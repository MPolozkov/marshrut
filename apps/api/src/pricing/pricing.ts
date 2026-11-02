export interface QuoteInput { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }
export interface Tariff { baseRub: number; perKgRub: number }

/**
 * Расчёт стоимости: оплачивается больший из фактического и объёмного веса.
 * Объёмный вес = Д×Ш×В (см) / делитель (обычно 5000). Первый кг входит в базовую цену.
 */
export function quote(p: QuoteInput, t: Tariff, divisor = 5000) {
  const volumeM3 = (p.lengthCm * p.widthCm * p.heightCm) / 1_000_000;
  const volumetricKg = round2((p.lengthCm * p.widthCm * p.heightCm) / divisor);
  const chargeableKg = round2(Math.max(p.weightKg, volumetricKg));
  const extraKg = Math.max(0, Math.ceil(chargeableKg - 1));
  const totalRub = t.baseRub + extraKg * t.perKgRub;
  return { volumeM3: round3(volumeM3), volumetricKg, chargeableKg, baseRub: t.baseRub, extraRub: extraKg * t.perKgRub, totalRub };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
