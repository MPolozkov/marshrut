import {
  pgTable, uuid, text, integer, boolean, timestamp, doublePrecision, jsonb, pgEnum, uniqueIndex, index, date,
} from 'drizzle-orm/pg-core';
import type { Rates } from '../common/vehicles';
import { DEFAULT_RATES } from '../common/vehicles';

// Каждая таблица содержит company_id: одна база обслуживает много курьерских служб (white-label).

export const roleEnum = pgEnum('role', ['owner', 'dispatcher', 'warehouse', 'courier', 'hr']);
export const shipmentStatusEnum = pgEnum('shipment_status', [
  'created', 'at_warehouse', 'assigned', 'delivered', 'failed', 'returned',
]);
export const channelEnum = pgEnum('channel', ['telegram', 'max', 'sms', 'email', 'log']);
export const contractEnum = pgEnum('contract_type', ['employment', 'gph', 'self_employed']);

const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const companies = pgTable('companies', {
  id: uuid().primaryKey().defaultRandom(),
  // platform — сама платформа: ей принадлежат курьеры-самозанятые и заказы физлиц
  // business — организация-заказчик: оформляет доставки из кабинета, по API и файлом
  kind: text().notNull().default('business'),
  name: text().notNull(),
  slug: text().notNull().unique(), // поддомен: slug.marshrut.ru
  brandColor: text().notNull().default('#0e7c66'),
  logoUrl: text(),
  trackingPrefix: text().notNull().default('MR'),
  shipmentSeq: integer().notNull().default(0),
  volumetricDivisor: integer().notNull().default(5000),
  // Реквизиты для договоров, актов и уведомлений
  legalName: text(),       // ООО «Быстро» / ИП Иванов И. И.
  inn: text(),
  legalAddress: text(),
  director: text(),        // ФИО подписанта
  phone: text(),
  city: text().notNull().default(''),                  // основной город работы
  pickupAddress: text(),                               // откуда курьеры забирают заказы организации по умолчанию (склад, офис)
  payerCustomerId: uuid(),                             // плательщик организации: через него хранится привязанная карта
  // Какие разделы включены у компании: склад и кадры нужны не всем
  modules: jsonb().$type<{ warehouse: boolean; hr: boolean }>().notNull().default({ warehouse: true, hr: true }),
  inviteCode: text().unique(),                         // код, по которому курьеры регистрируются в приложении
  // Интеграции: ключ API (храним хеш) и адрес для уведомлений о статусах
  apiKeyHash: text(),
  apiKeyPrefix: text(),                                // первые символы ключа, чтобы узнать его в списке
  webhookUrl: text(),
  webhookSecret: text(),
  // Управление платформой
  blocked: boolean().notNull().default(false),
  // Оплата курьеру за доставку: фиксированная сумма + процент от стоимости доставки. Чаевые — сверху.
  courierPay: jsonb().$type<{ fixedRub: number; percent: number }>().notNull().default({ fixedRub: 150, percent: 0 }),
  // Как заказ попадает к курьеру: offer — предлагается подходящим курьерам, везёт первый принявший;
  // auto — сразу назначается ближайшему; manual — назначает диспетчер.
  assignMode: text().notNull().default('offer'),
  // Биржа заявок из общего приложения заказчиков
  marketplace: boolean().notNull().default(true),      // участвовать в распределении заявок
  autoBid: boolean().notNull().default(true),          // сразу предлагать цену по тарифу (диспетчер может изменить)
  rates: jsonb().$type<Rates>().notNull().default(DEFAULT_RATES),   // тарифы по видам транспорта
  plan: text().notNull().default('start'),             // start | business | white_label (см. src/plans.ts)
  trialEndsAt: timestamp({ withTimezone: true }),      // до этой даты тариф работает бесплатно
  paidUntil: timestamp({ withTimezone: true }),        // оплачено до (отмечает владелец платформы после оплаты счёта)
  createdAt: ts(),
});

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  name: text().notNull(),
  role: roleEnum().notNull().default('dispatcher'),
  active: boolean().notNull().default(true),
  createdAt: ts(),
});

