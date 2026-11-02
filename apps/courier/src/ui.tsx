import { ReactNode, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, TextInputProps, useColorScheme, View, ViewStyle } from 'react-native';
import { BRAND, onBrandChange } from './api';

export function useTheme() {
  const dark = useColorScheme() === 'dark';
  const [, bump] = useState(0);
  useEffect(() => onBrandChange(() => bump((n) => n + 1)), []);
  return {
    dark,
    bg: dark ? '#0f1514' : '#f3f5f4',
    panel: dark ? '#172120' : '#ffffff',
    ink: dark ? '#e4ece9' : '#15211e',
    muted: dark ? '#93a39e' : '#5d6b67',
    line: dark ? '#2a3836' : '#dbe2df',
    brand: BRAND.color,
    ok: dark ? '#5fd18d' : '#1f8a4c',
    warn: dark ? '#f0b35a' : '#a86400',
    bad: dark ? '#ff8a80' : '#b3261e',
  };
}

export function Button({ title, onPress, kind = 'primary', busy, disabled, style }: {
  title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; busy?: boolean; disabled?: boolean; style?: ViewStyle;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.brand : kind === 'danger' ? t.bad : t.panel;
  const fg = kind === 'secondary' ? t.ink : '#fff';
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'secondary' ? t.line : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.muted, fontSize: 13 }}>{label}</Text>
      <TextInput placeholderTextColor={t.muted} {...props}
        style={[s.input, { color: t.ink, borderColor: t.line, backgroundColor: t.bg }, props.style]} />
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[s.card, { backgroundColor: t.panel, borderColor: t.line }, style]}>{children}</View>;
}

export const STATUS: Record<string, string> = { assigned: 'В пути', delivered: 'Вручено', failed: 'Не вручено' };

/** Группа настроек: заголовок и строки, как в системных настройках телефона. */
export function Section({ title, children, footer }: { title: string; children: ReactNode; footer?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: 4 }}>{title}</Text>
      <View style={[s.card, { backgroundColor: t.panel, borderColor: t.line, padding: 0, gap: 0 }]}>{children}</View>
      {!!footer && <Text style={{ color: t.muted, fontSize: 13, paddingHorizontal: 4 }}>{footer}</Text>}
    </View>
  );
}

export function Row({ label, value, onPress, right, last, danger }: {
  label: string; value?: string; onPress?: () => void; right?: ReactNode; last?: boolean; danger?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => [{ minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderColor: t.line, opacity: pressed ? 0.6 : 1 }]}>
      <Text style={{ flex: 1, color: danger ? t.bad : t.ink, fontSize: 16 }}>{label}</Text>
      {!!value && <Text style={{ color: t.muted, fontSize: 15, maxWidth: '55%', textAlign: 'right' }} numberOfLines={2}>{value}</Text>}
      {right}
      {onPress && !right && <Text style={{ color: t.muted, fontSize: 18 }}>›</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: { minHeight: 50, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnText: { fontSize: 16, fontWeight: '600' },
  input: { minHeight: 50, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 17 },
  card: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
});
