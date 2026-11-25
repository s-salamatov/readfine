// Five acceptance flows. AI/job/mail transport is stubbed explicitly; profile,
// configurations, schedules and redirects use the real isolated backend.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { seed, login, enableOffline, waitReady, pageFetch, appliedOps } from './helpers.mjs';
import { APP_ENV, BACKEND } from './env.mjs';
import { requireE2eDatabaseUrl } from './db-guard.mjs';
requireE2eDatabaseUrl(); // collection-time, before any seed
let s;
const csp = new WeakMap(), external = new WeakMap();
function python(code) {
  return execFileSync(path.join(BACKEND, '.venv/bin/python'), ['-c', code], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8',
  });
}
function db(code) {
  requireE2eDatabaseUrl();
  return JSON.parse(python(`import asyncio, json
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings
async def main():
    engine = create_async_engine(settings.database_url)
    async with engine.begin() as c:
${code}
    await engine.dispose()
asyncio.run(main())`));
}
function configure(values = "ai_quality_provider='custom', ai_quality_model='fixture', ai_custom_base_url='http://127.0.0.1:4252/never-ai', ai_chat_enabled=true, ai_scoring_enabled_default=true") {
  db(`        await c.execute(text("update user_settings set ${values} where user_id=:u"), {'u': ${s.alice.id}})
        print('null')`);
}
function settings() {
  return db(`        row = (await c.execute(text("select ai_quality_provider, ai_quality_model, ai_chat_enabled, ai_scoring_enabled_default, ai_preference_text, ai_preference_auto_days from user_settings where user_id=:u"), {'u': ${s.alice.id}})).mappings().one()
        print(json.dumps(dict(row)))`);
}
function chatHTML(message = 'Fixture response', article = null) {
  return python(`from app.templating import templates
print(templates.env.get_template('assistant/chat.html').module.assistant_chat_area([{'role':'assistant','content':${JSON.stringify(message)}}], ${article ?? 'None'}, 'Fixture article'))`);
}
const settle = page => page.waitForFunction(() => !document.querySelector('.htmx-request,.htmx-swapping,.htmx-settling'));
async function overflow(page) {
  const bounds = await page.evaluate(() => ({ width:innerWidth, scroll:document.documentElement.scrollWidth, outside:[...document.querySelectorAll('#assistant-main *')].map(el => ({id:el.id, tag:el.tagName, right:el.getBoundingClientRect().right, width:el.getBoundingClientRect().width})).filter(box => box.width > 0 && box.right > innerWidth + 1).slice(0,12) }));
  expect.soft(bounds.scroll, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.width + 1);
}
async function saveConfig(page) {
  await page.locator('#save-config-form input').fill('Acceptance briefing');
  await page.locator('#save-config-form button').click();
  await expect(page.locator('#catchup-configs-list')).toContainText('Acceptance briefing');
  return page.locator('[data-action="open-briefing-modal"]').first();
}
test.beforeEach(async ({ page }) => {
  s = seed(); configure(); csp.set(page, []); external.set(page, []);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) external.get(page).push(url.href);
  });
  await page.exposeFunction('recordAssistantCsp', value => csp.get(page).push(value));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.recordAssistantCsp(`${e.violatedDirective} ${e.blockedURI}`)));
  await login(page, s.alice.email, s.password);
});
test.afterEach(async ({ page, context }) => {
  await context.setOffline(false);
  expect(csp.get(page)).toEqual([]); expect(external.get(page)).toEqual([]);
  db(`        await c.execute(text("update app_settings set smtp_host=NULL, smtp_from_email=NULL where id=1"))
        print('null')`);
  seed();
});