export const zones = pgTable('zones', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  baseRub: integer().notNull(),      // цена до 1 кг
  perKgRub: integer().notNull(),     // каждый следующий кг
  etaDays: integer().notNull().default(0),
  polygon: jsonb(),                  // GeoJSON-полигон района; позже — PostGIS geometry
  city: text().notNull().default(''),
}, (t) => [index('zones_company_idx').on(t.companyId)]);

export const couriers = pgTable('couriers', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  userId: uuid().references(() => users.id),
  name: text().notNull(),
  phone: text().notNull(),
  zoneId: uuid().references(() => zones.id),
  active: boolean().notNull().default(true),
  status: text().notNull().default('approved'),   // pending — зарегистрировался сам и ждёт подтверждения | approved | rejected
  vehicle: text(),                                // foot | bike | car | truck_m | truck_l (см. common/vehicles.ts)
  // Выплаты: самозанятый выдаёт чек в «Мой налог» на каждую выплату
  selfEmployed: boolean().notNull().default(false),
  inn: text(),
  payoutMethod: text(),                            // sbp
  payoutDetails: text(),                           // телефон для СБП
  sbpBankId: text(),                               // банк получателя для выплаты по СБП
  seId: text(),                                    // id самозанятого у платёжного сервиса (разрешение в «Мой налог»)
  seStatus: text().notNull().default('none'),      // none | pending — ждём разрешения в «Мой налог» | confirmed
  city: text().notNull().default(''),
  lastLat: doublePrecision(),                      // последняя геопозиция из приложения (пока курьер на линии)
  lastLng: doublePrecision(),
  lastSeenAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
}, (t) => [index('couriers_company_idx').on(t.companyId)]);

/** Реквизиты заказчика-компании для счетов и закрывающих документов. */
export interface CustomerRequisites {
  companyName: string; inn: string; kpp?: string; ogrn?: string; legalAddress: string;
  bank?: string; bik?: string; account?: string; corrAccount?: string; director?: string; docsEmail?: string;
}

/**
 * Заказчики общего приложения. Один аккаунт на всю платформу: заказчик может работать с любой службой.
 * Вход по SMS-коду, затем регистрация: ФИО, физлицо или компания, способ оплаты.
 */
export const customers = pgTable('customers', {
  id: uuid().primaryKey().defaultRandom(),
  phone: text().notNull().unique(),
  lastName: text().notNull().default(''),
  firstName: text().notNull().default(''),
  middleName: text().notNull().default(''),
  name: text().notNull().default(''),             // «Имя Фамилия» для писем и курьера
  email: text(),
  kind: text().notNull().default('person'),        // person | company
  selfEmployed: boolean().notNull().default(false),
  inn: text(),                                     // ИНН физлица (для самозанятых)
  requisites: jsonb().$type<CustomerRequisites>(), // только для компаний
  // Оплата только картой. Карта проверяется при регистрации: резерв 1 ₽ и его отмена.
  cardMethodId: text(),                            // сохранённый способ оплаты у платёжного сервиса
  cardLast4: text(),
  cardBrand: text(),
  cardVerifiedAt: timestamp({ withTimezone: true }),
  registeredAt: timestamp({ withTimezone: true }), // null — вошёл, но ещё не заполнил анкету
  createdAt: ts(),
});

/** Телефоны для push-уведомлений (Expo): у заказчика — customerId, у курьера — userId. */
export const devices = pgTable('devices', {
  id: uuid().primaryKey().defaultRandom(),
  token: text().notNull().unique(),                // ExponentPushToken[…]
  customerId: uuid().references(() => customers.id, { onDelete: 'cascade' }),
  userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
  platform: text(),                                // android | ios
  updatedAt: ts(),
});

/** Тарифы доставки по городам (задаёт владелец платформы). Нет города — действуют тарифы по умолчанию. */
export const cityRates = pgTable('city_rates', {
  id: uuid().primaryKey().defaultRandom(),
  city: text().notNull().unique(),                 // в нижнем регистре, «ё» → «е»
  rates: jsonb().$type<Rates>().notNull(),
  nightPercent: integer().notNull().default(20),   // надбавка с 22:00 до 7:00
  updatedAt: ts(),
});

