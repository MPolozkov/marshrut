import { FormEvent, Fragment, useEffect, useState } from 'react';
import { adminAuth, api, auth } from '../api';

interface Stats { companies: number; users: number; couriers: number; shipments: number; shipments30d: number; activeCompanies30d: number; plans: Record<string, number>; newTickets: number }
interface Ticket {
  id: string; topic: string; subject: string; message: string; details: Record<string, any>; contactName: string; contactEmail: string;
  contactPhone: string | null; status: 'new' | 'in_progress' | 'done'; emailSent: boolean; createdAt: string; companyName: string | null;
}
const TOPIC: Record<string, string> = { integration: 'Подключение', problem: 'Проблема', plan: 'Тариф', other: 'Вопрос' };
const TSTATUS: Record<string, [string, string]> = { new: ['Новое', 's-way'], in_progress: ['В работе', 's-new'], done: ['Закрыто', 's-done'] };
interface Company {
  id: string; name: string; slug: string; city: string; phone: string | null; inn: string | null; plan: string; blocked: boolean;
  createdAt: string; trialEndsAt: string | null; paidUntil: string | null; users: number; couriers: number; shipments: number; shipments30d: number; lastShipmentAt: string | null; hasApiKey: boolean;
  modules: { warehouse: boolean; hr: boolean };
}
const PLAN: Record<string, string> = { start: 'Старт', business: 'Бизнес', white_label: 'Корпоративный' };
const d = (s: string | null) => s ? new Date(s).toLocaleDateString('ru-RU') : '—';

/** Панель владельца платформы (/platform): все компании, тарифы, блокировка, обращения в поддержку. */
interface Finance {
  feePercent: number; testPayments: boolean; testPayouts: boolean; deliveries: number; tips: number; platformRub: number; courierBalanceRub: number; paidOutRub: number;
  withCard: number; customers: number; awaiting: number; unpaid: number;
}
interface PCourier { id: string; name: string; phone: string; city: string; vehicle: string | null; inn: string | null; status: string; active: boolean; seStatus: string; lastSeenAt: string | null; createdAt: string; email: string | null; balanceRub: number; delivered: number; rating: number | null }
type VehicleId = 'foot' | 'bike' | 'car' | 'truck_m';
interface Rate { enabled: boolean; baseRub: number; perKmRub: number; perKgRub: number; freeKg: number }
const VEH: [VehicleId, string][] = [['foot', 'Пеший'], ['bike', 'Вело / самокат'], ['car', 'Легковой'], ['truck_m', 'Грузовой 3,5–5 т']];
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

export function Platform() {
  const [token, setToken] = useState(adminAuth.token);
  if (!token) return <AdminLogin onLogin={(t) => { adminAuth.set(t); setToken(t); }} />;
  return <AdminPanel onLogout={() => { adminAuth.clear(); setToken(null); }} />;
}

function AdminLogin({ onLogin }: { onLogin: (t: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    try { onLogin((await api<{ token: string }>('/platform/login', { body: { email, password }, admin: true })).token); }
    catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="wrap">
      <form className="panel login" onSubmit={submit}>
        <h2>Владелец платформы</h2>
        <p className="note" style={{ marginBottom: 12 }}>Вход по ADMIN_EMAIL и ADMIN_PASSWORD из файла .env на сервере.</p>
        <div className="form" style={{ gridTemplateColumns: '1fr' }}>
          <div className="f"><label htmlFor="ae">Email</label><input id="ae" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="f"><label htmlFor="ap">Пароль</label><input id="ap" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <div className="err">{err}</div>}
          <button className="btn primary">Войти</button>
        </div>
      </form>
    </div>
  );
}

