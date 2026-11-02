import { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api';
import { Button, Field, useTheme } from './ui';

/** «Что доработать»: предложение уходит на почту поддержки. */
export function IdeaForm({ source, name, email, phone, onDone }: { source: 'courier_app' | 'client_app'; name: string; email: string; phone?: string; onDone: () => void }) {
  const t = useTheme();
  const [text, setText] = useState('');
  const [mail, setMail] = useState(email);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function send() {
    setBusy(true); setErr('');
    try {
      await api('/support', { topic: 'idea', source, subject: 'Предложение из приложения', message: text.trim(), contactName: name || 'Пользователь приложения', contactEmail: mail.trim(), contactPhone: phone });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return <View style={{ gap: 12 }}>
    <Field label="Что улучшить, от 20 символов" value={text} onChangeText={setText} multiline numberOfLines={5} style={{ minHeight: 110, textAlignVertical: 'top' }} />
    <Field label="Email для ответа" value={mail} onChangeText={setMail} keyboardType="email-address" autoCapitalize="none" />
    {!!err && <Text style={{ color: t.bad }}>{err}</Text>}
    <Button title="Отправить" busy={busy} disabled={text.trim().length < 20 || !mail.includes('@')} onPress={send} />
  </View>;
}
