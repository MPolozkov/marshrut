import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, rub, usePolling } from '../api';
import { CityInput } from '../components';
import { IdeaBox } from '../components/IdeaBox';

/*
 * Приложение заказчика. Общее — /order (заявку получают все подходящие службы и предлагают цены),
 * и по ссылке конкретной службы — /c/<адрес-компании> (цену предлагает только она).
 * Вход по SMS → анкета → калькулятор → предложения служб → курьер → оценка и чаевые.
 */

type VehicleId = 'foot' | 'bike' | 'car' | 'truck_m';
interface Vehicle { id: VehicleId; label: string; short: string; maxKg: number; maxCm: [number, number, number] }
interface Config { vehicles: Vehicle[]; requestTtlHours: number; testPayments: boolean; debtLimitRub: number }
interface Brand { name: string; slug?: string; city: string; phone: string | null; brandColor: string; logoUrl: string | null; cities?: string[]; vehicles?: VehicleId[] }
interface Requisites { companyName: string; inn: string; kpp?: string; ogrn?: string; legalAddress: string; bank?: string; bik?: string; account?: string; corrAccount?: string; director?: string; docsEmail?: string }
interface Me {
  id: string; phone: string; lastName: string; firstName: string; middleName: string; name: string; email: string | null;
  kind: 'person' | 'company'; selfEmployed: boolean; inn: string | null; requisites: Requisites | null; registeredAt: string | null;
  hasCard: boolean; cardLast4: string | null; cardBrand: string | null; debtRub: number; blocked: boolean;
}
interface OrderRow { id: string; trackingNumber: string; status: string; address: string; pickupAddress: string | null; recipientName: string; priceRub: number; createdAt: string; pickedUpAt: string | null; rating: number | null; company: string; payStatus: string }
interface Order extends OrderRow {
  payStatus: string;
  city: string; recipientPhone: string | null; comment: string | null; payText: string; vehicle: string | null;
  deliveredAt: string | null; failReason: string | null; ratingComment: string | null; tipRub: number; confirmCode: string | null; waitingCourier: boolean;
  company: any; courier: { name: string; phone: string | null; vehicle: string | null; rating: number | null; ratingCount: number; location: { lat: number; lng: number; at: string } | null } | null;
  events: { status: string; note: string | null; at: string }[];
}
type Call = <T = any>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
interface Ctx { base: string; slug?: string; brand: Brand; config: Config; me: Me; call: Call; setMe: (m: Me) => void }

const TOKEN = 'marshrut-client';
const store = {
  get: () => { try { return localStorage.getItem(TOKEN); } catch { return null; } },
  set: (t: string | null) => { try { t ? localStorage.setItem(TOKEN, t) : localStorage.removeItem(TOKEN); } catch { /* приватный режим */ } },
};
/**
 * Оплата через страницу банка (3-D Secure): запоминаем, что проверить после возврата, и уходим на страницу банка.
 * Банк вернёт на /pay/done, оттуда — обратно в приложение, где проверка выполнится сама.
 */
const PENDING = 'marshrut-pending-pay';
type Pending = { check: string; paymentId?: string; body?: unknown; back: string };
export const pendingPay = {
  get(): Pending | null { try { return JSON.parse(localStorage.getItem(PENDING) ?? 'null'); } catch { return null; } },
  set(p: Pending) { try { localStorage.setItem(PENDING, JSON.stringify(p)); } catch { /* приватный режим */ } },
  clear() { try { localStorage.removeItem(PENDING); } catch { /* приватный режим */ } },
};
function goToBank(url: string, p: Pending) { pendingPay.set(p); location.href = url; }

const PLATFORM: Brand = { name: 'Маршрут — доставка', city: '', phone: null, brandColor: '#0e7c66', logoUrl: null };

function stage(o: { status: string; pickedUpAt: string | null; waitingCourier?: boolean }): [string, string] {
  if (o.status === 'delivered') return ['Доставлено', 's-done'];
  if (o.status === 'failed') return ['Не удалось доставить', 's-fail'];
  if (o.status === 'returned') return ['Отменён', 's-fail'];
  if (o.status === 'assigned') return o.pickedUpAt ? ['Едет к получателю', 's-way'] : ['Курьер едет за грузом', 's-way'];
  return ['Ищем курьера', 's-new'];
}

