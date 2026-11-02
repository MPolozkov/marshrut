import {
  BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, PipeTransform,
  SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ZodSchema } from 'zod';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { companies, users } from '../db/schema';

/** superadmin — владелец платформы (панель /admin), у него нет компании. */
/** customer — заказчик из приложения клиента: видит только свои заказы. */
export type Role = 'owner' | 'dispatcher' | 'warehouse' | 'courier' | 'hr' | 'superadmin' | 'customer';
export interface AuthUser { sub: string; companyId: string; role: Role; name: string }

const PUBLIC = 'isPublic';
const ROLES = 'roles';
/** Эндпоинт без авторизации (вход, публичный трекинг, приём заказов по API-ключу). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Ограничить доступ ролями. Владелец компании проходит любые роли, кроме superadmin. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser =>
  ctx.switchToHttp().getRequest().user);

@Injectable()
export class AuthGuard implements CanActivate {
  // Кэш на 60 секунд: отключённый сотрудник или заблокированная компания теряют доступ почти сразу.
  // Общий для всех экземпляров guard, чтобы сброс из панели администратора действовал сразу.
  private static cache = new Map<string, { ok: string | null; at: number }>();
  private get cache() { return AuthGuard.cache; }

  constructor(private jwt: JwtService, private reflector: Reflector, @Inject(DB) private db: Db) {}

  /** null — доступ есть, иначе текст причины отказа. */
  private async denyReason(userId: string): Promise<string | null> {
    const c = this.cache.get(userId);
    if (c && Date.now() - c.at < 60_000) return c.ok;
    const [row] = await this.db.select({ active: users.active, blocked: companies.blocked })
      .from(users).innerJoin(companies, eq(companies.id, users.companyId)).where(eq(users.id, userId));
    const reason = !row ? 'Пользователь не найден'
      : row.blocked ? 'Доступ компании приостановлен. Свяжитесь с поддержкой.'
      : !row.active ? 'Доступ отключён. Обратитесь к руководителю.' : null;
    this.cache.set(userId, { ok: reason, at: Date.now() });
    if (this.cache.size > 20_000) this.cache.clear();
    return reason;
  }

  private async companyBlocked(companyId: string) {
    const key = `company:${companyId}`;
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < 60_000) return !!c.ok;
    const row = await this.db.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { blocked: true } });
    const reason = !row || row.blocked ? 'blocked' : null;
    this.cache.set(key, { ok: reason, at: Date.now() });
    return !!reason;
  }

  /** Сбросить кэш (после блокировки компании из панели администратора). */
  forget() { this.cache.clear(); }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Войдите в систему');
    try {
      req.user = this.jwt.verify<AuthUser>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Сессия истекла, войдите снова');
    }
    const user: AuthUser = req.user;
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets) ?? [];

    // Администратор платформы работает только с эндпоинтами /admin.
    if (user.role === 'superadmin') {
      if (!roles.includes('superadmin')) throw new ForbiddenException('Раздел доступен только сотрудникам компании');
      return true;
    }
    if (roles.includes('superadmin')) throw new ForbiddenException('Раздел доступен только администратору платформы');

    // Клиент из приложения заказчика — только эндпоинты /client.
    if (user.role === 'customer') {
      if (!roles.includes('customer')) throw new ForbiddenException('Раздел недоступен в приложении клиента');
      // Заказчик общего приложения не привязан к компании (companyId пустой).
      if (user.companyId && await this.companyBlocked(user.companyId)) throw new UnauthorizedException('Сервис компании временно недоступен');
      return true;
    }
    if (roles.includes('customer')) throw new ForbiddenException('Раздел доступен только в приложении клиента');

    const reason = await this.denyReason(user.sub);
    if (reason) throw new UnauthorizedException(reason);
    if (roles.length && user.role !== 'owner' && !roles.includes(user.role)) {
      throw new ForbiddenException('Недостаточно прав для этого действия');
    }
    return true;
  }
}

/** Валидация тела запроса схемой zod. */
export class Zod<T> implements PipeTransform {
  constructor(private schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      const errors = r.error.flatten().fieldErrors as Record<string, string[] | undefined>;
      const first = Object.entries(errors).map(([k, v]) => `${k}: ${v?.[0]}`)[0];
      throw new BadRequestException({ message: first ? `Проверьте поле ${first}` : 'Проверьте поля формы', errors });
    }
    return r.data;
  }
}