test.describe('online Assistant transport', () => {
  // A pass-through service worker also owns fetches when offline mode is off;
  // block it only in the four transport-stub cases. The offline case below enables it.
  test.use({ serviceWorkers: 'block' });

test('assistant: chat and article entry on phone', async ({ page }) => {
  test.setTimeout(150_000);
  let posts = 0, mode = 'ok', release;
  const reply = chatHTML();
  const articleReply = python(`from app.routers.web.app.ai import _render_chat_area
print(_render_chat_area(${s.articles.w1.id}, [{'role':'assistant','content':'Article fixture response'}]))`);
  let articlePosts = 0;
  await page.route(`**/htmx/articles/${s.articles.w1.id}/ai-chat`, route => { articlePosts++; return route.fulfill({contentType:'text/html', body:articleReply}); });
  await page.route('**/htmx/ai-chat', async route => {
    posts++;
    if (mode === 'delay') await new Promise(resolve => { release = resolve; });
    if (mode === 'fail') return route.fulfill({ status: 503, body: 'Fixture unavailable' });
    await route.fulfill({ contentType: 'text/html', body: reply });
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/app?open_article_id=${s.articles.w1.id}`);
    const detail = page.locator('#article-detail');
    await expect(detail.locator('article')).toBeVisible();
    for (const name of ['Summary', 'Context']) {
      const tab = detail.getByRole('tab', { name, exact: true });
      await tab.click(); await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
    await detail.locator('[data-show-chat-modal]').first().click();
    const articleInput = page.locator(`#chat-input-${s.articles.w1.id}`);
    await expect(articleInput).toBeVisible();
    const articleBefore = articlePosts; await articleInput.fill('Question about this article'); await articleInput.press('Enter');
    await expect(page.locator(`#chat-area-${s.articles.w1.id}`)).toContainText('Article fixture response');
    expect(articlePosts).toBe(articleBefore + 1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { sessionStorage.setItem('_gchat_owner', 'another-account'); sessionStorage.setItem('_gchat_history', '[{"role":"user","content":"Foreign thread"}]'); });
    await page.goto(`/assistant?article_id=${s.articles.w1.id}`);
    await expect(page.locator('#general-chat-messages')).toBeEmpty();
    await expect(page.locator('#assistant-chat-scope')).toHaveValue('article');
    const input = page.locator('#general-chat-input');
    await input.fill('Long message '.repeat(100));
    await input.press('Shift+Enter');
    expect(await input.inputValue()).toContain('\n');
    mode = 'delay'; const before = posts;
    await input.press('Enter');
    await expect(page.locator('#rf-assistant-chat')).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => posts).toBe(before + 1);
    await overflow(page);
    await page.locator('#assistant-chat-scope').selectOption('general');
    await expect(page.locator('#general-chat-history')).toHaveValue('[]');
    await expect(input).toHaveValue('');
    await expect(page.locator('#assistant-chat-status')).toContainText('New conversation');
    release(); mode = 'ok'; await settle(page);
    await expect(page.locator('#general-chat-messages')).toBeEmpty();
    await page.goBack(); await expect(page.locator('#assistant-chat-scope')).toHaveValue('article');
    await page.goForward(); await expect(page.locator('#assistant-chat-scope')).toHaveValue('general');
    mode = 'fail'; await input.fill('Keep my retry'); await page.locator('#general-chat-submit').click();
    await expect(page.locator('[data-chat-error]')).toBeVisible();
    await expect(input).toHaveValue('Keep my retry'); await expect(input).toBeFocused();
    mode = 'ok'; await page.setViewportSize({ width, height: 480 });
    await page.locator('#general-chat-submit').click();
    await expect(page.locator('#general-chat-messages')).toContainText('Fixture response');
    await expect(page.locator('#general-chat-submit')).toBeInViewport(); await overflow(page);
    await settle(page);
    expect.soft(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').map(a => ({name:a.animationName || a.transitionProperty, target:a.effect?.target?.id || a.effect?.target?.className})))).toEqual([]);
    // Repeated boosted navigation must not add a second listener/request.
    for (let i = 0; i < 2; i++) {
      await page.getByRole('link', { name: 'Catch me up & Briefings' }).click();
      await page.getByRole('link', { name: 'Chat', exact: true }).click();
    }
    const n = posts; await page.locator('#general-chat-input').fill('Once');
    await page.locator('#general-chat-submit').click(); await settle(page);
    expect(posts).toBe(n + 1);
  }
});

test('assistant: digest and briefing sheet', async ({ page }) => {
  db(`        await c.execute(text("update app_settings set smtp_host='127.0.0.1', smtp_from_email='fixture@example.invalid' where id=1"))
        print('null')`);
  await page.goto('/assistant/catch-up');
  await page.locator('label').filter({ has: page.locator('input[name=period][value=today]') }).click();
  await page.locator('.scope-item-cb[value^="folder:"]').first().check();
  await page.locator('.scope-item-cb[value^="feed:"]').last().check();
  await page.locator('.label-item-cb').first().check();
  const scope = await page.locator('#scope-value').inputValue();
  const labels = await page.locator('#catchup-label-value').inputValue();
  const opener = await saveConfig(page);
  await page.locator('[data-action=load-catchup-config]').first().click();
  await expect(page.locator('#scope-value')).toHaveValue(scope); await expect(page.locator('#catchup-label-value')).toHaveValue(labels);
  await page.locator('[data-action=toggle-config-menu]').first().click();
  await page.locator('[data-action=rename-config]').first().click();
  await page.getByRole('textbox', { name: 'Configuration name', exact: true }).fill('Renamed briefing');
  await page.locator('[data-action=save-config-rename]').click();
  await expect(page.locator('#catchup-configs-list')).toContainText('Renamed briefing');
  let polls = 0;
  await page.route('**/htmx/catch-me-up/generate', route => route.fulfill({ contentType:'text/html', body:'<div hx-get="/htmx/catch-me-up/jobs/fixture" hx-trigger="load delay:3s" hx-target="#catchup-result" hx-swap="innerHTML">Fixture progress</div>' }));
  await page.route('**/htmx/catch-me-up/jobs/fixture', route => { polls++; return route.fulfill({ contentType:'text/html', body:'<div class="prose">Terminal fixture digest</div>' }); });
  await page.getByRole('button', { name: 'Generate briefing', exact: true }).click();
  await expect(page.locator('#catchup-result')).toContainText('Fixture progress');
  await expect(page.locator('#catchup-result')).toContainText('Terminal fixture digest');
  await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.__copied = text; }; });
  await page.locator('#catchup-copy-btn').click();
  expect(await page.evaluate(() => window.__copied)).toContain('Terminal fixture digest');
  await opener.click(); await expect(page.locator('#rf-briefing-sheet')).toHaveAttribute('open', '');
  await page.locator('#briefing-enabled-toggle').check();
  await page.locator('#briefing-interval').selectOption('weekly');
  await page.locator('[name=briefing_day]').selectOption('2');
  const time = page.locator('[name=briefing_time]');
  await time.fill('25:10'); await page.locator('#briefing-form button[type=submit]').click();
  await expect(page.locator('#briefing-form-error [role=alert]')).toBeVisible();
  await expect(time).toHaveValue('25:10');
  expect(await page.locator('#rf-briefing-sheet').evaluate(el => el.contains(document.activeElement))).toBe(true);
  await time.fill('09:30'); await page.locator('#briefing-form button[type=submit]').click();
  await expect(page.locator('#rf-briefing-sheet')).not.toHaveAttribute('open', '');
  await expect(opener).toHaveAttribute('title', 'Briefing: Weekly Wed 09:30');
  await opener.click(); await expect(time).toHaveValue('09:30');
  await page.keyboard.press('Tab');
  const focus = await page.locator('#rf-briefing-sheet').evaluate(el => ({open:el.open, inside:el.contains(document.activeElement), tag:document.activeElement?.tagName, id:document.activeElement?.id}));
  expect.soft(focus.inside, JSON.stringify(focus)).toBe(true);
  await page.route('**/briefing/test', route => route.fulfill({ status:429, contentType:'text/html', body:'<div role="alert">Fixture: too many test requests. Try again later.</div>' }));
  await page.locator('[data-briefing-test]').click();
  await expect(page.locator('#briefing-test-result')).toContainText('Wait a moment before sending another test');
  await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
  await page.getByRole('link', { name:'Chat', exact:true }).click();
  await page.waitForTimeout(3200); expect(polls).toBe(1);
});

