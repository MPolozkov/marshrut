import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, STATUS } from '../api';

interface Tracking { trackingNumber: string; status: string; company: string; brandColor: string; events: { status: string; at: string }[] }

/** Публичная страница отслеживания — ссылка на неё уходит получателю в сообщении. */
export function Track() {
  const { number } = useParams();
  const [t, setT] = useState<Tracking | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Tracking>(`/track/${number}`).then((r) => { setT(r); document.documentElement.style.setProperty('--brand', r.brandColor); }).catch((e) => setErr(e.message));
  }, [number]);

  return (
    <div className="wrap" style={{ maxWidth: 560, paddingBlock: 40 }}>
      {err && <div className="err">{err}</div>}
      {t && <div className="panel">
        <div className="note">{t.company}</div>
        <h2 className="mono">{t.trackingNumber}</h2>
        <span className={`pill ${STATUS[t.status][1]}`}>{STATUS[t.status][0]}</span>
        <ol style={{ marginTop: 16, paddingLeft: 18 }}>
          {t.events.map((e, i) => <li key={i}>{STATUS[e.status][0]} — <span className="note">{new Date(e.at).toLocaleString('ru-RU')}</span></li>)}
        </ol>
      </div>}
    </div>
  );
}
