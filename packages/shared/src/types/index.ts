import { z } from 'zod'

// Base response schema
export const ApiResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
})

export type ApiResponse<T = unknown> = {
  success: boolean
  message?: string
  data?: T
  error?: string
}

// Pagination
export const PaginationSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(10),
  total: z.number().optional(),
  totalPages: z.number().optional(),
})

export type Pagination = z.infer<typeof PaginationSchema>

// User types
export const UserRoleSchema = z.enum(['admin', 'client', 'freelancer'])
export type UserRole = z.infer<typeof UserRoleSchema>

export interface BaseUser {
  id: string
  email: string
  role: UserRole
  createdAt: Date
  updatedAt: Date
}

// Service health
export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy'
  service: string
  timestamp: Date
  version: string
}
