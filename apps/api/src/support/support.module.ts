import { Body, Controller, Get, Headers, Inject, Ip, Module, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, supportRequests, users } from '../db/schema';
import { AuthUser, Public, Zod } from '../common/auth';
import { MailService } from '../common/mail';
import { LoginLimiter } from '../auth/auth.module';
import { PLANS } from '../plans';

export const SUPPORT_EMAIL = () => process.env.SUPPORT_EMAIL || 'pipl82308@gmail.com';

/** Справочники формы — их же показывает веб-кабинет. */
export const SYSTEMS: Record<string, string> = {
  tilda: 'Tilda', insales: 'InSales', bitrix: '1С-Битрикс', woocommerce: 'WordPress / WooCommerce', opencart: 'OpenCart',
  shopify: 'Shopify', ecwid: 'Ecwid', '1c': '1С: Управление торговлей / УНФ / Розница', moysklad: 'МойСклад',
  amocrm: 'amoCRM', retailcrm: 'RetailCRM', bitrix24: 'Битрикс24', iiko: 'iiko / r_keeper (доставка еды)',
  marketplace: 'Маркетплейс (Ozon, Wildberries, Яндекс Маркет)', custom: 'Своя программа или сайт', other: 'Другое',
};
export const DIRECTIONS: Record<string, string> = {
  orders_in: 'Заказы из моей системы → в Маршрут (накладные создаются сами)',
  statuses_out: 'Статусы доставки из Маршрута → в мою систему',
  both: 'В обе стороны: заказы к вам, статусы обратно',
  couriers: 'Другое: курьеры, склад, отчёты',
};
export const ACCESS: Record<string, string> = {
  admin: 'Доступ администратора к сайту, магазину или CRM (отдельная учётная запись для подключения)',
  api_key: 'API-ключ или токен моей системы',
  webhook_url: 'Адрес (URL), куда присылать статусы',
  developer: 'Контакт нашего программиста или подрядчика',
  test_order: 'Тестовый заказ для проверки',
  remote: 'Созвон или удалённый доступ (AnyDesk, RuDesktop) для 1С',
};

const Dto = z.object({
  topic: z.enum(['integration', 'problem', 'plan', 'idea', 'other']),
  subject: z.string().trim().min(5, 'Тема — от 5 символов').max(150),
  message: z.string().trim().max(10_000),
  contactName: z.string().trim().min(2, 'Укажите имя'),
  contactEmail: z.string().trim().email('Неверный email'),
  contactPhone: z.string().trim().max(30).optional(),
  companyName: z.string().trim().max(120).optional(),       // для обращения до регистрации
  // Подключение
  system: z.string().max(40).optional(),
  systemOther: z.string().max(150).optional(),
  systemUrl: z.string().max(300).optional(),
  direction: z.string().max(40).optional(),
  ordersPerDay: z.string().max(40).optional(),
  access: z.array(z.string().max(40)).max(10).default([]),
  accessNotes: z.string().max(2000).optional(),
  preferredTime: z.string().max(150).optional(),
  plan: z.string().max(40).optional(),
  source: z.enum(['site', 'cabinet', 'courier_app', 'client_app']).optional(),
}).superRefine((d, ctx) => {
  const min = d.topic === 'integration' ? 100 : d.topic === 'idea' ? 20 : 30;
  if (d.message.length < min) ctx.addIssue({ code: 'custom', path: ['message'], message: `опишите подробнее — не меньше ${min} символов (сейчас ${d.message.length})` });
  if (d.topic === 'integration') {
    if (!d.system) ctx.addIssue({ code: 'custom', path: ['system'], message: 'выберите, что подключаем' });
    if (!d.direction) ctx.addIssue({ code: 'custom', path: ['direction'], message: 'выберите, что и куда передавать' });
    if (!d.access.length) ctx.addIssue({ code: 'custom', path: ['access'], message: 'отметьте, какие доступы вы готовы предоставить' });
  }
});

@Controller('support')
export class SupportController {
  private limiter = new LoginLimiter();
  constructor(@Inject(DB) private db: Db, private mail: MailService, private jwt: JwtService) {}

  /** Справочники для формы. */
  @Public()
  @Get('options')
  options() {
    return { systems: SYSTEMS, directions: DIRECTIONS, access: ACCESS, email: SUPPORT_EMAIL() };
  }

