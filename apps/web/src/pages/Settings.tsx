import { FormEvent, useEffect, useState } from 'react';
import { api, rub } from '../api';
import { pendingPay } from './ClientApp';
import { useMe } from '../App';
import { CityInput } from '../components';

interface Company {
  name: string; slug: string; brandColor: string; logoUrl: string | null; trackingPrefix: string; volumetricDivisor: number;
  legalName: string | null; inn: string | null; legalAddress: string | null; director: string | null; phone: string | null;
  city: string; pickupAddress: string | null; modules: { warehouse: boolean; hr: boolean };
}
interface User { id: string; name: string; email: string; role: string; active: boolean }
const ROLE: Record<string, string> = { owner: 'Владелец', dispatcher: 'Менеджер' };
const nul = (s: string) => (s.trim() ? s.trim() : null);

/** Настройки организации-заказчика: реквизиты, адрес отправки, тариф и доступы сотрудников. */
export function Settings() {
  const [c, setC] = useState<Company | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [nu, setNu] = useState({ name: '', email: '', password: '', role: 'dispatcher' });
  const { reload, me } = useMe();

  const load = () => Promise.all([api<Company>('/company').then(setC), api<User[]>('/company/users').then(setUsers)]);
  useEffect(() => { load().catch((e) => setMsg({ err: e.message })); }, []);
  const run = (p: Promise<unknown>, ok: string) => { setMsg({}); p.then(() => { setMsg({ ok }); return load(); }).catch((e) => setMsg({ err: e.message })); };
  const setF = (k: keyof Company) => (e: React.ChangeEvent<HTMLInputElement>) => setC({ ...c!, [k]: e.target.value });

  function saveCompany(e: FormEvent) {
    e.preventDefault();
    const { name, brandColor, logoUrl, trackingPrefix, volumetricDivisor, legalName, inn, legalAddress, director, phone, city, modules, pickupAddress } = c!;
    run(api('/company', { method: 'PUT', body: {
      name, brandColor, logoUrl, volumetricDivisor, city, modules: modules ?? { warehouse: false, hr: false }, trackingPrefix: trackingPrefix.toUpperCase(),
      legalName: nul(legalName ?? ''), inn: nul(inn ?? ''), legalAddress: nul(legalAddress ?? ''), director: nul(director ?? ''), phone: nul(phone ?? ''),
      pickupAddress: nul(pickupAddress ?? ''),
    } }).then(reload), 'Настройки сохранены');
  }

  function pickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 290_000) { setMsg({ err: 'Логотип больше 290 КБ. Уменьшите картинку.' }); return; }
    const r = new FileReader();
    r.onload = () => setC({ ...c!, logoUrl: String(r.result) });
    r.readAsDataURL(f);
  }

  if (!c) return msg.err ? <div className="err">{msg.err}</div> : <p className="note">Загрузка…</p>;

  return <>
    {msg.ok && <div className="okmsg">{msg.ok}</div>}
    {msg.err && <div className="err">{msg.err}</div>}

    <section className="panel">
      <h2>Бренд и реквизиты</h2>
      <p className="note">Название, цвет и логотип видят получатели на странице оплаты и отслеживания. Реквизиты нужны для счёта на тариф и закрывающих документов.</p>
      <form id="co" className="form" onSubmit={saveCompany}>
        <div className="f"><label htmlFor="cn">Название компании</label><input id="cn" required value={c.name} onChange={setF('name')} /></div>
        <div className="f"><label htmlFor="cc">Фирменный цвет</label><input id="cc" type="color" value={c.brandColor} onChange={setF('brandColor')} style={{ height: 40 }} /></div>
        <div className="f"><label htmlFor="cl">Логотип (PNG, JPEG, SVG до 290 КБ)</label><input id="cl" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={pickLogo} /></div>
        <div className="f"><label htmlFor="cp">Префикс номеров накладных</label><input id="cp" required pattern="[A-Za-z]{2,4}" value={c.trackingPrefix} onChange={setF('trackingPrefix')} /></div>
        <div className="f"><label htmlFor="ln">Юридическое название</label><input id="ln" value={c.legalName ?? ''} onChange={setF('legalName')} placeholder="ООО «Ромашка»" /></div>
        <div className="f"><label htmlFor="inn">ИНН</label><input id="inn" value={c.inn ?? ''} onChange={setF('inn')} inputMode="numeric" /></div>
        <div className="f"><label htmlFor="la">Юридический адрес</label><input id="la" value={c.legalAddress ?? ''} onChange={setF('legalAddress')} /></div>
        <div className="f"><label htmlFor="dr">Руководитель (ФИО)</label><input id="dr" value={c.director ?? ''} onChange={setF('director')} /></div>
        <div className="f"><label htmlFor="ph">Телефон отправителя</label><input id="ph" value={c.phone ?? ''} onChange={setF('phone')} /></div>
        <div className="f"><label htmlFor="ccity">Город отправки</label><CityInput id="ccity" value={c.city} onChange={(city) => setC({ ...c, city })} /></div>
        <div className="f" style={{ gridColumn: 'span 2' }}><label htmlFor="cpa">Откуда забирать по умолчанию (склад, офис)</label><input id="cpa" value={c.pickupAddress ?? ''} onChange={setF('pickupAddress')} placeholder="ул. Кирова, 86" /></div>
      </form>
      <div className="row" style={{ marginTop: 12 }}>
        {c.logoUrl && <img src={c.logoUrl} alt="Логотип" style={{ height: 40, borderRadius: 6 }} />}
        {c.logoUrl && <button className="btn sm" onClick={() => setC({ ...c, logoUrl: null })}>Убрать логотип</button>}
        <button className="btn primary" form="co">Сохранить</button>
        <span className="note">Адрес кабинета: <span className="mono">{c.slug}</span></span>
      </div>
    </section>

    <CardBlock />

    <section className="panel">
      <h2>Сотрудники с доступом</h2>
      <div className="tbl"><table>
        <thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th>Доступ</th></tr></thead>
        <tbody>{users.map((u) => <tr key={u.id}>
          <td>{u.name}</td><td className="mono">{u.email}</td><td>{ROLE[u.role]}</td>
          <td>{u.role === 'owner' ? '—' : <button className="btn sm" onClick={() => run(api(`/company/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }), u.active ? `${u.name}: доступ отключён` : `${u.name}: доступ включён`)}>{u.active ? 'Включён — отключить' : 'Отключён — включить'}</button>}</td>
        </tr>)}</tbody>
      </table></div>
      <form className="form" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); run(api('/auth/staff', { body: nu }).then(() => setNu({ name: '', email: '', password: '', role: nu.role })), `Учётная запись создана. Передайте сотруднику email и пароль.`); }}>
        <div className="f"><label htmlFor="un">Имя</label><input id="un" required value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} /></div>
        <div className="f"><label htmlFor="ue">Email</label><input id="ue" type="email" required value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></div>
        <div className="f"><label htmlFor="up">Пароль (от 8 символов)</label><input id="up" required minLength={8} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></div>
        <div className="f"><label htmlFor="ur">Роль</label><select id="ur" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
          {['dispatcher'].map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></div>
        <div className="f"><label>&nbsp;</label><button className="btn primary">Создать доступ</button></div>
      </form>
    </section>

  </>;
}

interface Card { hasCard: boolean; cardLast4: string | null; cardBrand: string | null; debtRub: number; testMode: boolean }
type PayStart = Card & { paymentId: string; status: string; confirmationUrl: string | null };

/**
 * Карта компании: доставки оплачиваются только с неё. Сумма заказа резервируется при оформлении и списывается после вручения.
 * Проверка карты — банк резервирует 1 ₽ и сразу возвращает.
 */
export function CardBlock() {
  const [c, setC] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api<Card>('/company/card').then(setC).catch((e) => setErr(e.message)); }, []);
  async function go(path: string, method = 'POST') {
    setBusy(true); setErr('');
    try {
      const r = await api<PayStart>(path, { method });
      if (r.confirmationUrl) { pendingPay.set({ check: path === '/company/card/debt' ? '/company/card/check' : '/company/card/check', paymentId: r.paymentId, back: '/admin/settings' }); location.href = r.confirmationUrl; return; }
      setC(r);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <section className="panel" id="card">
    <h2>Карта для оплаты доставок</h2>
    <p className="note">Абонентской платы нет: вы платите только за доставки. Сумма заказа по тарифу города резервируется на карте при оформлении и списывается после вручения; отмена до забора — резерв снимается. Получатели ничего не платят.</p>
    {c?.debtRub ? <div className="err">Не удалось списать оплату за доставки: {rub(c.debtRub)}. Новые доставки недоступны, пока долг не погашен. <button className="btn sm" disabled={busy} onClick={() => go('/company/card/debt')}>Оплатить</button></div> : null}
    {c && (c.hasCard
      ? <p>{c.cardBrand ?? 'Карта'} •••• {c.cardLast4} <button className="btn sm" disabled={busy} onClick={() => go('/company/card')}>Заменить</button> <button className="btn sm" disabled={busy} onClick={() => go('/company/card', 'DELETE')}>Отвязать</button></p>
      : <p><button className="btn primary" disabled={busy} onClick={() => go('/company/card')}>{busy ? 'Открываем банк…' : 'Привязать карту'}</button></p>)}
    {c?.testMode && <p className="note">Тестовый режим: деньги не списываются, карта •••• 4242 привяжется сразу.</p>}
    {err && <div className="err">{err}</div>}
  </section>;
}
