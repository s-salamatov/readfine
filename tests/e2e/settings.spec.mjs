// Settings acceptance (s7): immediate save, delayed delete, filter from a source, old
// bookmarks and the phone layout. Only the local app and its fixture server are used.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { seed, login, enableOffline, waitReady } from './helpers.mjs';
import { APP_ENV, BACKEND } from './env.mjs';
import { requireE2eDatabaseUrl } from './db-guard.mjs';

// Fail at collection, before any seed or helper can mutate the database.
requireE2eDatabaseUrl();

let s;
const csp = new WeakMap();
const externalRequests = new WeakMap();
const toasts = page => page.locator('#toaster .toast');

// Runs `body` (indented 8 spaces) inside an ORM session on readfine_e2e only; the
// code prints one JSON value.
function orm(body) {
  return JSON.parse(execFileSync(path.join(BACKEND, '.venv/bin/python'), ['-c', `
import asyncio, hashlib, json
from datetime import datetime, timezone
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from app.config import settings
from app.models.article import Article, UserArticleState
from app.models.filter import Filter, FilterAction, FilterCondition
url = make_url(settings.database_url)
assert url.database == 'readfine_e2e', 'refusing: DATABASE_URL is not the readfine_e2e database'
NOW = datetime.now(timezone.utc)
async def main():
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine, expire_on_commit=False) as db:
${body}
    await engine.dispose()
asyncio.run(main())
`], { cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8' }));
}

// One filter per [name, action_type, action_value]; returns their ids in order.
function makeFilters(specs) {
  return orm(`        ids = []
        for name, kind, value in json.loads(${JSON.stringify(JSON.stringify(specs))}):
            f = Filter(user_id=${s.alice.id}, name=name, is_active=True, match_operator='AND',
                       position=0, stop_on_match=False)
            db.add(f)
            await db.flush()
            db.add(FilterCondition(filter_id=f.id, field='title', operator='contains', value='Storm', position=0))
            db.add(FilterAction(filter_id=f.id, action_type=kind, action_value=value))
            ids.append(f.id)
        await db.commit()
        print(json.dumps(ids))`);
}

function filterState(id) {
  return orm(`        f = await db.get(Filter, ${id})
        print(json.dumps(None if f is None else {'active': f.is_active}))`);
}

function readingSettings() {
  return orm(`        row = (await db.execute(text("select mark_read_on_scroll, articles_per_page, timezone from user_settings where user_id=:u"), {'u': ${s.alice.id}})).mappings().one()
        print(json.dumps(dict(row)))`);
}

// The phone tab row's active tab lies inside the row's own box. toBeInViewport alone
// does not see the row's horizontal clipping (s7-T8 fix).
function activeTabInStrip(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-mobile-nav]');
    const tab = bar && bar.querySelector('[data-mobile-nav-active]');
    if (!tab) return false;
    const b = bar.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    return t.left >= b.left - 1 && t.right <= b.right + 1;
  });
}

async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('.htmx-request,.htmx-swapping,.htmx-settling'));
}

async function openArticle(page, id) {
  await page.goto(`/app?open_article_id=${id}`);
  await expect(page.locator(`#article-detail article[data-article-id="${id}"]`)).toHaveCount(1);
  await settle(page);
}

test.beforeEach(async ({ page, context, browserName }) => {
  s = seed();
  csp.set(page, []);
  externalRequests.set(page, []);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.get(page).push(url.href);
  });
  await page.exposeFunction('recordSettingsCsp', value => csp.get(page).push(value));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.recordSettingsCsp(`${e.violatedDirective} ${e.blockedURI}`)));
  // Local traffic only; WebKit interception interferes with offline worker navigation,
  // so there every request is audited instead.
  if (browserName === 'chromium') await context.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/])|localhost(?=[:/]))/, route => route.abort());
  await login(page, s.alice.email, s.password);
});

test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  expect(csp.get(page)).toEqual([]);
  expect(externalRequests.get(page)).toEqual([]);
  seed(); // Remove the filters, tokens and saved articles this case made.
});