function AdminPanel({ onLogout }: { onLogout: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [list, setList] = useState<Company[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'blocked' | 'idle'>('all');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [tab, setTab] = useState<'companies' | 'support' | 'money' | 'couriers' | 'tariffs'>('couriers');
  const [money, setMoney] = useState<Finance | null>(null);
  useEffect(() => { if (tab === 'money') api<Finance>('/platform/finance?days=30', { admin: true }).then(setMoney).catch(() => {}); }, [tab]);
  const [openT, setOpenT] = useState<string | null>(null);

  const load = () => Promise.all([
    api<Ticket[]>('/platform/support', { admin: true }).then(setTickets),
    api<Stats>('/platform/stats', { admin: true }).then(setStats),
    api<Company[]>('/platform/companies', { admin: true }).then(setList),
  ]).catch((e) => setMsg({ err: e.message }));
  useEffect(() => { load(); document.title = 'Платформа — Маршрут'; }, []);

  const patch = (c: Company, body: Partial<Company>, ok: string) => {
    setMsg({});
    api(`/platform/companies/${c.id}`, { method: 'PATCH', body, admin: true }).then(() => { setMsg({ ok }); load(); }).catch((e) => setMsg({ err: e.message }));
  };
  async function loginAs(c: Company) {
    try {
      const r = await api<{ token: string }>(`/platform/companies/${c.id}/login-as`, { method: 'POST', admin: true });
      auth.set(r.token);
      window.open('/admin', '_blank') ?? (location.href = '/admin');
    } catch (e: any) { setMsg({ err: e.message }); }
  }

  const n = q.trim().toLowerCase();
  const shown = list.filter((c) =>
    (!n || [c.name, c.city, c.inn, c.phone, c.slug].some((v) => v?.toLowerCase().includes(n))) &&
    (filter === 'all' || (filter === 'blocked' ? c.blocked : filter === 'active' ? !c.blocked && c.shipments30d > 0 : !c.blocked && c.shipments30d === 0)));

  return <>
    <header className="top admin-top">
      <div className="wrap bar">
        <div className="logo">М</div>
        <div><div className="brandname">Маршрут · платформа</div><div className="note">Панель администратора</div></div>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onLogout}>Выйти</button>
      </div>
    </header>
    <main className="wrap">
      {msg.ok && <div className="okmsg">{msg.ok}</div>}
      {msg.err && <div className="err">{msg.err}</div>}
      {stats && <div className="kpis">
        <div className="kpi"><b>{stats.companies}</b><span>компаний</span></div>
        <div className="kpi"><b>{stats.activeCompanies30d}</b><span>активны за 30 дней</span></div>
        <div className="kpi"><b>{stats.couriers}</b><span>курьеров</span></div>
        <div className="kpi"><b>{stats.shipments30d.toLocaleString('ru-RU')}</b><span>накладных за 30 дней</span></div>
        <div className="kpi"><b>{stats.shipments.toLocaleString('ru-RU')}</b><span>накладных всего</span></div>
      </div>}

      <nav className="tabs" style={{ marginBottom: -4 }}>
        <a href="#couriers" className={tab === 'couriers' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('couriers'); }}>Курьеры</a>
        <a href="#tariffs" className={tab === 'tariffs' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('tariffs'); }}>Тарифы доставки</a>
        <a href="#companies" className={tab === 'companies' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('companies'); }}>Организации</a>
        <a href="#support" className={tab === 'support' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('support'); }}>
          Обращения{stats?.newTickets ? <span className="badge">{stats.newTickets}</span> : null}</a>
        <a href="#money" className={tab === 'money' ? 'active' : ''} onClick={(e) => { e.preventDefault(); setTab('money'); }}>Финансы</a>
      </nav>
      {tab === 'couriers' && <CouriersTab />}
      {tab === 'tariffs' && <TariffsTab />}

      {tab === 'money' && <section className="panel">
        <h2>Деньги за 30 дней</h2>
        {money && <>
          <div className="kpis">
            <div className="kpi"><b>{rub(money.platformRub)}</b><span>доход платформы ({money.feePercent}% с доставленных)</span></div>
            <div className="kpi"><b>{rub(money.deliveries)}</b><span>оплачено заказов картами</span></div>
            <div className="kpi"><b>{rub(money.tips)}</b><span>чаевые курьерам</span></div>
            <div className="kpi"><b>{rub(money.paidOutRub)}</b><span>выплачено курьерам</span></div>
            <div className="kpi"><b>{rub(money.courierBalanceRub)}</b><span>на балансах курьеров сейчас</span></div>
            <div className="kpi"><b>{money.withCard} / {money.customers}</b><span>заказчиков с картой / всего</span></div>
            <div className="kpi"><b>{money.awaiting}</b><span>заказов ждут подтверждения банка</span></div>
            <div className="kpi"><b>{rub(money.unpaid)}</b><span>не списалось после вручения</span></div>
          </div>
          <p className="note">Из каждого оплаченного заказа платформе — {money.feePercent}%, курьеру — остальное (настройка PLATFORM_FEE_PERCENT). Комиссия эквайринга ЮKassa (~2–3%) — из доли платформы.{money.testPayments && ' Платежи в тестовом режиме.'}{money.testPayouts && ' Выплаты курьерам в тестовом режиме.'}</p>
        </>}
      </section>}

      {tab === 'support' && <section className="panel">
        <h2>Обращения в поддержку</h2>
        <p className="note">Все обращения сохраняются здесь, даже если почта не настроена. Письма уходят на SUPPORT_EMAIL из .env.</p>
        <div className="tbl"><table>
          <thead><tr><th>Дата</th><th>Тема</th><th>Компания</th><th>Контакт</th><th>Статус</th><th></th></tr></thead>
          <tbody>{tickets.map((t) => <Fragment key={t.id}>
            <tr>
              <td>{new Date(t.createdAt).toLocaleString('ru-RU')}</td>
              <td><b>{TOPIC[t.topic]}</b>: {t.subject}{!t.emailSent && <div className="note">письмо не отправлено</div>}</td>
              <td>{t.companyName ?? (t.details.companyName ? `${t.details.companyName} (не зарег.)` : 'не зарегистрирована')}</td>
              <td>{t.contactName}<div className="note mono">{t.contactEmail}{t.contactPhone && ` · ${t.contactPhone}`}</div></td>
              <td><select aria-label="Статус" value={t.status} style={{ width: 'auto' }}
                onChange={(e) => api(`/platform/support/${t.id}`, { method: 'PATCH', body: { status: e.target.value }, admin: true }).then(load)}>
                {Object.entries(TSTATUS).map(([k, [v]]) => <option key={k} value={k}>{v}</option>)}</select></td>
              <td><button className="btn sm" onClick={() => setOpenT(openT === t.id ? null : t.id)}>{openT === t.id ? 'Скрыть' : 'Подробнее'}</button></td>
            </tr>
            {openT === t.id && <tr><td colSpan={6}>
              <dl className="dl">
                {t.details.system && <><dt>Система</dt><dd>{t.details.system}{t.details.systemOther && ` — ${t.details.systemOther}`}</dd></>}
                {t.details.systemUrl && <><dt>Адрес</dt><dd className="mono">{t.details.systemUrl}</dd></>}
                {t.details.direction && <><dt>Что передавать</dt><dd>{t.details.direction}</dd></>}
                {t.details.ordersPerDay && <><dt>Заказов в день</dt><dd>{t.details.ordersPerDay}</dd></>}
                {t.details.access?.length > 0 && <><dt>Готовы предоставить</dt><dd>{t.details.access.join('; ')}</dd></>}
                {t.details.accessNotes && <><dt>О доступах</dt><dd>{t.details.accessNotes}</dd></>}
                {t.details.preferredTime && <><dt>Удобное время</dt><dd>{t.details.preferredTime}</dd></>}
                {t.details.plan && <><dt>Тариф</dt><dd>{t.details.plan}</dd></>}
              </dl>
              <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{t.message}</p>
              <p className="note">Ответить: <span className="mono">{t.contactEmail}</span></p>
            </td></tr>}
          </Fragment>)}</tbody>
        </table></div>
        {!tickets.length && <p className="note">Обращений пока нет.</p>}
      </section>}

      {tab === 'companies' && <section className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Организации-заказчики</h2>
          <div className="row">
            <input aria-label="Поиск" placeholder="Название, город, ИНН, телефон" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
            <select aria-label="Фильтр" value={filter} onChange={(e) => setFilter(e.target.value as any)} style={{ width: 'auto' }}>
              <option value="all">Все</option><option value="active">Работают</option><option value="idle">Нет накладных 30 дней</option><option value="blocked">Заблокированы</option>
            </select>
          </div>
        </div>
        <div className="tbl"><table>
          <thead><tr><th>Компания</th><th>Город</th><th>Регистрация</th><th>Сотр.</th><th>Доставки (30 дн.)</th><th>Последняя</th><th>Статус</th><th></th></tr></thead>
          <tbody>{shown.map((c) => <tr key={c.id}>
            <td><b>{c.name}</b><div className="note">{c.slug}{c.inn && ` · ИНН ${c.inn}`}{c.phone && ` · ${c.phone}`}</div>
              <div className="note">{[c.modules?.warehouse && 'склад', c.modules?.hr && 'кадры', c.hasApiKey && 'API'].filter(Boolean).join(', ')}</div></td>
            <td>{c.city || '—'}</td><td>{d(c.createdAt)}</td><td>{c.users}</td>
            <td>{c.shipments} ({c.shipments30d})</td><td>{d(c.lastShipmentAt)}</td>
            <td>{c.blocked ? <span className="pill s-fail">Заблокирована</span> : <span className="pill s-done">Работает</span>}</td>
            <td className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn sm" onClick={() => loginAs(c)}>Войти как владелец</button>
              <button className="btn sm" onClick={() => patch(c, { blocked: !c.blocked }, c.blocked ? `${c.name}: доступ восстановлен` : `${c.name}: доступ приостановлен`)}>{c.blocked ? 'Разблокировать' : 'Заблокировать'}</button>
            </td>
          </tr>)}</tbody>
        </table></div>
        {!shown.length && <p className="note">Компаний не найдено.</p>}
      </section>}
    </main>
  </>;
}

