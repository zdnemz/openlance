import { Elysia, t } from 'elysia'
import { AuthController } from '../controllers/auth'
import { jwt } from '@elysiajs/jwt'

export const authRoutes = new Elysia()
    .use(
        jwt({
            name: 'jwt',
            secret: process.env.JWT_SECRET || 'dev_secret'
        })
    )
    .post('/register', AuthController.register, {
        detail: {
            tags: ['Auth'],
            summary: 'Register a new user'
        },
        body: t.Object({
            email: t.String({ format: 'email' }),
            password: t.String({ minLength: 8 }),
            role: t.Optional(t.String())
        })
    })
    .post('/login', AuthController.login, {
        detail: {
            tags: ['Auth'],
            summary: 'Login user'
        },
        body: t.Object({
            email: t.String({ format: 'email' }),
            password: t.String(),
            code: t.Optional(t.String())
        })
    })
    .post('/forgot-password', AuthController.forgotPassword, {
        detail: {
            tags: ['Auth'],
            summary: 'Request password reset'
        },
        body: t.Object({
            email: t.String({ format: 'email' })
        })
    })
    .post('/reset-password', AuthController.resetPassword, {
        detail: {
            tags: ['Auth'],
            summary: 'Reset password with token'
        },
        body: t.Object({
            token: t.String(),
            newPassword: t.String({ minLength: 8 })
        })
    })
    .post('/verify-email', AuthController.verifyEmail, {
        detail: {
            tags: ['Auth'],
            summary: 'Verify email address'
        },
        body: t.Object({
            token: t.String()
        })
    })


    .get('/login/:provider', AuthController.oauthRedirect, {
        detail: {
            tags: ['OAuth'],
            summary: 'Initiate OAuth login'
        },
        params: t.Object({
            provider: t.String()
        })
    })
    .get('/login/:provider/callback', AuthController.oauthCallback, {
        detail: {
            tags: ['OAuth'],
            summary: 'OAuth callback'
        },
        params: t.Object({
            provider: t.String()
        })
    })

    // Protected Routes Group
    .guard({
        async beforeHandle({ jwt, set, headers }: any) {
            const auth = headers['authorization']
            if (!auth || !auth.startsWith('Bearer ')) {
                set.status = 401
                return 'Unauthorized'
            }
            const token = auth.slice(7)
            const payload = await jwt.verify(token)
            if (!payload) {
                set.status = 401
                return 'Unauthorized'
            }
        }
    }, (app) =>
        app
            .resolve(async ({ jwt, headers }: any) => {
                const auth = headers['authorization']!
                const token = auth.slice(7)
                const payload = await jwt.verify(token) as any // Cast to any or generic type
                return { user: { id: payload.sub } }
            })
            .get('/me', AuthController.me, {
                detail: {
                    tags: ['Auth'],
                    summary: 'Get current user profile',
                    security: [{ JwtAuth: [] }]
                }
            })
            .post('/change-password', AuthController.changePassword, {
                detail: {
                    tags: ['Auth'],
                    summary: 'Change password',
                    security: [{ JwtAuth: [] }]
                },
                body: t.Object({
                    currentPassword: t.String(),
                    newPassword: t.String({ minLength: 8 }),
                    twoFactorCode: t.Optional(t.String())
                })
            })
            .get('/2fa/setup', AuthController.setupTwoFactor, {
                detail: {
                    tags: ['2FA'],
                    summary: 'Setup 2FA (Get Secret/QR)',
                    security: [{ JwtAuth: [] }]
                }
            })
            .post('/2fa/enable', AuthController.enableTwoFactor, {
                detail: {
                    tags: ['2FA'],
                    summary: 'Enable 2FA with code',
                    security: [{ JwtAuth: [] }]
                },
                body: t.Object({
                    code: t.String({ minLength: 6, maxLength: 6 })
                })
            })
    )