test('assistant: profile and provider settings remain independent', async ({ page }) => {
  // Revert restores the previous automatic version, not the last manual edit.
  configure("ai_preference_prev_text='High relevance: distributed systems'");
  const before = settings();
  await page.goto('/assistant?section=profile');
  const input = page.locator('#ai_preference_text');
  await input.fill('High relevance: distributed systems');
  await page.locator('#ai_preference_auto_days').selectOption('14');
  await page.getByRole('button', { name:'Save interest profile' }).click(); await settle(page);
  await page.reload(); await expect(input).toHaveValue('High relevance: distributed systems');
  const saved = settings(); expect(saved.ai_preference_auto_days).toBe(14);
  for (const key of ['ai_quality_provider','ai_quality_model','ai_chat_enabled','ai_scoring_enabled_default']) expect(saved[key]).toBe(before[key]);
  const draft = 'High relevance: generated fixture topics';
  const generated = python(`from app.templating import templates
print(templates.env.get_template('assistant/profile_feedback.html').render(message='Draft ready. Save to apply.', error=False, profile_text=${JSON.stringify(draft)}))`);
  await page.route('**/assistant/profile/generate', route => route.fulfill({ contentType:'text/html', body:generated }));
  for (let i = 0; i < 2; i++) {
    await page.locator('#btn-generate-preference').click(); await expect(input).toHaveValue(draft);
    await expect(page.locator('#pref-char-count')).toHaveText(String(draft.length));
    expect(settings().ai_preference_text).toBe(saved.ai_preference_text);
  }
  await page.getByRole('button', { name:'Save interest profile' }).click(); await settle(page);
  await page.locator('#btn-revert-preference').click(); await expect(input).toHaveValue(saved.ai_preference_text);
  await input.fill('short'); await page.getByRole('button', { name:'Save interest profile' }).click();
  await expect(page.locator('#assistant-profile [role=alert]').first()).toBeVisible(); await expect(input).toHaveValue('short');
  await page.goto('/settings/ai');
  await expect(page.locator('a[href*="section=profile"]')).toBeVisible();
  const providerForm = page.locator('form[action="/settings/ai/preferences"]');
  await providerForm.locator('button[type=submit]').click(); await settle(page);
  expect(settings().ai_preference_text).toBe(saved.ai_preference_text);
});

