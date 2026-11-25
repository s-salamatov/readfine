// The read zone end to end (s4-T6, design §6): open, star and archive with Undo, the
// reader's keys, "Show original" for an AI-translated title, mark all read with Undo
// and the toast stack, swipe and the full-screen article on the phone, offline
// mark-all and Undo, the snapshot template refetch, reduced motion and the article
// partial without JS. Every test collects securitypolicyviolation and expects none.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { seed, login, enableOffline, waitReady, apiArticle } from './helpers.mjs';
import { APP_ENV, BACKEND } from './env.mjs';
import { requireE2eDatabaseUrl } from './db-guard.mjs';
requireE2eDatabaseUrl(); // Reject an unsafe DSN at collection, before seeding.

let s;
test.beforeEach(() => { s = seed(); });

// ---- helpers -------------------------------------------------------------------------

// Every securitypolicyviolation of the page, from the first script on.
async function collectCsp(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
}

async function expectNoCsp(page) {
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
}

// The seed has no translated title: give alice one for an article of hers (the
// reader's language, the feed's translate switch and the translation row, which is
// what the list and the detail join on). readfine_e2e only, like seed.py.
const TRANSLATE_PY = `
import asyncio, sys
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings
async def main(user_id, article_id, title):
    engine = create_async_engine(settings.database_url)
    async with engine.begin() as c:
        await c.execute(text("update user_settings set ai_translation_language = 'de' where user_id = :u"), {"u": user_id})
        await c.execute(text("update user_feeds set translate = true where user_id = :u"
                             " and feed_id = (select feed_id from articles where id = :a)"), {"u": user_id, "a": article_id})
        await c.execute(text("insert into article_translations (user_id, article_id, language, title)"
                             " values (:u, :a, 'de', :t)"), {"u": user_id, "a": article_id, "t": title})
    await engine.dispose()
asyncio.run(main(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]))
`;

function translate(userId, articleId, title) {
  requireE2eDatabaseUrl();
  execFileSync('uv', ['run', 'python', '-c', TRANSLATE_PY, String(userId), String(articleId), title], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8',
  });
}

// htmx done with every request and swap (settle included).
async function settled(page) {
  await page.waitForFunction(
    () => !document.querySelector('.htmx-request, .htmx-settling, .htmx-swapping, .htmx-added'),
    null, { polling: 'raf' },
  );
}

// Opens an article from its row and waits for the open-to-read timer (app.js marks an
// unread article read 500 ms after it opens), so a later read toggle is not raced.
async function openArticle(page, id) {
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/htmx/articles/${id}` && r.request().method() === 'GET'),
    page.locator(`#article-row-${id}`).first().click(),
  ]);
  await expect(page.locator(`#article-detail article[data-article-id="${id}"]`)).toHaveCount(1);
  await settled(page);
  await expect(page.locator(`#article-row-${id}`)).toHaveAttribute('data-is-read', 'true');
  await settled(page);
}

// Waits for a POST to a path ending in `pathEnd` while `act` runs.
async function posted(page, pathEnd, act) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(pathEnd)),
    act(),
  ]);
  await settled(page);
  return resp;
}

async function api(request, id) {
  const r = await apiArticle(request, s.alice.token, id);
  expect(r.status).toBe(200);
  return r.body;
}

// Resolves once the element's finite animations have finished and its box has held
// still for two frames (as in shell.spec.mjs).
async function still(locator) {
  await locator.evaluate(async (el) => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const finite = () => el.getAnimations({ subtree: true })
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    const box = () => JSON.stringify(el.getBoundingClientRect());
    for (;;) {
      await Promise.all(finite().map((a) => a.finished.catch(() => {})));
      const before = box();
      await frame();
      await frame();
      if (box() === before && finite().length === 0) return;
    }
  });
}

// A horizontal touch drag across a row, through the browser's own touch input (CDP),
// so the page sees real pointer events with pointerType "touch".
async function swipe(page, locator, dx) {
  const box = await locator.boundingBox();
  const y = Math.round(box.y + box.height / 2);
  const x0 = Math.round(dx > 0 ? box.x + 40 : box.x + box.width - 40);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + Math.round((dx * i) / steps), y }] });
    }
    // The finger rests before it lifts: a lift at speed starts a fling, and Chrome
    // spends the next tap on stopping it, so that tap would never click.
    await page.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

