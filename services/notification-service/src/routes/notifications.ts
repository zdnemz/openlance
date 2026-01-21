import type { ApiResponse } from '@openlance/shared'
import { Elysia } from 'elysia'

export const notificationRoutes = new Elysia({ prefix: '/notifications' })
  .get('/', (): ApiResponse => {
    // TODO: Implement list notifications
    return { success: true, data: [], message: 'List notifications endpoint' }
  })
  .get('/:id', ({ params }): ApiResponse => {
    // TODO: Implement get notification by ID
    return { success: true, data: { id: params.id }, message: 'Get notification endpoint' }
  })
  .post('/', (): ApiResponse => {
    // TODO: Implement create notification
    return { success: true, message: 'Create notification endpoint' }
  })
  .patch('/:id/read', ({ params }): ApiResponse => {
    // TODO: Implement mark notification as read
    return { success: true, data: { id: params.id }, message: 'Mark as read endpoint' }
  })
  .delete('/:id', ({ params }): ApiResponse => {
    // TODO: Implement delete notification
    return { success: true, data: { id: params.id }, message: 'Delete notification endpoint' }
  })
