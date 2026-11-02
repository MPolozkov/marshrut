import {
  Body, Query, Controller, Get, HttpException, HttpStatus, Inject, Ip, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, desc, eq, gte, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, courierLedger, couriers, customers, shipments, supportRequests, users } from '../db/schema';
import { TariffsService } from '../platform/platform.service';
import { Rate, VEHICLE_IDS, VehicleId } from '../common/vehicles';
import { PLAN_IDS } from '../plans';
import { AuthGuard, AuthUser, Public, Roles, Zod } from '../common/auth';
import { LoginLimiter } from '../auth/auth.module';
import { PaymentsService } from '../payments/payments.service';

/*
 * Панель владельца платформы (/platform). Вход по ADMIN_EMAIL и ADMIN_PASSWORD из .env.
 * Если переменные не заданы, панель выключена.
 */

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Controller('platform')
export class AdminController {
  private limiter = new LoginLimiter();
  constructor(@Inject(DB) private db: Db, private jwt: JwtService, private guard: AuthGuard, private pay: PaymentsService, private tariffs: TariffsService) {}

  @Public()
  @Post('login')
  login(@Body(new Zod(z.object({ email: z.string().email(), password: z.string().min(1) }))) b: { email: string; password: string }, @Ip() ip: string) {
    const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
    if (!email || !password) throw new ServiceUnavailableException('Панель выключена: задайте ADMIN_EMAIL и ADMIN_PASSWORD в .env и перезапустите сервер');
    this.limiter.check(ip, 'admin');
    if (!same(b.email.toLowerCase(), email.toLowerCase()) || !same(b.password, password)) {
      this.limiter.fail(ip, 'admin');
      throw new UnauthorizedException('Неверный email или пароль');
    }
    this.limiter.reset(ip, 'admin');
    const payload: AuthUser = { sub: 'admin', companyId: '', role: 'superadmin', name: 'Администратор' };
    return { token: this.jwt.sign(payload, { expiresIn: '12h' }) };
  }

  /**
   * Деньги платформы: оплаченные заказы, доход платформы (её процент с каждого заказа), доля курьеров, чаевые, выплаты.
   */
  @Roles('superadmin')
  @Get('finance')
  async finance(@Query('days') days?: string) {
    const from = new Date(Date.now() - Math.min(366, Math.max(1, Number(days) || 30)) * 86_400_000);
    const t = await this.pay.totals(from);
    const [l] = await this.db.select({
      owed: sql<number>`coalesce(sum(${courierLedger.amountRub}) filter (where ${courierLedger.status} is null or ${courierLedger.status} <> 'failed'), 0)`.mapWith(Number),
      paidOut: sql<number>`coalesce(-sum(${courierLedger.amountRub}) filter (where ${courierLedger.kind} = 'payout' and ${courierLedger.status} = 'done' and ${courierLedger.createdAt} >= ${from}), 0)`.mapWith(Number),
    }).from(courierLedger);
    const [p] = await this.db.select({
      withCard: sql<number>`count(*) filter (where ${customers.cardMethodId} is not null and ${customers.phone} not like 'org:%')`.mapWith(Number),
      customers: sql<number>`count(*) filter (where ${customers.registeredAt} is not null and ${customers.phone} not like 'org:%')`.mapWith(Number),
    }).from(customers);
    const [o] = await this.db.select({
      awaiting: sql<number>`count(*) filter (where ${shipments.payStatus} = 'awaiting' and ${shipments.status} = 'created')`.mapWith(Number),
      unpaid: sql<number>`coalesce(sum(${shipments.priceRub}) filter (where ${shipments.payStatus} = 'failed'), 0)`.mapWith(Number),
    }).from(shipments);
    return { from, feePercent: this.tariffs.feePercent, testPayments: this.pay.testMode, testPayouts: this.pay.payouts.name === 'test', ...t, courierBalanceRub: l.owed, paidOutRub: l.paidOut, ...p, ...o };
  }

