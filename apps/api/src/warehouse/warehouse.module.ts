import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Post } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { cells, shipments } from '../db/schema';
import { AuthUser, CurrentUser, Roles, Zod } from '../common/auth';
import { ShipmentsModule, } from '../shipments/shipments.module';
import { ShipmentsService } from '../shipments/shipments.service';

const ScanDto = z.object({ code: z.string().min(3), cellCode: z.string().optional() });
const CellsDto = z.object({ codes: z.array(z.string().regex(/^[A-Z]{1,2}\d{1,3}$/)).min(1) });

@Controller('warehouse')
@Roles('warehouse', 'dispatcher')
export class WarehouseController {
  constructor(@Inject(DB) private db: Db, private shipmentsSvc: ShipmentsService) {}

  /** Схема стеллажей: какие ячейки заняты и чем. */
  @Get('cells')
  async cells(@CurrentUser() u: AuthUser) {
    const all = await this.db.select().from(cells).where(eq(cells.companyId, u.companyId)).orderBy(asc(cells.code));
    const stored = await this.db.select({ id: shipments.id, trackingNumber: shipments.trackingNumber, cellCode: shipments.cellCode })
      .from(shipments).where(and(eq(shipments.companyId, u.companyId), eq(shipments.status, 'at_warehouse')));
    const byCell = new Map(stored.map((s) => [s.cellCode, s]));
    return all.map((c) => ({ code: c.code, shipment: byCell.get(c.code) ?? null }));
  }

  @Roles('owner')
  @Post('cells')
  async addCells(@CurrentUser() u: AuthUser, @Body(new Zod(CellsDto)) dto: z.infer<typeof CellsDto>) {
    await this.db.insert(cells).values(dto.codes.map((code) => ({ companyId: u.companyId, code }))).onConflictDoNothing();
    return { ok: true };
  }

  /**
   * Сканер: отправление, которого нет на складе, принимается в ячейку (указанную или первую свободную);
   * лежащее на складе — выдаётся, ячейка освобождается.
   */
  @Post('scan')
  async scan(@CurrentUser() u: AuthUser, @Body(new Zod(ScanDto)) dto: z.infer<typeof ScanDto>) {
    const s = await this.shipmentsSvc.findByNumber(u.companyId, dto.code);
    if (!s) throw new NotFoundException('Накладная не найдена. Проверьте номер.');

    if (s.status === 'at_warehouse') {
      const from = s.cellCode;
      await this.shipmentsSvc.setStatus(u, s.id, 'created', `Выдано со склада, ячейка ${from}`, { cellCode: null });
      return { action: 'issued', cellCode: from, trackingNumber: s.trackingNumber };
    }
    if (s.status === 'delivered') throw new BadRequestException('Отправление уже доставлено');
    if (s.status === 'assigned') throw new BadRequestException('Отправление у курьера. Сначала отметьте «Не вручено».');

    const map = await this.cells(u);
    const wanted = dto.cellCode?.toUpperCase();
    const cell = wanted
      ? map.find((c) => c.code === wanted)
      : map.find((c) => !c.shipment);
    if (!cell) throw new BadRequestException(wanted ? 'Такой ячейки нет' : 'Свободных ячеек нет');
    if (cell.shipment) throw new BadRequestException(`Ячейка ${cell.code} занята`);

    await this.shipmentsSvc.setStatus(u, s.id, 'at_warehouse', `Принято в ячейку ${cell.code}`, { cellCode: cell.code, courierId: null });
    return { action: 'stored', cellCode: cell.code, trackingNumber: s.trackingNumber };
  }
}

@Module({ imports: [ShipmentsModule], controllers: [WarehouseController] })
export class WarehouseModule {}
