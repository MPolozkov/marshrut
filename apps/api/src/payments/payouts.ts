import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Выплаты курьерам-самозанятым через ЮKassa (сервис «Выплаты»): деньги по СБП на телефон курьера,
 * чек в «Мой налог» формируется автоматически от имени курьера (он один раз даёт разрешение платформе).
 * Нужны отдельные ключи шлюза выплат: YOOKASSA_PAYOUT_AGENT_ID и YOOKASSA_PAYOUT_SECRET.
 * Документация: https://yookassa.ru/developers/payouts/overview
 */
export interface SelfEmployed { id: string; status: 'pending' | 'confirmed' | 'canceled' | 'unregistered'; confirmationUrl?: string }
export interface Payout { id: string; status: 'pending' | 'succeeded' | 'canceled'; reason?: string }
export interface PayoutProvider {
  readonly name: 'yookassa' | 'test';
  banks(): Promise<{ id: string; name: string }[]>;
  selfEmployed(inn: string, phone: string): Promise<SelfEmployed>;
  selfEmployedStatus(id: string): Promise<SelfEmployed>;
  payout(p: { amountRub: number; phone: string; bankId: string; seId: string; description: string; meta: Record<string, string> }): Promise<Payout>;
  payoutStatus(id: string): Promise<Payout>;
}

class YooKassaPayouts implements PayoutProvider {
  readonly name = 'yookassa' as const;
  private auth = 'Basic ' + Buffer.from(`${process.env.YOOKASSA_PAYOUT_AGENT_ID}:${process.env.YOOKASSA_PAYOUT_SECRET}`).toString('base64');
  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await fetch(`https://api.yookassa.ru/v3${path}`, {
      method, signal: AbortSignal.timeout(15_000), body: body ? JSON.stringify(body) : undefined,
      headers: { authorization: this.auth, 'content-type': 'application/json', ...(method === 'POST' ? { 'Idempotence-Key': randomUUID() } : {}) },
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ЮKassa: ${data.description ?? data.code ?? res.status}`);
    return data;
  }
  async banks() { const r = await this.call('GET', '/sbp_banks'); return (r.items ?? []).map((b: any) => ({ id: b.bank_id, name: b.name })); }
  private se(r: any): SelfEmployed { return { id: r.id, status: r.status, confirmationUrl: r.confirmation?.confirmation_url }; }
  async selfEmployed(inn: string, phone: string) {
    return this.se(await this.call('POST', '/self_employed', { itn: inn, phone: phone.replace(/\D/g, ''), confirmation: { type: 'redirect' } }));
  }
  async selfEmployedStatus(id: string) { return this.se(await this.call('GET', `/self_employed/${id}`)); }
  private po(r: any): Payout { return { id: r.id, status: r.status, reason: r.cancellation_details?.reason }; }
  async payout(p: Parameters<PayoutProvider['payout']>[0]) {
    return this.po(await this.call('POST', '/payouts', {
      amount: { value: p.amountRub.toFixed(2), currency: 'RUB' },
      payout_destination_data: { type: 'sbp', phone: p.phone.replace(/\D/g, ''), bank_id: p.bankId },
      description: p.description.slice(0, 128), self_employed: { id: p.seId },
      receipt_data: { service_name: 'Услуги курьерской доставки' }, metadata: p.meta,
    }));
  }
  async payoutStatus(id: string) { return this.po(await this.call('GET', `/payouts/${id}`)); }
}

/** Тестовые выплаты: всё проходит сразу, деньги не переводятся. */
class TestPayouts implements PayoutProvider {
  readonly name = 'test' as const;
  constructor() { Logger.warn('Выплаты курьерам в ТЕСТОВОМ режиме. Для боевого задайте YOOKASSA_PAYOUT_AGENT_ID и YOOKASSA_PAYOUT_SECRET.', 'Выплаты'); }
  async banks() { return [['100000000111', 'Сбербанк'], ['100000000004', 'Т-Банк'], ['100000000008', 'Альфа-Банк'], ['100000000005', 'ВТБ'], ['100000000015', 'Открытие']].map(([id, name]) => ({ id, name })); }
  async selfEmployed() { return { id: `test_se_${randomUUID()}`, status: 'confirmed' as const }; }
  async selfEmployedStatus(id: string) { return { id, status: 'confirmed' as const }; }
  async payout() { return { id: `test_po_${randomUUID()}`, status: 'succeeded' as const }; }
  async payoutStatus(id: string) { return { id, status: 'succeeded' as const }; }
}

export const createPayouts = (): PayoutProvider =>
  process.env.YOOKASSA_PAYOUT_AGENT_ID && process.env.YOOKASSA_PAYOUT_SECRET ? new YooKassaPayouts() : new TestPayouts();
