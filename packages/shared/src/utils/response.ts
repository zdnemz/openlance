import type { ApiResponse, Pagination } from '../types'
import { HTTP_STATUS } from '../constants'

/**
 * Success response helper
 */
export function success<T>(data?: T, message?: string): ApiResponse<T> {
  return {
    success: true,
    data,
    message,
  }
}

/**
 * Error response helper
 */
export function error(message: string, errorDetails?: string): ApiResponse<never> {
  return {
    success: false,
    message,
    error: errorDetails,
  }
}

/**
 * Paginated response helper
 */
export function paginated<T>(
  data: T[],
  pagination: Pagination,
  message?: string
): ApiResponse<{ items: T[]; pagination: Pagination }> {
  return {
    success: true,
    data: {
      items: data,
      pagination,
    },
    message,
  }
}

/**
 * HTTP response builder for Elysia
 */
export class ResponseBuilder {
  // 2xx Success
  static ok<T>(data?: T, message?: string) {
    return {
      status: HTTP_STATUS.OK,
      body: success(data, message),
    }
  }

  static created<T>(data?: T, message = 'Resource created successfully') {
    return {
      status: HTTP_STATUS.CREATED,
      body: success(data, message),
    }
  }

  static noContent() {
    return {
      status: HTTP_STATUS.NO_CONTENT,
      body: null,
    }
  }

  // 4xx Client Errors
  static badRequest(message = 'Bad request', details?: string) {
    return {
      status: HTTP_STATUS.BAD_REQUEST,
      body: error(message, details),
    }
  }

  static unauthorized(message = 'Unauthorized') {
    return {
      status: HTTP_STATUS.UNAUTHORIZED,
      body: error(message),
    }
  }

  static forbidden(message = 'Forbidden') {
    return {
      status: HTTP_STATUS.FORBIDDEN,
      body: error(message),
    }
  }

  static notFound(resource = 'Resource') {
    return {
      status: HTTP_STATUS.NOT_FOUND,
      body: error(`${resource} not found`),
    }
  }

  static conflict(message = 'Resource already exists') {
    return {
      status: HTTP_STATUS.CONFLICT,
      body: error(message),
    }
  }

  static unprocessable(message: string, details?: string) {
    return {
      status: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      body: error(message, details),
    }
  }

  // 5xx Server Errors
  static serverError(message = 'Internal server error') {
    return {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      body: error(message),
    }
  }

  static serviceUnavailable(message = 'Service temporarily unavailable') {
    return {
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      body: error(message),
    }
  }
}

// Shorthand exports
export const R = ResponseBuilder
