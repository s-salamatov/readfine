// Pages of the visual gallery (RF_VISUAL_MODE=gallery, tests/visual/key-screens.spec.mjs).
//
// Entry: { name, path, account, status?, state?, setup? }
// - path: a string or (seed) => string; the page must end on this path.
// - account: 'anonymous', 'alice' (the seeded reader) or 'admin'. The e2e seed has no
//   separate admin; the spec promotes alice, so 'admin' and 'alice' share her session.
//   The field names the access the page needs.
// - status: the expected HTTP status of the final navigation (default: a 2xx).
// - state: 'registration-open' pages are captured with registration switched on
//   through the admin settings form (default off), then switched back off.
// - setup(page): replaces the plain navigation; returns the final navigation's response.
//
// Verified against backend/app/routers (2026-11-21). Not reachable without faking the
// server, so not listed:
// - 500 (errors/500.html): only an unhandled exception renders it;
// - errors/client.html: a validation/integrity error on a form POST, no stable GET;
// - reset_password_confirm, email_change_result: need a mailed token the seed does not
//   create.

// Native form.submit() skips the submit event, so htmx's hx-boost does not take the
// POST over and the browser renders the response itself, error statuses included.
// /reset-password is CSRF-exempt (main.py). The limit is 2/hour per client address,
// in memory, so a fresh server answers the third POST with 429.
async function exhaustResetLimit(page) {
  for (let i = 0; i < 4; i++) {
    await page.goto('/reset-password');
    const [response] = await Promise.all([
      page.waitForNavigation(),
      page.evaluate(() => {
        const form = document.querySelector('form[action="/reset-password"]');
        form.querySelector('input[name="email"]').value = 'visual-gallery@example.com';
        form.submit();
      }),
    ]);
    if (response?.status() === 429) return response;
  }
  throw new Error('reset-password rate limit never answered 429');
}

export const KEY_SCREEN_PAGES = [
  { name: 'login', path: '/login', account: 'anonymous' },
  { name: 'list', path: '/app', account: 'alice' },
  { name: 'article', path: (s) => `/app?open_article_id=${s.articles.w1.id}`, account: 'alice' },
  { name: 'catch-me-up', path: '/app/catch-me-up', account: 'alice' },
  { name: 'settings-preferences', path: '/settings/preferences', account: 'alice' },
  { name: 'settings-feeds', path: '/sources', account: 'alice' },
  { name: 'help', path: '/help', account: 'alice' },
  { name: 'admin-settings', path: '/admin/settings', account: 'admin' },
];

// The reader with the sidebar's account menu open (s3-T3). No URL opens it, so the
// setup clicks its trigger. A tree without the menu (a base before s3) gets the plain
// reader.
async function openAccountMenu(page) {
  const response = await page.goto('/app');
  const trigger = page.locator('#account-menu-trigger');
  if (await trigger.count()) {
    await trigger.click();
    await page.locator('#account-menu-popover').waitFor({ state: 'visible' });
  }
  return response;
}

// The list with its View menu open (s4). A tree without the menu (a base before s4)
// gets the plain list.
async function openViewMenu(page) {
  const response = await page.goto('/app');
  const trigger = page.locator('#list-view-menu-trigger');
  if (await trigger.count()) {
    await trigger.click();
    await page.locator('#list-view-menu-popover').waitFor({ state: 'visible' });
  }
  return response;
}

// The first article of the list open on its AI panel's Context tab (s4). The article is
// opened through its URL (setup gets no seed, so the id comes from the list); a tree
// without the panel (a base before s4) gets the plain article.
async function openAiContext(page) {
  await page.goto('/app');
  const id = await page.locator('#article-list .article-row[data-article-id]').first().getAttribute('data-article-id');
  const response = await page.goto(`/app?open_article_id=${id}`);
  // The article arrives through htmx after the page has loaded.
  await page.locator(`#article-detail article[data-article-id="${id}"]`).waitFor({ state: 'visible' });
  const tab = page.locator('#article-detail').getByRole('tab', { name: 'Context' }).first();
  if (await tab.count()) {
    // Basecoat's tabs.js binds the tab list once it sees it; a click before that is lost.
    for (let i = 0; i < 10 && (await tab.getAttribute('aria-selected')) !== 'true'; i++) {
      await tab.click();
      await page.waitForTimeout(100);
    }
    if ((await tab.getAttribute('aria-selected')) !== 'true') throw new Error('AI panel: the Context tab did not open');
  }
  return response;
}

