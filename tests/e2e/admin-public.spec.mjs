// Admin and public pages acceptance (s8): public pages without the app's scripts, the
// legal pages on a phone and on paper, the traffic chart's contrast, the admin
// behaviour module and a stale tab posting to a removed alias. Only the local app and
// its fixture server are used.
import { test, expect } from '@playwright/test';
import { seed, login, setRole, seedTraffic } from './helpers.mjs';
import { APP_ORIGIN } from './env.mjs';
import { requireE2eDatabaseUrl } from './db-guard.mjs';

// Fail at collection, before any seed or helper can mutate the database.
requireE2eDatabaseUrl();

const STALE = 'This page is out of date. Reload it and try again.';
const PUBLIC = ['/features', '/changelog', '/help', '/privacy', '/terms'];
const ADMIN = ['/admin', '/admin/traffic', '/admin/scoring-eval', '/admin/users', '/admin/invitations',
  '/admin/audit-log', '/admin/fetch-logs', '/admin/feeds', '/admin/settings'];
const THEMES = ['neutral', 'paper', 'graphite'];

let s;
const csp = new WeakMap();
const externalRequests = new WeakMap();
const toasts = page => page.locator('#toaster .toast');

// CSP violations and requests leaving the loopback host, per page.
async function audit(page) {
  csp.set(page, []);
  externalRequests.set(page, []);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.get(page).push(url.href);
  });
  await page.exposeFunction('recordAdminPublicCsp', value => csp.get(page).push(value));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => window.recordAdminPublicCsp(`${e.violatedDirective} ${e.blockedURI}`)));
}

async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('.htmx-request,.htmx-swapping,.htmx-settling'));
}

// Saves the admin settings form as it stands after `change` (the page's own POST with
// the double-submit header). The app reads the traffic flag into its process here.
async function saveAdminSettings(page, change) {
  await page.goto('/admin/settings');
  const status = await page.evaluate(async (change) => {
    const form = document.querySelector('form[action="/admin/settings"]');
    for (const [name, on] of Object.entries(change)) form.querySelector(`input[name="${name}"]`).checked = on;
    const token = document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.split('=')[1];
    const r = await fetch('/admin/settings', { method: 'POST', body: new FormData(form), headers: { 'x-csrftoken': token || '' } });
    return r.status;
  }, change);
  expect(status).toBe(200);
}

// Colours resolved by the browser itself: each layer is painted on a canvas over white
// paper (or the layers below it) and the pixel read back, so oklch, color-mix and alpha
// all come out as the sRGB the screen shows.
async function paint(page, layers) {
  return page.evaluate((layers) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 1, 1);
    for (const colour of layers) { g.fillStyle = colour; g.fillRect(0, 0, 1, 1); }
    return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, layers);
}

function luminance([r, g, b]) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The layers of a computed box-shadow that paint anything: a layer with a transparent
// colour, or with every length zero, draws nothing.
function visibleShadows(value) {
  if (value === 'none') return [];
  const layers = value.split(/,(?![^(]*\))/).map(l => l.trim());
  return layers.filter((layer) => {
    const colour = layer.match(/(rgba?|oklch|oklab|color)\([^)]*\)|transparent/)?.[0] || '';
    if (colour === 'transparent' || /,\s*0\)$|\/\s*0\)$/.test(colour)) return false;
    const lengths = layer.replace(colour, '').match(/-?[\d.]+px/g) || [];
    return lengths.some(v => parseFloat(v) !== 0);
  });
}

// The background colours under `selector`, outermost first (what paint() stacks).
async function backgrounds(page, selector) {
  return page.locator(selector).first().evaluate((el) => {
    const out = [];
    for (let n = el; n; n = n.parentElement) out.unshift(getComputedStyle(n).backgroundColor);
    return out;
  });
}

test.beforeEach(async ({ page }) => {
  s = seed();
  await audit(page);
});

test.afterEach(async ({ page }) => {
  expect(csp.get(page)).toEqual([]);
  expect(externalRequests.get(page)).toEqual([]);
});

