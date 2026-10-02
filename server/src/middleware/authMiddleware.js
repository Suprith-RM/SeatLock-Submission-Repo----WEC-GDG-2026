/**
 * Authentication middleware.
 * Verifies JWT from the Authorization: Bearer <token> header.
 */
import jwt from 'jsonwebtoken';
import { AppError, ErrorCode } from '../utils/errors.js';

export function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Authentication required. Add: Authorization: Bearer <token>'));
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return next(AppError.unauthorized('Authentication token is missing.'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id:    payload.sub,
      email: payload.email,
      name:  payload.name,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError(
        ErrorCode.TOKEN_EXPIRED,
        'Session expired. Please log in again.',
        401,
      ));
    }
    if (err.name === 'JsonWebTokenError') {
      return next(new AppError(
        ErrorCode.TOKEN_INVALID,
        'Invalid authentication token.',
        401,
      ));
    }
    return next(AppError.unauthorized('Authentication failed.'));
  }
}
