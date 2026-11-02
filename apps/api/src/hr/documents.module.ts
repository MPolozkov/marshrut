import { BadRequestException, Controller, Get, Header, Inject, Module, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common';
import { and, asc, between, eq } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { attendance, companies, employees } from '../db/schema';
import { AuthUser, CurrentUser, Roles } from '../common/auth';

/*
 * Кадровые документы формируются как HTML-страницы, которые сотрудник кадров печатает или сохраняет в PDF из браузера.
 * Так кириллица и вёрстка работают без шрифтов на сервере. Тексты — шаблоны: перед продажей и использованием
 * их должен проверить юрист, а клиент может заменить их своими.
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const blank = (s?: string | null, w = 220) => s ? esc(s) : `<span class="blank" style="min-width:${w}px"></span>`;
const ruDate = (d: Date | string) => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });

function page(title: string, body: string, landscape = false) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 18mm 16mm; }
  body { font: 12pt/1.5 "Times New Roman", Times, serif; color: #000; max-width: ${landscape ? '1100px' : '760px'}; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 14pt; text-align: center; margin: 0 0 4px; } .c { text-align: center; } .r { text-align: right; }
  .meta { display: flex; justify-content: space-between; margin: 12px 0 18px; }
  p { margin: 0 0 8px; text-align: justify; } ol { padding-left: 20px; } li { margin-bottom: 6px; }
  .blank { display: inline-block; border-bottom: 1px solid #000; height: 1em; vertical-align: bottom; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 32px; }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; } td, th { border: 1px solid #000; padding: 3px 4px; text-align: center; }
  td.l, th.l { text-align: left; } .note { font: 9pt Arial, sans-serif; color: #555; margin-top: 24px; }
  .toolbar { font: 13px Arial, sans-serif; background: #f3f5f4; border: 1px solid #ccc; padding: 8px 12px; border-radius: 6px; margin-bottom: 16px; }
  @media print { .toolbar { display: none; } body { margin: 0; max-width: none; } }
  </style></head><body><div class="toolbar">Чтобы получить PDF, нажмите Ctrl+P (на Mac — Cmd+P) и выберите «Сохранить как PDF».</div>${body}</body></html>`;
}

type Company = typeof companies.$inferSelect;
type Employee = typeof employees.$inferSelect;

function employer(c: Company) {
  return `${blank(c.legalName ?? c.name, 260)}, ИНН ${blank(c.inn, 140)}, адрес: ${blank(c.legalAddress, 300)}, в лице ${blank(c.director, 220)}`;
}
function signatures(c: Company, partyB: string, e: Employee) {
  return `<div class="sign"><div><b>${partyB === 'Работник' ? 'Работодатель' : 'Заказчик'}</b><br>${esc(c.legalName ?? c.name)}<br>ИНН ${blank(c.inn, 120)}<br><br>____________ / ${blank(c.director, 160)}<br>М. П.</div>
  <div><b>${partyB}</b><br>${esc(e.name)}<br>Паспорт ${blank(null, 160)}<br>Адрес ${blank(null, 200)}<br><br>____________ / ${esc(e.name)}</div></div>`;
}

const DOCS: Record<string, { title: string; render: (c: Company, e: Employee) => string }> = {
  'employment-contract': {
    title: 'Трудовой договор',
    render: (c, e) => `<h1>ТРУДОВОЙ ДОГОВОР № ${blank(null, 60)}</h1>
    <div class="meta"><span>г. ${blank(null, 120)}</span><span>${ruDate(e.hiredAt)}</span></div>
    <p>${employer(c)}, действующего на основании ${blank(null, 140)}, именуемое в дальнейшем «Работодатель», и ${esc(e.name)}, именуемый(ая) в дальнейшем «Работник», заключили настоящий договор о нижеследующем.</p>
    <ol>
      <li>Работник принимается на должность <b>${esc(e.position)}</b>. Место работы: ${blank(c.legalAddress, 260)}.</li>
      <li>Договор заключён на неопределённый срок. Дата начала работы: ${ruDate(e.hiredAt)}. Испытательный срок: ${blank(null, 60)} месяца(ев).</li>
      <li>Работнику устанавливается должностной оклад ${blank(null, 120)} рублей в месяц. Заработная плата выплачивается не реже чем каждые полмесяца: ${blank(null, 60)} и ${blank(null, 60)} числа.</li>
      <li>Режим работы: ${blank(null, 260)}. Ежегодный оплачиваемый отпуск — 28 календарных дней.</li>
      <li>Условия труда на рабочем месте: класс ${blank(null, 60)} по результатам специальной оценки условий труда.</li>
      <li>Работник подлежит обязательному социальному страхованию в соответствии с законодательством РФ.</li>
      <li>Работник обязуется добросовестно исполнять трудовые обязанности, соблюдать правила внутреннего трудового распорядка и требования охраны труда, бережно относиться к имуществу Работодателя.</li>
      <li>Работодатель обязуется предоставлять работу по обусловленной трудовой функции, обеспечивать безопасные условия труда, своевременно и в полном размере выплачивать заработную плату.</li>
      <li>Во всём, что не предусмотрено договором, стороны руководствуются Трудовым кодексом РФ. Договор составлен в двух экземплярах, по одному для каждой стороны.</li>
    </ol>${signatures(c, 'Работник', e)}
    <p style="margin-top:20px">Экземпляр договора получил(а): ____________ «___» ____________ 20__ г.</p>`,
  },
  'gph-contract': {
    title: 'Договор возмездного оказания услуг',
    render: (c, e) => `<h1>ДОГОВОР ВОЗМЕЗДНОГО ОКАЗАНИЯ УСЛУГ № ${blank(null, 60)}</h1>
    <div class="meta"><span>г. ${blank(null, 120)}</span><span>${ruDate(e.hiredAt)}</span></div>
    <p>${employer(c)}, именуемое в дальнейшем «Заказчик», и ${esc(e.name)}, именуемый(ая) в дальнейшем «Исполнитель», заключили настоящий договор о нижеследующем.</p>
    <ol>
      <li>Исполнитель обязуется по заданиям Заказчика оказывать услуги: ${blank(e.position === 'Курьер' ? 'доставка отправлений получателям' : e.position, 280)}, а Заказчик — принять и оплатить их.</li>
      <li>Задания передаются через мобильное приложение Заказчика. Исполнитель самостоятельно определяет порядок оказания услуг и не подчиняется правилам внутреннего трудового распорядка.</li>
      <li>Стоимость услуг определяется по факту: ${blank(null, 120)} рублей за одно вручённое отправление. Оплата производится на основании акта в течение ${blank(null, 40)} рабочих дней.</li>
      <li>Заказчик удерживает и перечисляет НДФЛ и страховые взносы в соответствии с законодательством РФ.</li>
      <li>Исполнитель несёт ответственность за сохранность переданных отправлений и денежных средств, полученных от получателей.</li>
      <li>Договор действует до ${blank(null, 140)} и может быть расторгнут любой стороной с уведомлением за 10 дней.</li>
    </ol>${signatures(c, 'Исполнитель', e)}`,
  },
  'self-employed-contract': {
    title: 'Договор с самозанятым',
    render: (c, e) => `<h1>ДОГОВОР ОКАЗАНИЯ УСЛУГ № ${blank(null, 60)}<br><small>(с плательщиком налога на профессиональный доход)</small></h1>
    <div class="meta"><span>г. ${blank(null, 120)}</span><span>${ruDate(e.hiredAt)}</span></div>
    <p>${employer(c)}, именуемое в дальнейшем «Заказчик», и ${esc(e.name)}, применяющий(ая) специальный налоговый режим «Налог на профессиональный доход», ИНН ${blank(null, 140)}, именуемый(ая) в дальнейшем «Исполнитель», заключили настоящий договор.</p>
    <ol>
      <li>Исполнитель оказывает услуги по доставке отправлений по заявкам, которые принимает в мобильном приложении Заказчика по своему усмотрению.</li>
      <li>Исполнитель самостоятельно определяет время и объём работы, использует собственные средства связи и транспорт.</li>
      <li>Вознаграждение: ${blank(null, 120)} рублей за одно вручённое отправление. Выплата — по итогам периода на банковский счёт Исполнителя.</li>
      <li>По каждой выплате Исполнитель формирует чек в приложении «Мой налог» и передаёт его Заказчику в течение 3 дней. Налоги Исполнитель уплачивает самостоятельно.</li>
      <li>Исполнитель обязан сообщить Заказчику об утрате статуса плательщика налога на профессиональный доход в течение 1 рабочего дня.</li>
      <li>Исполнитель отвечает за сохранность отправлений и денежных средств, полученных от получателей.</li>
    </ol>${signatures(c, 'Исполнитель', e)}`,
  },
  'order-t1': {
    title: 'Приказ о приёме на работу',
    render: (c, e) => `<p class="r">Унифицированная форма № Т-1</p>
    <p class="c"><b>${esc(c.legalName ?? c.name)}</b><br>ИНН ${blank(c.inn, 140)}</p>
    <h1>ПРИКАЗ № ${blank(null, 60)}<br>о приёме работника на работу</h1>
    <p class="c">от ${ruDate(e.hiredAt)}</p>
    <p>Принять на работу с ${ruDate(e.hiredAt)}:</p>
    <table><tr><th class="l">Фамилия, имя, отчество</th><td class="l">${esc(e.name)}</td></tr>
    <tr><th class="l">Табельный номер</th><td class="l">${blank(null, 80)}</td></tr>
    <tr><th class="l">Структурное подразделение</th><td class="l">${blank(null, 200)}</td></tr>
    <tr><th class="l">Должность</th><td class="l">${esc(e.position)}</td></tr>
    <tr><th class="l">Условия приёма, характер работы</th><td class="l">Основное место работы, полная занятость</td></tr>
    <tr><th class="l">Оклад</th><td class="l">${blank(null, 120)} руб.</td></tr>
    <tr><th class="l">Испытание</th><td class="l">${blank(null, 60)} месяца(ев)</td></tr>
    <tr><th class="l">Основание</th><td class="l">Трудовой договор от ${ruDate(e.hiredAt)} № ${blank(null, 60)}</td></tr></table>
    <div class="sign"><div>Руководитель организации<br><br>____________ / ${blank(c.director, 160)}</div>
    <div>С приказом ознакомлен(а)<br><br>____________ / ${esc(e.name)}<br>«___» ____________ 20__ г.</div></div>`,
  },
};

@Controller('hr')
@Roles('hr')
export class DocumentsController {
  constructor(@Inject(DB) private db: Db) {}

  @Get('document-types')
  types() {
    return Object.entries(DOCS).map(([id, d]) => ({ id, title: d.title }));
  }

  @Get('employees/:id/documents/:type')
  @Header('content-type', 'text/html; charset=utf-8')
  async document(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('type') type: string) {
    const doc = DOCS[type];
    if (!doc) throw new NotFoundException('Такого шаблона нет');
    const e = await this.db.query.employees.findFirst({ where: and(eq(employees.id, id), eq(employees.companyId, u.companyId)) });
    if (!e) throw new NotFoundException('Сотрудник не найден');
    const c = (await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) }))!;
    return page(`${doc.title} — ${e.name}`, doc.render(c, e));
  }

  /** Табель учёта рабочего времени (по образцу формы Т-13) за месяц. */
  @Get('timesheet/:month/t13')
  @Header('content-type', 'text/html; charset=utf-8')
  async t13(@CurrentUser() u: AuthUser, @Param('month') month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('Формат месяца: ГГГГ-ММ');
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const c = (await this.db.query.companies.findFirst({ where: eq(companies.id, u.companyId) }))!;
    const emps = await this.db.select().from(employees).where(eq(employees.companyId, u.companyId)).orderBy(asc(employees.name));
    const rows = await this.db.select().from(attendance)
      .where(and(eq(attendance.companyId, u.companyId), between(attendance.day, `${month}-01`, `${month}-${String(days).padStart(2, '0')}`)));

    const hours = new Map<string, number>();
    for (const r of rows) {
      if (!r.checkIn) continue;
      const end = r.checkOut ?? r.checkIn;
      hours.set(`${r.employeeId}|${Number(r.day.slice(8))}`, Math.max(0, Math.round((end.getTime() - r.checkIn.getTime()) / 36e5 * 10) / 10));
    }
    const head = Array.from({ length: days }, (_, i) => `<th>${i + 1}</th>`).join('');
    const body = emps.map((e, idx) => {
      let total = 0, worked = 0;
      const cells = Array.from({ length: days }, (_, i) => {
        const h = hours.get(`${e.id}|${i + 1}`);
        if (h === undefined) return '<td></td>';
        total += h; worked++;
        return `<td>Я<br>${h}</td>`;
      }).join('');
      return `<tr><td>${idx + 1}</td><td class="l">${esc(e.name)}<br><small>${esc(e.position)}</small></td>${cells}<td>${worked}</td><td>${Math.round(total * 10) / 10}</td></tr>`;
    }).join('');
    const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

    return page(`Табель ${month}`, `<p class="r">По форме № Т-13</p>
      <p class="c"><b>${esc(c.legalName ?? c.name)}</b></p>
      <h1>ТАБЕЛЬ УЧЁТА РАБОЧЕГО ВРЕМЕНИ</h1><p class="c">за ${monthName}</p>
      <div style="overflow-x:auto"><table><thead><tr><th>№</th><th class="l">Сотрудник, должность</th>${head}<th>Дней</th><th>Часов</th></tr></thead><tbody>${body}</tbody></table></div>
      <p class="note">«Я» — явка, под ней отработанные часы по отметкам прихода и ухода. Дни без отметок оставлены пустыми: проставьте коды неявок (В — выходной, ОТ — отпуск, Б — больничный) перед подписанием.</p>
      <div class="sign"><div>Ответственное лицо<br><br>____________ / ____________</div><div>Руководитель<br><br>____________ / ${blank(c.director, 160)}</div></div>`, true);
  }
}

@Module({ controllers: [DocumentsController] })
export class DocumentsModule {}
