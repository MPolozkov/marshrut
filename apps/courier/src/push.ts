import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { api } from './api';

// Уведомления показываем и когда приложение открыто.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * Push вместо SMS: получаем токен телефона и сообщаем серверу.
 * Работает в собранном приложении (APK / development build). В Expo Go на Android удалённые push недоступны —
 * тогда приложение просто обновляет экраны само (опрос сервера), ничего не ломается.
 */
export async function registerPush() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('orders', { name: 'Заказы', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 150, 250] });
  }
  const perm = await Notifications.getPermissionsAsync();
  const granted = perm.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return null;
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  await api('/devices', { token, platform: Platform.OS });
  return token;
}
