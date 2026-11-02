import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { companies, customers, shipments } from '../db/schema';
import { ShipmentsService } from '../shipments/shipments.service';
import { PaymentsService } from '../payments/payments.service';
import { PlatformService, TariffsService } from '../platform/platform.service';
import { PushService } from '../push/push.service';
import { COURIER_CAN, recommendVehicle, VEHICLE_IDS, vehicleProblem, VEHICLES, VehicleId } from '../common/vehicles';
import { geocode, routeKm, sameCity } from '../common/geo';

type Customer = typeof customers.$inferSelect;
type Shipment = typeof shipments.$inferSelect;

/** Сколько ждём подтверждения банка (3-D Secure), прежде чем отменить неоплаченный заказ. */
export const PAY_WAIT_MIN = Number(process.env.PAY_WAIT_MINUTES ?? 30);

/** Полный адрес доставки для курьера: улица, дом, квартира, подъезд, этаж, домофон. */
export function fullAddress(d: Pick<OrderInput, 'toStreet' | 'toHouse' | 'toApartment' | 'toEntrance' | 'toFloor' | 'toIntercom'>) {
  const apt = /частн/i.test(d.toApartment) ? 'частный дом' : `кв./офис ${d.toApartment}`;
  return [d.toStreet, `д. ${d.toHouse}`, apt, d.toEntrance && `подъезд ${d.toEntrance}`, d.toFloor && `этаж ${d.toFloor}`, d.toIntercom && `домофон ${d.toIntercom}`].filter(Boolean).join(', ');
}

export interface OrderInput {
  city: string;
  fromAddress: string; fromLat?: number; fromLng?: number; fromName?: string; fromPhone?: string;
  toStreet: string; toHouse: string; toApartment: string; toEntrance?: string; toFloor?: string; toIntercom?: string;
  toLat?: number; toLng?: number;
  recipientName: string; recipientPhone?: string;
  weightKg: number; lengthCm: number; widthCm: number; heightCm: number;
  vehicle?: VehicleId; description?: string; comment?: string; externalId?: string;
}

/**
 * Заказ на платформе — сразу к курьерам.
 * 1. Сумма по тарифу города (транспорт, километры, вес, ночь). 2. Сумма резервируется на карте заказчика.
 * 3. Резерв прошёл — заказ видят курьеры рядом (и получают push), везёт первый принявший.
 * 4. Вручение — списание: платформе её процент, курьеру остальное. Отмена — резерв снимается. Получатель ничего не платит.
 */
