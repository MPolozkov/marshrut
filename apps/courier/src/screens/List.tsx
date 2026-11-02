import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, FlatList, Pressable, RefreshControl, Switch, Text, Vibration, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Location from 'expo-location';
import type { RootStack } from '../../App';
import { api, MyShipment } from '../api';
import { loadList, pendingCount } from '../queue';
import { useProfile } from '../profile';
import { Button, Card, STATUS, useTheme } from '../ui';
import { registerPush } from '../push';

type Props = NativeStackScreenProps<RootStack, 'List'>;
interface Offer {
  id: string; trackingNumber: string; pickupAddress: string | null; address: string; city: string;
  vehicleLabel: string | null; weightKg: number; dims: string; comment: string | null; priceRub: number; payRub: number; codRub: number; distanceKm: number | null;
}
interface Stats { today: { delivered: number; payRub: number; tipsRub: number }; rating: number | null; ratingCount: number }
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

export function ListScreen({ navigation }: Props) {
  const t = useTheme();
  const { profile, reload } = useProfile();
  const [items, setItems] = useState<MyShipment[]>([]);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [onShift, setOnShift] = useState<boolean>(profile?.active ?? false);
  const [stats, setStats] = useState<Stats | null>(null);
  const known = useRef<Set<string> | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const seenOffers = useRef<Set<string> | null>(null);
  const [taking, setTaking] = useState('');

  /** Доступные заказы: подходят по транспорту и городу; ближайшие видят их первыми. */
  const loadOffers = useCallback(async () => {
    try {
      const list = await api<Offer[]>('/courier/offers');
      const fresh = seenOffers.current ? list.filter((o) => !seenOffers.current!.has(o.id)) : [];
      seenOffers.current = new Set(list.map((o) => o.id));
      setOffers(list);
      if (fresh.length) Vibration.vibrate([0, 200, 100, 200]);
    } catch { /* нет сети — покажем в следующий раз */ }
  }, []);

  async function take(o: Offer) {
    setTaking(o.id); setErr('');
    try {
      await api(`/courier/offers/${o.id}/accept`, {});
      Vibration.vibrate(100);
      setOffers((l) => l.filter((x) => x.id !== o.id));
      await refresh(true);
      navigation.navigate('Shipment', { id: o.id });
    } catch (e: any) { Alert.alert('Не получилось', e.message); loadOffers(); } finally { setTaking(''); }
  }

  /** Обновить список. Новые назначенные заказы — вибрация и уведомление на экране. */
  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setErr('');
    try {
      const r = await loadList();
      const fresh = r.items.filter((s) => s.status === 'assigned' && known.current && !known.current.has(s.id));
      known.current = new Set(r.items.map((s) => s.id));
      setItems(r.items); setOffline(r.offline); setPending(await pendingCount());
      if (fresh.length) {
        Vibration.vibrate([0, 300, 150, 300]);
        Alert.alert(fresh.length === 1 ? 'Новый заказ' : `Новых заказов: ${fresh.length}`,
          fresh.map((s) => s.pickupAddress ? `Забрать: ${s.pickupAddress}` : s.address).join('\n'));
      }
      api<Stats>('/courier/stats').then(setStats).catch(() => {});
      loadOffers();
    } catch (e: any) { setErr(e.message); } finally { if (!silent) setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  // Автообновление: каждые 15 секунд и при возвращении в приложение.
  useEffect(() => {
    const id = setInterval(() => refresh(true), 15_000);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') { refresh(true); reload().catch(() => {}); } });
    return () => { clearInterval(id); sub.remove(); };
  }, [refresh, reload]);
  // Доступные заказы обновляем чаще: их разбирают быстро.
  useEffect(() => {
    if (!onShift) { setOffers([]); return; }
    loadOffers();
    const id = setInterval(loadOffers, 7_000);
    return () => clearInterval(id);
  }, [onShift, loadOffers]);

  // Геопозиция раз в минуту, пока курьер на линии и приложение открыто: по ней назначаются ближайшие заказы.
  const hasActive = items.some((x) => x.status === 'assigned');
  useEffect(() => {
    if (!onShift && !hasActive) return;
    let stop = false;
    const send = async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted) return;
        const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!stop) await api('/courier/location', { lat: p.coords.latitude, lng: p.coords.longitude });
      } catch { /* нет сети или GPS — попробуем в следующий раз */ }
    };
    send();
    // С заказом на руках — каждые 15 секунд: заказчик видит курьера на карте. Без заказа — раз в минуту.
    const id = setInterval(send, hasActive ? 15_000 : 60_000);
    return () => { stop = true; clearInterval(id); };
  }, [onShift, hasActive]);
  useEffect(() => { registerPush().catch(() => {}); }, []);

  useEffect(() => { if (profile) setOnShift(profile.active); }, [profile?.active]);
  useEffect(() => {
    navigation.setOptions({ headerRight: () => <Pressable onPress={() => navigation.navigate('Settings')} hitSlop={12}><Text style={{ color: t.brand, fontSize: 16 }}>Настройки</Text></Pressable> });
  }, [navigation, t.brand]);

  async function toggleShift(v: boolean) {
    setOnShift(v);
    if (v) await Location.requestForegroundPermissionsAsync().catch(() => {});
    try { await api('/courier/shift', { active: v }); reload().catch(() => {}); } catch (e: any) { setOnShift(!v); setErr(e.message); }
  }

  const active = items.filter((s) => s.status === 'assigned');
  const done = items.filter((s) => s.status !== 'assigned');
  const codToHand = items.filter((s) => s.status === 'delivered').reduce((a, s) => a + s.codRub, 0);

  return (
    <FlatList
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      data={[...active, ...done]}
      keyExtractor={(s) => s.id}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => refresh()} tintColor={t.brand} />}
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: t.ink, fontSize: 16, fontWeight: '600' }}>{onShift ? 'На линии' : 'Не на линии'}</Text>
              <Text style={{ color: t.muted }} numberOfLines={2}>{onShift ? 'Новые заказы приходят автоматически' : 'Включите, чтобы получать заказы'}</Text>
            </View>
            <View style={{ flexShrink: 0 }}>
              <Switch value={onShift} onValueChange={toggleShift} trackColor={{ true: t.brand }} />
            </View>
          </Card>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <Card style={{ flex: 1 }}><Text style={{ color: t.muted }}>Заработано сегодня</Text>
              <Text style={{ color: t.ink, fontSize: 22, fontWeight: '700' }}>{rub((stats?.today.payRub ?? 0) + (stats?.today.tipsRub ?? 0))}</Text>
              {!!stats?.today.tipsRub && <Text style={{ color: t.muted, fontSize: 13 }}>в т. ч. чаевые {rub(stats.today.tipsRub)}</Text>}</Card>
            <Card style={{ flex: 1 }}><Text style={{ color: t.muted }}>Осталось</Text>
              <Text style={{ color: t.ink, fontSize: 22, fontWeight: '700' }}>{active.length}</Text>
              {stats?.rating != null && <Text style={{ color: t.muted, fontSize: 13 }}>★ {stats.rating} · {stats.ratingCount} оценок</Text>}</Card>
          </View>
          {codToHand > 0 && <Card><Text style={{ color: t.muted }}>Сдать в кассу наложенный платёж</Text><Text style={{ color: t.warn, fontSize: 20, fontWeight: '700' }}>{rub(codToHand)}</Text></Card>}
          {offline && <Text style={{ color: t.warn }}>Нет связи. Показан последний сохранённый список.</Text>}
          {pending > 0 && <Text style={{ color: t.warn }}>Ждут отправки: {pending}. Уйдут автоматически, когда появится сеть.</Text>}
          {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
          {offers.length > 0 && <Text style={{ color: t.ink, fontSize: 18, fontWeight: '700', marginTop: 4 }}>Доступные заказы · {offers.length}</Text>}
          {offers.map((o) => (
            <Card key={o.id} style={{ borderColor: t.brand, borderWidth: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={{ color: t.muted, flexShrink: 1 }} numberOfLines={1}>{o.distanceKm != null ? `${o.distanceKm} км до забора` : o.city}{o.vehicleLabel ? ` · ${o.vehicleLabel}` : ''}</Text>
                <Text style={{ color: t.ok, fontWeight: '700', fontSize: 18, flexShrink: 0 }}>{rub(o.payRub)}</Text>
              </View>
              {!!o.pickupAddress && <Text style={{ color: t.ink }}>Забрать: {o.pickupAddress}</Text>}
              <Text style={{ color: t.ink, fontWeight: '600' }}>Доставить: {o.address}</Text>
              <Text style={{ color: t.muted }}>{o.weightKg} кг · {o.dims} см{o.codRub > 0 ? ` · взять ${rub(o.codRub)}` : ''}{o.comment ? ` · ${o.comment}` : ''}</Text>
              <Button title={`Беру за ${rub(o.payRub)}`} busy={taking === o.id} disabled={!!taking} onPress={() => take(o)} />
            </Card>
          ))}
          <Button title="Сканировать штрихкод" kind="secondary" onPress={() => navigation.navigate('Scan')} />
          {active.length > 0 && <Text style={{ color: t.ink, fontSize: 18, fontWeight: '700', marginTop: 4 }}>Мои заказы</Text>}
        </View>
      }
      ListEmptyComponent={!loading ? <Text style={{ color: t.muted, textAlign: 'center', marginTop: 24 }}>{onShift ? (offers.length ? 'Возьмите заказ из доступных выше.' : 'Заказов пока нет. Список обновляется сам.') : 'Выйдите на линию, чтобы получать заказы.'}</Text> : null}
      renderItem={({ item: s }) => (
        <Pressable onPress={() => navigation.navigate('Shipment', { id: s.id })} disabled={s.status !== 'assigned' && !s.syncError}>
          <Card style={{ opacity: s.status === 'assigned' || s.syncError ? 1 : 0.6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={{ color: t.muted, fontFamily: 'monospace' }}>{s.trackingNumber}</Text>
              <Text style={{ color: s.syncError ? t.bad : s.status === 'delivered' ? t.ok : s.status === 'failed' ? t.bad : t.warn, fontWeight: '600' }}>
                {s.syncError ? 'Ошибка' : s.status === 'assigned' && s.pickupAddress && !s.pickedUpAt ? 'Забрать' : STATUS[s.status]}{s.pending ? ' · ждёт сети' : ''}
              </Text>
            </View>
            {s.pickupAddress && !s.pickedUpAt && s.status === 'assigned'
              ? <><Text style={{ color: t.muted }}>Забрать:</Text><Text style={{ color: t.ink, fontSize: 17, fontWeight: '600' }}>{s.pickupAddress}</Text><Text style={{ color: t.muted }}>Доставить: {s.address}</Text></>
              : <Text style={{ color: t.ink, fontSize: 17, fontWeight: '600' }}>{s.address}</Text>}
            <Text style={{ color: t.muted }}>{s.recipientName}{s.codRub > 0 ? ` · взять ${rub(s.codRub)}` : ''}</Text>
            {s.status === 'delivered' && s.courierPayRub != null && <Text style={{ color: t.ok }}>+{rub(s.courierPayRub + (s.tipRub ?? 0))}{s.rating ? ` · ★${s.rating}` : ''}</Text>}
            {!!s.syncError && <Text style={{ color: t.bad }}>{s.syncError}</Text>}
          </Card>
        </Pressable>
      )}
    />
  );
}
