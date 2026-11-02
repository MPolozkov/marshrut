import { BadRequestException, Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { newInviteCode, seedCells } from '../db/defaults';
import { newApiKey } from '../integrations/keys';
import { WebhooksService } from '../integrations/webhooks';
import * as bcrypt from 'bcryptjs';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, users } from '../db/schema';
import { AuthUser, CurrentUser, Public, Roles, Zod } from '../common/auth';

const CompanyDto = z.object({
  name: z.string().min(2).max(80),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #0e7c66'),
  // Логотип хранится как data URL (PNG/JPEG/SVG до ~300 КБ): его видно на входе и странице трекинга без авторизации.
  logoUrl: z.string().max(400_000).regex(/^data:image\/(png|jpeg|svg\+xml|webp);base64,/, 'Загрузите PNG, JPEG, SVG или WebP').nullable(),
  trackingPrefix: z.string().regex(/^[A-Z]{2,4}$/, 'От 2 до 4 латинских заглавных букв'),
  volumetricDivisor: z.number().int().min(1000).max(10000),
  legalName: z.string().max(200).nullable(),
  inn: z.string().regex(/^(\d{10}|\d{12})$/, 'ИНН — 10 или 12 цифр').nullable(),
  legalAddress: z.string().max(300).nullable(),
  director: z.string().max(120).nullable(),
  phone: z.string().max(30).nullable(),
  city: z.string().trim().max(80).default(''),
  modules: z.object({ warehouse: z.boolean(), hr: z.boolean() }),
  pickupAddress: z.string().trim().max(300).nullable().optional(),   // откуда курьеры забирают заказы по умолчанию
});
const UserPatch = z.object({
  role: z.enum(['dispatcher', 'warehouse', 'courier', 'hr']).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
  name: z.string().min(2).optional(),
});

@Controller()
export class CompanyController {
  constructor(@Inject(DB) private db: Db, private webhooks: WebhooksService) {}

  @Roles('owner')
  @Get('company')
  async get(@CurrentUser() u: AuthUser) {
    const { shipmentSeq, apiKeyHash, webhookSecret, ...c } = (await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) }))!;
    return { ...c, hasApiKey: !!apiKeyHash, hasWebhookSecret: !!webhookSecret };
  }

  @Roles('owner')
  @Put('company')
  async update(@CurrentUser() u: AuthUser, @Body(new Zod(CompanyDto)) dto: z.infer<typeof CompanyDto>) {
    const [c] = await this.db.update(companies).set(dto).where(eq(companies.id, u.companyId)).returning();
    // Включили склад — создаём стандартные ячейки, если их ещё нет.
    if (dto.modules.warehouse) await seedCells(this.db, u.companyId);
    return { ok: true, name: c.name };
  }

  /** Новый код для курьеров. Старый перестаёт работать. */
  @Roles('owner')
  @Post('company/invite-code')
  async inviteCode(@CurrentUser() u: AuthUser) {
    const [c] = await this.db.update(companies).set({ inviteCode: newInviteCode() }).where(eq(companies.id, u.companyId)).returning();
    return { inviteCode: c.inviteCode };
  }

  /** Выпустить API-ключ. Показывается один раз; старый ключ сразу перестаёт работать. */
  @Roles('owner')
  @Post('company/api-key')
  async apiKey(@CurrentUser() u: AuthUser) {
    const k = newApiKey();
    await this.db.update(companies).set({ apiKeyHash: k.hash, apiKeyPrefix: k.prefix }).where(eq(companies.id, u.companyId));
    return { apiKey: k.key, prefix: k.prefix };
  }

  @Roles('owner')
  @Delete('company/api-key')
  async revokeKey(@CurrentUser() u: AuthUser) {
    await this.db.update(companies).set({ apiKeyHash: null, apiKeyPrefix: null }).where(eq(companies.id, u.companyId));
    return { ok: true };
  }

  /** Адрес, куда отправлять уведомления о статусах. Секрет для подписи создаётся автоматически. */
  @Roles('owner')
  @Put('company/webhook')
  async webhook(@CurrentUser() u: AuthUser, @Body(new Zod(z.object({ url: z.string().url('Укажите адрес, начиная с https://').max(500).nullable() }))) b: { url: string | null }) {
    const cur = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) });
    const secret = b.url ? cur?.webhookSecret ?? randomBytes(24).toString('hex') : null;
    await this.db.update(companies).set({ webhookUrl: b.url, webhookSecret: secret }).where(eq(companies.id, u.companyId));
    return { url: b.url, secret };
  }

  @Roles('owner')
  @Post('company/webhook/test')
  async webhookTest(@CurrentUser() u: AuthUser) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) });
    if (!c?.webhookUrl) throw new BadRequestException('Сначала сохраните адрес вебхука');
    try {
      return await this.webhooks.test(c.webhookUrl, c.webhookSecret ?? '');
    } catch (e: any) {
      throw new BadRequestException(`Адрес не отвечает: ${e.message}`);
    }
  }

  /** Бренд для страницы входа на поддомене клиента (white-label). */
  @Public()
  @Get('public/brand/:slug')
  async brand(@Param('slug') slug: string) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.slug, slug.toLowerCase()) });
    if (!c) throw new NotFoundException('Компания не найдена');
    return { name: c.name, brandColor: c.brandColor, logoUrl: c.logoUrl };
  }

  @Roles('owner')
  @Get('company/users')
  usersList(@CurrentUser() u: AuthUser) {
    return this.db.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, createdAt: users.createdAt })
      .from(users).where(eq(users.companyId, u.companyId)).orderBy(asc(users.name));
  }

  @Roles('owner')
  @Patch('company/users/:id')
  async userPatch(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(UserPatch)) dto: z.infer<typeof UserPatch>) {
    if (id === u.sub && (dto.active === false || dto.role)) throw new BadRequestException('Нельзя отключить или понизить себя');
    const { password, ...rest } = dto;
    const set = { ...rest, ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) };
    const [row] = await this.db.update(users).set(set).where(and(eq(users.id, id), eq(users.companyId, u.companyId)))
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active });
    if (!row) throw new NotFoundException('Пользователь не найден');
    return row;
  }
}

@Module({ controllers: [CompanyController] })
export class CompanyModule {}
