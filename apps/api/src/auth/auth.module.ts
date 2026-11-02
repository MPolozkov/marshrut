import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpException, HttpStatus, Inject, Ip, Module,
  NotFoundException, Param, Post, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { VEHICLE_IDS } from '../common/vehicles';
import { DB, Db } from '../db/db.module';
import { companies, couriers, users } from '../db/schema';
import { AuthUser, CurrentUser, Public, Roles, Zod } from '../common/auth';
import { newInviteCode, seedCompanyDefaults, slugify } from '../db/defaults';
import { PLAN_IDS } from '../plans';
import { PlatformService } from '../platform/platform.service';

/** Не больше 8 неудачных попыток за 15 минут с одного IP на один email. */
export class LoginLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  private key(ip: string, email: string) { return `${ip}|${email.toLowerCase()}`; }
  check(ip: string, email: string) {
    const h = this.hits.get(this.key(ip, email));
    if (h && h.n >= 8 && h.until > Date.now()) {
      throw new HttpException('Слишком много попыток. Попробуйте через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
  fail(ip: string, email: string) {
    const k = this.key(ip, email), h = this.hits.get(k);
    const fresh = !h || h.until < Date.now();
    this.hits.set(k, { n: fresh ? 1 : h!.n + 1, until: Date.now() + 15 * 60_000 });
    if (this.hits.size > 50_000) this.hits.clear();
  }
  reset(ip: string, email: string) { this.hits.delete(this.key(ip, email)); }
}

const phone = z.string().regex(/^\+?[\d\s()-]{10,20}$/, 'Телефон в формате +7 900 000-00-00');
const RegisterDto = z.object({
  companyName: z.string().trim().min(2, 'Название — от 2 символов').max(80),
  city: z.string().trim().min(2, 'Укажите город').max(80),
  phone,
  name: z.string().trim().min(2, 'Укажите ваше имя'),
  email: z.string().trim().email('Неверный email'),
  password: z.string().min(8, 'Пароль — от 8 символов'),
  slug: z.string().regex(/^[a-z0-9-]{3,30}$/, 'Латиница, цифры и дефис, 3–30 символов').optional(),
  legalName: z.string().trim().max(200).optional(),
  inn: z.string().regex(/^(\d{10}|\d{12})$/, 'ИНН — 10 или 12 цифр').optional().or(z.literal('')),
  modules: z.object({ warehouse: z.boolean(), hr: z.boolean() }).default({ warehouse: true, hr: true }),
  plan: z.enum(PLAN_IDS).default('start'),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'нужно согласие с условиями и политикой обработки данных' }) }),
});
const CourierRegisterDto = z.object({
  name: z.string().trim().min(2, 'Укажите имя и фамилию'),
  inn: z.string().trim().regex(/^\d{12}$/, 'ИНН самозанятого — 12 цифр'),
  phone,
  email: z.string().trim().email('Неверный email'),
  password: z.string().min(8, 'Пароль — от 8 символов'),
  vehicle: z.enum(VEHICLE_IDS).default('foot'),
  city: z.string().trim().min(2, 'Укажите город').max(80),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'нужно согласие на обработку персональных данных' }) }),
});
const LoginDto = z.object({ email: z.string().trim().email(), password: z.string().min(1) });
const StaffDto = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['dispatcher', 'warehouse', 'courier', 'hr']),
});
const PasswordDto = z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(8, 'Новый пароль — от 8 символов') });

@Controller('auth')
export class AuthController {
  private limiter = new LoginLimiter();
  constructor(@Inject(DB) private db: Db, private jwt: JwtService, private platform: PlatformService) {}

  private token(u: { id: string; companyId: string; role: AuthUser['role']; name: string }) {
    const payload: AuthUser = { sub: u.id, companyId: u.companyId, role: u.role, name: u.name };
    return { token: this.jwt.sign(payload), user: payload };
  }

  private async assertEmailFree(email: string) {
    const exists = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (exists) throw new ConflictException('Пользователь с таким email уже зарегистрирован. Войдите или укажите другой email.');
  }

  /** Регистрация новой курьерской службы и её владельца. Название и город сразу видны в кабинете и уведомлениях. */
  @Public()
  @Post('register')
  async register(@Body(new Zod(RegisterDto)) dto: z.infer<typeof RegisterDto>, @Ip() ip: string) {
    this.limiter.check(ip, 'register');
    const email = dto.email.toLowerCase();
    await this.assertEmailFree(email);

    let slug = dto.slug ?? slugify(dto.companyName);
    for (let i = 2; await this.db.query.companies.findFirst({ where: eq(companies.slug, slug) }); i++) {
      if (dto.slug) throw new ConflictException('Такой адрес кабинета уже занят, выберите другой');
      slug = `${slugify(dto.companyName).slice(0, 26)}-${i}`;
    }
    this.limiter.fail(ip, 'register'); // не больше 8 регистраций с одного IP за 15 минут

    return this.db.transaction(async (tx) => {
      const [company] = await tx.insert(companies).values({
        name: dto.companyName, slug, city: dto.city, phone: dto.phone,
        legalName: dto.legalName || null, inn: dto.inn || null, modules: dto.modules,
        plan: dto.plan,
        trackingPrefix: (slug.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase() || 'MR').padEnd(2, 'X'),
        inviteCode: newInviteCode(),
      }).returning();
      const [user] = await tx.insert(users).values({
        companyId: company.id, email, name: dto.name, role: 'owner',
        passwordHash: await bcrypt.hash(dto.password, 10),
      }).returning();
      await seedCompanyDefaults(tx, company.id, { city: dto.city, warehouse: dto.modules.warehouse });
      return this.token(user);
    });
  }

