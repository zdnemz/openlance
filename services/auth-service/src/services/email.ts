import nodemailer from 'nodemailer';
import { createServiceLogger } from "@openlance/logger";
import { SERVICES } from "@openlance/shared";

const logger = createServiceLogger(SERVICES.AUTH);

export class EmailService {
    private transporter: nodemailer.Transporter;
  private from: string;

  constructor() {
      this.transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.example.com",
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
          auth: {
              user: process.env.SMTP_USER || "user",
              pass: process.env.SMTP_PASS || "pass",
      },
    });
    this.from = process.env.EMAIL_FROM || "noreply@openlance.com";
  }

  async sendVerificationEmail(to: string, token: string) {
    if (process.env.NODE_ENV === 'test') {
        logger.info({ to, token }, 'Test mode: Skipping SMTP email sending');
        return;
    }

    const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/auth/verify-email?token=${token}`;

    try {
        await this.transporter.sendMail({
            from: this.from,
            to,
            subject: "Verify your email - OpenLance",
            text: `Please verify your email by clicking: ${verifyUrl}`,
            html: `<p>Please verify your email by clicking: <a href="${verifyUrl}">here</a></p>`,
        });
      logger.info({ to }, "Verification email sent");
    } catch (error) {
      logger.error({ error, to }, "Failed to send verification email");
    }
  }

  async sendPasswordResetEmail(to: string, token: string) {
      if (process.env.NODE_ENV === 'test') {
          logger.info({ to, token }, 'Test mode: Skipping SMTP email sending');
        return;
    }

    // In production this should point to a frontend page that calls the API
    const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${token}`;

    try {
        await this.transporter.sendMail({
            from: this.from,
            to,
            subject: "Reset your password - OpenLance",
            text: `Reset your password by clicking: ${resetUrl}`,
            html: `<p>Reset your password by clicking: <a href="${resetUrl}">here</a></p>`,
        });
      logger.info({ to }, "Password reset email sent");
    } catch (error) {
      logger.error({ error, to }, "Failed to send password reset email");
    }
  }
}

export const emailService = new EmailService();