// Once the offline worker controls the page, WebKit sends its fetches past page.route,
// so the refused save could not be staged. This case needs no worker: it is blocked.
test.describe('without the offline worker', () => {
test.use({ serviceWorkers: 'block' });
test('settings: immediate save, failure and offline', async ({ page, context }) => {
  await page.goto('/settings/reading');
  const toggle = page.locator('#set-mark_read_on_scroll');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toasts(page).last()).toContainText('Saved');
  await page.reload();
  await expect(toggle).toBeChecked();
  expect(readingSettings().mark_read_on_scroll).toBe(true);

  // The server refuses: the switch goes back and an error toast says so.
  await page.route('**/settings/field', route => route.fulfill({ status: 403, body: 'Forbidden' }));
  await toggle.click();
  await expect(toasts(page).last()).toContainText("Couldn't save Mark as read on scroll");
  await expect(toggle).toBeChecked();
  expect(readingSettings().mark_read_on_scroll).toBe(true);
  await page.unroute('**/settings/field');

  // Offline: nothing is sent and the switch goes back.
  let sent = 0;
  const count = request => { if (new URL(request.url()).pathname === '/settings/field') sent++; };
  page.on('request', count);
  await context.setOffline(true);
  await toggle.click();
  await expect(toasts(page).last()).toContainText("You're offline. Mark as read on scroll was not saved.");
  await expect(toggle).toBeChecked();
  expect(sent).toBe(0);
  page.off('request', count);
  await context.setOffline(false);

  // The sticky Save: timezone plus a number, then a value that is not a number.
  const form = page.locator('#reading-form');
  await form.locator('#set-timezone').selectOption('Europe/Berlin');
  await form.locator('#set-articles_per_page').fill('70');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toasts(page).last()).toContainText('Saved');
  await settle(page);
  expect(readingSettings()).toMatchObject({ articles_per_page: 70, timezone: 'Europe/Berlin' });
  // type=number refuses typed letters, so the field becomes text first: the server
  // answers what a browser without number inputs would send.
  await page.locator('#set-articles_per_page').evaluate(el => { el.type = 'text'; });
  await page.locator('#set-articles_per_page').fill('abc');
  await page.locator('#reading-form').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#set-articles_per_page-error')).toContainText('Enter a whole number');
  // The form comes back as a number field again, marked invalid next to its error.
  await expect(page.locator('#set-articles_per_page')).toHaveAttribute('aria-invalid', 'true');
  expect(readingSettings().articles_per_page).toBe(70);
});
});

test('settings: delayed delete of a label and a filter with Undo', async ({ page }) => {
  const [tagFilter, muteFilter] = makeFilters([
    ['Tag storms', 'label', String(s.labels.work)],
    ['Mute storms', 'mark_read', null],
  ]);
  const posts = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/settings/deletes' && request.method() === 'POST') posts.push(request.postDataJSON());
  });

  // Undo inside the 10 s: the row is back and nothing was sent.
  await page.goto('/settings/labels');
  const workRow = page.locator(`[data-rf-delete-key="label:${s.labels.work}"]`);
  await expect(workRow).toBeVisible();
  const count = page.locator('#labels-count');
  const noLabels = page.locator('#labels-list').getByText('No labels yet');
  await expect(count).toHaveText('(2)');
  await expect(noLabels).toBeHidden();
  await page.locator(`[data-rf-delete="label:${s.labels.work}"]`).click();
  await expect(workRow).toBeHidden();
  // The page follows the delete without a reload: the count, and the empty text once
  // the last label goes (Later is put back at once, so only Work is ever sent).
  await expect(count).toHaveText('(1)');
  await page.evaluate(id => window.RFPending.schedule({ kind: 'label', id, label: 'Later' }), s.labels.later);
  await expect(count).toHaveText('(0)');
  await expect(noLabels).toBeVisible();
  expect(await page.evaluate(id => window.RFPending.undo(`label:${id}`), s.labels.later)).toBe(true);
  await expect(count).toHaveText('(1)');
  await expect(noLabels).toBeHidden();
  await toasts(page).filter({ hasText: 'Deleted Work' }).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(workRow).toBeVisible();
  await expect(count).toHaveText('(2)');
  await page.waitForTimeout(11_000);
  expect(posts).toEqual([]);
  expect(filterState(tagFilter)).toEqual({ active: true });

  // The label and a filter within the same 10 s: one batch with both. The filter's
  // trigger is on Relevance & filters, the label's on Labels, and leaving a page sends
  // what is pending, so the label is scheduled on this page through RFPending, the
  // same call its trigger makes. Each item's own timer sends only the items whose 10 s
  // are up; everything pending travels together when the page is hidden or left
  // (pending.js), so the tab is hidden here, as when a phone switches apps.
  await page.goto('/settings/relevance');
  const muteRow = page.locator(`[data-rf-delete-key="filter:${muteFilter}"]`);
  await expect(muteRow).toBeVisible();
  await page.locator(`[data-rf-delete="filter:${muteFilter}"]`).click();
  await expect(muteRow).toBeHidden();
  // With the other filter pending too the list reads empty; its Undo brings it back.
  const noFilters = page.locator('#filters-list').getByText('No filters yet');
  await expect(noFilters).toBeHidden();
  await page.locator(`[data-rf-delete="filter:${tagFilter}"]`).click();
  await expect(noFilters).toBeVisible();
  expect(await page.evaluate(id => window.RFPending.undo(`filter:${id}`), tagFilter)).toBe(true);
  await expect(noFilters).toBeHidden();
  await expect(page.locator(`[data-rf-delete-key="filter:${tagFilter}"]`)).toBeVisible();
  await page.evaluate(id => window.RFPending.schedule({ kind: 'label', id, label: 'Work' }), s.labels.work);
  const answered = page.waitForResponse(r => new URL(r.url()).pathname === '/settings/deletes', { timeout: 20_000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  const response = await answered;
  expect(response.ok()).toBe(true);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual(expect.arrayContaining([
    { kind: 'filter', id: muteFilter }, { kind: 'label', id: s.labels.work },
  ]));
  expect(posts[0]).toHaveLength(2);
  await expect(toasts(page).filter({ hasText: 'Turned off 1 filter' })).toContainText('Tag storms');
  expect(filterState(muteFilter)).toBe(null);
  expect(filterState(tagFilter)).toEqual({ active: false });

  await page.reload();
  await expect(page.locator('#filters-list')).not.toContainText('Mute storms');
  await expect(page.locator('#filters-list')).toContainText('Tag storms');
  await page.goto('/settings/labels');
  await expect(page.locator('#labels-list')).not.toContainText('Work');
  await expect(page.locator('#labels-list')).toContainText('Later');
});