  /** Обращение из кабинета или с главной страницы. Сохраняется всегда; письмо уходит, если настроен SMTP. */
  @Public()
  @Post()
  async create(@Body(new Zod(Dto)) d: z.infer<typeof Dto>, @Headers('authorization') auth?: string, @Ip() ip = '') {
    this.limiter.check(ip, 'support');
    this.limiter.fail(ip, 'support'); // не больше 8 обращений за 15 минут с одного адреса

    let user: AuthUser | null = null;
    try { if (auth?.startsWith('Bearer ')) user = this.jwt.verify<AuthUser>(auth.slice(7)); } catch { /* гость */ }
    const company = user?.companyId ? await this.db.query.companies.findFirst({ where: eq(companies.id, user.companyId) }) : null;
    const login = user?.sub && user.sub !== 'admin' ? await this.db.query.users.findFirst({ where: eq(users.id, user.sub), columns: { email: true } }) : null;

    const details = {
      system: d.system ? SYSTEMS[d.system] ?? d.system : undefined, systemOther: d.systemOther, systemUrl: d.systemUrl,
      direction: d.direction ? DIRECTIONS[d.direction] ?? d.direction : undefined, ordersPerDay: d.ordersPerDay,
      access: d.access.map((a) => ACCESS[a] ?? a), accessNotes: d.accessNotes, preferredTime: d.preferredTime,
      plan: d.plan ? PLANS.find((p) => p.id === d.plan)?.name ?? d.plan : undefined, companyName: d.companyName,
      source: d.source ? ({ site: 'сайт', cabinet: 'кабинет', courier_app: 'приложение курьера', client_app: 'приложение клиента' } as Record<string, string>)[d.source] : undefined,
    };
    const [row] = await this.db.insert(supportRequests).values({
      companyId: company?.id ?? null, userId: login ? user!.sub : null, topic: d.topic, subject: d.subject,
      details, message: d.message, contactName: d.contactName, contactEmail: d.contactEmail.toLowerCase(), contactPhone: d.contactPhone,
    }).returning();

    const no = row.id.slice(0, 8).toUpperCase();
    const TOPIC: Record<string, string> = { integration: 'Подключение', problem: 'Проблема', plan: 'Тариф', idea: 'Предложение по доработке', other: 'Вопрос' };
    const line = (label: string, v?: unknown) => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) ? '' :
      Array.isArray(v) ? `${label}:\n${v.map((x) => `  — ${x}`).join('\n')}\n` : `${label}: ${v}\n`;
    const text = [
      `Обращение №${no} · ${TOPIC[d.topic]}`, `Тема: ${d.subject}`, line('Откуда', details.source), '',
      '— Компания —',
      company ? [line('Название', company.name), line('Город', company.city), line('Тариф', PLANS.find((p) => p.id === company.plan)?.name ?? company.plan),
        line('ID компании', company.id), line('Адрес кабинета', company.slug), line('API-ключ выпущен', company.apiKeyHash ? `да (${company.apiKeyPrefix}…)` : 'нет'),
        line('Вебхук', company.webhookUrl), line('Логин в кабинете', login?.email)].join('')
        : line('Ещё не зарегистрирована, название', d.companyName || '—'),
      '', '— Контакт —', line('Имя', d.contactName), line('Email', d.contactEmail), line('Телефон', d.contactPhone), line('Удобное время', d.preferredTime),
      d.topic === 'integration' ? ['', '— Что подключаем —', line('Система', details.system), line('Уточнение', d.systemOther), line('Адрес системы', d.systemUrl),
        line('Что передавать', details.direction), line('Заказов в день', d.ordersPerDay), line('Готовы предоставить', details.access), line('Комментарий о доступах', d.accessNotes)].join('') : '',
      details.plan ? line('Интересующий тариф', details.plan) : '',
      '', '— Описание —', d.message, '',
      `Ответить клиенту: просто ответьте на это письмо (${d.contactEmail}).`,
    ].join('\n');

    const sent = await this.mail.send(SUPPORT_EMAIL(), `[Маршрут] №${no} ${TOPIC[d.topic]}: ${d.subject}`, text, d.contactEmail);
    if (sent) {
      await this.db.update(supportRequests).set({ emailSent: true }).where(eq(supportRequests.id, row.id));
      this.mail.send(d.contactEmail, `Обращение №${no} получено`,
        `Здравствуйте, ${d.contactName}!\n\nМы получили ваше обращение «${d.subject}». ` +
        (d.topic === 'idea' ? 'Спасибо за предложение! Мы рассмотрим его и сообщим, когда доработка появится.\n' : 'Инженер свяжется с вами в течение одного рабочего дня.\n') +
        (d.topic === 'integration' ? 'Подключение бесплатное. Подготовьте, пожалуйста, доступы, которые вы отметили в заявке: инженер попросит передать их по защищённому каналу.\n' : '') +
        `\nНомер обращения: ${no}\nСлужба поддержки Маршрут, ${SUPPORT_EMAIL()}`).catch(() => {});
    }
    return { id: row.id, number: no, emailSent: sent, supportEmail: SUPPORT_EMAIL() };
  }
}

@Module({ controllers: [SupportController] })
export class SupportModule {}
