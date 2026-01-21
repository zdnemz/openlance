import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { createServiceLogger } from "@openlance/logger";
import { SERVICES } from "@openlance/shared";

const logger = createServiceLogger(SERVICES.AUTH);

export class EmailService {
  private client: SESClient;
  private from: string;

  constructor() {
    this.client = new SESClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
    this.from = process.env.EMAIL_FROM || "noreply@openlance.com";
  }

  async sendVerificationEmail(to: string, token: string) {
    if (process.env.NODE_ENV === 'test') {
        logger.info({ to, token }, 'Test mode: Skipping SES email sending');
        return;
    }

    const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/auth/verify-email?token=${token}`;
    
    const command = new SendEmailCommand({
      Source: this.from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: "Verify your email - OpenLance" },
        Body: {
          Text: { Data: `Please verify your email by clicking: ${verifyUrl}` },
          Html: { Data: `<p>Please verify your email by clicking: <a href="${verifyUrl}">here</a></p>` },
        },
      },
    });

    try {
      await this.client.send(command);
      logger.info({ to }, "Verification email sent");
    } catch (error) {
      logger.error({ error, to }, "Failed to send verification email");
    }
  }

  async sendPasswordResetEmail(to: string, token: string) {
      if (process.env.NODE_ENV === 'test') {
        logger.info({ to, token }, 'Test mode: Skipping SES email sending');
        return;
    }

    // In production this should point to a frontend page that calls the API
    const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${token}`;

    const command = new SendEmailCommand({
      Source: this.from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: "Reset your password - OpenLance" },
        Body: {
          Text: { Data: `Reset your password by clicking: ${resetUrl}` },
          Html: { Data: `<p>Reset your password by clicking: <a href="${resetUrl}">here</a></p>` },
        },
      },
    });

    try {
      await this.client.send(command);
      logger.info({ to }, "Password reset email sent");
    } catch (error) {
      logger.error({ error, to }, "Failed to send password reset email");
    }
  }
}

export const emailService = new EmailService();
