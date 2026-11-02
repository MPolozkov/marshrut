import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Ip, Logger, Module, NotFoundException, Param,
  ParseUUIDPipe, Post, Put, Query,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, courierLedger, couriers, customers, shipmentEvents, shipments } from '../db/schema';
import { AuthUser, CurrentUser, Public, Roles, Zod } from '../common/auth';
import { NotificationsService } from '../notifications/notifications.module';
import { LoginLimiter } from '../auth/auth.module';
import { ShipmentsModule } from '../shipments/shipments.module';
import { ShipmentsService } from '../shipments/shipments.service';
import { OrdersModule, CargoDto, OrderDto } from '../orders/orders.module';
import { OrdersService, PAY_WAIT_MIN } from '../orders/orders.service';
import { PaymentsService, DEBT_LIMIT_RUB } from '../payments/payments.service';
import { VEHICLE_IDS, VEHICLES, VehicleId } from '../common/vehicles';
import { reverseGeocode } from '../common/geo';
import { TariffsService } from '../platform/platform.service';
import { PushService } from '../push/push.service';

/*
 * Заказчик в едином приложении (роль «Заказчик») и в веб-версии /order, /c/<адрес-компании>.
 * Вход по SMS → анкета → проверка карты (1 ₽) → калькулятор → предложения служб → резерв на карте → курьер
 * → списание после вручения → оценка и чаевые картой.
 */

const normPhone = (p: string) => { const d = p.replace(/\D/g, ''); return d.length === 11 && d[0] === '8' ? `7${d.slice(1)}` : d.length === 10 ? `7${d}` : d; };
const digits = (n: number[], msg: string) => z.string().trim().refine((v) => n.includes(v.replace(/\s/g, '').length) && /^\d+$/.test(v.replace(/\s/g, '')), msg);
const fio = z.string().trim().min(2, 'Минимум 2 буквы').max(60);
const PAY_STATUS: Record<string, string> = {
  none: '', awaiting: 'Ждём подтверждения оплаты банком', held: 'Сумма зарезервирована на карте', paid: 'Оплачено картой',
  failed: 'Оплата не прошла', refunded: 'Резерв снят, деньги вернулись на карту',
};

const ProfileDto = z.object({
  lastName: fio, firstName: fio, middleName: z.string().trim().max(60).default(''),
  email: z.string().trim().email('Неверный email').optional().or(z.literal('')),
  kind: z.enum(['person', 'company']),
  selfEmployed: z.boolean().default(false),
  inn: z.string().trim().optional(),
  requisites: z.object({
    companyName: z.string().trim().min(2, 'Укажите название организации').max(200),
    inn: digits([10, 12], 'ИНН — 10 цифр у организации, 12 у ИП'),
    kpp: digits([9], 'КПП — 9 цифр').optional().or(z.literal('')),
    ogrn: digits([13, 15], 'ОГРН — 13 цифр, ОГРНИП — 15').optional().or(z.literal('')),
    legalAddress: z.string().trim().min(5, 'Укажите юридический адрес').max(300),
    bank: z.string().trim().max(200).optional(),
    bik: digits([9], 'БИК — 9 цифр').optional().or(z.literal('')),
    account: digits([20], 'Расчётный счёт — 20 цифр').optional().or(z.literal('')),
    corrAccount: digits([20], 'Корр. счёт — 20 цифр').optional().or(z.literal('')),
    director: z.string().trim().max(150).optional(),
    docsEmail: z.string().trim().email('Неверный email для документов').optional().or(z.literal('')),
  }).optional(),
}).superRefine((d, ctx) => {
  if (d.kind === 'person' && d.selfEmployed && !/^\d{12}$/.test(d.inn ?? '')) ctx.addIssue({ code: 'custom', path: ['inn'], message: 'ИНН самозанятого — 12 цифр' });
  if (d.kind === 'company' && !d.requisites) ctx.addIssue({ code: 'custom', path: ['requisites'], message: 'Заполните реквизиты компании' });
});

@Controller('client')
export class ClientController {
  private log = new Logger('Заказчики');
  private limiter = new LoginLimiter();
  private codes = new Map<string, { code: string; until: number; tries: number }>();