function runningAnimations(page) {
  return page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running')
    .map((a) => `${a.constructor.name} ${a.animationName || a.transitionProperty || ''} on ${a.effect?.target?.id || a.effect?.target?.className || '?'}`));
}

const toasts = (page) => page.locator('#toaster .toast');

// ---- desktop -------------------------------------------------------------------------

test('read: open, star and archive with Undo; j/k/s/m/v; Show original swaps row and pane titles', async ({ page, context, request }) => {
  await collectCsp(page);
  const w1 = s.articles.w1;
  const translated = 'Turmfalke über dem Hafen gesichtet';
  translate(s.alice.id, w1.id, translated);
  await login(page, s.alice.email, s.password);
  await page.goto('/app');

  const row = page.locator(`#article-row-${w1.id}`);
  await expect(row.locator('[data-article-title]')).toHaveText(translated);
  await openArticle(page, w1.id);
  const pane = page.locator(`#article-detail article[data-article-id="${w1.id}"]`);
  const paneTitle = pane.locator('[data-detail-title]').first();
  await expect(paneTitle).toHaveText(translated);

  // Show original: the pane and the row show the source's title; and back again.
  await pane.getByRole('button', { name: 'Show original' }).click();
  await expect(paneTitle).toHaveText(w1.title);
  await expect(row.locator('[data-article-title]')).toHaveText(w1.title);
  await pane.getByRole('button', { name: 'Show translation' }).click();
  await expect(paneTitle).toHaveText(translated);
  await expect(row.locator('[data-article-title]')).toHaveText(translated);

  // Star from the toolbar: the row's star follows, the server has it.
  const toolbar = page.locator('#article-detail [data-article-toolbar]');
  await posted(page, `/articles/${w1.id}/star`, () => toolbar.locator('[data-header-star]').click());
  await expect(row.locator('[data-star-btn]')).toHaveAttribute('title', 'Remove star');
  expect((await api(request, w1.id)).is_starred).toBe(true);

  // Archive from the toolbar: an "Archived" toast with Undo, which unarchives through
  // the open article (its hidden #archive-btn-* target, which app.js reads by id).
  await expect(page.locator(`#archive-btn-${w1.id}`)).toHaveCount(1);
  await posted(page, `/articles/${w1.id}/archive`, () => toolbar.locator('[data-header-archive]').click());
  expect((await api(request, w1.id)).is_archived).toBe(true);
  const archived = toasts(page).filter({ hasText: 'Archived' });
  await expect(archived.getByRole('button', { name: 'Undo' })).toBeVisible();
  await posted(page, `/articles/${w1.id}/archive`, () => archived.getByRole('button', { name: 'Undo' }).click());
  expect((await api(request, w1.id)).is_archived).toBe(false);
  await expect(toolbar.locator('[data-header-archive] [data-label]')).toHaveText('Archive');

  // The "···" menu (a Basecoat dropdown in htmx-swapped markup) opens; Escape closes
  // only the menu, the article stays open.
  await toolbar.getByRole('button', { name: 'More actions' }).click();
  const copy = page.locator(`#article-menu-${w1.id}-menu`).getByRole('menuitem', { name: 'Copy' });
  await expect(copy).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(copy).toBeHidden();
  await expect(pane).toHaveCount(1);

  // Keys: s unstars, m marks unread, j opens the next row, k comes back, v opens the
  // original.
  await page.locator('body').focus();
  await posted(page, `/articles/${w1.id}/star`, () => page.keyboard.press('s'));
  expect((await api(request, w1.id)).is_starred).toBe(false);
  await expect(row.locator('[data-star-btn]')).toHaveAttribute('title', 'Star article');
  await posted(page, `/articles/${w1.id}/read`, () => page.keyboard.press('m'));
  expect((await api(request, w1.id)).is_read).toBe(false);
  const nextId = await row.evaluate((el) => {
    let n = el.nextElementSibling;
    while (n && !(n.classList.contains('article-row') && n.dataset.articleId)) n = n.nextElementSibling;
    return n ? Number(n.dataset.articleId) : null;
  });
  expect(nextId).not.toBeNull();
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/htmx/articles/${nextId}` && r.request().method() === 'GET'),
    page.keyboard.press('j'),
  ]);
  await expect(page.locator(`#article-detail article[data-article-id="${nextId}"]`)).toHaveCount(1);
  await settled(page);
  await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === `/htmx/articles/${w1.id}` && r.request().method() === 'GET'),
    page.keyboard.press('k'),
  ]);
  await expect(pane).toHaveCount(1);
  await settled(page);
  await context.route('https://*.e2e.invalid/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>original</p>' }));
  const [popup] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('v')]);
  await popup.waitForURL('https://w1.e2e.invalid/post');
  await popup.close();

  await expectNoCsp(page);
});

