import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import { DB, Db } from '../db/db.module';
import { companies, courierLedger, couriers, shipmentEvents, shipments, zones } from '../db/schema';
import { COURIER_CAN, VehicleId } from '../common/vehicles';
import { quote } from '../pricing/pricing';
import { NotificationsService, Channel } from '../notifications/notifications.module';
import { AuthUser } from '../common/auth';
import { distanceKm, geocode } from '../common/geo';
import { StorageService } from '../common/storage';
import { WebhooksService } from '../integrations/webhooks';
import { PaymentsService } from '../payments/payments.service';
import { TariffsService } from '../platform/platform.service';
import { PushService } from '../push/push.service';

type Status = typeof shipments.$inferSelect['status'];

export interface CreateShipment {
  senderName: string; senderPhone?: string;
  recipientName: string; recipientPhone?: string; recipientChatId?: string;
  address: string;
  city?: string;
  zoneId?: string;        // если не указана — ищем по zoneName и городу
  zoneName?: string;
  weightKg: number; lengthCm?: number; widthCm?: number; heightCm?: number;
  codRub?: number; notifyChannel?: Channel;
  source?: 'manual' | 'api' | 'import' | 'client';
  externalId?: string;    // номер заказа в системе клиента: повторная отправка не создаёт дубль
  customerId?: string;
  pickupAddress?: string; pickupName?: string; pickupPhone?: string; pickupLat?: number; pickupLng?: number;
  comment?: string; paymentMethod?: string;
  priceRub?: number;      // цена по тарифу платформы (тогда зоны не используются)
  vehicle?: string;
  platformFeeRub?: number; payStatus?: 'none' | 'awaiting'; payDeadline?: Date;
  addressDetails?: { street: string; house: string; apartment: string; entrance?: string; floor?: string; intercom?: string };
  deliveryLat?: number; deliveryLng?: number;
}

/** Курьер может взять заказ, если его транспорт подходит (на машине можно везти то, что подошло бы пешему). */
export const courierFits = (courierVehicle: string | null, need: string | null) =>
  !need || COURIER_CAN[(courierVehicle ?? 'foot') as VehicleId]?.includes(need as VehicleId);

/** «Доставлено» можно нажать только рядом с адресом: курьер не дальше этого расстояния от точки доставки. */
export const DELIVER_RADIUS_M = Number(process.env.DELIVER_RADIUS_M ?? 300);

export interface DeliverProof {
  code: string;
  photo?: string; signature?: string;     // data URL изображений
  lat?: number; lng?: number;
  codCollected?: number; codMethod?: 'cash' | 'card' | 'sbp';
  at?: Date;                              // время вручения на телефоне (для офлайн-режима)
}

/** Контекст создания: пользователь кабинета или интеграция по API-ключу. */
export type Actor = Pick<AuthUser, 'companyId'> & { sub?: string; role?: AuthUser['role'] };

@Injectable()
export class ShipmentsService {
  constructor(
    @Inject(DB) private db: Db, private notify: NotificationsService, private storage: StorageService,
    private webhooks: WebhooksService, private payments: PaymentsService, private tariffs: TariffsService, private push: PushService,
  ) {}

  /** Зона: явная → по названию в городе → первая зона города → первая зона компании. */
  private async resolveZone(companyId: string, dto: CreateShipment) {
    if (dto.zoneId) {
      const z = await this.db.query.zones.findFirst({ where: and(eq(zones.id, dto.zoneId), eq(zones.companyId, companyId)) });
      if (!z) throw new BadRequestException('Выберите зону доставки из списка');
      return z;
    }
    const all = await this.db.select().from(zones).where(eq(zones.companyId, companyId)).orderBy(asc(zones.name));
    const norm = (v?: string) => (v ?? '').trim().toLowerCase().replace(/ё/g, 'е');
    const inCity = dto.city ? all.filter((z) => norm(z.city) === norm(dto.city)) : all;
    const z = (dto.zoneName && inCity.find((x) => norm(x.name) === norm(dto.zoneName)))
      || inCity[0] || all.find((x) => !x.city) || all[0];
    if (!z) throw new BadRequestException('У компании нет зон доставки. Добавьте их в настройках.');
    return z;
  }