/** Курьеры-самозанятые: подтверждение заявок, статус «Мой налог», баланс. */
function CouriersTab() {
  const [list, setList] = useState<PCourier[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<PCourier[]>('/platform/couriers', { admin: true }).then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const set = (c: PCourier, status: string) => api(`/platform/couriers/${c.id}`, { method: 'PATCH', body: { status }, admin: true }).then(load).catch((e) => setErr(e.message));
  const SE: Record<string, string> = { none: 'не подключён', pending: 'ждёт разрешения', confirmed: 'подключён' };
  return <section className="panel">
    <h2>Курьеры-самозанятые</h2>
    <p className="note">Курьеры регистрируются в приложении сами (роль «Я курьер») с ИНН самозанятого. Проверьте ИНН на npd.nalog.ru и подтвердите заявку. Выплаты курьер выводит сам по СБП; чек в «Мой налог» формируется автоматически.</p>
    {err && <div className="err">{err}</div>}
    <div className="tbl"><table>
      <thead><tr><th>Курьер</th><th>Город, транспорт</th><th>ИНН, «Мой налог»</th><th>Доставок</th><th>Баланс</th><th>Статус</th><th /></tr></thead>
      <tbody>{list?.map((c) => <tr key={c.id}>
        <td><b>{c.name}</b><div className="note">{c.phone}{c.email && ` · ${c.email}`}</div></td>
        <td>{c.city}<div className="note">{VEH.find(([v]) => v === c.vehicle)?.[1] ?? '—'}{c.active && ' · на линии'}</div></td>
        <td className="mono">{c.inn ?? '—'}<div className="note">{SE[c.seStatus] ?? c.seStatus}</div></td>
        <td>{c.delivered}{c.rating && <div className="note">★ {c.rating}</div>}</td>
        <td>{rub(c.balanceRub)}</td>
        <td><span className={`pill ${c.status === 'approved' ? 's-done' : c.status === 'pending' ? 's-way' : 's-fail'}`}>{c.status === 'approved' ? 'Работает' : c.status === 'pending' ? 'Заявка' : 'Отклонён'}</span></td>
        <td className="row" style={{ flexWrap: 'nowrap' }}>
          {c.status !== 'approved' && <button className="btn sm primary" onClick={() => set(c, 'approved')}>Подтвердить</button>}
          {c.status !== 'rejected' && <button className="btn sm" onClick={() => set(c, 'rejected')}>{c.status === 'approved' ? 'Заблокировать' : 'Отклонить'}</button>}
        </td>
      </tr>)}</tbody>
    </table></div>
    {list && !list.length && <p className="note">Курьеров пока нет.</p>}
  </section>;
}

/** Тарифы доставки по городам: одна цена для всех заказчиков, вся она — вознаграждение курьера. */
function TariffsTab() {
  const [data, setData] = useState<{ defaults: Record<VehicleId, Rate>; sharePercent: number; cities: { city: string; rates: Record<VehicleId, Rate>; nightPercent: number }[] } | null>(null);
  const [edit, setEdit] = useState<{ city: string; rates: Record<VehicleId, Rate>; nightPercent: number } | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const load = () => api<typeof data>('/platform/tariffs', { admin: true }).then(setData).catch((e) => setMsg({ err: e.message }));
  useEffect(() => { load(); }, []);
  async function save(e: FormEvent) {
    e.preventDefault(); setMsg({});
    try { await api('/platform/tariffs', { body: edit, admin: true }); setMsg({ ok: `Тарифы «${edit!.city}» сохранены` }); setEdit(null); load(); } catch (er: any) { setMsg({ err: er.message }); }
  }
  if (!data) return <section className="panel"><p className="note">Загрузка…</p></section>;
  const setRate = (v: VehicleId, k: keyof Rate, val: number | boolean) => setEdit({ ...edit!, rates: { ...edit!.rates, [v]: { ...edit!.rates[v], [k]: val } } });
  return <section className="panel">
    <h2>Тарифы доставки</h2>
    <p className="note">Цена = подача + км × ставка + каждый кг сверх включённых; с 22:00 до 7:00 — ночная надбавка. Курьер получает {data.sharePercent}% цены (COURIER_SHARE_PERCENT). Город без своих тарифов считается по умолчанию: {VEH.map(([v, l]) => `${l} ${data.defaults[v].baseRub} ₽ + ${data.defaults[v].perKmRub} ₽/км`).join('; ')}.</p>
    {msg.ok && <div className="okmsg">{msg.ok}</div>}
    {msg.err && <div className="err">{msg.err}</div>}
    <div className="row" style={{ margin: '8px 0' }}>
      {data.cities.map((c) => <button key={c.city} className="btn sm" onClick={() => setEdit({ city: c.city, rates: { ...data.defaults, ...c.rates }, nightPercent: c.nightPercent })}>{c.city}</button>)}
      <button className="btn sm primary" onClick={() => setEdit({ city: '', rates: data.defaults, nightPercent: 20 })}>+ Город</button>
    </div>
    {edit && <form onSubmit={save}>
      <div className="form">
        <div className="f"><label htmlFor="tc">Город</label><input id="tc" required value={edit.city} onChange={(e) => setEdit({ ...edit, city: e.target.value })} /></div>
        <div className="f"><label htmlFor="tn">Ночная надбавка, %</label><input id="tn" type="number" min={0} max={200} value={edit.nightPercent} onChange={(e) => setEdit({ ...edit, nightPercent: Number(e.target.value) })} /></div>
      </div>
      <div className="tbl" style={{ marginTop: 8 }}><table>
        <thead><tr><th>Транспорт</th><th>Подача, ₽</th><th>За км, ₽</th><th>Включено кг</th><th>За кг сверх, ₽</th></tr></thead>
        <tbody>{VEH.map(([v, l]) => <tr key={v}>
          <td><label className="check" htmlFor={`te-${v}`}><input id={`te-${v}`} type="checkbox" checked={edit.rates[v].enabled} onChange={(e) => setRate(v, 'enabled', e.target.checked)} /><span>{l}</span></label></td>
          {(['baseRub', 'perKmRub', 'freeKg', 'perKgRub'] as const).map((k) => <td key={k}><input aria-label={`${l}: ${k}`} type="number" min={0} step={0.5} style={{ width: 90 }} value={edit.rates[v][k]} onChange={(e) => setRate(v, k, Number(e.target.value))} /></td>)}
        </tr>)}</tbody>
      </table></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary">Сохранить</button>
        <button type="button" className="btn" onClick={() => setEdit(null)}>Отмена</button>
        {data.cities.some((c) => c.city === edit.city) && <button type="button" className="btn" onClick={() => api('/platform/tariffs/delete', { body: { city: edit.city }, admin: true }).then(() => { setEdit(null); load(); })}>Удалить город (будут тарифы по умолчанию)</button>}
      </div>
    </form>}
  </section>;
}
