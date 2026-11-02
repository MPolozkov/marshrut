import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

type Topic = 'integration' | 'problem' | 'plan' | 'idea' | 'other';
interface Options { systems: Record<string, string>; directions: Record<string, string>; access: Record<string, string>; email: string }

const TOPICS: [Topic, string][] = [
  ['integration', 'Бесплатно подключить мой магазин, 1С или CRM'],
  ['problem', 'Не получается подключиться или что-то не работает'],
  ['plan', 'Вопрос о тарифе или оплате'],
  ['idea', 'Предложить доработку системы'],
  ['other', 'Другой вопрос'],
];

/**
 * Обращение в техподдержку. Для подключения просим подробное описание и отмечаем, какие доступы клиент готов передать:
 * так инженер начинает работу без лишних переписок. Сами пароли и ключи в форму не вписываются — их передают инженеру отдельно.
 */
export function SupportForm({ guest, defaults }: { guest?: boolean; defaults?: { topic?: Topic; plan?: string; name?: string; email?: string } }) {
  const source = guest ? 'site' : 'cabinet';
  const [opt, setOpt] = useState<Options | null>(null);
  const [topic, setTopic] = useState<Topic>(defaults?.topic ?? 'integration');
  const [f, setF] = useState({
    subject: '', message: '', contactName: defaults?.name ?? '', contactEmail: defaults?.email ?? '', contactPhone: '', companyName: '',
    system: '', systemOther: '', systemUrl: '', direction: '', ordersPerDay: '', accessNotes: '', preferredTime: '', plan: defaults?.plan ?? '',
  });
  const [access, setAccess] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ number: string; emailSent: boolean; supportEmail: string } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { api<Options>('/support/options').then(setOpt).catch(() => {}); }, []);
  useEffect(() => { if (defaults?.topic) setTopic(defaults.topic); if (defaults?.plan) setF((x) => ({ ...x, plan: defaults.plan! })); }, [defaults?.topic, defaults?.plan]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const isInt = topic === 'integration';
  const min = isInt ? 100 : topic === 'idea' ? 20 : 30;

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body: Record<string, unknown> = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== '')), topic, access, source };
      if (!body.subject) body.subject = isInt ? `Подключение: ${opt?.systems[f.system] ?? 'интеграция'}` : TOPICS.find(([t]) => t === topic)![1];
      setDone(await api('/support', { body }));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (done) return (
    <div className="okmsg" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <b>Обращение №{done.number} принято.</b>
      <span>Инженер свяжется с вами по {f.contactEmail || 'указанной почте'} в течение одного рабочего дня.{isInt && ' Подготовьте доступы, которые вы отметили: инженер попросит передать их по защищённому каналу.'}</span>
      {!done.emailSent && <span className="note">Если ответа долго нет, напишите напрямую: <span className="mono">{done.supportEmail}</span></span>}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setDone(null); setF({ ...f, message: '', subject: '' }); setAccess([]); }}>Написать ещё</button>
    </div>
  );

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <fieldset className="fs" style={{ margin: 0 }}>
        <legend>С чем помочь</legend>
        {TOPICS.map(([t, label]) => <label key={t} className="check" htmlFor={`tp-${t}`}>
          <input id={`tp-${t}`} type="radio" name="topic" checked={topic === t} onChange={() => setTopic(t)} /><span>{label}</span></label>)}
      </fieldset>

      {isInt && <>
        <div className="note" style={{ background: 'var(--bg)', padding: '10px 12px', borderRadius: 8 }}>
          Подключение <b>бесплатное</b> на любом тарифе. Чтобы инженер начал сразу, опишите, <b>что</b> и <b>куда</b> подключаем, и отметьте, какие доступы вы готовы передать.
        </div>
        <div className="form">
          <div className="f"><label htmlFor="sys">Что подключаем</label>
            <select id="sys" required value={f.system} onChange={set('system')}>
              <option value="">Выберите систему…</option>
              {opt && Object.entries(opt.systems).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          {(f.system === 'other' || f.system === 'custom' || f.system === 'marketplace') &&
            <div className="f"><label htmlFor="syso">Уточните систему</label><input id="syso" value={f.systemOther} onChange={set('systemOther')} placeholder="Например: сайт на Laravel, Ozon FBS" /></div>}
          <div className="f"><label htmlFor="sysu">Адрес сайта или системы</label><input id="sysu" value={f.systemUrl} onChange={set('systemUrl')} placeholder="https://shop.ru" /></div>
          <div className="f"><label htmlFor="opd">Сколько заказов в день</label>
            <select id="opd" value={f.ordersPerDay} onChange={set('ordersPerDay')}>
              <option value="">Не знаю</option><option>до 20</option><option>20–100</option><option>100–500</option><option>больше 500</option>
            </select></div>
        </div>
        <fieldset className="fs" style={{ margin: 0 }}>
          <legend>Что и куда передавать</legend>
          {opt && Object.entries(opt.directions).map(([k, v]) => <label key={k} className="check" htmlFor={`dir-${k}`}>
            <input id={`dir-${k}`} type="radio" name="direction" checked={f.direction === k} onChange={() => setF({ ...f, direction: k })} /><span>{v}</span></label>)}
        </fieldset>
        <fieldset className="fs" style={{ margin: 0 }}>
          <legend>Какие доступы вы готовы предоставить</legend>
          <p className="note">Отметьте, что есть или что вы сможете получить. Сами пароли и ключи сюда <b>не вписывайте</b>: инженер попросит передать их отдельно, по защищённому каналу. Лучше создать для подключения отдельную учётную запись — её можно отключить после настройки.</p>
          {opt && Object.entries(opt.access).map(([k, v]) => <label key={k} className="check" htmlFor={`acc-${k}`}>
            <input id={`acc-${k}`} type="checkbox" checked={access.includes(k)} onChange={(e) => setAccess(e.target.checked ? [...access, k] : access.filter((a) => a !== k))} /><span>{v}</span></label>)}
          <div className="f"><label htmlFor="accn">Комментарий о доступах</label>
            <input id="accn" value={f.accessNotes} onChange={set('accessNotes')} placeholder="Например: ключ API есть в разделе «Настройки → Интеграции» магазина, программист на связи по будням" /></div>
        </fieldset>
      </>}

      {topic === 'plan' && <div className="f"><label htmlFor="pl">Тариф</label>
        <select id="pl" value={f.plan} onChange={set('plan')}><option value="">Не выбран</option><option value="start">Старт</option><option value="business">Бизнес</option><option value="white_label">White-label</option></select></div>}

      {topic === 'idea' && <div className="note" style={{ background: 'var(--bg)', padding: '10px 12px', borderRadius: 8 }}>
        Чего не хватает в системе? Опишите, какую задачу хотите решить и как сейчас это делаете. Лучшие идеи попадают в план разработки — мы напишем, когда доработка появится.
      </div>}

      {!isInt && <div className="f"><label htmlFor="subj">Тема</label><input id="subj" required minLength={5} value={f.subject} onChange={set('subject')} placeholder="Коротко, в чём вопрос" /></div>}

      <div className="f"><label htmlFor="msg">{isInt ? 'Подробное описание подключения' : 'Подробное описание'}</label>
        <textarea id="msg" required minLength={min} rows={isInt ? 7 : 5} value={f.message} onChange={set('message')}
          placeholder={isInt
            ? 'Например: магазин на InSales, около 50 заказов в день. Хотим, чтобы оплаченные заказы сами появлялись в Маршруте, а статус «Доставлен» возвращался в магазин. Наложенный платёж нужен только для заказов с оплатой при получении. Доставляем по Новосибирску и Бердску.'
            : topic === 'idea' ? 'Например: хочу, чтобы курьер видел все заказы на карте и мог сам выбрать маршрут.' : 'Что делали, что ожидали увидеть и что произошло. Если есть текст ошибки — вставьте его.'} />
        <span className="note">{f.message.length < min ? `Ещё ${min - f.message.length} символов минимум` : 'Спасибо, так инженеру будет проще'}</span></div>

      <div className="form">
        <div className="f"><label htmlFor="cname">Ваше имя</label><input id="cname" required value={f.contactName} onChange={set('contactName')} autoComplete="name" /></div>
        <div className="f"><label htmlFor="cmail">Email для ответа</label><input id="cmail" type="email" required value={f.contactEmail} onChange={set('contactEmail')} autoComplete="email" /></div>
        <div className="f"><label htmlFor="cphone">Телефон</label><input id="cphone" type="tel" value={f.contactPhone} onChange={set('contactPhone')} placeholder="+7 900 000-00-00" /></div>
        <div className="f"><label htmlFor="ctime">Когда удобно связаться</label><input id="ctime" value={f.preferredTime} onChange={set('preferredTime')} placeholder="Будни 10–18 по Новосибирску" /></div>
        {guest && <div className="f"><label htmlFor="ccomp">Название компании</label><input id="ccomp" value={f.companyName} onChange={set('companyName')} /></div>}
      </div>

      {err && <div className="err">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || f.message.length < min}>{busy ? 'Отправляем…' : 'Отправить в поддержку'}</button>
        {opt && <span className="note">или напишите на <span className="mono">{opt.email}</span></span>}
      </div>
    </form>
  );
}
