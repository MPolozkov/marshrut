import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStack } from '../../App';
import { loadList } from '../queue';
import { Button, useTheme } from '../ui';

/** Сканер штрихкода накладной: открывает карточку отправления из списка курьера. */
export function ScanScreen({ navigation }: NativeStackScreenProps<RootStack, 'Scan'>) {
  const t = useTheme();
  const [perm, requestPerm] = useCameraPermissions();
  const [msg, setMsg] = useState('');
  const busy = useRef(false);

  if (!perm) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  if (!perm.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Text style={{ color: t.ink, fontSize: 16 }}>Для сканирования нужен доступ к камере.</Text>
        <Button title="Разрешить камеру" onPress={requestPerm} />
      </View>
    );
  }

  async function onScan(data: string) {
    if (busy.current) return;
    busy.current = true;
    const number = data.trim().toUpperCase();
    try {
      const { items } = await loadList();
      const s = items.find((x) => x.trackingNumber === number);
      if (s) { navigation.replace('Shipment', { id: s.id }); return; }
      setMsg(`${number} нет в вашем списке на сегодня`);
    } catch (e: any) { setMsg(e.message); }
    setTimeout(() => { busy.current = false; }, 1500);
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['code128', 'qr', 'ean13'] }}
        onBarcodeScanned={({ data }) => onScan(data)} />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, backgroundColor: 'rgba(0,0,0,0.6)' }}>
        <Text style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>{msg || 'Наведите камеру на штрихкод накладной'}</Text>
      </View>
    </View>
  );
}
