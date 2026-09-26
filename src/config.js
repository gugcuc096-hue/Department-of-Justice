// @ts-check
'use strict';
/**
 * Konfiguration aus Umgebungsvariablen. Einzige Stelle, die process.env liest.
 * Ungültige Werte brechen den Start ab, statt still auf Standardwerte zu fallen.
 */
const path = require('path');
const { z } = require('zod');

const ROOT = path.resolve(__dirname, '..');

// Leere Strings aus .env (z. B. "BOOTSTRAP_ADMIN_PASSWORD=") wie "nicht gesetzt" behandeln.
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const flag = z
  .preprocess((v) => (v === '' || v == null ? '0' : String(v)), z.enum(['0', '1', 'true', 'false']))
  .transform((v) => v === '1' || v === 'true');

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DB_PATH: z.string().default('data/sjcs.db'),
  UPLOAD_DIR: optionalString,
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(120),
  SESSION_MAX_HOURS: z.coerce.number().int().positive().default(12),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(30),
  BOOTSTRAP_ADMIN_USER: optionalString,
  BOOTSTRAP_ADMIN_PASSWORD: optionalString,
  SEED_DEMO: flag,
  TRUST_PROXY: flag,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
});

/**
 * @typedef {ReturnType<typeof loadConfig>} Config
 */

/** @param {Record<string, string | undefined>} [env] */
function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Ungültige Konfiguration: ${issues}`);
  }
  const e = parsed.data;
  const dbPath = e.DB_PATH === ':memory:' ? ':memory:' : path.resolve(ROOT, e.DB_PATH);
  const dataDir = dbPath === ':memory:' ? path.join(ROOT, 'data') : path.dirname(dbPath);

  return Object.freeze({
    root: ROOT,
    port: e.PORT,
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    dbPath,
    uploadDir: e.UPLOAD_DIR ? path.resolve(ROOT, e.UPLOAD_DIR) : path.join(dataDir, 'uploads'),
    backupDir: path.join(dataDir, 'backups'),
    sessionIdleMs: e.SESSION_IDLE_MINUTES * 60_000,
    sessionMaxMs: e.SESSION_MAX_HOURS * 3_600_000,
    bcryptCost: e.BCRYPT_COST,
    loginRateLimit: e.LOGIN_RATE_LIMIT,
    bootstrapAdmin: e.BOOTSTRAP_ADMIN_USER && e.BOOTSTRAP_ADMIN_PASSWORD
      ? { username: e.BOOTSTRAP_ADMIN_USER, password: e.BOOTSTRAP_ADMIN_PASSWORD }
      : null,
    seedDemo: e.SEED_DEMO,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
  });
}

module.exports = { loadConfig, ROOT };
