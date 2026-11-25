import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertE2eDatabase, requireE2eDatabaseUrl } from '../e2e/db-guard.mjs';

const valid = 'postgresql+asyncpg://readfine:readfine@127.0.0.1:4253/readfine_e2e';

test('accepts explicit isolated loopback PostgreSQL databases', () => {
  for (const url of [valid,
    'postgresql://readfine:readfine@localhost:4253/readfine_e2e',
    'postgres://readfine:readfine@[::1]:4253/readfine_e2e']) {
    assert.doesNotThrow(() => assertE2eDatabase(url));
  }
});

const password = 'guard-secret-do-not-disclose';
for (const [name, url] of [
  ['shared port', `postgresql://readfine:${password}@127.0.0.1:4250/readfine_e2e`],
  ['remote host', `postgresql://readfine:${password}@db.example.org:4253/readfine_e2e`],
  ...['readfine_pytest', 'readfine_test', 'readfine'].map(db =>
    [db, `postgresql://readfine:${password}@127.0.0.1:4253/${db}`]),
  ['missing port', `postgresql://readfine:${password}@127.0.0.1/readfine_e2e`],
  ['malformed URL', `postgresql://readfine:${password}@[broken:4253/readfine_e2e`],
  ['wrong scheme', `https://readfine:${password}@127.0.0.1:4253/readfine_e2e`],
  ['missing URL', undefined],
  ['empty URL', ''],
]) {
  test(`rejects ${name} without disclosing the password`, () => {
    assert.throws(() => assertE2eDatabase(url), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(password));
      assert.ok(!String(error.stack).includes(password));
      return true;
    });
  });
}

test('requires and validates E2E_DATABASE_URL without a default', () => {
  const original = process.env.E2E_DATABASE_URL;
  try {
    delete process.env.E2E_DATABASE_URL;
    assert.throws(() => requireE2eDatabaseUrl(), /E2E_DATABASE_URL/);
    for (const value of ['', '   ']) {
      process.env.E2E_DATABASE_URL = value;
      assert.throws(() => requireE2eDatabaseUrl(), /E2E_DATABASE_URL/);
    }
    process.env.E2E_DATABASE_URL = valid;
    assert.equal(requireE2eDatabaseUrl(), valid);
    process.env.E2E_DATABASE_URL = valid.replace(':4253/', ':4250/');
    assert.throws(() => requireE2eDatabaseUrl());
  } finally {
    if (original === undefined) delete process.env.E2E_DATABASE_URL;
    else process.env.E2E_DATABASE_URL = original;
  }
});

// Import the real entry points in fresh processes: validation must happen before
// Playwright can consume the config and start webServer or global setup.
for (const entry of ['../e2e/env.mjs', '../../playwright.config.mjs']) {
  for (const [name, url, expectedStatus] of [
    ['unset URL', undefined, 1],
    ['empty URL', '', 1],
    ['shared port', `postgresql+asyncpg://readfine:${password}@127.0.0.1:4250/readfine_e2e`, 1],
    ['remote host', `postgresql+asyncpg://readfine:${password}@db.example.org:4253/readfine_e2e`, 1],
    ['malformed URL', `postgresql://readfine:${password}@[broken:4253/readfine_e2e`, 1],
    ['isolated database', valid, 0],
  ]) {
    test(`${entry} validates ${name} at module load without disclosing credentials`, () => {
      const env = { ...process.env };
      delete env.E2E_DATABASE_URL;
      if (url !== undefined) env.E2E_DATABASE_URL = url;
      const moduleUrl = new URL(entry, import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(moduleUrl)}); console.log('import completed');`],
      { env, encoding: 'utf8', timeout: 15_000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const output = result.stdout + result.stderr;
      assert.ok(!output.includes(password), 'child output must not disclose credentials');
      assert.equal(result.status, expectedStatus);
      if (expectedStatus === 0) {
        assert.equal(result.stdout.trim(), 'import completed');
        assert.equal(result.stderr, '');
      } else {
        assert.match(result.stderr, /E2E_DATABASE_URL/);
        assert.ok(!output.includes('import completed'), 'invalid environment must stop module loading');
      }
    });
  }
}
