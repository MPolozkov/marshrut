import { BadRequestException, Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { customers, payments, shipments } from '../db/schema';
import { createProvider, PaymentProvider, ProviderPayment, reasonText } from './provider';
import { createPayouts, PayoutProvider } from './payouts';

type Payment = typeof payments.$inferSelect;
type Customer = typeof customers.$inferSelect;
/** Плательщик: заказчик с сохранённой картой. */
interface Payer { customerId: string | null; phone?: string | null; email?: string | null; methodId?: string | null }

/** Долг, при котором заказчик не может оформлять новые доставки (по умолчанию — любой). */
export const DEBT_LIMIT_RUB = Number(process.env.DEBT_LIMIT_RUB ?? 0);
const RETRY_WITH_3DS = new Set(['3d_secure_failed', 'permission_revoked', 'general_decline', 'call_issuer']);
const toStatus = (p: ProviderPayment): string =>
  p.status === 'waiting_for_capture' ? 'held' : p.status === 'succeeded' ? 'captured' : p.status === 'canceled' ? 'failed' : 'pending';
const asPayer = (c: Customer): Payer => ({ customerId: c.id, phone: c.phone.startsWith('org:') ? null : c.phone, email: c.email ?? c.requisites?.docsEmail ?? null, methodId: c.cardMethodId });

/**
 * Деньги только картой.
 * • Проверка карты заказчика: резерв 1 ₽ с сохранением карты и сразу отмена резерва.
 * • Доставка: сумма резервируется на карте заказчика (физлица или организации); после вручения списывается,
 *   при отмене — резерв снимается и деньги возвращаются на ту же карту. Получатель ничего не платит.
 * • Не списалось после вручения — повторная попытка; иначе долг блокирует новые заказы.
 * • Чаевые — списанием с сохранённой карты.
 */
@Injectable()
export class PaymentsService {
  private log = new Logger('Платежи');
  readonly provider: PaymentProvider = createProvider();
  readonly payouts: PayoutProvider = createPayouts();
  constructor(@Inject(DB) private db: Db) {}

  get testMode() { return this.provider.name === 'test'; }
  private site() { return process.env.PUBLIC_URL ?? 'http://localhost:5173'; }

  private async start(payer: Payer, kind: string, amountRub: number, description: string, o: {
    capture: boolean; save?: boolean; confirm?: boolean; returnUrl?: string; companyId?: string | null; shipmentId?: string | null; meta?: Record<string, unknown>;
  }) {
    const useSaved = !o.save && !!payer.methodId && !o.returnUrl;
    let p: ProviderPayment;
    try {
      p = await this.provider.create({
        amountRub, capture: o.capture, description, saveMethod: o.save,
        methodId: useSaved ? payer.methodId! : undefined,
        returnUrl: o.returnUrl ?? (o.save || o.confirm || !useSaved ? `${this.site()}/pay/done` : undefined),
        metadata: { kind, ...(payer.customerId ? { customerId: payer.customerId } : {}), ...(o.shipmentId ? { shipmentId: o.shipmentId } : {}) },
        customer: { phone: payer.phone ?? undefined, email: payer.email },
      });
    } catch (e: any) {
      this.log.error(e.message);
      throw new BadRequestException('Платёжный сервис недоступен. Попробуйте через минуту.');
    }
    const [row] = await this.db.insert(payments).values({
      customerId: payer.customerId, kind, provider: this.provider.name, providerId: p.id, amountRub, status: toStatus(p),
      confirmationUrl: p.confirmationUrl ?? null, error: p.status === 'canceled' ? reasonText(p.cancelReason) : null,
      companyId: o.companyId ?? null, shipmentId: o.shipmentId ?? null, meta: o.meta ?? {},
    }).returning();
    return { row, p };
  }

  private async save(row: Payment, p: ProviderPayment) {
    const [r] = await this.db.update(payments).set({ status: toStatus(p), error: p.status === 'canceled' ? reasonText(p.cancelReason) : null, updatedAt: new Date() })
      .where(eq(payments.id, row.id)).returning();
    return r;
  }

  async get(id: string, customerId?: string) {
    const r = await this.db.query.payments.findFirst({ where: customerId ? and(eq(payments.id, id), eq(payments.customerId, customerId)) : eq(payments.id, id) });
    if (!r) throw new BadRequestException('Платёж не найден');
    return r;
  }
  async byProviderId(providerId: string) {
    return this.db.query.payments.findFirst({ where: and(eq(payments.provider, this.provider.name), eq(payments.providerId, providerId)) });
  }

  /** Актуальный статус от платёжного сервиса (после страницы банка или из вебхука). */
  async sync(row: Payment) {
    if (row.status !== 'pending' && !(row.kind === 'card_check' && row.status === 'held')) return row;
    const p = await this.provider.get(row.providerId);
    const r = await this.save(row, p);
    if (row.kind === 'card_check') return this.finishCardCheck(r, p);
    if (row.kind === 'debt' && r.status === 'captured') await this.afterDebt(r);
    return r;
  }

  /* ---------- Карта заказчика ---------- */

  async startCardCheck(c: Customer) {
    const { row, p } = await this.start({ ...asPayer(c), methodId: null }, 'card_check', 1, 'Проверка карты: 1 ₽ вернётся сразу', { capture: false, save: true });
    if (p.status === 'waiting_for_capture') return this.finishCardCheck(row, p);
    if (p.status === 'canceled') throw new BadRequestException(`Карта не прошла проверку: ${reasonText(p.cancelReason)}`);
    return row;
  }

  private async finishCardCheck(row: Payment, p: ProviderPayment) {
    if (p.status === 'canceled' && row.status !== 'canceled') throw new BadRequestException(`Карта не прошла проверку: ${reasonText(p.cancelReason)}`);
    if (p.status !== 'waiting_for_capture') return row;
    if (!p.methodId || p.methodSaved === false) {
      await this.provider.cancel(p.id).catch(() => {});
      throw new BadRequestException('Банк не разрешил сохранить карту для оплаты. Попробуйте другую карту.');
    }
    await this.db.update(customers).set({ cardMethodId: p.methodId, cardLast4: p.card?.last4 ?? null, cardBrand: p.card?.brand ?? null, cardVerifiedAt: new Date() })
      .where(eq(customers.id, row.customerId!));
    const c = await this.provider.cancel(p.id).catch((e) => { this.log.error(`Не отменён резерв 1 ₽ ${p.id}: ${e.message}`); return null; });
    const [r] = await this.db.update(payments).set({ status: c ? 'canceled' : 'held', error: null, updatedAt: new Date() }).where(eq(payments.id, row.id)).returning();
    return r;
  }

  needCard(c: Customer) {
    if (!c.cardMethodId) throw new BadRequestException('Привяжите карту в профиле — оплата только картой');
  }

  /* ---------- Доставка ---------- */

  /** Резерв с сохранённой карты заказчика (если он платит сам). При отказе — повтор через страницу банка. */
  async holdFromCustomer(c: Customer, s: { id: string; companyId: string; priceRub: number; trackingNumber: string }) {
    this.needCard(c);
    const d = `Доставка ${s.trackingNumber}`;
    let { row, p } = await this.start(asPayer(c), 'order', s.priceRub, d, { capture: false, companyId: s.companyId, shipmentId: s.id });
    if (p.status === 'canceled' && !this.testMode && RETRY_WITH_3DS.has(p.cancelReason ?? '')) {
      ({ row, p } = await this.start(asPayer(c), 'order', s.priceRub, d, { capture: false, confirm: true, companyId: s.companyId, shipmentId: s.id }));
    }
    return row;
  }

  /** Вручено: списываем резерв. Не вышло — пробуем списать с сохранённой карты заказчика (если платил он); иначе — долг. */
  async captureShipment(shipmentId: string) {
    const s = await this.db.query.shipments.findFirst({ where: eq(shipments.id, shipmentId) });
    if (!s?.paymentId || s.payStatus !== 'held') return s?.payStatus ?? 'none';
    const row = await this.get(s.paymentId);
    let ok = false;
    try { ok = (await this.save(row, await this.provider.capture(row.providerId, s.priceRub))).status === 'captured'; }
    catch (e: any) { this.log.warn(`Списание резерва ${row.providerId}: ${e.message}`); }
    if (!ok && s.payer === 'sender' && row.customerId) {
      const c = await this.db.query.customers.findFirst({ where: eq(customers.id, row.customerId) });
      if (c?.cardMethodId) {
        const again = await this.start(asPayer(c), 'debt', s.priceRub, `Оплата доставки ${s.trackingNumber}`, { capture: true, companyId: s.companyId, shipmentId: s.id, meta: { shipmentIds: [s.id] } }).catch(() => null);
        ok = again?.p.status === 'succeeded';
        if (ok) await this.db.update(shipments).set({ paymentId: again!.row.id }).where(eq(shipments.id, s.id));
      }
    }
    const status = ok ? 'paid' : 'failed';
    await this.db.update(shipments).set({ payStatus: status }).where(eq(shipments.id, s.id));
    return status;
  }

  /** Отмена: снимаем резерв (или возвращаем деньги, если уже списаны). */
  async releaseShipment(shipmentId: string) {
    const s = await this.db.query.shipments.findFirst({ where: eq(shipments.id, shipmentId) });
    if (!s?.paymentId || !['held', 'paid', 'awaiting'].includes(s.payStatus)) return;
    const row = await this.get(s.paymentId).catch(() => null);
    if (row) await this.release(row);
    await this.db.update(shipments).set({ payStatus: 'refunded' }).where(eq(shipments.id, s.id));
  }

  async release(row: Payment) {
    try {
      if (row.status === 'held' || row.status === 'pending') await this.save(row, await this.provider.cancel(row.providerId));
      else if (row.status === 'captured') {
        await this.provider.refund(row.providerId, row.amountRub);
        await this.db.update(payments).set({ status: 'refunded', updatedAt: new Date() }).where(eq(payments.id, row.id));
      }
    } catch (e: any) {
      this.log.error(`Не удалось вернуть деньги по платежу ${row.providerId}: ${e.message}`);
      throw new BadRequestException('Не удалось вернуть деньги автоматически. Мы разберёмся вручную.');
    }
  }

  /* ---------- Долг заказчика ---------- */

  async debt(customerId: string) {
    const rows = await this.db.select({ id: shipments.id, trackingNumber: shipments.trackingNumber, priceRub: shipments.priceRub })
      .from(shipments).where(and(eq(shipments.customerId, customerId), eq(shipments.payer, 'sender'), eq(shipments.payStatus, 'failed')));
    return { totalRub: rows.reduce((a, r) => a + r.priceRub, 0), shipments: rows };
  }

  async assertNoDebt(customerId: string) {
    const d = await this.debt(customerId);
    if (d.totalRub > DEBT_LIMIT_RUB) throw new BadRequestException(`Не прошла оплата прошлых доставок на ${d.totalRub} ₽. Погасите долг — после этого можно оформлять новые заказы.`);
  }

  async payDebt(c: Customer) {
    this.needCard(c);
    const d = await this.debt(c.id);
    if (!d.totalRub) throw new BadRequestException('Долга нет');
    const ids = d.shipments.map((s) => s.id);
    const desc = `Оплата доставок: ${d.shipments.map((s) => s.trackingNumber).join(', ')}`.slice(0, 128);
    let { row, p } = await this.start(asPayer(c), 'debt', d.totalRub, desc, { capture: true, meta: { shipmentIds: ids } });
    if (p.status === 'canceled' && !this.testMode) ({ row, p } = await this.start(asPayer(c), 'debt', d.totalRub, desc, { capture: true, confirm: true, meta: { shipmentIds: ids } }));
    return this.afterDebt(row);
  }

  async afterDebt(row: Payment) {
    if (row.kind === 'debt' && row.status === 'captured') {
      const ids = (row.meta.shipmentIds as string[] | undefined) ?? [];
      if (ids.length) await this.db.update(shipments).set({ payStatus: 'paid', paymentId: row.id }).where(and(inArray(shipments.id, ids), eq(shipments.payStatus, 'failed')));
    }
    return row;
  }

  /* ---------- Чаевые ---------- */

  async tip(c: Customer, amountRub: number, s: { id: string; companyId: string; trackingNumber: string }) {
    this.needCard(c);
    const { row, p } = await this.start(asPayer(c), 'tip', amountRub, `Чаевые курьеру, заказ ${s.trackingNumber}`, { capture: true, companyId: s.companyId, shipmentId: s.id });
    if (p.status !== 'succeeded') throw new BadRequestException(`Не удалось списать чаевые: ${row.error ?? 'нужно подтверждение банка'}`);
    return row;
  }

  /** Деньги за период: оплачено заказов, из них доля платформы (доход) и курьеров; чаевые — курьерам целиком. */
  async totals(from: Date) {
    const [r] = await this.db.select({
      deliveries: sql<number>`coalesce(sum(${payments.amountRub}) filter (where ${payments.kind} in ('order','debt')), 0)`.mapWith(Number),
      tips: sql<number>`coalesce(sum(${payments.amountRub}) filter (where ${payments.kind} = 'tip'), 0)`.mapWith(Number),
    }).from(payments).where(and(eq(payments.status, 'captured'), sql`${payments.updatedAt} >= ${from}`));
    const [f] = await this.db.select({ fee: sql<number>`coalesce(sum(${shipments.platformFeeRub}), 0)`.mapWith(Number) })
      .from(shipments).where(and(eq(shipments.payStatus, 'paid'), sql`${shipments.deliveredAt} >= ${from}`));
    return { ...r, platformRub: f.fee };
  }
}

@Global()
@Module({ providers: [PaymentsService], exports: [PaymentsService] })
export class PaymentsModule {}
