import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, ApiError, MyShipment, NetworkError } from './api';

/*
 * Офлайн-режим: если связи нет, вручение или отказ сохраняются в телефоне и отправляются,
 * как только сеть появится. Сервер принимает повтор без дублей (идемпотентно).
 */

const QUEUE_KEY = 'marshrut.queue';
const LIST_KEY = 'marshrut.list';

export interface QueuedAction {
  id: string;
  shipmentId: string;
  kind: 'deliver' | 'fail';
  body: Record<string, unknown>;
  createdAt: string;
  error?: string;
}

async function readQueue(): Promise<QueuedAction[]> {
  try { return JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]'); } catch { return []; }
}
const writeQueue = (q: QueuedAction[]) => AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));

export const pendingCount = async () => (await readQueue()).filter((a) => !a.error).length;

/** Выполнить действие сразу; без сети — поставить в очередь. Возвращает 'sent' или 'queued'. */
export async function perform(shipmentId: string, kind: QueuedAction['kind'], body: Record<string, unknown>) {
  const payload = { ...body, at: new Date().toISOString() };
  try {
    await api(`/shipments/${shipmentId}/${kind}`, payload);
    return 'sent' as const;
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e; // ошибку сервера (например, неверный код) показываем сразу
    const q = await readQueue();
    q.push({ id: `${Date.now()}-${Math.random()}`, shipmentId, kind, body: payload, createdAt: payload.at });
    await writeQueue(q);
    return 'queued' as const;
  }
}

let flushing = false;
/** Отправить накопленные действия. Вызывается при появлении сети и при обновлении списка. */
export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const q = await readQueue();
    const rest: QueuedAction[] = [];
    for (const a of q) {
      if (a.error) { rest.push(a); continue; }
      try {
        await api(`/shipments/${a.shipmentId}/${a.kind}`, a.body);
      } catch (e) {
        if (e instanceof NetworkError) { rest.push(a); continue; }
        rest.push({ ...a, error: e instanceof ApiError ? e.message : 'Ошибка отправки' });
      }
    }
    await writeQueue(rest);
  } finally {
    flushing = false;
  }
}

export async function dismissAll() {
  await writeQueue([]);
}

export async function dismissError(shipmentId: string) {
  await writeQueue((await readQueue()).filter((a) => a.shipmentId !== shipmentId));
}

/** Список с сервера; без сети — последний сохранённый. Поверх накладываются действия из очереди. */
export async function loadList(): Promise<{ items: MyShipment[]; offline: boolean }> {
  let items: MyShipment[]; let offline = false;
  try {
    await flush();
    items = await api<MyShipment[]>('/courier/my-shipments');
    await AsyncStorage.setItem(LIST_KEY, JSON.stringify(items));
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    offline = true;
    try { items = JSON.parse((await AsyncStorage.getItem(LIST_KEY)) ?? '[]'); } catch { items = []; }
  }
  const q = await readQueue();
  items = items.map((s) => {
    const a = q.find((x) => x.shipmentId === s.id);
    if (!a) return s;
    if (a.error) return { ...s, syncError: a.error };
    return { ...s, status: a.kind === 'deliver' ? 'delivered' : 'failed', pending: true };
  });
  return { items, offline };
}

export async function clearLocal() {
  await AsyncStorage.multiRemove([QUEUE_KEY, LIST_KEY]);
}
