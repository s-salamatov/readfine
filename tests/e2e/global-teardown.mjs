// The scratch directory goes; the readfine_e2e database stays for re-runs (the seed
// resets what it created).
import fs from 'node:fs';
import { WORK } from './env.mjs';

export default async function globalTeardown() {
  if (!process.env.E2E_KEEP_WORK) fs.rmSync(WORK, { recursive: true, force: true });
}