  /** Данные компании по коду приглашения: приложение курьера показывает, к кому он присоединяется. */
  @Public()
  @Get('invite/:code')
  async invite(@Param('code') code: string) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.inviteCode, code.trim().toUpperCase()) });
    if (!c || c.blocked) throw new NotFoundException('Код не найден. Проверьте код у диспетчера.');
    return { name: c.name, city: c.city, brandColor: c.brandColor, logoUrl: c.logoUrl };
  }

  /** Курьер регистрируется сам в приложении; диспетчер подтверждает заявку в кабинете. */
  @Public()
  @Post('courier-register')
  async courierRegister(@Body(new Zod(CourierRegisterDto)) dto: z.infer<typeof CourierRegisterDto>, @Ip() ip: string) {
    this.limiter.check(ip, 'courier-register');
    this.limiter.fail(ip, 'courier-register');   // не больше 8 регистраций с одного адреса за 15 минут
    // Курьеры-самозанятые работают напрямую с платформой.
    const c = { id: await this.platform.id() };
    const email = dto.email.toLowerCase();
    await this.assertEmailFree(email);
    return this.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        companyId: c.id, email, name: dto.name, role: 'courier', passwordHash: await bcrypt.hash(dto.password, 10),
      }).returning();
      await tx.insert(couriers).values({
        companyId: c.id, userId: user.id, name: dto.name, phone: dto.phone, vehicle: dto.vehicle,
        city: dto.city, status: 'pending', active: false, inn: dto.inn, selfEmployed: true, payoutDetails: dto.phone,
      });
      return this.token(user);
    });
  }

  @Public()
  @Post('login')
  async login(@Body(new Zod(LoginDto)) dto: z.infer<typeof LoginDto>, @Ip() ip: string) {
    this.limiter.check(ip, dto.email);
    const user = await this.db.query.users.findFirst({ where: eq(users.email, dto.email.toLowerCase()) });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      this.limiter.fail(ip, dto.email);
      throw new UnauthorizedException('Неверный email или пароль');
    }
    if (!user.active) throw new UnauthorizedException('Доступ отключён. Обратитесь к руководителю.');
    const company = await this.db.query.companies.findFirst({ where: eq(companies.id, user.companyId) });
    if (company?.blocked) throw new UnauthorizedException('Доступ компании приостановлен. Свяжитесь с поддержкой.');
    this.limiter.reset(ip, dto.email);
    return this.token(user);
  }

  /** Профиль и бренд компании: кабинет и приложение подставляют название, цвет, логотип и включённые разделы. */
  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const c = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) });
    return {
      user: u,
      company: c && { name: c.name, slug: c.slug, city: c.city, brandColor: c.brandColor, logoUrl: c.logoUrl, modules: c.modules, plan: c.plan, trialEndsAt: c.trialEndsAt, paidUntil: c.paidUntil, kind: c.kind, pickupAddress: c.pickupAddress },
    };
  }

  @Post('change-password')
  async changePassword(@CurrentUser() u: AuthUser, @Body(new Zod(PasswordDto)) dto: z.infer<typeof PasswordDto>) {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, u.sub) });
    if (!user || !(await bcrypt.compare(dto.oldPassword, user.passwordHash))) throw new BadRequestException('Текущий пароль указан неверно');
    await this.db.update(users).set({ passwordHash: await bcrypt.hash(dto.newPassword, 10) }).where(eq(users.id, u.sub));
    return { ok: true };
  }

  /** Владелец добавляет сотрудника с доступом в систему. */
  @Roles('owner')
  @Post('staff')
  async addStaff(@CurrentUser() u: AuthUser, @Body(new Zod(StaffDto)) dto: z.infer<typeof StaffDto>) {
    const email = dto.email.toLowerCase();
    await this.assertEmailFree(email);
    const [user] = await this.db.insert(users).values({
      companyId: u.companyId, email, name: dto.name, role: dto.role, passwordHash: await bcrypt.hash(dto.password, 10),
    }).returning({ id: users.id, email: users.email, role: users.role });
    return user;
  }
}

@Module({ controllers: [AuthController] })
export class AuthModule {}