  async create(u: Actor, dto: CreateShipment) {
    if (dto.externalId) {
      const dup = await this.db.query.shipments.findFirst({
        where: and(eq(shipments.companyId, u.companyId), eq(shipments.externalId, dto.externalId)),
      });
      if (dup) return { ...dup, duplicate: true };
    }
    // Заказы платформы считаются по тарифам городов; старые накладные по зонам — по тарифу зоны.
    const zone = dto.priceRub != null ? null : await this.resolveZone(u.companyId, dto);
    const dims = { weightKg: dto.weightKg, lengthCm: dto.lengthCm ?? 20, widthCm: dto.widthCm ?? 20, heightCm: dto.heightCm ?? 10 };

    const created = await this.db.transaction(async (tx) => {
      // Атомарно берём следующий номер накладной компании.
      const [c] = await tx.update(companies)
        .set({ shipmentSeq: sql`${companies.shipmentSeq} + 1` })
        .where(eq(companies.id, u.companyId))
        .returning();
      const q = quote(dims, zone ?? { baseRub: 0, perKgRub: 0 }, c.volumetricDivisor);
      const [s] = await tx.insert(shipments).values({
        senderName: dto.senderName, senderPhone: dto.senderPhone, recipientName: dto.recipientName,
        recipientPhone: dto.recipientPhone, recipientChatId: dto.recipientChatId, address: dto.address,
        ...dims,
        companyId: u.companyId,
        zoneId: zone?.id ?? null,
        city: zone?.city || dto.city || c.city,
        trackingNumber: `${c.trackingPrefix}-${String(c.shipmentSeq).padStart(6, '0')}`,
        chargeableKg: q.chargeableKg,
        priceRub: dto.priceRub ?? q.totalRub,
        vehicle: dto.vehicle ?? null, addressDetails: dto.addressDetails ?? null, deliveryLat: dto.deliveryLat ?? null, deliveryLng: dto.deliveryLng ?? null,
        platformFeeRub: dto.platformFeeRub ?? null, payStatus: dto.payStatus ?? 'none', payDeadline: dto.payDeadline ?? null,
        codRub: dto.codRub ?? 0,
        notifyChannel: dto.notifyChannel ?? 'sms',
        source: dto.source ?? 'manual',
        externalId: dto.externalId || null,
        customerId: dto.customerId ?? null,
        pickupAddress: dto.pickupAddress ?? null, pickupName: dto.pickupName ?? null, pickupPhone: dto.pickupPhone ?? null,
        pickupLat: dto.pickupLat ?? null, pickupLng: dto.pickupLng ?? null,
        comment: dto.comment ?? null, paymentMethod: dto.paymentMethod ?? null,
        confirmCode: String(randomInt(1000, 10000)),
      }).returning();
      await tx.insert(shipmentEvents).values({
        companyId: u.companyId, shipmentId: s.id, status: 'created', actorUserId: u.sub ?? null,
        note: dto.source === 'api' ? 'Создано через API' : dto.source === 'import' ? 'Загружено из файла' : dto.source === 'client' ? 'Заказ клиента из приложения' : null,
      });
      return { shipment: s, company: c };
    });

    const s = created.shipment;
    // Заказы платформы: получатель узнаёт о доставке из SMS со ссылкой на оплату (её отправляет OrdersService).
    if (s.payStatus === 'none') await this.tell(u.companyId, s, `${created.company.name}: оформлена доставка ${s.trackingNumber}. Отслеживание: ${this.trackUrl(s)}`);
    this.webhooks.emit(u.companyId, 'shipment.created', this.publicView(s));
    return s;
  }

