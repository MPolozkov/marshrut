import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth } from '../api';
import { CityInput } from '../components';
import { BrandHeader } from './Login';

const TR: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slugify = (s: string) => s.toLowerCase().split('').map((c) => TR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

/** Регистрация организации-заказчика: магазин, офис, склад — оформляет доставки из кабинета, файлом или по API. */
export function Register() {
  const nav = useNavigate();
  const [f, setF] = useState({ companyName: '', city: '', phone: '', name: '', email: '', password: '', legalName: '', inn: '' });
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const modules = { warehouse: false, hr: false };
  const [accept, setAccept] = useState(false);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: e.target.value });
    if (k === 'companyName' && !slugTouched) setSlug(slugify(e.target.value));
  };

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string }>('/auth/register', { body: {
        ...f, legalName: f.legalName || undefined, inn: f.inn || undefined,
        slug: slug.length >= 3 ? slug : undefined, modules, acceptTerms: accept,
      } });
      auth.set(r.token);
      nav('/admin');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const display = f.companyName.trim() || 'Ваша компания';
  return (
    <div className="wrap">
      <form className="panel login" style={{ maxWidth: 560 }} onSubmit={submit}>
        <BrandHeader name={display} />
        <h2>Регистрация компании</h2>
        <p className="note">Без абонентской платы: вы платите только за доставки — сумма по тарифу города списывается с карты компании после вручения.</p>
        <p className="note" style={{ marginBottom: 14 }}>Название увидят курьеры и получатели.</p>
        <div className="form">
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="cn">Название компании или магазина</label>
            <input id="cn" required minLength={2} maxLength={80} placeholder="Магазин «Ромашка»" value={f.companyName} onChange={set('companyName')} /></div>
          <div className="f"><label htmlFor="city">Город</label>
            <CityInput id="city" required value={f.city} onChange={(city) => setF({ ...f, city })} /></div>
          <div className="f"><label htmlFor="ph">Телефон компании</label>
            <input id="ph" type="tel" required placeholder="+7 900 000-00-00" value={f.phone} onChange={set('phone')} /></div>
          <div className="f"><label htmlFor="nm">Ваше имя</label><input id="nm" required value={f.name} onChange={set('name')} autoComplete="name" /></div>
          <div className="f"><label htmlFor="em">Email для входа</label><input id="em" type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="pw">Пароль (от 8 символов)</label>
            <input id="pw" type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></div>
        </div>


        <button type="button" className="btn sm" style={{ marginBottom: 12 }} onClick={() => setMore(!more)}>{more ? 'Скрыть реквизиты' : 'Добавить реквизиты (можно позже)'}</button>
        {more && <div className="form" style={{ marginBottom: 12 }}>
          <div className="f"><label htmlFor="ln">Юридическое название</label><input id="ln" placeholder="ООО «Ромашка»" value={f.legalName} onChange={set('legalName')} /></div>
          <div className="f"><label htmlFor="inn">ИНН</label><input id="inn" inputMode="numeric" pattern="\d{10}|\d{12}" value={f.inn} onChange={set('inn')} /></div>
          <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="sl">Адрес кабинета</label>
            <input id="sl" pattern="[a-z0-9-]{3,30}" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }} />
            <span className="note">Латиница, цифры и дефис. Кабинет будет доступен по адресу <span className="mono">{slug || 'адрес'}.ваш-домен.ru</span></span></div>
        </div>}

        <label className="check" htmlFor="acc" style={{ marginBottom: 12 }}>
          <input id="acc" type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>Принимаю <Link to="/terms">условия использования</Link> и даю согласие на обработку персональных данных по <Link to="/privacy">политике</Link></span>
        </label>
        {err && <div className="err" style={{ marginBottom: 12 }}>{err}</div>}
        <div className="form" style={{ gridTemplateColumns: '1fr' }}>
          <button className="btn primary" disabled={!accept || busy}>{busy ? 'Создаём кабинет…' : 'Создать кабинет'}</button>
          <Link to="/admin/login" className="btn" style={{ textAlign: 'center', textDecoration: 'none' }}>У меня уже есть аккаунт</Link>
        </div>
      </form>
    </div>
  );
}
