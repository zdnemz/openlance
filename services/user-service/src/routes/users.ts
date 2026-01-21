import type { ApiResponse } from '@openlance/shared'
import { Elysia } from 'elysia'

export const userRoutes = new Elysia({ prefix: '/users' })
  .get('/', (): ApiResponse => {
    // TODO: Implement list users
    return { success: true, data: [], message: 'List users endpoint' }
  })
  .get('/:id', ({ params }): ApiResponse => {
    // TODO: Implement get user by ID
    return { success: true, data: { id: params.id }, message: 'Get user endpoint' }
  })
  .post('/', (): ApiResponse => {
    // TODO: Implement create user
    return { success: true, message: 'Create user endpoint' }
  })
  .put('/:id', ({ params }): ApiResponse => {
    // TODO: Implement update user
    return { success: true, data: { id: params.id }, message: 'Update user endpoint' }
  })
  .delete('/:id', ({ params }): ApiResponse => {
    // TODO: Implement delete user
    return { success: true, data: { id: params.id }, message: 'Delete user endpoint' }
  })
