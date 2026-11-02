/**
 * Разбор CSV из Excel: разделитель «;» или «,», кавычки, BOM.
 * Заголовки узнаём по-русски и по-английски, порядок колонок любой.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  externalId: ['номер заказа', 'заказ', 'order', 'order id', 'externalid', 'id'],
  senderName: ['отправитель', 'sender'],
  senderPhone: ['телефон отправителя', 'sender phone'],
  recipientName: ['получатель', 'фио', 'клиент', 'recipient', 'name'],
  recipientPhone: ['телефон', 'телефон получателя', 'phone'],
  city: ['город', 'city'],
  address: ['адрес', 'улица', 'address', 'street'],
  house: ['дом', 'house'],
  apartment: ['квартира', 'кв', 'офис', 'apartment', 'flat'],
  entrance: ['подъезд', 'entrance'],
  floor: ['этаж', 'floor'],
  zoneName: ['зона', 'zone'],
  weightKg: ['вес', 'вес, кг', 'вес кг', 'weight'],
  lengthCm: ['длина', 'длина, см', 'length'],
  widthCm: ['ширина', 'ширина, см', 'width'],
  heightCm: ['высота', 'высота, см', 'height'],
  codRub: ['наложенный платёж', 'наложенный платеж', 'наложка', 'к оплате', 'cod'],
  pickupAddress: ['откуда', 'адрес забора', 'адрес отправителя', 'pickup'],
  vehicle: ['транспорт', 'vehicle'],
  comment: ['комментарий', 'comment'],
};

export interface CsvOrder { line: number; data: Record<string, string> }

export function mapRows(rows: string[][]): { orders: CsvOrder[]; missing: string[] } {
  const [head, ...rest] = rows;
  if (!head) return { orders: [], missing: ['заголовок'] };
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const idx: Record<string, number> = {};
  head.forEach((h, i) => {
    for (const [key, names] of Object.entries(ALIASES)) {
      if (idx[key] === undefined && names.map(norm).includes(norm(h))) idx[key] = i;
    }
  });
  const missing = ['recipientName', 'address'].filter((k) => idx[k] === undefined).map((k) => ALIASES[k][0]);
  const orders = rest.map((r, n) => ({
    line: n + 2,
    data: Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, r[i] ?? ''])),
  }));
  return { orders, missing };
}

export const num = (v?: string) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