  /** Выставить заказ подходящим курьерам: сначала ближайшим, затем по всему городу. Везёт первый принявший. */
  async offer(u: Actor, id: string) {
    const s = await this.db.query.shipments.findFirst({ where: and(eq(shipments.id, id), eq(shipments.companyId, u.companyId)) });
    if (s && s.payStatus === 'awaiting') throw new BadRequestException('Заказ ждёт оплату получателя — курьеры увидят его сразу после оплаты');
    if (!s) throw new NotFoundException('Накладная не найдена');
    if (!['created', 'at_warehouse', 'failed'].includes(s.status) || s.courierId && s.status === 'assigned') throw new BadRequestException('Заказ уже у курьера');
    let extra: Partial<typeof shipments.$inferInsert> = {};
    if (s.pickupLat == null && s.pickupAddress) {
      const p = await geocode([s.city, s.pickupAddress].filter(Boolean).join(', '));
      if (p) extra = { pickupLat: p.lat, pickupLng: p.lng };
    }
    const [r] = await this.db.update(shipments).set({ ...extra, offeredAt: new Date(), courierId: null, updatedAt: new Date() }).where(eq(shipments.id, s.id)).returning();
    await this.db.insert(shipmentEvents).values({ companyId: u.companyId, shipmentId: s.id, status: r.status, note: 'Предложен курьерам', actorUserId: u.sub ?? null });
    return r;
  }

  /**
   * Курьер нажал «Беру». Условие courierId IS NULL в одном UPDATE: если двое нажали одновременно,
   * заказ получит только первый, второй увидит «уже взял другой курьер».
   */
  async claim(companyId: string, id: string, c: { id: string; name: string; userId: string | null }) {
    const [won] = await this.db.update(shipments).set({ courierId: c.id, status: 'assigned', cellCode: null, pickedUpAt: null, updatedAt: new Date() })
      .where(and(eq(shipments.id, id), sql`${shipments.courierId} is null`,
        sql`${shipments.offeredAt} is not null`, sql`${shipments.status} in ('created','at_warehouse','failed')`))
      .returning();
    if (!won) throw new BadRequestException('Этот заказ уже взял другой курьер');
    companyId = won.companyId;
    await this.db.insert(shipmentEvents).values({ companyId, shipmentId: id, status: 'assigned', note: `Курьер ${c.name} принял заказ`, actorUserId: c.userId });
    this.webhooks.emit(companyId, 'shipment.status', { ...this.publicView(won), note: 'Курьер принял заказ' });
    await this.tell(companyId, won, `Посылка ${won.trackingNumber}: курьер ${c.name.split(' ')[0]} принял заказ. Код для получения: ${won.confirmCode}`);
    await this.push.toCustomer(won.customerId, { title: 'Курьер найден', body: `${c.name.split(' ')[0]} едет за грузом. Код для получателя: ${won.confirmCode}`, data: { type: 'order', id: won.id } });
    return won;
  }

  /**
   * Ближайший курьер на линии: по свежей геопозиции (до 20 минут) к точке забора или адресу,
   * иначе — курьер того же города с наименьшей загрузкой.
   */
  async autoAssign(u: Actor, s: typeof shipments.$inferSelect) {
    let point = s.pickupLat != null && s.pickupLng != null ? { lat: s.pickupLat, lng: s.pickupLng } : null;
    if (!point) {
      point = await geocode([s.city, s.pickupAddress ?? s.address].filter(Boolean).join(', '));
      if (point && s.pickupAddress) await this.db.update(shipments).set({ pickupLat: point.lat, pickupLng: point.lng }).where(eq(shipments.id, s.id));
    }
    const list = await this.db.select({
      id: couriers.id, name: couriers.name, city: couriers.city, lat: couriers.lastLat, lng: couriers.lastLng, seen: couriers.lastSeenAt,
      inWork: sql<number>`(select count(*) from ${shipments} where ${shipments.courierId} = ${couriers.id} and ${shipments.status} = 'assigned')`.mapWith(Number),
      vehicle: couriers.vehicle,
    }).from(couriers).where(and(eq(couriers.companyId, u.companyId), eq(couriers.status, 'approved'), eq(couriers.active, true)))
      .then((rows) => rows.filter((c) => courierFits(c.vehicle, s.vehicle)));
    if (!list.length) return null;
    const fresh = (c: (typeof list)[number]) => c.lat != null && c.lng != null && c.seen && Date.now() - c.seen.getTime() < 20 * 60_000;
    const near = point ? list.filter(fresh).map((c) => ({ c, km: distanceKm(point!, { lat: c.lat!, lng: c.lng! }) })).sort((a, b) => a.km - b.km + (a.c.inWork - b.c.inWork) * 0.5) : [];
    const sameCity = list.filter((c) => !s.city || !c.city || c.city === s.city).sort((a, b) => a.inWork - b.inWork);
    const pick = near[0]?.c ?? sameCity[0];
    if (!pick) return null;
    const note = near[0] ? `Автоназначение: ближайший курьер, ${near[0].km.toFixed(1)} км` : 'Автоназначение: свободный курьер в городе';
    return this.assignTo(u, s, pick, note);
  }

