import * as authService from '../services/authService.js';

/**
 * Handle user registration.
 */
export async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;
    const result = await authService.register({ name, email, password });
    res.status(201).json({
      message: 'Registration successful.',
      user:    result.user,
      token:   result.token,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Handle user authentication.
 */
export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.login({ email, password });
    res.status(200).json({
      message: 'Login successful.',
      user:    result.user,
      token:   result.token,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Return profile of authenticated user.
 */
export function me(req, res) {
  res.json({ user: req.user });
}
