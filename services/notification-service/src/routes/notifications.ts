import { R, success } from '@openlance/shared'
import { Elysia } from 'elysia'

export const notificationRoutes = new Elysia()
  .get('/', ({ set }) => {
    // TODO: Implement list notifications
    set.status = R.ok().status
    return success([], 'Notifications retrieved successfully')
  })
  .get('/:id', ({ params, set }) => {
    // TODO: Implement get notification by ID
    const notification = null // Placeholder

    if (!notification) {
      set.status = R.notFound().status
      return R.notFound('Notification').body
    }

    set.status = R.ok().status
    return success({ id: params.id }, 'Notification retrieved successfully')
  })
  .post('/', ({ set }) => {
    // TODO: Implement create notification
    set.status = R.created().status
    return R.created({ id: 'new-notification-id' }, 'Notification created successfully').body
  })
  .patch('/:id/read', ({ params, set }) => {
    // TODO: Implement mark notification as read
    set.status = R.ok().status
    return success({ id: params.id, read: true }, 'Notification marked as read')
  })
  .delete('/:id', ({ params, set }) => {
    // TODO: Implement delete notification
    set.status = R.ok().status
    return success({ id: params.id }, 'Notification deleted successfully')
  })