test('public: signed-out pages without app scripts, also with JavaScript off', async ({ page, browser }) => {
  for (const url of PUBLIC) {
    const scripts = [];
    const onRequest = r => { if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname); };
    page.on('request', onRequest);
    const response = await page.goto(url);
    expect(response.status(), url).toBe(200);
    await page.waitForLoadState('networkidle');
    page.off('request', onRequest);
    expect(scripts, url).toEqual(['/static/js/init.js']);
    await expect(page.locator('h1').first(), url).toBeVisible();
  }

  const off = await browser.newContext({ baseURL: APP_ORIGIN, javaScriptEnabled: false, serviceWorkers: 'block' });
  try {
    const plain = await off.newPage();
    await audit(plain);
    for (const url of PUBLIC) {
      await plain.goto(url);
      await expect(plain.locator('h1').first(), url).toBeVisible();
      const last = plain.locator('main :is(section, h2, h3)').last();
      await last.scrollIntoViewIfNeeded();
      await expect(last, url).toBeVisible();
    }
    expect(externalRequests.get(plain)).toEqual([]);
  } finally {
    await off.close();
  }
});

test('legal: phone scroll and print', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/privacy');
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);

  const footer = page.locator('footer').last();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(footer).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  const scroller = page.locator('main .rf-scroll-x').first();
  const onScreen = await scroller.evaluate(el => ({
    scrolls: el.scrollWidth > el.clientWidth, image: getComputedStyle(el).backgroundImage,
  }));
  expect(onScreen.scrolls).toBe(true);
  expect(onScreen.image).not.toBe('none');

  // Printed from the dark screen, without a reload: plain dark text on paper.
  await page.emulateMedia({ media: 'print', colorScheme: 'dark' });
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await expect(page.locator('header').first()).toBeHidden();
  await expect(footer).toBeHidden();
  const text = 'main section p';
  const paper = await paint(page, await backgrounds(page, text));
  const ink = await paint(page, [...await backgrounds(page, text),
    await page.locator(text).first().evaluate(el => getComputedStyle(el).color)]);
  expect(luminance(paper)).toBeGreaterThan(0.5);
  expect(contrast(ink, paper)).toBeGreaterThanOrEqual(4.5);
  // The table is not cut off on paper and carries no scroll shades; the card has no
  // ring or shadow.
  const printed = await scroller.evaluate(el => ({
    clipped: el.scrollWidth > el.clientWidth + 1, image: getComputedStyle(el).backgroundImage,
    overflow: getComputedStyle(el).overflowX,
  }));
  expect(printed).toEqual({ clipped: false, image: 'none', overflow: 'visible' });
  const shadow = await page.locator('main .card').first().evaluate(el => getComputedStyle(el).boxShadow);
  expect(visibleShadows(shadow), shadow).toEqual([]);
});