test('assistant: missing configuration and failed requests', async ({ page }) => {
  for (const [values, message] of [
    ["ai_quality_model=NULL", 'Choose a main model'],
    ["ai_quality_provider='anthropic', ai_quality_model='fixture'", 'Add an API key'],
    ["ai_quality_provider='custom', ai_custom_base_url=NULL", 'Set the custom model endpoint'],
    ["ai_custom_base_url='http://127.0.0.1:4252/never-ai', ai_chat_enabled=false", 'Enable chat'],
  ]) {
    configure(values); await page.goto('/assistant');
    await expect(page.locator('#assistant-chat')).toContainText(message);
    await expect(page.locator('#general-chat-submit')).toBeDisabled();
    await expect(page.getByRole('heading', { name:'Assistant', exact:true })).toBeVisible();
  }
  db(`        await c.execute(text("update app_settings set ai_enabled=false where id=1"))
        print('null')`);
  await page.goto('/assistant'); await expect(page.locator('#assistant-chat')).toContainText('Contact your administrator');
  db(`        await c.execute(text("update app_settings set ai_enabled=true where id=1"))
        print('null')`);
  configure('ai_scoring_enabled_default=false'); await page.goto('/assistant?section=profile');
  await expect(page.locator('#assistant-profile')).toContainText('Enable AI scoring');
  await expect(page.locator('#ai_preference_text')).toBeDisabled();
  configure(); await page.goto('/assistant/catch-up');
  const opener = await saveConfig(page); await opener.click();
  await expect(page.locator('#rf-briefing-sheet-body')).toContainText('Contact your administrator');
  await page.keyboard.press('Escape');
  await opener.evaluate(el => { el.dataset.configId = '2147483646'; }); await opener.click();
  await expect(page.locator('#rf-briefing-sheet-body [role=alert]')).toBeVisible();
  await expect(page.locator('#rf-briefing-sheet-body')).not.toContainText('Password');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name:'Chat', exact:true }).click();
  for (const fault of ['403', 'network', 'login']) {
    await page.route('**/htmx/ai-chat', route => fault === 'network' ? route.abort('failed') : route.fulfill({ status:fault === '403' ? 403 : 200, headers:fault === 'login' ? {'HX-Redirect':'/login'} : {}, contentType:'text/html', body: fault === 'login' ? '<form>Password</form>' : 'Forbidden' }));
    await page.locator('#general-chat-input').fill(`Retry ${fault}`); await page.locator('#general-chat-submit').click();
    await expect(page.locator('[data-chat-error]')).toBeVisible();
    await expect(page.locator('#general-chat-input')).toHaveValue(`Retry ${fault}`);
    await expect(page).toHaveURL(/\/assistant$/);
    await page.unroute('**/htmx/ai-chat');
  }
});

});

