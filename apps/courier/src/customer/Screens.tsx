import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, Vibration, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import { api } from '../api';
import { Button, Card, Field, Row, Section, useTheme } from '../ui';
import { IdeaForm } from '../idea';
import { LiveMap } from '../map';
import { distanceKm } from '../geo';
import { bindCard, ProfileForm } from './Auth';
import { CityField, Me, PayResp, rub, stage, useCustomer, VehicleId, withBank } from './shared';

export type CustomerStack = { CHome: undefined; CNew: undefined; COrder: { id: string }; CProfile: undefined };
type P<K extends keyof CustomerStack> = NativeStackScreenProps<CustomerStack, K>;

/** Автообновление экрана: по таймеру и при возврате в приложение. */
function usePoll(fn: () => void, ms: number) {
  useEffect(() => {
    const id = setInterval(fn, ms);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') fn(); });
    return () => { clearInterval(id); sub.remove(); };
  }, [fn, ms]);
}

/* ---------- Долг ---------- */

/** Не прошла оплата прошлой доставки — новые заказы недоступны, пока долг не погашен. */
export function DebtCard({ onPaid }: { onPaid?: () => void }) {
  const t = useTheme();
  const { me, setMe } = useCustomer();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!me.debtRub) return null;
  async function pay() {
    setBusy(true); setErr('');
    try {
      const r = await withBank(() => api<PayResp>('/client/debt/pay', {}), (x) => api<PayResp>('/client/debt/check', { paymentId: x.paymentId }));
      if (r.me) setMe(r.me);
      onPaid?.();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <Card style={{ borderColor: t.bad, borderWidth: 2 }}>
    <Text style={{ color: t.bad, fontSize: 18, fontWeight: '700' }}>Оплата не прошла: {rub(me.debtRub)}</Text>
    <Text style={{ color: t.ink }}>Не удалось списать оплату за доставку с карты •••• {me.cardLast4}. Новые заказы недоступны, пока долг не погашен. Пополните карту или привяжите другую в профиле.</Text>
    {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
    <Button title={`Оплатить ${rub(me.debtRub)}`} busy={busy} onPress={pay} />
  </Card>;
}

/* ---------- Главная ---------- */

interface Home {
  orders: { id: string; trackingNumber: string; status: string; address: string; pickupAddress: string | null; recipientName: string; priceRub: number; pickedUpAt: string | null; rating: number | null; company: string; payStatus: string }[];
  debtRub: number;
}

export function HomeScreen({ navigation }: P<'CHome'>) {
  const t = useTheme();
  const { me, reload } = useCustomer();
  const [d, setD] = useState<Home | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (silent = true) => {
    if (!silent) setLoading(true);
    try { const r = await api<Home>('/client/orders'); setD(r); if (r.debtRub !== me.debtRub) reload().catch(() => {}); } catch { /* нет сети */ } finally { setLoading(false); }
  }, [me.debtRub, reload]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  usePoll(load, 15_000);
  useEffect(() => {
    navigation.setOptions({ headerRight: () => <Pressable onPress={() => navigation.navigate('CProfile')} hitSlop={12}><Text style={{ color: t.brand, fontSize: 16 }}>Профиль</Text></Pressable> });
  }, [navigation, t.brand]);

  const active = d?.orders.filter((o) => ['created', 'at_warehouse', 'assigned'].includes(o.status)) ?? [];
  const past = d?.orders.filter((o) => !active.includes(o)) ?? [];
  const color = (k: string) => (k === 'ok' ? t.ok : k === 'bad' ? t.bad : k === 'warn' ? t.warn : t.muted);

  return <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}
    refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(false)} tintColor={t.brand} />}>
    <Text style={{ color: t.ink, fontSize: 18 }}>Здравствуйте, {me.firstName}!</Text>
    <DebtCard onPaid={() => load()} />
    {!me.blocked && <Button title="Рассчитать и заказать доставку" onPress={() => navigation.navigate('CNew')} />}
    {[['В работе', active] as const, ['История', past] as const].map(([title, list]) => list.length > 0 && <View key={title} style={{ gap: 12 }}>
      <Text style={{ color: t.ink, fontSize: 18, fontWeight: '700' }}>{title}</Text>
      {list.map((o) => { const [l, k] = stage(o); return <Pressable key={o.id} onPress={() => navigation.navigate('COrder', { id: o.id })}><Card style={{ opacity: title === 'История' ? 0.8 : 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ color: t.muted, flexShrink: 1 }} numberOfLines={1}>{o.trackingNumber} · {o.company}</Text>
          <Text style={{ color: color(k), fontWeight: '600' }}>{l}</Text>
        </View>
        <Text style={{ color: t.ink, fontWeight: '600' }}>{o.address}</Text>
        <Text style={{ color: o.payStatus === 'failed' ? t.bad : t.muted }}>{rub(o.priceRub)}{o.payStatus === 'failed' ? ' · оплата не прошла' : o.status === 'delivered' && !o.rating ? ' · оцените курьера' : ''}</Text>
      </Card></Pressable>; })}
    </View>)}
    {d && !d.orders.length && <Text style={{ color: t.muted, textAlign: 'center', marginTop: 24 }}>Здесь появятся ваши доставки.</Text>}
  </ScrollView>;
}

