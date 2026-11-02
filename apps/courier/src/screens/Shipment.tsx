import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { distanceKm } from '../geo';
import { Alert, Linking, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStack } from '../../App';
import { api, MyShipment } from '../api';
import { dismissError, loadList, perform } from '../queue';
import { Button, Card, useTheme } from '../ui';
import { getPrefs, Navigator, NAVIGATORS, setPrefs } from '../profile';

const REASONS = ['Клиент не отвечает', 'Клиента нет по адресу', 'Отказ от получения', 'Неверный адрес', 'Перенос на другой день'];

const PAY: Record<string, string> = { sender_cash: 'Возьмите оплату у отправителя при заборе', recipient_cash: 'Возьмите оплату у получателя при вручении', invoice: 'Клиент платит компании по счёту', card_online: 'Оплачено онлайн', card: 'Оплачено картой в приложении — деньги не берите', contract: 'По договору' };
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

/** При первом нажатии «Маршрут» спрашиваем, каким навигатором пользоваться. Поменять можно в настройках. */
async function chooseNavigator(): Promise<Navigator | null> {
  const p = await getPrefs();
  if (p.navigatorChosen) return p.navigator;
  return new Promise((resolve) => Alert.alert('Каким навигатором пользоваться?', 'Выбор запомнится. Поменять можно в настройках.', [
    ...NAVIGATORS.map(([id, name]) => ({ text: name, onPress: async () => { await setPrefs({ navigator: id, navigatorChosen: true }); resolve(id); } })),
    { text: 'Отмена', style: 'cancel' as const, onPress: () => resolve(null) },
  ], { cancelable: true, onDismiss: () => resolve(null) }));
}

/** Открывает выбранный навигатор; если его нет на телефоне — карту в браузере. */
async function openNav(address: string) {
  const q = encodeURIComponent(address);
  const navigator = await chooseNavigator();
  if (!navigator) return;
  const apps: Record<string, string> = {
    yandexnavi: `yandexnavi://map_search?text=${q}`,
    yandexmaps: `yandexmaps://maps.yandex.ru/?text=${q}`,
    '2gis': `dgis://2gis.ru/search/${q}`,
    google: `geo:0,0?q=${q}`,
  };
  const web: Record<string, string> = {
    '2gis': `https://2gis.ru/search/${q}`, google: `https://www.google.com/maps/search/?api=1&query=${q}`,
  };
  const url = apps[navigator];
  if (url && await Linking.canOpenURL(url).catch(() => false)) return Linking.openURL(url);
  return Linking.openURL(web[navigator] ?? `https://yandex.ru/maps/?text=${q}`);
}

