import { FormEvent, useState } from 'react';
import { api } from '../api';

/** «Что доработать в системе»: короткая форма, предложение уходит на почту поддержки. */
export function IdeaBox({ source, name = '', email = '', title = 'Что доработать в системе?' }: {
  source: 'site' | 'cabinet' | 'client_app'; name?: string; email?: string; title?: string;
}) {
  const [f, setF] = useState({ message: '', name, email });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  async function send(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg({});
    try {
      await api('/support', { body: {
        topic: 'idea', source, subject: 'Предложение по доработке', message: f.message.trim(),
        contactName: f.name.trim() || 'Без имени', contactEmail: f.email.trim(),
      } });
      setF({ ...f, message: '' }); setMsg({ ok: 'Спасибо! Предложение отправлено, ответим на почту.' });
    } catch (e: any) { setMsg({ err: e.message }); } finally { setBusy(false); }
  }

  return (
    <form className="panel" onSubmit={send}>
      <h2>{title}</h2>
      <p className="note">Напишите, чего не хватает или что неудобно. Лучшие идеи попадают в ближайшие обновления.</p>
      <div className="f"><label htmlFor="idea-m">Предложение</label>
        <textarea id="idea-m" rows={4} required minLength={20} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} placeholder="Например: хочу видеть курьера на карте в реальном времени" /></div>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="f"><label htmlFor="idea-n">Имя</label><input id="idea-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="f"><label htmlFor="idea-e">Email для ответа</label><input id="idea-e" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
      </div>
      {msg.ok && <div className="okmsg">{msg.ok}</div>}
      {msg.err && <div className="err">{msg.err}</div>}
      <button className="btn primary" disabled={busy || f.message.trim().length < 20}>{busy ? 'Отправляем…' : 'Отправить предложение'}</button>
    </form>
  );
}
