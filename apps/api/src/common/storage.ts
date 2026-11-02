import { BadRequestException, Controller, ForbiddenException, Get, Global, Injectable, Module, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthUser, CurrentUser } from './auth';

const ROOT = process.env.UPLOAD_DIR ?? join(process.cwd(), 'uploads');
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 6 * 1024 * 1024;

/**
 * Файлы (фото посылок, подписи, логотипы) лежат на диске сервера в папке компании.
 * Для облака замените реализацию save/read на S3-совместимое хранилище (Yandex Object Storage, Selectel S3).
 */
@Injectable()
export class StorageService {
  /** Принимает data URL (data:image/jpeg;base64,...) или голый base64 JPEG. Возвращает ключ файла. */
  async saveDataUrl(companyId: string, data: string): Promise<string> {
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(data);
    const mime = m ? m[1] : 'image/jpeg';
    const ext = TYPES[mime];
    if (!ext) throw new BadRequestException('Поддерживаются только изображения JPEG, PNG и WebP');
    const buf = Buffer.from(m ? m[2] : data, 'base64');
    if (!buf.length) throw new BadRequestException('Файл пустой');
    if (buf.length > MAX_BYTES) throw new BadRequestException('Файл больше 6 МБ, уменьшите качество фото');
    const dir = join(ROOT, companyId);
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}.${ext}`;
    await writeFile(join(dir, name), buf);
    return `${companyId}/${name}`;
  }

  async read(key: string) {
    const path = normalize(join(ROOT, key));
    if (!path.startsWith(normalize(ROOT))) throw new ForbiddenException();
    try { return await readFile(path); } catch { throw new NotFoundException('Файл не найден'); }
  }
}

@Controller('files')
export class FilesController {
  constructor(private storage: StorageService) {}

  /** Файл отдаётся только сотрудникам той же компании. */
  @Get(':companyId/:name')
  async get(@CurrentUser() u: AuthUser, @Param('companyId') companyId: string, @Param('name') name: string, @Res() res: Response) {
    if (companyId !== u.companyId || !/^[\w-]+\.(jpg|png|webp)$/.test(name)) throw new ForbiddenException('Нет доступа к файлу');
    const buf = await this.storage.read(`${companyId}/${name}`);
    res.type(name.split('.').pop()!).setHeader('cache-control', 'private, max-age=86400');
    res.send(buf);
  }
}

@Global()
@Module({ providers: [StorageService], controllers: [FilesController], exports: [StorageService] })
export class StorageModule {}