test('admin: traffic chart readable in dark mode', async ({ page }, testInfo) => {
  setRole(s.alice.email, 'admin');
  seedTraffic(true);
  try {
    await login(page, s.alice.email, s.password);
    await saveAdminSettings(page, { traffic_stats_enabled: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const theme of THEMES) {
      await page.evaluate((t) => { localStorage.setItem('appTheme', t); localStorage.setItem('colorScheme', 'system'); }, theme);
      await page.goto('/admin/traffic');
      expect(await page.evaluate(() => [document.documentElement.classList.contains('dark'), document.documentElement.dataset.rfTheme]))
        .toEqual([true, theme]);
      const bar = '#traffic-bars button:last-of-type';
      await expect(page.locator(bar)).toBeVisible();
      const under = await backgrounds(page, '#traffic-bars');
      const card = await paint(page, under);
      const series = async (n) => paint(page, [...under,
        await page.locator(`${bar} span:nth-child(${n})`).evaluate(el => getComputedStyle(el).backgroundColor)]);
      const visitors = await series(1);
      const views = await series(2);
      expect(contrast(visitors, card), `${theme} visitors`).toBeGreaterThanOrEqual(3);
      expect(contrast(views, card), `${theme} views`).toBeGreaterThanOrEqual(3);
      expect(contrast(visitors, views), `${theme} visitors/views`).toBeGreaterThanOrEqual(1.5);
      await page.locator('#traffic-bars').screenshot({ path: testInfo.outputPath(`traffic-${theme}-dark.png`) });
    }
  } finally {
    await saveAdminSettings(page, { traffic_stats_enabled: false }).catch(() => {});
    seedTraffic(false);
  }
});

test('admin: grouping, dialogs, switches and chart keys behave as before', async ({ page }) => {
  setRole(s.alice.email, 'admin');
  seedTraffic(true);
  try {
    await login(page, s.alice.email, s.password);
    await saveAdminSettings(page, { traffic_stats_enabled: true });

    // By host is kept per device and restored after a reload.
    await page.goto('/admin/feeds');
    await page.locator('button[data-feeds-group="host"]').click();
    await expect(page.locator('#feeds-table')).toHaveAttribute('data-group-mode', 'host');
    await page.reload();
    await expect(page.locator('#feeds-table')).toHaveAttribute('data-group-mode', 'host');
    await expect(page.locator('button[data-feeds-group="host"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('button[data-feeds-group="az"]')).toHaveAttribute('aria-pressed', 'false');

    // The feeds dialogs close on a backdrop click (one rule in ui/admin.js for both).
    // The Rate limits trigger renders only once the fetcher has learned a spacing, an
    // in-process state the seed cannot reach, so the feed-edit dialog stands in for it.
    await page.locator('#feeds-table [data-menu-toggle]').first().click();
    await page.locator('#feeds-table [data-rf-open="feed-edit-overlay"]:visible').first().click();
    const dialog = page.locator('#feed-edit-overlay');
    await expect(dialog).toHaveJSProperty('open', true);
    await expect(page.locator('#feed-edit-content')).not.toBeEmpty();
    await settle(page);
    await page.mouse.click(4, 4);
    await expect(dialog).toHaveJSProperty('open', false);

    // The registration switch shows and hides the legal section (nothing is saved).
    await page.goto('/admin/settings');
    const legal = page.locator('#legal-section');
    const box = page.locator('#registration_enabled');
    const was = await box.isChecked();
    await expect(legal).toBeVisible({ visible: was });
    await box.click();
    await expect(legal).toBeVisible({ visible: !was });
    await box.click();
    await expect(legal).toBeVisible({ visible: was });

    // Arrow keys walk the chart and the readout follows.
    await page.goto('/admin/traffic');
    const last = page.locator('#traffic-bars button').last();
    const readout = page.locator('#traffic-readout');
    const lastText = await last.getAttribute('data-readout');
    await last.focus();
    await page.keyboard.press('ArrowLeft');
    const previous = await page.locator('#traffic-bars button').nth(-2).getAttribute('data-readout');
    await expect(readout).toHaveText(previous);
    await page.keyboard.press('ArrowRight');
    await expect(readout).toHaveText(lastText);

    // At phone width no admin page scrolls sideways, and the nav opens and navigates.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of ADMIN) {
      await page.goto(url);
      await settle(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), url).toBe(true);
    }
    await page.goto('/admin');
    await page.locator('[data-rf-open="admin-nav"]').click();
    const nav = page.locator('#admin-nav');
    const link = nav.locator('a[href="/admin/users"]');
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/admin\/users$/);
    await expect(page.locator('h1').first()).toBeVisible();
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
    await saveAdminSettings(page, { traffic_stats_enabled: false }).catch(() => {});
    seedTraffic(false);
  }
});

test('stale tab: a post to a removed alias says the page is out of date', async ({ page }) => {
  await login(page, s.alice.email, s.password);
  const reading = async () => {
    await page.goto('/settings/reading');
    return page.locator('input[name="articles_per_page"]').inputValue();
  };
  const perPage = await reading();
  expect(perPage).not.toBe('77');

  await page.goto('/sources');
  await settle(page);
  const stale = toasts(page).filter({ hasText: STALE });
  await page.evaluate(() => window.htmx.ajax('POST', '/settings/folders',
    { source: document.body, swap: 'none', values: { name: 'Stale folder' } }));
  await expect(stale).toHaveCount(1);

  // A form from a tab opened before the move, boosted like the old page's.
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/settings/preferences';
    form.setAttribute('hx-boost', 'true');
    form.id = 'stale-form';
    for (const [name, value] of [['articles_per_page', '77'], ['timezone', 'UTC'], ['mark_read_on_scroll', 'on']]) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Save';
    form.append(submit);
    document.body.append(form);
    window.htmx.process(form);
  });
  await page.locator('#stale-form button').click();
  await expect(stale).toHaveCount(2);
  await expect(toasts(page).filter({ hasText: 'That did not go through' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/sources');

  await page.reload();
  await expect(page.locator('#feeds-list')).not.toContainText('Stale folder');
  expect(await reading()).toBe(perPage);

  await page.goto('/settings/feeds?x=1');
  await expect(page).toHaveURL(/\/sources\?x=1$/);
});
