// Migrates the e2e database. Seeding is per test group (seed() in helpers.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { APP_ENV, BACKEND, WORK } from './env.mjs';

export default async function globalSetup() {
  fs.mkdirSync(WORK, { recursive: true });
  execFileSync('uv', ['run', 'alembic', 'upgrade', 'head'], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, stdio: 'inherit',
  });
}
