/**
 * Виды транспорта. Заказчик выбирает, кто повезёт груз; курьер указывает, на чём ездит.
 * Доставка только по городу. Пределы веса и габаритов — ориентир для подсказки заказчику, поправьте под свой парк.
 */
export const VEHICLE_IDS = ['foot', 'bike', 'car', 'truck_m'] as const;
export type VehicleId = (typeof VEHICLE_IDS)[number];

export interface VehicleSpec {
  id: VehicleId; label: string; short: string;
  maxKg: number; maxCm: [number, number, number];   // длина, ширина, высота грузового места
}

export const VEHICLES: Record<VehicleId, VehicleSpec> = {
  foot: { id: 'foot', label: 'Пеший курьер', short: 'Пешком', maxKg: 5, maxCm: [45, 35, 30] },
  bike: { id: 'bike', label: 'Велосипед или электросамокат', short: 'Вело / самокат', maxKg: 15, maxCm: [50, 40, 40] },
  car: { id: 'car', label: 'Легковой автомобиль', short: 'Легковой', maxKg: 300, maxCm: [150, 100, 80] },
  truck_m: { id: 'truck_m', label: 'Грузовой 3,5–5 т', short: 'Грузовой', maxKg: 2000, maxCm: [420, 200, 200] },
};

/** Какие заказы может взять курьер на своём транспорте: на машине можно везти и то, что подошло бы пешему. */
export const COURIER_CAN: Record<VehicleId, VehicleId[]> = {
  foot: ['foot'], bike: ['foot', 'bike'], car: ['foot', 'bike', 'car'], truck_m: ['truck_m'],
};

export interface Rate { enabled: boolean; baseRub: number; perKmRub: number; perKgRub: number; freeKg: number }
export type Rates = Record<VehicleId, Rate>;
/** Тарифы по умолчанию для новой компании: подача + километры + перевес. */
export const DEFAULT_RATES: Rates = {
  foot: { enabled: true, baseRub: 250, perKmRub: 25, perKgRub: 20, freeKg: 2 },
  bike: { enabled: true, baseRub: 300, perKmRub: 30, perKgRub: 15, freeKg: 5 },
  car: { enabled: true, baseRub: 450, perKmRub: 35, perKgRub: 10, freeKg: 20 },
  truck_m: { enabled: false, baseRub: 2500, perKmRub: 60, perKgRub: 0, freeKg: 2000 },
};

export interface Cargo { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }

/** Подходит ли транспорт по весу и габаритам. Возвращает причину, если нет. */
export function vehicleProblem(v: VehicleId, cargo: Cargo): string | null {
  const s = VEHICLES[v];
  if (cargo.weightKg > s.maxKg) return `вес до ${s.maxKg.toLocaleString('ru-RU')} кг`;
  const box = [cargo.lengthCm, cargo.widthCm, cargo.heightCm].sort((a, b) => b - a);
  const room = [...s.maxCm].sort((a, b) => b - a);
  if (box.some((d, i) => d > room[i])) return `габариты до ${s.maxCm.join('×')} см`;
  return null;
}

/** Самый лёгкий подходящий транспорт — его предлагаем по умолчанию. */
export const recommendVehicle = (cargo: Cargo) => VEHICLE_IDS.find((v) => !vehicleProblem(v, cargo)) ?? null;

/** Цена по тарифу компании: подача + км + каждый кг сверх включённых. null — расстояние неизвестно. */
export function priceByRate(r: Rate, km: number | null, weightKg: number): number | null {
  if (km == null) return null;
  const extraKg = Math.max(0, Math.ceil(weightKg - r.freeKg));
  return Math.round((r.baseRub + km * r.perKmRub + extraKg * r.perKgRub) / 10) * 10;
}

/** Вознаграждение курьера за заказ: фикс + % от цены доставки (настройка компании). */
export const courierReward = (rule: { fixedRub: number; percent: number } | null | undefined, priceRub: number) =>
  Math.round((rule?.fixedRub ?? 0) + (priceRub * (rule?.percent ?? 0)) / 100);