export const GALLERY_PAGES = [
  ...KEY_SCREEN_PAGES,
  // The account menu sits in the full sidebar, which a phone shows only as a sheet.
  { name: 'account-menu', path: '/app', account: 'alice', widths: [1280], setup: openAccountMenu },
  { name: 'list-view-menu', path: '/app', account: 'alice', setup: openViewMenu },
  { name: 'article-ai-context', path: '/app', account: 'alice', setup: openAiContext },
  // auth
  { name: 'register', path: '/register', account: 'anonymous', state: 'registration-open' },
  { name: 'registration-disabled', path: '/register', account: 'anonymous' },
  { name: 'reset-password', path: '/reset-password', account: 'anonymous' },
  { name: 'check-email', path: '/register/check-email?email=reader%40example.com&sent=1', account: 'anonymous' },
  // errors
  { name: 'error-404', path: '/visual-gallery-no-such-page', account: 'anonymous', status: 404 },
  { name: 'error-429', path: '/reset-password', account: 'anonymous', status: 429, setup: exhaustResetLimit },
  // admin
  { name: 'admin-dashboard', path: '/admin', account: 'admin' },
  { name: 'admin-traffic', path: '/admin/traffic', account: 'admin' },
  { name: 'admin-scoring-eval', path: '/admin/scoring-eval', account: 'admin' },
  { name: 'admin-users', path: '/admin/users', account: 'admin' },
  { name: 'admin-invitations', path: '/admin/invitations', account: 'admin' },
  { name: 'admin-audit-log', path: '/admin/audit-log', account: 'admin' },
  { name: 'admin-fetch-logs', path: '/admin/fetch-logs', account: 'admin' },
  { name: 'admin-feeds', path: '/admin/feeds', account: 'admin' },
  // public
  { name: 'features', path: '/features', account: 'anonymous' },
  { name: 'changelog', path: '/changelog', account: 'anonymous' },
  { name: 'privacy', path: '/privacy', account: 'anonymous' },
  { name: 'terms', path: '/terms', account: 'anonymous' },
];

// Added with RF_VISUAL_LANDING=1, which copies landing.example.html to landing.html for
// the run. `/` renders the landing only while registration is open.
export const LANDING_PAGE = { name: 'landing', path: '/', account: 'anonymous', state: 'registration-open' };

// Added with RF_VISUAL_DEBUG=1 (DEBUG on in the head app), captured at 1280 only.
export const DEV_UI_PAGE = { name: 'dev-ui', path: '/dev/ui', account: 'alice', widths: [1280] };

// Preserve Sources gallery keys. A pre-s5 base uses the equivalent full page;
// the s6 baseline already has Sources sheets and exercises those same sheets.
let lastScrapePreview = 0;
async function sourceState(page, { side, kind }) {
  let root = side === 'base' ? '/settings/feeds' : '/sources';
  let response = await page.goto(root);
  const hasSheets = await page.evaluate(() => Boolean(window.RFSources));
  if (hasSheets) root = '/sources';
  let edit;
  if (kind === 'edit') edit = await page.locator('a[href$="/edit"]').first().getAttribute('href');
  const destination = kind === 'add' ? (hasSheets ? '/sources/add' : root)
    : kind === 'edit' ? edit
    : kind === 'opml-report' ? (hasSheets ? '/sources/opml' : '/settings/opml')
    : (hasSheets ? '/sources/scrape' : '/settings/feeds/scrape-setup') + '?url=http%3A%2F%2F127.0.0.1%3A4252%2Fmanual';
  if (!hasSheets) response = await page.goto(destination);
  else {
    await page.evaluate(url => window.RFSources.open(url, document.querySelector('#sources-heading')), destination);
    await page.locator('#rf-source-sheet-body form').first().waitFor({ state: 'visible' });
  }
  if (kind === 'opml-report') {
    await page.locator('#opml-import-form input[type=file]').setInputFiles({
      name: 'gallery.opml', mimeType: 'text/xml',
      buffer: Buffer.from('<opml version="2.0"><head><title>Gallery</title></head><body/></opml>'),
    });
    await page.locator('#opml-submit-btn').click();
    await page.getByRole('heading', { name: 'Import complete', exact: true }).waitFor();
  }
  if (kind === 'scrape-manual-error') {
    await page.locator('#selector-input').fill('[');
    // Twelve theme/viewport shots share the real endpoint's 10/minute budget.
    // Space previews so the gallery captures the form error, not a rate limit.
    const pause = 6100 - (Date.now() - lastScrapePreview);
    if (pause > 0) await page.waitForTimeout(pause);
    lastScrapePreview = Date.now();
    await page.locator('#preview-btn').click();
    await page.locator('#scrape-preview').filter({ hasText: /.+/ }).waitFor();
  }
  return response;
}

export const SOURCES_GALLERY_PAGES = [
  { name: 'sources-add-full-page', path: '/sources/add', account: 'alice' },
  { name: 'sources-opml-full-page', path: '/sources/opml', account: 'alice' },
  { name: 'sources-scrape-full-page', path: '/sources/scrape?url=http%3A%2F%2F127.0.0.1%3A4252%2Fmanual', account: 'alice' },
  ...['add', 'edit', 'opml-report', 'scrape-manual-error'].map(kind => ({
  name: `sources-${kind}-sheet-base-full-page`, path: '/settings/feeds', account: 'alice',
  sourceState: kind,
  setup: (page, context) => sourceState(page, { ...context, kind }),
})),
];

