import { randomInt } from 'node:crypto';
import { Db } from './db.module';
import { cells, zones } from './schema';

type Tx = Pick<Db, 'insert'>;

/** Стартовые зоны (в городе компании) и ячейки склада — их потом правят в настройках. */
export async function seedCompanyDefaults(tx: Tx, companyId: string, opts: { city?: string; warehouse?: boolean } = {}) {
  const city = opts.city ?? '';
  await tx.insert(zones).values([
    { companyId, city, name: 'Центр', baseRub: 250, perKgRub: 40, etaDays: 0 },
    { companyId, city, name: 'Спальные районы', baseRub: 300, perKgRub: 40, etaDays: 0 },
    { companyId, city, name: 'Пригород', baseRub: 600, perKgRub: 50, etaDays: 1 },
  ]);
  if (opts.warehouse !== false) await seedCells(tx, companyId);
}

export async function seedCells(tx: Tx, companyId: string) {
  const codes = ['A', 'B', 'C', 'D'].flatMap((r) => [1, 2, 3, 4, 5, 6].map((n) => `${r}${n}`));
  await tx.insert(cells).values(codes.map((code) => ({ companyId, code }))).onConflictDoNothing();
}

/** Код приглашения для курьеров: 8 символов без похожих букв и цифр (0/O, 1/I). */
export function newInviteCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => abc[randomInt(abc.length)]).join('');
}

const TR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};
/** «Быстрая доставка» → bystraya-dostavka (для адреса кабинета). */
export function slugify(name: string) {
  const s = name.toLowerCase().split('').map((ch) => TR[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return s.length >= 3 ? s : `company-${randomInt(1000, 9999)}`;
}
