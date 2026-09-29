import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string({ required_error: 'Name is required.' })
    .trim()
    .min(2, 'Name must be at least 2 characters.')
    .max(100, 'Name must not exceed 100 characters.'),
  email: z.string({ required_error: 'Email is required.' })
    .trim()
    .toLowerCase()
    .email('Must be a valid email address.'),
  password: z.string({ required_error: 'Password is required.' })
    .min(8, 'Password must be at least 8 characters.')
    .max(72, 'Password must not exceed 72 characters.'),
});

export const loginSchema = z.object({
  email: z.string({ required_error: 'Email is required.' })
    .trim()
    .toLowerCase()
    .email('Must be a valid email address.'),
  password: z.string({ required_error: 'Password is required.' })
    .min(1, 'Password cannot be empty.'),
});
