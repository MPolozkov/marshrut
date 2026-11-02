import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '../api';
import { useTheme } from '../ui';

export type AppRole = 'customer' | 'courier';

/** Первый экран единого приложения: кто вы — заказчик или курьер. */
export function RoleScreen({ onPick }: { onPick: (r: AppRole) => void }) {
  const t = useTheme();
  const card = (role: AppRole, title: string, text: string) => (
    <Pressable onPress={() => onPick(role)} accessibilityRole="button"
      style={({ pressed }) => ({ borderWidth: 1, borderColor: t.line, backgroundColor: t.panel, borderRadius: 16, padding: 20, gap: 6, opacity: pressed ? 0.8 : 1 })}>
      <Text style={{ color: t.ink, fontSize: 22, fontWeight: '700' }}>{title}</Text>
      <Text style={{ color: t.muted, fontSize: 15 }}>{text}</Text>
    </Pressable>
  );
  return <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
      <View style={{ width: 56, height: 56, borderRadius: 14, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '700' }}>{BRAND.name[0]}</Text>
      </View>
      <Text style={{ color: t.ink, fontSize: 28, fontWeight: '700' }}>{BRAND.name}</Text>
      <Text style={{ color: t.muted, fontSize: 16 }}>Доставка по городу: курьер рядом выезжает сразу.</Text>
      {card('customer', 'Я заказчик', 'Рассчитать доставку, выбрать службу по цене и рейтингу, оплатить картой, следить за курьером.')}
      {card('courier', 'Я курьер', 'Работа самозанятым: заказы рядом, сумма видна сразу, вывод денег по СБП.')}
    </View>
  </SafeAreaView>;
}
