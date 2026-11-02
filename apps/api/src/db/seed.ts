/**
 * Демо-данные: платформа с курьерами-самозанятыми, организация-заказчик и тарифы Новосибирска.
 * Запуск после первого старта API (миграции уже применены): npm run db:seed
 */
import '../env';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { createDb } from './db.module';
import { cityRates, companies, couriers, users } from './schema';
import { DEFAULT_RATES } from '../common/vehicles';

async function main() {
  const db = createDb();
  if (await db.query.users.findFirst({ where: eq(users.email, 'owner@demo.ru') })) {
    console.log('Демо-данные уже есть. Вход: owner@demo.ru / demo12345');
    process.exit(0);
  }
  const hash = await bcrypt.hash('demo12345', 10);

  // Платформа: ей принадлежат курьеры и заказы физлиц.
  let platform = await db.query.companies.findFirst({ where: eq(companies.kind, 'platform') });
  if (!platform) [platform] = await db.insert(companies).values({ kind: 'platform', name: 'Маршрут', slug: 'platform', modules: { warehouse: false, hr: false }, plan: 'white_label' }).returning();

  // Тарифы города (остальные города — по умолчанию).
  await db.insert(cityRates).values({ city: 'новосибирск', rates: { ...DEFAULT_RATES, truck_m: { ...DEFAULT_RATES.truck_m, enabled: true } }, nightPercent: 20 }).onConflictDoNothing();

  // Курьеры-самозанятые. Статус «Мой налог» подключается в приложении (в тестовом режиме — сразу).
  const [c1] = await db.insert(users).values({ companyId: platform.id, email: 'courier@demo.ru', name: 'Алексей Смирнов', role: 'courier', passwordHash: hash }).returning();
  const [c2] = await db.insert(users).values({ companyId: platform.id, email: 'driver@demo.ru', name: 'Виктор Ким', role: 'courier', passwordHash: hash }).returning();
  await db.insert(couriers).values([
    { companyId: platform.id, userId: c1.id, name: 'Алексей Смирнов', phone: '+79135551240', vehicle: 'car', city: 'Новосибирск', inn: '540000000001', selfEmployed: true, payoutDetails: '+79135551240', status: 'approved' },
    { companyId: platform.id, userId: c2.id, name: 'Виктор Ким', phone: '+79135557788', vehicle: 'truck_m', city: 'Новосибирск', inn: '540000000002', selfEmployed: true, payoutDetails: '+79135557788', status: 'approved' },
  ]);

  // Организация-заказчик: интернет-магазин, отправляет доставки из кабинета, файлом и по API.
  const [shop] = await db.insert(companies).values({
    kind: 'business', name: 'Магазин Демо', slug: 'demo', trackingPrefix: 'NSK', city: 'Новосибирск', phone: '+7 383 000-00-00',
    pickupAddress: 'ул. Кирова, 86', legalName: 'ООО «Магазин Демо»', inn: '5400000000', legalAddress: 'г. Новосибирск, ул. Кирова, 86',
    director: 'Иванов Иван Иванович', plan: 'business', modules: { warehouse: false, hr: false }, trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
  }).returning();
  await db.insert(users).values([
    { companyId: shop.id, email: 'owner@demo.ru', name: 'Владелец', role: 'owner', passwordHash: hash },
    { companyId: shop.id, email: 'dispatcher@demo.ru', name: 'Павел Лебедев', role: 'dispatcher', passwordHash: hash },
  ]);

  console.log([
    'Готово. Пароль для всех: demo12345.',
    '  Организация «Магазин Демо»: owner@demo.ru, менеджер dispatcher@demo.ru (кабинет /admin).',
    '  Курьеры-самозанятые: courier@demo.ru (легковой), driver@demo.ru (грузовой).',
    '  Заказчик-физлицо: приложение, «Я заказчик», вход любым номером. Владелец платформы: /platform (ADMIN_EMAIL в .env).',
  ].join('\n'));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
