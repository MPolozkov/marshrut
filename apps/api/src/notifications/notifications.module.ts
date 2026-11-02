import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { notifications } from '../db/schema';

export type Channel = 'telegram' | 'max' | 'sms' | 'email' | 'log';
export interface Outgoing { companyId: string | null; channel: Channel; to: string; text: string }

/**
 * Отправка уведомлений через очередь: запрос пользователя не ждёт ответа мессенджера,
 * а при сбое канала BullMQ повторит попытку.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Notifications');
  private queue?: Queue;
  private worker?: Worker;

  constructor(@Inject(DB) private db: Db) {}

  onModuleInit() {
    if (!process.env.REDIS_URL) { this.log.warn('REDIS_URL не задан: уведомления отправляются сразу, без очереди'); return; }
    const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue('notifications', { connection });
    this.worker = new Worker('notifications', async (job) => this.deliver(job.data.id, job.data as Outgoing), { connection });
    this.worker.on('failed', (job, err) => this.log.error(`Не отправлено ${job?.data?.id}: ${err.message}`));
  }

  async onModuleDestroy() { await this.worker?.close(); await this.queue?.close(); }

  async send(msg: Outgoing) {
    if (!msg.to) return;
    const [row] = await this.db.insert(notifications)
      .values({ companyId: msg.companyId, channel: msg.channel, recipient: msg.to, text: msg.text })
      .returning({ id: notifications.id });
    if (this.queue) {
      await this.queue.add('send', { ...msg, id: row.id }, { attempts: 5, backoff: { type: 'exponential', delay: 5000 } });
    } else {
      await this.deliver(row.id, msg).catch((e) => this.log.error(e.message));
    }
  }

  private async deliver(id: string, m: Outgoing) {
    try {
      await this.transport(m);
      await this.db.update(notifications).set({ status: 'sent' }).where(eq(notifications.id, id));
    } catch (e: any) {
      await this.db.update(notifications).set({ status: 'failed', error: String(e.message) }).where(eq(notifications.id, id));
      throw e;
    }
  }

  private async transport({ channel, to, text }: Outgoing) {
    switch (channel) {
      case 'telegram': {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return this.log.log(`[telegram выключен] ${to}: ${text}`);
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: to, text }),
        });
        if (!r.ok) throw new Error(`Telegram ответил ${r.status}: ${await r.text()}`);
        return;
      }
      case 'max': {
        // TODO: сверить путь и формат запроса с актуальной документацией Bot API мессенджера Max.
        const token = process.env.MAX_BOT_TOKEN, base = process.env.MAX_API_URL;
        if (!token || !base) return this.log.log(`[max выключен] ${to}: ${text}`);
        const r = await fetch(`${base.replace(/\/$/, '')}/messages?chat_id=${encodeURIComponent(to)}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: token },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) throw new Error(`Max ответил ${r.status}: ${await r.text()}`);
        return;
      }
      case 'sms': {
        const login = process.env.SMSC_LOGIN, psw = process.env.SMSC_PASSWORD;
        if (!login || !psw) return this.log.log(`[sms выключен] ${to}: ${text}`);
        const q = new URLSearchParams({ login, psw, phones: to, mes: text, fmt: '3', charset: 'utf-8' });
        if (process.env.SMSC_SENDER) q.set('sender', process.env.SMSC_SENDER);
        const r = await fetch('https://smsc.ru/sys/send.php', { method: 'POST', body: q });
        const body: any = await r.json();
        if (body.error) throw new Error(`SMSC: ${body.error}`);
        return;
      }
      default:
        this.log.log(`[${channel}] ${to}: ${text}`);
    }
  }
}

@Global()
@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
