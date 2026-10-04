import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'crypto';

import authRoutes        from './routes/auth.js';
import workshopRoutes    from './routes/workshops.js';
import reservationRoutes from './routes/reservations.js';
import eventsRoutes      from './routes/events.js';
import { errorHandler }  from './middleware/errorHandler.js';

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

const skipRateLimit = () =>
  process.env.NODE_ENV === 'test' ||
  process.env.DISABLE_RATE_LIMIT === 'true';

const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '200'),
  standardHeaders: true, legacyHeaders: false,
  skip:            skipRateLimit,
  message: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.' } },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20'),
  skip:     skipRateLimit,
  message: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many auth attempts.' } },
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

app.use('/api/auth',         authLimiter,   authRoutes);
app.use('/api/workshops',    globalLimiter, workshopRoutes);
app.use('/api/reservations', globalLimiter, reservationRoutes);
app.use('/api/events',       globalLimiter, eventsRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found.` },
  });
});

app.use(errorHandler);

export default app;
