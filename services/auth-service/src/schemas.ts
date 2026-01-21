import { z } from 'zod'

export const RegisterDTO = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['CLIENT', 'FREELANCER']).default('FREELANCER'),
})

export const LoginDTO = z.object({
  email: z.string().email(),
  password: z.string(),
  code: z.string().optional(),
})

export const ForgotPasswordDTO = z.object({
  email: z.string().email(),
})

export const ResetPasswordDTO = z.object({
  token: z.string(),
  newPassword: z.string().min(8),
})

export const ChangePasswordDTO = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
  twoFactorCode: z.string().optional(),
})

export const VerifyEmailDTO = z.object({
  token: z.string(),
})

export const EnableTwoFactorDTO = z.object({
  code: z.string().length(6)
})

export type RegisterSchema = z.infer<typeof RegisterDTO>
export type LoginSchema = z.infer<typeof LoginDTO>
export type ForgotPasswordSchema = z.infer<typeof ForgotPasswordDTO>
export type ResetPasswordSchema = z.infer<typeof ResetPasswordDTO>
export type ChangePasswordSchema = z.infer<typeof ChangePasswordDTO>
export type VerifyEmailSchema = z.infer<typeof VerifyEmailDTO>
export type EnableTwoFactorSchema = z.infer<typeof EnableTwoFactorDTO>
