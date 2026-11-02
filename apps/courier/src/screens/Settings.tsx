import { useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { api, API_URL } from '../api';
import { getPrefs, NAVIGATORS, Prefs, setPrefs, useProfile, VEHICLE, VEHICLE_IDS, VehicleId } from '../profile';
import { dismissAll, pendingCount } from '../queue';
import { Button, Field, Row, Section, useTheme } from '../ui';

interface Balance { balanceRub: number; minPayoutRub: number; testMode: boolean; inn: string | null; seStatus: string; payoutDetails: string | null; sbpBankId: string | null; entries: { id: string; kind: string; amountRub: number; status: string | null; createdAt: string }[] }
const KIND: Record<string, string> = { earning: 'За заказ', tip: 'Чаевые', payout: 'Вывод', cash_collected: 'Наличные от клиента', payout: 'Выплата', cash_in: 'Сдал в кассу', adjust: 'Корректировка' };

/** Настройки курьера: профиль, выплаты, навигатор, вручение, пароль, данные в телефоне, выход. */
export function SettingsScreen() {
  const t = useTheme();
  const { profile, reload, logout } = useProfile();
  const [prefs, setP] = useState<Prefs | null>(null);
  const [queued, setQueued] = useState(0);
  const [edit, setEdit] = useState<null | 'profile' | 'password' | 'idea' | 'payout'>(null);
  const [idea, setIdea] = useState('');
  const [stats, setStats] = useState<{ rating: number | null; ratingCount: number; last30: { delivered: number; payRub: number; tipsRub: number }; sharePercent?: number } | null>(null);
  const [f, setF] = useState({ name: '', phone: '' });
  const [vehicle, setVehicle] = useState<VehicleId>('foot');
  const [bal, setBal] = useState<Balance | null>(null);
  const [pay, setPay] = useState({ inn: '', payoutDetails: '', sbpBankId: '' });
  const [banks, setBanks] = useState<{ id: string; name: string }[]>([]);
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  useEffect(() => { getPrefs().then(setP); pendingCount().then(setQueued); api('/courier/stats').then(setStats).catch(() => {});
    loadBalance(); api<{ id: string; name: string }[]>('/courier/sbp-banks').then(setBanks).catch(() => {}); }, []);
  const loadBalance = () => api<Balance>('/courier/balance').then((b) => { setBal(b); setPay({ inn: b.inn ?? '', payoutDetails: b.payoutDetails ?? '', sbpBankId: b.sbpBankId ?? '' }); }).catch(() => {});
  /** Разрешение платформе в «Мой налог» — чтобы чеки по выплатам формировались автоматически. */
  async function connectSe() {
    const r = await api<{ status: string; confirmationUrl: string | null }>('/courier/self-employed', {});
    if (r.confirmationUrl) { await WebBrowser.openBrowserAsync(r.confirmationUrl); await api('/courier/self-employed', {}).catch(() => {}); }
    await loadBalance();
  }
  useEffect(() => {
    if (profile) { setF({ name: profile.name, phone: profile.phone }); setVehicle(profile.vehicle ?? 'foot'); }
  }, [profile]);

  const update = async (p: Partial<Prefs>) => setP(await setPrefs(p));
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg({}); setBusy(true);
    try { await fn(); setMsg({ ok }); setEdit(null); } catch (e: any) { setMsg({ err: e.message }); } finally { setBusy(false); }
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      {!!msg.ok && <Text style={{ color: t.ok, fontSize: 15 }}>{msg.ok}</Text>}
      {!!msg.err && <Text style={{ color: t.bad, fontSize: 15 }}>{msg.err}</Text>}

      <Section title="Профиль">
        {edit === 'profile' ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Field label="Имя и фамилия" value={f.name} onChangeText={(name) => setF({ ...f, name })} />
            <Field label="Телефон" value={f.phone} onChangeText={(phone) => setF({ ...f, phone })} keyboardType="phone-pad" />
            <Text style={{ color: t.muted, fontSize: 13 }}>Как доставляете</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {VEHICLE_IDS.map((v) => <Button key={v} title={VEHICLE[v]} kind={vehicle === v ? 'primary' : 'secondary'} style={{ flexGrow: 1, flexBasis: '45%' }} onPress={() => setVehicle(v)} />)}
            </View>
            <Button title="Сохранить" busy={busy} onPress={() => act(async () => { await api('/courier/me', { ...f, vehicle }, 'PATCH'); await reload(); }, 'Профиль сохранён')} />
            <Button title="Отмена" kind="secondary" onPress={() => setEdit(null)} />
          </View>
        ) : <>
          <Row label="Имя" value={profile?.name} />
          <Row label="Телефон" value={profile?.phone} />
          <Row label="Email для входа" value={profile?.email} />
          <Row label="Транспорт" value={VEHICLE[profile?.vehicle ?? 'foot']} />
          <Row label="Изменить профиль" onPress={() => setEdit('profile')} last />
        </>}
      </Section>

      {stats && <Section title="Работа за 30 дней" footer={`Вам — ${stats.sharePercent ?? 50}% суммы каждого заказа, сумма видна до принятия. Чаевые — полностью ваши.`}>
        <Row label="Доставлено" value={String(stats.last30.delivered)} />
        <Row label="Заработано" value={`${stats.last30.payRub.toLocaleString('ru-RU')} ₽`} />
        <Row label="Чаевые" value={`${stats.last30.tipsRub.toLocaleString('ru-RU')} ₽`} />
        <Row label="Оценка клиентов" value={stats.rating != null ? `★ ${stats.rating} (${stats.ratingCount})` : 'пока нет'} last />
      </Section>}

      {bal && <Section title="Деньги" footer={`Деньги начисляются сразу после отметки «Доставлено». Вывод — по СБП на ваш телефон, от ${bal.minPayoutRub} ₽; чек в «Мой налог» формируется автоматически.${bal.testMode ? ' Тестовый режим: деньги не переводятся.' : ''}`}>
        <Row label="На балансе" value={`${bal.balanceRub.toLocaleString('ru-RU')} ₽`} />
        {bal.entries.slice(0, 5).map((e) => <Row key={e.id} label={`${KIND[e.kind] ?? e.kind}${e.status === 'pending' ? ' (в обработке)' : e.status === 'failed' ? ' (не прошла)' : ''} · ${new Date(e.createdAt).toLocaleDateString('ru-RU')}`} value={`${e.amountRub > 0 ? '+' : ''}${e.amountRub.toLocaleString('ru-RU')} ₽`} />)}
        <Row label="«Мой налог»" value={bal.seStatus === 'confirmed' ? 'подключён' : bal.seStatus === 'pending' ? 'ждём разрешения' : 'не подключён'}
          onPress={bal.seStatus === 'confirmed' ? undefined : () => act(connectSe, 'Статус самозанятого проверен')} />
        {edit === 'payout' ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Field label="ИНН самозанятого (12 цифр)" value={pay.inn} onChangeText={(v) => setPay({ ...pay, inn: v.replace(/\D/g, '') })} keyboardType="number-pad" maxLength={12} />
            <Field label="Телефон для СБП" value={pay.payoutDetails} onChangeText={(v) => setPay({ ...pay, payoutDetails: v })} keyboardType="phone-pad" />
            <Text style={{ color: t.muted, fontSize: 13 }}>Банк</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {banks.map((b) => <Button key={b.id} title={b.name} kind={pay.sbpBankId === b.id ? 'primary' : 'secondary'} style={{ flexGrow: 1, flexBasis: '45%' }} onPress={() => setPay({ ...pay, sbpBankId: b.id })} />)}
            </View>
            <Button title="Сохранить" busy={busy} disabled={pay.inn.length !== 12 || pay.payoutDetails.replace(/\D/g, '').length < 11 || !pay.sbpBankId}
              onPress={() => act(async () => { await api('/courier/me', { inn: pay.inn, payoutMethod: 'sbp', payoutDetails: pay.payoutDetails, sbpBankId: pay.sbpBankId }, 'PATCH'); await loadBalance(); await reload(); }, 'Реквизиты сохранены')} />
            <Button title="Отмена" kind="secondary" onPress={() => setEdit(null)} />
          </View>
        ) : <Row label="Реквизиты для выплат" value={bal.payoutDetails && bal.sbpBankId ? `СБП ${bal.payoutDetails}` : 'не указаны'} onPress={() => setEdit('payout')} />}
        <Row label={`Вывести ${Math.max(0, bal.balanceRub).toLocaleString('ru-RU')} ₽`} last
          onPress={bal.balanceRub >= bal.minPayoutRub ? () => act(async () => { await api('/courier/payout', {}); await loadBalance(); }, 'Деньги отправлены по СБП') : undefined} />
      </Section>}

      <Section title="Поддержка">
        <Row label="Город работы" value={profile?.city} />
        <Row label="Написать в поддержку" value="pipl82308@gmail.com" onPress={() => Linking.openURL('mailto:pipl82308@gmail.com')} last />
      </Section>

      {prefs && <Section title="Навигатор" footer="Кнопка «Маршрут» в карточке доставки откроет выбранное приложение. Если его нет на телефоне, откроется карта в браузере.">
        {NAVIGATORS.map(([id, name], i) => (
          <Row key={id} label={name} onPress={() => update({ navigator: id, navigatorChosen: true })} last={i === NAVIGATORS.length - 1}
            right={prefs.navigator === id ? <Text style={{ color: t.brand, fontSize: 18, fontWeight: '700' }}>✓</Text> : <View style={{ width: 14 }} />} />
        ))}
      </Section>}

      {prefs && <Section title="Вручение">
        <Row label="Всегда просить фото посылки" right={<Switch value={prefs.photoRequired} onValueChange={(v) => update({ photoRequired: v })} trackColor={{ true: t.brand }} />} last />
      </Section>}

      <Section title="Безопасность">
        {edit === 'password' ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Field label="Текущий пароль" value={pw.oldPassword} onChangeText={(oldPassword) => setPw({ ...pw, oldPassword })} secureTextEntry />
            <Field label="Новый пароль, от 8 символов" value={pw.newPassword} onChangeText={(newPassword) => setPw({ ...pw, newPassword })} secureTextEntry />
            <Button title="Сменить пароль" busy={busy} disabled={!pw.oldPassword || pw.newPassword.length < 8}
              onPress={() => act(async () => { await api('/auth/change-password', pw); setPw({ oldPassword: '', newPassword: '' }); }, 'Пароль изменён')} />
            <Button title="Отмена" kind="secondary" onPress={() => setEdit(null)} />
          </View>
        ) : <Row label="Сменить пароль" onPress={() => setEdit('password')} last />}
      </Section>

      <Section title="Предложить доработку" footer="Чего не хватает в приложении? Идеи приходят напрямую разработчикам.">
        {edit === 'idea' ? (
          <View style={{ padding: 16, gap: 12 }}>
            <Field label="Что улучшить, от 20 символов" value={idea} onChangeText={setIdea} multiline numberOfLines={5} style={{ minHeight: 110, textAlignVertical: 'top' }} />
            <Button title="Отправить" busy={busy} disabled={idea.trim().length < 20}
              onPress={() => act(async () => {
                await api('/support', { topic: 'idea', source: 'courier_app', subject: 'Идея из приложения курьера', message: idea.trim(),
                  contactName: profile?.name ?? 'Курьер', contactEmail: profile?.email ?? '', contactPhone: profile?.phone, companyName: profile?.company?.name });
                setIdea('');
              }, 'Спасибо! Предложение отправлено.')} />
            <Button title="Отмена" kind="secondary" onPress={() => setEdit(null)} />
          </View>
        ) : <Row label="Написать предложение" onPress={() => setEdit('idea')} last />}
      </Section>

      <Section title="Данные в телефоне" footer={queued ? 'Эти отметки ещё не дошли до сервера. Удаляйте их, только если поддержка уже отметила доставки сама.' : undefined}>
        <Row label="Ждут отправки" value={String(queued)} />
        <Row label="Удалить неотправленные отметки" danger={!!queued} last onPress={queued ? () => Alert.alert(
          'Удалить отметки?', `${queued} вручений и отказов не будут отправлены на сервер.`,
          [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: async () => { await dismissAll(); setQueued(0); } }],
        ) : undefined} />
      </Section>

      <Section title="О приложении">
        <Row label="Версия" value={Constants.expoConfig?.version ?? '—'} />
        <Row label="Сервер" value={API_URL.replace(/^https?:\/\//, '')} last />
      </Section>

      <Button title="Выйти из аккаунта" kind="danger" onPress={() => Alert.alert('Выйти?', queued ? 'Неотправленные отметки будут удалены.' : 'Чтобы снова войти, понадобятся email и пароль.',
        [{ text: 'Отмена', style: 'cancel' }, { text: 'Выйти', style: 'destructive', onPress: logout }])} />
    </ScrollView>
  );
}
