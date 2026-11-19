// Shared steps for the offline e2e specs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { APP_ENV, APP_ORIGIN, BACKEND, SEED_OUT, WORK } from './env.mjs';

const SEED = '../tests/e2e/fixtures/seed.py';

function py(args) {
  return execFileSync('uv', ['run', 'python', SEED, ...args], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8',
  });
}

// Resets and re-creates the fixture accounts; returns ids, emails and tokens.
export function seed() {
  fs.mkdirSync(WORK, { recursive: true });
  py(['seed', '--out', SEED_OUT]);
  return JSON.parse(fs.readFileSync(SEED_OUT, 'utf8'));
}

export function aiJobs(articleId) { return JSON.parse(py(['ai-jobs', String(articleId)])); }
export function appliedOps(email) { return JSON.parse(py(['applied-ops', email])); }
export function userExists(email) { return JSON.parse(py(['user-exists', email])).exists; }

export async function login(page, email, password) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await Promise.all([page.waitForURL(/\/app/), page.click('form[data-rf-login] button[type=submit]')]);
}

// The worker script URL controlling the page ('' when none).
export async function controllerUrl(page) {
  return page.evaluate(() => (navigator.serviceWorker.controller || {}).scriptURL || '');
}

export async function registrationUrls(page) {
  return page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/');
    if (!r) return null;
    const u = (w) => (w ? w.scriptURL : null);
    return { active: u(r.active), waiting: u(r.waiting), installing: u(r.installing) };
  });
}

// Settings → Preferences: switch offline mode on and wait for the flagged worker.
export async function enableOffline(page) {
  await page.goto('/settings/preferences');
  const box = page.locator('[data-rf-offline-toggle]');
  await expect(box).toBeEnabled();
  await box.check();
  await expect(page.locator('[data-rf-offline-note]')).toContainText('On.');
  // The flagged worker is active by the time the switch reports back (sw-register.js
  // waits for it; before that fix Chrome could leave it waiting here).
  expect((await registrationUrls(page))?.active || '').toMatch(/\/sw\.js\?offline=1$/);
}

// Back on /app: the status line says Ready, images are done, and the page is
// controlled by the flagged worker.
export async function waitReady(page) {
  if (!/\/app/.test(page.url())) await page.goto('/app');
  const status = page.locator('[data-rf-slot="offline-status"]').first();
  await expect(status.locator('[data-rf-offline-line]')).toHaveText(
    /^Ready for offline · [\d,]+ articles? · [\d,]+ images? · [\d,]+ pending$/,
    { timeout: 60_000 },
  );
  await expect(status.locator('[data-rf-offline-media]')).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => controllerUrl(page), { timeout: 20_000 }).toMatch(/\/sw\.js\?offline=1$/);
  return (await status.locator('[data-rf-offline-line]').textContent()).trim();
}

// A fresh browser process with the same device storage and its network state
// set before the first app navigation.
export async function coldLaunch(playwright, testInfo, profileDir, { offline }) {
  const { browserName, launchOptions } = testInfo.project.use;
  const context = await playwright[browserName].launchPersistentContext(profileDir, {
    ...launchOptions, baseURL: APP_ORIGIN, serviceWorkers: 'allow', offline,
  });
  // Chromium's offline emulation leaves service-worker network requests online.
  const abortNetwork = (route) => route.abort('internetdisconnected');
  async function setNetworkRoute(offline) {
    if (browserName !== 'chromium') return;
    if (offline) await context.route('**/*', abortNetwork);
    else await context.unroute('**/*', abortNetwork);
  }
  async function setOffline(offline) {
    await setNetworkRoute(offline);
    await context.setOffline(offline);
  }

  try {
    if (offline) await setNetworkRoute(true);
    return { context, page: context.pages()[0] ?? await context.newPage(), setOffline };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function seedOfflineDevice(playwright, testInfo, s,
  profileDir = fs.mkdtempSync(path.join(WORK, `cold-${testInfo.project.name}-`))) {
  const { context, page } = await coldLaunch(playwright, testInfo, profileDir, { offline: false });
  try {
    await login(page, s.alice.email, s.password);
    expect(await page.evaluate(() => typeof navigator.locks?.request), 'full offline requires Web Locks').toBe('function');
    await enableOffline(page);
    await waitReady(page);
    return profileDir;
  } finally {
    await context.close();
  }
}

// An htmx-style GET/POST issued from the page, so it goes through the worker. Returns
// status, the offline marker header and the body.
export async function pageFetch(page, path, init = {}) {
  return page.evaluate(async ([p, i]) => {
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]*)/) || [])[1] || '';
    const headers = { 'HX-Request': 'true', 'x-csrftoken': csrf, ...(i.headers || {}) };
    try {
      const r = await fetch(p, { method: i.method || 'GET', headers, body: i.body, credentials: 'same-origin' });
      return { status: r.status, offline: r.headers.get('X-Readfine-Offline'), body: await r.text(), hx: r.headers.get('HX-Trigger') };
    } catch (e) {
      return { status: 0, error: String(e) };
    }
  }, [path, init]);
}

// Names of this origin's IndexedDB databases and Cache Storage caches.
export async function deviceStorage(page) {
  return page.evaluate(async () => ({
    dbs: (await indexedDB.databases()).map((d) => d.name).sort(),
    caches: (await caches.keys()).sort(),
  }));
}

// The REST API, authenticated with an API token (outside the browser).
export async function apiArticle(request, token, id) {
  const r = await request.get(`${APP_ORIGIN}/api/v1/articles/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status(), body: r.status() === 200 ? await r.json() : null };
}