test('assistant: bookmarks aliases and offline', async ({ page, context, browserName }) => {
  await enableOffline(page); await waitReady(page);
  const redirect = await context.request.get('/app/catch-me-up', { maxRedirects:0 });
  expect(redirect.status()).toBe(308); expect(redirect.headers()['cache-control']).toBe('no-store');
  expect(redirect.headers().location).toBe('/assistant/catch-up');
  await page.goto('/app/catch-me-up'); await expect(page).toHaveURL(/\/assistant\/catch-up$/);
  await expect(page.locator('#assistant-catch-up')).toBeVisible();
  await page.getByRole('link', { name:'Chat', exact:true }).click();
  await page.goBack(); await expect(page.locator('#assistant-catch-up')).toBeVisible();
  await page.goForward(); await expect(page.locator('#assistant-chat')).toBeVisible();
  // Empty previous profile produces the same real response via both action aliases.
  const opts = { method:'POST', body:'', headers:{'Content-Type':'application/x-www-form-urlencoded'} };
  const legacy = await pageFetch(page, '/settings/ai/revert-preference', opts);
  const canonical = await pageFetch(page, '/assistant/profile/revert', opts);
  expect(legacy.status).toBe(canonical.status); expect(legacy.status).toBe(200); expect(legacy.body).toBe(canonical.body);
  const applied = appliedOps(s.alice.email);
  const abortOffline = route => route.abort('internetdisconnected');
  for (const force of [false,true]) {
    await page.goto('/app'); await waitReady(page);
    if (force) await page.evaluate(() => window.RFOffline.page.current(document).setForceOffline(true));
    else { if (browserName === 'chromium') await context.route('**/*', abortOffline); await context.setOffline(true); }
    const response = await page.goto('/assistant'); expect(response.status()).toBe(503);
    await page.goto('/app'); await expect(page.locator('#article-list')).toBeVisible();
    let posts = 0; const observe = req => { if (req.method() !== 'GET') posts++; }; page.on('request', observe);
    await page.locator('a[href="/assistant"]:visible').first().click({ force:true });
    expect(posts).toBe(0); expect(new URL(page.url()).pathname).toBe('/app'); page.off('request', observe);
    if (force) await page.evaluate(() => window.RFOffline.page.current(document).setForceOffline(false));
    else { await context.setOffline(false); if (browserName === 'chromium') await context.unroute('**/*', abortOffline); }
  }
  expect(appliedOps(s.alice.email)).toEqual(applied);
  await page.goto('/app'); expect(await waitReady(page)).toContain('0 pending');
  // Retry a real local save: service-worker requests deliberately bypass page.route.
  await page.goto('/assistant?section=profile');
  await page.locator('#ai_preference_text').fill('Explicit retry after reconnect');
  await page.getByRole('button', { name:'Save interest profile' }).click(); await settle(page);
  expect(settings().ai_preference_text).toBe('Explicit retry after reconnect');
});