export function ClientApp() {
  const { slug } = useParams();
  const base = slug ? `/c/${slug}` : '/order';
  const [brand, setBrand] = useState<Brand | null>(slug ? null : PLATFORM);
  const [config, setConfig] = useState<Config | null>(null);
  const [token, setTokenState] = useState<string | null>(store.get);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState('');
  const setToken = (t: string | null) => { store.set(t); setTokenState(t); if (!t) setMe(null); };

  useEffect(() => {
    api<Config>('/client/config').then(setConfig).catch((e) => setErr(e.message));
    if (slug) api<Brand>(`/client/company/${slug}`).then(setBrand).catch((e) => setErr(e.message));
  }, [slug]);
  useEffect(() => {
    if (!brand) return;
    document.title = brand.name;
    document.documentElement.style.setProperty('--brand', brand.brandColor);
  }, [brand]);

  const call = useCallback((path: string, opts: { method?: string; body?: unknown } = {}) =>
    api(path, { ...opts, token }).catch((e) => { if (e.status === 401) setToken(null); throw e; }), [token]) as Call;

  useEffect(() => { if (token) call<Me>('/client/me').then(setMe).catch(() => {}); }, [token, call]);
  // Вернулись со страницы банка — проверяем платёж.
  const [payMsg, setPayMsg] = useState('');
  const nav = useNavigate();
  useEffect(() => {
    const p = pendingPay.get();
    if (!token || !p || !p.check.startsWith('/client')) return;
    pendingPay.clear();
    call<any>(p.check, { body: p.body ?? (p.paymentId ? { paymentId: p.paymentId } : {}) }).then((r) => {
      if (r.me) setMe(r.me);
      if (r.shipmentId) nav(`${base}/o/${r.shipmentId}`);
      setPayMsg(r.status === 'pending' ? 'Банк ещё не подтвердил платёж. Обновите страницу через минуту.' : '');
    }).catch((e) => setPayMsg(e.message));
  }, [token]);

  if (err) return <div className="wrap capp"><div className="err">{err}</div></div>;
  if (!brand || !config) return <div className="wrap capp"><p className="note">Загрузка…</p></div>;

  return (
    <div className="capp">
      <header className="top"><div className="wrap bar">
        {brand.logoUrl ? <img src={brand.logoUrl} alt="" className="logo" /> : <div className="logo">{brand.name[0]?.toUpperCase()}</div>}
        <Link to={base} className="brandname" style={{ color: 'inherit', textDecoration: 'none' }}>{brand.name}</Link>
        {token && me?.registeredAt && <Link className="btn sm" style={{ marginLeft: 'auto' }} to={`${base}/profile`}>Профиль</Link>}
        {token && <button className="btn sm" style={{ marginLeft: me?.registeredAt ? 0 : 'auto' }} onClick={() => setToken(null)}>Выйти</button>}
      </div></header>
      <main className="wrap">
        {payMsg && <div className="err">{payMsg}</div>}
        {!token ? <ClientLogin brand={brand} onToken={setToken} />
          : !me ? <p className="note">Загрузка…</p>
          : !me.registeredAt ? <Profile ctx={{ base, slug, brand, config, me, call, setMe }} first />
          : !me.hasCard ? <CardStep ctx={{ base, slug, brand, config, me, call, setMe }} />
          : (
            <Routes>
              <Route index element={<Home ctx={{ base, slug, brand, config, me, call, setMe }} />} />
              <Route path="new" element={<NewOrder ctx={{ base, slug, brand, config, me, call, setMe }} />} />
              <Route path="o/:id" element={<OrderView ctx={{ base, slug, brand, config, me, call, setMe }} />} />
              <Route path="profile" element={<Profile ctx={{ base, slug, brand, config, me, call, setMe }} />} />
            </Routes>
          )}
        <p className="note" style={{ textAlign: 'center' }}>{brand.phone && <>Диспетчер: <a href={`tel:${brand.phone}`}>{brand.phone}</a> · </>}<Link to="/privacy">Политика данных</Link></p>
      </main>
    </div>
  );
}

function ClientLogin({ brand, onToken }: { brand: Brand; onToken: (t: string) => void }) {
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [dev, setDev] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api<{ devCode?: string }>('/client/auth/code', { body: { phone } }); setDev(r.devCode ?? null); setStep('code'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function verify(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api<{ token: string }>('/client/auth/verify', { body: { phone, code } }); onToken(r.token); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <section className="panel" style={{ maxWidth: 440, margin: '24px auto' }}>
      <h2>Заказать доставку</h2>
      <p className="note" style={{ marginBottom: 12 }}>
        {brand.slug ? `${brand.name} заберёт груз и привезёт получателю.` : 'Сумма сразу, курьер рядом выезжает после оформления, оплата картой — получатель ничего не платит.'} Вход по номеру телефона, без пароля.
      </p>
      {step === 'phone' ? <form className="form" style={{ gridTemplateColumns: '1fr' }} onSubmit={send}>
        <div className="f"><label htmlFor="cph">Телефон</label><input id="cph" type="tel" required autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy}>Получить код по SMS</button>
      </form> : <form className="form" style={{ gridTemplateColumns: '1fr' }} onSubmit={verify}>
        <p className="note">Код отправлен на {phone}. <button type="button" className="btn sm" onClick={() => setStep('phone')}>Изменить номер</button></p>
        {dev && <p className="okmsg">Режим проверки (SMS не подключены): код {dev}</p>}
        <div className="f"><label htmlFor="ccode">Код из SMS</label><input id="ccode" inputMode="numeric" autoComplete="one-time-code" maxLength={4} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></div>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy || code.length !== 4}>Войти</button>
      </form>}
    </section>
  );
}

/* ---------- Анкета заказчика ---------- */

const EMPTY_REQ: Requisites = { companyName: '', inn: '', kpp: '', ogrn: '', legalAddress: '', bank: '', bik: '', account: '', corrAccount: '', director: '', docsEmail: '' };

