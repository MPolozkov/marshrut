import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { api, BRAND, session } from '../api';
import { useTheme } from '../ui';
import { CardScreen, CustomerLogin, RegisterScreen } from './Auth';
import { Config, CustomerCtx, Me } from './shared';
import { CustomerStack, HomeScreen, NewOrderScreen, OrderScreen, ProfileScreen } from './Screens';
import { registerPush } from '../push';

const Stack = createNativeStackNavigator<CustomerStack>();

/**
 * Режим «Заказчик»: вход по SMS → анкета → проверка карты → заказы.
 * Пока анкета не заполнена или карта не привязана, заказывать нельзя.
 */
export function CustomerApp({ onExit }: { onExit: () => void }) {
  const t = useTheme();
  const [config, setConfig] = useState<Config | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'out' | 'in'>(session.token ? 'loading' : 'out');
  const [err, setErr] = useState('');

  const reload = useCallback(async () => { setMe(await api<Me>('/client/me')); }, []);
  // Уведомления о заказах приходят push-сообщениями.
  useEffect(() => { if (me?.registeredAt) registerPush().catch(() => {}); }, [!!me?.registeredAt]);
  const logout = useCallback(async () => { await session.clear(); setMe(null); onExit(); }, [onExit]);

  useEffect(() => { api<Config>('/client/config').then(setConfig).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    if (state !== 'loading') return;
    reload().then(() => setState('in')).catch((e) => { if (e.status === 401 || e.status === 403) { session.clear(); setState('out'); } else setErr(e.message); });
  }, [state, reload]);

  if (state === 'out') return <CustomerLogin onToken={() => setState('loading')} onBack={onExit} />;
  if (err && (!me || !config)) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg, gap: 16, padding: 24 }}>
    <Text style={{ color: t.bad, textAlign: 'center' }}>{err}</Text>
    <Pressable onPress={() => { setErr(''); setState('loading'); api<Config>('/client/config').then(setConfig).catch((e) => setErr(e.message)); }}><Text style={{ color: t.brand, fontSize: 16 }}>Повторить</Text></Pressable>
    <Pressable onPress={logout}><Text style={{ color: t.muted, fontSize: 16 }}>Выйти</Text></Pressable>
  </View>;
  if (!me || !config) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator color={t.brand} /></View>;
  if (!me.registeredAt) return <RegisterScreen me={me} onSaved={setMe} onLogout={logout} />;
  if (!me.hasCard) return <CardScreen config={config} onDone={setMe} onLogout={logout} />;

  const navTheme = t.dark ? DarkTheme : DefaultTheme;
  return <CustomerCtx.Provider value={{ me, setMe, reload, logout, config }}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <NavigationContainer theme={{ ...navTheme, colors: { ...navTheme.colors, primary: t.brand, background: t.bg, card: t.panel, text: t.ink, border: t.line } }}>
      <Stack.Navigator screenOptions={{ headerBackTitle: 'Назад' }}>
        <Stack.Screen name="CHome" component={HomeScreen} options={{ title: BRAND.name }} />
        <Stack.Screen name="CNew" component={NewOrderScreen} options={{ title: 'Новая доставка' }} />
        <Stack.Screen name="COrder" component={OrderScreen} options={{ title: 'Заказ' }} />
        <Stack.Screen name="CProfile" component={ProfileScreen} options={{ title: 'Профиль' }} />
      </Stack.Navigator>
    </NavigationContainer>
  </CustomerCtx.Provider>;
}
