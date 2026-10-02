/**
 * HTTP server entry point.
 */
import 'dotenv/config';
import http from 'http';
import app               from './app.js';
import pool              from './config/db.js';
import { logger }        from './utils/logger.js';
import { startExpiryJob, stopExpiryJob } from './jobs/expiryJob.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

async function checkDatabase() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW() AS time, version() AS ver');
    logger.info('Database connected', {
      time:    res.rows[0].time,
      version: res.rows[0].ver.split(' ').slice(0, 2).join(' '),
    });
  } finally {
    client.release();
  }
}

function setupShutdown(server) {
  const graceful = async (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);

    stopExpiryJob(); // Stop the interval first

    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await pool.end();
        logger.info('Database pool drained');
        process.exit(0);
      } catch (err) {
        logger.error('Error during shutdown', { message: err.message });
        process.exit(1);
      }
    });

    // Force exit after 15 seconds if in-flight requests haven't finished
    setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000).unref();
  };

  process.on('SIGTERM', () => graceful('SIGTERM'));
  process.on('SIGINT',  () => graceful('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
    if (process.env.NODE_ENV === 'production') process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { message: err.message, stack: err.stack });
    process.exit(1);
  });
}

async function start() {
  try {
    await checkDatabase();

    const server = http.createServer(app);
    server.listen(PORT, () => {
      logger.info('SeatLock server started', {
        port: PORT,
        env:  process.env.NODE_ENV,
        pid:  process.pid,
      });
    });

    startExpiryJob();

    setupShutdown(server);
  } catch (err) {
    logger.error('Server failed to start', { message: err.message });
    process.exit(1);
  }
}

start();
