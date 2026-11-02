import { createContext, useContext, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api } from '../api';
import { Field, useTheme } from '../ui';

export type VehicleId = 'foot' | 'bike' | 'car' | 'truck_m';
export interface Vehicle { id: VehicleId; label: string; short: string; maxKg: number; maxCm: [number, number, number] }
export interface Config { vehicles: Vehicle[]; feePercent: number; payWaitMinutes: number; testPayments: boolean; debtLimitRub: number }
export interface Requisites { companyName: string; inn: string; kpp?: string; ogrn?: string; legalAddress: string; bank?: string; bik?: string; account?: string; corrAccount?: string; director?: string; docsEmail?: string }
export interface Me {
  id: string; phone: string; lastName: string; firstName: string; middleName: string; name: string; email: string | null;
  kind: 'person' | 'company'; selfEmployed: boolean; inn: string | null; requisites: Requisites | null; registeredAt: string | null;
  hasCard: boolean; cardLast4: string | null; cardBrand: string | null; debtRub: number; blocked: boolean;
}
export interface PayResp { status: string; paymentId?: string; confirmationUrl?: string | null; shipmentId?: string; me?: Me }

export const CustomerCtx = createContext<{ me: Me; setMe: (m: Me) => void; reload: () => Promise<void>; logout: () => Promise<void>; config: Config }>(null as any);
export const useCustomer = () => useContext(CustomerCtx);
export const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

/**
 * Платёж с подтверждением в банке (3-D Secure): открываем страницу банка во встроенном браузере,
 * после закрытия проверяем статус на сервере. В тестовом режиме страницы банка нет — всё сразу.
 */
export async function withBank(start: () => Promise<PayResp>, check: (r: PayResp) => Promise<PayResp>): Promise<PayResp> {
  const r = await start();
  if (!r.confirmationUrl) return r;
  await WebBrowser.openBrowserAsync(r.confirmationUrl, { dismissButtonStyle: 'close' });
  const after = await check(r);
  if (after.status === 'pending') throw new Error('Банк ещё не подтвердил платёж. Если вы подтвердили — подождите минуту и откройте экран снова.');
  return after;
}

export function stage(o: { status: string; pickedUpAt: string | null; waitingCourier?: boolean }): [string, 'ok' | 'warn' | 'bad' | 'muted'] {
  if (o.status === 'delivered') return ['Доставлено', 'ok'];
  if (o.status === 'failed') return ['Не удалось доставить', 'bad'];
  if (o.status === 'returned') return ['Отменён', 'bad'];
  if (o.status === 'assigned') return o.pickedUpAt ? ['Едет к получателю', 'warn'] : ['Курьер едет за грузом', 'warn'];
  return ['Ищем курьера', 'muted'];
}

/** Город с подсказками (встроенный список или DaData на сервере). */
export function CityField({ value, onChange, label = 'Город' }: { value: string; onChange: (v: string) => void; label?: string }) {
  const t = useTheme();
  const [hints, setHints] = useState<string[]>([]);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus || value.trim().length < 2) { setHints([]); return; }
    const id = setTimeout(() => api<string[]>(`/public/cities?q=${encodeURIComponent(value.trim())}`)
      .then((r) => setHints(r.filter((x) => x !== value.trim()).slice(0, 5))).catch(() => setHints([])), 250);
    return () => clearTimeout(id);
  }, [value, focus]);
  return <View style={{ gap: 6 }}>
    <Field label={label} value={value} onChangeText={onChange} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 200)} autoCorrect={false} />
    {hints.map((h) => <Pressable key={h} onPress={() => { onChange(h); setHints([]); }} style={{ paddingVertical: 8, paddingHorizontal: 12, backgroundColor: t.panel, borderRadius: 8, borderWidth: 1, borderColor: t.line }}>
      <Text style={{ color: t.ink }}>{h}</Text></Pressable>)}
  </View>;
}

/** Выбор из нескольких вариантов кнопками. */
export function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
    {options.map(([v, l]) => <Pressable key={v} onPress={() => onChange(v)} accessibilityRole="radio" accessibilityState={{ selected: value === v }}
      style={{ flexGrow: 1, flexBasis: '45%', minHeight: 46, borderRadius: 12, borderWidth: value === v ? 2 : 1, borderColor: value === v ? t.brand : t.line, backgroundColor: t.panel, alignItems: 'center', justifyContent: 'center', padding: 8 }}>
      <Text style={{ color: t.ink, fontWeight: value === v ? '700' : '400', textAlign: 'center' }}>{l}</Text>
    </Pressable>)}
  </View>;
}