/* ---------- Калькулятор и оформление ---------- */

const PRESETS: [string, number, number, number, number][] = [
  ['Документы', 0.5, 35, 25, 2], ['Коробка до 5 кг', 5, 40, 30, 25], ['Крупная до 15 кг', 15, 50, 40, 40], ['Мебель, техника', 80, 150, 80, 80], ['Паллета', 500, 120, 80, 150],
];
interface Calc { distanceKm: number | null; distanceApprox: boolean; night: boolean; recommended: VehicleId | null; vehicle: VehicleId | null; vehicles: { id: VehicleId; label: string; problem: string | null; priceRub: number | null }[]; priceRub: number | null; courierRub: number | null; feePercent: number }

export function NewOrderScreen({ navigation }: P<'CNew'>) {
  const t = useTheme();
  const { me, config } = useCustomer();
  const [city, setCity] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [to, setTo] = useState({ street: '', house: '', apartment: '', entrance: '', floor: '', intercom: '' });
  const [privateHouse, setPrivateHouse] = useState(false);
  const toAddress = [to.street.trim(), to.house.trim()].filter(Boolean).join(', ');
  const [toPoint, setToPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [gps, setGps] = useState('');
  const [cargo, setCargo] = useState({ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 });
  const [vehicle, setVehicle] = useState<VehicleId | null>(null);
  const [calc, setCalc] = useState<Calc | null>(null);
  const [o, setO] = useState({ description: '', recipientName: '', recipientPhone: '+7', comment: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  /** Куда доставить — по GPS заказчика: адрес определяет телефон, при неудаче — сервер. Адрес можно исправить. */
  const locate = useCallback(async () => {
    setGps('Определяем адрес…');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) { setGps('Нет доступа к геопозиции. Введите адрес вручную.'); return; }
      const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const point = { lat: p.coords.latitude, lng: p.coords.longitude };
      setToPoint(point);
      let address = '', place = '';
      const [g] = await Location.reverseGeocodeAsync({ latitude: point.lat, longitude: point.lng }).catch(() => []);
      let street = '', house = '';
      if (g) { street = g.street ?? ''; house = g.streetNumber ?? ''; address = [street, house].filter(Boolean).join(', '); place = g.city ?? g.subregion ?? ''; }
      if (!address) { const r = await api<{ address: string; city: string }>(`/client/reverse?lat=${point.lat}&lng=${point.lng}`).catch(() => null); address = r?.address ?? ''; place = place || r?.city || ''; }
      if (!street && address) { const i = address.lastIndexOf(','); street = i > 0 ? address.slice(0, i).trim() : address; house = i > 0 ? address.slice(i + 1).trim() : ''; }
      if (street) setTo((t) => ({ ...t, street, house: house || t.house }));
      if (place) setCity((c) => c || place);
      setGps(address ? 'Улица и дом определены по GPS — проверьте и укажите квартиру.' : 'Местоположение получено. Укажите улицу и дом вручную.');
    } catch { setGps('Не удалось определить адрес. Введите его вручную.'); }
  }, []);
  const asked = useRef(false);
  useEffect(() => { if (!asked.current) { asked.current = true; locate(); } }, [locate]);

  const payload = { city: city.trim(), fromAddress: fromAddress.trim() || undefined, toAddress: toAddress.trim() || undefined, toLat: toPoint?.lat, toLng: toPoint?.lng, ...cargo, vehicle: vehicle ?? undefined };
  const key = JSON.stringify(payload);
  useEffect(() => {
    if (payload.city.length < 2 || !(cargo.weightKg > 0)) { setCalc(null); return; }
    const id = setTimeout(() => {
      api<Calc>('/client/calc', payload).then((c) => { setCalc(c); setErr(''); if (c.vehicle !== vehicle) setVehicle(c.vehicle); }).catch((e) => setErr(e.message));
    }, 500);
    return () => clearTimeout(id);
  }, [key]);

  const numField = (k: keyof typeof cargo, label: string) => <Field label={label} keyboardType="decimal-pad" value={cargo[k] ? String(cargo[k]) : ''}
    onChangeText={(v) => setCargo({ ...cargo, [k]: k === 'weightKg' ? Number(v.replace(',', '.')) || 0 : Math.round(Number(v) || 0) })} style={{ flex: 1 }} />;

  async function submit() {
    if (!vehicle) { setErr('Выберите транспорт'); return; }
    setBusy(true); setErr('');
    try {
      let id = '';
      await withBank(
        async () => { const r = await api<PayResp & { id: string }>('/client/orders', { ...payload, toAddress: undefined, fromAddress: fromAddress.trim(), vehicle,
          toStreet: to.street.trim(), toHouse: to.house.trim(), toApartment: privateHouse ? 'частный дом' : to.apartment.trim(),
          toEntrance: to.entrance || undefined, toFloor: to.floor || undefined, toIntercom: to.intercom || undefined,
          recipientName: o.recipientName, recipientPhone: o.recipientPhone, description: o.description || undefined, comment: o.comment || undefined }); id = r.id; return r; },
        () => api<PayResp>(`/client/orders/${id}/pay-check`, {}),
      );
      navigation.replace('COrder', { id });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (me.blocked) return <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16 }}><DebtCard onPaid={() => navigation.goBack()} /></ScrollView>;

  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.bg }}>
    <ScrollView contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Section title="Откуда и куда">
        <View style={{ padding: 16, gap: 12 }}>
          <CityField value={city} onChange={setCity} />
          <Field label="Откуда забрать — улица, дом, подъезд" value={fromAddress} onChangeText={setFromAddress} />
          <Field label="Куда: улица" value={to.street} onChangeText={(v) => { setTo({ ...to, street: v }); setToPoint(null); }} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Дом" value={to.house} onChangeText={(v) => { setTo({ ...to, house: v }); setToPoint(null); }} style={{ flex: 1 }} />
            <Field label={privateHouse ? 'Частный дом' : 'Квартира / офис'} value={privateHouse ? '—' : to.apartment} editable={!privateHouse} onChangeText={(v) => setTo({ ...to, apartment: v })} style={{ flex: 1 }} />
          </View>
          <Pressable onPress={() => setPrivateHouse(!privateHouse)} accessibilityRole="checkbox" accessibilityState={{ checked: privateHouse }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: privateHouse ? t.brand : t.line, backgroundColor: privateHouse ? t.brand : 'transparent' }} />
            <Text style={{ color: t.ink }}>Частный дом (без квартиры)</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Подъезд" value={to.entrance} onChangeText={(v) => setTo({ ...to, entrance: v })} style={{ flex: 1 }} />
            <Field label="Этаж" value={to.floor} onChangeText={(v) => setTo({ ...to, floor: v })} style={{ flex: 1 }} />
            <Field label="Домофон" value={to.intercom} onChangeText={(v) => setTo({ ...to, intercom: v })} style={{ flex: 1 }} />
          </View>
          <Button title="Определить по GPS" kind="secondary" onPress={locate} />
          {!!gps && <Text style={{ color: t.muted }}>{gps}</Text>}
        </View>
      </Section>

      <Section title="Что везём">
        <View style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {PRESETS.map(([l, w, a, b, c]) => <Pressable key={l} onPress={() => setCargo({ weightKg: w, lengthCm: a, widthCm: b, heightCm: c })}
              style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: t.line }}><Text style={{ color: t.ink }}>{l}</Text></Pressable>)}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>{numField('weightKg', 'Вес, кг')}{numField('lengthCm', 'Длина, см')}</View>
          <View style={{ flexDirection: 'row', gap: 8 }}>{numField('widthCm', 'Ширина, см')}{numField('heightCm', 'Высота, см')}</View>
          <Field label="Описание груза" value={o.description} onChangeText={(v) => setO({ ...o, description: v })} placeholder="3 коробки, хрупкое" />
        </View>
      </Section>

      <Section title="Кто повезёт">
        {(calc?.vehicles ?? config.vehicles.map((v) => ({ id: v.id, label: v.label, problem: null }))).map((v, i, all) => {
          const spec = config.vehicles.find((x) => x.id === v.id)!;
          return <Pressable key={v.id} disabled={!!v.problem} onPress={() => setVehicle(v.id)} accessibilityRole="radio" accessibilityState={{ selected: vehicle === v.id, disabled: !!v.problem }}
            style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: v.problem ? 0.45 : 1, borderBottomWidth: i === all.length - 1 ? 0 : 1, borderColor: t.line }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: vehicle === v.id ? t.brand : t.line, alignItems: 'center', justifyContent: 'center' }}>
              {vehicle === v.id && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: t.brand }} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.ink, fontSize: 16, fontWeight: '600' }}>{v.label}</Text>
              <Text style={{ color: v.problem ? t.bad : calc?.recommended === v.id ? t.ok : t.muted, fontSize: 13 }}>
                {v.problem ? `не подходит: ${v.problem}` : `до ${spec.maxKg.toLocaleString('ru-RU')} кг${'priceRub' in v && v.priceRub != null ? ` · ${rub(v.priceRub as number)}` : ''}${calc?.recommended === v.id ? ' · оптимально' : ''}`}</Text>
            </View>
          </Pressable>;
        })}
      </Section>
      {calc && <Card>
        {calc.distanceKm != null && <Text style={{ color: t.muted }}>{calc.distanceApprox ? '≈ ' : ''}{calc.distanceKm} км{calc.distanceApprox ? ' (уточнится по адресам)' : ''}{calc.night ? ' · ночной тариф' : ''}</Text>}
        <Text style={{ color: t.ink, fontSize: 24, fontWeight: '700' }}>{calc.priceRub != null ? rub(calc.priceRub) : 'укажите точные адреса'}</Text>
        <Text style={{ color: t.muted }}>Подача + километры + вес{calc.night ? ' + ночная надбавка' : ''}. Сумма зарезервируется на карте и спишется после вручения. Получатель ничего не платит.</Text>
      </Card>}

      <Section title="Получатель">
        <View style={{ padding: 16, gap: 12 }}>
          <Field label="Имя получателя" value={o.recipientName} onChangeText={(v) => setO({ ...o, recipientName: v })} />
          <Field label="Телефон получателя" value={o.recipientPhone} onChangeText={(v) => setO({ ...o, recipientPhone: v })} keyboardType="phone-pad" />
          <Field label="Комментарий курьеру" value={o.comment} onChangeText={(v) => setO({ ...o, comment: v })} placeholder="Домофон, этаж, время" />
          <Text style={{ color: t.muted }}>Оплата картой •••• {me.cardLast4}.</Text>
        </View>
      </Section>
      {!!err && <Text style={{ color: t.bad, fontSize: 15 }}>{err}</Text>}
      <Button title={calc?.priceRub != null ? `Заказать за ${rub(calc.priceRub)}` : 'Заказать'} busy={busy} onPress={submit}
        disabled={!vehicle || calc?.priceRub == null || fromAddress.trim().length < 5 || to.street.trim().length < 3 || !to.house.trim() || (!privateHouse && !to.apartment.trim()) || o.recipientName.trim().length < 2 || o.recipientPhone.replace(/\D/g, '').length < 11} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

