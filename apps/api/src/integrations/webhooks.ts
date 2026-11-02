import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { companies } from '../db/schema';

/**
 * Исходящие вебхуки: при каждой смене статуса отправляем POST на адрес, который клиент указал в «Интеграциях».
 * Тело подписано HMAC-SHA256 секретом компании (заголовок X-Marshrut-Signature), чтобы клиент мог проверить источник.
 * При ошибке — до 4 повторов с паузой 10 с, 1 мин, 5 мин, 30 мин.
 */
@Injectable()
export class WebhooksService {
  private log = new Logger('Вебхуки');
  private delays = [10_000, 60_000, 300_000, 1_800_000];

  constructor(@Inject(DB) private db: Db) {}

  async emit(companyId: string, event: string, data: Record<string, unknown>) {
    const c = await this.db.query.companies.findFirst({
      where: eq(companies.id, companyId), columns: { webhookUrl: true, webhookSecret: true },
    });
    if (!c?.webhookUrl) return;
    const body = JSON.stringify({ event, at: new Date().toISOString(), data });
    this.send(c.webhookUrl, c.webhookSecret ?? '', body, 0);
  }

  /** Тестовый вызов из настроек: возвращает код ответа, чтобы клиент сразу увидел, что адрес работает. */
  async test(url: string, secret: string) {
    const body = JSON.stringify({ event: 'test', at: new Date().toISOString(), data: { message: 'Проверка вебхука Маршрут' } });
    const r = await this.post(url, secret, body);
    return { status: r.status, ok: r.ok };
  }

  private post(url: string, secret: string, body: string) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-marshrut-signature': createHmac('sha256', secret).update(body).digest('hex'),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  }

  private send(url: string, secret: string, body: string, attempt: number) {
    this.post(url, secret, body).then((r) => {
      if (!r.ok) throw new Error(`ответ ${r.status}`);
    }).catch((e) => {
      if (attempt >= this.delays.length) { this.log.error(`Не доставлен ${url}: ${e.message}`); return; }
      setTimeout(() => this.send(url, secret, body, attempt + 1), this.delays[attempt]).unref?.();
    });
  }
}

@Global()
@Module({ providers: [WebhooksService], exports: [WebhooksService] })
export class WebhooksModule {}
