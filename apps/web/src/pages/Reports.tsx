import { useEffect, useState } from 'react';
import { api, rub } from '../api';

interface Summary {
  total: number; delivered: number; failed: number; inWork: number; revenueRub: number; codRub: number; failRate: number;
  byDay: { day: string; created: number; delivered: number }[];
  byCourier: { courier: string; delivered: number; failed: number; codRub: number; payRub: number; tipsRub: number; rating: number | null }[];
}
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Reports() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    const end = new Date(to); end.setDate(end.getDate() + 1);
    api<Summary>(`/reports/summary?from=${from}&to=${iso(end)}`).then(setS).catch((e) => setErr(e.message));
  }, [from, to]);

  const max = Math.max(1, ...(s?.byDay.map((d) => d.created) ?? [1]));
  return <>
    <section className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Отчёт за период</h2>
        <div className="row">
          <div className="f"><label htmlFor="rf">С</label><input id="rf" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="f"><label htmlFor="rt">По</label><input id="rt" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </div>
    </section>
    {err && <div className="err">{err}</div>}
    {s && <>
      <div className="kpis">
        <div className="kpi"><b>{s.total}</b><span>отправлений</span></div>
        <div className="kpi"><b>{s.delivered}</b><span>доставлено</span></div>
        <div className="kpi"><b>{s.failRate}%</b><span>невручений от закрытых</span></div>
        <div className="kpi"><b>{rub(s.revenueRub)}</b><span>стоимость доставленных (платили получатели)</span></div>
      </div>
      <section className="panel">
        <h2>Отправления по дням</h2>
        {s.byDay.length ? <>
          <div className="bars" role="img" aria-label="Количество отправлений по дням">
            {s.byDay.map((d) => <div key={d.day} style={{ height: `${(d.created / max) * 100}%` }} title={`${d.day}: создано ${d.created}, доставлено ${d.delivered}`} />)}
          </div>
          <div className="row note" style={{ justifyContent: 'space-between', marginTop: 4 }}><span>{s.byDay[0].day}</span><span>макс. {max} в день</span><span>{s.byDay[s.byDay.length - 1].day}</span></div>
        </> : <p className="note">За период отправлений нет.</p>}
      </section>
      <section className="panel">
        <h2>Курьеры</h2>
        <div className="tbl"><table>
          <thead><tr><th>Курьер</th><th>Доставлено</th><th>Не вручено</th><th>Оценка</th><th>Стоимость доставок</th></tr></thead>
          <tbody>{s.byCourier.map((c) => <tr key={c.courier}><td>{c.courier}</td><td>{c.delivered}</td><td>{c.failed}</td><td>{c.rating ? `★ ${c.rating}` : '—'}</td><td>{rub(c.payRub)}</td></tr>)}</tbody>
        </table></div>
      </section>
    </>}
  </>;
}
