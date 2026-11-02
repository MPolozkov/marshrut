import { useEffect, useRef, useState } from 'react';
import { Alert, Image, ScrollView, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import SignatureScreen, { SignatureViewRef } from 'react-native-signature-canvas';
import type { RootStack } from '../../App';
import { perform } from '../queue';
import { getPrefs } from '../profile';
import { BRAND } from '../api';
import { Button, Card, Field, useTheme } from '../ui';

type Method = 'cash' | 'card' | 'sbp';
const METHODS: [Method, string][] = [['cash', 'Наличные'], ['card', 'Карта'], ['sbp', 'СБП']];

export function DeliverScreen({ route, navigation }: NativeStackScreenProps<RootStack, 'Deliver'>) {
  const t = useTheme();
  const { id, trackingNumber, codRub } = route.params;
  const [code, setCode] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [method, setMethod] = useState<Method>('cash');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sigRef = useRef<SignatureViewRef>(null);
  const [photoRequired, setPhotoRequired] = useState(false);
  useEffect(() => { getPrefs().then((p) => setPhotoRequired(p.photoRequired)); }, []);

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { setErr('Разрешите доступ к камере в настройках телефона'); return; }
    const r = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (r.canceled) return;
    // Сжимаем до 1280 px: фото весит ~200 КБ и быстро уходит даже по слабой сети.
    const small = await ImageManipulator.manipulateAsync(r.assets[0].uri, [{ resize: { width: 1280 } }],
      { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true });
    setPhoto(`data:image/jpeg;base64,${small.base64}`);
  }

  async function position() {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return {};
      const p = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      return p ? { lat: p.coords.latitude, lng: p.coords.longitude } : {};
    } catch { return {}; }
  }

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const body = {
        code: code.trim(),
        ...(photo ? { photo } : {}),
        ...(signature ? { signature } : {}),
        ...(await position()),
        ...(codRub > 0 ? { codCollected: codRub, codMethod: method } : {}),
      };
      const r = await perform(id, 'deliver', body);
      if (r === 'queued') Alert.alert('Сохранено в телефоне', 'Нет связи. Вручение отправится автоматически, когда появится сеть. Код проверится при отправке.');
      navigation.popToTop();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (signing) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <Text style={{ color: t.ink, padding: 16, fontSize: 16 }}>Попросите получателя расписаться пальцем</Text>
        <SignatureScreen
          ref={sigRef}
          onOK={(img) => { setSignature(img); setSigning(false); }}
          onEmpty={() => setErr('Подпись пустая')}
          descriptionText=""
          clearText="Очистить"
          confirmText="Готово"
          webStyle={`.m-signature-pad--footer .button { background-color: ${BRAND.color}; color: #fff; }`}
          imageType="image/png"
        />
        <View style={{ padding: 16 }}><Button title="Отмена" kind="secondary" onPress={() => setSigning(false)} /></View>
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: t.muted, fontFamily: 'monospace' }}>{trackingNumber}</Text>
      <Field label="Код из сообщения получателя" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
        keyboardType="number-pad" maxLength={6} style={{ fontSize: 28, letterSpacing: 8, textAlign: 'center' }} />

      {codRub > 0 && (
        <Card>
          <Text style={{ color: t.warn, fontSize: 18, fontWeight: '700' }}>Получите {codRub.toLocaleString('ru-RU')} ₽</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {METHODS.map(([m, label]) => <Button key={m} title={label} kind={method === m ? 'primary' : 'secondary'} style={{ flex: 1 }} onPress={() => setMethod(m)} />)}
          </View>
          <Text style={{ color: t.muted, fontSize: 13 }}>Чек клиенту выдаёт касса компании по закону 54-ФЗ.</Text>
        </Card>
      )}

      <Card>
        <Text style={{ color: t.ink, fontWeight: '600' }}>Подтверждение</Text>
        {photo && <Image source={{ uri: photo }} style={{ width: '100%', height: 200, borderRadius: 10 }} resizeMode="cover" />}
        <Button title={photo ? 'Переснять фото' : 'Сфотографировать посылку'} kind="secondary" onPress={takePhoto} />
        {signature && <Image source={{ uri: signature }} style={{ width: '100%', height: 120, backgroundColor: '#fff', borderRadius: 10 }} resizeMode="contain" />}
        <Button title={signature ? 'Подписать заново' : 'Подпись получателя'} kind="secondary" onPress={() => setSigning(true)} />
      </Card>

      {!!err && <Text style={{ color: t.bad, fontSize: 15 }}>{err}</Text>}
      {photoRequired && !photo && <Text style={{ color: t.muted }}>По настройкам нужно фото посылки.</Text>}
      <Button title="Подтвердить вручение" onPress={submit} busy={busy} disabled={code.length < 4 || (photoRequired && !photo)} />
    </ScrollView>
  );
}
