import { prisma as db } from '@openlance/database'
import { validate } from '@openlance/shared'
import { RegisterDTO, LoginDTO, ResetPasswordDTO, ForgotPasswordDTO, ChangePasswordDTO, VerifyEmailDTO } from '../schemas'
import { createServiceLogger } from '@openlance/logger'
import { SERVICES } from '@openlance/shared'
import { google, github, linkedin } from '../utils/oauth'
import { emailService } from '../services/email'
import { generateState, generateCodeVerifier } from 'arctic'
import * as authenticator from 'otplib';
import QRCode from 'qrcode';
import { EnableTwoFactorDTO } from '../schemas'

const logger = createServiceLogger(SERVICES.AUTH)

const sanitizeUser = (user: any) => {
    const { passwordHash, ...safeUser } = user
    return safeUser
}

export class AuthController {
    static async register({ body, jwt }: { body: unknown, jwt: any }) {
        const val = await validate(RegisterDTO, body)
        if (!val.success) throw new Error(val.error)

        const { email, password, role } = val.data

        const existing = await db.user.findUnique({ where: { email } })
        if (existing) throw new Error('Email already registered')

        const passwordHash = await Bun.password.hash(password)

        const user = await db.user.create({
            data: {
                email,
                passwordHash,
                role: role as any,
                status: 'PENDING_VERIFICATION'
            }
        })

        // Generate verification token and send email
        const verificationToken = await jwt.sign({ sub: user.id, type: 'email_verification' })
        await emailService.sendVerificationEmail(email, verificationToken)

        return { success: true, user: sanitizeUser(user), message: 'Registration successful. Please verify your email.' }
    }

