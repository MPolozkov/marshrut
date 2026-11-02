import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

/**
 * Отправка писем через SMTP (Яндекс 360, Mail.ru, Gmail и др.).
 * Без SMTP_HOST письма не отправляются, а пишутся в лог — обращения при этом всё равно сохраняются в базе.
 */
@Injectable()
export class MailService {
  private log = new Logger('Почта');
  private transport: Transporter | null = null;

  constructor() {
    const host = process.env.SMTP_HOST;
    if (!host) { this.log.warn('SMTP_HOST не задан: письма в поддержку не отправляются, только сохраняются в базе'); return; }
    const port = Number(process.env.SMTP_PORT ?? 465);
    this.transport = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }

  get enabled() { return !!this.transport; }

  async send(to: string, subject: string, text: string, replyTo?: string): Promise<boolean> {
    if (!this.transport) { this.log.log(`[письмо не отправлено] ${to}: ${subject}`); return false; }
    try {
      await this.transport.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to, subject, text, replyTo });
      return true;
    } catch (e: any) {
      this.log.error(`Не удалось отправить письмо ${to}: ${e.message}`);
      return false;
    }
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
