import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { cityRates, companies } from '../db/schema';
import { DEFAULT_RATES, priceByRate, Rates, VehicleId } from '../common/vehicles';

const norm = (c: string) => c.trim().toLowerCase().replace(/ё/g, 'е');

/**
 * Платформа как участник системы: ей принадлежат курьеры-самозанятые и заказы физлиц.
 * Запись создаётся сама при первом обращении.
 */
@Injectable()
export class PlatformService {
  private cached: string | null = null;
  constructor(@Inject(DB) private db: Db) {}

  async id() {
    if (this.cached) return this.cached;
    const found = await this.db.query.companies.findFirst({ where: eq(companies.kind, 'platform'), columns: { id: true } });
    if (found) return (this.cached = found.id);
    const [c] = await this.db.insert(companies).values({
      kind: 'platform', name: process.env.PLATFORM_NAME ?? 'Маршрут', slug: 'platform', trackingPrefix: 'MR',
      modules: { warehouse: false, hr: false }, plan: 'white_label',
    }).onConflictDoNothing().returning({ id: companies.id });
    if (c) return (this.cached = c.id);
    return (this.cached = (await this.db.query.companies.findFirst({ where: eq(companies.slug, 'platform'), columns: { id: true } }))!.id);
  }
}

/**
 * Сумма заказа — одна для всех заказчиков, по тарифу города:
 *   подача (зависит от транспорта) + километры по дороге × ставка + каждый кг сверх включённых × ставка,
 *   с 22:00 до 7:00 — ночная надбавка (по умолчанию +20%), округление до 10 ₽.
 * С суммы платформа берёт PLATFORM_FEE_PERCENT (по умолчанию 50%), остальное — вознаграждение курьера.
 */
@Injectable()
export class TariffsService {
  constructor(@Inject(DB) private db: Db) {}
  readonly feePercent = Math.min(100, Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT ?? 50)));
  get sharePercent() { return 100 - this.feePercent; }

  async forCity(city: string): Promise<{ city: string; rates: Rates; nightPercent: number; custom: boolean }> {
    const row = city ? await this.db.query.cityRates.findFirst({ where: eq(cityRates.city, norm(city)) }) : null;
    return row ? { city: row.city, rates: { ...DEFAULT_RATES, ...row.rates }, nightPercent: row.nightPercent, custom: true }
      : { city: norm(city), rates: DEFAULT_RATES, nightPercent: 20, custom: false };
  }

  list() { return this.db.select().from(cityRates).orderBy(cityRates.city); }

  async save(city: string, rates: Rates, nightPercent: number) {
    const [r] = await this.db.insert(cityRates).values({ city: norm(city), rates, nightPercent })
      .onConflictDoUpdate({ target: cityRates.city, set: { rates, nightPercent, updatedAt: new Date() } }).returning();
    return r;
  }
  async remove(city: string) { await this.db.delete(cityRates).where(eq(cityRates.city, norm(city))); }

  static isNight(at = new Date()) {
    const h = Number(new Intl.DateTimeFormat('ru-RU', { hour: 'numeric', hourCycle: 'h23', timeZone: process.env.TZ_CITY ?? 'Asia/Novosibirsk' }).format(at));
    return h >= 22 || h < 7;
  }

  /** Цена для заказчика и вознаграждение курьера. null — расстояние неизвестно или транспорт в городе выключен. */
  async price(city: string, vehicle: VehicleId, km: number | null, weightKg: number, at = new Date()) {
    const t = await this.forCity(city);
    const rate = t.rates[vehicle];
    if (!rate?.enabled) return null;
    const base = priceByRate(rate, km, weightKg);
    if (base == null) return null;
    const night = TariffsService.isNight(at);
    const priceRub = Math.round((base * (night ? 1 + t.nightPercent / 100 : 1)) / 10) * 10;
    return { priceRub, courierRub: this.courierShare(priceRub), platformRub: priceRub - this.courierShare(priceRub), night, nightPercent: t.nightPercent, base };
  }

  courierShare(priceRub: number) { return Math.round((priceRub * this.sharePercent) / 100); }
}

@Global()
@Module({ providers: [PlatformService, TariffsService], exports: [PlatformService, TariffsService] })
export class PlatformModule {}