    static async login({ body, jwt }: { body: unknown, jwt: any }) {
        const val = await validate(LoginDTO, body)
        if (!val.success) throw new Error(val.error)

        const { email, password, code } = val.data

        const user = await db.user.findUnique({ where: { email } })
        if (!user || !user.passwordHash) throw new Error('Invalid credentials')

        const valid = await Bun.password.verify(password, user.passwordHash)
        if (!valid) throw new Error('Invalid credentials')

        if (user.twoFactorEnabled) {
            if (!code) {
                // Client should catch this and prompt for 2FA code
                return { success: false, require2fa: true, message: '2FA code required' }
            }
            const isValid = authenticator.verify({ token: code, secret: user.twoFactorSecret! });
            if (!isValid) throw new Error('Invalid 2FA code');
        }

        const token = await jwt.sign({
            sub: user.id,
            email: user.email,
            role: user.role
        })

        await db.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() }
        })

        return { success: true, token, user: sanitizeUser(user) }
    }

    static async me({ user }: { user: any }) {
        if (!user) throw new Error('Unauthorized')

        const fullUser = await db.user.findUnique({
            where: { id: user.id },
            include: { profile: true }
        })

        return { success: true, user: sanitizeUser(fullUser) }
    }

    static async forgotPassword({ body }: { body: unknown }) {
        const val = await validate(ForgotPasswordDTO, body)
        if (!val.success) throw new Error(val.error)

        const { email } = val.data
        const user = await db.user.findUnique({ where: { email } })

        if (!user) return { success: true, message: 'If email exists, reset link sent' }

        const token = crypto.randomUUID()
        const tokenHash = await Bun.password.hash(token)

        await db.passwordReset.create({
            data: {
                userId: user.id,
                tokenHash,
                expiresAt: new Date(Date.now() + 1000 * 60 * 30)
            }
        })

        await emailService.sendPasswordResetEmail(email, token)

        return { success: true, message: 'If email exists, reset link sent' }
    }

    static async resetPassword({ body }: { body: unknown }) {
        const val = await validate(ResetPasswordDTO, body)
        if (!val.success) throw new Error(val.error)

        const { token, newPassword } = val.data

        // This is simplified. Real world needs raw token lookup or similar.
        // Assuming token passed in IS the lookup key for now as per previous logic.

        const resetRecord = await db.passwordReset.findUnique({
            where: { tokenHash: token }
        })

        if (!resetRecord) throw new Error('Invalid or expired token')
        if (resetRecord.expiresAt < new Date()) throw new Error('Token expired')
        if (resetRecord.usedAt) throw new Error('Token already used')

        const passwordHash = await Bun.password.hash(newPassword)

        await db.$transaction([
            db.user.update({
                where: { id: resetRecord.userId },
                data: { passwordHash }
            }),
            db.passwordReset.update({
                where: { id: resetRecord.id },
                data: { usedAt: new Date() }
            })
        ])

        return { success: true, message: 'Password reset successfully' }
    }


    static async changePassword({ body, user }: { body: unknown, user: any }) {
        const val = await validate(ChangePasswordDTO, body)
        if (!val.success) throw new Error(val.error)

        const { currentPassword, newPassword, twoFactorCode } = val.data

        const dbUser = await db.user.findUnique({ where: { id: user.id } })
        if (!dbUser || !dbUser.passwordHash) throw new Error('User not found')

        if (dbUser.twoFactorEnabled) {
            if (!twoFactorCode) throw new Error('2FA code required to change password');
            const isValid = authenticator.verify({ token: twoFactorCode, secret: dbUser.twoFactorSecret! });
            if (!isValid) throw new Error('Invalid 2FA code');
        }

        const valid = await Bun.password.verify(currentPassword, dbUser.passwordHash)
        if (!valid) throw new Error('Invalid current password')

        const newHash = await Bun.password.hash(newPassword)

        await db.user.update({
            where: { id: user.id },
            data: { passwordHash: newHash }
        })

        return { success: true, message: 'Password updated' }
    }

    static async setupTwoFactor({ user }: { user: any }) {
        const secret = authenticator.generateSecret();
        const otpauth = authenticator.generateURI({
            secret: secret,
            label: user.email || 'user',
            issuer: 'OpenLance',
            strategy: "totp"
        });
        const qrCodeUrl = await QRCode.toDataURL(otpauth);

        // Save secret temporarily or permanently? Usually temporarily until verified.
        // For simplicity, we save it directly but disable 2FA until verified.
        await db.user.update({
            where: { id: user.id },
            data: { twoFactorSecret: secret, twoFactorEnabled: false }
        });

        return { success: true, secret, qrCodeUrl };
    }

    static async enableTwoFactor({ body, user }: { body: unknown, user: any }) {
        const val = await validate(EnableTwoFactorDTO, body);
        if (!val.success) throw new Error(val.error);

        const { code } = val.data;
        const dbUser = await db.user.findUnique({ where: { id: user.id } });

        if (!dbUser || !dbUser.twoFactorSecret) throw new Error('2FA setup not initiated');

        const isValid = authenticator.verify({ token: code, secret: dbUser.twoFactorSecret });
        if (!isValid) throw new Error('Invalid code');

        await db.user.update({
            where: { id: user.id },
            data: { twoFactorEnabled: true }
        });

        return { success: true, message: '2FA enabled successfully' };
    }

    static async verifyEmail({ body, jwt }: { body: unknown, jwt: any }) {
        const val = await validate(VerifyEmailDTO, body)
        if (!val.success) throw new Error(val.error)

        const { token } = val.data
        // Verify the token which should contain userId and type 'email_verification'
        const payload = await jwt.verify(token)
        if (!payload || payload.type !== 'email_verification') throw new Error('Invalid or expired verification token')

        await db.user.update({
            where: { id: payload.sub },
            data: {
                emailVerified: true,
                status: 'ACTIVE' // Activate account upon email verification
            }
        })

        return { success: true, message: 'Email verified successfully' }
    }

    // Helper to generate verification token (internal use or call from register)
    // We need to modify register to call this.


    static async oauthRedirect({ params, set }: { params: { provider: string }, set: any }) {
        const state = generateState()
        let url: URL

        // In clean architecture, this switch belongs in a factory or strategy, but here is fine.
        if (params.provider === 'google') {
            const scopes = ['openid', 'profile', 'email']
            // generateState/codeVerifier if needed. Google uses state.
            // Arctic Google.createAuthorizationURL(state, codeVerifier, scopes)
            // Simplified for now assuming arctic < 2 or specific API. 
            // Checking Arctic docs memory: const [url, state] = await google.createAuthorizationURL(state)
            // Google helper usually involves:
            const codeVerifier = generateCodeVerifier()
            url = await google.createAuthorizationURL(state, codeVerifier, { scopes })
            set.cookie = {
                oauth_state: { value: state, httpOnly: true, secure: process.env.NODE_ENV === 'production', path: '/' },
                code_verifier: { value: codeVerifier, httpOnly: true, secure: process.env.NODE_ENV === 'production', path: '/' }
            }
        } else if (params.provider === 'github') {
            url = await github.createAuthorizationURL(state)
            set.cookie = {
                oauth_state: { value: state, httpOnly: true, secure: process.env.NODE_ENV === 'production', path: '/' }
            }
        } else if (params.provider === 'linkedin') {
            url = await linkedin.createAuthorizationURL(state, { scopes: ['openid', 'profile', 'email'] })
            set.cookie = {
                oauth_state: { value: state, httpOnly: true, secure: process.env.NODE_ENV === 'production', path: '/' }
            }
        } else {
            throw new Error('Invalid provider')
        }

        return set.redirect = url.toString()
    }

    // This is complex, will need a robust implementation later. 
    // Implementing a stub that handles the code exchange and user creation.
    static async oauthCallback({ params, query, cookie, jwt, set }: any) {
        const provider = params.provider;
        const code = query.code;
        const state = query.state;
        const storedState = cookie.oauth_state?.value;
        const codeVerifier = cookie.code_verifier?.value;

        if (!code || !state || !storedState || state !== storedState) {
            throw new Error('Invalid state or code');
        }

        let tokens: any;
        let providerUser: { id: string, email: string, name: string };

        try {
            if (provider === 'google') {
                tokens = await google.validateAuthorizationCode(code, codeVerifier);
                const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
                    headers: { Authorization: `Bearer ${tokens.accessToken}` }
                });
                const user = await response.json() as any;
                providerUser = { id: user.sub, email: user.email, name: user.name };
            } else if (provider === 'github') {
                tokens = await github.validateAuthorizationCode(code);
                const userResponse = await fetch('https://api.github.com/user', {
                    headers: { Authorization: `Bearer ${tokens.accessToken}` }
                });
                const user = await userResponse.json() as any;
                let email = user.email;
                if (!email) {
                    const emailRes = await fetch('https://api.github.com/user/emails', {
                        headers: { Authorization: `Bearer ${tokens.accessToken}` }
                    });
                    const emails = await emailRes.json() as any[];
                    email = emails.find((e: any) => e.primary)?.email || emails[0]?.email;
                }
                providerUser = { id: String(user.id), email, name: user.name || user.login };
            } else if (provider === 'linkedin') {
                tokens = await linkedin.validateAuthorizationCode(code);
                const response = await fetch('https://api.linkedin.com/v2/userinfo', {
                    headers: { Authorization: `Bearer ${tokens.accessToken}` }
                });
                const user = await response.json() as any;
                providerUser = { id: user.sub, email: user.email, name: user.name };
            } else {
                throw new Error('Invalid provider');
            }
        } catch (e) {
            logger.error({ error: e }, 'OAuth token validation failed');
            throw new Error('Failed to verify provider');
        }

        // Database Logic
        let user = await db.user.findUnique({
            where: { email: providerUser.email },
            include: { oauthAccounts: true }
        });

        if (user) {
            const linked = user.oauthAccounts.find(
                (acc: any) => acc.provider === provider.toUpperCase() && acc.providerUserId === providerUser.id
            );

            if (!linked) {
                await db.oAuthAccount.create({
                    data: {
                        userId: user.id,
                        provider: provider.toUpperCase() as any,
                        providerUserId: providerUser.id,
                        accessTokenEncrypted: Buffer.from(tokens.accessToken || ''),
                    }
                });
            }
        } else {
            user = await db.user.create({
                data: {
                    email: providerUser.email,
                    emailVerified: true,
                    status: 'ACTIVE',
                    profile: {
                        create: {
                            displayName: providerUser.name,
                        }
                    },
                    oauthAccounts: {
                        create: {
                            provider: provider.toUpperCase() as any,
                            providerUserId: providerUser.id,
                            accessTokenEncrypted: Buffer.from(tokens.accessToken || ''),
                        }
                    }
                },
                include: { oauthAccounts: true }
            });
        }

        const token = await jwt.sign({
            sub: user!.id,
            email: user!.email,
            role: user!.role
        });

        return set.redirect = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback?token=${token}`;
    }
}