  constructor(@Inject(DB) private db: Db, private jwt: JwtService, private notify: NotificationsService,
    private shipmentsSvc: ShipmentsService, private orders: OrdersService, private pay: PaymentsService, private tariffs: TariffsService, private push: PushService) {}


  @Public()
  @Get('config')
  config() {
    return { vehicles: VEHICLE_IDS.map((id) => VEHICLES[id]), feePercent: this.tariffs.feePercent, payWaitMinutes: PAY_WAIT_MIN, testPayments: this.pay.testMode, debtLimitRub: DEBT_LIMIT_RUB };
  }

  /** Код входа по SMS. Без SMS-шлюза при разработке код возвращается в ответе. */
  @Public()
  @Post('auth/code')
  async requestCode(@Body(new Zod(z.object({ phone: z.string().min(10) }))) b: { phone: string }, @Ip() ip: string) {
    const phone = normPhone(b.phone);
    if (phone.length < 11) throw new BadRequestException('Введите номер полностью, например +7 900 000-00-00');
    this.limiter.check(ip, `code:${phone}`);
    this.limiter.fail(ip, `code:${phone}`);
    const code = String(randomInt(1000, 10000));
    this.codes.set(phone, { code, until: Date.now() + 10 * 60_000, tries: 0 });
    if (this.codes.size > 50_000) this.codes.clear();
    await this.notify.send({ companyId: null, channel: 'sms', to: `+${phone}`, text: `Код для входа: ${code}` });
    const dev = !process.env.SMSC_LOGIN && process.env.NODE_ENV !== 'production';
    if (dev) this.log.log(`Код входа для +${phone}: ${code}`);
    return { sent: true, ...(dev ? { devCode: code } : {}) };
  }

  @Public()
  @Post('auth/verify')
  async verify(@Body(new Zod(z.object({ phone: z.string(), code: z.string().length(4) }))) b: { phone: string; code: string }) {
    const phone = normPhone(b.phone);
    const rec = this.codes.get(phone);
    if (!rec || rec.until < Date.now()) throw new BadRequestException('Код устарел. Запросите новый.');
    if (++rec.tries > 5) { this.codes.delete(phone); throw new BadRequestException('Слишком много попыток. Запросите новый код.'); }
    if (rec.code !== b.code) throw new BadRequestException('Неверный код');
    this.codes.delete(phone);
    const [cust] = await this.db.insert(customers).values({ phone: `+${phone}` })
      .onConflictDoUpdate({ target: customers.phone, set: { phone: `+${phone}` } }).returning();
    const payload: AuthUser = { sub: cust.id, companyId: '', role: 'customer', name: cust.name };
    return { token: this.jwt.sign(payload, { expiresIn: '90d' }), registered: !!cust.registeredAt };
  }

  private async me(u: AuthUser) {
    const c = await this.db.query.customers.findFirst({ where: eq(customers.id, u.sub) });
    if (!c) throw new NotFoundException('Профиль не найден, войдите снова');
    return c;
  }
  /** Заказывать можно после анкеты, проверки карты и без долга. */
  private async ready(u: AuthUser) {
    const c = await this.me(u);
    if (!c.registeredAt) throw new ForbiddenException('Сначала заполните анкету заказчика');
    if (!c.cardMethodId) throw new ForbiddenException('Привяжите карту — оплата заказов только картой');
    await this.pay.assertNoDebt(c.id);
    return c;
  }
  private async view(c: typeof customers.$inferSelect) {
    const { cardMethodId, ...rest } = c;
    const debt = await this.pay.debt(c.id);
    return { ...rest, hasCard: !!cardMethodId, debtRub: debt.totalRub, blocked: debt.totalRub > DEBT_LIMIT_RUB };
  }

  @Roles('customer')
  @Get('me')
  async profile(@CurrentUser() u: AuthUser) { return this.view(await this.me(u)); }

