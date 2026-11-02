import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, BRAND, NetworkError, session, setBrand, setUnauthorizedHandler } from './src/api';
import { flush, clearLocal } from './src/queue';
import { Profile, ProfileCtx } from './src/profile';
import { useTheme } from './src/ui';
import { LoginScreen } from './src/screens/Login';
import { RegisterScreen } from './src/screens/Register';
import { PendingScreen } from './src/screens/Pending';
import { ListScreen } from './src/screens/List';
import { ShipmentScreen } from './src/screens/Shipment';
import { DeliverScreen } from './src/screens/Deliver';
import { ScanScreen } from './src/screens/Scan';
import { SettingsScreen } from './src/screens/Settings';
import { AppRole, RoleScreen } from './src/screens/Role';
import { CustomerApp } from './src/customer/CustomerApp';

const ROLE_KEY = 'marshrut.role';

export type RootStack = {
  List: undefined;
  Shipment: { id: string };
  Deliver: { id: string; trackingNumber: string; codRub: number };
  Scan: undefined;
  Settings: undefined;
};
const Stack = createNativeStackNavigator<RootStack>();

/** Единое приложение: сначала выбор роли (заказчик или курьер), дальше — свой раздел. Роль запоминается. */
export default function App() {
  const t = useTheme();
  const [role, setRole] = useState<AppRole | null | 'loading'>('loading');
  useEffect(() => {
    Promise.all([AsyncStorage.getItem(ROLE_KEY).catch(() => null), session.load()])
      .then(([r]) => setRole(r === 'customer' || r === 'courier' ? r : null));
  }, []);
  const pick = async (r: AppRole) => { await AsyncStorage.setItem(ROLE_KEY, r).catch(() => {}); setRole(r); };
  const exit = useCallback(async () => { await session.clear(); await AsyncStorage.removeItem(ROLE_KEY).catch(() => {}); setRole(null); }, []);

  if (role === 'loading') return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator color={t.brand} /></View>;
  if (role === null) return <SafeAreaProvider><RoleScreen onPick={pick} /></SafeAreaProvider>;
  if (role === 'customer') return <SafeAreaProvider><CustomerRoot onExit={exit} /></SafeAreaProvider>;
  return <CourierApp onExit={exit} />;
}

function CustomerRoot({ onExit }: { onExit: () => void }) {
  // Сессия истекла — возвращаемся к выбору роли.
  useEffect(() => { setUnauthorizedHandler(() => { onExit(); }); }, [onExit]);
  return <CustomerApp onExit={onExit} />;
}

function CourierApp({ onExit }: { onExit: () => void }) {
  const t = useTheme();
  const [state, setState] = useState<'loading' | 'out' | 'register' | 'in'>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [offline, setOffline] = useState(false);

  /** Профиль курьера: статус заявки, имя и бренд компании для шапки. Без сети — работаем с последним сохранённым. */
  const reload = useCallback(async () => {
    try {
      const p = await api<Profile>('/courier/me');
      setProfile(p); setOffline(false);
      if (p.company) setBrand({ name: p.company.name, color: p.company.brandColor });
    } catch (e) {
      if (e instanceof NetworkError) setOffline(true); else throw e;
    }
  }, []);

  const logout = useCallback(async () => {
    await clearLocal(); setProfile(null); await onExit();
  }, [onExit]);

  useEffect(() => {
    session.load().then(async (tok) => {
      if (!tok) return setState('out');
      await reload().catch(() => {});
      setState('in');
    });
    setUnauthorizedHandler(() => { session.clear(); setProfile(null); setState('out'); });
    // Как только появилась сеть — отправляем накопленные вручения.
    return NetInfo.addEventListener((s) => { if (s.isConnected) flush(); });
  }, [reload]);

  const onLogin = async () => { await reload().catch(() => {}); setState('in'); };

  if (state === 'loading') {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}><ActivityIndicator color={t.brand} /></View>;
  }
  if (state === 'out') return <SafeAreaProvider><LoginScreen onLogin={onLogin} onRegister={() => setState('register')} onBack={onExit} /></SafeAreaProvider>;
  if (state === 'register') return <SafeAreaProvider><RegisterScreen onDone={onLogin} onBack={() => setState('out')} /></SafeAreaProvider>;

  const ctx = { profile, reload, logout };
  if (!profile && !offline) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg, gap: 16, padding: 24 }}>
      <Text style={{ color: t.ink, fontSize: 16, textAlign: 'center' }}>Не удалось загрузить профиль курьера.</Text>
      <Pressable onPress={logout}><Text style={{ color: t.brand, fontSize: 16 }}>Выйти</Text></Pressable>
    </View>;
  }
  if (profile && profile.status !== 'approved') {
    return <ProfileCtx.Provider value={ctx}><SafeAreaProvider><PendingScreen /></SafeAreaProvider></ProfileCtx.Provider>;
  }

  const navTheme = t.dark ? DarkTheme : DefaultTheme;
  return (
    <ProfileCtx.Provider value={ctx}>
      <SafeAreaProvider>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <NavigationContainer theme={{ ...navTheme, colors: { ...navTheme.colors, primary: t.brand, background: t.bg, card: t.panel, text: t.ink, border: t.line } }}>
          <Stack.Navigator screenOptions={{ headerBackTitle: 'Назад' }}>
            <Stack.Screen name="List" component={ListScreen} options={{ title: profile?.company?.name ?? BRAND.name }} />
            <Stack.Screen name="Shipment" component={ShipmentScreen} options={{ title: 'Отправление' }} />
            <Stack.Screen name="Deliver" component={DeliverScreen} options={{ title: 'Вручение' }} />
            <Stack.Screen name="Scan" component={ScanScreen} options={{ title: 'Сканер' }} />
            <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Настройки' }} />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </ProfileCtx.Provider>
  );
}