@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Заказы');
  private timer?: NodeJS.Timeout;
  constructor(@Inject(DB) private db: Db, private shipmentsSvc: ShipmentsService, private pay: PaymentsService,
    private tariffs: TariffsService, private platform: PlatformService, private push: PushService) {}

  onModuleInit() { this.timer = setInterval(() => this.expireUnpaid().catch((e) => this.log.warn(e.message)), 5 * 60_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Калькулятор: подходящий транспорт, расстояние, сумма и как она делится. */
  async quote(d: Pick<OrderInput, 'city' | 'fromAddress' | 'fromLat' | 'fromLng' | 'toLat' | 'toLng' | 'weightKg' | 'lengthCm' | 'widthCm' | 'heightCm' | 'vehicle'> & { toAddress?: string }) {
    const cargo = { weightKg: d.weightKg, lengthCm: d.lengthCm, widthCm: d.widthCm, heightCm: d.heightCm };
    const { km, approx } = await routeKm({ city: d.city, address: d.fromAddress, lat: d.fromLat, lng: d.fromLng }, { city: d.city, address: d.toAddress, lat: d.toLat, lng: d.toLng });
    const t = await this.tariffs.forCity(d.city);
    const vehicles = await Promise.all(VEHICLE_IDS.map(async (id) => {
      const problem = vehicleProblem(id, cargo) ?? (t.rates[id]?.enabled ? null : 'нет в этом городе');
      const p = problem ? null : await this.tariffs.price(d.city, id, km, d.weightKg);
      return { id, label: VEHICLES[id].label, problem, priceRub: p?.priceRub ?? null };
    }));
    const recommended = vehicles.find((v) => !v.problem)?.id ?? recommendVehicle(cargo);
    const vehicle = d.vehicle && vehicles.find((v) => v.id === d.vehicle && !v.problem) ? d.vehicle : recommended;
    const p = vehicle ? await this.tariffs.price(d.city, vehicle, km, d.weightKg) : null;
    const rate = vehicle ? t.rates[vehicle] : null;
    return {
      distanceKm: km, distanceApprox: approx, night: TariffsService.isNight(), vehicles, recommended, vehicle,
      priceRub: p?.priceRub ?? null, courierRub: p?.courierRub ?? null, platformRub: p?.platformRub ?? null, feePercent: this.tariffs.feePercent,
      breakdown: rate && km != null ? {
        baseRub: rate.baseRub, km, perKmRub: rate.perKmRub, extraKg: Math.max(0, Math.ceil(d.weightKg - rate.freeKg)), perKgRub: rate.perKgRub,
        nightPercent: p?.night ? t.nightPercent : 0,
      } : null,
    };
  }

  /** Плательщик организации: служебная запись заказчика, на которой хранится привязанная карта компании. */
  async orgPayer(companyId: string) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    if (!c) throw new BadRequestException('Компания не найдена');
    if (c.payerCustomerId) {
      const p = await this.db.query.customers.findFirst({ where: eq(customers.id, c.payerCustomerId) });
      if (p) return p;
    }
    const [p] = await this.db.insert(customers).values({
      phone: `org:${c.id}`, name: c.name, kind: 'company', registeredAt: new Date(),
      requisites: { companyName: c.legalName ?? c.name, inn: c.inn ?? '', legalAddress: c.legalAddress ?? '' },
    }).onConflictDoUpdate({ target: customers.phone, set: { name: c.name } }).returning();
    await this.db.update(companies).set({ payerCustomerId: p.id }).where(eq(companies.id, c.id));
    return p;
  }

  /**
   * Новый заказ. companyId — организация-заказчик или платформа (заказы физлиц из приложения).
   * payer — заказчик, с карты которого резервируется сумма.
   */
  async create(companyId: string, d: OrderInput, o: { source: 'manual' | 'api' | 'import' | 'client'; sub?: string; payer: Customer; senderName: string; senderPhone?: string }) {
    this.pay.needCard(o.payer);
    await this.pay.assertNoDebt(o.payer.id);
    // Точка доставки: координаты из GPS заказчика или по адресу (улица и дом) — по ней проверяем, что курьер на месте.
    const toAddress = `${d.toStreet}, ${d.toHouse}`;
    const point = d.toLat != null && d.toLng != null ? { lat: d.toLat, lng: d.toLng } : await geocode(`${d.city}, ${toAddress}`);
    const q = await this.quote({ ...d, toAddress, toLat: point?.lat, toLng: point?.lng });
    if (!q.vehicle) throw new BadRequestException('Груз не подходит ни под один транспорт: проверьте вес и габариты');
    if (d.vehicle && d.vehicle !== q.vehicle) throw new BadRequestException(`${VEHICLES[d.vehicle].label}: ${q.vehicles.find((x) => x.id === d.vehicle)?.problem ?? 'не подходит'}`);
    if (q.priceRub == null) throw new BadRequestException('Не удалось рассчитать расстояние: уточните адреса (улица и дом)');
    const s = await this.shipmentsSvc.create({ companyId, sub: o.sub }, {
      source: o.source, customerId: o.payer.id, externalId: d.externalId,
      senderName: d.fromName || o.senderName, senderPhone: d.fromPhone || o.senderPhone,
      pickupAddress: d.fromAddress, pickupName: d.fromName || o.senderName, pickupPhone: d.fromPhone || o.senderPhone,
      pickupLat: d.fromLat, pickupLng: d.fromLng,
      recipientName: d.recipientName, recipientPhone: d.recipientPhone, address: fullAddress(d), city: d.city,
      addressDetails: { street: d.toStreet, house: d.toHouse, apartment: d.toApartment, entrance: d.toEntrance, floor: d.toFloor, intercom: d.toIntercom },
      deliveryLat: point?.lat, deliveryLng: point?.lng,
      weightKg: d.weightKg, lengthCm: d.lengthCm, widthCm: d.widthCm, heightCm: d.heightCm, vehicle: q.vehicle,
      comment: [d.description && `Груз: ${d.description}`, d.comment].filter(Boolean).join('. ') || undefined,
      priceRub: q.priceRub, platformFeeRub: q.platformRub ?? 0, codRub: 0, paymentMethod: 'card', notifyChannel: 'sms',
      payStatus: 'awaiting', payDeadline: new Date(Date.now() + PAY_WAIT_MIN * 60_000),
    }) as Shipment & { duplicate?: boolean };
    if (s.duplicate) return { shipment: s, confirmationUrl: null };

    const p = await this.pay.holdFromCustomer(o.payer, s);
    await this.db.update(shipments).set({ paymentId: p.id }).where(eq(shipments.id, s.id));
    if (p.status === 'held') return { shipment: await this.onHeld(s.id), confirmationUrl: null };
    if (p.status === 'pending') return { shipment: s, confirmationUrl: p.confirmationUrl, paymentId: p.id };
    await this.shipmentsSvc.setStatus({ companyId }, s.id, 'returned', 'Оплата не прошла', { failReason: `Оплата не прошла: ${p.error}` });
    throw new BadRequestException(`Не удалось зарезервировать оплату: ${p.error ?? 'банк отклонил платёж'}. Проверьте баланс карты или привяжите другую.`);
  }

  /** Резерв прошёл: заказ сразу виден курьерам рядом, им приходит push. */
  async onHeld(shipmentId: string) {
    const [s] = await this.db.update(shipments).set({ payStatus: 'held', payDeadline: null, updatedAt: new Date() })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.payStatus, 'awaiting'))).returning();
    if (!s) return (await this.db.query.shipments.findFirst({ where: eq(shipments.id, shipmentId) }))!;
    const offered = await this.shipmentsSvc.offer({ companyId: s.companyId }, s.id);
    const reward = this.tariffs.courierShare(s.priceRub);
    await this.push.toActiveCouriers(
      (c) => (!c.city || sameCity(c.city, s.city)) && (!s.vehicle || COURIER_CAN[(c.vehicle ?? 'foot') as VehicleId]?.includes(s.vehicle as VehicleId)),
      { title: `Новый заказ · ${reward} ₽`, body: `${s.pickupAddress ?? ''} → ${s.address}`, data: { type: 'offer', id: s.id } },
    );
    await this.push.toCustomer(s.customerId, { title: 'Ищем курьера', body: `Доставка ${s.trackingNumber}: ${s.priceRub} ₽ зарезервировано на карте`, data: { type: 'order', id: s.id } });
    return offered;
  }

  /** Проверка оплаты по заказу (после страницы банка или из вебхука). */
  async checkPayment(s: Shipment) {
    if (!s.paymentId) return s;
    const p = await this.pay.sync(await this.pay.get(s.paymentId));
    if (p.status === 'held' && s.payStatus === 'awaiting') return this.onHeld(s.id);
    return (await this.db.query.shipments.findFirst({ where: eq(shipments.id, s.id) }))!;
  }

  /** Банк так и не подтвердил резерв — отменяем заказ. */
  async expireUnpaid() {
    const list = await this.db.select().from(shipments)
      .where(and(eq(shipments.payStatus, 'awaiting'), lt(shipments.payDeadline, new Date()), eq(shipments.status, 'created'))).limit(200);
    for (const s of list) {
      const fresh = await this.checkPayment(s).catch(() => s);
      if (fresh.payStatus !== 'awaiting') continue;
      await this.shipmentsSvc.setStatus({ companyId: s.companyId }, s.id, 'returned', 'Оплата не подтверждена', { failReason: 'Банк не подтвердил оплату' }).catch(() => {});
      await this.push.toCustomer(s.customerId, { title: 'Заказ отменён', body: `Доставка ${s.trackingNumber}: оплата не подтверждена банком`, data: { type: 'order', id: s.id } });
    }
  }

  platformId() { return this.platform.id(); }
}
