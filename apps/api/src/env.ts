import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Загружает переменные из файла .env в корне проекта, если он есть.
 * Работает на любой версии Node.js без дополнительных пакетов.
 * Уже заданные переменные окружения (например, из Docker) не перезаписываются.
 */
function findEnv(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const file = findEnv(__dirname) ?? findEnv(process.cwd());
if (!file) {
  console.warn('[Маршрут] Файл .env не найден в корне проекта — используются настройки по умолчанию.');
} else {
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
