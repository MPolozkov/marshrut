import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** Состояние платежа у платёжного сервиса (в терминах ЮKassa). */
export interface ProviderPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  confirmationUrl?: string;
  methodId?: string; methodSaved?: boolean;
  card?: { last4: string; brand: string };
  cancelReason?: string;
}
export interface CreatePayment {
  amountRub: number; capture: boolean; description: string;
  methodId?: string;          // сохранённая карта заказчика
  saveMethod?: boolean;       // сохранить карту (проверка при регистрации)
  returnUrl?: string;
  metadata: Record<string, string>;
  customer?: { phone?: string; email?: string | null };
}
export interface PaymentProvider {
  readonly name: 'yookassa' | 'test';
  create(p: CreatePayment): Promise<ProviderPayment>;
  get(id: string): Promise<ProviderPayment>;
  capture(id: string, amountRub: number): Promise<ProviderPayment>;
  cancel(id: string): Promise<ProviderPayment>;
  refund(id: string, amountRub: number): Promise<{ status: string }>;
}

const money = (rub: number) => ({ value: rub.toFixed(2), currency: 'RUB' });
/** Понятная причина отказа банка по коду ЮKassa. */
const REASONS: Record<string, string> = {
  insufficient_funds: 'недостаточно денег на карте', card_expired: 'истёк срок действия карты', '3d_secure_failed': 'не пройдено подтверждение 3-D Secure',
  call_issuer: 'банк отклонил платёж, позвоните в банк', canceled_by_merchant: 'отменено', expired_on_capture: 'истёк срок резерва',
  expired_on_confirmation: 'не подтверждено вовремя', fraud_suspected: 'банк заподозрил мошенничество', general_decline: 'банк отклонил платёж',
  payment_method_limit_exceeded: 'превышен лимит по карте', payment_method_restricted: 'операции по карте ограничены', permission_revoked: 'автосписания с карты запрещены',
};
export const reasonText = (code?: string) => (code ? REASONS[code] ?? code : 'банк отклонил платёж');

/**
 * ЮKassa: двухстадийные платежи (capture: false — резерв, потом capture — списание или cancel — возврат резерва).
 * Документация: https://yookassa.ru/developers/payment-acceptance/getting-started/payment-process
 * Для списаний с сохранённой карты без участия заказчика (автоплатежи) нужно включить их в личном кабинете ЮKassa через менеджера.
 */
export class YooKassaProvider implements PaymentProvider {
  readonly name = 'yookassa' as const;
  private auth = 'Basic ' + Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch(`https://api.yookassa.ru/v3${path}`, {
      method,
      headers: { authorization: this.auth, 'content-type': 'application/json', ...(method === 'POST' ? { 'Idempotence-Key': randomUUID() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ЮKassa: ${data.description ?? data.code ?? res.status}`);
    return data;
  }
  private map(p: any): ProviderPayment {
    return {
      id: p.id, status: p.status, confirmationUrl: p.confirmation?.confirmation_url,
      methodId: p.payment_method?.id, methodSaved: p.payment_method?.saved,
      card: p.payment_method?.card ? { last4: p.payment_method.card.last4, brand: p.payment_method.card.card_type } : undefined,
      cancelReason: p.cancellation_details?.reason,
    };
  }
  /** Чек по 54-ФЗ, если в магазине ЮKassa включена отправка чеков (YOOKASSA_RECEIPT=1). */
  private receipt(p: CreatePayment) {
    if (process.env.YOOKASSA_RECEIPT !== '1' || (!p.customer?.phone && !p.customer?.email)) return undefined;
    return {
      customer: p.customer.email ? { email: p.customer.email } : { phone: p.customer.phone!.replace(/\D/g, '') },
      items: [{
        description: p.description.slice(0, 128), quantity: '1.00', amount: money(p.amountRub),
        vat_code: Number(process.env.YOOKASSA_VAT_CODE ?? 1), payment_mode: 'full_payment', payment_subject: 'service',
      }],
    };
  }
  async create(p: CreatePayment) {
    const body: any = { amount: money(p.amountRub), capture: p.capture, description: p.description.slice(0, 128), metadata: p.metadata };
    if (p.methodId) body.payment_method_id = p.methodId;
    else body.payment_method_data = { type: 'bank_card' };
    if (p.saveMethod) body.save_payment_method = true;
    // Подтверждение (3-D Secure) нужно при первой оплате новой картой; при списании с сохранённой — если банк попросит.
    if (!p.methodId || p.returnUrl) body.confirmation = { type: 'redirect', return_url: p.returnUrl };
    const receipt = this.receipt(p);
    if (receipt) body.receipt = receipt;
    return this.map(await this.call('POST', '/payments', body));
  }
  async get(id: string) { return this.map(await this.call('GET', `/payments/${id}`)); }
  async capture(id: string, amountRub: number) { return this.map(await this.call('POST', `/payments/${id}/capture`, { amount: money(amountRub) })); }
  async cancel(id: string) { return this.map(await this.call('POST', `/payments/${id}/cancel`, {})); }
  async refund(id: string, amountRub: number) { const r = await this.call('POST', '/refunds', { payment_id: id, amount: money(amountRub) }); return { status: r.status }; }
}

/**
 * Тестовый режим без настоящих денег — пока не заданы ключи ЮKassa.
 * Карта «•••• 4242» привязывается сразу. TEST_PAYMENTS_FAIL=capture — списание после вручения не проходит
 * (так проверяется долг и блокировка заказчика); TEST_PAYMENTS_FAIL=hold — банк отказывает в резерве.
 */
export class TestProvider implements PaymentProvider {
  readonly name = 'test' as const;
  private state = new Map<string, ProviderPayment>();
  private fail = (process.env.TEST_PAYMENTS_FAIL ?? '').split(',');
  constructor() { Logger.warn('Платежи в ТЕСТОВОМ режиме: деньги не списываются. Для боевого режима задайте YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.', 'Платежи'); }

  async create(p: CreatePayment) {
    const id = `test_${randomUUID()}`;
    const declined = !p.saveMethod && !p.capture && this.fail.includes('hold');
    const r: ProviderPayment = declined
      ? { id, status: 'canceled', cancelReason: 'insufficient_funds' }
      : { id, status: p.capture ? 'succeeded' : 'waiting_for_capture', methodId: p.methodId ?? 'test_card_4242', methodSaved: true, card: { last4: '4242', brand: 'MasterCard' } };
    this.state.set(id, r);
    return r;
  }
  async get(id: string) { return this.state.get(id) ?? { id, status: 'waiting_for_capture' as const, methodId: 'test_card_4242', methodSaved: true, card: { last4: '4242', brand: 'MasterCard' } }; }
  async capture(id: string) {
    const r: ProviderPayment = this.fail.includes('capture') ? { id, status: 'canceled', cancelReason: 'expired_on_capture' } : { id, status: 'succeeded' };
    this.state.set(id, r); return r;
  }
  async cancel(id: string) { const r: ProviderPayment = { id, status: 'canceled', cancelReason: 'canceled_by_merchant' }; this.state.set(id, r); return r; }
  async refund() { return { status: 'succeeded' }; }
}

export const createProvider = (): PaymentProvider =>
  process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY ? new YooKassaProvider() : new TestProvider();
