import { FormEvent, useEffect, useState } from 'react';
import { api, authBlobUrl, barcodeUrl, rub, ShipmentRow, STATUS, usePolling, VEHICLE } from '../api';
import { useMe } from '../App';
import { CityInput } from '../components';
import { ShipmentDetail } from './ShipmentDetail';
import { pendingPay } from './ClientApp';
import { Link } from 'react-router-dom';

const PAY: Record<string, [string, string]> = {
  awaiting: ['ждёт банк', 's-new'], held: ['оплачено, резерв', 's-way'], paid: ['оплачено', 's-done'], failed: ['не списалось', 's-fail'], refunded: ['возврат', 's-fail'],
};
interface Quote { distanceKm: number | null; distanceApprox: boolean; night: boolean; vehicle: string | null; recommended: string | null; priceRub: number | null; vehicles: { id: string; label: string; problem: string | null; priceRub: number | null }[] }
const PRESETS: [string, number, number, number, number][] = [['Документы', 0.5, 35, 25, 2], ['Коробка 5 кг', 5, 40, 30, 25], ['Крупная 15 кг', 15, 50, 40, 40], ['Мебель', 80, 150, 80, 80], ['Паллета', 500, 120, 80, 150]];

export function Shipments() {
  const { me } = useMe();
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [filter, setFilter] = useState('');
  const [f, setF] = useState({ city: me.company.city, fromAddress: me.company.pickupAddress ?? '', toStreet: '', toHouse: '', toApartment: '', toEntrance: '', toFloor: '', toIntercom: '', recipientName: '', recipientPhone: '+7', comment: '', externalId: '' });
  const [privateHouse, setPrivateHouse] = useState(false);
  const [cargo, setCargo] = useState({ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 });
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [q, setQ] = useState<Quote | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [label, setLabel] = useState<{ url: string; number: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<ShipmentRow[]>(`/shipments${filter ? `?status=${filter}` : ''}`).then(setRows);
  useEffect(() => { load(); }, [filter]);
  usePolling(load, 20_000, [filter]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  // Цена по тарифу платформы пересчитывается при изменении адресов и груза.
  const body = { city: f.city.trim(), fromAddress: f.fromAddress.trim(), toAddress: [f.toStreet.trim(), f.toHouse.trim()].filter(Boolean).join(', '), ...cargo, vehicle: vehicle ?? undefined };
  const key = JSON.stringify(body);
  useEffect(() => {
    if (body.city.length < 2) { setQ(null); return; }
    const t = setTimeout(() => api<Quote>('/shipments/quote', { body }).then((r) => { setQ(r); if (r.vehicle !== vehicle) setVehicle(r.vehicle); }).catch(() => setQ(null)), 500);
    return () => clearTimeout(t);
  }, [key]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg({}); setBusy(true);
    try {
      const s = await api<{ id: string; trackingNumber: string; priceRub: number; confirmationUrl: string | null }>('/shipments', { body: { ...body, toAddress: undefined, toStreet: f.toStreet, toHouse: f.toHouse, toApartment: privateHouse ? 'частный дом' : f.toApartment, toEntrance: f.toEntrance || undefined, toFloor: f.toFloor || undefined, toIntercom: f.toIntercom || undefined, recipientName: f.recipientName, recipientPhone: f.recipientPhone, comment: f.comment || undefined, externalId: f.externalId || undefined } });
      if (s.confirmationUrl) { pendingPay.set({ check: '/shipments/pay-check', body: { id: s.id }, back: '/admin/shipments' }); location.href = s.confirmationUrl; return; }
      setMsg({ ok: `Доставка ${s.trackingNumber} оформлена: ${rub(s.priceRub)} зарезервировано на карте компании. Заказ уже видят курьеры рядом.` });
      setF({ ...f, toStreet: '', toHouse: '', toApartment: '', toEntrance: '', toFloor: '', toIntercom: '', recipientName: '', recipientPhone: '+7', comment: '', externalId: '' }); load(); showLabel(s.id, s.trackingNumber);
    } catch (e: any) { setMsg({ err: e.message }); } finally { setBusy(false); }
  }
  async function showLabel(id: string, number: string) { setLabel({ url: await barcodeUrl(id), number }); }
  const num = (k: keyof typeof cargo, lbl: string) => <div className="f"><label htmlFor={`c-${k}`}>{lbl}</label>
    <input id={`c-${k}`} type="number" min={0} step={k === 'weightKg' ? 0.1 : 1} value={cargo[k] || ''} onChange={(e) => setCargo({ ...cargo, [k]: Number(e.target.value) })} /></div>;

  return <>
    <ImportPanel onDone={load} />
    <section className="panel">
      <h2>Новая доставка</h2>
      <p className="note">Сумма — по тарифу города: подача + километры + вес, ночью надбавка. Резервируется на <Link to="/admin/settings">карте компании</Link> и списывается после вручения. Заказ сразу видят курьеры рядом с адресом забора. Получатель ничего не платит.</p>
      <form id="ship" className="form" onSubmit={submit}>
        <div className="f"><label htmlFor="ci">Город</label><CityInput id="ci" required value={f.city} onChange={(v) => setF({ ...f, city: v })} /></div>
        <div className="f" style={{ gridColumn: 'span 2' }}><label htmlFor="fa">Откуда забрать</label><input id="fa" required value={f.fromAddress} onChange={set('fromAddress')} placeholder="улица, дом, склад" /></div>
        <div className="f" style={{ gridColumn: 'span 2' }}><label htmlFor="ts">Куда: улица</label><input id="ts" required value={f.toStreet} onChange={set('toStreet')} placeholder="ул. Ленина" /></div>
        <div className="f"><label htmlFor="th">Дом</label><input id="th" required value={f.toHouse} onChange={set('toHouse')} placeholder="12к1" /></div>
        <div className="f"><label htmlFor="tap">Квартира / офис</label><input id="tap" required={!privateHouse} disabled={privateHouse} value={privateHouse ? 'частный дом' : f.toApartment} onChange={set('toApartment')} />
          <label className="check" htmlFor="tph"><input id="tph" type="checkbox" checked={privateHouse} onChange={(e) => setPrivateHouse(e.target.checked)} /><span>частный дом</span></label></div>
        <div className="f"><label htmlFor="te">Подъезд</label><input id="te" value={f.toEntrance} onChange={set('toEntrance')} /></div>
        <div className="f"><label htmlFor="tf">Этаж</label><input id="tf" value={f.toFloor} onChange={set('toFloor')} /></div>
        <div className="f"><label htmlFor="ti">Домофон</label><input id="ti" value={f.toIntercom} onChange={set('toIntercom')} /></div>
        <div className="f"><label htmlFor="rn">Получатель</label><input id="rn" required value={f.recipientName} onChange={set('recipientName')} /></div>
        <div className="f"><label htmlFor="rp">Телефон получателя (для курьера)</label><input id="rp" required type="tel" value={f.recipientPhone} onChange={set('recipientPhone')} /></div>
        <div className="f"><label htmlFor="ex">Номер заказа (необязательно)</label><input id="ex" value={f.externalId} onChange={set('externalId')} /></div>
        {num('weightKg', 'Вес, кг')}{num('lengthCm', 'Длина, см')}{num('widthCm', 'Ширина, см')}{num('heightCm', 'Высота, см')}
        <div className="f" style={{ gridColumn: '1 / -1' }}><label htmlFor="cm">Комментарий курьеру</label><input id="cm" value={f.comment} onChange={set('comment')} placeholder="что везём, домофон, время" /></div>
      </form>
      <div className="row" style={{ marginTop: 8 }}>{PRESETS.map(([l, w, a, b, c]) => <button key={l} type="button" className="btn sm" onClick={() => setCargo({ weightKg: w, lengthCm: a, widthCm: b, heightCm: c })}>{l}</button>)}</div>
      {q && <div className="vehicles" style={{ marginTop: 12 }}>{q.vehicles.map((v) => (
        <button key={v.id} type="button" className={`veh ${vehicle === v.id ? 'on' : ''}`} disabled={!!v.problem} onClick={() => setVehicle(v.id)}>
          <b>{v.label}</b>
          {v.problem ? <span className="note bad">{v.problem}</span> : <span className="note">{v.priceRub != null ? rub(v.priceRub) : 'нужен точный адрес'}{q.recommended === v.id && ' · оптимально'}</span>}
        </button>))}</div>}
      {q && <p className="note">{q.distanceKm != null && `${q.distanceApprox ? '≈ ' : ''}${q.distanceKm} км`}{q.night && ' · ночной тариф'}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" form="ship" disabled={busy || q?.priceRub == null}>{q?.priceRub != null ? `Оформить за ${rub(q.priceRub)}` : 'Оформить'}</button>
        {msg.ok && <span className="okmsg">{msg.ok}</span>}
        {msg.err && <span className="err">{msg.err}</span>}
      </div>
      {label && <div className="panel" style={{ marginTop: 12, background: '#fff', maxWidth: 360 }}>
        <img src={label.url} alt={`Штрихкод ${label.number}`} style={{ width: '100%' }} />
        <p className="note">Наклейте на посылку: курьер отсканирует его в приложении.</p>
      </div>}
    </section>

    {open && <ShipmentDetail id={open} onClose={() => setOpen(null)} />}
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Доставки</h2>
        <div className="row">
        <button className="btn sm" onClick={async () => {
          const a = document.createElement('a');
          a.href = await authBlobUrl('/shipments/export.csv'); a.download = `nakladnye-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
        }}>Выгрузить в Excel (CSV)</button>
        <select style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Фильтр по статусу">
          <option value="">Все статусы</option>
          {Object.entries(STATUS).map(([k, [v]]) => <option key={k} value={k}>{v}</option>)}
        </select>
        </div>
      </div>
      <div className="tbl"><table>
        <thead><tr><th>Номер</th><th>Откуда</th><th>Получатель</th><th>Транспорт</th><th>Цена</th><th>Оплата</th><th>Статус</th><th>Курьер</th><th></th></tr></thead>
        <tbody>{rows.map((s) => <tr key={s.id}>
          <td><span className="mono">{s.trackingNumber}</span>{s.source !== 'manual' && <div className="note">{({ api: 'API', import: 'файл', client: 'клиент' } as Record<string, string>)[s.source]}{s.externalId && ` · ${s.externalId}`}{s.rating && ` · ★${s.rating}`}</div>}</td><td>{s.pickupAddress ?? s.senderName}</td>
          <td>{s.recipientName}<div className="note">{s.address}</div></td><td>{s.vehicle ? VEHICLE[s.vehicle] : '—'}<div className="note">{s.weightKg} кг</div></td>
          <td>{rub(s.priceRub)}</td><td>{PAY[s.payStatus] ? <span className={`pill ${PAY[s.payStatus][1]}`}>{PAY[s.payStatus][0]}</span> : '—'}</td>
          <td><span className={`pill ${STATUS[s.status][1]}`}>{STATUS[s.status][0]}</span>{s.cellCode && <span className="mono"> · {s.cellCode}</span>}</td>
          <td>{s.courierName ?? '—'}</td>
          <td className="row" style={{ flexWrap: 'nowrap' }}>
            <button className="btn sm" onClick={() => { setOpen(s.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Подробнее</button>
            <button className="btn sm" onClick={() => showLabel(s.id, s.trackingNumber)}>Штрихкод</button>
          </td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <p className="note">Доставок пока нет. Оформите первую в форме выше.</p>}
    </section>
  </>;
}

const SAMPLE = 'Номер заказа;Получатель;Телефон;Город;Откуда;Улица;Дом;Квартира;Подъезд;Этаж;Вес;Транспорт;Комментарий\nORDER-1;Мария Котова;+79131234567;Новосибирск;ул. Кирова, 86;ул. Ленина;12;4;1;2;2,5;car;хрупкое\n';

/** Загрузка заказов из Excel: файл сохраняют как «CSV (разделители — точка с запятой)». */
function ImportPanel({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ created: number; duplicates: number; errors: { line: number; error: string }[] } | null>(null);
  const [err, setErr] = useState('');

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr(''); setRes(null); setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      // Excel в России часто сохраняет CSV в кодировке Windows-1251.
      let csv = new TextDecoder('utf-8').decode(buf);
      if (csv.includes('\uFFFD')) csv = new TextDecoder('windows-1251').decode(buf);
      const r = await api<typeof res>('/shipments/import', { body: { csv } });
      setRes(r); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!open) return <div className="row"><button className="btn" onClick={() => setOpen(true)}>Загрузить заказы из Excel</button>
    <span className="note">или подключите автоматическую передачу во вкладке «Интеграции»</span></div>;
  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Загрузка заказов из Excel</h2><button className="btn sm" onClick={() => setOpen(false)}>Скрыть</button></div>
      <ol className="steps">
        <li>В Excel первой строкой — заголовки. Обязательные: <b>Получатель</b>, <b>Телефон</b>, <b>Улица</b>, <b>Дом</b>, <b>Квартира</b> (для частного дома — «частный дом»). Подъезд и Этаж — по желанию. Сумма каждой доставки резервируется на карте компании. Дополнительно: Номер заказа, Город, Откуда, Вес, Длина, Ширина, Высота, Транспорт (foot, bike, car, truck_m), Комментарий. Город и «Откуда» по умолчанию — из «Настроек».</li>
        <li>«Файл» → «Сохранить как» → «CSV (разделители — точки с запятой)».</li>
        <li>Выберите файл ниже. Если в файле есть «Номер заказа», повторная загрузка не создаст дублей.</li>
      </ol>
      <div className="row">
        <div className="f" style={{ flex: '1 1 220px' }}><label htmlFor="impf">Файл CSV</label><input id="impf" type="file" accept=".csv,text/csv" disabled={busy} onChange={onFile} /></div>
        <button type="button" className="btn sm" onClick={() => {
          const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\uFEFF' + SAMPLE], { type: 'text/csv' })); a.download = 'obrazec-zakazov.csv'; a.click();
        }}>Скачать образец</button>
      </div>
      {busy && <p className="note">Загружаем…</p>}
      {err && <p className="err">{err}</p>}
      {res && <div className={res.errors.length ? 'err' : 'okmsg'} style={{ marginTop: 10 }}>
        Оформлено доставок: {res.created}. Уже были загружены раньше: {res.duplicates}. С ошибками: {res.errors.length}.
        {res.errors.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{res.errors.slice(0, 20).map((e) => <li key={e.line}>Строка {e.line}: {e.error}</li>)}</ul>}
      </div>}
    </section>
  );
}
