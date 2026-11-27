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
// Fields, buttons and alerts of the briefing sheet keep an inset from its panel.
async function sheetInset(page) {
  const sheet = page.locator('#rf-briefing-sheet-body');
  const content = sheet.locator('input:visible, select:visible, button:visible, .alert:visible');
  await expect(content.first()).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await settle(page);
    // The sheet slides in; measure once it rests.
    await page.waitForFunction(() => !document.querySelector('#rf-briefing-sheet').getAnimations({ subtree: true }).some(a => a.playState === 'running' && a.effect.getTiming().iterations !== Infinity));
    const gaps = await content.evaluateAll(els => els.map(el => {
      const box = el.getBoundingClientRect();
      const panel = document.querySelector('#rf-briefing-sheet > div').getBoundingClientRect();
      return { tag: el.tagName, name: el.getAttribute('name'), left: box.left - panel.left, right: panel.right - box.right };
    }));
    expect.soft(gaps.filter(g => g.left < 15 || g.right < 15), `briefing sheet inset at ${width}`).toEqual([]);
  }
}
// The sheet body arrives after the dialog opens: the first form control takes focus,
// and Shift+Tab goes around inside the sheet.
async function sheetFocus(page) {
  await expect(page.locator('#briefing-enabled-toggle')).toBeFocused();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab');
    const focus = await page.locator('#rf-briefing-sheet').evaluate(el => ({ inside: el.contains(document.activeElement), tag: document.activeElement?.tagName, id: document.activeElement?.id }));
    expect(focus.inside, JSON.stringify(focus)).toBe(true);
  }
}
// The way into the Assistant from the open article: the sidebar beside it on a
// desktop; on a phone's full-screen article, where no navigation is on screen, the
// article chat.
async function openAssistantFromArticle(page, width, id) {
  const href = `/assistant?article_id=${id}`;
  if (width >= 1000) {
    await page.goto(`/app?open_article_id=${id}`);
    await expect(page.locator('#article-detail article')).toBeVisible();
    await page.locator(`#sidebar a[href="${href}"]:visible`).click();
  } else {
    await page.goto('/app');
    const tab = page.locator('#tab-bar [data-rf-tab="assistant"]');
    await expect(tab).toHaveAttribute('href', '/assistant');
    await page.locator(`#article-row-${id}`).click();
    await expect(page.locator('html')).toHaveClass(/mobile-detail-open/);
    await expect(tab).toHaveAttribute('href', href);
    await page.locator('#article-detail #mobile-detail-back-btn').click();
    await expect(page.locator('html')).not.toHaveClass(/mobile-detail-open/);
    await expect(tab).toHaveAttribute('href', '/assistant');
    await page.locator(`#article-row-${id}`).click();
    await expect(page.locator('html')).toHaveClass(/mobile-detail-open/);
    await expect(tab).toBeHidden();
    await page.locator('#article-detail [data-show-chat-modal]:visible').first().click();
    const link = page.locator(`#chat-modal-${id} [data-rf-assistant-open]`);
    await expect(link).toHaveCount(1);
    await expect(link).toBeInViewport();
    await link.click();
  }
  await expect(page).toHaveURL(new RegExp(`/assistant\\?article_id=${id}$`));
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
    // The phone opens a row still unread from the list: the desktop pass read w1.
    await openAssistantFromArticle(page, width, width >= 1000 ? s.articles.w1.id : s.articles.w2.id);
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
  await opener.click(); await sheetInset(page); await page.keyboard.press('Escape');
  await opener.click(); await expect(page.locator('#rf-briefing-sheet')).toHaveAttribute('open', '');
  await sheetFocus(page);
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
  await sheetFocus(page);
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

// Geometry as first painted: no click, focus or scroll comes before the measurement.
const chatGeometry = page => page.evaluate(() => {
  const box = id => document.getElementById(id).getBoundingClientRect();
  const log = document.getElementById('general-chat-messages');
  return {
    scrollY, innerHeight, pageHeight: document.documentElement.scrollHeight,
    card: box('rf-assistant-chat').toJSON(), send: box('general-chat-submit').toJSON(),
    input: box('general-chat-input').toJSON(),
    log: { client: log.clientHeight, scroll: log.scrollHeight },
  };
});
async function composerOnScreen(page, label) {
  const g = await chatGeometry(page);
  const why = `${label} ${JSON.stringify(g)}`;
  expect.soft(g.scrollY, why).toBe(0);
  expect.soft(g.pageHeight, why).toBeLessThanOrEqual(g.innerHeight + 1);
  expect.soft(g.input.top, why).toBeGreaterThanOrEqual(0);
  expect.soft(g.send.bottom, why).toBeLessThanOrEqual(g.innerHeight);
  expect.soft(g.send.bottom, why).toBeLessThanOrEqual(g.card.bottom);
  expect.soft(g.card.bottom, why).toBeLessThanOrEqual(g.innerHeight);
  expect.soft(g.log.client, why).toBeGreaterThanOrEqual(24);
}

test('assistant: phone composer is above the fold', async ({ page }) => {
  test.setTimeout(150_000);
  // 390x664 is Safari with its toolbars; the other two are the full screens.
  const sizes = [[390, 844], [440, 956], [390, 664]];
  const states = [
    ['general', '/assistant'],
    ['article', `/assistant?article_id=${s.articles.w1.id}`],
    ['unavailable article', '/assistant?article_id=999999999'],
    ['missing provider', '/assistant', 'ai_quality_model=NULL'],
  ];
  await page.route('**/htmx/ai-chat', route => route.fulfill({ status: 503, body: 'Fixture unavailable' }));
  for (const [state, url, values] of states) {
    configure(); if (values) configure(values);
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
      await composerOnScreen(page, `${state} ${width}x${height}`);
    }
  }
  configure();
  // The tightest case: a notice above the card, a long thread and a failed send in it.
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/assistant?article_id=999999999');
  await page.locator('#general-chat-input').fill('Fails');
  await page.locator('#general-chat-submit').click();
  await expect(page.locator('[data-chat-error]')).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('general-chat-messages').innerHTML = Array.from({ length: 30 }, (_, i) =>
      `<div class="rf-assistant-message" data-role="assistant">Message ${i} of a long conversation</div>`).join('');
    scrollTo(0, 0);
  });
  await composerOnScreen(page, 'long conversation with error 390x664');
  const long = await chatGeometry(page);
  expect(long.log.scroll, 'the thread scrolls inside the card').toBeGreaterThan(long.log.client + 100);
  // The phone keyboard shrinks only the visual viewport, which assistant.js reports in
  // --rf-assistant-viewport-height. A real reply (stubbed provider response through the
  // real htmx swap and settle) keeps the cap and the composer: the card stays within
  // the visual viewport, composer included. Playwright cannot open a keyboard, so the
  // visual viewport's height is reduced in the page and its resize event fired.
  // The server answers with the whole chat area, so each height gets its own reply text.
  const replies = { 450: chatHTML('Fixture reply at 450'), 330: chatHTML('Fixture reply at 330') };
  let reply = null;
  await page.unroute('**/htmx/ai-chat');
  await page.route('**/htmx/ai-chat', route => route.fulfill({ contentType: 'text/html', body: reply }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/assistant');
  const cap = () => page.locator('#rf-assistant-chat').evaluate(el => el.style.getPropertyValue('--rf-assistant-viewport-height'));
  for (const visible of [450, 330]) {
    await page.evaluate(h => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => h });
      window.visualViewport.dispatchEvent(new Event('resize'));
    }, visible);
    await expect.poll(cap).toBe(`${visible}px`);
    reply = replies[visible];
    await page.locator('#general-chat-input').fill(`Question at ${visible}`);
    await page.locator('#general-chat-submit').click();
    await expect(page.locator('#general-chat-messages').getByText(`Fixture reply at ${visible}`)).toHaveCount(1);
    await settle(page);
    await expect.poll(cap, `cap after the reply at ${visible}`).toBe(`${visible}px`);
    await expect(page.locator('#general-chat-input')).toBeVisible();
    const g = await chatGeometry(page);
    const why = `keyboard ${visible} after a reply ${JSON.stringify(g)}`;
    expect.soft(g.card.height, why).toBeLessThanOrEqual(visible);
    expect.soft(g.send.bottom, why).toBeLessThanOrEqual(g.card.bottom);
    expect.soft(g.input.top, why).toBeGreaterThanOrEqual(g.card.top);
    expect.soft(g.log.client, why).toBeGreaterThanOrEqual(0);
  }
});