  /** Курьеры-самозанятые: заявки на подтверждение, статус «Мой налог», баланс. */
  @Roles('superadmin')
  @Get('couriers')
  async couriersList() {
    const list = await this.db.select({
      id: couriers.id, name: couriers.name, phone: couriers.phone, city: couriers.city, vehicle: couriers.vehicle, inn: couriers.inn,
      status: couriers.status, active: couriers.active, seStatus: couriers.seStatus, lastSeenAt: couriers.lastSeenAt, createdAt: couriers.createdAt, email: users.email,
    }).from(couriers).innerJoin(companies, eq(companies.id, couriers.companyId)).leftJoin(users, eq(users.id, couriers.userId))
      .where(eq(companies.kind, 'platform'))
      .orderBy(sql`case ${couriers.status} when 'pending' then 0 when 'approved' then 1 else 2 end`, desc(couriers.createdAt));
    const bal = await this.db.select({ id: courierLedger.courierId, b: sql<number>`coalesce(sum(${courierLedger.amountRub}) filter (where ${courierLedger.status} is null or ${courierLedger.status} <> 'failed'), 0)`.mapWith(Number) })
      .from(courierLedger).groupBy(courierLedger.courierId);
    const stats = await this.db.select({
      id: shipments.courierId, delivered: sql<number>`count(*) filter (where ${shipments.status} = 'delivered')`.mapWith(Number),
      rating: sql<number | null>`round(avg(${shipments.rating})::numeric, 1)`.mapWith((v) => (v == null ? null : Number(v))),
    }).from(shipments).groupBy(shipments.courierId);
    const B = new Map(bal.map((x) => [x.id, x.b])), S = new Map(stats.map((x) => [x.id, x]));
    return list.map((c) => ({ ...c, balanceRub: B.get(c.id) ?? 0, delivered: S.get(c.id)?.delivered ?? 0, rating: S.get(c.id)?.rating ?? null }));
  }

  /** Подтвердить, отклонить или заблокировать курьера. */
  @Roles('superadmin')
  @Patch('couriers/:id')
  async courierUpdate(@Param('id', ParseUUIDPipe) id: string, @Body(new Zod(z.object({ status: z.enum(['approved', 'rejected', 'pending']) }))) b: { status: string }) {
    const [c] = await this.db.update(couriers).set({ status: b.status, ...(b.status !== 'approved' ? { active: false } : {}) }).where(eq(couriers.id, id)).returning();
    if (!c) throw new NotFoundException('Курьер не найден');
    if (c.userId) await this.db.update(users).set({ active: b.status !== 'rejected' }).where(eq(users.id, c.userId));
    this.guard.forget();
    return c;
  }

  /** Тарифы доставки по городам. Город без своих тарифов считается по тарифам по умолчанию. */
  @Roles('superadmin')
  @Get('tariffs')
  async tariffsList() {
    const def = await this.tariffs.forCity('');
    return { defaults: def.rates, sharePercent: this.tariffs.sharePercent, cities: await this.tariffs.list() };
  }

  @Roles('superadmin')
  @Post('tariffs')
  saveTariff(@Body(new Zod(z.object({
    city: z.string().trim().min(2).max(80), nightPercent: z.number().int().min(0).max(200),
    rates: z.object(Object.fromEntries(VEHICLE_IDS.map((v) => [v, z.object({
      enabled: z.boolean(), baseRub: z.number().int().min(0).max(1_000_000), perKmRub: z.number().min(0).max(10_000),
      perKgRub: z.number().min(0).max(10_000), freeKg: z.number().min(0).max(40_000),
    })])) as Record<VehicleId, z.ZodType<Rate>>),
  }))) b: { city: string; nightPercent: number; rates: Record<VehicleId, Rate> }) {
    return this.tariffs.save(b.city, b.rates, b.nightPercent);
  }

  @Roles('superadmin')
  @Post('tariffs/delete')
  async deleteTariff(@Body(new Zod(z.object({ city: z.string() }))) b: { city: string }) { await this.tariffs.remove(b.city); return { ok: true }; }

  /** Сводка по платформе. */
  @Roles('superadmin')
  @Get('stats')
  async stats() {
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const [[c], [u], [k], [s], [s30], [active], plans, [tickets]] = await Promise.all([
      this.db.select({ n: count() }).from(companies),
      this.db.select({ n: count() }).from(users),
      this.db.select({ n: count() }).from(couriers).where(eq(couriers.status, 'approved')),
      this.db.select({ n: count() }).from(shipments),
      this.db.select({ n: count() }).from(shipments).where(gte(shipments.createdAt, monthAgo)),
      this.db.select({ n: sql<number>`count(distinct ${shipments.companyId})`.mapWith(Number) }).from(shipments).where(gte(shipments.createdAt, monthAgo)),
      this.db.select({ plan: companies.plan, n: count() }).from(companies).groupBy(companies.plan),
      this.db.select({ n: count() }).from(supportRequests).where(eq(supportRequests.status, 'new')),
    ]);
    return {
      companies: c.n, users: u.n, couriers: k.n, shipments: s.n, shipments30d: s30.n, activeCompanies30d: active.n,
      plans: Object.fromEntries(plans.map((p) => [p.plan, p.n])), newTickets: tickets.n,
    };
  }

