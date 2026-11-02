import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, API_URL, session } from '../api';
import { Button, Card, Field, useTheme } from '../ui';
import { VEHICLE, VEHICLE_IDS, VehicleId } from '../profile';


/**
 * Регистрация курьера-самозанятого: ИНН и данные → заявку проверяет платформа.
 * После подтверждения курьер сразу видит свои доставки.
 */
export function RegisterScreen({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const t = useTheme();
  const [inn, setInn] = useState('');
  const [f, setF] = useState({ name: '', phone: '+7', email: '', password: '' });
  const [city, setCity] = useState('');
  const [hints, setHints] = useState<string[]>([]);

  // Подсказки городов: встроенный список или DaData на сервере.
  useEffect(() => {
    const q = city.trim();
    if (q.length < 2) { setHints([]); return; }
    const id = setTimeout(() => {
      api<{ name: string }[] | string[]>(`/public/cities?q=${encodeURIComponent(q)}`)
        .then((r) => setHints(r.map((x: any) => (typeof x === 'string' ? x : x.name)).filter((n) => n !== q).slice(0, 5)))
        .catch(() => setHints([]));
    }, 250);
    return () => clearTimeout(id);
  }, [city]);
  const [vehicle, setVehicle] = useState<VehicleId>('foot');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string }>('/auth/courier-register', {
        ...f, inn, email: f.email.trim(), city: city.trim(), vehicle, acceptTerms: accept,
      });
      await session.set(r.token);
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
          <Pressable onPress={onBack} hitSlop={12}><Text style={{ color: t.brand, fontSize: 16 }}>‹ Назад</Text></Pressable>
          <Text style={{ color: t.ink, fontSize: 26, fontWeight: '700' }}>Регистрация курьера</Text>

          <Text style={{ color: t.muted, fontSize: 15 }}>Работа самозанятым напрямую с платформой: берёте заказы рядом, сумму видите до принятия, деньги выводите по СБП — чек в «Мой налог» формируется автоматически. Нет статуса самозанятого? Оформите его за 5 минут в приложении «Мой налог».</Text>
          <>
            <Field label="ИНН самозанятого (12 цифр)" value={inn} onChangeText={(v) => setInn(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={12} />
            <Field label="Имя и фамилия" value={f.name} onChangeText={(name) => setF({ ...f, name })} autoComplete="name" />
            <View style={{ gap: 6 }}>
              <Field label="Из какого вы города" value={city} onChangeText={setCity} autoComplete="off" autoCorrect={false} />
              {hints.map((h) => <Pressable key={h} onPress={() => { setCity(h); setHints([]); }} style={{ paddingVertical: 8, paddingHorizontal: 12, backgroundColor: t.panel, borderRadius: 8, borderWidth: 1, borderColor: t.line }}>
                <Text style={{ color: t.ink }}>{h}</Text></Pressable>)}
            </View>
            <Field label="Телефон" value={f.phone} onChangeText={(phone) => setF({ ...f, phone })} keyboardType="phone-pad" autoComplete="tel" />
            <Field label="Email (логин для входа)" value={f.email} onChangeText={(email) => setF({ ...f, email })} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
            <Field label="Пароль, от 8 символов" value={f.password} onChangeText={(password) => setF({ ...f, password })} secureTextEntry autoComplete="new-password" />
            <View style={{ gap: 6 }}>
              <Text style={{ color: t.muted, fontSize: 13 }}>Как доставляете</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {VEHICLE_IDS.map((v) => <Button key={v} title={VEHICLE[v]} kind={vehicle === v ? 'primary' : 'secondary'} style={{ flexGrow: 1, flexBasis: '45%' }} onPress={() => setVehicle(v)} />)}
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <Switch value={accept} onValueChange={setAccept} trackColor={{ true: t.brand }} />
              <Text style={{ color: t.ink, flex: 1 }}>
                Даю согласие на обработку персональных данных и принимаю{' '}
                <Text style={{ color: t.brand }} onPress={() => Linking.openURL(API_URL.replace(/\/api\/?$/, '/privacy'))}>политику</Text>
              </Text>
            </View>
            {!!err && <Text style={{ color: t.bad, fontSize: 15 }}>{err}</Text>}
            <Button title="Отправить заявку" onPress={submit} busy={busy}
              disabled={!accept || inn.length !== 12 || city.trim().length < 2 || f.name.trim().length < 2 || f.phone.length < 10 || !f.email.includes('@') || f.password.length < 8} />
          </>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
