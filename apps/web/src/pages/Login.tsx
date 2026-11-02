import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, auth } from '../api';

/** White-label: на поддомене клиента (bystro.marshrut.ru) вход оформлен в его бренд. */
export function useSubdomainBrand() {
  const [brand, setBrand] = useState<{ name: string; logoUrl: string | null } | null>(null);
  useEffect(() => {
    const parts = location.hostname.split('.');
    if (parts.length < 3 || ['www', 'app'].includes(parts[0]) || /^\d+$/.test(parts[0])) return;
    api<{ name: string; brandColor: string; logoUrl: string | null }>(`/public/brand/${parts[0]}`).then((b) => {
      setBrand(b); document.documentElement.style.setProperty('--brand', b.brandColor); document.title = b.name;
    }).catch(() => {});
  }, []);
  return brand;
}

export function BrandHeader({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  return <div className="row" style={{ marginBottom: 16, alignItems: 'center' }}>
    {logoUrl ? <img src={logoUrl} alt="" className="logo" /> : <div className="logo">{name[0]?.toUpperCase()}</div>}
    <b style={{ fontSize: 17 }}>{name}</b>
  </div>;
}

export function Login() {
  const nav = useNavigate();
  const brand = useSubdomainBrand();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: { role: string } }>('/auth/login', { body: { email, password } });
      if (r.user.role === 'courier') { setErr('Курьеры работают в мобильном приложении. Кабинет — для диспетчеров и руководителей.'); return; }
      auth.set(r.token);
      nav('/admin');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="wrap">
      <form className="panel login" onSubmit={submit}>
        <BrandHeader name={brand?.name ?? 'Маршрут'} logoUrl={brand?.logoUrl} />
        <h2>Вход в кабинет компании</h2>
        <div className="form" style={{ gridTemplateColumns: '1fr' }}>
          <div className="f"><label htmlFor="em">Email</label><input id="em" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="f"><label htmlFor="pw">Пароль</label><input id="pw" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <div className="err">{err}</div>}
          <button className="btn primary" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
          {!brand && <Link className="btn" to="/register" style={{ textAlign: 'center' }}>Зарегистрировать компанию — тарифы и 14 дней бесплатно</Link>}
          <p className="note">Не получается войти? <a href="/#support">Напишите в поддержку</a> или на <span className="mono">pipl82308@gmail.com</span></p>
          <p className="note"><Link to="/privacy">Политика обработки данных</Link> · <Link to="/terms">Условия</Link></p>
        </div>
      </form>
    </div>
  );
}
