// Offline mode end to end: a real browser, the real service worker, IndexedDB and
// Cache Storage, against the real app (tests/e2e/env.mjs). Every offline read and
// action is checked for the worker's X-Readfine-Offline marker, so a request that
// silently reached the server cannot pass as an offline answer.
import { test, expect } from '@playwright/test';
import {
  seed, login, enableOffline, waitReady, pageFetch, controllerUrl, registrationUrls,
  deviceStorage, apiArticle, aiJobs, appliedOps, userExists,
} from './helpers.mjs';

// ---- page helpers --------------------------------------------------------------------

// Loads a list into #article-list by clicking its sidebar link, and returns the row
// ids and whether the worker answered it offline. Views without a sidebar link
// (unread_only, combined filters, a search) are requested the way the sidebar would
// (htmx GET into #article-list), since there is nothing to click.
async function openList(page, qs) {
  const url = '/htmx/articles' + (qs ? '?' + qs : '');
  const link = page.locator(`#sidebar [hx-get="${url}"]:visible, [hx-get="${url}"].nav-item:visible`).first();
  const viaLink = (await link.count()) > 0;
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(url) && r.request().method() === 'GET'),
    viaLink ? link.click()
      : page.evaluate((u) => htmx.ajax('GET', u, { target: '#article-list', swap: 'innerHTML' }), url),
  ]);
  await settled(page);
  const ids = await page.$$eval('#article-list [data-article-id]', (els) => [...new Set(els.map((e) => Number(e.dataset.articleId)))].sort((a, b) => a - b));
  return { ids, offline: (await resp.allHeaders())['x-readfine-offline'] || null, status: resp.status() };
}

// htmx done with every request and swap (settle included), so the next click lands on
// the new, processed element.
async function settled(page) {
  await page.waitForFunction(
    () => !document.querySelector('.htmx-request, .htmx-settling, .htmx-swapping, .htmx-added'),
    null, { polling: 'raf' },
  );
}

// Opens an article in the reading pane by clicking its row in the current list. An
// unread article marks itself read 500 ms after it opens (app.js, the detail's
// mark-as-read timer; any htmx request from the pane cancels it), so this waits for
// that before returning: otherwise whether the timer or the test's next click comes
// first depends on the browser's speed (WebKit loses the race where Chrome wins it),
// and a read toggle clicked afterwards would flip the article back to unread.
async function openArticle(page, id) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/htmx/articles/${id}` && r.request().method() === 'GET'),
    page.locator(`#article-row-${id}`).first().click(),
  ]);
  await expect(page.locator(`#star-btn-${id}`)).toHaveCount(1);
  await settled(page);
  const unread = await page.locator(`#article-detail [data-article-id="${id}"][data-is-read]`).first()
    .evaluate((el) => el.dataset.isRead !== 'true');
  if (unread) {
    await expect(page.locator(`#read-btn-${id}`)).toContainText('✓ Read');
    await settled(page);
  }
  return (await resp.allHeaders())['x-readfine-offline'] || null;
}

// Clicks an htmx control (a real, hit-tested click) and waits for its POST; returns the
// offline marker and the response body.
async function hxClick(page, locator, pathEnd) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(pathEnd)),
    locator.click(),
  ]);
  await settled(page);
  return { offline: (await resp.allHeaders())['x-readfine-offline'] || null, status: resp.status(), body: await resp.text() };
}

// An item of the open article's "···" menu (star, read, archive, summary), opened first
// when it is closed.
async function menuAction(page, id, item, pathEnd) {
  const menu = page.locator('.article-detail-menu').filter({ has: page.locator(`[hx-post="/htmx/articles/${id}/star"]`) }).first();
  const target = menu.locator(item);
  if (!(await target.isVisible())) await menu.locator('[data-menu-toggle]').click();
  return hxClick(page, target, pathEnd);
}

// Toggles a label through the row's label picker.
async function toggleLabel(page, id, name, labelId) {
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/htmx/articles/${id}/labels`),
    page.locator(`#article-labels-${id} [data-label-trigger]`).first().click(),
  ]);
  await settled(page);
  const r = await hxClick(page, page.locator('#label-picker button', { hasText: name }), `/htmx/articles/${id}/labels/${labelId}/toggle`);
  await page.keyboard.press('Escape');
  return r;
}