/* ---------- Заказ ---------- */

interface Order {
  id: string; trackingNumber: string; status: string; priceRub: number; pickupAddress: string | null; address: string; recipientName: string; recipientPhone: string | null;
  payStatus: string; payText: string; vehicle: string | null; pickedUpAt: string | null; failReason: string | null; rating: number | null; tipRub: number;
  company: { name: string; phone: string | null } | null; waitingCourier: boolean; confirmCode: string | null;
  courier: { name: string; phone: string | null; vehicle: string | null; rating: number | null; ratingCount: number; location: { lat: number; lng: number } | null } | null;
  pickupPoint: { lat: number; lng: number } | null; deliveryPoint: { lat: number; lng: number } | null;
  events: { status: string; note: string | null; at: string }[];
}

export function OrderScreen({ route }: P<'COrder'>) {
  const t = useTheme();
  const { me, reload } = useCustomer();
  const id = route.params.id;
  const [o, setO] = useState<Order | null>(null);
  const [err, setErr] = useState('');
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [tip, setTip] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<Order>(`/client/orders/${id}`).then(setO).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => { load(); }, [load]);
  usePoll(load, 10_000);

  const act = async (fn: () => Promise<Order>) => { setBusy(true); setErr(''); try { setO(await fn()); reload().catch(() => {}); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  if (!o) return <View style={{ flex: 1, backgroundColor: t.bg, padding: 16 }}><Text style={{ color: err ? t.bad : t.muted }}>{err || 'Загрузка…'}</Text></View>;
  const [label, k] = stage(o);

  return <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ color: t.muted }}>{o.trackingNumber}</Text>
        <Text style={{ color: k === 'ok' ? t.ok : k === 'bad' ? t.bad : k === 'warn' ? t.warn : t.muted, fontWeight: '700' }}>{label}</Text>
      </View>
      {o.waitingCourier && <Text style={{ color: t.muted }}>Заказ предложен курьерам с подходящим транспортом — повезёт первый, кто примет.</Text>}
      {!!o.company && <Text style={{ color: t.ink }}>Служба: {o.company.name}</Text>}
      <Text style={{ color: t.ink }}>Откуда: {o.pickupAddress}</Text>
      <Text style={{ color: t.ink }}>Куда: {o.address}</Text>
      <Text style={{ color: t.ink }}>Получатель: {o.recipientName}</Text>
      <Text style={{ color: t.ink, fontSize: 18, fontWeight: '700' }}>{rub(o.priceRub)}</Text>
      {!!o.payText && <Text style={{ color: o.payStatus === 'failed' ? t.bad : t.muted }}>{o.payText}</Text>}
      {!!o.confirmCode && <Text style={{ color: t.ink }}>Код для получения: <Text style={{ fontWeight: '700', letterSpacing: 4 }}>{o.confirmCode}</Text> — передайте его получателю: он называет код курьеру.</Text>}
      {!!o.failReason && <Text style={{ color: t.bad }}>{o.failReason}</Text>}
    </Card>
    {o.payStatus === 'failed' && <DebtCard onPaid={load} />}
    {o.status === 'assigned' && !!o.courier?.location && <View style={{ gap: 6 }}>
      <LiveMap courier={o.courier.location} pickup={o.pickedUpAt ? null : o.pickupPoint} delivery={o.deliveryPoint} />
      <Text style={{ color: t.muted }}>{o.pickedUpAt && o.deliveryPoint ? `Курьер в ${distanceKm(o.courier.location, o.deliveryPoint).toFixed(1)} км от получателя` : o.pickupPoint ? `Курьер в ${distanceKm(o.courier.location, o.pickupPoint).toFixed(1)} км от места забора` : 'Местоположение курьера'} · обновляется каждые 10 секунд</Text>
    </View>}
    {!!o.courier && <Card>
      <Text style={{ color: t.muted }}>Курьер</Text>
      <Text style={{ color: t.ink, fontSize: 17, fontWeight: '700' }}>{o.courier.name}{o.courier.vehicle ? ` · ${o.courier.vehicle}` : ''}</Text>
      <Text style={{ color: t.muted }}>{o.courier.rating ? `★ ${o.courier.rating} (${o.courier.ratingCount} оценок)` : 'пока без оценок'}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {!!o.courier.phone && <Button style={{ flex: 1 }} kind="secondary" title="Позвонить" onPress={() => Linking.openURL(`tel:${o.courier!.phone}`)} />}
        {!!o.courier.location && <Button style={{ flex: 1 }} kind="secondary" title="Где курьер" onPress={() => Linking.openURL(`https://yandex.ru/maps/?pt=${o.courier!.location!.lng},${o.courier!.location!.lat}&z=16&l=map`)} />}
      </View>
    </Card>}
    {o.status === 'delivered' && !o.rating && <Card>
      <Text style={{ color: t.ink, fontSize: 18, fontWeight: '700' }}>Как прошла доставка?</Text>
      <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="radiogroup">
        {[1, 2, 3, 4, 5].map((n) => <Pressable key={n} onPress={() => setRating(n)} accessibilityRole="radio" accessibilityLabel={`${n} из 5`} accessibilityState={{ selected: rating === n }} hitSlop={6}>
          <Text style={{ fontSize: 36, color: n <= rating ? '#f5b301' : t.line }}>★</Text></Pressable>)}
      </View>
      <Field label="Отзыв (необязательно)" value={comment} onChangeText={setComment} multiline />
      <Text style={{ color: t.muted }}>Чаевые курьеру — спишутся с карты •••• {me.cardLast4} и полностью достанутся курьеру</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {[0, 50, 100, 200, 300].map((v) => <Pressable key={v} onPress={() => setTip(v)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: tip === v ? 2 : 1, borderColor: tip === v ? t.brand : t.line }}>
          <Text style={{ color: t.ink }}>{v ? rub(v) : 'Без чаевых'}</Text></Pressable>)}
        <TextInput placeholder="Другая сумма" placeholderTextColor={t.muted} keyboardType="number-pad" value={tip && ![50, 100, 200, 300].includes(tip) ? String(tip) : ''}
          onChangeText={(v) => setTip(Number(v.replace(/\D/g, '')) || 0)} style={{ color: t.ink, borderWidth: 1, borderColor: t.line, borderRadius: 20, paddingHorizontal: 14, minWidth: 120 }} />
      </View>
      <Button title={tip ? `Оценить и оставить ${rub(tip)}` : 'Оценить'} busy={busy} onPress={() => act(() => api<Order>(`/client/orders/${id}/rate`, { rating, comment: comment || undefined, tipRub: tip }))} />
    </Card>}
    {!!o.rating && <Card><Text style={{ color: t.ink }}>Ваша оценка: {'★'.repeat(o.rating)}{'☆'.repeat(5 - o.rating)}{o.tipRub ? ` · чаевые ${rub(o.tipRub)}` : ''}. Спасибо!</Text></Card>}
    <Section title="История">
      {o.events.map((e, i) => <Row key={i} label={stage({ status: e.status, pickedUpAt: e.note === 'Курьер забрал посылку' ? 'x' : null })[0] + (e.note && e.note !== 'Курьер забрал посылку' && !e.note.startsWith('Курьер:') ? ` — ${e.note}` : '')}
        value={new Date(e.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} last={i === o.events.length - 1} />)}
    </Section>
    {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
    {['created', 'at_warehouse', 'assigned'].includes(o.status) && !o.pickedUpAt && <Button title="Отменить заказ" kind="secondary" busy={busy}
      onPress={() => Alert.alert('Отменить заказ?', 'Резерв на карте снимется, деньги вернутся на карту.', [
        { text: 'Нет', style: 'cancel' }, { text: 'Отменить', style: 'destructive', onPress: () => act(() => api<Order>(`/client/orders/${id}/cancel`, {})) },
      ])} />}
  </ScrollView>;
}

/* ---------- Профиль ---------- */

export function ProfileScreen() {
  const t = useTheme();
  const { me, setMe, logout } = useCustomer();
  const [edit, setEdit] = useState<null | 'profile' | 'idea'>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const run = async (fn: () => Promise<Me>, ok: string) => { setBusy(true); setMsg({}); try { setMe(await fn()); setMsg({ ok }); } catch (e: any) { setMsg({ err: e.message }); } finally { setBusy(false); } };

  return <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
    {!!msg.ok && <Text style={{ color: t.ok }}>{msg.ok}</Text>}
    {!!msg.err && <Text style={{ color: t.bad }}>{msg.err}</Text>}
    <DebtCard />
    <Section title="Профиль">
      {edit === 'profile' ? <View style={{ padding: 16 }}><ProfileForm me={me} onSaved={(m) => { setMe(m); setEdit(null); setMsg({ ok: 'Профиль сохранён' }); }} /></View> : <>
        <Row label="ФИО" value={[me.lastName, me.firstName, me.middleName].filter(Boolean).join(' ')} />
        <Row label="Телефон" value={me.phone} />
        <Row label={me.kind === 'company' ? 'Компания' : 'Физическое лицо'} value={me.kind === 'company' ? me.requisites?.companyName : me.selfEmployed ? `самозанятый, ИНН ${me.inn}` : undefined} />
        <Row label="Изменить" onPress={() => setEdit('profile')} last />
      </>}
    </Section>
    <Section title="Карта для оплаты" footer="Оплата доставки только картой: при выборе службы сумма резервируется, после вручения списывается, при отмене возвращается на карту.">
      <Row label={me.hasCard ? `${me.cardBrand ?? 'Карта'} •••• ${me.cardLast4}` : 'Карта не привязана'} />
      <Row label={me.hasCard ? 'Заменить карту' : 'Привязать карту'} onPress={busy ? undefined : () => run(bindCard, 'Карта привязана')} last={!me.hasCard} />
      {me.hasCard && <Row label="Отвязать карту" danger last onPress={busy ? undefined : () => run(() => api<Me>('/client/card', undefined, 'DELETE'), 'Карта отвязана')} />}
    </Section>
    <Section title="Предложить доработку">
      {edit === 'idea' ? <View style={{ padding: 16 }}><IdeaForm source="client_app" name={me.name} email={me.email ?? ''} phone={me.phone} onDone={() => { setEdit(null); setMsg({ ok: 'Спасибо! Предложение отправлено.' }); }} /></View>
        : <Row label="Что улучшить в приложении?" onPress={() => setEdit('idea')} last />}
    </Section>
    <Button title="Выйти" kind="danger" onPress={() => Alert.alert('Выйти?', 'Чтобы войти снова, понадобится код из SMS.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Выйти', style: 'destructive', onPress: logout }])} />
  </ScrollView>;
}
