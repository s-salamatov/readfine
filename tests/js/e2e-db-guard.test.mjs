import { test } from 'node:test';
import assert from 'node:assert/strict';
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
