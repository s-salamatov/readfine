// The e2e environment, shared by playwright.config.mjs (the app server), the global
// setup (migrations + seed) and the specs. Everything here is local and throw-away:
// the app on 127.0.0.1:4251 against the `readfine_e2e` database of the dev Postgres
// (127.0.0.1:4250), and a fixture server on 127.0.0.1:4252.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BACKEND = path.join(ROOT, 'backend');
export const WORK = path.join(ROOT, 'tests/e2e/.work'); // gitignored, removed by teardown
export const SEED_OUT = path.join(WORK, 'seed.json');
export const APP_PORT = 4251;
export const FIXTURE_PORT = 4252;
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

export const APP_ENV = {
  DATABASE_URL: process.env.E2E_DATABASE_URL
    || 'postgresql+asyncpg://readfine:readfine@127.0.0.1:4250/readfine_e2e',
  // The CI values (.github/workflows/ci.yml): long enough for the config guard, so
  // the app runs its production profile (DEBUG off) ...
  SECRET_KEY: 'ci-test-secret-key-0123456789abcdef',
  ENCRYPTION_KEY: 'ci0123456789abcdef0123456789abcd',
  DEBUG: 'false',
  // ... except that the session cookie must travel over plain http to 127.0.0.1.
  SESSION_COOKIE_SECURE: 'false',
  ALLOWED_HOSTS: '["127.0.0.1","localhost"]',
  RATE_LIMIT_LOGIN: '1000/minute',
  LOG_LEVEL: 'WARNING',
  // Seeded with the fixture images (see fixtures/seed.py), so the media proxy serves
  // them from its disk cache and never fetches the private fixture address.
  OFFLINE_MEDIA_CACHE_DIR: path.join(WORK, 'media-cache'),
  E2E_FIXTURE_DIR: path.join(WORK, 'fixtures'),
  E2E_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
};
