// Sources acceptance uses only the local app and its allowlisted fixture server.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { seed, login, enableOffline, waitReady, pageFetch } from './helpers.mjs';
import { APP_ENV, BACKEND, FIXTURE_ORIGIN } from './env.mjs';
import { requireE2eDatabaseUrl } from './db-guard.mjs';

// Fail at collection, before any seed or helper can mutate the database.
requireE2eDatabaseUrl();

const feedURL = `${FIXTURE_ORIGIN}/feeds/freshness.xml`;
const sheet = page => page.locator('#rf-source-sheet');
const body = page => page.locator('#rf-source-sheet-body');
let s;
const csp = new WeakMap();
const externalRequests = new WeakMap();

function db(code) {
  return JSON.parse(execFileSync(path.join(BACKEND, '.venv/bin/python'), ['-c', `
import asyncio, json
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings
url = make_url(settings.database_url)
assert url.database == 'readfine_e2e', 'refusing: DATABASE_URL is not the readfine_e2e database'
async def main():
    engine = create_async_engine(settings.database_url)
    async with engine.begin() as c:
${code}
    await engine.dispose()
asyncio.run(main())
`], { cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8' }));
}
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('.htmx-request,.htmx-swapping,.htmx-settling'));
}
async function close(page) {
  await page.keyboard.press('Escape');
  await expect(sheet(page)).not.toHaveAttribute('open', '');
}
async function open(page, locator) {
  await locator.click();
  await expect(sheet(page)).toHaveAttribute('open', '');
  await expect(body(page).locator('form').first()).toBeVisible();
  await settle(page);
}
async function remove(page, id) {
  await page.locator(`#source-menu-${id}-trigger`).click();
  await page.locator(`[data-rf-delete="feed:${id}"]`).click();
}
function subscription() {
  return db(`        row = (await c.execute(text("select id, feed_id from user_feeds where user_id=:u order by id limit 1"), {'u': ${s.alice.id}})).mappings().one()
        print(json.dumps(dict(row)))`);
}

test.beforeEach(async ({ page, context, browserName }) => {
  s = seed();
  csp.set(page, []);
  externalRequests.set(page, []);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.get(page).push(url.href);
  });
  await page.exposeFunction('recordSourcesCsp', value => csp.get(page).push(value));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.recordSourcesCsp(`${e.violatedDirective} ${e.blockedURI}`)));
  // Permit local fixture traffic only; a regression must not reach a public site.
  // WebKit interception interferes with native downloads and offline worker navigation.
  // Every URL below is local; additionally audit every browser's requests.
  if (browserName === 'chromium') await context.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/])|localhost(?=[:/]))/, route => route.abort());
  const dir = path.join(APP_ENV.E2E_FIXTURE_DIR, 'feeds');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'freshness.xml'), `<?xml version="1.0"?><rss version="2.0"><channel><title>Sources fixture</title><link>${FIXTURE_ORIGIN}/</link><description>Local feed</description></channel></rss>`);
  await login(page, s.alice.email, s.password);
});
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  expect(csp.get(page)).toEqual([]);
  expect(externalRequests.get(page)).toEqual([]);
  seed(); // Remove subscriptions, folders and scope records made by this case.
});

test('sources: add from reader palette and phone', async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/app');
    const trigger = page.locator('a[data-rf-source-sheet][href="/sources/add"]:visible').first();
    await open(page, trigger);
    await expect(page.locator('#feed-subscribe-form')).toHaveCount(1);
    const inset = await page.evaluate(() => {
      const panel = document.querySelector('#rf-source-sheet > div').getBoundingClientRect();
      const address = document.getElementById('feed-url-input').getBoundingClientRect();
      return { left: Math.round((address.left - panel.left) * 100) / 100,
        right: Math.round((panel.right - address.right) * 100) / 100 };
    });
    expect(inset.left, 'sheet controls retain a horizontal inset').toBeGreaterThanOrEqual(16);
    expect(inset.right).toBeGreaterThanOrEqual(16);
    await close(page);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#rf-palette-input').fill('Add source');
    await open(page, page.locator('#rf-palette').getByRole('menuitem', { name: 'Add source', exact: true }));
    await expect(page.locator('#rf-palette')).not.toHaveAttribute('open', '');
    await page.locator('#feed-url-input').fill(feedURL);
    await body(page).getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.locator('#feed-test-result')).toContainText('Sources fixture');
    await page.locator('#subscribe-folder-select').selectOption(String(s.folders.news));
    if (width === 1280) {
      await body(page).getByRole('button', { name: 'Subscribe', exact: true }).click();
      await expect(sheet(page)).not.toHaveAttribute('open', '');
      await expect(page.locator('#sidebar')).toContainText('Sources fixture');
    } else await close(page);
    await page.goto('/sources');
    await page.getByRole('link', { name: 'Back to Read', exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    await open(page, page.locator('a[data-rf-source-sheet][href="/sources/add"]:visible').first());
    await expect(page.locator('#feed-subscribe-form')).toHaveCount(1);
    await close(page);
  }
});

