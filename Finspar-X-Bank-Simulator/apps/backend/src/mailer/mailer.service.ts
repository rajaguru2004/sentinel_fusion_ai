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

  /**
   * `opts.from` overrides the From header (default: the authenticated mailbox).
   * Providers generally require From to match the authenticated account, so an
   * override may be rewritten or rejected upstream — see .env.example.
   */
  async send(
    to: string,
    subject: string,
    html: string,
    opts?: { from?: string },
  ): Promise<void> {
    const transport = this.getTransport();
    const recipient = env.smtp.to || to; // demo recipient override
    const from = opts?.from || env.smtp.user;
    if (!transport) {
      this.logger.warn(
        `[DEV MAIL] From: ${from} | To: ${recipient} | ${subject}\n` +
          `${html.replace(/<[^>]+>/g, ' ').trim()}`,
      );
      return;
    }
    // Log the attempt BEFORE handing off to SMTP: on a hang or a hard failure
    // this line is the only record of what was addressed to whom.
    this.logger.log(
      `[MAIL SEND] From: ${from} | To: ${recipient} | Host: ${env.smtp.host}:${env.smtp.port} | ${subject}`,
    );
    try {
      const info = await transport.sendMail({ from, to: recipient, subject, html });
      this.logger.log(
        `[MAIL SENT] From: ${from} | To: ${recipient} | id=${info.messageId ?? 'none'} | ` +
          `accepted=${JSON.stringify(info.accepted ?? [])} ` +
          `rejected=${JSON.stringify(info.rejected ?? [])} | ${subject}`,
      );
    } catch (err) {
      // Rethrow: OTP callers must fail loudly, and the risk-alert path already
      // catches and logs on its own. This line just records From/To alongside it.
      this.logger.error(
        `[MAIL FAILED] From: ${from} | To: ${recipient} | ${subject} — ${String(err)}`,
      );
      throw err;
    }
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
