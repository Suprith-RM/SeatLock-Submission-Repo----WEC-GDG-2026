const isDev = process.env.NODE_ENV !== 'production';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'authorization',
  'secret',
]);

/**
 * Redacts sensitive fields from log metadata objects.
 *
 * @param {unknown} meta
 * @returns {unknown}
 */
function sanitize(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

const LOG_LEVELS = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

function writeLog(level, message, meta) {
  const cleanMeta = sanitize(meta);

  if (isDev) {
    const metaSuffix = cleanMeta && Object.keys(cleanMeta).length > 0
      ? `\n   ${JSON.stringify(cleanMeta)}`
      : '';
    console.log(`[${LOG_LEVELS[level] || 'LOG'}] ${message}${metaSuffix}`);
  } else {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...cleanMeta,
    }));
  }
}

export const logger = {
  info:  (msg, meta) => writeLog('info',  msg, meta),
  warn:  (msg, meta) => writeLog('warn',  msg, meta),
  error: (msg, meta) => writeLog('error', msg, meta),
  debug: (msg, meta) => { if (isDev) writeLog('debug', msg, meta); },
};
