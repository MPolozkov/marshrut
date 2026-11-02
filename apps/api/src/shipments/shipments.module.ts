import { BadRequestException, Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import bwipjs from 'bwip-js';
import { AuthUser, CurrentUser, Public, Roles, Zod } from '../common/auth';
import { ShipmentsService } from './shipments.service';

const DeliverDto = z.object({
  code: z.string().min(4).max(8),
  photo: z.string().max(9_000_000).optional(),
  signature: z.string().max(3_000_000).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  codCollected: z.number().int().min(0).optional(),
  codMethod: z.enum(['cash', 'card', 'sbp']).optional(),
  at: z.coerce.date().optional(),
});
const StatusQ = z.enum(['created', 'at_warehouse', 'assigned', 'delivered', 'failed', 'returned']).optional();

@Controller('shipments')
export class ShipmentsController {
  constructor(private svc: ShipmentsService) {}

  @Roles('dispatcher', 'warehouse')
  @Get()
  list(@CurrentUser() u: AuthUser, @Query('status', new Zod(StatusQ)) status?: z.infer<typeof StatusQ>) {
    return this.svc.list(u, status);
  }

  /** Выгрузка всех накладных в CSV (открывается в Excel). */
  @Roles('dispatcher')
  @Get('export.csv')
  async export(@CurrentUser() u: AuthUser, @Res() res: Response) {
    const rows = await this.svc.list(u, undefined, 100_000);
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Номер', 'Номер заказа', 'Источник', 'Создана', 'Отправитель', 'Получатель', 'Город', 'Адрес', 'Зона', 'Вес, кг', 'Стоимость, ₽', 'Статус', 'Курьер', 'Ячейка'];
    const SRC: Record<string, string> = { manual: 'вручную', api: 'API', import: 'файл' };
    const lines = rows.map((r) => [r.trackingNumber, r.externalId, SRC[r.source] ?? r.source, new Date(r.createdAt).toLocaleString('ru-RU'), r.senderName, r.recipientName, r.city, r.address,
      r.zoneName, String(r.weightKg).replace('.', ','), r.priceRub, r.status, r.courierName, r.cellCode].map(cell).join(';'));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="shipments-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + [head.map(cell).join(';'), ...lines].join('\r\n'));
  }

  @Roles('dispatcher', 'warehouse', 'courier')
  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return u.role === 'courier' ? this.svc.getForCourier(u, id) : this.svc.get(u, id);
  }

  /** Этикетка со штрихкодом Code128 (PNG) для термопринтера. */
  @Roles('dispatcher', 'warehouse')
  @Get(':id/barcode.png')
  async barcode(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const s = await this.svc.get(u, id);
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: s.trackingNumber, scale: 3, height: 15, includetext: true, textxalign: 'center' });
    res.type('png').send(png);
  }

  @Roles('dispatcher')
  @Post(':id/assign')
  assign(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(z.object({ courierId: z.string().uuid() }))) b: { courierId: string }) {
    return this.svc.assign(u, id, b.courierId);
  }

  /** Выставить заказ курьерам: увидят подходящие по транспорту и городу, везёт первый принявший. */
  @Roles('dispatcher')
  @Post(':id/offer')
  offer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.offer(u, id);
  }

  @Roles('dispatcher', 'courier')
  @Post(':id/deliver')
  deliver(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(DeliverDto)) b: z.infer<typeof DeliverDto>) {
    return this.svc.deliver(u, id, b);
  }

  @Roles('dispatcher', 'courier')
  @Post(':id/pickup')
  pickup(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.pickup(u, id);
  }

  @Roles('dispatcher', 'courier')
  @Post(':id/fail')
  fail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(z.object({ reason: z.string().default('') }))) b: { reason: string }) {
    return this.svc.fail(u, id, b.reason);
  }
}

@Controller('track')
export class TrackController {
  constructor(private svc: ShipmentsService) {}

  @Public()
  @Get(':number')
  track(@Param('number') n: string) {
    return this.svc.track(n);
  }
}

@Module({ controllers: [ShipmentsController, TrackController], providers: [ShipmentsService], exports: [ShipmentsService] })
export class ShipmentsModule {}
