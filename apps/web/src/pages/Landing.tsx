import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth } from '../api';
import { SupportForm } from '../components/SupportForm';
import { IdeaBox } from '../components/IdeaBox';

interface Pricing { feePercent: number; courierPercent: number; nightPercent: number; vehicles: { id: string; label: string; maxKg: number; rate: { baseRub: number; perKmRub: number; freeKg: number; perKgRub: number } }[] }

const FOR_WHOM: [string, string][] = [
  ['Частным лицам', 'Отправить документы, подарок, вещи или технику по городу. Приложение «Маршрут» → «Я заказчик»: адрес, груз, цена сразу, оплата картой.'],
  ['Магазинам и компаниям', 'Кабинет на сайте: доставки вручную, файлом из Excel или автоматически по API из сайта и 1С. Оплата картой компании.'],
  ['Курьерам', 'Работа самозанятым: заказы рядом, сумма видна до принятия, вывод денег по СБП с автоматическим чеком в «Мой налог».'],
];
const STEPS = [
  'Заказчик указывает откуда, куда, вес и габариты — приложение подбирает транспорт и сразу показывает сумму.',
  'Сумма резервируется на карте заказчика. Получатель ничего не платит.',
  'Заказ сразу видят курьеры рядом с адресом забора и получают push; везёт тот, кто первым нажал «Беру».',
  'Курьер вручает по коду. Сумма списывается с карты: платформе — её процент, курьеру — остальное. Отменили до забора — резерв снимается.',
];

/** Главная: как работает сервис, как считается сумма заказа, вход для организаций. */
export function Landing() {
  const [p, setP] = useState<Pricing | null>(null);
  useEffect(() => {
    document.title = 'Маршрут — доставка по городу курьерами рядом';
    api<Pricing>('/public/pricing').then(setP).catch(() => {});
  }, []);
  const inCabinet = !!auth.token;

  return <div className="landing">
    <header className="top">
      <div className="wrap bar">
        <div className="logo">М</div><div className="brandname">Маршрут</div>
        <nav className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <a className="btn sm" href="#price">Стоимость</a>
          <a className="btn sm" href="#support">Поддержка</a>
          {inCabinet ? <Link className="btn sm primary" to="/admin">Кабинет компании</Link> : <Link className="btn sm" to="/admin/login">Вход для компаний</Link>}
        </nav>
      </div>
    </header>

    <main className="wrap">
      <section className="hero">
        <h1>Доставка по городу: курьер рядом выезжает сразу</h1>
        <p className="lead">Пешие курьеры, вело и самокаты, легковые и грузовые машины. Сумма известна до заказа, оплата картой, получатель ничего не платит. Без абонентской платы.</p>
        <div className="row">
          <Link className="btn primary" to="/order">Заказать доставку</Link>
          <Link className="btn" to="/register">Подключить компанию</Link>
          <span className="note">Приложение «Маршрут» для заказчиков и курьеров — Android и iPhone</span>
        </div>
      </section>

      <section className="grid3">
        {FOR_WHOM.map(([h, t]) => <div key={h} className="panel"><h3 className="fh">{h}</h3><p className="note">{t}</p></div>)}
      </section>

      <section className="panel">
        <h2>Как это работает</h2>
        <ol className="steps">{STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
      </section>

      <section id="price" className="panel">
        <h2>Как считается сумма заказа</h2>
        <p><b>Сумма = подача + километры по дороге × ставка + каждый кг сверх включённых × ставка</b>{p && <>, ночью (22:00–7:00) +{p.nightPercent}%</>}. Ставки зависят от транспорта и города.</p>
        {p && <div className="tbl"><table>
          <thead><tr><th>Транспорт</th><th>Груз до</th><th>Подача</th><th>За км</th><th>Включено</th><th>За кг сверх</th></tr></thead>
          <tbody>{p.vehicles.map((v) => <tr key={v.id}><td>{v.label}</td><td>{v.maxKg.toLocaleString('ru-RU')} кг</td><td>{v.rate.baseRub} ₽</td><td>{v.rate.perKmRub} ₽</td><td>{v.rate.freeKg} кг</td><td>{v.rate.perKgRub} ₽</td></tr>)}</tbody>
        </table></div>}
        {p && <p className="note">Из суммы заказа {p.courierPercent}% получает курьер, {p.feePercent}% — платформа. Пример: легковой, 7 км, 10 кг днём — подача 450 ₽ + 7 км × 35 ₽ = 700 ₽; курьер получит {Math.round(700 * p.courierPercent / 100)} ₽. Тарифы конкретного города могут отличаться — точная сумма видна при оформлении.</p>}
      </section>

      <section id="support" className="panel">
        <h2>Подключение для компаний и поддержка</h2>
        <p className="note">Подключим ваш интернет-магазин, 1С, МойСклад или CRM бесплатно — заказы будут передаваться сами. Чем подробнее описание, тем быстрее начнём.</p>
        <SupportForm guest />
      </section>

      <IdeaBox source="site" />
    </main>

    <footer className="wrap foot">
      <span>© {new Date().getFullYear()} Маршрут</span>
      <Link to="/privacy">Политика обработки данных</Link>
      <Link to="/terms">Условия использования</Link>
      <span className="mono">pipl82308@gmail.com</span>
    </footer>
  </div>;
}
