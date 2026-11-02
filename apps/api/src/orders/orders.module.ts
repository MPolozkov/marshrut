import { BadRequestException, Body, Controller, Delete, Get, Inject, Module, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, customers } from '../db/schema';
import { PaymentsService } from '../payments/payments.service';
import { AuthUser, CurrentUser, Public, Roles, Zod } from '../common/auth';
import { VEHICLE_IDS, VehicleId } from '../common/vehicles';
import { ShipmentsModule } from '../shipments/shipments.module';
import { mapRows, num, parseCsv } from '../shipments/csv';
import { OrderInput, OrdersService } from './orders.service';

const lat = z.number().min(-90).max(90).optional(), lng = z.number().min(-180).max(180).optional();
export const CargoDto = z.object({
  city: z.string().trim().min(2, 'Укажите город').max(80),
  fromAddress: z.string().trim().max(300).default(''), fromLat: lat, fromLng: lng,
  toAddress: z.string().trim().max(300).default(''), toLat: lat, toLng: lng,
  weightKg: z.number().positive('Укажите вес').max(2000),
  lengthCm: z.number().int().min(1).max(1000), widthCm: z.number().int().min(1).max(500), heightCm: z.number().int().min(1).max(500),
  vehicle: z.enum(VEHICLE_IDS).optional(),
});
/** Адрес доставки по частям: улица, дом и квартира обязательны (у частного дома — «частный дом»). */
export const AddressParts = {
  toStreet: z.string().trim().min(3, 'Укажите улицу').max(200),
  toHouse: z.string().trim().min(1, 'Укажите номер дома').max(20),
  toApartment: z.string().trim().min(1, 'Укажите квартиру или офис (для частного дома — «частный дом»)').max(30),
  toEntrance: z.string().trim().max(10).optional(),
  toFloor: z.string().trim().max(10).optional(),
  toIntercom: z.string().trim().max(20).optional(),
};
export const OrderDto = CargoDto.extend({
  fromAddress: z.string().trim().min(5, 'Укажите точный адрес, откуда забрать').max(300),
  ...AddressParts,
  fromName: z.string().trim().max(80).optional(), fromPhone: z.string().trim().max(20).optional(),
  recipientName: z.string().trim().min(2, 'Укажите получателя').max(80),
  recipientPhone: z.string().trim().min(10, 'Укажите телефон получателя').max(20),   // курьер звонит получателю
  description: z.string().trim().max(300).optional(),
  comment: z.string().trim().max(500).optional(),
  externalId: z.string().trim().max(100).optional(),
});

/** Кабинет организации: оформление доставок вручную и файлом. Сумма — по тарифу города, резерв с карты компании. */
@Controller('shipments')
@Roles('dispatcher')
export class BusinessOrdersController {
  constructor(@Inject(DB) private db: Db, private orders: OrdersService) {}

  private company(id: string) { return this.db.query.companies.findFirst({ where: eq(companies.id, id) }).then((c) => c!); }

