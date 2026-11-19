import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCaches, loadOffline } from './harness.mjs';

const RF = await loadOffline();
const pages7 = { name: 'readfine-pages-7', hasApp: true, appUser: 7 };
const record7 = { recordState: 'ok', record: { userId: 7, offlineEnabled: true } };
const mirror7 = { mirrorState: 'ok', mirror: { uid: 7, offlineEnabled: true } };
const defaults = {
  record: null, recordState: 'missing', mirror: null, mirrorState: 'missing',
  forgetWindow: false, pages: [], legacy: [],
};

test('every row of the A1 table with the amended mirror restrictions', () => {
  const own = { ...record7, pages: [pages7] };
  const mirrored = { ...mirror7, pages: [pages7] };
  const cases = [
    ['own pages', own, { row: 'R1', answer: 'shell', cache: 'readfine-pages-7' }],
    ['no pages', record7, { row: 'R1-miss', answer: 'offline', cache: null }],
    ['wrong reader in own cache', { ...own, pages: [{ ...pages7, appUser: 9 }] }, { row: 'R1-miss', answer: 'offline', cache: null }],
    ['stale record', { ...own, record: { ...record7.record, stale: true } }, { row: 'R2', answer: 'offline', cache: null }],
    ['forget window', { ...own, forgetWindow: true }, { row: 'R2', answer: 'offline', cache: null }],
    ['stale mirror', { ...own, ...mirror7, mirror: { ...mirror7.mirror, stale: true } }, { row: 'R2', answer: 'offline', cache: null }],
    ['logout pending', { ...own, ...mirror7, mirror: { ...mirror7.mirror, logoutPending: true } }, { row: 'R2', answer: 'offline', cache: null }],
    ['wipe pending with readable record', { ...own, ...mirror7, mirror: { uid: null, wipePending: true } }, { row: 'R2', answer: 'offline', cache: null }],
    ['wipe pending with missing record', { ...mirrored, mirror: { uid: null, wipePending: true } }, { row: 'R2', answer: 'offline', cache: null }],
    ['anonymous stale marker', { ...own, ...mirror7, mirror: { uid: null, offlineEnabled: false, stale: true } }, { row: 'R2', answer: 'offline', cache: null }],
    ['mirror off', { ...own, ...mirror7, mirror: { uid: 7, offlineEnabled: false } }, { row: 'R2', answer: 'offline', cache: null }],
    ['record off', { ...mirrored, ...record7, record: { userId: 7, offlineEnabled: false } }, { row: 'R3', answer: 'offline', cache: null }],
    ['both unavailable', { recordState: 'unreadable' }, { row: 'R4', answer: 'offline', cache: null }],
    ['missing record and unreadable mirror', { ...mirrored, mirrorState: 'unreadable' }, { row: 'R4', answer: 'offline', cache: null }],
    ['readable record and unreadable mirror', { ...own, mirrorState: 'unreadable' }, { row: 'R7', answer: 'offline', cache: null }],
    ['one matching cache', mirrored, { row: 'R6', answer: 'shell', cache: 'readfine-pages-7' }],
    ['second pages cache', { ...mirrored, pages: [pages7, { name: 'readfine-pages-9', hasApp: false, appUser: null }] }, { row: 'R7', answer: 'offline', cache: null }],
    ['wrong reader in mirrored cache', { ...mirrored, pages: [{ ...pages7, appUser: 9 }] }, { row: 'R7', answer: 'offline', cache: null }],
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(RF.decision.decide({ ...defaults, ...input }), expected, name);
  }
});

test("legacy shell only for the record's uid, else the mirror's (d4m3)", () => {
  const input = { ...defaults, legacy: [{ name: 'readfine-shell-2', hasApp: true, appUser: 7 }] };
  assert.deepEqual(RF.decision.decide({ ...input, ...record7 }), { row: 'L1', answer: 'shell', cache: 'readfine-shell-2' });
  assert.deepEqual(RF.decision.decide({ ...input, ...mirror7, recordState: 'ok', record: { userId: 9, offlineEnabled: true } }),
    { row: 'R1-miss', answer: 'offline', cache: null });
  const unreadable = { ...input, ...mirror7, recordState: 'unreadable' };
  assert.deepEqual(RF.decision.decide(unreadable), { row: 'L6', answer: 'shell', cache: 'readfine-shell-2' });
  const emptyPages = [{ ...pages7, hasApp: false, appUser: null }];
  assert.deepEqual(RF.decision.decide({ ...unreadable, pages: emptyPages }), { row: 'R7', answer: 'offline', cache: null });
  assert.deepEqual(RF.decision.decide({ ...input, ...record7, pages: emptyPages }), { row: 'R1-miss', answer: 'offline', cache: null });
});

test('gather retries an unreadable record 3 times, 100 ms apart, then reports unreadable', async () => {
  const caches = fakeCaches();
  const times = [];
  const db = { ...RF.db, async getCurrentUser() {
    times.push(Date.now());
    throw new Error('IndexedDB unavailable');
  } };
  const result = await RF.decision.gather({ db, caches });
  assert.equal(result.recordState, 'unreadable');
  assert.equal(result.record, null);
  assert.equal(times.length, 3);
  assert.ok(times[2] - times[0] >= 200, `attempts were ${times[2] - times[0]} ms apart`);

  let calls = 0;
  db.getCurrentUser = async () => {
    if (++calls < 3) throw new Error('IndexedDB unavailable');
    return record7.record;
  };
  const recovered = await RF.decision.gather({ db, caches, delayMs: 0 });
  assert.equal(recovered.recordState, 'ok');
  assert.deepEqual(recovered.record, record7.record);
  assert.equal(calls, 3);
});

test('gather reads appUser from the cached /app body tag only', async () => {
  const caches = fakeCaches();
  caches.match = (url, { cacheName, ...options }) => caches.stores.get(cacheName)?.match(url, options);
  const cache = await caches.open('readfine-pages-12');
  const db = { ...RF.db, getCurrentUser: async () => ({ userId: 12, offlineEnabled: true }) };
  await cache.put('/app?source=sync', new Response('<body class="x" data-rf-user="12">'));
  const input = await RF.decision.gather({ db, caches });
  assert.deepEqual(input.pages, [{ name: 'readfine-pages-12', hasApp: true, appUser: 12 }]);
  assert.deepEqual(RF.decision.decide(input), { row: 'R1', answer: 'shell', cache: 'readfine-pages-12' });

  const meta = await caches.open('readfine-meta');
  await meta.put('/__rf/meta', Response.json({ uid: 12, offlineEnabled: true }));
  const wipe = await caches.open('readfine-meta-wipe');
  const marker = { uid: null, wipePending: true };
  await wipe.put('/__rf/meta', Response.json(marker));
  const wiping = await RF.decision.gather({ db, caches });
  assert.equal(wiping.mirrorState, 'ok');
  assert.deepEqual(wiping.mirror, marker);
  assert.deepEqual(RF.decision.decide(wiping), { row: 'R2', answer: 'offline', cache: null });

  await caches.delete('readfine-meta-wipe');
  await cache.put('/app?source=sync', new Response('<script data-rf-user="5">'));
  const unmarked = await RF.decision.gather({ db, caches });
  assert.deepEqual(unmarked.pages, [{ name: 'readfine-pages-12', hasApp: true, appUser: null }]);
  assert.deepEqual(RF.decision.decide(unmarked), { row: 'R1-miss', answer: 'offline', cache: null });
});