// The device's article records and outbox (raw IndexedDB; the handle is closed again so
// it never blocks a later wipe).
async function deviceRecords(page, userId) {
  return page.evaluate((uid) => new Promise((resolve, reject) => {
    const req = indexedDB.open('readfine-offline-' + uid);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['articles', 'outbox'], 'readonly');
      const a = tx.objectStore('articles').getAll();
      const o = tx.objectStore('outbox').getAll();
      tx.oncomplete = () => { db.close(); resolve({ articles: a.result, outbox: o.result }); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), userId);
}

function statusLine(page) {
  return page.locator('[data-rf-slot="offline-status"]:visible [data-rf-offline-line]').first();
}

async function logoutForm(page) {
  await page.evaluate(() => document.querySelector('form[data-rf-logout]').requestSubmit());
}

const LISTS = (s) => ({
  all: '',
  unread: 'unread_only=true',
  folder: `folder_id=${s.folders.news}`,
  feed: `feed_id=${s.feeds.gadget}`,
  label: `label_id=${s.labels.work}`,
  labeled: 'labeled_only=true',
  starred: 'starred_only=true',
  saved: 'saved_only=true',
  archive: 'archived_only=true',
  savedSearch: `saved_search_id=${s.savedSearch}`,
});

// ---- 1. one reader, offline and back ------------------------------------------------

test.describe.serial('reading and acting offline, then syncing', () => {
  let s;
  test.beforeAll(() => { s = seed(); });

  test('offline session for one reader', async ({ page, context, request }) => {
    const A = s.articles;
    await login(page, s.alice.email, s.password);

    // Offline mode off: the plain worker takes no request.
    await expect.poll(() => controllerUrl(page)).toMatch(/\/sw\.js$/);
    const plain = await pageFetch(page, '/htmx/articles');
    expect(plain.status).toBe(200);
    expect(plain.offline).toBeNull();
    await context.setOffline(true);
    const plainOff = await pageFetch(page, '/htmx/articles');
    expect(plainOff.status, 'unflagged worker must not answer offline').toBe(0);
    await context.setOffline(false);
    expect(await deviceStorage(page)).toEqual({ dbs: [], caches: [] });

    // The lists as the server draws them, to compare the device's against.
    await page.goto('/app');
    const online = {};
    for (const [name, qs] of Object.entries(LISTS(s))) {
      const r = await openList(page, qs);
      expect(r.offline, name).toBeNull();
      online[name] = r.ids;
    }
    expect(online.savedSearch).toEqual([A.w1.id, A.l2.id].sort((a, b) => a - b));
    expect(online.starred).toEqual([A.g3.id]);
    expect(online.archive).toEqual([A.g4.id]);
    expect(online.saved).toEqual([A.l3.id]);
    // unread_filter "adaptive" (the default): a feed with unread articles lists only those.
    expect(online.feed).toEqual([A.g1.id, A.g2.id]);

    // Switch on: flagged worker, Ready for offline with every article and image.
    await enableOffline(page);
    await waitReady(page);
    await expect(statusLine(page)).toHaveText('Ready for offline · 10 articles · 5 images · 0 pending');
    const store = await deviceStorage(page);
    expect([...store.dbs].sort()).toEqual([`readfine-offline-${s.alice.id}`, 'readfine-offline-current'].sort());
    expect(store.caches).toEqual(expect.arrayContaining([`readfine-media-${s.alice.id}`]));
    expect(store.caches.some((c) => c.startsWith('readfine-shell-'))).toBe(true);

    // ---- offline ----
    await context.setOffline(true);
    await expect(page.locator('[data-rf-slot="offline-banner"]')).toBeVisible();
    for (const [name, qs] of Object.entries(LISTS(s))) {
      const r = await openList(page, qs);
      expect(r.offline, `${name} answered offline`).toBe('1');
      expect(r.ids, `${name} offline equals online`).toEqual(online[name]);
    }

    // A full reload offline: the cached shell, then the device's lists.
    await page.reload();
    await expect(page.locator('#article-list')).toBeVisible();
    await expect(statusLine(page)).toContainText('Offline · 0 actions waiting');

    // An article with an image: the body is the snapshot, the image the cached copy.
    await openList(page, '');
    expect(await openArticle(page, A.w1.id)).toBe('1');
    const img = page.locator(`#article-detail img[data-e2e-img="w1"], [data-e2e-img="w1"]`).first();
    await expect(img).toHaveAttribute('src', /^\/m\//);
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(40);

    // Online-only controls are inert, with a reason: buttons disabled, links
    // aria-disabled and out of pointer reach.
    const onlineOnly = page.locator('[data-rf-online-only]');
    expect(await onlineOnly.count()).toBeGreaterThan(0);
    let links = 0;
    for (const el of await onlineOnly.all()) {
      await expect(el).toHaveAttribute('title', 'Needs a connection');
      await expect(el).toHaveAttribute('aria-disabled', 'true');
      if (await el.evaluate((e) => e.tagName === 'A')) {
        links++;
        await expect(el).toHaveClass(/pointer-events-none/);
        expect(await el.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
      } else {
        await expect(el).toBeDisabled();
      }
    }
    expect(links).toBeGreaterThan(0);

    // Star, read, unread, archive (the article's "···" menu), label toggles (the row's
    // label picker): real clicks through htmx, the overlay and the worker. Opening w1
    // already marked it read (openArticle), so the read toggle goes unread, then read.
    const W1 = A.w1.id;
    expect((await menuAction(page, W1, '[data-header-star]', `/htmx/articles/${W1}/star`)).offline).toBe('1');
    await expect(page.locator(`#star-btn-${W1}`)).toContainText('★');
    expect((await menuAction(page, W1, '[data-header-read]', `/htmx/articles/${W1}/read`)).offline).toBe('1');
    await expect(page.locator(`#read-btn-${W1}`)).toContainText('○ Unread');
    expect((await menuAction(page, W1, '[data-header-read]', `/htmx/articles/${W1}/read`)).offline).toBe('1');
    await expect(page.locator(`#read-btn-${W1}`)).toContainText('✓ Read');
    expect((await toggleLabel(page, W1, 'Later', s.labels.later)).offline).toBe('1');
    expect((await toggleLabel(page, A.w2.id, 'Work', s.labels.work)).offline).toBe('1');

    // AI summary: queued, shown as requested.
    expect(await openArticle(page, A.w3.id)).toBe('1');
    const ai = await menuAction(page, A.w3.id, '[data-rf-slot="ai-summary-action"]', `/htmx/articles/${A.w3.id}/ai-summary`);
    expect(ai.offline).toBe('1');
    await expect(page.locator(`#ai-summary-${A.w3.id}`)).toContainText('Requested');

    await openList(page, `feed_id=${s.feeds.local}`);
    const L1 = A.l1.id;
    expect(await openArticle(page, L1)).toBe('1');
    await expect(page.locator(`#read-btn-${L1}`)).toContainText('✓ Read');
    await menuAction(page, L1, '[data-header-read]', `/htmx/articles/${L1}/read`);
    await expect(page.locator(`#read-btn-${L1}`)).toContainText('○ Unread');
    expect((await menuAction(page, L1, '[data-header-archive]', `/htmx/articles/${L1}/archive`)).offline).toBe('1');

    const workList = await openList(page, `label_id=${s.labels.work}`);
    expect(workList.ids).toEqual([A.g1.id]);
    expect((await openList(page, `label_id=${s.labels.later}`)).ids).toEqual([A.w1.id]);

    // Mark the Tech folder read (the sidebar's ✓, shown on hover).
    const folderRow = page.locator('#sidebar .mark-read-row').filter({ has: page.locator(`[hx-get="/htmx/articles?folder_id=${s.folders.tech}"]`) }).first();
    await folderRow.hover();
    expect((await hxClick(page, folderRow.locator(`[hx-post="/htmx/folders/${s.folders.tech}/mark-read"]`), `/htmx/folders/${s.folders.tech}/mark-read`)).offline).toBe('1');
    expect((await openList(page, `folder_id=${s.folders.tech}&unread_only=true`)).ids).toEqual([]);
    // unread_filter "adaptive" (the default) offline: with nothing unread left in the
    // feed, its list shows the read articles instead of an empty one. Archived g4 is in
    // it too, as on the server (a feed list does not filter archived articles; checked
    // against the server's own list after the sync below).
    const gadgetAfter = await openList(page, `feed_id=${s.feeds.gadget}`);
    expect(gadgetAfter.offline).toBe('1');
    expect(gadgetAfter.ids).toEqual([A.g1.id, A.g2.id, A.g3.id, A.g4.id].sort((a, b) => a - b));

    // Save a URL: a pending row on Saved.
    await openList(page, 'saved_only=true');
    await page.fill('#save-url-form input[name=url]', 'https://saved.e2e.invalid/later');
    const [saveResp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/htmx/articles/save-url')),
      page.click('#save-url-form button[type=submit]'),
    ]);
    expect((await saveResp.allHeaders())['x-readfine-offline']).toBe('1');
    await expect(page.locator('#article-list [data-rf-pending-save]')).toHaveCount(1);

    // Local search: a word only in a body, answered by the device index.
    const found = await openList(page, 'q=zephyrine');
    expect(found.offline).toBe('1');
    expect(found.ids).toEqual([A.g1.id]);
    await expect(page.locator('#article-list')).toContainText('on this device');

    // Everything waits in the outbox.
    const dev = await deviceRecords(page, s.alice.id);
    const pending = dev.outbox.length;
    expect(pending).toBeGreaterThanOrEqual(10);
    await expect(statusLine(page)).toContainText(`Offline · ${pending} actions waiting`);

    // ---- back online: the outbox goes out, the server equals the device ----
    await context.setOffline(false);
    await expect(statusLine(page)).toContainText('Ready for offline', { timeout: 30_000 });
    await expect(statusLine(page)).toContainText('· 0 pending');
    // The same feed list from the server, now that the folder is read there too.
    const gadgetOnline = await openList(page, `feed_id=${s.feeds.gadget}`);
    expect(gadgetOnline.offline).toBeNull();
    expect(gadgetOnline.ids).toEqual(gadgetAfter.ids);
    const after = await deviceRecords(page, s.alice.id);
    // The saved URL cannot be saved (.invalid does not resolve): the server refuses it
    // for good, and the device keeps it for the reader instead of dropping it.
    expect(after.outbox.map((o) => [o.type, !!o.poison, o.last_error])).toEqual([['save_url', true, 'failed/invalid_url']]);
    const results = appliedOps(s.alice.email);
    expect(results.length).toBe(pending);
    expect(results.filter((r) => r.status !== 'applied').map((r) => `${r.status}/${r.reason}`)).toEqual(['failed/invalid_url']);
    const stuckBtn = page.locator('[data-rf-slot="offline-status"]:visible [data-rf-offline-action="stuck"]');
    await expect(stuckBtn).toHaveText('1 action needs attention');
    await stuckBtn.click();
    await expect(page.locator('[data-rf-offline-stuck]:visible')).toContainText('save_url');
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-rf-offline-stuck]:visible [data-rf-offline-action="discard"]').click();
    await expect(stuckBtn).toHaveCount(0);
    expect((await deviceRecords(page, s.alice.id)).outbox).toEqual([]);

    for (const key of ['w1', 'w2', 'w3', 'l1', 'l2', 'g1', 'g2', 'g3', 'g4']) {
      const rec = after.articles.find((r) => r.id === A[key].id);
      const api = await apiArticle(request, s.alice.token, A[key].id);
      expect(api.status, key).toBe(200);
      const server = api.body;
      if (!rec) {
        // Left the device's scope with this sync: read, and neither kept nor starred.
        expect([server.is_read, server.is_starred, server.is_archived, server.is_saved], `${key} out of scope`)
          .toEqual([true, false, false, false]);
        continue;
      }
      expect({ read: server.is_read, starred: server.is_starred, archived: server.is_archived,
        labels: server.labels.map((l) => l.id).sort() }, key)
        .toEqual({ read: rec.is_read, starred: rec.is_starred, archived: rec.is_archived,
          labels: [...rec.label_ids].sort() });
    }
    const w1 = (await apiArticle(request, s.alice.token, A.w1.id)).body;
    expect([w1.is_read, w1.is_starred, w1.labels.map((l) => l.name)]).toEqual([true, true, ['Later']]);
    expect((await apiArticle(request, s.alice.token, A.w2.id)).body.labels).toEqual([]);
    const l1 = (await apiArticle(request, s.alice.token, A.l1.id)).body;
    expect([l1.is_read, l1.is_archived]).toEqual([false, true]);
    for (const k of ['g1', 'g2']) expect((await apiArticle(request, s.alice.token, A[k].id)).body.is_read, k).toBe(true);
    expect(aiJobs(A.w3.id)).toEqual([expect.objectContaining({ operation: 'summary', user_id: s.alice.id })]);
  });
});

// ---- 2. logout, accounts and deletion -----------------------------------------------

// Alice signed in with offline mode on and everything stored.
async function readyAlice(page, s) {
  await login(page, s.alice.email, s.password);
  await enableOffline(page);
  await waitReady(page);
}

function offlineDbs(store) { return store.dbs.filter((n) => n.startsWith('readfine-offline-')); }

async function expectWiped(page) {
  const store = await deviceStorage(page);
  expect(offlineDbs(store), 'no offline database left').toEqual([]);
  expect(store.caches.filter((c) => /^readfine-(media|shell)-/.test(c)), 'no offline cache left').toEqual([]);
}

// Makes the outbox POST (/sync/v1/ops) fail with a 503 until undone; returns the undo.
// Chrome: page.route. WebKit: Playwright's request interception (page.route and
// context.route alike) never sees a request from a page that a service worker
// controls, even one the worker leaves to the network (checked: the routed handler
// never ran and the server answered 200), so there the page's own fetch, which the
// sync client binds per run (offline/sync.js client()), answers the 503 instead.
async function failSyncOps(page, browserName) {
  if (browserName !== 'webkit') {
    const handler = (route) => route.fulfill({ status: 503, body: 'down for the test' });
    await page.route('**/sync/v1/ops', handler);
    return () => page.unroute('**/sync/v1/ops', handler);
  }
  await page.evaluate(() => {
    const real = window.fetch;
    window.__rfE2eRealFetch = real;
    window.fetch = (input, init) => (new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/sync/v1/ops'
      ? Promise.resolve(new Response('down for the test', { status: 503 }))
      : real.call(window, input, init));
  });
  return () => page.evaluate(() => { window.fetch = window.__rfE2eRealFetch; delete window.__rfE2eRealFetch; });
}

// One action queued offline that the next sync cannot deliver (its POST gets a 503),
// so it is still unsent when the reader logs out online. The article is opened online,
// so its mark-as-read on open is synced already and the star is the one pending action.
async function unsentStar(page, context, browserName, articleId) {
  await openList(page, '');
  expect(await openArticle(page, articleId)).toBeNull();
  await context.setOffline(true);
  expect((await menuAction(page, articleId, '[data-header-star]', `/htmx/articles/${articleId}/star`)).offline).toBe('1');
  const restore = await failSyncOps(page, browserName);
  await context.setOffline(false);
  await expect(statusLine(page)).toContainText(/Sync failed|Ready for offline · .* · 1 pending/, { timeout: 30_000 });
  return restore;
}

test.describe.serial('logout and accounts', () => {
  let s;
  test.beforeEach(() => { s = seed(); });

  test('logout with an unsent action: dialog, sync and log out, wipe; the next reader sees nothing', async ({ page, context, request, browserName }) => {
    await readyAlice(page, s);
    const restoreSync = await unsentStar(page, context, browserName, s.articles.w2.id);
    expect((await apiArticle(request, s.alice.token, s.articles.w2.id)).body.is_starred).toBe(false);

    await logoutForm(page);
    const dialog = page.locator('[data-rf-logout-dialog]');
    await expect(dialog).toContainText('1 change not synced yet');
    await expect(dialog.locator('[data-rf-logout-choice="sync"]')).toBeFocused();
    await dialog.locator('[data-rf-logout-choice="cancel"]').click();
    await expect(dialog).toHaveCount(0);
    expect(page.url()).toMatch(/\/app/);

    await restoreSync();
    await logoutForm(page);
    await Promise.all([
      page.waitForURL(/\/login/, { timeout: 30_000 }),
      page.locator('[data-rf-logout-dialog] [data-rf-logout-choice="sync"]').click(),
    ]);
    expect((await apiArticle(request, s.alice.token, s.articles.w2.id)).body.is_starred).toBe(true);
    await expectWiped(page);
    expect((await deviceStorage(page)).dbs).toEqual([]);
    await expect.poll(async () => (await registrationUrls(page))?.active || '').toMatch(/\/sw\.js$/);
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login/);

    // The next reader on this browser.
    await login(page, s.bob.email, s.password);
    const bob = await openList(page, '');
    expect(bob.offline).toBeNull();
    expect(bob.ids).toEqual([s.bob.article]);
    const store = await deviceStorage(page);
    expect(offlineDbs(store)).not.toContain(`readfine-offline-${s.alice.id}`);
    await expect(page.locator('body')).not.toContainText('Kestrel');
    // A reader who never used offline mode here gets the light page (only boot.js) and
    // the plain worker, upstream's.
    expect(await page.evaluate(() => ({
      page: !!(window.RFOffline && window.RFOffline.page),
      db: !!(window.RFOffline && window.RFOffline.db),
      boot: !!(window.RFOffline && window.RFOffline.boot),
    }))).toEqual({ page: false, db: false, boot: true });
    await expect.poll(async () => (await registrationUrls(page))?.active || '').toMatch(/\/sw\.js$/);
  });

  test('discard and log out drops the unsent action', async ({ page, context, request, browserName }) => {
    await readyAlice(page, s);
    await unsentStar(page, context, browserName, s.articles.w2.id);
    await logoutForm(page);
    await Promise.all([
      page.waitForURL(/\/login/, { timeout: 30_000 }),
      page.locator('[data-rf-logout-dialog] [data-rf-logout-choice="discard"]').click(),
    ]);
    await expectWiped(page);
    expect((await apiArticle(request, s.alice.token, s.articles.w2.id)).body.is_starred).toBe(false);
  });

  test('a stale tab of the previous account gets 409 on sync and wipes', async ({ page, context }) => {
    await readyAlice(page, s);
    // Another reader signs in on this browser without a logout here (same cookie jar,
    // no page of ours runs for it).
    const r = await context.request.post('/login', { form: { email: s.bob.email, password: s.password }, maxRedirects: 0 });
    expect([302, 303]).toContain(r.status());

    const [conflict] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/sync/v1/') && res.status() === 409),
      page.locator('[data-rf-slot="offline-status"]:visible [data-rf-offline-action="sync"]').click(),
    ]);
    expect(conflict.status()).toBe(409);
    // The tab wipes and reloads as whoever is signed in now.
    await expect(page.locator(`#article-row-${s.bob.article}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`#article-row-${s.articles.w1.id}`)).toHaveCount(0);
    await expectWiped(page);
    // What the stale tab was told (its own response body is gone with the reload).
    const again = await context.request.get('/sync/v1/manifest', { headers: { 'X-Readfine-User': String(s.alice.id) } });
    expect([again.status(), await again.json()]).toEqual([409, { error: 'account_mismatch' }]);
  });

  test('offline logout, then the pending logout is replayed online', async ({ page, context }) => {
    await readyAlice(page, s);
    await context.setOffline(true);
    await logoutForm(page);
    await expect(page.locator('[data-rf-logged-out]')).toContainText('Logged out on this device.');
    await expect(page.locator('[data-rf-logged-out]')).toContainText('Offline data was removed from this device.');
    await expectWiped(page);

    // Back online: the server session is still alive (nothing could reach it), and
    // opening the app ends it before showing anything.
    await context.setOffline(false);
    expect((await context.request.get('/app', { maxRedirects: 0 })).status()).toBe(200);
    // What /app looked like while the replay ran: recorded by the page itself once its
    // scripts have run (the server rendered the app for the still-valid session).
    await page.addInitScript(() => {
      if (location.pathname !== '/app') return;
      document.addEventListener('DOMContentLoaded', () => {
        const html = document.documentElement;
        sessionStorage.setItem('rf-e2e-replay', JSON.stringify({
          rfHide: html.classList.contains('rf-hide'),
          bodyVisibility: getComputedStyle(document.body).visibility,
          appRendered: !!document.querySelector('#article-list'),
        }));
      });
    });
    await page.goto('/app');
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
    const seen = JSON.parse(await page.evaluate(() => sessionStorage.getItem('rf-e2e-replay')));
    expect(seen).toEqual({ rfHide: true, bodyVisibility: 'hidden', appRendered: true });
    expect([302, 303]).toContain((await context.request.get('/app', { maxRedirects: 0 })).status());
    await expectWiped(page);
  });

  test('deleting the account wipes the device', async ({ page }) => {
    await login(page, s.carol.email, s.password);
    await enableOffline(page);
    await waitReady(page);
    await page.goto('/settings/profile');
    const form = page.locator('form[action="/settings/profile/delete-account"]');
    await form.locator('input[name=current_password]').fill(s.password);
    await form.locator('input[name=confirm_text]').fill('delete my account');
    await form.locator('button[type=submit]').click();
    await expect(page).toHaveURL(/\/login\?deleted=1/, { timeout: 30_000 });
    await expectWiped(page);
    expect(userExists(s.carol.email)).toBe(false);
  });
});
