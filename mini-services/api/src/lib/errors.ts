/** Typed application errors → consistent JSON error envelope. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'unauthorized', message),
  forbidden: (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message),
  notFound: (what: string) => new AppError(404, 'not_found', `${what} not found`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  precondition: (code: string, message: string) => new AppError(422, code, message),
  tooMany: (message = 'Rate limit exceeded') => new AppError(429, 'too_many_requests', message),
  internal: (message = 'Internal server error') => new AppError(500, 'internal_error', message),
}