test('read: mark all read from the list header, Undo restores the rows, the newest toast is on top', async ({ page, request }) => {
  await collectCsp(page);
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const unread = page.locator('#article-list .article-row[data-is-read="false"]');
  await expect(unread.first()).toBeVisible();
  const before = await unread.count();
  expect((await api(request, s.articles.w1.id)).is_read).toBe(false);

  // An older toast that stays, so the Undo toast has one to stack on.
  await page.evaluate(() => window.RFToast.show({ msg: 'Read e2e older toast', duration: -1 }));
  await expect(toasts(page).filter({ hasText: 'Read e2e older toast' })).toBeVisible();

  // Online there is no confirm(): Undo covers it.
  page.on('dialog', (d) => { throw new Error(`unexpected dialog: ${d.message()}`); });
  const header = page.locator('#article-list [data-list-header]').first();
  await posted(page, '/mark-read', () => header.getByRole('button', { name: 'Mark all as read' }).click());
  const marked = toasts(page).filter({ hasText: /^Marked \d+ as read/ });
  const undo = marked.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  expect((await api(request, s.articles.w1.id)).is_read).toBe(true);

  await still(marked);
  const stack = await marked.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const others = [...el.parentElement.querySelectorAll('.toast:not([aria-hidden="true"])')].filter((t) => t !== el);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      opacity: getComputedStyle(el).opacity,
      hitsSelf: el.contains(hit),
      inView: r.top >= 0 && r.bottom <= innerHeight,
      above: others.every((o) => r.bottom <= o.getBoundingClientRect().top),
      others: others.length,
    };
  });
  expect(stack.others, JSON.stringify(stack)).toBeGreaterThanOrEqual(1);
  expect(stack, JSON.stringify(stack)).toEqual({ opacity: '1', hitsSelf: true, inView: true, above: true, others: stack.others });

  await posted(page, '/mark-read/undo', () => undo.click());
  await expect(toasts(page).filter({ hasText: /^Restored \d+$/ })).toBeVisible();
  expect((await api(request, s.articles.w1.id)).is_read).toBe(false);
  await expect.poll(() => unread.count()).toBe(before);

  await expectNoCsp(page);
});