  /** Анкета: ФИО, физлицо или компания; для компании — реквизиты для закрывающих документов. */
  @Roles('customer')
  @Put('me')
  async saveProfile(@CurrentUser() u: AuthUser, @Body(new Zod(ProfileDto)) d: z.infer<typeof ProfileDto>) {
    const me = await this.me(u);
    const [c] = await this.db.update(customers).set({
      lastName: d.lastName, firstName: d.firstName, middleName: d.middleName, name: `${d.firstName} ${d.lastName}`.trim(),
      email: d.email || null, kind: d.kind,
      selfEmployed: d.kind === 'person' && d.selfEmployed, inn: d.kind === 'person' && d.selfEmployed ? d.inn ?? null : d.requisites?.inn ?? null,
      requisites: d.kind === 'company' ? { ...d.requisites!, kpp: d.requisites!.kpp || undefined, ogrn: d.requisites!.ogrn || undefined } : null,
      registeredAt: me.registeredAt ?? new Date(),
    }).where(eq(customers.id, me.id)).returning();
    return this.view(c);
  }

  /* ---------- Карта ---------- */

  /** Проверка карты: резерв 1 ₽ с сохранением карты, затем резерв сразу снимается. */
  @Roles('customer')
  @Post('card')
  async bindCard(@CurrentUser() u: AuthUser) {
    const p = await this.pay.startCardCheck(await this.me(u));
    return { paymentId: p.id, status: p.status, confirmationUrl: p.status === 'pending' ? p.confirmationUrl : null, me: await this.view(await this.me(u)) };
  }

