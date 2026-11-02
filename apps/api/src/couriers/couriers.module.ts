import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, courierLedger, couriers, shipments, users } from '../db/schema';
import { COURIER_CAN, VEHICLE_IDS, VehicleId, VEHICLES } from '../common/vehicles';
import { TariffsService } from '../platform/platform.service';
import { PaymentsService } from '../payments/payments.service';
import { distanceKm, sameCity } from '../common/geo';
import { ShipmentsModule } from '../shipments/shipments.module';
import { DELIVER_RADIUS_M, ShipmentsService } from '../shipments/shipments.service';

/** Волны предложения: сначала курьерам в 3 км от точки забора, каждую минуту радиус растёт на 2 км, через 10 минут — всем. */
const WAVE = { startKm: 3, stepKm: 2, allAfterMin: 10, noGpsAfterMin: 1 };
/** Баланс курьера: сколько компания ему должна (минус — у курьера на руках наличные компании). */
export const balanceSql = sql<number>`coalesce(sum(${courierLedger.amountRub}) filter (where ${courierLedger.status} is null or ${courierLedger.status} <> 'failed'), 0)`.mapWith(Number);
const MIN_PAYOUT_RUB = Number(process.env.MIN_PAYOUT_RUB ?? 100);
import { AuthUser, CurrentUser, Roles, Zod } from '../common/auth';

const CourierDto = z.object({
  name: z.string().min(2),
  phone: z.string().min(5),
  zoneId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  city: z.string().max(80).optional(),
});
const PatchDto = CourierDto.partial().extend({
  active: z.boolean().optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

@Controller('couriers')
@Roles('dispatcher')
export class CouriersController {
  constructor(@Inject(DB) private db: Db) {}

  /** Курьеры с загрузкой. Сначала заявки на подтверждение. */
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.db.select({
      id: couriers.id, name: couriers.name, phone: couriers.phone, zoneId: couriers.zoneId, active: couriers.active,
      userId: couriers.userId, status: couriers.status, vehicle: couriers.vehicle, city: couriers.city,
      createdAt: couriers.createdAt, email: users.email,
      inWork: sql<number>`count(${shipments.id}) filter (where ${shipments.status} = 'assigned')`.mapWith(Number),
      rating: sql<number | null>`round(avg(${shipments.rating})::numeric, 1)`.mapWith((v) => (v == null ? null : Number(v))),
      lastSeenAt: couriers.lastSeenAt, selfEmployed: couriers.selfEmployed,
    })
      .from(couriers)
      .leftJoin(users, eq(users.id, couriers.userId))
      .leftJoin(shipments, eq(shipments.courierId, couriers.id))
      .where(eq(couriers.companyId, u.companyId))
      .groupBy(couriers.id, users.email)
      .orderBy(sql`case ${couriers.status} when 'pending' then 0 when 'approved' then 1 else 2 end`, asc(couriers.name));
  }

  /** Код, который диспетчер сообщает новым курьерам для регистрации в приложении. */
  @Get('invite-code')
  async inviteCode(@CurrentUser() u: AuthUser) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId), columns: { inviteCode: true, name: true } });
    return { inviteCode: c?.inviteCode ?? null, company: c?.name };
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body(new Zod(CourierDto)) dto: z.infer<typeof CourierDto>) {
    const [c] = await this.db.insert(couriers).values({ ...dto, companyId: u.companyId, status: 'approved' }).returning();
    return c;
  }

  /** Правка карточки, вывод на линию, подтверждение или отклонение заявки. */
  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(PatchDto)) dto: z.infer<typeof PatchDto>) {
    const cur = await this.db.query.couriers.findFirst({ where: and(eq(couriers.id, id), eq(couriers.companyId, u.companyId)) });
    if (!cur) throw new NotFoundException('Курьер не найден');
    const status = dto.status ?? cur.status;
    if (dto.active && status !== 'approved') throw new BadRequestException('Сначала подтвердите заявку курьера');
    const set = { ...dto, ...(dto.status && dto.status !== 'approved' ? { active: false } : {}) };
    const [c] = await this.db.update(couriers).set(set).where(eq(couriers.id, id)).returning();
    // Отклонённый курьер теряет доступ к приложению.
    if (c.userId && dto.status) await this.db.update(users).set({ active: dto.status !== 'rejected' }).where(eq(users.id, c.userId));
    return c;
  }
}