test('settings: filter from this source', async ({ page, context }) => {
  const w1 = s.articles.w1.id;
  await openArticle(page, w1);
  const item = page.locator(`#article-menu-${w1}-menu`).getByRole('menuitem', { name: 'Filter from this source' });
  await page.locator('#article-detail').getByRole('button', { name: 'More actions' }).first().click();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/settings/filters/new\\?feed=${s.feeds.world}$`));
  const checked = page.locator('input[name="scope_include"]:checked');
  await expect(checked).toHaveCount(1);
  await expect(checked).toHaveValue(`feed:${s.feeds.world}`);
  await expect(page.locator('input[name="name"]')).toHaveValue('World Wire');

  if (await page.locator('#conditions .condition-row').count() === 0) await page.locator('#add-condition').click();
  await page.locator('#conditions input[name="cond_value"]').first().fill('Kestrel');
  if (await page.locator('#actions .action-row').count() === 0) await page.locator('#add-action').click();
  await page.locator('#actions select[name="action_type"]').first().selectOption('star');
  await page.getByRole('button', { name: 'Create filter', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/relevance$/);
  await expect(page.locator('#filters-list')).toContainText('World Wire');

  // A saved article without a feed has no source to scope to.
  const saved = orm(`        a = Article(feed_id=None, guid='e2e-saved-filter',
                    guid_hash=hashlib.sha256(b'e2e-saved-filter').hexdigest(),
                    url='https://saved-filter.e2e.invalid/post', title='Saved without a source',
                    content='<p>Saved without a source.</p>', content_source='feed',
                    readable_status='skipped', published_at=NOW, fetched_at=NOW)
        db.add(a)
        await db.flush()
        db.add(UserArticleState(user_id=${s.alice.id}, article_id=a.id, saved_at=NOW))
        await db.commit()
        print(json.dumps(a.id))`);
  await openArticle(page, saved);
  await page.locator('#article-detail').getByRole('button', { name: 'More actions' }).first().click();
  await expect(page.locator(`#article-menu-${saved}-menu`).getByRole('menuitem', { name: 'Copy' })).toBeVisible();
  await expect(page.locator(`#article-menu-${saved}-menu`).getByRole('menuitem', { name: 'Filter from this source' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Offline (offline mode on, connection gone), the item is disabled.
  await enableOffline(page);
  await waitReady(page);
  await openArticle(page, w1);
  await context.setOffline(true);
  const offlineItem = page.locator(`#article-menu-${w1}-menu a[href^="/settings/filters/new"]`);
  await expect(offlineItem).toHaveAttribute('aria-disabled', 'true');
  await expect(offlineItem).toHaveAttribute('title', 'Needs a connection');
});

test('settings: old bookmarks, stale form and diagnostics', async ({ page }) => {
  await page.goto('/settings/preferences?x=1#offline-diagnostics');
  await expect(page).toHaveURL(/\/settings\/reading\?x=1(#offline-diagnostics)?$/);
  await expect(page.locator('#offline-diagnostics')).toBeInViewport();

  await page.goto('/settings/filters');
  await expect(page).toHaveURL(/\/settings\/relevance$/);
  await expect(page.locator('#filters-list')).toHaveCount(1);

  // A tab opened before the move posts the whole old form to the old address.
  const stale = await page.evaluate(async () => {
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]*)/) || [])[1] || '';
    const r = await fetch('/settings/preferences', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrftoken': csrf },
      body: new URLSearchParams({ articles_per_page: '77', timezone: 'UTC', mark_read_on_scroll: 'on' }).toString(),
    });
    return { status: r.status, saved: (await r.text()).includes('Settings saved.') };
  });
  expect(stale).toEqual({ status: 200, saved: true });
  expect(readingSettings()).toMatchObject({ articles_per_page: 77, mark_read_on_scroll: true });

  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/reading$/);
  await expect(page.locator('h1')).toHaveText('Reading & appearance');

  // Online, a long press on the offline status line opens the diagnostics.
  await enableOffline(page);
  await waitReady(page);
  const slot = page.locator('[data-rf-slot="offline-status"]:visible').first();
  const box = await slot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForURL(/\/settings\/reading#offline-diagnostics$/, { timeout: 5_000 });
  await page.mouse.up();
  await expect(page.locator('#offline-diagnostics')).toBeInViewport();
});

