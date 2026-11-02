import { Global, Module } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;

// По умолчанию — база из docker-compose.yml, чтобы локальный запуск работал и без .env.
export function createDb(url = process.env.DATABASE_URL || 'postgres://marshrut:marshrut@localhost:5433/marshrut'): Db {
  const pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema, casing: 'snake_case' });
}

@Global()
@Module({
  providers: [{ provide: DB, useFactory: () => createDb() }],
  exports: [DB],
})
export class DbModule {}
