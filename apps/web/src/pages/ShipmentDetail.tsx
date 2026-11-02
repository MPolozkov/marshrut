import { useEffect, useState } from 'react';
import { api, authBlobUrl, rub, STATUS } from '../api';

interface Detail {
  id: string; trackingNumber: string; senderName: string; senderPhone: string | null; recipientName: string; recipientPhone: string | null;
  address: string; weightKg: number; lengthCm: number; widthCm: number; heightCm: number; chargeableKg: number; priceRub: number;
  codRub: number; codCollected: number | null; codMethod: string | null; status: string; confirmCode: string; failReason: string | null;
  proofPhoto: string | null; proofSignature: string | null; deliveredLat: number | null; deliveredLng: number | null; deliveredAt: string | null;
  events: { status: string; note: string | null; createdAt: string }[];
  pickupAddress: string | null; pickupName: string | null; pickupPhone: string | null; pickedUpAt: string | null; comment: string | null;
  courierPayRub: number | null; tipRub: number; tipMethod: string | null; rating: number | null; ratingComment: string | null;
  courierId: string | null; offeredAt: string | null; vehicle: string | null; payStatus: string; payDeadline: string | null; platformFeeRub: number | null;
}
const VEH: Record<string, string> = { foot: 'пеший курьер', bike: 'вело / самокат', car: 'легковой', truck_m: 'грузовой 3,5–5 т' };
const PAYST: Record<string, string> = { awaiting: 'ждём подтверждения банка', held: 'зарезервирована на карте', paid: 'списана с карты', failed: 'не списалась — долг заказчика', refunded: 'резерв снят, деньги вернулись' };
const METHOD: Record<string, string> = { cash: 'наличные', card: 'карта', sbp: 'СБП' };

/** Карточка отправления: история статусов и подтверждение вручения — главный аргумент в спорах с клиентами. */
export function ShipmentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [img, setImg] = useState<{ photo?: string; sign?: string }>({});
  const [err, setErr] = useState('');


  useEffect(() => {
    let urls: string[] = [];
    api<Detail>(`/shipments/${id}`).then(async (r) => {
      setD(r);
      const photo = r.proofPhoto ? await authBlobUrl(`/files/${r.proofPhoto}`).catch(() => undefined) : undefined;
      const sign = r.proofSignature ? await authBlobUrl(`/files/${r.proofSignature}`).catch(() => undefined) : undefined;
      urls = [photo, sign].filter(Boolean) as string[];
      setImg({ photo, sign });
    }).catch((e) => setErr(e.message));
    return () => urls.forEach(URL.revokeObjectURL);
  }, [id]);

  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 className="mono" style={{ margin: 0 }}>{d?.trackingNumber ?? '…'}</h2>
        <button className="btn sm" onClick={onClose}>Закрыть</button>
      </div>
      {err && <div className="err">{err}</div>}
      {d && <div className="detail">
        <div>
          <p><span className={`pill ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span></p>
          <dl className="dl">
            <dt>Отправитель</dt><dd>{d.senderName}{d.senderPhone && `, ${d.senderPhone}`}</dd>
            {d.pickupAddress && <><dt>Забрать</dt><dd>{d.pickupAddress}{d.pickupName && `, ${d.pickupName}`}{d.pickupPhone && `, ${d.pickupPhone}`}{d.pickedUpAt && <div className="note">забрал {new Date(d.pickedUpAt).toLocaleString('ru-RU')}</div>}</dd></>}
            {d.comment && <><dt>Комментарий</dt><dd>{d.comment}</dd></>}
            <dt>Получатель</dt><dd>{d.recipientName}{d.recipientPhone && `, ${d.recipientPhone}`}</dd>
            <dt>Адрес</dt><dd>{d.address}</dd>
            <dt>Габариты</dt><dd>{d.lengthCm}×{d.widthCm}×{d.heightCm} см, {d.weightKg} кг (к оплате {d.chargeableKg} кг)</dd>
            <dt>Стоимость</dt><dd>{rub(d.priceRub)}</dd>
            {d.vehicle && <><dt>Транспорт</dt><dd>{VEH[d.vehicle] ?? d.vehicle}</dd></>}
            {d.payStatus && d.payStatus !== 'none' && <><dt>Оплата картой</dt><dd>{PAYST[d.payStatus] ?? d.payStatus}</dd></>}
            {d.codRub > 0 && <><dt>Наложенный платёж</dt><dd>{rub(d.codRub)}{d.codCollected != null && ` · получено ${rub(d.codCollected)} (${METHOD[d.codMethod ?? 'cash']})`}</dd></>}
            <dt>Код вручения</dt><dd className="mono">{d.confirmCode}</dd>
            {d.failReason && <><dt>Причина невручения</dt><dd>{d.failReason}</dd></>}
            {d.courierPayRub != null && <><dt>Курьеру</dt><dd>{rub(d.courierPayRub)}{d.tipRub > 0 && ` + чаевые ${rub(d.tipRub)} (${d.tipMethod === 'transfer' ? 'переводом' : 'наличными'})`}</dd></>}
            {d.rating && <><dt>Оценка клиента</dt><dd>{'★'.repeat(d.rating)}{'☆'.repeat(5 - d.rating)}{d.ratingComment && ` — ${d.ratingComment}`}</dd></>}
          </dl>
          {d.payStatus === 'held' && !d.courierId && d.status !== 'returned' && <p><span className="pill s-way">Оплачено, ищем курьера рядом</span></p>}
          <h3 className="h3">История</h3>
          <ol className="timeline">{d.events.map((e, i) => <li key={i}><b>{STATUS[e.status][0]}</b>{e.note && ` — ${e.note}`}<div className="note">{new Date(e.createdAt).toLocaleString('ru-RU')}</div></li>)}</ol>
        </div>
        {d.status === 'delivered' && <div>
          <h3 className="h3">Подтверждение вручения</h3>
          <p className="note">{d.deliveredAt && new Date(d.deliveredAt).toLocaleString('ru-RU')}</p>
          {img.photo ? <img src={img.photo} alt="Фото посылки при вручении" className="proof" /> : <p className="note">Фото не прикреплено.</p>}
          {img.sign && <img src={img.sign} alt="Подпись получателя" className="proof sign" />}
          {d.deliveredLat != null && <p><a href={`https://yandex.ru/maps/?pt=${d.deliveredLng},${d.deliveredLat}&z=17&l=map`} target="_blank" rel="noreferrer">Место вручения на карте</a></p>}
        </div>}
      </div>}
    </section>
  );
}