  /** Все компании с объёмом работы и последней активностью. */
  @Roles('superadmin')
  @Get('companies')
  async companies() {
    const list = await this.db.select({
      id: companies.id, name: companies.name, slug: companies.slug, city: companies.city, phone: companies.phone,
      inn: companies.inn, plan: companies.plan, trialEndsAt: companies.trialEndsAt, paidUntil: companies.paidUntil, blocked: companies.blocked, createdAt: companies.createdAt,
      modules: companies.modules, hasApiKey: sql<boolean>`${companies.apiKeyHash} is not null`,
    }).from(companies).where(eq(companies.kind, 'business')).orderBy(desc(companies.createdAt));
    const [usersBy, couriersBy, shipBy] = await Promise.all([
      this.db.select({ id: users.companyId, n: count() }).from(users).groupBy(users.companyId),
      this.db.select({ id: couriers.companyId, n: count() }).from(couriers).where(eq(couriers.status, 'approved')).groupBy(couriers.companyId),
      this.db.select({ id: shipments.companyId, n: count(), last: max(shipments.createdAt),
        n30: sql<number>`count(*) filter (where ${shipments.createdAt} > now() - interval '30 days')`.mapWith(Number) })
        .from(shipments).groupBy(shipments.companyId),
    ]);
    const m = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
    const U = m(usersBy), K = m(couriersBy), S = m(shipBy);
    return list.map((c) => ({
      ...c, users: U.get(c.id)?.n ?? 0, couriers: K.get(c.id)?.n ?? 0,
      shipments: S.get(c.id)?.n ?? 0, shipments30d: S.get(c.id)?.n30 ?? 0, lastShipmentAt: S.get(c.id)?.last ?? null,
    }));
  }

  @Roles('superadmin')
  @Get('companies/:id')
  async company(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.id, id) });
    if (!c) throw new NotFoundException('Компания не найдена');
    const { apiKeyHash, webhookSecret, ...rest } = c;
    const staff = await this.db.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, createdAt: users.createdAt })
      .from(users).where(eq(users.companyId, id)).orderBy(asc(users.role), asc(users.name));
    return { ...rest, hasApiKey: !!apiKeyHash, staff };
  }

  /** Блокировка (неоплата, нарушение) и смена тарифа. */
  @Roles('superadmin')
  @Patch('companies/:id')
  async update(@Param('id', ParseUUIDPipe) id: string,
    @Body(new Zod(z.object({ blocked: z.boolean().optional(), plan: z.enum(PLAN_IDS).optional(), trialEndsAt: z.coerce.date().nullable().optional(), paidUntil: z.coerce.date().nullable().optional() }))) b: { blocked?: boolean; plan?: (typeof PLAN_IDS)[number]; trialEndsAt?: Date | null; paidUntil?: Date | null }) {
    const [c] = await this.db.update(companies).set(b).where(eq(companies.id, id)).returning({ id: companies.id, blocked: companies.blocked, plan: companies.plan });
    if (!c) throw new NotFoundException('Компания не найдена');
    this.guard.forget();
    return c;
  }

  /** Обращения в поддержку и заявки на подключение: сначала новые. */
  @Roles('superadmin')
  @Get('support')
  support() {
    return this.db.select({
      id: supportRequests.id, topic: supportRequests.topic, subject: supportRequests.subject, message: supportRequests.message,
      details: supportRequests.details, contactName: supportRequests.contactName, contactEmail: supportRequests.contactEmail,
      contactPhone: supportRequests.contactPhone, status: supportRequests.status, emailSent: supportRequests.emailSent,
      createdAt: supportRequests.createdAt, companyId: supportRequests.companyId, companyName: companies.name,
    }).from(supportRequests).leftJoin(companies, eq(companies.id, supportRequests.companyId))
      .orderBy(sql`case ${supportRequests.status} when 'new' then 0 when 'in_progress' then 1 else 2 end`, desc(supportRequests.createdAt))
      .limit(300);
  }

  @Roles('superadmin')
  @Patch('support/:id')
  async supportStatus(@Param('id', ParseUUIDPipe) id: string, @Body(new Zod(z.object({ status: z.enum(['new', 'in_progress', 'done']) }))) b: { status: string }) {
    const [r] = await this.db.update(supportRequests).set({ status: b.status }).where(eq(supportRequests.id, id)).returning({ id: supportRequests.id });
    if (!r) throw new NotFoundException('Обращение не найдено');
    return { ok: true };
  }

  /** Войти в кабинет компании от имени владельца — для поддержки клиента. */
  @Roles('superadmin')
  @Post('companies/:id/login-as')
  async loginAs(@Param('id', ParseUUIDPipe) id: string) {
    const owner = await this.db.query.users.findFirst({ where: and(eq(users.companyId, id), eq(users.role, 'owner')) });
    if (!owner) throw new HttpException('У компании нет владельца', HttpStatus.CONFLICT);
    const payload: AuthUser = { sub: owner.id, companyId: id, role: 'owner', name: `${owner.name} (поддержка)` };
    return { token: this.jwt.sign(payload, { expiresIn: '2h' }) };
  }
}

@Module({ controllers: [AdminController], providers: [AuthGuard] })
export class AdminModule {}