/** Эндпоинты для мобильного приложения курьера. */
@Controller('courier')
@Roles('courier')
export class CourierAppController {
  constructor(@Inject(DB) private db: Db, private shipmentsSvc: ShipmentsService, private tariffs: TariffsService, private pay: PaymentsService) {}

  private async me(u: AuthUser) {
    const me = await this.db.query.couriers.findFirst({ where: and(eq(couriers.userId, u.sub), eq(couriers.companyId, u.companyId)) });
    if (!me) throw new NotFoundException('Профиль курьера не найден, обратитесь в поддержку');
    return me;
  }
  private async approved(u: AuthUser) {
    const me = await this.me(u);
    if (me.status !== 'approved') throw new ForbiddenException('Заявка ещё не подтверждена');
    return me;
  }

  /** Профиль, статус заявки и бренд компании для шапки приложения. */
  @Get('me')
  async profile(@CurrentUser() u: AuthUser) {
    const me = await this.me(u);
    const c = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) });
    const user = await this.db.query.users.findFirst({ where: eq(users.id, u.sub), columns: { email: true } });
    return {
      ...me, email: user?.email,
      company: c && { name: c.name, city: c.city, brandColor: c.brandColor, logoUrl: c.logoUrl, phone: c.phone },
    };
  }

  @Patch('me')
  async updateProfile(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({
    name: z.string().trim().min(2).optional(), phone: z.string().min(10).optional(), vehicle: z.enum(VEHICLE_IDS).optional(),
    city: z.string().trim().min(2).max(80).optional(),
    selfEmployed: z.boolean().optional(),
    inn: z.string().trim().regex(/^(\d{12})?$/, 'ИНН — 12 цифр').optional(),
    payoutMethod: z.enum(['sbp']).optional(),
    payoutDetails: z.string().trim().max(100).optional(),
    sbpBankId: z.string().trim().max(40).optional(),
  }))) dto: { name?: string; phone?: string; vehicle?: VehicleId; city?: string; selfEmployed?: boolean; inn?: string; payoutMethod?: string; payoutDetails?: string; sbpBankId?: string }) {
    const me = await this.me(u);
    // Сменили ИНН — разрешение в «Мой налог» нужно получить заново.
    const reset = dto.inn !== undefined && dto.inn !== (me.inn ?? '') ? { seId: null, seStatus: 'none' } : {};
    const [c] = await this.db.update(couriers).set({ ...dto, ...reset }).where(eq(couriers.id, me.id)).returning();
    if (dto.name) await this.db.update(users).set({ name: dto.name }).where(eq(users.id, u.sub));
    return c;
  }

  /** Выход на линию и уход с линии (начало и конец смены). */
  @Post('shift')
  async shift(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ active: z.boolean() }))) b: { active: boolean }) {
    const me = await this.approved(u);
    const [c] = await this.db.update(couriers).set({ active: b.active }).where(eq(couriers.id, me.id)).returning();
    return c;
  }

  /** Геопозиция, пока курьер на линии: по ней новые заказы уходят ближайшему курьеру. */
  @Post('location')
  async location(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))) b: { lat: number; lng: number }) {
    const me = await this.approved(u);
    await this.db.update(couriers).set({ lastLat: b.lat, lastLng: b.lng, lastSeenAt: new Date() }).where(eq(couriers.id, me.id));
    return { ok: true };
  }

  /** Заработок и оценка: за сегодня и за 30 дней. */
  @Get('stats')
  async stats(@CurrentUser() u: AuthUser) {
    const me = await this.approved(u);
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const month = new Date(Date.now() - 30 * 86_400_000);
    const agg = (from: Date) => this.db.select({
      delivered: sql<number>`count(*)`.mapWith(Number),
      payRub: sql<number>`coalesce(sum(${shipments.courierPayRub}), 0)`.mapWith(Number),
      tipsRub: sql<number>`coalesce(sum(${shipments.tipRub}), 0)`.mapWith(Number),
      codRub: sql<number>`coalesce(sum(${shipments.codCollected}), 0)`.mapWith(Number),
    }).from(shipments).where(and(eq(shipments.courierId, me.id), eq(shipments.status, 'delivered'), gte(shipments.deliveredAt, from)));
    const [[today], [last30], [rate]] = await Promise.all([agg(day), agg(month), this.db.select({
      avg: sql<number | null>`round(avg(${shipments.rating})::numeric, 2)`.mapWith((v) => (v == null ? null : Number(v))),
      n: sql<number>`count(${shipments.rating})`.mapWith(Number),
    }).from(shipments).where(eq(shipments.courierId, me.id))]);
    return { today, last30, rating: rate.avg, ratingCount: rate.n, sharePercent: this.tariffs.sharePercent };
  }

  /**
   * Доступные заказы: выставлены курьерам, ещё никем не взяты, подходят по транспорту и городу.
   * Ближайшие видят заказ первыми; без геопозиции — через минуту.
   */
  @Get('offers')
  async offers(@CurrentUser() u: AuthUser) {
    const me = await this.approved(u);
    if (!me.active) return [];
    const can = COURIER_CAN[(me.vehicle ?? 'foot') as VehicleId] ?? ['foot'];
    // Заказы всех заказчиков платформы: организаций и физлиц. Видны только оплаченные (резерв прошёл).
    const rows = await this.db.select().from(shipments).where(and(
      isNull(shipments.courierId), isNotNull(shipments.offeredAt), inArray(shipments.payStatus, ['held', 'none']),
      inArray(shipments.status, ['created', 'at_warehouse', 'failed']),
    )).orderBy(asc(shipments.offeredAt)).limit(300);
    const gps = me.lastLat != null && me.lastLng != null && me.lastSeenAt && Date.now() - me.lastSeenAt.getTime() < 20 * 60_000
      ? { lat: me.lastLat, lng: me.lastLng } : null;
    return rows
      .filter((s) => !s.vehicle || can.includes(s.vehicle as VehicleId))
      .filter((s) => !me.city || !s.city || sameCity(me.city, s.city))
      .map((s) => {
        const km = gps && s.pickupLat != null && s.pickupLng != null ? distanceKm(gps, { lat: s.pickupLat, lng: s.pickupLng }) : null;
        const min = (Date.now() - s.offeredAt!.getTime()) / 60_000;
        const visible = min >= WAVE.allAfterMin || (km != null ? km <= WAVE.startKm + WAVE.stepKm * min : min >= WAVE.noGpsAfterMin);
        return { s, km, visible };
      })
      .filter((x) => x.visible)
      .sort((a, b) => (a.km ?? 999) - (b.km ?? 999))
      .map(({ s, km }) => ({
        id: s.id, trackingNumber: s.trackingNumber, pickupAddress: s.pickupAddress, address: s.address, city: s.city,
        vehicle: s.vehicle, vehicleLabel: s.vehicle ? VEHICLES[s.vehicle as VehicleId]?.short : null,
        weightKg: s.weightKg, dims: `${s.lengthCm}×${s.widthCm}×${s.heightCm}`, comment: s.comment, priceRub: s.priceRub,
        payRub: this.tariffs.courierShare(s.priceRub), paymentMethod: s.paymentMethod, codRub: s.codRub,
        distanceKm: km == null ? null : Math.round(km * 10) / 10, offeredAt: s.offeredAt,
      }));
  }

  /** «Беру»: заказ достаётся первому принявшему. */
  @Post('offers/:id/accept')
  async accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const me = await this.approved(u);
    if (!me.active) throw new BadRequestException('Выйдите на линию, чтобы брать заказы');
    const s = await this.db.query.shipments.findFirst({ where: eq(shipments.id, id) });
    if (!s) throw new NotFoundException('Заказ не найден');
    if (me.city && s.city && !sameCity(me.city, s.city)) throw new BadRequestException('Заказ в другом городе');
    const can = COURIER_CAN[(me.vehicle ?? 'foot') as VehicleId] ?? ['foot'];
    if (s.vehicle && !can.includes(s.vehicle as VehicleId)) throw new BadRequestException(`Для этого заказа нужен транспорт: ${VEHICLES[s.vehicle as VehicleId]?.label}`);
    return this.shipmentsSvc.claim(s.companyId, id, { id: me.id, name: me.name, userId: u.sub });
  }

  /** Баланс и движения денег: начисления за заказы, чаевые, выплаты. Незавершённые выплаты сверяем с платёжным сервисом. */
  @Get('balance')
  async balance(@CurrentUser() u: AuthUser) {
    const me = await this.approved(u);
    const pending = await this.db.select().from(courierLedger).where(and(eq(courierLedger.courierId, me.id), eq(courierLedger.status, 'pending')));
    for (const e of pending) if (e.providerId) {
      const st = await this.pay.payouts.payoutStatus(e.providerId).catch(() => null);
      if (st && st.status !== 'pending') await this.db.update(courierLedger).set({ status: st.status === 'succeeded' ? 'done' : 'failed', note: st.status === 'succeeded' ? e.note : `${e.note} — не прошла, деньги на балансе` }).where(eq(courierLedger.id, e.id));
    }
    const [b] = await this.db.select({ balance: balanceSql }).from(courierLedger).where(eq(courierLedger.courierId, me.id));
    const entries = await this.db.select().from(courierLedger).where(eq(courierLedger.courierId, me.id)).orderBy(desc(courierLedger.createdAt)).limit(50);
    return {
      balanceRub: b.balance, minPayoutRub: MIN_PAYOUT_RUB, testMode: this.pay.payouts.name === 'test',
      selfEmployed: me.selfEmployed, inn: me.inn, seStatus: me.seStatus, payoutDetails: me.payoutDetails, sbpBankId: me.sbpBankId,
      entries: entries.map((e) => ({ id: e.id, kind: e.kind, amountRub: e.amountRub, note: e.note, status: e.status, createdAt: e.createdAt })),
    };
  }

  /** Банки для выплат по СБП. */
  @Get('sbp-banks')
  banks() { return this.pay.payouts.banks(); }

  /**
   * Подключение самозанятого: курьер даёт платформе разрешение в «Мой налог» формировать чеки от его имени.
   * Без этого выплаты не отправляются: каждый вывод денег сопровождается чеком самозанятого.
   */
  @Post('self-employed')
  async selfEmployed(@CurrentUser() u: AuthUser) {
    const me = await this.approved(u);
    if (!/^\d{12}$/.test(me.inn ?? '')) throw new BadRequestException('Укажите ИНН самозанятого (12 цифр) в настройках');
    if (me.seId) {
      const st = await this.pay.payouts.selfEmployedStatus(me.seId).catch(() => null);
      if (st) {
        const seStatus = st.status === 'confirmed' ? 'confirmed' : st.status === 'pending' ? 'pending' : 'none';
        await this.db.update(couriers).set({ seStatus, ...(seStatus === 'none' ? { seId: null } : {}) }).where(eq(couriers.id, me.id));
        if (seStatus !== 'none') return { status: seStatus, confirmationUrl: st.confirmationUrl ?? null };
      }
    }
    const se = await this.pay.payouts.selfEmployed(me.inn!, me.payoutDetails || me.phone).catch((e) => { throw new BadRequestException(e.message); });
    const seStatus = se.status === 'confirmed' ? 'confirmed' : se.status === 'pending' ? 'pending' : 'none';
    await this.db.update(couriers).set({ seId: se.id, seStatus, selfEmployed: true }).where(eq(couriers.id, me.id));
    if (se.status === 'unregistered') throw new BadRequestException('ИНН не зарегистрирован как самозанятый. Зарегистрируйтесь в приложении «Мой налог» и повторите.');
    return { status: seStatus, confirmationUrl: se.confirmationUrl ?? null };
  }

  /** Вывести деньги по СБП. Чек в «Мой налог» формируется автоматически. */
  @Post('payout')
  async payout(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ amountRub: z.number().int().positive().optional() }))) b: { amountRub?: number }) {
    const me = await this.approved(u);
    if (me.seStatus !== 'confirmed' || !me.seId) throw new BadRequestException('Подключите статус самозанятого в настройках: «Мой налог» → разрешение для платформы');
    if (!me.payoutDetails || !me.sbpBankId) throw new BadRequestException('Укажите телефон и банк для выплат по СБП');
    const [bal] = await this.db.select({ balance: balanceSql }).from(courierLedger).where(eq(courierLedger.courierId, me.id));
    const amount = Math.min(b.amountRub ?? bal.balance, bal.balance);
    if (amount < MIN_PAYOUT_RUB) throw new BadRequestException(`Минимальная сумма вывода — ${MIN_PAYOUT_RUB} ₽`);
    // Сначала списываем с баланса (pending), чтобы двойное нажатие не вывело деньги дважды.
    const [row] = await this.db.insert(courierLedger).values({ companyId: me.companyId, courierId: me.id, kind: 'payout', amountRub: -amount, method: 'sbp', note: 'Вывод по СБП', status: 'pending' }).returning();
    try {
      const p = await this.pay.payouts.payout({ amountRub: amount, phone: me.payoutDetails, bankId: me.sbpBankId, seId: me.seId, description: 'Вознаграждение за доставки', meta: { courierId: me.id, ledgerId: row.id } });
      await this.db.update(courierLedger).set({ providerId: p.id, status: p.status === 'succeeded' ? 'done' : p.status === 'canceled' ? 'failed' : 'pending' }).where(eq(courierLedger.id, row.id));
      if (p.status === 'canceled') throw new BadRequestException(`Выплата не прошла${p.reason ? `: ${p.reason}` : ''}. Деньги остались на балансе.`);
      return { status: p.status, amountRub: amount };
    } catch (e: any) {
      await this.db.update(courierLedger).set({ status: 'failed' }).where(and(eq(courierLedger.id, row.id), eq(courierLedger.status, 'pending')));
      throw e instanceof BadRequestException ? e : new BadRequestException(`Выплата не прошла: ${e.message}. Деньги остались на балансе.`);
    }
  }

  /** Список на сегодня: активные доставки и уже закрытые за день. */
  @Get('my-shipments')
  async mine(@CurrentUser() u: AuthUser) {
    const me = await this.approved(u);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const rows = await this.db.select({
      id: shipments.id, trackingNumber: shipments.trackingNumber, recipientName: shipments.recipientName,
      recipientPhone: shipments.recipientPhone, address: shipments.address, city: shipments.city, codRub: shipments.codRub,
      status: shipments.status, weightKg: shipments.weightKg, updatedAt: shipments.updatedAt, priceRub: shipments.priceRub,
      pickupAddress: shipments.pickupAddress, pickupName: shipments.pickupName, pickupPhone: shipments.pickupPhone,
      pickedUpAt: shipments.pickedUpAt, comment: shipments.comment, paymentMethod: shipments.paymentMethod,
      courierPayRub: shipments.courierPayRub, tipRub: shipments.tipRub, rating: shipments.rating, createdAt: shipments.createdAt,
      vehicle: shipments.vehicle, payStatus: shipments.payStatus,
      addressDetails: shipments.addressDetails, deliveryLat: shipments.deliveryLat, deliveryLng: shipments.deliveryLng,
      pickupLat: shipments.pickupLat, pickupLng: shipments.pickupLng,
    }).from(shipments).where(and(
      eq(shipments.courierId, me.id),
      or(eq(shipments.status, 'assigned'), and(inArray(shipments.status, ['delivered', 'failed']), gte(shipments.updatedAt, dayStart))),
    )).orderBy(asc(shipments.createdAt));
    // Сколько курьер получит за заказ — видно до вручения.
    return rows.map((r) => ({ ...r, courierPayRub: r.courierPayRub ?? this.tariffs.courierShare(r.priceRub), deliverRadiusM: DELIVER_RADIUS_M }));
  }
}

@Module({ imports: [ShipmentsModule], controllers: [CouriersController, CourierAppController] })
export class CouriersModule {}
