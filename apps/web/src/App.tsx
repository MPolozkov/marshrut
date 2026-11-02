import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, auth, Modules } from './api';
import { pendingPay } from './pages/ClientApp';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Shipments } from './pages/Shipments';
import { Track } from './pages/Track';
import { Settings } from './pages/Settings';
import { Reports } from './pages/Reports';
import { Integrations } from './pages/Integrations';
import { Support } from './pages/Support';
import { Platform } from './pages/Platform';
import { ClientApp, PayDone } from './pages/ClientApp';
import { Privacy, Terms } from './pages/Legal';

export interface Me {
  user: { name: string; role: string };
  company: {
    name: string; slug: string; city: string; brandColor: string; logoUrl: string | null; modules: Modules;
    plan: string; trialEndsAt: string | null; paidUntil: string | null; pickupAddress?: string | null;
  };
}
const MeCtx = createContext<{ me: Me; reload: () => void } | null>(null);
/** Данные пользователя и компании; reload() — после изменения настроек, чтобы шапка и меню обновились сразу. */
export const useMe = () => useContext(MeCtx)!;

type Module = keyof Modules | null;
const ALL = ['owner', 'dispatcher', 'warehouse', 'hr'];
// Разделы кабинета компании. Все адреса — внутри /admin.
const NAV: [string, string, string[], Module][] = [
  ['shipments', 'Доставки', ['owner', 'dispatcher'], null],
  ['reports', 'Отчёты', ['owner', 'dispatcher'], null],
  ['integrations', 'Интеграции', ['owner'], null],
  ['settings', 'Настройки', ['owner'], null],
  ['support', 'Поддержка', ALL, null],
];
const PAGES: Record<string, () => JSX.Element> = { shipments: Shipments, reports: Reports, integrations: Integrations, settings: Settings, support: Support };

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/register" element={<Register />} />
      <Route path="/login" element={<Navigate to="/admin/login" replace />} />
      <Route path="/admin/login" element={<Login />} />
      <Route path="/admin/*" element={<RequireAuth />} />
      <Route path="/platform/*" element={<Platform />} />
      <Route path="/c/:slug/*" element={<Navigate to="/order" replace />} />
      <Route path="/order/*" element={<ClientApp />} />
      <Route path="/pay/done" element={<PayDone />} />
      <Route path="/track/:number" element={<Track />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Проверка токена при каждой смене адреса: после входа или выхода экран переключается сразу. */
function RequireAuth() {
  useLocation();
  return auth.token ? <Shell /> : <Navigate to="/admin/login" replace />;
}

/** Кабинет компании (/admin): шапка с брендом, разделы по роли и включённым модулям. */
function Shell() {
  const [me, setMe] = useState<Me | null>(null);
  const nav = useNavigate();
  const reload = useCallback(() => { api<Me>('/auth/me').then(setMe).catch(() => nav('/admin/login')); }, [nav]);
  useEffect(reload, [reload]);
  // Вернулись со страницы банка (карта компании или доставка) — проверяем платёж.
  useEffect(() => {
    const p = pendingPay.get();
    if (!p || !(p.check.startsWith('/company') || p.check.startsWith('/shipments'))) return;
    pendingPay.clear();
    api(p.check, { body: p.body ?? (p.paymentId ? { paymentId: p.paymentId } : {}) }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!me) return;
    document.documentElement.style.setProperty('--brand', me.company.brandColor);
    document.title = me.company.name;
  }, [me]);
  if (!me) return <div className="wrap"><p className="note">Загрузка…</p></div>;

  const mods = me.company.modules ?? { warehouse: true, hr: true };
  const links = NAV.filter(([, , roles, mod]) => roles.includes(me.user.role) && (!mod || mods[mod]));
  const first = `/admin/${links[0]?.[0] ?? 'support'}`;


  return (
    <MeCtx.Provider value={{ me, reload }}>
      <header className="top">
        <div className="wrap bar">
          {me.company.logoUrl
            ? <img src={me.company.logoUrl} alt="" className="logo" />
            : <div className="logo">{me.company.name[0]?.toUpperCase()}</div>}
          <div style={{ minWidth: 0 }}>
            <div className="brandname">{me.company.name}</div>
            <div className="note">{me.user.name}{me.company.city && ` · ${me.company.city}`}</div>
          </div>
          <div className="row" style={{ marginLeft: 'auto', alignItems: 'center' }}>
            <button className="btn sm" onClick={() => { auth.clear(); nav('/admin/login'); }}>Выйти</button>
          </div>
        </div>
        <nav className="wrap tabs">
          {links.map(([to, label]) => <NavLink key={to} to={`/admin/${to}`}>{label}</NavLink>)}
        </nav>
      </header>
      <main className="wrap">
        <Routes>
          {links.map(([to]) => { const Page = PAGES[to]; return <Route key={to} path={to} element={<Page />} />; })}
          <Route path="*" element={<Navigate to={first} replace />} />
        </Routes>
      </main>
    </MeCtx.Provider>
  );
}
