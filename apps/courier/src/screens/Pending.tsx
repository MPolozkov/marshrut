import { useEffect, useState } from 'react';
import { AppState, Linking, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useProfile } from '../profile';
import { Button, Card, useTheme } from '../ui';

/** Заявка ждёт подтверждения платформой или отклонена. Экран сам проверяет статус каждые 10 секунд и при возврате в приложение. */
export function PendingScreen() {
  const t = useTheme();
  const { profile, reload, logout } = useProfile();
  const [busy, setBusy] = useState(false);
  const rejected = profile?.status === 'rejected';

  useEffect(() => {
    if (rejected) return;
    const id = setInterval(() => { reload().catch(() => {}); }, 10_000);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') reload().catch(() => {}); });
    return () => { clearInterval(id); sub.remove(); };
  }, [rejected, reload]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        <Text style={{ color: t.ink, fontSize: 24, fontWeight: '700' }}>{rejected ? 'Заявка отклонена' : 'Заявка отправлена'}</Text>
        <Card>
          <Text style={{ color: t.ink, fontSize: 16 }}>{profile?.company?.name}</Text>
          <Text style={{ color: t.muted }}>
            {rejected
              ? 'Заявка отклонена. Если это ошибка, напишите в поддержку.'
              : 'Проверяем ИНН самозанятого и данные. После подтверждения здесь появятся заказы рядом. Экран обновится сам.'}
          </Text>
        </Card>
        {!rejected && <Button title="Проверить сейчас" busy={busy} onPress={async () => { setBusy(true); await reload().catch(() => {}); setBusy(false); }} />}
        {!!profile?.company?.phone && <Button title={`Позвонить в компанию: ${profile.company.phone}`} kind="secondary" onPress={() => Linking.openURL(`tel:${profile.company!.phone}`)} />}
        <Button title="Выйти" kind="secondary" onPress={logout} />
      </View>
    </SafeAreaView>
  );
}