  @Post('quote')
  quote(@Body(new Zod(CargoDto)) d: z.infer<typeof CargoDto>) { return this.orders.quote(d); }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body(new Zod(OrderDto)) d: z.infer<typeof OrderDto>) {
    const c = await this.company(u.companyId);
    const r = await this.orders.create(u.companyId, d, { source: 'manual', sub: u.sub, payer: await this.orders.orgPayer(c.id), senderName: c.name, senderPhone: c.phone ?? undefined });
    return { ...r.shipment, confirmationUrl: r.confirmationUrl };
  }

  /** После страницы банка: проверить резерв по доставке. */
  @Post('pay-check')
  async payCheck(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ id: z.string().uuid() }))) b: { id: string }) {
    const s = await this.db.query.shipments.findFirst({ where: (t, { and, eq }) => and(eq(t.id, b.id), eq(t.companyId, u.companyId)) });
    if (!s) throw new BadRequestException('Доставка не найдена');
    return this.orders.checkPayment(s);
  }

  /**
   * Загрузка из Excel (CSV): «Получатель», «Телефон», «Адрес» (улица), «Дом», «Квартира» обязательны; «Подъезд», «Этаж», «Город», «Откуда», «Вес», «Длина», «Ширина», «Высота»,
   * «Транспорт», «Комментарий», «Номер заказа» — по желанию. Откуда по умолчанию — адрес отправки из настроек.
   */
  @Post('import')
  async import(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ csv: z.string().min(10).max(5_000_000) }))) b: { csv: string }) {
    const c = await this.company(u.companyId);
    const payer = await this.orders.orgPayer(c.id);
    const { orders, missing } = mapRows(parseCsv(b.csv));
    if (missing.length) throw new BadRequestException(`В файле нет колонок: ${missing.join(', ')}. Первая строка должна содержать заголовки.`);
    if (orders.length > 2000) throw new BadRequestException('Не больше 2000 строк за раз');
    const result = { created: 0, duplicates: 0, errors: [] as { line: number; error: string }[] };
    for (const { line, data: d } of orders) {
      try {
        const vehicle = VEHICLE_IDS.find((v) => v === d.vehicle) as VehicleId | undefined;
        if (!d.house || !d.apartment) throw new Error('нужны колонки «Дом» и «Квартира» (для частного дома — «частный дом»)');
        const input: OrderInput = {
          city: d.city || c.city, fromAddress: d.pickupAddress || c.pickupAddress || '',
          toStreet: d.address, toHouse: d.house, toApartment: d.apartment, toEntrance: d.entrance || undefined, toFloor: d.floor || undefined,
          recipientName: d.recipientName, recipientPhone: d.recipientPhone, vehicle, comment: d.comment || undefined, externalId: d.externalId || undefined,
          weightKg: num(d.weightKg) ?? 1, lengthCm: Math.round(num(d.lengthCm) ?? 30), widthCm: Math.round(num(d.widthCm) ?? 20), heightCm: Math.round(num(d.heightCm) ?? 15),
        };
        if (!input.city || input.fromAddress.length < 5) throw new Error('нет города или адреса забора: укажите их в файле или в «Настройках»');
        const r: any = await this.orders.create(u.companyId, input, { source: 'import', sub: u.sub, payer, senderName: d.senderName || c.name, senderPhone: d.senderPhone || c.phone || undefined });
        if (r.confirmationUrl) throw new Error('банк требует подтверждения оплаты — оформите эту доставку вручную');
        if (r.shipment.duplicate) result.duplicates++; else result.created++;
      } catch (e: any) {
        result.errors.push({ line, error: e?.response?.message ?? e.message });
      }
    }
    return result;
  }
}

/**
 * Карта организации: оплата доставок только картой. Проверка — резерв 1 ₽ и сразу отмена.
 * Для удобства бухгалтерии реквизиты компании передаются в чек.
 */
@Controller('company/card')
@Roles('owner')
export class CompanyCardController {
  constructor(@Inject(DB) private db: Db, private orders: OrdersService, private pay: PaymentsService) {}
  private view(p: typeof customers.$inferSelect) { return { hasCard: !!p.cardMethodId, cardLast4: p.cardLast4, cardBrand: p.cardBrand }; }

  @Get()
  async get(@CurrentUser() u: AuthUser) {
    const p = await this.orders.orgPayer(u.companyId);
    return { ...this.view(p), debtRub: (await this.pay.debt(p.id)).totalRub, testMode: this.pay.testMode };
  }
  @Post()
  async bind(@CurrentUser() u: AuthUser) {
    const r = await this.pay.startCardCheck(await this.orders.orgPayer(u.companyId));
    return { paymentId: r.id, status: r.status, confirmationUrl: r.status === 'pending' ? r.confirmationUrl : null, ...(await this.get(u)) };
  }
  @Post('check')
  async check(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ paymentId: z.string().uuid() }))) b: { paymentId: string }) {
    const p = await this.orders.orgPayer(u.companyId);
    const r = await this.pay.sync(await this.pay.get(b.paymentId, p.id));
    return { status: r.status, confirmationUrl: r.status === 'pending' ? r.confirmationUrl : null, ...(await this.get(u)) };
  }
  @Delete()
  async unlink(@CurrentUser() u: AuthUser) {
    const p = await this.orders.orgPayer(u.companyId);
    await this.db.update(customers).set({ cardMethodId: null, cardLast4: null, cardBrand: null, cardVerifiedAt: null }).where(eq(customers.id, p.id));
    return this.get(u);
  }
  /** Погасить долг (не списалось после вручения). */
  @Post('debt')
  async debt(@CurrentUser() u: AuthUser) {
    const r = await this.pay.payDebt(await this.orders.orgPayer(u.companyId));
    if (r.status === 'failed') throw new BadRequestException(`Оплата не прошла: ${r.error}`);
    return { paymentId: r.id, status: r.status, confirmationUrl: r.status === 'pending' ? r.confirmationUrl : null, ...(await this.get(u)) };
  }
}

@Module({ imports: [ShipmentsModule], controllers: [BusinessOrdersController, CompanyCardController], providers: [OrdersService], exports: [OrdersService] })
export class OrdersModule {}
