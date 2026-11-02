import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, session } from '../api';
import { Button, Card, Field, useTheme } from '../ui';
import { Choice, Config, Me, PayResp, Requisites, withBank } from './shared';

/** Вход заказчика по номеру телефона и коду из SMS. */
export function CustomerLogin({ onToken, onBack }: { onToken: () => void; onBack: () => void }) {
  const t = useTheme();
  const [phone, setPhone] = useState('+7');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [dev, setDev] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    setErr(''); setBusy(true);
    try { const r = await api<{ devCode?: string }>('/client/auth/code', { phone }); setDev(r.devCode ?? null); setStep('code'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function verify() {
    setErr(''); setBusy(true);
    try { const r = await api<{ token: string }>('/client/auth/verify', { phone, code }); await session.set(r.token); onToken(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
      <Pressable onPress={step === 'code' ? () => setStep('phone') : onBack} hitSlop={12}><Text style={{ color: t.brand, fontSize: 16 }}>‹ Назад</Text></Pressable>
      <Text style={{ color: t.ink, fontSize: 26, fontWeight: '700' }}>Заказать доставку</Text>
      <Text style={{ color: t.muted, fontSize: 15 }}>Рассчитайте доставку по городу, получите цены курьерских служб и выберите лучшую. Вход по номеру телефона.</Text>
      {step === 'phone' ? <>
        <Field label="Телефон" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" onSubmitEditing={send} />
        {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
        <Button title="Получить код по SMS" onPress={send} busy={busy} disabled={phone.replace(/\D/g, '').length < 11} />
      </> : <>
        <Text style={{ color: t.muted }}>Код отправлен на {phone}</Text>
        {!!dev && <Text style={{ color: t.ok }}>Режим проверки (SMS не подключены): код {dev}</Text>}
        <Field label="Код из SMS" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={4} autoComplete="sms-otp"
          style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }} onSubmitEditing={verify} />
        {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
        <Button title="Войти" onPress={verify} busy={busy} disabled={code.length !== 4} />
      </>}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const EMPTY: Requisites = { companyName: '', inn: '', kpp: '', ogrn: '', legalAddress: '', bank: '', bik: '', account: '', corrAccount: '', director: '', docsEmail: '' };

/** Анкета заказчика: ФИО, физлицо или компания. Используется при регистрации и в профиле. */
export function ProfileForm({ me, onSaved, first }: { me: Me; onSaved: (m: Me) => void; first?: boolean }) {
  const t = useTheme();
  const [f, setF] = useState({ lastName: me.lastName, firstName: me.firstName, middleName: me.middleName, email: me.email ?? '', kind: me.kind, selfEmployed: me.selfEmployed, inn: me.kind === 'person' ? me.inn ?? '' : '' });
  const [req, setReq] = useState<Requisites>({ ...EMPTY, ...(me.requisites ?? {}) });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const rq = (k: keyof Requisites, label: string, numeric = false) =>
    <Field key={k} label={label} value={req[k] ?? ''} onChangeText={(v) => setReq({ ...req, [k]: numeric ? v.replace(/\D/g, '') : v })} keyboardType={numeric ? 'number-pad' : 'default'} />;

  async function save() {
    setErr(''); setBusy(true);
    try { onSaved(await api<Me>('/client/me', { ...f, requisites: f.kind === 'company' ? req : undefined, inn: f.selfEmployed ? f.inn : undefined }, 'PUT')); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return <View style={{ gap: 12 }}>
    {first && <Text style={{ color: t.muted, fontSize: 15 }}>Заполните один раз — данные подставятся в заказы и закрывающие документы. Затем привяжем карту: оплата доставки только картой.</Text>}
    <Field label="Фамилия" value={f.lastName} onChangeText={(v) => setF({ ...f, lastName: v })} autoComplete="name-family" />
    <Field label="Имя" value={f.firstName} onChangeText={(v) => setF({ ...f, firstName: v })} autoComplete="name-given" />
    <Field label="Отчество (если есть)" value={f.middleName} onChangeText={(v) => setF({ ...f, middleName: v })} autoComplete="name-middle" />
    <Field label="Email (необязательно)" value={f.email} onChangeText={(v) => setF({ ...f, email: v })} keyboardType="email-address" autoCapitalize="none" />
    <Text style={{ color: t.muted, fontSize: 13 }}>Кто вы</Text>
    <Choice value={f.kind} options={[['person', 'Физическое лицо'], ['company', 'Компания или ИП']]} onChange={(kind) => setF({ ...f, kind })} />
    {f.kind === 'person' ? <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text style={{ color: t.ink, flex: 1 }}>Я самозанятый — нужны документы на доставку</Text>
        <Switch value={f.selfEmployed} onValueChange={(v) => setF({ ...f, selfEmployed: v })} trackColor={{ true: t.brand }} />
      </View>
      {f.selfEmployed && <Field label="ИНН (12 цифр)" value={f.inn} onChangeText={(v) => setF({ ...f, inn: v.replace(/\D/g, '') })} keyboardType="number-pad" maxLength={12} />}
    </> : <>
      <Text style={{ color: t.muted, fontSize: 13 }}>Реквизиты для закрывающих документов (акт или УПД)</Text>
      {rq('companyName', 'Название организации или ИП')}{rq('inn', 'ИНН', true)}{rq('kpp', 'КПП (для ООО)', true)}{rq('ogrn', 'ОГРН / ОГРНИП', true)}
      {rq('legalAddress', 'Юридический адрес')}{rq('bank', 'Банк')}{rq('bik', 'БИК', true)}{rq('account', 'Расчётный счёт', true)}{rq('corrAccount', 'Корр. счёт', true)}
      {rq('director', 'Руководитель (ФИО)')}{rq('docsEmail', 'Email для актов')}
    </>}
    {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
    <Button title={first ? 'Продолжить' : 'Сохранить'} onPress={save} busy={busy} disabled={f.lastName.trim().length < 2 || f.firstName.trim().length < 2} />
  </View>;
}

export function RegisterScreen({ me, onSaved, onLogout }: { me: Me; onSaved: (m: Me) => void; onLogout: () => void }) {
  const t = useTheme();
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }} keyboardShouldPersistTaps="handled">
        <Pressable onPress={onLogout} hitSlop={12}><Text style={{ color: t.brand, fontSize: 16 }}>‹ Выйти</Text></Pressable>
        <Text style={{ color: t.ink, fontSize: 26, fontWeight: '700' }}>Регистрация заказчика</Text>
        <ProfileForm me={me} onSaved={onSaved} first />
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

/** Привязка карты: банк резервирует 1 ₽ и сразу его возвращает. */
export async function bindCard(): Promise<Me> {
  const r = await withBank(() => api<PayResp>('/client/card', {}), (x) => api<PayResp>('/client/card/check', { paymentId: x.paymentId }));
  if (!r.me?.hasCard) throw new Error('Карта не привязана. Попробуйте ещё раз.');
  return r.me;
}

export function CardScreen({ config, onDone, onLogout }: { config: Config; onDone: (m: Me) => void; onLogout: () => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16, flexGrow: 1, justifyContent: 'center' }}>
      <Text style={{ color: t.ink, fontSize: 26, fontWeight: '700' }}>Привяжите карту</Text>
      <Text style={{ color: t.ink, fontSize: 16 }}>Доставка оплачивается только картой. Для проверки банк зарезервирует 1 ₽ и сразу вернёт его.</Text>
      <Card>
        <Text style={{ color: t.ink }}>• При выборе службы сумма заказа резервируется на карте.</Text>
        <Text style={{ color: t.ink }}>• После вручения резерв списывается. Отменили заказ — резерв снимается, деньги возвращаются на эту карту.</Text>
        <Text style={{ color: t.ink }}>• Если списать оплату не получится, новые заказы будут недоступны, пока долг не погашен.</Text>
      </Card>
      {config.testPayments && <Text style={{ color: t.ok }}>Тестовый режим: деньги не списываются, карта •••• 4242 привяжется сразу.</Text>}
      {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
      <Button title="Привязать карту" busy={busy} onPress={async () => { setBusy(true); setErr(''); try { onDone(await bindCard()); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }} />
      <Button title="Выйти" kind="secondary" onPress={onLogout} />
    </ScrollView>
  </SafeAreaView>;
}
