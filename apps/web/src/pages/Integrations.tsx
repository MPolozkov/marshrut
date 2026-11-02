import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { CopyButton } from '../components';

interface Co { apiKeyPrefix: string | null; hasApiKey: boolean; webhookUrl: string | null }

/**
 * Как заказы попадают в систему автоматически: интернет-магазин, 1С, CRM или любая программа клиента
 * отправляет заказ по API-ключу компании — накладная появляется сама, а статусы уходят обратно по вебхуку.
 */
export function Integrations() {
  const [c, setC] = useState<Co | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [hook, setHook] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  const load = () => api<Co>('/company').then((r) => { setC(r); setHook(r.webhookUrl ?? ''); });
  useEffect(() => { load().catch((e) => setMsg({ err: e.message })); }, []);
  const base = `${location.origin}/api/integration/v1`;
  const key = newKey ?? 'mr_live_ВАШ_КЛЮЧ';

  async function issue() {
    setMsg({}); setConfirm(false);
    try { const r = await api<{ apiKey: string }>('/company/api-key', { method: 'POST' }); setNewKey(r.apiKey); load(); }
    catch (e: any) { setMsg({ err: e.message }); }
  }
  async function saveHook(e: FormEvent) {
    e.preventDefault(); setMsg({});
    try {
      const r = await api<{ secret: string | null }>('/company/webhook', { method: 'PUT', body: { url: hook.trim() || null } });
      setSecret(r.secret); setMsg({ ok: hook.trim() ? 'Адрес сохранён. Статусы будут приходить на него.' : 'Вебхук отключён' }); load();
    } catch (e: any) { setMsg({ err: e.message }); }
  }
  async function testHook() {
    setMsg({});
    try { const r = await api<{ status: number; ok: boolean }>('/company/webhook/test', { method: 'POST' });
      setMsg(r.ok ? { ok: `Тест отправлен, ваш сервер ответил ${r.status}` } : { err: `Ваш сервер ответил ошибкой ${r.status}` }); }
    catch (e: any) { setMsg({ err: e.message }); }
  }

  const curl = `curl -X POST ${base}/orders \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "externalId": "ORDER-1042",
    "recipient": { "name": "Мария Котова", "phone": "+79131234567" },
    "city": "Новосибирск",
    "pickupAddress": "ул. Кирова, 86",
    "address": "ул. Ленина, 12, кв. 4",
    "weightKg": 2.5,
    "vehicle": "car"
  }'`;

  return <>
    {msg.ok && <div className="okmsg">{msg.ok}</div>}
    {msg.err && <div className="err">{msg.err}</div>}

    <section className="panel">
      <h2>Как заказы попадают в систему сами</h2>
      <p className="note">Вручную накладные создавать не обязательно. Есть три способа загружать заказы автоматически:</p>
      <ol className="steps">
        <li><b>API.</b> Сайт, интернет-магазин, 1С или CRM отправляет заказ по вашему ключу. Ключ определяет вашу компанию, поэтому заказ сразу появляется в «Накладных», а клиент получает SMS с кодом. Подходит, если у отправителя есть программист или модуль интеграции.</li>
        <li><b>Вебхук.</b> Мы сами сообщаем вашей системе о каждом статусе: принят, у курьера, доставлен, не вручён.</li>
        <li><b>Файл из Excel.</b> Если программиста нет, выгрузите заказы из своей программы в Excel и загрузите в «Накладных» кнопкой «Загрузить из Excel».</li>
      </ol>
      <div className="okmsg" style={{ marginTop: 10 }}>
        Нет программиста или не получается? <b>Подключим бесплатно.</b> <Link to="/admin/support?topic=integration">Оставить заявку на подключение</Link> — опишите систему и отметьте, какие доступы готовы передать.
      </div>
    </section>

    <section className="panel">
      <h2>API-ключ</h2>
      {newKey ? <div className="okmsg" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <b>Новый ключ. Скопируйте и сохраните его сейчас: повторно он не показывается.</b>
        <div className="row"><span className="mono" style={{ wordBreak: 'break-all' }}>{newKey}</span><CopyButton text={newKey} /></div>
      </div> : <p>{c?.hasApiKey ? <>Ключ выпущен: <span className="mono">{c.apiKeyPrefix}…</span></> : 'Ключа ещё нет.'}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        {!confirm
          ? <button className="btn primary" onClick={() => c?.hasApiKey ? setConfirm(true) : issue()}>{c?.hasApiKey ? 'Выпустить новый ключ' : 'Выпустить ключ'}</button>
          : <><span className="note">Старый ключ сразу перестанет работать.</span><button className="btn primary" onClick={issue}>Да, выпустить новый</button><button className="btn" onClick={() => setConfirm(false)}>Отмена</button></>}
        {c?.hasApiKey && !confirm && <button className="btn" onClick={() => api('/company/api-key', { method: 'DELETE' }).then(() => { setNewKey(null); load(); setMsg({ ok: 'Ключ отозван' }); })}>Отозвать</button>}
      </div>
    </section>

    <section className="panel">
      <h2>Пример запроса</h2>
      <p className="note">Передайте это программисту вашего клиента или подключите в своей системе. Поля <span className="mono">city</span>, <span className="mono">pickupAddress</span>, размеры и <span className="mono">vehicle</span> (foot, bike, car, truck_m) необязательны: город и адрес забора берутся из «Настроек», транспорт подбирается по грузу. Сумма считается по тарифу города и резервируется на карте компании — заказ сразу видят курьеры.</p>
      <pre className="code">{curl}</pre>
      <div className="row"><CopyButton text={curl} /></div>
      <h3 className="h3">Методы</h3>
      <div className="tbl"><table><tbody>
        <tr><td className="mono">POST /orders</td><td>Создать заказ или пачку <span className="mono">{'{ "orders": [...] }'}</span> до 500 штук. Повтор с тем же <span className="mono">externalId</span> не создаёт дубль.</td></tr>
        <tr><td className="mono">GET /orders/:номер</td><td>Статус по номеру накладной или по вашему номеру заказа</td></tr>
        <tr><td className="mono">GET /ping</td><td>Проверка ключа</td></tr>
      </tbody></table></div>
      <p className="note">Адрес API: <span className="mono">{base}</span></p>
    </section>

    <section className="panel">
      <h2>Вебхук: уведомления о статусах</h2>
      <form className="row" onSubmit={saveHook}>
        <div className="f" style={{ flex: '1 1 320px' }}><label htmlFor="wh">Адрес вашего сервера</label>
          <input id="wh" type="url" placeholder="https://shop.ru/marshrut-webhook" value={hook} onChange={(e) => setHook(e.target.value)} /></div>
        <button className="btn primary">Сохранить</button>
        {c?.webhookUrl && <button type="button" className="btn" onClick={testHook}>Отправить тест</button>}
      </form>
      {secret && <div className="okmsg" style={{ marginTop: 10 }}>Секрет для проверки подписи: <span className="mono">{secret}</span> <CopyButton text={secret} /></div>}
      <p className="note" style={{ marginTop: 10 }}>При создании накладной и каждой смене статуса мы отправляем POST с JSON: <span className="mono">event</span> (<span className="mono">shipment.created</span>, <span className="mono">shipment.status</span>) и <span className="mono">data</span> (номер, ваш <span className="mono">externalId</span>, статус, причина невручения, ссылка на отслеживание). Заголовок <span className="mono">X-Marshrut-Signature</span> — HMAC-SHA256 тела вашим секретом. Если ваш сервер не ответил, повторим до 4 раз за 40 минут.</p>
    </section>
  </>;
}
