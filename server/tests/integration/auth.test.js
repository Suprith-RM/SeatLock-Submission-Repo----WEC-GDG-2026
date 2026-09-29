import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import pool from '../../src/config/db.js';

const timestamp = Date.now();
const testEmail = `auth-${timestamp}@example.com`;
const testPassword = 'testpassword123';
const testName = 'Auth Test User';

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE email = $1', [testEmail]);
  await pool.end();
});

describe('POST /api/auth/register', () => {
  it('registers a new user and returns JWT token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: testName, email: testEmail, password: testPassword });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe(testEmail);
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('returns 409 conflict when registering an existing email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: testName, email: testEmail, password: testPassword });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USER_ALREADY_EXISTS');
  });

  it('returns 400 when email format is invalid', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Test', email: 'invalid-email-format', password: 'password123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when password is shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Test', email: 'short@example.com', password: '123' });

    expect(res.status).toBe(400);
  });

  it('normalizes email to lowercase and detects collision', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: testName, email: testEmail.toUpperCase(), password: testPassword });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/login', () => {
  it('authenticates user with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: testPassword });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('returns uniform 401 error response for invalid credentials', async () => {
    const wrongPasswordRes = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: 'incorrect-password' });

    const nonExistentUserRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@example.com', password: 'password123' });

    expect(wrongPasswordRes.status).toBe(401);
    expect(nonExistentUserRes.status).toBe(401);
    expect(wrongPasswordRes.body.error.message).toBe(nonExistentUserRes.body.error.message);
  });
});

describe('GET /api/auth/me', () => {
  let authToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: testPassword });
    authToken = res.body.token;
  });

  it('returns current user session profile', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(testEmail);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid.token.payload');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});
