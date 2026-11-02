import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, BRAND, session } from '../api';
import { Button, Field, useTheme } from '../ui';

export function LoginScreen({ onLogin, onRegister, onBack }: { onLogin: () => void; onRegister: () => void; onBack?: () => void }) {
  const t = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: { role: string } }>('/auth/login', { email: email.trim(), password });
      if (r.user.role !== 'courier') { setErr('Это вход для курьеров. Сотрудники службы работают в веб-кабинете, заказчики — в разделе «Я заказчик».'); return; }
      await session.set(r.token);
      onLogin();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        {onBack && <Pressable onPress={onBack} hitSlop={12}><Text style={{ color: t.brand, fontSize: 16 }}>‹ Заказчик или курьер</Text></Pressable>}
        <View style={{ width: 56, height: 56, borderRadius: 14, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '700' }}>{BRAND.name[0]}</Text>
        </View>
        <Text style={{ color: t.ink, fontSize: 26, fontWeight: '700' }}>{BRAND.name}</Text>
        <Text style={{ color: t.muted, fontSize: 15 }}>Вход для курьера. Впервые здесь? Зарегистрируйтесь как самозанятый — нужен ИНН.</Text>
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
        <Field label="Пароль" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={submit} />
        {!!err && <Text style={{ color: t.bad, fontSize: 15 }}>{err}</Text>}
        <Button title="Войти" onPress={submit} busy={busy} disabled={!email || !password} />
        <Button title="Стать курьером" kind="secondary" onPress={onRegister} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