// Assistant states use the actual page on head, the old modal/Catch me up/AI
// settings on base. AI/mail are never called. Pending/error responses are fixtures.
async function assistantState(page, { side, kind }) {
  const { execFileSync } = await import('node:child_process');
  const { APP_ENV, BACKEND } = await import('../e2e/env.mjs');
  const sql = async (missing = false) => execFileSync(`${BACKEND}/.venv/bin/python`, ['-c', `
import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings
async def main():
    e=create_async_engine(settings.database_url)
    async with e.begin() as c:
        await c.execute(text("update user_settings set ai_quality_provider='custom', ai_quality_model=${missing ? 'NULL' : "'fixture'"}, ai_custom_base_url='http://127.0.0.1:4252/never-ai', ai_chat_enabled=true, ai_scoring_enabled_default=true where user_id=(select id from users where email='alice@e2e.example')"))
        await c.execute(text("update app_settings set smtp_host='127.0.0.1', smtp_from_email='fixture@example.invalid' where id=1"))
    await e.dispose()
asyncio.run(main())`], { cwd:BACKEND, env:{...process.env,...APP_ENV}, encoding:'utf8' });
  await sql(kind === 'missing-provider');
  let response;
  try {
    if (kind === 'profile' || kind === 'missing-provider') {
      response = await page.goto(side === 'base' ? '/settings/ai' : `/assistant${kind === 'profile' ? '?section=profile' : ''}`);
      if (kind === 'profile') await page.locator('#ai_preference_text').fill('High relevance: systems, science, open source\nAvoid: sponsored content');
    } else if (kind.startsWith('briefing')) {
      response = await page.goto(side === 'base' ? '/app/catch-me-up' : '/assistant/catch-up');
      // Reuse one persisted config for all theme/viewport captures.
      if (!(await page.locator('[data-action=open-briefing-modal]').count())) {
        await page.locator('#save-config-form input').fill('Visual briefing');
        await page.locator('#save-config-form button').click();
        await page.locator('[data-action=open-briefing-modal]').first().waitFor();
      }
      await page.locator('[data-action=open-briefing-modal]').first().click();
      await page.locator('#briefing-enabled-toggle').check();
      await page.locator('[name=briefing_time]').fill(kind === 'briefing-invalid' ? '25:10' : '09:30');
      if (kind === 'briefing-invalid') {
        await page.locator('#briefing-form button[type=submit]').click();
        await page.locator('#briefing-form-error').filter({hasText: /.+/}).waitFor();
      } else {
        const saved = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/briefing'));
        await page.locator('#briefing-form button[type=submit]').click();
        const result = await saved; await result.finished();
        if (!result.ok()) throw new Error(`Briefing fixture save: HTTP ${result.status()}`);
        // Base saves without the new list response; reopen through the real page.
        response = await page.goto(side === 'base' ? '/app/catch-me-up' : '/assistant/catch-up');
        await page.locator('[data-action=open-briefing-modal]').first().click();
        await page.locator('[name=briefing_time]').waitFor({state:'visible'});
        if (await page.locator('[name=briefing_time]').inputValue() !== '09:30') throw new Error('Saved briefing time did not persist');
      }
    } else {
      response = await page.goto('/app');
      const id = await page.locator('.article-row[data-article-id]').first().getAttribute('data-article-id');
      if (side === 'head') response = await page.goto(`/assistant${kind === 'article-context' ? `?article_id=${id}` : ''}`);
      else {
        if (kind === 'article-context') {
          response = await page.goto(`/app?open_article_id=${id}`);
          await page.locator('#article-detail [data-show-chat-modal]').first().click();
        } else await page.locator('#sidebar-chat-btn').evaluate(el => el.click());
      }
      const input = page.locator(side === 'base' && kind === 'article-context' ? `#chat-input-${id}` : '#general-chat-input');
      await input.fill('How do these ideas relate? A long question to inspect wrapping and the reachable Send button.');
      if (kind === 'chat-pending' || kind === 'chat-error') {
        await page.route('**/htmx/ai-chat', async route => {
          if (kind === 'chat-pending') await new Promise(resolve => setTimeout(resolve, 15000));
          await route.fulfill({status:503, body:'Fixture: provider temporarily unavailable'}).catch(() => {});
        });
        // The baseline has a hidden submit proxy; Enter is the user action on both sides.
        await input.press('Enter');
        if (kind === 'chat-pending') {
          if (side === 'base') await page.locator('#general-chat-messages .animate-chat-bounce').first().waitFor({state:'visible'});
          else await page.locator('[aria-label="Waiting for reply"]').waitFor({state:'visible'});
        }
        else await page.locator('[data-chat-error]').waitFor({state:'visible'});
      }
    }
    return response;
  } finally { if (kind === 'missing-provider') await sql(false); }
}
export const ASSISTANT_GALLERY_PAGES = ['chat', 'article-context', 'chat-pending', 'chat-error', 'briefing-invalid', 'briefing-saved', 'profile', 'missing-provider'].map(kind => ({
  name: `assistant-${kind}-base-${kind.startsWith('briefing') ? 'catch-up' : kind === 'profile' || kind === 'missing-provider' ? 'ai-settings' : 'modal'}`,
  path: '/assistant', account:'alice', assistantState:kind,
  setup:(page, context) => assistantState(page, {...context, kind}),
}));