export function ShipmentScreen({ route, navigation }: NativeStackScreenProps<RootStack, 'Shipment'>) {
  const t = useTheme();
  const [s, setS] = useState<MyShipment | null>(null);
  const [failing, setFailing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Карточка берётся из списка: так она открывается и без сети.
  useEffect(() => {
    loadList().then((r) => setS(r.items.find((x) => x.id === route.params.id) ?? null)).catch((e) => setErr(e.message));
  }, [route.params.id]);

  // Расстояние до адреса доставки: «Доставлено» доступно только рядом с ним.
  const [meters, setMeters] = useState<number | null>(null);
  const target = s?.deliveryLat != null && s?.deliveryLng != null ? { lat: s.deliveryLat, lng: s.deliveryLng } : null;
  useEffect(() => {
    if (!target || s?.status !== 'assigned') return;
    let sub: Location.LocationSubscription | null = null;
    Location.requestForegroundPermissionsAsync().then(({ granted }) => {
      if (!granted) return;
      Location.watchPositionAsync({ accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 }, (p) => {
        setMeters(Math.round(distanceKm({ lat: p.coords.latitude, lng: p.coords.longitude }, target) * 1000));
      }).then((x) => { sub = x; });
    });
    return () => sub?.remove();
  }, [target?.lat, target?.lng, s?.status]);

  if (!s) return <View style={{ flex: 1, backgroundColor: t.bg, padding: 16 }}><Text style={{ color: err ? t.bad : t.muted }}>{err || 'Загрузка…'}</Text></View>;

  async function fail(reason: string) {
    setBusy(true); setErr('');
    try {
      const r = await perform(s!.id, 'fail', { reason });
      if (r === 'queued') Alert.alert('Сохранено в телефоне', 'Отметка уйдёт на сервер, как только появится сеть.');
      navigation.goBack();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const needPickup = !!s.pickupAddress && !s.pickedUpAt && s.status === 'assigned';
  const where = (a: string) => (s!.city ? `${s!.city}, ${a}` : a);
  const radius = s.deliverRadiusM ?? 300;
  const near = !target || (meters != null && meters <= radius);
  const ad = s.addressDetails;

  async function pickedUp() {
    setBusy(true); setErr('');
    try {
      const r = await api<{ pickedUpAt: string }>(`/shipments/${s!.id}/pickup`, {});
      setS({ ...s!, pickedUpAt: r?.pickedUpAt ?? new Date().toISOString() });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {s.courierPayRub != null || s.priceRub != null ? (
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: t.muted }}>{s.status === 'delivered' ? 'Вы получили' : 'Вы получите за заказ'}</Text>
            {!!s.paymentMethod && <Text style={{ color: t.muted, fontSize: 13 }}>{PAY[s.paymentMethod] ?? s.paymentMethod}</Text>}
            {(s.paymentMethod === 'sender_cash' || s.paymentMethod === 'recipient_cash') && !!s.priceRub && <Text style={{ color: t.warn, fontSize: 13 }}>За доставку: {rub(s.priceRub)} — сдайте в кассу</Text>}
          </View>
          <Text style={{ color: t.ok, fontSize: 22, fontWeight: '700', flexShrink: 0 }}>{s.courierPayRub != null ? rub(s.courierPayRub + (s.tipRub ?? 0)) : 'по тарифу'}</Text>
        </Card>
      ) : null}

      {!!s.pickupAddress && (
        <Card style={{ opacity: needPickup ? 1 : 0.6 }}>
          <Text style={{ color: t.muted }}>{needPickup ? 'Шаг 1. Забрать посылку' : 'Посылка забрана'}</Text>
          <Text style={{ color: t.ink, fontSize: 18, fontWeight: '700' }}>{s.pickupAddress}</Text>
          {!!(s.pickupName || s.pickupPhone) && <Text style={{ color: t.ink }}>{[s.pickupName, s.pickupPhone].filter(Boolean).join(', ')}</Text>}
          {needPickup && <View style={{ flexDirection: 'row', gap: 12 }}>
            <Button style={{ flex: 1 }} kind="secondary" title="Позвонить" disabled={!s.pickupPhone} onPress={() => Linking.openURL(`tel:${s.pickupPhone}`)} />
            <Button style={{ flex: 1 }} kind="secondary" title="Маршрут" onPress={() => openNav(where(s.pickupAddress!))} />
          </View>}
          {needPickup && <Button title="Забрал посылку" busy={busy} onPress={pickedUp} />}
        </Card>
      )}

      <Card style={{ opacity: needPickup ? 0.6 : 1 }}>
        {!!s.pickupAddress && <Text style={{ color: t.muted }}>{needPickup ? 'Шаг 2. Доставить' : 'Доставить'}</Text>}
        <Text style={{ color: t.muted, fontFamily: 'monospace' }}>{s.trackingNumber}</Text>
        {ad ? <>
          <Text style={{ color: t.ink, fontSize: 20, fontWeight: '700' }}>{ad.street}, д. {ad.house}</Text>
          <Text style={{ color: t.ink, fontSize: 18 }}>{/частн/i.test(ad.apartment) ? 'Частный дом' : `Кв./офис ${ad.apartment}`}{ad.entrance ? ` · подъезд ${ad.entrance}` : ''}{ad.floor ? ` · этаж ${ad.floor}` : ''}{ad.intercom ? ` · домофон ${ad.intercom}` : ''}</Text>
        </> : <Text style={{ color: t.ink, fontSize: 20, fontWeight: '700' }}>{s.address}</Text>}
        <Text style={{ color: t.ink, fontSize: 16 }}>{s.recipientName}</Text>
        <Text style={{ color: t.muted }}>Вес: {s.weightKg} кг</Text>
        {s.codRub > 0 && <Text style={{ color: t.warn, fontSize: 18, fontWeight: '700' }}>Получить с клиента: {s.codRub.toLocaleString('ru-RU')} ₽</Text>}
        {!!s.comment && <Text style={{ color: t.ink }}>Комментарий: {s.comment}</Text>}
      </Card>

      {!!s.syncError && (
        <Card>
          <Text style={{ color: t.bad, fontWeight: '600' }}>Сервер не принял прошлую отметку</Text>
          <Text style={{ color: t.ink }}>{s.syncError}</Text>
          <Button title="Отметить заново" kind="secondary" onPress={async () => { await dismissError(s.id); setS({ ...s, syncError: undefined, status: 'assigned' }); }} />
        </Card>
      )}

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Button style={{ flex: 1 }} kind="secondary" title="Позвонить" disabled={!s.recipientPhone} onPress={() => Linking.openURL(`tel:${s.recipientPhone}`)} />
        <Button style={{ flex: 1 }} kind="secondary" title="Маршрут" onPress={() => openNav(where(ad ? `${ad.street}, ${ad.house}` : s.address))} />
      </View>

      {s.status === 'assigned' && !s.syncError && !needPickup && <>
        <Button title={near ? 'Доставлено' : meters != null ? `Доставлено — подойдите ближе (${meters > 1000 ? `${(meters / 1000).toFixed(1)} км` : `${meters} м`})` : 'Доставлено — определяем местоположение…'}
          disabled={!near} onPress={() => navigation.navigate('Deliver', { id: s.id, trackingNumber: s.trackingNumber, codRub: s.codRub })} />
        {!near && <Text style={{ color: t.muted }}>Кнопка станет активной в {radius} м от адреса. Деньги за заказ начисляются сразу после отметки «Доставлено».</Text>}
        {!failing
          ? <Button title="Не удалось вручить" kind="secondary" onPress={() => setFailing(true)} />
          : <Card>
              <Text style={{ color: t.ink, fontWeight: '600' }}>Причина</Text>
              {REASONS.map((r) => <Button key={r} title={r} kind="secondary" busy={busy} onPress={() => fail(r)} />)}
              <Button title="Отмена" kind="secondary" onPress={() => setFailing(false)} />
            </Card>}
      </>}
      {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
    </ScrollView>
  );
}
