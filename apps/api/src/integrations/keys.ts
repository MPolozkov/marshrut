import { createHash, randomBytes } from 'node:crypto';

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Ключ вида mr_live_XXXXXXXX… — показывается владельцу один раз, в базе хранится только хеш. */
export function newApiKey() {
  const key = `mr_live_${randomBytes(24).toString('base64url')}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) };
}
