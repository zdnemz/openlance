import type { ApiResponse } from '@openlance/shared'
import { Elysia } from 'elysia'

export const projectRoutes = new Elysia({ prefix: '/projects' })
  .get('/', (): ApiResponse => {
    // TODO: Implement list projects
    return { success: true, data: [], message: 'List projects endpoint' }
  })
  .get('/:id', ({ params }): ApiResponse => {
    // TODO: Implement get project by ID
    return { success: true, data: { id: params.id }, message: 'Get project endpoint' }
  })
  .post('/', (): ApiResponse => {
    // TODO: Implement create project
    return { success: true, message: 'Create project endpoint' }
  })
  .put('/:id', ({ params }): ApiResponse => {
    // TODO: Implement update project
    return { success: true, data: { id: params.id }, message: 'Update project endpoint' }
  })
  .delete('/:id', ({ params }): ApiResponse => {
    // TODO: Implement delete project
    return { success: true, data: { id: params.id }, message: 'Delete project endpoint' }
  })
