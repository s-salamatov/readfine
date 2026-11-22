// The reader shell end to end (s3-T11, design §6): the command palette, the account
// menu's theme items, the phone tab bar with the sidebar sheet, toasts under the nonce
// CSP, and the palette offline. Delayed-delete flows on real rows come with s5; here the
// Undo toast runs on a row injected into the page.
// Screenshots go to the test's output folder (test-results/), attached to the report.
import { test, expect } from '@playwright/test';
import { seed, login, enableOffline, waitReady } from './helpers.mjs';

let s;
test.beforeEach(() => { s = seed(); });

const palette = (page) => page.locator('#rf-palette');
const paletteInput = (page) => page.locator('#rf-palette-input');
const results = (page) => page.locator('#rf-palette-results');
const paletteItem = (page, name) => palette(page).getByRole('menuitem', { name, exact: true });

async function shot(page, testInfo, name) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

// Every securitypolicyviolation of the page, from the first script on.
async function collectCsp(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
}

test('palette: ⌘K opens, a search finds an article and opens it; an action runs (app theme)', async ({ page }, testInfo) => {
  await collectCsp(page);
  await login(page, s.alice.email, s.password);
  await page.goto('/app');

  // ⌘K (Meta) opens it with focus in the input; Escape closes it again.
  await page.locator('body').press('Meta+k');
  await expect(palette(page)).toHaveJSProperty('open', true);
  await expect(paletteInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveJSProperty('open', false);

  // Ctrl+K too; a server match opens the article (a full page load).
  await page.locator('body').press('Control+k');
  await expect(palette(page)).toHaveJSProperty('open', true);
  await paletteInput(page).fill('kestrel sighted');
  const hit = results(page).getByRole('menuitem', { name: s.articles.w1.title, exact: true });
  await expect(hit).toBeVisible();
  await expect(hit).toHaveAttribute('href', `/app?open_article_id=${s.articles.w1.id}`);
  await shot(page, testInfo, 'palette-results');
  await Promise.all([page.waitForURL(new RegExp(`open_article_id=${s.articles.w1.id}`)), hit.click()]);
  await expect(page.locator('#article-detail')).toContainText(s.articles.w1.title);

  // Escape closes only the palette: the open article stays.
  await page.locator('body').press('Control+k');
  await expect(palette(page)).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveJSProperty('open', false);
  await expect(page.locator('#article-detail')).toContainText(s.articles.w1.title);
  await expect(page).toHaveURL(new RegExp(`open_article_id=${s.articles.w1.id}`));

  // "Keyboard shortcuts" opens the dialog with focus inside it.
  await page.locator('body').press('Control+k');
  await paletteInput(page).fill('keyboard');
  await paletteItem(page, 'Keyboard shortcuts').click();
  const dlg = page.locator('#shortcuts-dialog');
  await expect(dlg).toHaveJSProperty('open', true);
  await expect(palette(page)).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => !!document.activeElement?.closest('#shortcuts-dialog'))).toBe(true);
  await shot(page, testInfo, 'shortcuts-dialog');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveJSProperty('open', false);

  // An action: App theme: Graphite.
  await page.locator('body').press('Control+k');
  await paletteInput(page).fill('graphite');
  await paletteItem(page, 'App theme: Graphite').click();
  await expect(page.locator('html')).toHaveAttribute('data-rf-theme', 'graphite');
  await expect(palette(page)).toHaveJSProperty('open', false);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('palette: no results and a forced server error show their states', async ({ page }) => {
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  // The sidebar's search entry opens the palette.
  await page.locator('#sidebar-full [data-action="open-search"]').first().click();
  await expect(palette(page)).toHaveJSProperty('open', true);

  await paletteInput(page).fill('qqzzxxnothing');
  await expect(results(page).locator('[data-rf-palette-state="empty"]'))
    .toHaveText('No articles, saved searches or feeds match.');

  let hits = 0;
  await page.route('**/htmx/palette*', (r) => { hits++; return r.fulfill({ status: 500, body: 'boom' }); });
  await paletteInput(page).fill('kestrel');
  await expect(results(page).locator('[data-rf-palette-state="error"]')).toHaveText('Search failed. Try again.');
  expect(hits, 'the forced 500 was served').toBeGreaterThan(0);
  // A state is never a menu item, and Advanced search… stays offered.
  await expect(results(page).getByRole('menuitem')).toHaveCount(0);
  await expect(paletteItem(page, 'Advanced search…')).toBeVisible();
});

test('account menu: scheme and app theme persist across reload', async ({ page }, testInfo) => {
  // A short viewport: the menu opens upward from the footer and must not be cut.
  await page.setViewportSize({ width: 1280, height: 700 });
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const trigger = page.locator('#account-menu-trigger');
  const pop = page.locator('#account-menu-popover');

  await trigger.click();
  await expect(pop).toBeVisible();
  await page.waitForTimeout(300); // the popover's fade-in
  await shot(page, testInfo, 'account-menu-1280x700');
  // Inside the viewport, and every inset corner hits the popover itself, so nothing
  // clips it (the 240 px sidebar has overflow-x hidden).
  const fit = await pop.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const corners = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]];
    return {
      rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
      vw: innerWidth, vh: innerHeight,
      hits: corners.map(([x, y]) => el.contains(document.elementFromPoint(x, y))),
    };
  });
  expect(fit.rect.top, JSON.stringify(fit)).toBeGreaterThanOrEqual(0);
  expect(fit.rect.left).toBeGreaterThanOrEqual(0);
  expect(fit.rect.right).toBeLessThanOrEqual(fit.vw);
  expect(fit.rect.bottom).toBeLessThanOrEqual(fit.vh);
  expect(fit.rect.width).toBeGreaterThanOrEqual(224); // min-width 14rem
  expect(fit.hits, JSON.stringify(fit)).toEqual([true, true, true, true]);

  await pop.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  // A closed popover is aria-hidden (out of the role tree) but may still be fading out.
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await pop.getByRole('menuitemradio', { name: 'Paper', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-rf-theme', 'paper');

  await page.reload();
  const html = page.locator('html');
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).toHaveAttribute('data-rf-theme', 'paper');
  await trigger.click();
  await expect(pop.getByRole('menuitemradio', { name: 'Dark', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(pop.getByRole('menuitemradio', { name: 'Paper', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(pop.getByRole('menuitemradio', { name: 'Light', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.waitForTimeout(300);
  await shot(page, testInfo, 'account-menu-paper-dark');
  // theme-color is the theme's --background, read the way init.js reads it.
  const colours = await page.evaluate(() => ({
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
    token: getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
    body: getComputedStyle(document.body).backgroundColor,
  }));
  const expected = /^#[0-9a-f]{3,8}$/i.test(colours.token) || /^rgba?\(/i.test(colours.token) ? colours.token : colours.body;
  expect(colours.meta, JSON.stringify(colours)).toBe(expected);
  expect(colours.meta).not.toBe('');
});

test('phone: tab bar at 390 — Folders opens the sheet with focus inside, Search opens the palette, Feed returns to All articles', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const bar = page.getByRole('navigation', { name: 'Main' });
  await expect(bar).toBeVisible();
  const tabs = bar.locator('.tab-bar-item');
  await expect(tabs).toHaveText(['Feed', 'Search', 'Add', 'Assistant', 'Folders']);
  const tab = (name) => tabs.filter({ hasText: name });
  await expect(tab('Feed')).toHaveAttribute('aria-current', 'page');
  const list = page.locator('#article-list');
  await expect(list).toContainText(s.articles.w1.title);

  // Search opens the palette.
  await tab('Search').click();
  await expect(palette(page)).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveJSProperty('open', false);

  // Folders: the sheet, focus on its first row, panes inert; bar > sheet > backdrop.
  await tab('Folders').click();
  await expect(page.locator('html')).toHaveClass(/mobile-sidebar-open/);
  await expect(tab('Folders')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar-full .nav-item'))).toBe(true);
  await expect(list).toHaveAttribute('inert', '');
  await page.waitForTimeout(300); // the sheet's 200 ms slide
  await shot(page, testInfo, 'phone-sheet-open');
  const stack = await page.evaluate(() => {
    const z = (id) => Number(getComputedStyle(document.getElementById(id)).zIndex);
    const at = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('#tab-bar') ? 'bar' : el?.closest('#sidebar') ? 'sheet' : el?.closest('#mobile-sidebar-backdrop') ? 'backdrop' : el?.id || el?.tagName;
    };
    const bar = document.getElementById('tab-bar').getBoundingClientRect();
    const sheet = document.getElementById('sidebar').getBoundingClientRect();
    return {
      z: { bar: z('tab-bar'), sheet: z('sidebar'), backdrop: z('mobile-sidebar-backdrop') },
      hit: { bar: at(30, bar.top + bar.height / 2), sheet: at(sheet.left + 40, sheet.top + 120), backdrop: at(innerWidth - 20, innerHeight / 3) },
    };
  });
  expect(stack.z.bar, JSON.stringify(stack)).toBeGreaterThan(stack.z.sheet);
  expect(stack.z.sheet).toBeGreaterThan(stack.z.backdrop);
  expect(stack.hit, JSON.stringify(stack)).toEqual({ bar: 'bar', sheet: 'sheet', backdrop: 'backdrop' });

  // Rows by keyboard: Down to Starred, Enter opens it and closes the sheet.
  const focusedText = () => page.evaluate(() => document.activeElement?.querySelector('span.flex-1')?.textContent.trim() || '');
  for (let i = 0; i < 8 && (await focusedText()) !== 'Starred'; i++) await page.keyboard.press('ArrowDown');
  expect(await focusedText()).toBe('Starred');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).not.toHaveClass(/mobile-sidebar-open/);
  await expect(list).toContainText(s.articles.g3.title);
  await expect(list).not.toContainText(s.articles.w1.title);
  await expect(list).not.toHaveAttribute('inert', '');

  // Space on a feed row of the Folders section.
  await tab('Folders').click();
  await expect(page.locator('html')).toHaveClass(/mobile-sidebar-open/);
  for (let i = 0; i < 20 && (await focusedText()) !== 'Local Ledger'; i++) await page.keyboard.press('ArrowDown');
  expect(await focusedText()).toBe('Local Ledger');
  await page.keyboard.press(' ');
  await expect(page.locator('html')).not.toHaveClass(/mobile-sidebar-open/);
  await expect(list).toContainText(s.articles.l1.title);
  await expect(list).not.toContainText(s.articles.w1.title);

  // Feed, with the sheet open, returns to All articles.
  await tab('Folders').click();
  await expect(page.locator('html')).toHaveClass(/mobile-sidebar-open/);
  await tab('Feed').click();
  await expect(page.locator('html')).not.toHaveClass(/mobile-sidebar-open/);
  await expect(list).toContainText(s.articles.w1.title);
  await expect(tab('Feed')).toHaveAttribute('aria-current', 'page');
});

test('toasts: an HX-Trigger notice and an Undo toast raise no securitypolicyviolation', async ({ page }, testInfo) => {
  await collectCsp(page);
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const toaster = page.locator('#toaster');

  // A server notice: the saved search's delete answers HX-Trigger showToast.
  await page.evaluate((id) => window.htmx.ajax('POST', `/htmx/saved-searches/${id}/delete`, { swap: 'none' }), s.savedSearch);
  await expect(toaster.locator('.toast').filter({ hasText: 'Deleted “Kestrel”' })).toBeVisible();

  // An RFToast with an action: the footer button runs it and closes the toast.
  await page.evaluate(() => {
    window.__undone = 0;
    window.RFToast.show({ msg: 'Shell e2e action toast', action: { label: 'Undo', onClick: () => { window.__undone++; } }, duration: -1 });
  });
  const actionToast = toaster.locator('.toast').filter({ hasText: 'Shell e2e action toast' });
  await expect(actionToast).toBeVisible();
  await expect(actionToast.locator('[onclick]')).toHaveCount(0);
  await actionToast.getByRole('button', { name: 'Undo' }).click();
  expect(await page.evaluate(() => window.__undone)).toBe(1);
  await expect(actionToast).toBeHidden();

  // The delayed delete: a row of the label hides at once, Undo brings it back and
  // nothing reaches the batch route.
  const posts = [];
  page.on('request', (r) => { if (r.url().includes('/settings/deletes')) posts.push(r.method()); });
  await page.evaluate((id) => {
    const row = document.createElement('div');
    row.id = 'shell-e2e-row';
    row.textContent = 'Later (label row)';
    row.setAttribute('data-rf-delete-key', `label:${id}`);
    document.getElementById('article-list').prepend(row);
    window.RFPending.schedule({ kind: 'label', id, label: 'Later' });
  }, s.labels.later);
  const row = page.locator('#shell-e2e-row');
  await expect(row).toBeHidden();
  const undoToast = toaster.locator('.toast').filter({ hasText: 'Later' });
  await expect(undoToast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await shot(page, testInfo, 'undo-toast');
  await undoToast.getByRole('button', { name: 'Undo' }).click();
  await expect(row).toBeVisible();
  expect(await page.evaluate((id) => window.RFPending.state(`label:${id}`), s.labels.later)).toBeUndefined();
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);

  expect(await page.evaluate(() => window.__csp)).toEqual([]);
});

test('palette offline: server search says it needs a connection; Advanced search… opens the offline search', async ({ page, context }) => {
  await login(page, s.alice.email, s.password);
  await enableOffline(page);
  await waitReady(page);
  // Chromium's offline emulation leaves the worker's own requests online: abort them too.
  await context.route('**/*', (r) => r.abort('internetdisconnected'));
  await context.setOffline(true);

  await page.locator('body').press('Control+k');
  await expect(palette(page)).toHaveJSProperty('open', true);
  await paletteInput(page).fill('zephyrine');
  await expect(results(page).locator('[data-rf-palette-state="offline"]'))
    .toHaveText('Search needs a connection. Advanced search works offline.');

  await paletteItem(page, 'Advanced search…').click();
  await expect(palette(page)).toHaveJSProperty('open', false);
  await expect(page.locator('#search-modal-overlay')).toBeVisible();
  await expect(page.locator('#search-input')).toHaveValue('zephyrine');

  await context.setOffline(false);
  await context.unroute('**/*');
});
