import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

// Адрес API и бренд задаются при сборке в app.json → extra (у каждого клиента white-label своя сборка).
const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; devApiUrl?: string; brandName?: string; brandColor?: string };

/**
 * Адрес сервера.
 * При разработке (Expo Go) берём IP компьютера, с которого запущен Expo, и порт 3000 — ничего прописывать не нужно.
 * Можно задать вручную через extra.devApiUrl. В собранном APK используется extra.apiUrl (адрес боевого сервера).
 */
function resolveApiUrl() {
  if (__DEV__) {
    if (extra.devApiUrl) return extra.devApiUrl;
    const host = (Constants.expoConfig?.hostUri ?? '').split(':')[0];
    if (host) return `http://${host}:3000/api`;
  }
  return extra.apiUrl ?? 'http://10.0.2.2:3000/api';
}
export const API_URL = resolveApiUrl();
/** Бренд приложения: из сборки, а после входа — название и цвет компании курьера. */
export const BRAND = { name: extra.brandName ?? 'Маршрут', color: extra.brandColor ?? '#0e7c66' };
const brandListeners = new Set<() => void>();
export function setBrand(b: { name: string; color: string }) {
  if (b.name === BRAND.name && b.color === BRAND.color) return;
  BRAND.name = b.name; BRAND.color = b.color;
  brandListeners.forEach((fn) => fn());
}
export function onBrandChange(fn: () => void) { brandListeners.add(fn); return () => { brandListeners.delete(fn); }; }

const TOKEN_KEY = 'marshrut.token';
let token: string | null = null;

export const session = {
  async load() { token = await SecureStore.getItemAsync(TOKEN_KEY); return token; },
  async set(t: string) { token = t; await SecureStore.setItemAsync(TOKEN_KEY, t); },
  async clear() { token = null; await SecureStore.deleteItemAsync(TOKEN_KEY); },
  get token() { return token; },
};

/** Ошибка сервера (4xx/5xx). Сетевая ошибка — отдельный класс: такие действия уходят в офлайн-очередь. */
export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg); } }
export class NetworkError extends Error {}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  let res: Response;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    res = await fetch(`${API_URL}${path}`, {
      method: method ?? (body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {
    throw new NetworkError(`Нет связи с сервером ${API_URL}`);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/auth/login') onUnauthorized();
  if (!res.ok) throw new ApiError(data?.message ?? `Ошибка сервера (${res.status})`, res.status);
  return data as T;
}

export interface MyShipment {
  id: string; trackingNumber: string; recipientName: string; recipientPhone: string | null;
  address: string; city?: string; codRub: number; status: 'assigned' | 'delivered' | 'failed'; weightKg: number;
  priceRub?: number; pickupAddress?: string | null; pickupName?: string | null; pickupPhone?: string | null; pickedUpAt?: string | null;
  comment?: string | null; paymentMethod?: string | null; courierPayRub?: number | null; tipRub?: number; rating?: number | null;
  vehicle?: string | null; payStatus?: string;
  addressDetails?: { street: string; house: string; apartment: string; entrance?: string; floor?: string; intercom?: string } | null;
  deliveryLat?: number | null; deliveryLng?: number | null; deliverRadiusM?: number;
  pending?: boolean;     // действие сохранено в телефоне и ждёт отправки
  syncError?: string;    // сервер отклонил действие из очереди
}