function Profile({ ctx, first }: { ctx: Ctx; first?: boolean }) {
  const { me, call, setMe, base } = ctx;
  const nav = useNavigate();
  const [f, setF] = useState({
    lastName: me.lastName, firstName: me.firstName, middleName: me.middleName, email: me.email ?? '', kind: me.kind,
    selfEmployed: me.selfEmployed, inn: me.kind === 'person' ? me.inn ?? '' : '',
  });
  const [req, setReq] = useState<Requisites>({ ...EMPTY_REQ, ...(me.requisites ?? {}) });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const r = (k: keyof Requisites) => ({ value: req[k] ?? '', onChange: (e: { target: { value: string } }) => setReq({ ...req, [k]: e.target.value }) });

  async function save(e: FormEvent) {
    e.preventDefault(); setErr(''); setOk(''); setBusy(true);
    try {
      const saved = await call<Me>('/client/me', { method: 'PUT', body: { ...f, requisites: f.kind === 'company' ? req : undefined, inn: f.selfEmployed ? f.inn : undefined } });
      setMe(saved); setOk('Сохранено');
      if (first) nav(base);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <form className="panel" onSubmit={save}>
      <h2>{first ? 'Регистрация заказчика' : 'Профиль'}</h2>
      {first && <p className="note">Заполните один раз — данные подставятся в заказы и закрывающие документы. Следующий шаг — привязка карты: оплата доставки только картой.</p>}
      <div className="form">
        <div className="f"><label htmlFor="p-l">Фамилия</label><input id="p-l" required autoComplete="family-name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></div>
        <div className="f"><label htmlFor="p-f">Имя</label><input id="p-f" required autoComplete="given-name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></div>
        <div className="f"><label htmlFor="p-m">Отчество (если есть)</label><input id="p-m" autoComplete="additional-name" value={f.middleName} onChange={(e) => setF({ ...f, middleName: e.target.value })} /></div>
        <div className="f"><label htmlFor="p-e">Email (необязательно)</label><input id="p-e" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      </div>

      <h3 className="h3">Кто вы</h3>
      <div className="row">
        <label className="check" htmlFor="k-p"><input id="k-p" type="radio" checked={f.kind === 'person'} onChange={() => setF({ ...f, kind: 'person' })} /><span>Физическое лицо</span></label>
        <label className="check" htmlFor="k-c"><input id="k-c" type="radio" checked={f.kind === 'company'} onChange={() => setF({ ...f, kind: 'company' })} /><span>Компания или ИП</span></label>
      </div>

      {f.kind === 'person' ? <>
        <label className="check" htmlFor="p-se" style={{ marginTop: 10 }}><input id="p-se" type="checkbox" checked={f.selfEmployed} onChange={(e) => setF({ ...f, selfEmployed: e.target.checked })} /><span>Я самозанятый — нужны документы на доставку для учёта</span></label>
        {f.selfEmployed && <div className="form" style={{ marginTop: 8 }}><div className="f"><label htmlFor="p-inn">ИНН (12 цифр)</label><input id="p-inn" inputMode="numeric" maxLength={12} required value={f.inn} onChange={(e) => setF({ ...f, inn: e.target.value.replace(/\D/g, '') })} /></div></div>}
      </> : <>
        <p className="note">Реквизиты нужны для закрывающих документов (акт или УПД). Оплата — корпоративной или личной картой.</p>
        <div className="form">
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="r-n">Название организации или ИП</label><input id="r-n" required placeholder="ООО «Ромашка»" {...r('companyName')} /></div>
          <div className="f"><label htmlFor="r-inn">ИНН</label><input id="r-inn" required inputMode="numeric" maxLength={12} {...r('inn')} /></div>
          <div className="f"><label htmlFor="r-kpp">КПП (для ООО)</label><input id="r-kpp" inputMode="numeric" maxLength={9} {...r('kpp')} /></div>
          <div className="f"><label htmlFor="r-ogrn">ОГРН / ОГРНИП</label><input id="r-ogrn" inputMode="numeric" maxLength={15} {...r('ogrn')} /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="r-a">Юридический адрес</label><input id="r-a" required {...r('legalAddress')} /></div>
          <div className="f"><label htmlFor="r-b">Банк</label><input id="r-b" {...r('bank')} /></div>
          <div className="f"><label htmlFor="r-bik">БИК</label><input id="r-bik" inputMode="numeric" maxLength={9} {...r('bik')} /></div>
          <div className="f"><label htmlFor="r-acc">Расчётный счёт</label><input id="r-acc" inputMode="numeric" maxLength={20} {...r('account')} /></div>
          <div className="f"><label htmlFor="r-ca">Корр. счёт</label><input id="r-ca" inputMode="numeric" maxLength={20} {...r('corrAccount')} /></div>
          <div className="f"><label htmlFor="r-d">Руководитель (ФИО)</label><input id="r-d" {...r('director')} /></div>
          <div className="f"><label htmlFor="r-de">Email для счетов и актов</label><input id="r-de" type="email" {...r('docsEmail')} /></div>
        </div>
      </>}

      {!first && <CardBox ctx={ctx} />}
      {err && <div className="err">{err}</div>}
      {ok && <div className="okmsg">{ok}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy}>{first ? 'Продолжить' : 'Сохранить'}</button>
        {!first && <Link to={base} className="btn">Назад</Link>}
      </div>
    </form>
  );
}

/* ---------- Карта и долг ---------- */

type PayStart = { status: string; paymentId: string; confirmationUrl: string | null; me: Me };

function useCard(ctx: Ctx) {
  const { call, setMe, base } = ctx;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function bind() {
    setBusy(true); setErr('');
    try {
      const r = await call<PayStart>('/client/card', { method: 'POST' });
      if (r.confirmationUrl) return goToBank(r.confirmationUrl, { check: '/client/card/check', paymentId: r.paymentId, back: base });
      setMe(r.me);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function unlink() {
    setBusy(true); setErr('');
    try { setMe(await call<Me>('/client/card', { method: 'DELETE' })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return { bind, unlink, busy, err };
}

/** Шаг регистрации: проверка карты. 1 ₽ резервируется и сразу возвращается. */
function CardStep({ ctx }: { ctx: Ctx }) {
  const { bind, busy, err } = useCard(ctx);
  return <section className="panel" style={{ maxWidth: 520, margin: '24px auto' }}>
    <h2>Привяжите карту</h2>
    <p>Доставка оплачивается только картой. Для проверки банк зарезервирует 1 ₽ и сразу вернёт его.</p>
    <ul className="note">
      <li>При выборе службы сумма заказа резервируется на карте.</li>
      <li>После вручения резерв списывается. Отменили заказ — резерв снимается, деньги возвращаются на эту же карту.</li>
      <li>Если списать оплату не получится, новые заказы будут недоступны, пока долг не погашен.</li>
    </ul>
    {ctx.config.testPayments && <p className="okmsg">Тестовый режим: деньги не списываются, карта •••• 4242 привяжется сразу.</p>}
    {err && <div className="err">{err}</div>}
    <button className="btn primary big" disabled={busy} onClick={bind}>{busy ? 'Открываем банк…' : 'Привязать карту'}</button>
  </section>;
}

function CardBox({ ctx }: { ctx: Ctx }) {
  const { bind, unlink, busy, err } = useCard(ctx);
  const { me } = ctx;
  return <>
    <h3 className="h3">Карта для оплаты</h3>
    {me.hasCard ? <p>{me.cardBrand ?? 'Карта'} •••• {me.cardLast4} <button type="button" className="btn sm" disabled={busy} onClick={bind}>Заменить</button> <button type="button" className="btn sm" disabled={busy} onClick={unlink}>Отвязать</button></p>
      : <button type="button" className="btn" disabled={busy} onClick={bind}>Привязать карту</button>}
    {err && <div className="err">{err}</div>}
  </>;
}

/** Не прошла оплата прошлой доставки — новые заказы недоступны, пока долг не погашен. */
function DebtBanner({ ctx, onPaid }: { ctx: Ctx; onPaid?: () => void }) {
  const { me, call, setMe, base } = ctx;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!me.debtRub) return null;
  async function pay() {
    setBusy(true); setErr('');
    try {
      const r = await call<PayStart>('/client/debt/pay', { method: 'POST' });
      if (r.confirmationUrl) return goToBank(r.confirmationUrl, { check: '/client/debt/check', paymentId: r.paymentId, back: base });
      setMe(r.me); onPaid?.();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <section className="panel" style={{ borderColor: 'var(--bad)' }}>
    <h2 style={{ color: 'var(--bad)' }}>Оплата не прошла: {rub(me.debtRub)}</h2>
    <p>Не удалось списать оплату за доставку с карты •••• {me.cardLast4}. Новые заказы недоступны, пока долг не погашен. Пополните карту или привяжите другую в профиле.</p>
    {err && <div className="err">{err}</div>}
    <button className="btn primary" disabled={busy} onClick={pay}>{busy ? 'Списываем…' : `Оплатить ${rub(me.debtRub)}`}</button>
  </section>;
}

/* ---------- Главная: заявки и заказы ---------- */

function Home({ ctx }: { ctx: Ctx }) {
  const { call, base, brand, me } = ctx;
  const [data, setData] = useState<{ orders: OrderRow[]; debtRub: number } | null>(null);
  const load = useCallback(() => call<{ orders: OrderRow[]; debtRub: number }>('/client/orders').then((d) => {
    setData(d);
    if (d.debtRub !== ctx.me.debtRub) call<Me>('/client/me').then(ctx.setMe).catch(() => {});
  }).catch(() => {}), [call]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 15_000, [load]);
  const active = data?.orders.filter((o) => ['created', 'at_warehouse', 'assigned'].includes(o.status)) ?? [];
  const past = data?.orders.filter((o) => !active.includes(o)) ?? [];
  const row = (o: OrderRow) => { const [l, c] = stage(o); return (
    <Link key={o.id} to={`${base}/o/${o.id}`} className="panel corder">
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="mono note">{o.trackingNumber} · {o.company}</span><span className={`pill ${c}`}>{l}</span></div>
      <div className="note">{o.pickupAddress ?? '—'} →</div><b>{o.address}</b>
      <div className="note">{o.recipientName} · {rub(o.priceRub)}{o.payStatus === 'failed' && ' · оплата не прошла'}{o.status === 'delivered' && !o.rating && o.payStatus !== 'failed' && ' · оцените курьера'}</div>
    </Link>); };
  return <>
    <p style={{ margin: '4px 0 12px' }}>Здравствуйте, {me.firstName}!</p>
    <DebtBanner ctx={ctx} onPaid={load} />
    {!me.blocked && <Link to={`${base}/new`} className="btn primary big">Рассчитать и заказать доставку</Link>}
    {data === null && <p className="note">Загрузка…</p>}
    {active.length > 0 && <><h3 className="h3">В работе</h3>{active.map(row)}</>}
    {past.length > 0 && <><h3 className="h3">История</h3>{past.map(row)}</>}
    {data && !data.orders.length && <p className="note" style={{ textAlign: 'center' }}>Здесь появятся ваши доставки{brand.city && ` по городу ${brand.city}`}.</p>}
    <IdeaBox source="client_app" title="Что улучшить в приложении?" name={me.name} email={me.email ?? ''} />
  </>;
}

/* ---------- Калькулятор и оформление ---------- */

const PRESETS: { id: string; label: string; w: number; l: number; wd: number; h: number }[] = [
  { id: 'docs', label: 'Документы', w: 0.5, l: 35, wd: 25, h: 2 },
  { id: 'box', label: 'Коробка до 5 кг', w: 5, l: 40, wd: 30, h: 25 },
  { id: 'big', label: 'Крупная до 15 кг', w: 15, l: 50, wd: 40, h: 40 },
  { id: 'furn', label: 'Мебель, техника', w: 80, l: 150, wd: 80, h: 80 },
  { id: 'pallet', label: 'Паллета', w: 500, l: 120, wd: 80, h: 150 },
];
interface Calc { distanceKm: number | null; distanceApprox: boolean; night: boolean; recommended: VehicleId | null; vehicle: VehicleId | null; vehicles: { id: VehicleId; label: string; problem: string | null; priceRub: number | null }[]; priceRub: number | null; courierRub: number | null; feePercent: number }

function NewOrder({ ctx }: { ctx: Ctx }) {
  const { call, base, slug, brand, config, me } = ctx;
  const nav = useNavigate();
  const [city, setCity] = useState(brand.city || '');
  const [fromAddress, setFromAddress] = useState('');
  const [to, setTo] = useState({ street: '', house: '', apartment: '', entrance: '', floor: '', intercom: '' });
  const [privateHouse, setPrivateHouse] = useState(false);
  const toAddress = [to.street.trim(), to.house.trim()].filter(Boolean).join(', ');
  /** «улица Ленина, 12» → улица и дом отдельно. */
  const setToAddress = (a: string) => { const i = a.lastIndexOf(','); setTo((t) => ({ ...t, street: i > 0 ? a.slice(0, i).trim() : a, house: i > 0 ? a.slice(i + 1).trim() : t.house })); };
  const [toPoint, setToPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [gps, setGps] = useState('');
  const [cargo, setCargo] = useState({ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 });
  const [vehicle, setVehicle] = useState<VehicleId | null>(null);
  const [calc, setCalc] = useState<Calc | null>(null);
  const [o, setO] = useState({ description: '', recipientName: '', recipientPhone: '+7', fromName: '', fromPhone: '', comment: '' });
  const [otherSender, setOtherSender] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  /** Куда доставить — по GPS заказчика; адрес можно поправить. */
  const locate = useCallback(() => {
    if (!navigator.geolocation) { setGps('Браузер не даёт геопозицию. Введите адрес вручную.'); return; }
    setGps('Определяем адрес…');
    navigator.geolocation.getCurrentPosition(async (p) => {
      const point = { lat: p.coords.latitude, lng: p.coords.longitude };
      try {
        const r = await call<{ address: string; city: string }>(`/client/reverse?lat=${point.lat}&lng=${point.lng}`);
        setToPoint(point);
        if (r.address) { setToAddress(r.address); setGps('Адрес определён по GPS — проверьте и при необходимости исправьте.'); }
        else setGps('Местоположение получено. Уточните улицу и дом вручную.');
        if (r.city) setCity((c) => c || r.city);
      } catch { setGps('Не удалось определить адрес. Введите его вручную.'); }
    }, () => setGps('Нет доступа к геопозиции. Введите адрес вручную.'), { enableHighAccuracy: true, timeout: 10_000 });
  }, [call]);
  const asked = useRef(false);
  useEffect(() => { if (!asked.current) { asked.current = true; locate(); } }, [locate]);

  const payload = useMemo(() => ({
    city: city.trim(), fromAddress: fromAddress.trim() || undefined, toAddress: toAddress.trim() || undefined,
    toLat: toPoint?.lat, toLng: toPoint?.lng, ...cargo, vehicle: vehicle ?? undefined, slug,
  }), [city, fromAddress, toAddress, toPoint, cargo, vehicle, slug]);

  useEffect(() => {
    if (payload.city.length < 2 || !(cargo.weightKg > 0)) { setCalc(null); return; }
    const t = setTimeout(() => {
      call<Calc>('/client/calc', { body: payload }).then((c) => { setCalc(c); setErr(''); if (!vehicle || c.vehicle !== vehicle) setVehicle(c.vehicle); }).catch((e) => setErr(e.message));
    }, 500);
    return () => clearTimeout(t);
  }, [payload]);

  const num = (k: keyof typeof cargo, int = true) => ({
    value: cargo[k] || '', type: 'number', min: 0, step: int ? 1 : 0.1,
    onChange: (e: { target: { value: string } }) => setCargo({ ...cargo, [k]: int ? Math.round(Number(e.target.value)) : Number(e.target.value) }),
  });

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (!vehicle) { setErr('Выберите транспорт'); return; }
    setBusy(true);
    try {
      const r = await call<{ id: string; status: string; confirmationUrl: string | null }>('/client/orders', { body: {
        ...payload, toAddress: undefined, fromAddress: fromAddress.trim(), vehicle,
        toStreet: to.street, toHouse: to.house, toApartment: privateHouse ? 'частный дом' : to.apartment,
        toEntrance: to.entrance || undefined, toFloor: to.floor || undefined, toIntercom: to.intercom || undefined,
        recipientName: o.recipientName, recipientPhone: o.recipientPhone, description: o.description || undefined, comment: o.comment || undefined,
        fromName: otherSender ? o.fromName || undefined : undefined, fromPhone: otherSender ? o.fromPhone || undefined : undefined,
      } });
      if (r.confirmationUrl) return goToBank(r.confirmationUrl, { check: `/client/orders/${r.id}/pay-check`, back: `${base}/o/${r.id}` });
      nav(`${base}/o/${r.id}`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (me.blocked) return <DebtBanner ctx={ctx} onPaid={() => nav(`${base}/new`)} />;
  const cityOk = !brand.cities?.length || brand.cities.some((x) => x.toLowerCase() === city.trim().toLowerCase());

  return (
    <form onSubmit={submit}>
      <section className="panel">
        <h2>Откуда и куда</h2>
        <div className="form">
          <div className="f"><label htmlFor="o-c">Город</label><CityInput id="o-c" required value={city} onChange={setCity} /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="o-fa">Откуда забрать — улица, дом, подъезд</label><input id="o-fa" required value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="o-ta">Куда: улица</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}><input id="o-ta" required value={to.street} onChange={(e) => { setTo({ ...to, street: e.target.value }); setToPoint(null); }} />
              <button type="button" className="btn" onClick={locate} title="Определить по GPS">GPS</button></div></div>
          <div className="f"><label htmlFor="o-th">Дом</label><input id="o-th" required value={to.house} onChange={(e) => { setTo({ ...to, house: e.target.value }); setToPoint(null); }} /></div>
          <div className="f"><label htmlFor="o-tap">Квартира / офис</label><input id="o-tap" required={!privateHouse} disabled={privateHouse} value={privateHouse ? 'частный дом' : to.apartment} onChange={(e) => setTo({ ...to, apartment: e.target.value })} />
            <label className="check" htmlFor="o-ph"><input id="o-ph" type="checkbox" checked={privateHouse} onChange={(e) => setPrivateHouse(e.target.checked)} /><span>частный дом</span></label></div>
          <div className="f"><label htmlFor="o-te">Подъезд</label><input id="o-te" value={to.entrance} onChange={(e) => setTo({ ...to, entrance: e.target.value })} /></div>
          <div className="f"><label htmlFor="o-tf">Этаж</label><input id="o-tf" value={to.floor} onChange={(e) => setTo({ ...to, floor: e.target.value })} /></div>
          <div className="f"><label htmlFor="o-ti">Домофон</label><input id="o-ti" value={to.intercom} onChange={(e) => setTo({ ...to, intercom: e.target.value })} /></div>
        </div>
        {gps && <p className="note">{gps}</p>}
        {brand.slug && city && !cityOk && <p className="err">{brand.name} работает в городах: {brand.cities!.join(', ')}</p>}
      </section>

      <section className="panel">
        <h2>Что везём</h2>
        <div className="row">{PRESETS.map((p) => <button key={p.id} type="button" className="btn sm" onClick={() => setCargo({ weightKg: p.w, lengthCm: p.l, widthCm: p.wd, heightCm: p.h })}>{p.label}</button>)}</div>
        <div className="form" style={{ marginTop: 12 }}>
          <div className="f"><label htmlFor="g-w">Вес, кг</label><input id="g-w" required {...num('weightKg', false)} /></div>
          <div className="f"><label htmlFor="g-l">Длина, см</label><input id="g-l" required {...num('lengthCm')} /></div>
          <div className="f"><label htmlFor="g-wd">Ширина, см</label><input id="g-wd" required {...num('widthCm')} /></div>
          <div className="f"><label htmlFor="g-h">Высота, см</label><input id="g-h" required {...num('heightCm')} /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="g-d">Описание груза</label><input id="g-d" value={o.description} onChange={(e) => setO({ ...o, description: e.target.value })} placeholder="Например: 3 коробки с посудой, хрупкое" /></div>
        </div>
      </section>

      <section className="panel">
        <h2>Кто повезёт</h2>
        <div className="vehicles">{(calc?.vehicles ?? config.vehicles.map((v) => ({ id: v.id, label: v.label, problem: null }))).map((v) => {
          const spec = config.vehicles.find((x) => x.id === v.id)!;
          const notHere = brand.vehicles ? !brand.vehicles.includes(v.id) : false;
          return <button key={v.id} type="button" className={`veh ${vehicle === v.id ? 'on' : ''}`} disabled={!!v.problem || notHere} aria-pressed={vehicle === v.id} onClick={() => setVehicle(v.id)}>
            <b>{v.label}</b>
            <span className="note">до {spec.maxKg.toLocaleString('ru-RU')} кг, {spec.maxCm.join('×')} см</span>
            {v.problem ? <span className="note bad">не подходит: {v.problem}</span> : notHere ? <span className="note">недоступно</span>
              : <span className="note okc">{'priceRub' in v && v.priceRub != null ? rub(v.priceRub as number) : ''}{calc?.recommended === v.id ? ' · оптимально' : ''}</span>}
          </button>;
        })}</div>
        {calc && <div className="estimate">
          {calc.distanceKm != null && <span>{calc.distanceApprox ? '≈ ' : ''}{calc.distanceKm} км</span>}
          <b>{calc.priceRub != null ? rub(calc.priceRub) : 'укажите точные адреса'}</b>
          {calc.night && <span className="note">ночной тариф</span>}
        </div>}
        <p className="note">Сумма = подача + километры + вес{calc?.night ? ' + ночная надбавка' : ''}. Резервируется на карте при оформлении, списывается после вручения. Получатель ничего не платит.{calc?.distanceApprox && ' Расстояние оценочное: укажите точные адреса.'}</p>
      </section>

      <section className="panel">
        <h2>Получатель</h2>
        <div className="form">
          <div className="f"><label htmlFor="r-nm">Имя получателя</label><input id="r-nm" required value={o.recipientName} onChange={(e) => setO({ ...o, recipientName: e.target.value })} /></div>
          <div className="f"><label htmlFor="r-ph">Телефон получателя</label><input id="r-ph" type="tel" required value={o.recipientPhone} onChange={(e) => setO({ ...o, recipientPhone: e.target.value })} /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="r-cm">Комментарий курьеру</label><input id="r-cm" value={o.comment} onChange={(e) => setO({ ...o, comment: e.target.value })} placeholder="Домофон, этаж, время" /></div>
        </div>
        <label className="check" htmlFor="r-os" style={{ marginTop: 10 }}><input id="r-os" type="checkbox" checked={otherSender} onChange={(e) => setOtherSender(e.target.checked)} /><span>Груз отдаст другой человек</span></label>
        {otherSender && <div className="form" style={{ marginTop: 8 }}>
          <div className="f"><label htmlFor="s-nm">Кто отдаст</label><input id="s-nm" value={o.fromName} onChange={(e) => setO({ ...o, fromName: e.target.value })} /></div>
          <div className="f"><label htmlFor="s-ph">Его телефон</label><input id="s-ph" type="tel" value={o.fromPhone} onChange={(e) => setO({ ...o, fromPhone: e.target.value })} /></div>
        </div>}
        <p className="note" style={{ marginTop: 10 }}>Оплата картой {me.cardBrand ?? ''} •••• {me.cardLast4}: сумма зарезервируется, когда вы выберете службу, и спишется после вручения.</p>
      </section>

      {err && <div className="err">{err}</div>}
      <button className="btn primary big" disabled={busy || !vehicle || calc?.priceRub == null}>{busy ? 'Резервируем…' : calc?.priceRub != null ? `Заказать за ${rub(calc.priceRub)}` : 'Заказать'}</button>
      <Link to={base}>← Назад</Link>
    </form>
  );
}

/* ---------- Заказ: курьер, статус, оценка и чаевые ---------- */

function OrderView({ ctx }: { ctx: Ctx }) {
  const { call, base } = ctx;
  const { id } = useParams();
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState('');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [tip, setTip] = useState(0);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const load = useCallback(() => call<Order>(`/client/orders/${id}`).then(setO).catch((e) => setErr(e.message)), [id, call]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 10_000, [load]);

  if (err && !o) return <div className="err">{err}</div>;
  if (!o) return <p className="note">Загрузка…</p>;
  const [label, cls] = stage(o);
  const act = (p: Promise<Order>) => { setErr(''); p.then(setO).catch((e) => setErr(e.message)); };

  return <>
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="mono note">{o.trackingNumber}</span><span className={`pill ${cls}`}>{label}</span></div>
      {o.waitingCourier && <p className="note">Заказ предложен курьерам с подходящим транспортом. Повезёт первый, кто примет, — вы увидите его здесь.</p>}
      <dl className="dl">
        {o.company && <><dt>Служба</dt><dd>{o.company.name}{o.company.phone && <> · <a href={`tel:${o.company.phone}`}>{o.company.phone}</a></>}</dd></>}
        <dt>Откуда</dt><dd>{o.pickupAddress}</dd>
        <dt>Куда</dt><dd>{o.address}</dd>
        {o.vehicle && <><dt>Транспорт</dt><dd>{o.vehicle}</dd></>}
        <dt>Получатель</dt><dd>{o.recipientName}{o.recipientPhone && `, ${o.recipientPhone}`}</dd>
        <dt>Стоимость</dt><dd>{rub(o.priceRub)}{o.payText && <div className="note">{o.payText}</div>}</dd>
        {o.confirmCode && <><dt>Код для получения</dt><dd><span className="codebox" style={{ fontSize: 18 }}>{o.confirmCode}</span><div className="note">Получатель называет его курьеру. Мы отправили его по SMS.</div></dd></>}
        {o.failReason && <><dt>Причина</dt><dd>{o.failReason}</dd></>}
      </dl>
    </section>

    {o.courier && <section className="panel">
      <h3 className="h3" style={{ marginTop: 0 }}>Курьер</h3>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><b>{o.courier.name}</b>{o.courier.vehicle && <span className="note"> · {o.courier.vehicle}</span>}
          <div className="note">{o.courier.rating ? `★ ${o.courier.rating} (${o.courier.ratingCount} оценок)` : 'Пока без оценок'}</div></div>
        <div className="row">
          {o.courier.phone && <a className="btn sm" href={`tel:${o.courier.phone}`}>Позвонить</a>}
          {o.courier.location && <a className="btn sm" target="_blank" rel="noreferrer" href={`https://yandex.ru/maps/?pt=${o.courier.location.lng},${o.courier.location.lat}&z=16&l=map`}>Где курьер</a>}
        </div>
      </div>
    </section>}

    {o.status === 'delivered' && !o.rating && <section className="panel">
      <h2>Как прошла доставка?</h2>
      <div className="stars" role="radiogroup" aria-label="Оценка курьера">
        {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} из 5`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>)}
      </div>
      <div className="f"><label htmlFor="rcm">Отзыв (необязательно)</label><textarea id="rcm" rows={2} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} /></div>
      <h3 className="h3">Чаевые курьеру</h3>
      <div className="row">{[0, 50, 100, 200, 300].map((v) => <button key={v} type="button" className={`btn sm ${tip === v ? 'primary' : ''}`} onClick={() => setTip(v)}>{v ? rub(v) : 'Без чаевых'}</button>)}
        <input aria-label="Другая сумма" type="number" min={0} max={10000} style={{ width: 110 }} value={tip || ''} placeholder="Другая" onChange={(e) => setTip(Number(e.target.value) || 0)} /></div>
      <p className="note">Чаевые спишутся с карты •••• {ctx.me.cardLast4} и полностью достанутся курьеру.</p>
      <button className="btn primary" style={{ marginTop: 8 }} onClick={() => act(call(`/client/orders/${o.id}/rate`, { body: { rating, comment: comment || undefined, tipRub: tip } }))}>Отправить оценку</button>
    </section>}
    {o.rating && <section className="panel"><p>Ваша оценка: <span className="stars-static">{'★'.repeat(o.rating)}{'☆'.repeat(5 - o.rating)}</span>{o.tipRub > 0 && ` · чаевые ${rub(o.tipRub)}`}. Спасибо!</p></section>}

    <section className="panel">
      <h3 className="h3" style={{ marginTop: 0 }}>История</h3>
      <ol className="timeline">{o.events.map((e, i) => <li key={i}>{stage({ status: e.status, pickedUpAt: e.note === 'Курьер забрал посылку' ? 'x' : null })[0]}{e.note && e.note !== 'Курьер забрал посылку' && !e.note.startsWith('Курьер:') && ` — ${e.note}`}<div className="note">{new Date(e.at).toLocaleString('ru-RU')}</div></li>)}</ol>
    </section>

    {o.payStatus === 'failed' && <DebtBanner ctx={ctx} onPaid={load} />}
    {['created', 'at_warehouse', 'assigned'].includes(o.status) && !o.pickedUpAt && <div className="row">
      {!confirmCancel ? <button className="btn" onClick={() => setConfirmCancel(true)}>Отменить заказ</button>
        : <><span>Отменить? Резерв снимется, деньги вернутся на карту.</span><button className="btn" onClick={() => act(call(`/client/orders/${o.id}/cancel`, { method: 'POST' }))}>Да, отменить</button><button className="btn" onClick={() => setConfirmCancel(false)}>Нет</button></>}
    </div>}
    {err && <div className="err">{err}</div>}
    <p><Link to={base}>← Все доставки</Link></p>
  </>;
}

/** Сюда банк возвращает заказчика после подтверждения платежа (3-D Secure). */
export function PayDone() {
  const nav = useNavigate();
  const p = pendingPay.get();
  useEffect(() => { if (p) nav(p.back, { replace: true }); }, []);
  return <div className="wrap capp"><section className="panel" style={{ maxWidth: 440, margin: '48px auto', textAlign: 'center' }}>
    <h2>Готово</h2>
    <p>Платёж обработан. Вернитесь в приложение — статус обновится сам.</p>
  </section></div>;
}
