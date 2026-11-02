import './env';
import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { AppModule } from './app.module';
import { createDb } from './db/db.module';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    throw new Error('Задайте JWT_SECRET в .env перед запуском в продакшене');
  }
  const dbUrl = new URL(process.env.DATABASE_URL || 'postgres://marshrut:marshrut@localhost:5433/marshrut');
  Logger.log(`База данных: ${dbUrl.hostname}:${dbUrl.port || 5432}/${dbUrl.pathname.slice(1)}, пользователь ${dbUrl.username}`, 'Маршрут');
  // Миграции применяются при старте: новый сервер поднимается одной командой.
  await migrate(createDb(), { migrationsFolder: join(__dirname, '..', 'drizzle') });

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Фото и подпись из приложения курьера приходят в base64.
  app.useBodyParser('json', { limit: '12mb' });
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API запущен: http://localhost:${port}/api`, 'Маршрут');
}
bootstrap();
