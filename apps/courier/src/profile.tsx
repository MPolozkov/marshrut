import { createContext, useContext } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Profile {
  id: string; name: string; phone: string; email?: string; vehicle: VehicleId | null;
  selfEmployed?: boolean; inn?: string | null; payoutMethod?: string | null; payoutDetails?: string | null;
  status: 'pending' | 'approved' | 'rejected'; active: boolean; city: string;
  company?: { name: string; city: string; brandColor: string; logoUrl: string | null; phone: string | null };
}

export const ProfileCtx = createContext<{ profile: Profile | null; reload: () => Promise<void>; logout: () => Promise<void> }>({
  profile: null, reload: async () => {}, logout: async () => {},
});
export const useProfile = () => useContext(ProfileCtx);

export type VehicleId = 'foot' | 'bike' | 'car' | 'truck_m';
export const VEHICLE_IDS: VehicleId[] = ['foot', 'bike', 'car', 'truck_m'];
export const VEHICLE: Record<string, string> = { foot: 'Пешком', bike: 'Вело / самокат', car: 'Легковой', truck_m: 'Грузовой 3,5–5 т' };

/** Настройки приложения, которые хранятся в телефоне. */
export type Navigator = 'yandexnavi' | 'yandexmaps' | '2gis' | 'google';
export const NAVIGATORS: [Navigator, string][] = [
  ['yandexnavi', 'Яндекс Навигатор'], ['yandexmaps', 'Яндекс Карты'], ['2gis', '2ГИС'], ['google', 'Google Карты'],
];
const PREF = 'marshrut.prefs';
export interface Prefs { navigator: Navigator; navigatorChosen: boolean; photoRequired: boolean; keepAwake: boolean }
const DEFAULTS: Prefs = { navigator: 'yandexnavi', navigatorChosen: false, photoRequired: false, keepAwake: false };

export async function getPrefs(): Promise<Prefs> {
  try { return { ...DEFAULTS, ...JSON.parse((await AsyncStorage.getItem(PREF)) ?? '{}') }; } catch { return DEFAULTS; }
}
export async function setPrefs(p: Partial<Prefs>) {
  const next = { ...(await getPrefs()), ...p };
  await AsyncStorage.setItem(PREF, JSON.stringify(next));
  return next;
}
