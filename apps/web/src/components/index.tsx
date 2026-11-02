import { useEffect, useId, useState } from 'react';
import { api } from '../api';

/** Поле города с подсказками: встроенный список городов России или DaData, если подключена. Можно вписать любой город. */
export function CityInput({ id, value, onChange, required, placeholder = 'Начните вводить город' }: {
  id: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string;
}) {
  const listId = useId();
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    const t = setTimeout(() => api<string[]>(`/public/cities?q=${encodeURIComponent(value)}`).then(setOptions).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [value]);
  return <>
    <input id={id} list={listId} required={required} value={value} placeholder={placeholder} autoComplete="off"
      onChange={(e) => onChange(e.target.value)} />
    <datalist id={listId}>{options.map((c) => <option key={c} value={c} />)}</datalist>
  </>;
}

/** Кнопка «Скопировать» с запасным вариантом: выделить текст, если буфер обмена недоступен. */
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn sm" onClick={() => {
    navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {});
  }}>{done ? 'Скопировано' : 'Скопировать'}</button>;
}