  /** Заказчик вернулся со страницы банка: проверяем, прошёл ли резерв 1 ₽. */
  @Roles('customer')
  @Post('card/check')
  async checkCard(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ paymentId: z.string().uuid() }))) b: { paymentId: string }) {
    const p = await this.pay.sync(await this.pay.get(b.paymentId, u.sub));
    return { status: p.status, confirmationUrl: p.status === 'pending' ? p.confirmationUrl : null, me: await this.view(await this.me(u)) };
  }

  @Roles('customer')
  @Delete('card')
  async unlinkCard(@CurrentUser() u: AuthUser) {
    const active = await this.db.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.customerId, u.sub), eq(shipments.payStatus, 'held'))).limit(1);
    if (active.length) throw new BadRequestException('Есть заказ с резервом на этой карте. Отвязать карту можно после его завершения.');
    const [c] = await this.db.update(customers).set({ cardMethodId: null, cardLast4: null, cardBrand: null, cardVerifiedAt: null }).where(eq(customers.id, u.sub)).returning();
    return this.view(c);
  }

  /* ---------- Долг ---------- */

  @Roles('customer')
  @Get('debt')
  debt(@CurrentUser() u: AuthUser) { return this.pay.debt(u.sub); }

  @Roles('customer')
  @Post('debt/pay')
  async payDebt(@CurrentUser() u: AuthUser) {
    const p = await this.pay.payDebt(await this.me(u));
    if (p.status === 'failed') throw new BadRequestException(`Оплата не прошла: ${p.error}. Пополните карту или привяжите другую.`);
    return { paymentId: p.id, status: p.status, confirmationUrl: p.status === 'pending' ? p.confirmationUrl : null, me: await this.view(await this.me(u)) };
  }

  @Roles('customer')
  @Post('debt/check')
  async checkDebt(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ paymentId: z.string().uuid() }))) b: { paymentId: string }) {
    const p = await this.pay.afterDebt(await this.pay.sync(await this.pay.get(b.paymentId, u.sub)));
    if (p.status === 'failed') throw new BadRequestException(`Оплата не прошла: ${p.error}`);
    return { status: p.status, confirmationUrl: p.status === 'pending' ? p.confirmationUrl : null, me: await this.view(await this.me(u)) };
  }

  /* ---------- Калькулятор и заявки ---------- */

  @Roles('customer')
  @Get('reverse')
  async reverse(@Query('lat') la: string, @Query('lng') ln: string) {
    const a = Number(la), b = Number(ln);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new BadRequestException('Нет координат');
    return (await reverseGeocode(a, b)) ?? { address: '', city: '', unavailable: true };
  }

  /** Калькулятор: какой транспорт подходит, расстояние и цена по тарифу города. */
  @Roles('customer')
  @Post('calc')
  calc(@Body(new Zod(CargoDto)) d: z.infer<typeof CargoDto>) { return this.orders.quote(d); }

  /* ---------- Оформление ---------- */

  /**
   * Заказ сразу к курьерам. Сумма резервируется на карте заказчика; получатель ничего не платит.
   * status: held — резерв прошёл, ищем курьера; pending — подтвердите оплату на странице банка.
   */
  @Roles('customer')
  @Post('orders')
  async create(@CurrentUser() u: AuthUser, @Body(new Zod(OrderDto)) d: z.infer<typeof OrderDto>) {
    const me = await this.ready(u);
    const r = await this.orders.create(await this.orders.platformId(), d, {
      source: 'client', payer: me, senderName: me.requisites?.companyName || me.name || me.phone, senderPhone: me.phone,
    });
    return { id: r.shipment.id, status: r.shipment.payStatus, confirmationUrl: r.confirmationUrl ?? null };
  }

  /** После страницы банка: проверить резерв по заказу. */
  @Roles('customer')
  @Post('orders/:id/pay-check')
  async payCheck(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.orders.checkPayment(await this.own(u, id));
    if (s.payStatus === 'awaiting' && s.paymentId) {
      const p = await this.pay.get(s.paymentId);
      if (p.status === 'failed') throw new BadRequestException(`Оплата не прошла: ${p.error}`);
      if (p.status === 'pending') return { id: s.id, status: 'pending', confirmationUrl: p.confirmationUrl };
    }
    return { id: s.id, status: s.payStatus, confirmationUrl: null };
  }

  @Roles('customer')
  @Get('orders')
  async list(@CurrentUser() u: AuthUser) {
    const orders = await this.db.select({
      id: shipments.id, trackingNumber: shipments.trackingNumber, status: shipments.status, address: shipments.address,
      pickupAddress: shipments.pickupAddress, recipientName: shipments.recipientName, priceRub: shipments.priceRub,
      createdAt: shipments.createdAt, pickedUpAt: shipments.pickedUpAt, rating: shipments.rating, payStatus: shipments.payStatus, payer: shipments.payer,
    }).from(shipments).where(eq(shipments.customerId, u.sub)).orderBy(desc(shipments.createdAt)).limit(100);
    const debt = await this.pay.debt(u.sub);
    return { orders, debtRub: debt.totalRub };
  }

  /* ---------- Заказы ---------- */

  private async own(u: AuthUser, id: string) {
    const s = await this.db.query.shipments.findFirst({ where: and(eq(shipments.id, id), eq(shipments.customerId, u.sub)) });
    if (!s) throw new NotFoundException('Заказ не найден');
    return s;
  }

  @Roles('customer')
  @Get('orders/:id')
  async orderView(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.own(u, id);
    const co = await this.db.query.companies.findFirst({ where: eq(companies.id, s.companyId), columns: { name: true, phone: true, brandColor: true } });
    let courier = null;
    if (s.courierId) {
      const c = await this.db.query.couriers.findFirst({ where: eq(couriers.id, s.courierId) });
      const [r] = await this.db.select({ avg: sql<number | null>`round(avg(${shipments.rating})::numeric, 1)`.mapWith((v) => (v == null ? null : Number(v))), n: sql<number>`count(${shipments.rating})`.mapWith(Number) })
        .from(shipments).where(eq(shipments.courierId, s.courierId));
      // Живое местоположение курьера, пока заказ у него (приложение курьера присылает точку каждые 15 секунд).
      const fresh = c?.lastSeenAt && Date.now() - c.lastSeenAt.getTime() < 5 * 60_000 && s.status === 'assigned';
      courier = c && {
        name: c.name.split(' ')[0], phone: s.status === 'assigned' ? c.phone : null, vehicle: c.vehicle ? VEHICLES[c.vehicle as VehicleId]?.short ?? c.vehicle : null,
        rating: r.avg, ratingCount: r.n, location: fresh ? { lat: c.lastLat, lng: c.lastLng, at: c.lastSeenAt } : null,
      };
    }
    const events = await this.db.select({ status: shipmentEvents.status, note: shipmentEvents.note, at: shipmentEvents.createdAt })
      .from(shipmentEvents).where(eq(shipmentEvents.shipmentId, s.id)).orderBy(asc(shipmentEvents.createdAt));
    return {
      id: s.id, trackingNumber: s.trackingNumber, status: s.status, priceRub: s.priceRub,
      pickupAddress: s.pickupAddress, address: s.address, city: s.city, recipientName: s.recipientName, recipientPhone: s.recipientPhone,
      comment: s.comment, payStatus: s.payStatus, payText: PAY_STATUS[s.payStatus] ?? '',
      vehicle: s.vehicle ? VEHICLES[s.vehicle as VehicleId]?.label : null,
      pickedUpAt: s.pickedUpAt, deliveredAt: s.deliveredAt, failReason: s.failReason, rating: s.rating, ratingComment: s.ratingComment,
      tipRub: s.tipRub, createdAt: s.createdAt, company: co, addressDetails: s.addressDetails,
      pickupPoint: s.pickupLat != null ? { lat: s.pickupLat, lng: s.pickupLng } : null,
      deliveryPoint: s.deliveryLat != null ? { lat: s.deliveryLat, lng: s.deliveryLng } : null,
      waitingCourier: !s.courierId && !!s.offeredAt && ['created', 'at_warehouse', 'failed'].includes(s.status),
      confirmCode: s.status === 'assigned' ? s.confirmCode : null,
      courier, events: events.map((e) => ({ ...e, note: e.note?.startsWith('Автоназначение') ? 'Назначен курьер' : e.note })),
    };
  }

  /** Отменить можно, пока курьер не забрал груз. Резерв снимается, деньги возвращаются на карту. */
  @Roles('customer')
  @Post('orders/:id/cancel')
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.own(u, id);
    if (s.pickedUpAt || ['delivered', 'failed', 'returned'].includes(s.status)) throw new BadRequestException('Заказ уже нельзя отменить: курьер забрал груз');
    await this.shipmentsSvc.setStatus({ companyId: s.companyId }, s.id, 'returned', 'Отменён заказчиком', { failReason: 'Отменён заказчиком', offeredAt: null });
    return this.orderView(u, id);
  }

  /** Оценка курьера и чаевые (списываются с карты и начисляются курьеру). Один раз на заказ. */
  @Roles('customer')
  @Post('orders/:id/rate')
  async rate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
    tipRub: z.number().int().min(0).max(10_000).default(0),
  }))) b: { rating: number; comment?: string; tipRub: number }) {
    const s = await this.own(u, id);
    if (s.status !== 'delivered') throw new BadRequestException('Оценить можно после вручения');
    if (s.ratedAt) throw new ForbiddenException('Вы уже оценили этот заказ');
    if (b.tipRub > 0) {
      await this.pay.tip(await this.me(u), b.tipRub, s);
      if (s.courierId) {
        const k = await this.db.query.couriers.findFirst({ where: eq(couriers.id, s.courierId), columns: { companyId: true } });
        await this.db.insert(courierLedger).values({ companyId: k?.companyId ?? s.companyId, courierId: s.courierId, shipmentId: s.id, kind: 'tip', amountRub: b.tipRub, method: 'card', note: `Чаевые за ${s.trackingNumber}` });
        await this.push.toCourier(s.courierId, { title: `Чаевые ${b.tipRub} ₽`, body: `Заказчик поблагодарил за доставку ${s.trackingNumber}`, data: { type: 'balance' } });
      }
    }
    await this.db.update(shipments).set({
      rating: b.rating, ratingComment: b.comment || null, tipRub: b.tipRub, tipMethod: b.tipRub ? 'card' : null, ratedAt: new Date(),
    }).where(eq(shipments.id, s.id));
    return this.orderView(u, id);
  }

  /**
   * Уведомления ЮKassa (в личном кабинете ЮKassa → HTTP-уведомления: https://ваш-домен/api/client/payments/webhook,
   * события payment.waiting_for_capture, payment.succeeded, payment.canceled).
   * Телу уведомления не доверяем: статус перечитываем у ЮKassa.
   */
  @Public()
  @Post('payments/webhook')
  @HttpCode(200)
  async webhook(@Body() body: any) {
    const id = body?.object?.id;
    if (typeof id !== 'string') return { ok: true };
    try {
      const row = await this.pay.byProviderId(id);
      if (!row) return { ok: true };
      const p = await this.pay.sync(row);
      if (p.kind === 'order' && p.shipmentId && p.status === 'held') await this.orders.onHeld(p.shipmentId);
    } catch (e: any) { this.log.warn(`Вебхук платежа ${id}: ${e.message}`); }
    return { ok: true };
  }
}

@Module({ imports: [ShipmentsModule, OrdersModule], controllers: [ClientController] })
export class ClientModule {}