  /** То, что видит внешняя система: без кода вручения и путей к фото. */
  publicView(s: typeof shipments.$inferSelect) {
    return {
      trackingNumber: s.trackingNumber, externalId: s.externalId, status: s.status, priceRub: s.priceRub,
      city: s.city, address: s.address, recipientName: s.recipientName, failReason: s.failReason,
      deliveredAt: s.deliveredAt, codCollected: s.codCollected, trackingUrl: this.trackUrl(s), updatedAt: s.updatedAt,
    };
  }

  list(u: AuthUser, status?: Status, limit = 500) {
    const where = status
      ? and(eq(shipments.companyId, u.companyId), eq(shipments.status, status))
      : eq(shipments.companyId, u.companyId);
    return this.db.select({
      id: shipments.id, trackingNumber: shipments.trackingNumber, senderName: shipments.senderName,
      recipientName: shipments.recipientName, address: shipments.address, zoneName: zones.name, city: shipments.city,
      weightKg: shipments.weightKg, priceRub: shipments.priceRub, status: shipments.status,
      cellCode: shipments.cellCode, courierName: couriers.name, createdAt: shipments.createdAt,
      source: shipments.source, externalId: shipments.externalId, pickupAddress: shipments.pickupAddress, rating: shipments.rating,
      vehicle: shipments.vehicle, payStatus: shipments.payStatus,
    })
      .from(shipments)
      .leftJoin(zones, eq(zones.id, shipments.zoneId))
      .leftJoin(couriers, eq(couriers.id, shipments.courierId))
      .where(where)
      .orderBy(desc(shipments.createdAt))
      .limit(limit);
  }