test('assistant: phone section row stays on one line', async ({ page }) => {
  const row = () => page.getByRole('navigation', { name: 'Assistant sections' }).evaluate(nav => {
    const links = [...nav.querySelectorAll('a')].map(a => a.getBoundingClientRect());
    const box = nav.getBoundingClientRect();
    return { tops: links.map(l => Math.round(l.top)), heights: links.map(l => Math.round(l.height)),
      last: links.at(-1).right, right: box.right, left: box.left, scroll: nav.scrollWidth, client: nav.clientWidth,
      page: document.documentElement.scrollWidth, width: innerWidth, wrap: getComputedStyle(nav).flexWrap,
      font: getComputedStyle(nav).fontSize, root: getComputedStyle(document.body).fontSize };
  });
  for (const url of ['/assistant', '/assistant/catch-up', '/assistant?section=profile']) {
    for (const width of [390, 440, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(url);
      const r = await row();
      const why = `${url} ${width} ${JSON.stringify(r)}`;
      expect.soft(new Set(r.tops).size, why).toBe(1);
      expect.soft(Math.max(...r.heights), `no label wraps: ${why}`).toBeLessThan(2 * parseFloat(r.font) + 4);
      expect.soft(r.right, why).toBeLessThanOrEqual(r.width);
      if (url === '/assistant') expect.soft(r.page, why).toBeLessThanOrEqual(r.width);
      if (width >= 390) {
        expect.soft(r.last, why).toBeLessThanOrEqual(r.right + 0.5);
        expect.soft(r.scroll, why).toBeLessThanOrEqual(r.client);
      } else {
        // Narrower: the row itself scrolls to its last link.
        const last = page.getByRole('link', { name: 'Interest profile' });
        await last.evaluate(a => a.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        const after = await row();
        expect.soft(after.last, `${why} ${JSON.stringify(after)}`).toBeLessThanOrEqual(after.right + 0.5);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto('/assistant');
  const desktop = await row();
  expect(desktop.wrap).toBe('wrap');
  expect(desktop.font).toBe(desktop.root);
});

test('assistant: setup notices say it once with one settings link', async ({ page }) => {
  // Chat notices link "Open AI provider settings" (their text may also name the page); Catch me up's
  // sentences end "… in AI provider settings", which is the link. Count the link text.
  const once = async (alert, label, link = 'Open AI provider settings') => {
    const text = (await alert.innerText()).replace(/\s+/g, ' ');
    expect.soft(text.split(link).length - 1, `${label}: ${text}`).toBe(1);
    await expect.soft(alert.getByRole('link'), label).toHaveCount(1);
    await expect.soft(alert.getByRole('link'), label).toHaveText(link);
    await expect.soft(alert.getByRole('link'), label).toHaveAttribute('href', '/settings/ai');
  };
  // The notice and whatever sits beside it in its section: no second link outside it.
  const settingsLinks = id => page.locator(`${id} a[href="/settings/ai"]:visible`);
  for (const values of [
    'ai_quality_model=NULL',
    "ai_quality_provider='anthropic', ai_quality_model='fixture'",
    "ai_quality_provider='custom', ai_custom_base_url=NULL",
    "ai_custom_base_url='http://127.0.0.1:4252/never-ai', ai_chat_enabled=false",
  ]) {
    configure(values); await page.goto('/assistant');
    await once(page.locator('#assistant-chat .alert'), values);
    await expect.soft(settingsLinks('#assistant-chat'), values).toHaveCount(1);
  }
  configure('ai_quality_provider=NULL, ai_quality_model=NULL, ai_fast_provider=NULL');
  await page.goto('/assistant/catch-up');
  await once(page.locator('#assistant-catch-up > .alert'), 'catch-up without a provider', 'AI provider settings');
  await expect.soft(settingsLinks('#assistant-catch-up')).toHaveCount(1);
  configure("ai_quality_provider=NULL, ai_quality_model=NULL, ai_fast_provider='custom'");
  await page.goto('/assistant/catch-up');
  await once(page.locator('#assistant-catch-up > .alert'), 'catch-up without a main model', 'AI provider settings');
  await expect.soft(settingsLinks('#assistant-catch-up')).toHaveCount(1);
  db(`        await c.execute(text("update app_settings set ai_enabled=false where id=1"))
        print('null')`);
  await page.goto('/assistant');
  await expect(page.locator('#assistant-chat .alert')).toContainText('Contact your administrator');
  // Nothing in the reader's settings fixes this one.
  await expect(settingsLinks('#assistant-chat')).toHaveCount(0);
  db(`        await c.execute(text("update app_settings set ai_enabled=true where id=1"))
        print('null')`);
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
  await sheetInset(page);
  await page.keyboard.press('Escape');
  await opener.evaluate(el => { el.dataset.configId = '2147483646'; }); await opener.click();
  await expect(page.locator('#rf-briefing-sheet-body [role=alert]')).toBeVisible();
  await expect(page.locator('#rf-briefing-sheet-body')).not.toContainText('Password');
  await page.keyboard.press('Escape');
  await page.goto('/assistant?article_id=999999999');
  await expect(page.locator('#assistant-chat')).toContainText('This article is unavailable');
  await expect(page.locator('#assistant-chat-scope')).toBeEnabled();
  await expect(page.locator('#assistant-chat-scope option')).toHaveCount(1);
  await expect(page.locator('#general-chat-submit')).toBeEnabled();
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
  // With an article on screen the links carry it, and stay as unusable offline.
  await page.goto('/app'); await waitReady(page);
  await page.evaluate(() => window.RFOffline.page.current(document).setForceOffline(true));
  await page.locator('#article-list .article-row').first().click();
  await expect(page.locator('#article-detail article')).toBeVisible();
  await expect(page.locator('[data-rf-assistant-open][href^="/assistant?article_id="][aria-disabled="true"]')).toHaveCount(1);
  await expect(page.locator('a[href^="/assistant?article_id="]:not([aria-disabled="true"])')).toHaveCount(0);
  await page.locator('#sidebar a[href^="/assistant?article_id="]:visible').click({ force:true });
  expect(new URL(page.url()).pathname).toBe('/app');
  await page.evaluate(() => window.RFOffline.page.current(document).setForceOffline(false));
});