test('read: offline mark-all has no Undo; Undo after the connection drops says so; old snapshots are replaced after one sync', async ({ page, context, request }) => {
  test.setTimeout(180_000);
  await collectCsp(page);
  await login(page, s.alice.email, s.password);
  await enableOffline(page);
  await waitReady(page);
  // Chromium's offline emulation leaves the worker's own requests online: abort them too.
  const abort = (r) => r.abort('internetdisconnected');
  async function setOffline(offline) {
    if (offline) await context.route('**/*', abort);
    else await context.unroute('**/*', abort);
    await context.setOffline(offline);
  }
  // Offline, mark-all still asks first (there is no Undo); accept it.
  page.on('dialog', (d) => d.accept());

  // (a) Offline: the Tech folder's mark-all says "will sync" and offers no Undo.
  await setOffline(true);
  const tech = page.locator(`#sidebar .nav-item[hx-get="/htmx/articles?folder_id=${s.folders.tech}"]:visible`).first();
  await tech.click();
  await settled(page);
  const header = page.locator('#article-list [data-list-header]').first();
  await expect(header.getByRole('button', { name: 'Mark all as read' })).toBeVisible();
  await header.getByRole('button', { name: 'Mark all as read' }).click();
  const willSync = toasts(page).filter({ hasText: /^Marked \d+ as read · will sync/ });
  await expect(willSync).toBeVisible();
  await expect(willSync.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await setOffline(false);

  // (c, before b so its article is still unread and listed) A snapshot from the old templates (version 5) is fetched again by one sync.
  const MARK = 'rf-e2e-stale-snapshot';
  const snapshot = (id) => page.evaluate(([uid, aid]) => new Promise((resolve, reject) => {
    const req = indexedDB.open('readfine-offline-' + uid);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('snapshots', 'readonly');
      const g = tx.objectStore('snapshots').get(aid);
      tx.oncomplete = () => { db.close(); resolve(g.result || null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), [s.alice.id, id]);
  const w2 = s.articles.w2.id;
  const current = await snapshot(w2);
  expect(current && current.template_version).toBeTruthy();
  const version = current.template_version;
  expect(version).not.toBe('5');
  await page.evaluate(([uid, aid, mark]) => new Promise((resolve, reject) => {
    const req = indexedDB.open('readfine-offline-' + uid);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      const g = store.get(aid);
      g.onsuccess = () => store.put({ ...g.result, template_version: '5', row_html: `<div>${mark}</div>` });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), [s.alice.id, w2, MARK]);
  expect((await snapshot(w2)).template_version).toBe('5');
  await page.evaluate(() => window.RFOffline.page.current().syncNow());
  await expect.poll(async () => (await snapshot(w2)).template_version, { timeout: 30_000 }).toBe(version);
  const fresh = await snapshot(w2);
  expect(fresh.row_html).not.toContain(MARK);
  expect(fresh.row_html).toContain(`data-rf-article="${w2}"`);

  // And the offline list draws the new row from it.
  await setOffline(true);
  await page.locator('#sidebar .nav-item[hx-get="/htmx/articles"]:visible').first().click();
  await settled(page);
  const offlineRow = page.locator(`#article-list #article-row-${w2}`);
  await expect(offlineRow).toHaveAttribute('data-rf-article', String(w2));
  await expect(offlineRow.locator('[data-star-btn]')).toHaveCount(1);
  await expect(page.locator('#article-list')).not.toContainText(MARK);
  await setOffline(false);

  // (b) Online mark-all on All articles, then the connection drops: Undo says so and
  // the rows stay read.
  await page.locator('#sidebar .nav-item[hx-get="/htmx/articles"]:visible').first().click();
  await settled(page);
  await posted(page, '/mark-read', () => header.getByRole('button', { name: 'Mark all as read' }).click());
  const marked = toasts(page).filter({ hasText: /^Marked \d+ as read/ }).filter({ hasNotText: 'will sync' });
  await expect(marked.getByRole('button', { name: 'Undo' })).toBeVisible();
  await setOffline(true);
  await marked.getByRole('button', { name: 'Undo' }).click();
  await expect(toasts(page).filter({ hasText: 'Couldn\'t undo while offline' })).toBeVisible();
  await setOffline(false);
  expect((await api(request, s.articles.w1.id)).is_read).toBe(true);
  expect((await api(request, w2)).is_read).toBe(true);

  await expectNoCsp(page);
});

// ---- phone ---------------------------------------------------------------------------

test.describe('phone', () => {
  // The configured projects have no touch: this group adds it.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('read: phone — swipe star and read with touch, full-screen article with the floating bar and back', async ({ page, request }) => {
    await collectCsp(page);
    await login(page, s.alice.email, s.password);
    await page.goto('/app');
    const opened = [];
    page.on('request', (r) => {
      const m = new URL(r.url()).pathname.match(/^\/htmx\/articles\/(\d+)$/);
      if (m && r.method() === 'GET') opened.push(Number(m[1]));
    });

    // Right stars, and does not open the article.
    const w1 = s.articles.w1.id;
    const row1 = page.locator(`#article-row-${w1}`);
    await expect(row1).toBeVisible();
    await posted(page, `/articles/${w1}/star`, () => swipe(page, row1, 160));
    await expect(row1.locator('[data-star-btn]')).toHaveAttribute('title', 'Remove star');
    expect((await api(request, w1)).is_starred).toBe(true);
    await expect(row1).not.toHaveAttribute('data-rf-swipe', /./);

    // Left toggles read.
    const w2 = s.articles.w2.id;
    const row2 = page.locator(`#article-row-${w2}`);
    await expect(row2).toHaveAttribute('data-is-read', 'false');
    await posted(page, `/articles/${w2}/read`, () => swipe(page, row2, -160));
    expect((await api(request, w2)).is_read).toBe(true);
    await expect(row2).toHaveAttribute('data-is-read', 'true');
    expect(opened).toEqual([]);
    await expect(page.locator('html')).not.toHaveClass(/mobile-detail-open/);

    // A tap opens the article full screen, with the floating bar at the bottom edge.
    const w3 = s.articles.w3.id;
    await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === `/htmx/articles/${w3}` && r.request().method() === 'GET'),
      page.locator(`#article-row-${w3}`).tap(),
    ]);
    await settled(page);
    await expect(page.locator('html')).toHaveClass(/mobile-detail-open/);
    const bar = page.locator(`#article-detail .article-bottom-bar[data-article-id="${w3}"]`);
    await expect(bar).toBeVisible();
    await still(bar);
    const box = await bar.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    expect(box.y + box.height).toBeGreaterThan(844 - 120);
    await expect(bar.locator('[data-bottom-star]')).toBeVisible();
    await expect(bar.locator('[data-bottom-next]')).toBeVisible();

    // A toast over the full-screen article clears the floating bar and is not covered.
    await page.evaluate(() => window.RFToast.show({ msg: 'Read e2e phone toast', duration: -1 }));
    const phoneToast = toasts(page).filter({ hasText: 'Read e2e phone toast' });
    await expect(phoneToast).toBeVisible();
    await still(phoneToast);
    const t = await phoneToast.boundingBox();
    const b = await bar.boundingBox();
    expect(t.y + t.height <= b.y || t.y >= b.y + b.height, JSON.stringify({ toast: t, bar: b })).toBe(true);
    expect(await phoneToast.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    })).toBe(true);

    // Back to the list.
    await page.locator('#article-detail #mobile-detail-back-btn').tap();
    await expect(page.locator('html')).not.toHaveClass(/mobile-detail-open/);
    await expect(page.locator(`#article-row-${w3}`)).toBeVisible();

    await expectNoCsp(page);
  });

  test('read: reduced motion leaves no running animation after swipe, star and mark-all; the article partial reads without JS', async ({ page, browser, request }) => {
    await collectCsp(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, s.alice.email, s.password);
    await page.goto('/app');

    // (a) Swipe: the star lands and the row is back in place with nothing running.
    const w1 = s.articles.w1.id;
    const row1 = page.locator(`#article-row-${w1}`);
    await posted(page, `/articles/${w1}/star`, () => swipe(page, row1, 160));
    expect((await api(request, w1)).is_starred).toBe(true);
    expect(await row1.evaluate((el) => el.style.transform)).toBe('');
    expect(await runningAnimations(page)).toEqual([]);

    // A star by tap.
    await posted(page, `/articles/${w1}/star`, () => row1.locator('[data-star-btn]').tap());
    expect((await api(request, w1)).is_starred).toBe(false);
    expect(await runningAnimations(page)).toEqual([]);

    // Mark all: its toast arrives without an entrance animation.
    const header = page.locator('#article-list [data-list-header]').first();
    await posted(page, '/mark-read', () => header.getByRole('button', { name: 'Mark all as read' }).tap());
    await expect(toasts(page).filter({ hasText: /^Marked \d+ as read/ })).toBeVisible();
    expect(await runningAnimations(page)).toEqual([]);
    await expectNoCsp(page);

    // (b) Without JS, the article partial is the article: title, body, original link.
    const w1Title = s.articles.w1.title;
    const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    try {
      const p = await ctx.newPage();
      const resp = await p.goto(`/htmx/articles/${w1}`);
      expect(resp.status()).toBe(200);
      await expect(p.getByText(w1Title).first()).toBeVisible();
      await expect(p.getByText('Birdwatchers gathered.').first()).toBeVisible();
      const original = p.locator('.article-detail-title-row a[data-external-link]');
      await expect(original).toBeVisible();
      await expect(original).toHaveAttribute('href', 'https://w1.e2e.invalid/post');
    } finally {
      await ctx.close();
    }
  });
});
