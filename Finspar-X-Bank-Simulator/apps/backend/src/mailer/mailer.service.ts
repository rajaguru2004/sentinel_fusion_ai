import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../common/env';

/**
 * SMTP mailer over Zoho (smtp.zoho.in:465, TLS). Sends OTP and notification email.
 * If SMTP credentials are absent (local dev), falls back to logging the message
 * to the console so every flow stays testable without a live mailbox. (§8.10)
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: Transporter | null = null;

  private getTransport(): Transporter | null {
    if (!env.smtp.user || !env.smtp.pass) return null;
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: env.smtp.host,
        port: env.smtp.port,
        secure: env.smtp.secure,
        auth: { user: env.smtp.user, pass: env.smtp.pass },
      });
    }
    return this.transporter;
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    const transport = this.getTransport();
    const recipient = env.smtp.to || to; // demo recipient override
    if (!transport) {
      this.logger.warn(
        `[DEV MAIL] To: ${recipient} | ${subject}\n${html.replace(/<[^>]+>/g, ' ').trim()}`,
      );
      return;
    }
    await transport.sendMail({ from: env.smtp.user, to: recipient, subject, html });
    this.logger.log(`Sent "${subject}" to ${recipient}`);
  }

  async sendOtp(to: string, code: string, purposeLabel: string, requestId: string): Promise<void> {
    const html = `
      <div style="font-family:sans-serif">
        <h2>Bank of Maharashtra — ${purposeLabel}</h2>
        <p>Your one-time password is:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
        <p>Valid for ${env.otpTtlSeconds} seconds. Request ID: ${requestId}.</p>
        <p style="color:#64748b">If you did not request this, ignore this email.</p>
      </div>`;
    await this.send(to, `Bank of Maharashtra OTP — ${purposeLabel}`, html);
  }
}
