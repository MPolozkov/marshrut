import {
  BadRequestException, Body, Controller, Get, Headers, Inject, Ip, Module, NotFoundException, Param, Post, UnauthorizedException,
} from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, shipments } from '../db/schema';
import { Public, Zod } from '../common/auth';
import { ShipmentsModule } from '../shipments/shipments.module';
import { ShipmentsService } from '../shipments/shipments.service';
import { OrdersModule } from '../orders/orders.module';
import { OrdersService } from '../orders/orders.service';
import { VEHICLE_IDS } from '../common/vehicles';
import { LoginLimiter } from '../auth/auth.module';
import { hashKey } from './keys';


const Order = z.object({
  externalId: z.string().trim().min(1).max(100).optional(),
  sender: z.object({ name: z.string().min(1), phone: z.string().optional() }).optional(),
  recipient: z.object({ name: z.string().min(1), phone: z.string().min(10, 'Нужен телефон получателя') }),
  city: z.string().max(80).optional(),
  pickupAddress: z.string().min(5).optional(),        // откуда забрать; по умолчанию — адрес отправки из настроек
  address: z.object({
    street: z.string().min(3), house: z.string().min(1), apartment: z.string().min(1, 'Квартира или офис обязательны (для частного дома — «частный дом»)'),
    entrance: z.string().optional(), floor: z.string().optional(), intercom: z.string().optional(),
  }),
  vehicle: z.enum(VEHICLE_IDS).optional(),
  weightKg: z.coerce.number().positive().max(2000).default(1),
  lengthCm: z.coerce.number().int().positive().default(30),
  widthCm: z.coerce.number().int().positive().default(20),
  heightCm: z.coerce.number().int().positive().default(15),
  comment: z.string().max(500).optional(),
});
const Batch = z.union([Order, z.object({ orders: z.array(Order).min(1).max(500) })]);

/**
 * Публичный API для систем клиента. Авторизация — заголовок `Authorization: Bearer mr_live_…` или `X-Api-Key`.
 * Ключ определяет компанию, поэтому заказ сразу попадает в её кабинет.
 */
@Controller('integration/v1')
export class IntegrationController {
  private limiter = new LoginLimiter();
  constructor(@Inject(DB) private db: Db, private shipmentsSvc: ShipmentsService, private orders: OrdersService) {}

  private async company(auth?: string, xKey?: string, ip = '') {
    const key = (xKey ?? auth?.replace(/^Bearer\s+/i, '') ?? '').trim();
    this.limiter.check(ip, 'api');
    if (!key.startsWith('mr_live_')) { this.limiter.fail(ip, 'api'); throw new UnauthorizedException('Нужен API-ключ: заголовок Authorization: Bearer mr_live_…'); }
    const c = await this.db.query.companies.findFirst({ where: eq(companies.apiKeyHash, hashKey(key)) });
    if (!c) { this.limiter.fail(ip, 'api'); throw new UnauthorizedException('API-ключ не найден или отозван'); }
    if (c.blocked) throw new UnauthorizedException('Доступ компании приостановлен');
    return c;
  }

  /** Проверка ключа: вернёт название компании. */
  @Public()
  @Get('ping')
  async ping(@Headers('authorization') a?: string, @Headers('x-api-key') k?: string, @Ip() ip?: string) {
    const c = await this.company(a, k, ip);
    return { ok: true, company: c.name };
  }

  /** Создать один заказ или пачку { orders: [...] }. Повтор с тем же externalId вернёт уже созданную накладную. */
  @Public()
  @Post('orders')
  async create(@Body(new Zod(Batch)) body: z.infer<typeof Batch>,
    @Headers('authorization') a?: string, @Headers('x-api-key') k?: string, @Ip() ip?: string) {
    const c = await this.company(a, k, ip);
    const payer = await this.orders.orgPayer(c.id);
    const list = 'orders' in body ? body.orders : [body];
    const results = [];
    for (const o of list) {
      try {
        const { shipment: s }: any = await this.orders.create(c.id, {
          externalId: o.externalId, city: o.city || c.city, fromAddress: o.pickupAddress || c.pickupAddress || '',
          toStreet: o.address.street, toHouse: o.address.house, toApartment: o.address.apartment, toEntrance: o.address.entrance, toFloor: o.address.floor, toIntercom: o.address.intercom,
          recipientName: o.recipient.name, recipientPhone: o.recipient.phone, vehicle: o.vehicle, comment: o.comment,
          weightKg: o.weightKg, lengthCm: o.lengthCm, widthCm: o.widthCm, heightCm: o.heightCm,
        }, { source: 'api', payer, senderName: o.sender?.name ?? c.name, senderPhone: o.sender?.phone ?? c.phone ?? undefined });
        results.push({ ok: true, duplicate: !!s.duplicate, ...this.shipmentsSvc.publicView(s), payStatus: s.payStatus });
      } catch (e: any) {
        results.push({ ok: false, externalId: o.externalId ?? null, error: e?.response?.message ?? e.message });
      }
    }
    return 'orders' in body ? { results } : results[0];
  }

  /** Статус по номеру накладной или номеру заказа клиента. */
  @Public()
  @Get('orders/:id')
  async status(@Param('id') id: string, @Headers('authorization') a?: string, @Headers('x-api-key') k?: string, @Ip() ip?: string) {
    const c = await this.company(a, k, ip);
    const s = await this.db.query.shipments.findFirst({
      where: and(eq(shipments.companyId, c.id), or(eq(shipments.trackingNumber, id.toUpperCase()), eq(shipments.externalId, id))),
    });
    if (!s) throw new NotFoundException('Заказ не найден');
    return this.shipmentsSvc.publicView(s);
  }
}

@Module({ imports: [ShipmentsModule, OrdersModule], controllers: [IntegrationController] })
export class IntegrationsModule {}