/**
 * Платежи по картам заказчиков: проверка карты (1 ₽), резерв суммы заказа, списание долга, чаевые.
 * Статусы: pending — ждём подтверждения (3-D Secure) | held — сумма зарезервирована | captured — списана
 * | canceled — резерв снят | refunded — возврат | failed — банк отказал.
 */
export const payments = pgTable('payments', {
  id: uuid().primaryKey().defaultRandom(),
  customerId: uuid().references(() => customers.id, { onDelete: 'set null' }),
  companyId: uuid().references(() => companies.id, { onDelete: 'set null' }),
  shipmentId: uuid(),
  kind: text().notNull(),                          // card_check | order | debt | tip
  provider: text().notNull(),                      // yookassa | test
  providerId: text().notNull(),
  amountRub: integer().notNull(),
  status: text().notNull().default('pending'),
  confirmationUrl: text(),
  error: text(),
  meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts(),
  updatedAt: ts(),
}, (t) => [uniqueIndex('payments_provider_uq').on(t.provider, t.providerId), index('payments_customer_idx').on(t.customerId)]);

/**
 * Журнал денег курьера. Баланс = сколько компания должна курьеру:
 * + начисление за заказ; − наличные, которые курьер получил от клиентов; − выплата курьеру; + курьер сдал наличные в кассу.
 */
export const courierLedger = pgTable('courier_ledger', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  courierId: uuid().notNull().references(() => couriers.id, { onDelete: 'cascade' }),
  shipmentId: uuid(),
  kind: text().notNull(),                          // earning | cash_collected | payout | cash_in | adjust
  amountRub: integer().notNull(),                  // со знаком
  method: text(),                                  // sbp | card | cash
  note: text(),
  receiptUrl: text(),                              // ссылка на чек самозанятого из «Мой налог»
  status: text(),                                  // для выплат: pending | done | failed (failed не учитывается в балансе)
  providerId: text(),                              // id выплаты у платёжного сервиса
  createdBy: uuid(),
  createdAt: ts(),
}, (t) => [index('ledger_courier_idx').on(t.courierId)]);

export const shipments = pgTable('shipments', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  trackingNumber: text().notNull().unique(),
  senderName: text().notNull(),
  senderPhone: text(),
  recipientName: text().notNull(),
  recipientPhone: text(),
  address: text().notNull(),
  zoneId: uuid().references(() => zones.id),     // старые тарифы по зонам; заказы платформы считаются по тарифам городов
  weightKg: doublePrecision().notNull(),
  lengthCm: integer().notNull(),
  widthCm: integer().notNull(),
  heightCm: integer().notNull(),
  chargeableKg: doublePrecision().notNull(),
  priceRub: integer().notNull(),
  codRub: integer().notNull().default(0),   // наложенный платёж
  status: shipmentStatusEnum().notNull().default('created'),
  courierId: uuid().references(() => couriers.id),
  cellCode: text(),
  confirmCode: text().notNull(),
  notifyChannel: channelEnum().notNull().default('sms'),
  recipientChatId: text(),                  // id чата в Telegram/Max, если клиент подписан на бота
  deliveredAt: timestamp({ withTimezone: true }),
  // Подтверждение вручения из приложения курьера
  proofPhoto: text(),       // путь к файлу в хранилище
  proofSignature: text(),
  deliveredLat: doublePrecision(),
  deliveredLng: doublePrecision(),
  codCollected: integer(),  // фактически получено от клиента
  codMethod: text(),        // cash | card | sbp
  failReason: text(),
  city: text().notNull().default(''),
  source: text().notNull().default('manual'),     // manual | api | import | client
  customerId: uuid().references(() => customers.id, { onDelete: 'set null' }),
  // Откуда забрать (заказы из приложения клиента)
  pickupAddress: text(),
  pickupName: text(),
  pickupPhone: text(),
  pickupLat: doublePrecision(),
  pickupLng: doublePrecision(),
  pickedUpAt: timestamp({ withTimezone: true }),
  comment: text(),
  paymentMethod: text(),                          // sender_cash | recipient_cash | invoice
  // Деньги курьера и отзыв клиента
  courierPayRub: integer(),                       // начисляется при вручении
  tipRub: integer().notNull().default(0),
  tipMethod: text(),                              // cash | transfer | online
  rating: integer(),                              // 1–5 от клиента
  ratingComment: text(),
  ratedAt: timestamp({ withTimezone: true }),
  externalId: text(),                             // номер заказа во внешней системе клиента
  vehicle: text(),                                // какой транспорт нужен (common/vehicles.ts)
  payer: text().notNull().default('sender'),      // платит всегда заказчик своей картой
  payDeadline: timestamp({ withTimezone: true }), // не подтверждено банком до этого времени — заказ отменяется
  platformFeeRub: integer(),                      // доля платформы с суммы заказа
  // Точный адрес доставки (обязателен: улица, дом, квартира) и его координаты — по ним проверяется, что курьер на месте
  addressDetails: jsonb().$type<{ street: string; house: string; apartment: string; entrance?: string; floor?: string; intercom?: string }>(),
  deliveryLat: doublePrecision(),
  deliveryLng: doublePrecision(),
  offeredAt: timestamp({ withTimezone: true }),   // с этого момента заказ виден подходящим курьерам
  // Оплата картой заказчика: awaiting — ждём подтверждения банка | held — сумма зарезервирована | paid — списана
  // failed — списать не удалось (долг заказчика) | refunded — резерв снят, деньги вернулись
  payStatus: text().notNull().default('none'),
  paymentId: uuid(),
  createdAt: ts(),
  updatedAt: ts(),
}, (t) => [
  index('shipments_company_status_idx').on(t.companyId, t.status),
  index('shipments_courier_idx').on(t.courierId),
  uniqueIndex('shipments_company_external_uq').on(t.companyId, t.externalId),
]);

