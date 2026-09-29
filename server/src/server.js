import 'dotenv/config';
import http from 'http';
import app from './app.js';
import pool from './config/db.js';
import { logger } from './utils/logger.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function assertDatabaseConnection() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW() as server_time');
    logger.info('Database connection established', { time: res.rows[0].server_time });
  } finally {
    client.release();
  }
}

function setupGracefulShutdown(server) {
  const shutdown = (signal) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);

    server.close(async () => {
      try {
        await pool.end();
        logger.info('Closed database connection pool.');
        process.exit(0);
      } catch (err) {
        logger.error('Error closing database pool during shutdown', { error: err.message });
        process.exit(1);
      }
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timed out, terminating process');
      process.exit(1);
    }, 15000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise rejection', { reason: String(reason) });
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  });
}

async function bootstrap() {
  try {
    await assertDatabaseConnection();

    const server = http.createServer(app);
    server.listen(PORT, () => {
      logger.info('SeatLock server listening', {
        port: PORT,
        env: process.env.NODE_ENV,
        pid: process.pid,
      });
    });

    setupGracefulShutdown(server);
  } catch (err) {
    logger.error('Bootstrap failure', { message: err.message });
    process.exit(1);
  }
}

bootstrap();