  /** Сотрудник видит накладные своей компании; курьер платформы — заказы любых заказчиков (проверка «свой ли» — отдельно). */
  async get(u: AuthUser, id: string) {
    const s = await this.db.query.shipments.findFirst({ where: u.role === 'courier' ? eq(shipments.id, id) : and(eq(shipments.id, id), eq(shipments.companyId, u.companyId)) });
    if (!s) throw new NotFoundException('Накладная не найдена');
    const events = await this.db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, id)).orderBy(asc(shipmentEvents.createdAt));
    return { ...s, events };
  }

  async findByNumber(companyId: string, trackingNumber: string) {
    return this.db.query.shipments.findFirst({
      where: and(eq(shipments.companyId, companyId), eq(shipments.trackingNumber, trackingNumber.trim().toUpperCase())),
    });
  }

  async assign(u: AuthUser, id: string, courierId: string) {
    const s = await this.get(u, id);
    if (!['created', 'at_warehouse', 'failed'].includes(s.status)) throw new BadRequestException('Это отправление уже у курьера или доставлено');
    const c = await this.db.query.couriers.findFirst({ where: and(eq(couriers.id, courierId), eq(couriers.companyId, u.companyId)) });
    if (!c || c.status !== 'approved') throw new BadRequestException('Курьер не найден или его заявка не подтверждена');
    if (!c.active) throw new BadRequestException(`${c.name} сейчас не на линии`);
    return this.assignTo(u, s, c, `Курьер: ${c.name}`);
  }

  async assignTo(u: Actor, s: typeof shipments.$inferSelect, c: { id: string; name: string }, note: string) {
    const updated = await this.setStatus(u, s.id, 'assigned', note, { courierId: c.id, cellCode: null, pickedUpAt: null });
    await this.tell(u.companyId, updated, `Посылка ${s.trackingNumber} передана курьеру ${c.name}. Код для получения: ${s.confirmCode}`);
    return updated;
  }

  /** Курьер забрал посылку у отправителя (заказы с адресом забора). */
  async pickup(u: AuthUser, id: string) {
    const s = await this.get(u, id);
    if (s.pickedUpAt) return s;
    if (s.status !== 'assigned') throw new BadRequestException('Заказ не назначен курьеру');
    if (u.role === 'courier') await this.assertOwnShipment(u, s.courierId);
    const updated = await this.setStatus({ ...u, companyId: s.companyId }, s.id, 'assigned', 'Курьер забрал посылку', { pickedUpAt: new Date() });
    await this.tell(s.companyId, updated, `Посылка ${s.trackingNumber} у курьера и едет к вам. Код для получения: ${s.confirmCode}`);
    await this.push.toCustomer(s.customerId, { title: 'Курьер забрал груз', body: `Доставка ${s.trackingNumber} едет к получателю`, data: { type: 'order', id: s.id } });
    return updated;
  }

  /** Вознаграждение курьера: доля цены доставки по тарифу платформы (по умолчанию 100%). */
  private courierPay(priceRub: number) { return this.tariffs.courierShare(priceRub); }

  /** Начисление курьеру в его журнал (баланс для вывода). Журнал ведёт платформа — компания, к которой принадлежит курьер. */
  private async ledgerOnDeliver(s: typeof shipments.$inferSelect, payRub: number) {
    if (!s.courierId || payRub <= 0) return;
    const c = await this.db.query.couriers.findFirst({ where: eq(couriers.id, s.courierId), columns: { companyId: true } });
    if (!c) return;
    await this.db.insert(courierLedger).values({ companyId: c.companyId, courierId: s.courierId, shipmentId: s.id, kind: 'earning', amountRub: payRub, note: `За заказ ${s.trackingNumber}` });
  }

  /** Вручение: курьер вводит код, который получатель получил в сообщении. */
  async deliver(u: AuthUser, id: string, p: DeliverProof) {
    const s = await this.get(u, id);
    if (s.status === 'delivered') return s; // повторная отправка из офлайн-очереди приложения
    if (s.status !== 'assigned') throw new BadRequestException('Отправление не находится в доставке');
    if (u.role === 'courier') await this.assertOwnShipment(u, s.courierId);
    if (s.confirmCode !== p.code.trim()) throw new BadRequestException('Код не совпадает. Попросите получателя проверить код у отправителя.');
    // Курьер должен быть у адреса доставки (если координаты адреса известны).
    if (u.role === 'courier' && s.deliveryLat != null && s.deliveryLng != null) {
      if (p.lat == null || p.lng == null) throw new BadRequestException('Включите геопозицию: «Доставлено» можно отметить только у адреса');
      const m = Math.round(distanceKm({ lat: p.lat, lng: p.lng }, { lat: s.deliveryLat, lng: s.deliveryLng }) * 1000);
      if (m > DELIVER_RADIUS_M) throw new BadRequestException(`Вы в ${m} м от адреса доставки. Отметить «Доставлено» можно ближе ${DELIVER_RADIUS_M} м.`);
    }
    if (s.codRub > 0 && (p.codCollected ?? 0) < s.codRub) {
      throw new BadRequestException(`Нужно получить с клиента ${s.codRub} ₽ наложенного платежа`);
    }
    const proofPhoto = p.photo ? await this.storage.saveDataUrl(s.companyId, p.photo) : null;
    const proofSignature = p.signature ? await this.storage.saveDataUrl(s.companyId, p.signature) : null;
    const updated = await this.setStatus({ ...u, companyId: s.companyId }, s.id, 'delivered', 'Вручено по коду', {
      deliveredAt: p.at ?? new Date(), proofPhoto, proofSignature,
      deliveredLat: p.lat ?? null, deliveredLng: p.lng ?? null,
      codCollected: s.codRub > 0 ? p.codCollected ?? null : null, codMethod: s.codRub > 0 ? p.codMethod ?? 'cash' : null,
      pickedUpAt: s.pickedUpAt ?? (s.pickupAddress ? new Date() : null),
      courierPayRub: this.courierPay(s.priceRub),
    });
    await this.ledgerOnDeliver(updated, updated.courierPayRub ?? 0).catch(() => {});
    // Оплата картой: списываем резерв. Не прошло — у заказчика долг, новые заказы ему недоступны, пока не погасит.
    if (updated.payStatus === 'held') {
      const pay = await this.payments.captureShipment(updated.id).catch(() => 'failed');
      if (pay === 'failed') await this.push.toCustomer(s.customerId, { title: 'Оплата не прошла', body: `Не удалось списать ${s.priceRub} ₽ за доставку ${s.trackingNumber}. Оплатите в приложении — до этого новые заказы недоступны.`, data: { type: 'debt' } });
    }
    await this.push.toCustomer(s.customerId, { title: 'Доставлено', body: `Доставка ${s.trackingNumber} вручена. Оцените курьера`, data: { type: 'order', id: s.id } });
    return updated;
  }

  async fail(u: AuthUser, id: string, reason: string) {
    const s = await this.get(u, id);
    if (s.status === 'failed') return s; // повтор из офлайн-очереди
    if (s.status !== 'assigned') throw new BadRequestException('Отправление не находится в доставке');
    if (u.role === 'courier') await this.assertOwnShipment(u, s.courierId);
    const r = reason || 'Не вручено';
    return this.setStatus({ ...u, companyId: s.companyId }, s.id, 'failed', r, { failReason: r });
  }

  async setStatus(u: Actor, id: string, status: Status, note?: string, extra: Partial<typeof shipments.$inferInsert> = {}) {
    // Отмена заказа (возврат): резерв на карте снимается, деньги возвращаются на ту же карту.
    if (status === 'returned') await this.payments.releaseShipment(id);
    const updated = await this.db.transaction(async (tx) => {
      const [s] = await tx.update(shipments).set({ ...extra, status, updatedAt: new Date() })
        .where(and(eq(shipments.id, id), eq(shipments.companyId, u.companyId))).returning();
      if (!s) throw new NotFoundException('Накладная не найдена');
      await tx.insert(shipmentEvents).values({ companyId: s.companyId, shipmentId: id, status, note, actorUserId: u.sub ?? null });
      return s;
    });
    this.webhooks.emit(updated.companyId, 'shipment.status', { ...this.publicView(updated), note: note ?? null });
    return updated;
  }

  /** Публичный трекинг: только статусы, без персональных данных. */
  async track(trackingNumber: string) {
    const s = await this.db.query.shipments.findFirst({ where: eq(shipments.trackingNumber, trackingNumber.toUpperCase()) });
    if (!s) throw new NotFoundException('Отправление с таким номером не найдено');
    const company = await this.db.query.companies.findFirst({ where: eq(companies.id, s.companyId) });
    const events = await this.db.select({ status: shipmentEvents.status, at: shipmentEvents.createdAt })
      .from(shipmentEvents).where(eq(shipmentEvents.shipmentId, s.id)).orderBy(asc(shipmentEvents.createdAt));
    return { trackingNumber: s.trackingNumber, status: s.status, company: company?.name, brandColor: company?.brandColor, events };
  }

  /** Карточка для курьера: только своё отправление и без кода вручения — его называет получатель. */
  async getForCourier(u: AuthUser, id: string) {
    const { confirmCode, ...s } = await this.get(u, id);
    await this.assertOwnShipment(u, s.courierId);
    return s;
  }

  private async assertOwnShipment(u: AuthUser, courierId: string | null) {
    const me = await this.db.query.couriers.findFirst({ where: eq(couriers.userId, u.sub) });
    if (!me || me.id !== courierId) throw new ForbiddenException('Это отправление назначено другому курьеру');
  }

  private trackUrl(s: { trackingNumber: string }) {
    return `${process.env.PUBLIC_URL ?? ''}/track/${s.trackingNumber}`;
  }

  /** Уведомление получателю — push, если у него есть приложение (тот же телефон). SMS не отправляются. */
  private tell(_companyId: string, s: typeof shipments.$inferSelect, text: string) {
    return this.push.toPhone(s.recipientPhone, { title: 'Доставка для вас', body: text, data: { type: 'track', number: s.trackingNumber } });
  }

}
