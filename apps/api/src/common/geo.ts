import { Logger } from '@nestjs/common';

/** Расстояние по прямой между двумя точками, км. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Координаты адреса через HTTP Геокодер Яндекса (нужен YANDEX_GEOCODER_KEY, developer.tech.yandex.ru).
 * Без ключа возвращает null — тогда курьер подбирается по городу и загрузке, а клиент может отправить свою геопозицию.
 */
export async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const key = process.env.YANDEX_GEOCODER_KEY;
  if (!key || !address.trim()) return null;
  try {
    const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(key)}&format=json&results=1&lang=ru_RU&geocode=${encodeURIComponent(address)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const body: any = await r.json();
    const pos: string | undefined = body?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject?.Point?.pos;
    if (!pos) return null;
    const [lng, lat] = pos.split(' ').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch (e: any) {
    Logger.warn(`Геокодер недоступен: ${e.message}`, 'Гео');
    return null;
  }
}

/** Адрес по координатам (кнопка «Определить по GPS» в приложении заказчика). Без ключа — null. */
export async function reverseGeocode(lat: number, lng: number): Promise<{ address: string; city: string } | null> {
  const key = process.env.YANDEX_GEOCODER_KEY;
  if (!key) return null;
  try {
    const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(key)}&format=json&results=1&lang=ru_RU&kind=house&geocode=${lng},${lat}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const body: any = await r.json();
    const meta = body?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject?.metaDataProperty?.GeocoderMetaData;
    if (!meta) return null;
    const parts: { kind: string; name: string }[] = meta.Address?.Components ?? [];
    const city = parts.find((p) => p.kind === 'locality')?.name ?? '';
    const street = parts.filter((p) => p.kind === 'street' || p.kind === 'house').map((p) => p.name).join(', ');
    return { address: street || meta.text, city };
  } catch (e: any) {
    Logger.warn(`Геокодер недоступен: ${e.message}`, 'Гео');
    return null;
  }
}

/**
 * Центры крупных городов: межгородское расстояние считается и без ключа геокодера.
 * Дорога длиннее прямой примерно на четверть — это учитывает ROAD_FACTOR.
 */
export const ROAD_FACTOR = 1.25;
const CITY_CENTERS: Record<string, [number, number]> = {
  'москва': [55.756, 37.617], 'санкт-петербург': [59.939, 30.316], 'новосибирск': [55.030, 82.920], 'екатеринбург': [56.838, 60.597],
  'казань': [55.796, 49.106], 'нижний новгород': [56.327, 44.006], 'челябинск': [55.160, 61.402], 'самара': [53.195, 50.101],
  'омск': [54.989, 73.368], 'ростов-на-дону': [47.222, 39.720], 'уфа': [54.735, 55.958], 'красноярск': [56.010, 92.852],
  'пермь': [58.010, 56.229], 'воронеж': [51.661, 39.200], 'волгоград': [48.708, 44.513], 'краснодар': [45.035, 38.975],
  'саратов': [51.533, 46.034], 'тюмень': [57.153, 65.534], 'томск': [56.484, 84.948], 'барнаул': [53.348, 83.779],
  'кемерово': [55.355, 86.087], 'новокузнецк': [53.757, 87.136], 'иркутск': [52.287, 104.305], 'хабаровск': [48.480, 135.072],
  'владивосток': [43.115, 131.885], 'ярославль': [57.626, 39.894], 'тула': [54.193, 37.618], 'калининград': [54.710, 20.452],
  'сочи': [43.585, 39.723], 'бердск': [54.758, 83.107], 'искитим': [54.640, 83.300], 'обь': [54.994, 82.693],
  'горно-алтайск': [51.958, 85.960], 'абакан': [53.721, 91.442], 'улан-удэ': [51.834, 107.584], 'оренбург': [51.768, 55.097],
};
const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е').replace(/^г\.?\s*/, '');
export function cityCenter(city: string): { lat: number; lng: number } | null {
  const c = CITY_CENTERS[norm(city)];
  return c ? { lat: c[0], lng: c[1] } : null;
}
export const sameCity = (a?: string | null, b?: string | null) => !!a && !!b && norm(a) === norm(b);

/**
 * Расстояние по дороге для расчёта цены.
 * approx = true, если точных координат нет и взята оценка (центр города или средняя поездка по городу).
 */
export async function routeKm(from: { city: string; address?: string; lat?: number | null; lng?: number | null },
  to: { city: string; address?: string; lat?: number | null; lng?: number | null }): Promise<{ km: number | null; approx: boolean }> {
  const point = async (p: typeof from) => (p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng }
    : (p.address ? await geocode(`${p.city}, ${p.address}`) : null));
  const [a, b] = await Promise.all([point(from), point(to)]);
  if (a && b) return { km: Math.max(1, Math.round(distanceKm(a, b) * ROAD_FACTOR * 10) / 10), approx: false };
  if (sameCity(from.city, to.city)) return { km: 8, approx: true };          // средняя поездка по городу
  const ca = a ?? cityCenter(from.city), cb = b ?? cityCenter(to.city);
  if (ca && cb) return { km: Math.round(distanceKm(ca, cb) * ROAD_FACTOR), approx: true };
  return { km: null, approx: true };
}