test('sources: table and folders at phone width', async ({ page }) => {
  const uf = subscription();
  db(`        await c.execute(text("update user_feeds set custom_title=:t where id=:id"), {'t': 'A long source title ' * 12, 'id': ${uf.id}})
        await c.execute(text("update feeds set status='error', last_error='Fixture fetch failure' where id=:id"), {'id': ${uf.feed_id}})
        await c.execute(text("update user_feeds set folder_id=NULL where user_id=:u and feed_id=:f"), {'u': ${s.alice.id}, 'f': ${s.feeds.local}})
        await c.execute(text("update feeds set status='disabled' where id=:f"), {'f': ${s.feeds.local}})
        await c.execute(text("update feeds set block_count=3 where id=:f"), {'f': ${s.feeds.gadget}})
        print('null')`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/sources');
  await expect(page.locator(`#source-row-${uf.id}`)).toContainText('Fixture fetch failure');
  await expect(page.locator('[data-rf-source-unread]').first()).toContainText(/\d/);
  await expect(page.locator('#feeds-list')).toContainText('No folder');
  await expect(page.locator('#feeds-list')).toContainText('Disabled');
  await expect(page.locator('#feeds-list')).toContainText('Throttled');
  const bounds = await page.evaluate(() => ({
    viewport: innerWidth, scroll: document.documentElement.scrollWidth,
    outsideTable: [...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.right > innerWidth + 1 && r.width > 0 && !el.closest('.rf-sources-table-scroll');
    }).map(el => ({ tag: el.tagName, id: el.id, class: String(el.className),
      right: el.getBoundingClientRect().right, position: getComputedStyle(el).position })).slice(0, 12),
  }));
  expect(bounds.scroll, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewport + 1);
  const table = page.getByRole('region', { name: 'Sources table' });
  expect(await table.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole('textbox', { name: 'New folder name' }).fill('Empty acceptance');
  await page.getByRole('button', { name: 'Add folder', exact: true }).click();
  await expect(page.locator('#feeds-list')).toContainText('Empty acceptance');
  await page.getByRole('button', { name: 'Actions for folder Empty acceptance', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const rename = page.locator('form[hx-post$="/rename"]');
  await rename.locator('input[name="name"]').fill('Renamed acceptance');
  await rename.locator('button[type="submit"]').click();
  await expect(page.locator('#feeds-list')).toContainText('Renamed acceptance');
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await settle(page);
  await expect(page.locator(`#folder-move-up-${s.folders.news}`)).toHaveCount(0);
  await page.locator(`#folder-move-down-${s.folders.news}`).click();
  await settle(page);
  await expect(page.locator(`#folder-move-up-${s.folders.news}`)).toBeFocused();
  await page.locator(`#folder-move-up-${s.folders.news}`).click();
  await settle(page);
  await page.getByRole('button', { name: 'Stats', exact: true }).click();
  await expect(page.locator('#tab-stats')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Feeds', exact: true }).click();
  await settle(page);
  const edgeRow = page.locator('#feeds-list tr[id^="source-row-"]').last();
  await edgeRow.locator('[aria-haspopup="menu"]').click();
  const menu = edgeRow.locator('[data-popover][aria-hidden="false"]');
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(391);
  await page.keyboard.press('Escape');
  await edgeRow.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(sheet(page)).toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('sources: edit opml and scraping sheets retain errors', async ({ page, context, browserName }) => {
  const uf = subscription();
  db(`        await c.execute(text("update user_settings set ai_quality_provider=NULL, ai_quality_model=NULL where user_id=:u"), {'u': ${s.alice.id}})
        print('null')`);
  await page.goto('/sources');
  await open(page, page.locator(`#source-row-${uf.id}`).getByRole('link', { name: 'Edit', exact: true }));
  await expect(body(page).locator('input[name="extract_readable"][type="checkbox"]')).toBeVisible();
  await expect(body(page)).toContainText('Translat');
  const address = body(page).locator('[name="feed_url"]');
  const originalAddress = await address.inputValue();
  await body(page).locator('[name="custom_title"]').fill('Edited acceptance');
  await body(page).locator('[name="folder_id"]').selectOption(String(s.folders.tech));
  await address.fill('http://127.0.0.1:1/private');
  await body(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(body(page).locator('[name="feed_url"]')).toHaveAttribute('aria-invalid', 'true');
  await expect(body(page).locator('[name="custom_title"]')).toHaveValue('Edited acceptance');
  await expect(page).toHaveURL(/\/sources$/);
  await body(page).locator('[name="feed_url"]').fill(originalAddress);
  await body(page).getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet(page)).not.toHaveAttribute('open', '');
  await expect(page.locator(`#source-row-${uf.id}`)).toContainText('Edited acceptance');
  await open(page, page.getByRole('link', { name: 'OPML', exact: true }));
  await expect(page.locator('#opml-import-form')).toHaveAttribute('hx-target', '#rf-source-sheet-body');
  await page.locator('#opml-import-form input[type=file]').setInputFiles({ name: 'valid.opml', mimeType: 'text/xml', buffer: Buffer.from(`<opml version="2.0"><head><title>Acceptance</title></head><body><outline text="Imported source" type="rss" xmlUrl="${feedURL}"/></body></opml>`) });
  await page.locator('#opml-submit-btn').click();
  await expect(body(page)).toContainText('Import complete');
  await page.locator('#opml-import-form input[type=file]').setInputFiles({ name: 'bad.opml', mimeType: 'text/xml', buffer: Buffer.from('<not-opml') });
  await page.locator('#opml-submit-btn').click();
  await expect(body(page).locator('[role="alert"]')).toBeVisible();
  await expect(page).toHaveURL(/\/sources$/);
  await context.unrouteAll(); // let the browser handle the attachment natively
  if (browserName === 'webkit') {
    // This Linux WebKit runtime renders attachment responses as documents, on
    // both the full page and sheet. Preserve the server contract assertion here;
    // Chrome below verifies the native download. See the T6 acceptance report.
    const exported = page.waitForResponse(response => new URL(response.url()).pathname === '/sources/opml/export');
    await body(page).getByRole('button', { name: 'Download OPML' }).click({ noWaitAfter: true });
    const response = await exported;
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^application\/xml/);
    expect(response.headers()['content-disposition']).toMatch(/^attachment; filename="readfine-\d{8}\.opml"$/);
    await response.finished();
    await page.waitForLoadState('domcontentloaded');
    await page.goto('/sources');
  } else {
    const download = page.waitForEvent('download');
    await body(page).getByRole('button', { name: 'Download OPML' }).click();
    expect((await download).suggestedFilename()).toMatch(/^readfine-\d{8}\.opml$/);
    await close(page);
  }
  // Reuse the allowlisted fixture URL as a local HTML page for manual scraping.
  fs.writeFileSync(path.join(APP_ENV.E2E_FIXTURE_DIR, 'feeds/freshness.xml'),
    `<html><head><title>Manual fixture</title></head><body><a href="${FIXTURE_ORIGIN}/articles/freshness.html">Preview article</a></body></html>`);
  // Use the actual shared-sheet controller, with its normal URL allowlist.
  await page.evaluate(url => window.RFSources.open('/sources/scrape?url=' + encodeURIComponent(url), document.querySelector('#sources-heading')), feedURL);
  await expect(page.locator('#selector-input')).toBeVisible();
  await page.locator('#selector-input').fill('[');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#scrape-preview')).not.toBeEmpty();
  await expect(page.locator('#selector-input')).toHaveValue('[');
  await page.locator('#selector-input').fill('a');
  await page.locator('#preview-btn').click();
  await expect(page.locator('#scrape-preview')).toContainText('Preview article');
  await settle(page);
  await body(page).getByRole('button', { name: 'Show AI prompt' }).click();
  await expect(page.locator('#ai-prompt-area')).not.toBeEmpty();
  await expect(page.locator('#selector-input')).toHaveCount(1);
});

test('sources: delayed unsubscribe undo and cleanup', async ({ page, context }) => {
  const uf = subscription();
  db(`        await c.execute(text("insert into saved_searches (user_id,name,params) values (:u,'Acceptance scope',CAST(:p AS jsonb))"), {'u': ${s.alice.id}, 'p': json.dumps({'scope_include':['feed:${uf.feed_id}']})})
        print('null')`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/sources');
  await remove(page, uf.id);
  await expect(page.locator(`#source-row-${uf.id}`)).toBeHidden();
  await page.locator('#toaster').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator(`#source-row-${uf.id}`)).toBeVisible();
  expect(subscription().id).toBe(uf.id);
  // One deterministic failed send exercises restoration in both runtimes;
  // native fetch is restored before the real unsubscribe below.
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    window.__sourcesFailedSend = false;
    window.fetch = function(input, options) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/settings/deletes' && options?.method === 'POST') {
        window.fetch = nativeFetch;
        window.__sourcesFailedSend = window.fetch === nativeFetch;
        return Promise.resolve(new Response('Injected send failure', { status: 503 }));
      }
      return nativeFetch.call(this, input, options);
    };
  });
  await remove(page, uf.id);
  await page.waitForFunction(() => window.__sourcesFailedSend === true, null, { timeout: 20_000 });
  await expect(page.locator(`#source-row-${uf.id}`)).toBeVisible({ timeout: 20_000 });
  expect(subscription().id).toBe(uf.id);
  await expect(page.locator('#toaster .toast').last()).toContainText("Couldn't delete");
  await expect(page.locator('#toaster .toast').last()).toBeInViewport();
  await page.evaluate(() => { delete window.__sourcesFailedSend; });
  // Chromium interception can cancel keepalive on document replacement. All
  // subsequent URLs are the local app, so release interception before navigating.
  await context.unrouteAll();
  let observed;
  const onResponse = response => {
    if (response.url().endsWith('/settings/deletes') && response.request().method() === 'POST') observed = response;
  };
  page.on('response', onResponse);
  await remove(page, uf.id);
  await page.getByRole('link', { name: 'Back to Read', exact: true }).click();
  await expect.poll(() => db(`        present = (await c.execute(text("select exists(select 1 from user_feeds where id=:id)"), {'id': ${uf.id}})).scalar_one()
        print(json.dumps(present))`), { timeout: 20_000 }).toBe(false);
  if (observed) {
    expect(observed.ok()).toBe(true);
    expect((await observed.json()).notices[0].msg).toContain('saved search');
    await expect(page.locator('#toaster')).toContainText('saved search');
  }
  page.off('response', onResponse);
  await page.goto('/sources');
  await expect(page.locator(`#source-row-${uf.id}`)).toHaveCount(0);
});

test('sources: old links with service worker and offline', async ({ page, context, browserName }) => {
  const uf = subscription();
  await enableOffline(page);
  await waitReady(page);
  for (const [old, canonical] of [['/settings/feeds','/sources'], [`/settings/feeds/${uf.id}/edit`, `/sources/feeds/${uf.id}/edit`], ['/settings/opml','/sources/opml']]) {
    // A controlling worker follows redirects internally, so its intermediate 308
    // is not a page response event. Inspect the same authenticated server route.
    const redirect = await context.request.get(old, { maxRedirects: 0 });
    expect(redirect.status()).toBe(308);
    expect(redirect.headers()['cache-control']).toBe('no-store');
    expect(redirect.headers().location).toBe(canonical);
    await page.goto(old);
    await expect(page).toHaveURL(new RegExp(canonical + '$'));
  }
  const alias = await pageFetch(page, '/settings/folders', { method: 'POST', body: 'name=Legacy+acceptance', headers: { 'Content-Type':'application/x-www-form-urlencoded' } });
  expect(alias.status).toBe(200);
  await page.goto('/sources');
  await expect(page.locator('#feeds-list')).toContainText('Legacy acceptance');
  await page.goto('/app');
  const abortOffline = route => route.abort('internetdisconnected');
  for (const force of [false, true]) {
    if (force) await page.evaluate(() => window.RFOffline.page.current(document).setForceOffline(true));
    else {
      if (browserName === 'chromium') await context.route('**/*', abortOffline);
      await context.setOffline(true);
    }
    const response = await page.goto('/sources');
    expect(response.status()).toBe(503);
    await page.goto('/app');
    await expect(page.locator('#article-list')).toBeVisible();
    let requests = 0;
    const seen = req => { if (new URL(req.url()).pathname.startsWith('/sources/')) requests++; };
    page.on('request', seen);
    await page.locator('a[data-rf-source-sheet][href="/sources/add"]:visible').first().click({ force:true });
    expect(requests).toBe(0);
    page.off('request', seen);
    if (force) await page.evaluate(() => window.RFOffline.page.current(document).setForceOffline(false));
    else {
      await context.setOffline(false);
      if (browserName === 'chromium') await context.unroute('**/*', abortOffline);
    }
  }
  await page.goto('/sources');
  await open(page, page.getByRole('link', { name: 'Add source', exact: true }));
});
