import { useEffect } from 'react';
// Тонкий клиент к API: токен хранится в localStorage, ошибки сервера показываются как есть.

const TOKEN = 'marshrut-token';

export const auth = {
  get token() { return localStorage.getItem(TOKEN); },
  set(token: string) { localStorage.setItem(TOKEN, token); },
  clear() { localStorage.removeItem(TOKEN); },
};

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const ADMIN = 'marshrut-admin-token';
export const adminAuth = {
  get token() { return localStorage.getItem(ADMIN); },
  set(token: string) { localStorage.setItem(ADMIN, token); },
  clear() { localStorage.removeItem(ADMIN); },
};

/** admin: true — запрос панели администратора платформы (свой токен, свой экран входа). */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; admin?: boolean; token?: string | null } = {}): Promise<T> {
  const own = opts.token !== undefined;   // свой токен (приложение клиента) — без перехода на вход кабинета
  const token = own ? opts.token : opts.admin ? adminAuth.token : auth.token;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && token && !own && !path.endsWith('/login')) {
    if (opts.admin) { adminAuth.clear(); location.reload(); } else { auth.clear(); location.href = '/admin/login'; }
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(Array.isArray(data?.message) ? data.message.join(', ') : data?.message ?? 'Ошибка сервера', res.status);
  return data as T;
}

/** Опрос сервера каждые ms, пока страница открыта и видна: списки обновляются сами. */
export function usePolling(fn: () => unknown, ms: number, deps: unknown[] = []) {
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') fn(); };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Файлы за авторизацией (штрихкод, фото вручения) грузим через fetch и отдаём blob-ссылку. */
export async function authBlobUrl(path: string) {
  const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${auth.token}` } });
  if (!res.ok) throw new ApiError('Не удалось загрузить файл', res.status);
  return URL.createObjectURL(await res.blob());
}
export const barcodeUrl = (id: string) => authBlobUrl(`/shipments/${id}/barcode.png`);

/** Документ (HTML для печати в PDF) открываем в новой вкладке. */
export async function openDocument(path: string) {
  const win = window.open('', '_blank');
  try {
    const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${auth.token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Не удалось сформировать документ');
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
    if (win) win.location.href = url; else location.href = url;
  } catch (e) { win?.close(); throw e; }
}

export const STATUS: Record<string, [string, string]> = {
  created: ['Создана', 's-new'],
  at_warehouse: ['На складе', 's-wh'],
  assigned: ['В пути', 's-way'],
  delivered: ['Доставлена', 's-done'],
  failed: ['Не вручена', 's-fail'],
  returned: ['Возврат', 's-fail'],
};

export const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

export interface Zone { id: string; name: string; city: string; baseRub: number; perKgRub: number; etaDays: number }
export interface Modules { warehouse: boolean; hr: boolean }
export interface Courier {
  id: string; name: string; phone: string; zoneId: string | null; active: boolean; inWork: number; userId: string | null;
  status: 'pending' | 'approved' | 'rejected'; vehicle: string | null; city: string; email: string | null; createdAt: string;
  rating: number | null; lastSeenAt: string | null;
}
export const VEHICLE: Record<string, string> = { foot: 'пешком', bike: 'вело / самокат', car: 'легковой', truck_m: 'грузовой 3,5–5 т' };
export interface ShipmentRow {
  id: string; trackingNumber: string; senderName: string; recipientName: string; address: string; zoneName: string;
  weightKg: number; priceRub: number; status: string; cellCode: string | null; courierName: string | null; createdAt: string;
  city: string; source: 'manual' | 'api' | 'import' | 'client'; externalId: string | null; pickupAddress: string | null; rating: number | null;
  vehicle: string | null; payStatus: string;
}

export interface Plan {
  id: 'start' | 'business' | 'white_label'; name: string; priceRub: number; period: string; lead: string;
  features: readonly string[]; popular?: boolean; priceFrom?: boolean;
}
let plansCache: Promise<{ trialDays: number; plans: Plan[] }> | null = null;
/** Тарифы приходят с сервера (src/plans.ts), чтобы цены были в одном месте. */
export const loadPlans = () => (plansCache ??= api<{ trialDays: number; plans: Plan[] }>('/public/plans'));
export const planName = (id?: string) => ({ start: 'Старт', business: 'Бизнес', white_label: 'White-label' } as Record<string, string>)[id ?? ''] ?? id ?? '';
