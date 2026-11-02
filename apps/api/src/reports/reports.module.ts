import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { couriers, shipments } from '../db/schema';
import { AuthUser, CurrentUser, Roles, Zod } from '../common/auth';

const Range = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

@Controller('reports')
@Roles('dispatcher')
export class ReportsController {
  constructor(@Inject(DB) private db: Db) {}

  private range(q: z.infer<typeof Range>) {
    const to = q.to ?? new Date(Date.now() + 86_400_000);
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
    return { from, to };
  }

  /** Итоги за период: по умолчанию последние 30 дней. */
  @Get('summary')
  async summary(@CurrentUser() u: AuthUser, @Query(new Zod(Range)) q: z.infer<typeof Range>) {
    const { from, to } = this.range(q);
    const inRange = and(eq(shipments.companyId, u.companyId), gte(shipments.createdAt, from), lt(shipments.createdAt, to));

    const [totals] = await this.db.select({
      total: sql<number>`count(*)`.mapWith(Number),
      delivered: sql<number>`count(*) filter (where ${shipments.status} = 'delivered')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${shipments.status} = 'failed')`.mapWith(Number),
      inWork: sql<number>`count(*) filter (where ${shipments.status} in ('created','at_warehouse','assigned'))`.mapWith(Number),
      revenueRub: sql<number>`coalesce(sum(${shipments.priceRub}) filter (where ${shipments.status} = 'delivered'), 0)`.mapWith(Number),
      codRub: sql<number>`coalesce(sum(${shipments.codCollected}), 0)`.mapWith(Number),
    }).from(shipments).where(inRange);

    const byDay = await this.db.select({
      day: sql<string>`to_char(date_trunc('day', ${shipments.createdAt}), 'YYYY-MM-DD')`,
      created: sql<number>`count(*)`.mapWith(Number),
      delivered: sql<number>`count(*) filter (where ${shipments.status} = 'delivered')`.mapWith(Number),
    }).from(shipments).where(inRange).groupBy(sql`1`).orderBy(sql`1`);

    const byCourier = await this.db.select({
      courier: couriers.name,
      delivered: sql<number>`count(*) filter (where ${shipments.status} = 'delivered')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${shipments.status} = 'failed')`.mapWith(Number),
      codRub: sql<number>`coalesce(sum(${shipments.codCollected}), 0)`.mapWith(Number),
      payRub: sql<number>`coalesce(sum(${shipments.courierPayRub}), 0)`.mapWith(Number),
      tipsRub: sql<number>`coalesce(sum(${shipments.tipRub}), 0)`.mapWith(Number),
      rating: sql<number | null>`round(avg(${shipments.rating})::numeric, 1)`.mapWith((v) => (v == null ? null : Number(v))),
    }).from(shipments).innerJoin(couriers, eq(couriers.id, shipments.courierId))
      .where(inRange).groupBy(couriers.name).orderBy(couriers.name);

    const closed = totals.delivered + totals.failed;
    return { from, to, ...totals, failRate: closed ? Math.round((totals.failed / closed) * 1000) / 10 : 0, byDay, byCourier };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