test('settings: phone tabs, stored collapsible mode and token shown once', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pages = ['/settings/reading', '/settings/relevance', '/settings/labels', '/settings/ai',
    '/settings/profile', '/settings/tokens', '/settings/stats'];
  for (const url of pages) {
    await page.goto(url);
    const tabs = page.locator('[data-mobile-nav]');
    await expect(tabs, url).toBeVisible();
    await expect(tabs.locator('[data-mobile-nav-active]'), url).toBeInViewport();
    await expect.poll(() => activeTabInStrip(page), { message: url, timeout: 3_000 }).toBe(true);
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth }));
    expect(widths.scroll, `${url} ${JSON.stringify(widths)}`).toBeLessThanOrEqual(widths.inner + 1);
  }
  await page.goto('/settings/tokens');
  await expect(page.locator('[data-mobile-nav] [data-mobile-nav-active]')).toHaveText('Account');
  await expect(page.locator('[data-rf-settings-subnav] [aria-current="page"]')).toHaveText('API tokens');

  // A phone that stored the retired Collapsible mode boots as hideable-up.
  await page.addInitScript(() => { try { localStorage.setItem('sidebar_mode_small', 'collapsible'); } catch (e) { /* none */ } });
  await page.goto('/app');
  await expect(page.locator('html')).toHaveAttribute('data-sidebar-mode', 'hideable-up');

  // A new token is shown once, with Copy; Back and a reload do not bring it back.
  await page.goto('/settings/tokens');
  // A strip offset saved by an earlier tab click (app.js restores it on every settle)
  // that would put Account off-screen.
  await page.evaluate(() => sessionStorage.setItem('_snav_scroll', '0'));
  await page.locator('#token-name').fill('Phone script');
  await page.locator('#token-name').press('Enter');
  const value = page.locator('#new-token-value');
  await expect(value).toBeVisible();
  const token = (await value.textContent()).trim();
  expect(token.length).toBeGreaterThan(10);
  await expect(page.locator('.copy-from-btn[data-copy-from="new-token-value"]')).toBeVisible();
  // The boosted post swapped in a new tab row: its active tab is scrolled into view
  // again, and the saved strip offset restored on settle does not undo it.
  await settle(page);
  await expect(page.locator('[data-mobile-nav] [data-mobile-nav-active]')).toHaveText('Account');
  await expect.poll(() => activeTabInStrip(page), { timeout: 3_000 }).toBe(true);
  // Back may be an htmx history restore that settles after the navigation resolves.
  await page.goBack();
  await page.waitForLoadState('networkidle');
  await settle(page);
  // Back alone (an htmx history restore or the browser's own page) never shows it.
  await expect(page.locator('#new-token-value')).toHaveCount(0);
  expect(await page.content()).not.toContain(token);
  await page.reload();
  await expect(page.locator('#new-token-value')).toHaveCount(0);
  expect(await page.content()).not.toContain(token);
  await expect(page.locator('#tokens-list')).toContainText('Phone script');
});
