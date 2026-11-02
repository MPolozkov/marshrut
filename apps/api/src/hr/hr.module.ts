import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { and, asc, between, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, Db } from '../db/db.module';
import { attendance, candidates, companies, employees } from '../db/schema';
import { AuthUser, CurrentUser, Roles, Zod } from '../common/auth';
import { NotificationsService } from '../notifications/notifications.module';

const EmployeeDto = z.object({
  name: z.string().min(2),
  phone: z.string().optional(),
  position: z.string().min(2),
  contractType: z.enum(['employment', 'gph', 'self_employed']),
});
const CandidateDto = z.object({
  name: z.string().min(2),
  phone: z.string().optional(),
  vacancy: z.string().min(2),
  channel: z.enum(['telegram', 'max', 'sms']).default('sms'),
  chatId: z.string().optional(),
});
const InviteDto = z.object({ interviewAt: z.coerce.date(), address: z.string().min(3) });
const Month = z.string().regex(/^\d{4}-\d{2}$/, 'Формат месяца: ГГГГ-ММ');

const today = () => new Date().toISOString().slice(0, 10);

@Controller('hr')
@Roles('hr')
export class HrController {
  constructor(@Inject(DB) private db: Db, private notify: NotificationsService) {}

  @Get('employees')
  employees(@CurrentUser() u: AuthUser) {
    return this.db.select().from(employees).where(and(eq(employees.companyId, u.companyId), eq(employees.active, true))).orderBy(asc(employees.name));
  }

  @Post('employees')
  async addEmployee(@CurrentUser() u: AuthUser, @Body(new Zod(EmployeeDto)) dto: z.infer<typeof EmployeeDto>) {
    const [e] = await this.db.insert(employees).values({ ...dto, companyId: u.companyId }).returning();
    return e;
  }

  @Roles('hr', 'dispatcher', 'warehouse')
  @Post('employees/:id/check-in')
  async checkIn(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.ownEmployee(u, id);
    const [row] = await this.db.insert(attendance).values({ companyId: u.companyId, employeeId: id, day: today(), checkIn: new Date() })
      .onConflictDoNothing().returning();
    if (!row) throw new BadRequestException('Приход сегодня уже отмечен');
    return row;
  }

  @Roles('hr', 'dispatcher', 'warehouse')
  @Post('employees/:id/check-out')
  async checkOut(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.ownEmployee(u, id);
    const [row] = await this.db.update(attendance).set({ checkOut: new Date() })
      .where(and(eq(attendance.employeeId, id), eq(attendance.day, today()))).returning();
    if (!row) throw new BadRequestException('Сначала отметьте приход');
    return row;
  }

  /** Табель за месяц: основа для формы Т-13 и расчёта выплат. */
  @Get('timesheet')
  timesheet(@CurrentUser() u: AuthUser, @Query('month', new Zod(Month)) month: string) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return this.db.select({
      employeeId: attendance.employeeId, name: employees.name, day: attendance.day,
      checkIn: attendance.checkIn, checkOut: attendance.checkOut,
    }).from(attendance)
      .innerJoin(employees, eq(employees.id, attendance.employeeId))
      .where(and(eq(attendance.companyId, u.companyId), between(attendance.day, `${month}-01`, `${month}-${String(last).padStart(2, '0')}`)))
      .orderBy(asc(employees.name), asc(attendance.day));
  }

  @Get('candidates')
  candidates(@CurrentUser() u: AuthUser) {
    return this.db.select().from(candidates).where(eq(candidates.companyId, u.companyId)).orderBy(asc(candidates.createdAt));
  }

  @Post('candidates')
  async addCandidate(@CurrentUser() u: AuthUser, @Body(new Zod(CandidateDto)) dto: z.infer<typeof CandidateDto>) {
    const [c] = await this.db.insert(candidates).values({ ...dto, companyId: u.companyId }).returning();
    return c;
  }

  /** Приглашение на собеседование уходит кандидату в выбранный канал. */
  @Post('candidates/:id/invite')
  async invite(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new Zod(InviteDto)) dto: z.infer<typeof InviteDto>) {
    const c = await this.db.query.candidates.findFirst({ where: and(eq(candidates.id, id), eq(candidates.companyId, u.companyId)) });
    if (!c) throw new NotFoundException('Кандидат не найден');
    const company = await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) });
    const when = dto.interviewAt.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    const [upd] = await this.db.update(candidates).set({ stage: 'invited', interviewAt: dto.interviewAt }).where(eq(candidates.id, id)).returning();
    const to = c.channel === 'sms' ? c.phone : c.chatId ?? c.phone;
    if (to) await this.notify.send({ companyId: u.companyId, channel: c.channel, to, text: `${company?.name}: приглашаем на собеседование ${when}, адрес: ${dto.address}.` });
    return upd;
  }

  @Post('candidates/:id/hire')
  async hire(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string,
    @Body(new Zod(z.object({ contractType: EmployeeDto.shape.contractType, position: z.string().optional() }))) b: { contractType: 'employment' | 'gph' | 'self_employed'; position?: string }) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.update(candidates).set({ stage: 'hired' })
        .where(and(eq(candidates.id, id), eq(candidates.companyId, u.companyId))).returning();
      if (!c) throw new NotFoundException('Кандидат не найден');
      const [e] = await tx.insert(employees).values({
        companyId: u.companyId, name: c.name, phone: c.phone, position: b.position ?? c.vacancy, contractType: b.contractType,
      }).returning();
      return e;
    });
  }

  private async ownEmployee(u: AuthUser, id: string) {
    const e = await this.db.query.employees.findFirst({ where: and(eq(employees.id, id), eq(employees.companyId, u.companyId)) });
    if (!e) throw new NotFoundException('Сотрудник не найден');
  }
}

@Module({ controllers: [HrController] })
export class HrModule {}
