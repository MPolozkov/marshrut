import { Global, Inject, Injectable, Logger, Module, Body, Controller, Delete, Post } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { couriers, customers, devices, users } from '../db/schema';
import { AuthUser, CurrentUser, Roles, Zod } from '../common/auth';

interface Msg { title: string; body: string; data?: Record<string, unknown> }

/**
 * Push-уведомления в приложение вместо SMS (Expo Push: https://docs.expo.dev/push-notifications/sending-notifications/).
 * Токен телефона приложение присылает после входа. EXPO_ACCESS_TOKEN — если в Expo включена защита отправки.
 * Без сети или токена уведомление просто не уходит: приложение и так обновляет экраны само.
 */
@Injectable()
export class PushService {
  private log = new Logger('Push');
  constructor(@Inject(DB) private db: Db) {}

  async register(token: string, owner: { customerId?: string; userId?: string }, platform?: string) {
    await this.db.insert(devices).values({ token, customerId: owner.customerId ?? null, userId: owner.userId ?? null, platform: platform ?? null })
      .onConflictDoUpdate({ target: devices.token, set: { customerId: owner.customerId ?? null, userId: owner.userId ?? null, platform: platform ?? null, updatedAt: new Date() } });
  }
  async unregister(token: string) { await this.db.delete(devices).where(eq(devices.token, token)); }

  private async send(tokens: string[], m: Msg) {
    if (!tokens.length) return;
    const chunks: string[][] = [];
    for (let i = 0; i < tokens.length; i += 100) chunks.push(tokens.slice(i, i + 100));
    for (const c of chunks) {
      try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', accept: 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
          body: JSON.stringify(c.map((to) => ({ to, title: m.title, body: m.body, data: m.data ?? {}, sound: 'default', priority: 'high', channelId: 'orders' }))),
        });
        const r: any = await res.json().catch(() => ({}));
        // Удалённое приложение — токен больше не действует.
        const dead = (r.data ?? []).map((t: any, i: number) => (t?.details?.error === 'DeviceNotRegistered' ? c[i] : null)).filter(Boolean);
        if (dead.length) await this.db.delete(devices).where(inArray(devices.token, dead));
      } catch (e: any) { this.log.warn(`Push не отправлен: ${e.message}`); }
    }
  }

  async toCustomer(customerId: string | null | undefined, m: Msg) {
    if (!customerId) return;
    const rows = await this.db.select({ t: devices.token }).from(devices).where(eq(devices.customerId, customerId));
    await this.send(rows.map((r) => r.t), m);
  }
  /** Получателю — если у него есть приложение (тот же номер телефона). Иначе код для получения передаёт заказчик. */
  async toPhone(phone: string | null | undefined, m: Msg) {
    const d = (phone ?? '').replace(/\D/g, '');
    if (d.length < 10) return;
    const norm = d.length === 11 && d[0] === '8' ? `7${d.slice(1)}` : d.length === 10 ? `7${d}` : d;
    const c = await this.db.query.customers.findFirst({ where: eq(customers.phone, `+${norm}`), columns: { id: true } });
    if (c) await this.toCustomer(c.id, m);
  }
  async toUsers(userIds: string[], m: Msg) {
    if (!userIds.length) return;
    const rows = await this.db.select({ t: devices.token }).from(devices).where(inArray(devices.userId, userIds));
    await this.send(rows.map((r) => r.t), m);
  }
  async toCourier(courierId: string | null | undefined, m: Msg) {
    if (!courierId) return;
    const c = await this.db.query.couriers.findFirst({ where: eq(couriers.id, courierId), columns: { userId: true } });
    if (c?.userId) await this.toUsers([c.userId], m);
  }
  /** Новый заказ — курьерам на линии в этом городе. */
  async toActiveCouriers(filter: (c: { city: string; vehicle: string | null }) => boolean, m: Msg) {
    const list = await this.db.select({ userId: couriers.userId, city: couriers.city, vehicle: couriers.vehicle }).from(couriers)
      .innerJoin(users, eq(users.id, couriers.userId)).where(and(eq(couriers.status, 'approved'), eq(couriers.active, true)));
    await this.toUsers(list.filter(filter).map((c) => c.userId!).filter(Boolean), m);
  }
}

/** Приложение сообщает токен для push после входа (заказчик или курьер). */
@Controller('devices')
export class DevicesController {
  constructor(private push: PushService) {}
  @Roles('customer', 'courier')
  @Post()
  async add(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ token: z.string().min(10).max(300), platform: z.string().max(20).optional() }))) b: { token: string; platform?: string }) {
    await this.push.register(b.token, u.role === 'customer' ? { customerId: u.sub } : { userId: u.sub }, b.platform);
    return { ok: true };
  }
  @Roles('customer', 'courier')
  @Delete()
  async remove(@Body(new Zod(z.object({ token: z.string() }))) b: { token: string }) { await this.push.unregister(b.token); return { ok: true }; }
}

@Global()
@Module({ controllers: [DevicesController], providers: [PushService], exports: [PushService] })
export class PushModule {}
