export const ErrorCode = {
  INVALID_CREDENTIALS:        'INVALID_CREDENTIALS',
  TOKEN_MISSING:              'TOKEN_MISSING',
  TOKEN_INVALID:              'TOKEN_INVALID',
  TOKEN_EXPIRED:              'TOKEN_EXPIRED',
  FORBIDDEN:                  'FORBIDDEN',
  VALIDATION_ERROR:           'VALIDATION_ERROR',
  USER_ALREADY_EXISTS:        'USER_ALREADY_EXISTS',
  USER_NOT_FOUND:             'USER_NOT_FOUND',
  WORKSHOP_NOT_FOUND:         'WORKSHOP_NOT_FOUND',
  NO_SEATS_AVAILABLE:         'NO_SEATS_AVAILABLE',
  ALREADY_HAS_RESERVATION:    'ALREADY_HAS_RESERVATION',
  RESERVATION_NOT_FOUND:      'RESERVATION_NOT_FOUND',
  HOLD_EXPIRED:               'HOLD_EXPIRED',
  ALREADY_CONFIRMED:          'ALREADY_CONFIRMED',
  ALREADY_CANCELLED:          'ALREADY_CANCELLED',
  INVALID_STATUS_TRANSITION:  'INVALID_STATUS_TRANSITION',
  ALREADY_ON_WAITLIST:        'ALREADY_ON_WAITLIST',
  NOT_ON_WAITLIST:            'NOT_ON_WAITLIST',
  SEATS_AVAILABLE_USE_HOLD:   'SEATS_AVAILABLE_USE_HOLD',
  WAITLIST_ENTRY_NOT_FOUND:   'WAITLIST_ENTRY_NOT_FOUND',
  IDEMPOTENCY_KEY_REQUIRED:   'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_CONFLICT:   'IDEMPOTENCY_KEY_CONFLICT',
  INTERNAL_ERROR:             'INTERNAL_ERROR',
  RATE_LIMIT_EXCEEDED:        'RATE_LIMIT_EXCEEDED',
};

/**
 * Standardized application error class for expected HTTP responses.
 */
export class AppError extends Error {
  /**
   * @param {string} code - Application-specific error code
   * @param {string} message - Human-readable error message
   * @param {number} [statusCode=400] - HTTP response status code
   * @param {unknown} [details=null] - Additional validation or error context
   */
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name       = 'AppError';
    this.code       = code;
    this.statusCode = statusCode;
    this.details    = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }

  static badRequest(code, message, details = null) {
    return new AppError(code, message, 400, details);
  }

  static unauthorized(message = 'Authentication required.') {
    return new AppError(ErrorCode.TOKEN_MISSING, message, 401);
  }

  static forbidden(message = 'You do not have permission.') {
    return new AppError(ErrorCode.FORBIDDEN, message, 403);
  }

  static notFound(code, message) {
    return new AppError(code, message, 404);
  }

  static conflict(code, message, details = null) {
    return new AppError(code, message, 409, details);
  }

  static internal(message = 'An unexpected error occurred.') {
    return new AppError(ErrorCode.INTERNAL_ERROR, message, 500);
  }
}
