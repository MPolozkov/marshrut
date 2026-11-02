import { BadRequestException, Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { companies, zones } from '../db/schema';
import { AuthUser, CurrentUser, Roles, Zod } from '../common/auth';
import { quote } from '../pricing/pricing';

const ZoneDto = z.object({
  name: z.string().min(1),
  baseRub: z.number().int().min(0),
  perKgRub: z.number().int().min(0),
  etaDays: z.number().int().min(0).default(0),
  city: z.string().trim().max(80).default(''),
  polygon: z.any().optional(),
});
const QuoteDto = z.object({
  zoneId: z.string().uuid(),
  weightKg: z.number().positive(),
  lengthCm: z.number().int().positive(),
  widthCm: z.number().int().positive(),
  heightCm: z.number().int().positive(),
});

@Controller()
export class ZonesController {
  constructor(@Inject(DB) private db: Db) {}

  /** Зоны компании; ?city= — только в выбранном городе. */
  @Get('zones')
  list(@CurrentUser() u: AuthUser, @Query('city') city?: string) {
    const where = city ? and(eq(zones.companyId, u.companyId), eq(zones.city, city)) : eq(zones.companyId, u.companyId);
    return this.db.select().from(zones).where(where).orderBy(asc(zones.city), asc(zones.name));
  }

  /** Города, где у компании есть зоны доставки, — для выбора города в накладной. */
  @Get('zones/cities')
  async cities(@CurrentUser() u: AuthUser) {
    const rows = await this.db.selectDistinct({ city: zones.city }).from(zones).where(eq(zones.companyId, u.companyId)).orderBy(asc(zones.city));
    return rows.map((r) => r.city);
  }

  @Roles('owner')
  @Delete('zones/:id')
  async remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    try {
      const [z] = await this.db.delete(zones).where(and(eq(zones.id, id), eq(zones.companyId, u.companyId))).returning();
      if (!z) throw new NotFoundException('Зона не найдена');
      return { ok: true };
    } catch (e: any) {
      if (e instanceof NotFoundException) throw e;
      throw new BadRequestException('По этой зоне уже есть накладные — её нельзя удалить, только переименовать');
    }
  }

  @Roles('owner')
  @Post('zones')
  async create(@CurrentUser() u: AuthUser, @Body(new Zod(ZoneDto)) dto: z.infer<typeof ZoneDto>) {
    const [z] = await this.db.insert(zones).values({ ...dto, companyId: u.companyId }).returning();
    return z;
  }

  @Roles('owner')
  @Put('zones/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(ZoneDto)) dto: z.infer<typeof ZoneDto>) {
    const [z] = await this.db.update(zones).set(dto).where(and(eq(zones.id, id), eq(zones.companyId, u.companyId))).returning();
    if (!z) throw new NotFoundException('Зона не найдена');
    return z;
  }

  /** Калькулятор стоимости для менеджера и виджета на сайте. */
  @Post('pricing/quote')
  async quote(@CurrentUser() u: AuthUser, @Body(new Zod(QuoteDto)) dto: z.infer<typeof QuoteDto>) {
    const zone = await this.db.query.zones.findFirst({ where: and(eq(zones.id, dto.zoneId), eq(zones.companyId, u.companyId)) });
    if (!zone) throw new NotFoundException('Зона не найдена');
    const company = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) });
    return { ...quote(dto, zone, company?.volumetricDivisor), etaDays: zone.etaDays };
  }
}

@Module({ controllers: [ZonesController] })
export class ZonesModule {}