export const shipmentEvents = pgTable('shipment_events', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  shipmentId: uuid().notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  status: shipmentStatusEnum().notNull(),
  note: text(),
  actorUserId: uuid().references(() => users.id),
  createdAt: ts(),
}, (t) => [index('events_shipment_idx').on(t.shipmentId)]);

export const cells = pgTable('cells', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  code: text().notNull(), // A1, B4 ...
}, (t) => [uniqueIndex('cells_company_code_uq').on(t.companyId, t.code)]);

export const employees = pgTable('employees', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  phone: text(),
  position: text().notNull(),
  contractType: contractEnum().notNull(),
  hiredAt: date().notNull().defaultNow(),
  active: boolean().notNull().default(true),
}, (t) => [index('employees_company_idx').on(t.companyId)]);

export const attendance = pgTable('attendance', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  day: date().notNull(),
  checkIn: timestamp({ withTimezone: true }),
  checkOut: timestamp({ withTimezone: true }),
}, (t) => [uniqueIndex('attendance_employee_day_uq').on(t.employeeId, t.day)]);

export const candidates = pgTable('candidates', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull().references(() => companies.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  phone: text(),
  vacancy: text().notNull(),
  stage: text().notNull().default('new'), // new | invited | hired | rejected
  channel: channelEnum().notNull().default('sms'),
  chatId: text(),
  interviewAt: timestamp({ withTimezone: true }),
  createdAt: ts(),
}, (t) => [index('candidates_company_idx').on(t.companyId)]);

export const notifications = pgTable('notifications', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().references(() => companies.id, { onDelete: 'cascade' }),
  channel: channelEnum().notNull(),
  recipient: text().notNull(),
  text: text().notNull(),
  status: text().notNull().default('queued'), // queued | sent | failed
  error: text(),
  createdAt: ts(),
});

/** Обращения в техподдержку и заявки на бесплатное подключение интеграций. */
export const supportRequests = pgTable('support_requests', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().references(() => companies.id, { onDelete: 'set null' }),  // null — обращение с главной страницы до регистрации
  userId: uuid().references(() => users.id, { onDelete: 'set null' }),
  topic: text().notNull(),               // integration | problem | plan | other
  subject: text().notNull(),
  details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  message: text().notNull(),
  contactName: text().notNull(),
  contactEmail: text().notNull(),
  contactPhone: text(),
  status: text().notNull().default('new'),   // new | in_progress | done
  emailSent: boolean().notNull().default(false),
  createdAt: ts(),
}, (t) => [index('support_company_idx').on(t.companyId)]);
