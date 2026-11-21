// Key-screen screenshots for the base-vs-head diff (tests/visual/run.mjs).
// RF_VISUAL_SIDE=base: capture every screen into RF_VISUAL_SHOTS.
// RF_VISUAL_SIDE=head: capture again and diff each shot against the base one.
// Both sides serve their own tree (RF_VISUAL_TREE, see playwright.visual.config.mjs).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { seed, login } from '../e2e/helpers.mjs';
import { APP_ENV, APP_ORIGIN, BACKEND, ROOT } from '../e2e/env.mjs';
import { diffRgba } from './diff.mjs';

const SIDE = process.env.RF_VISUAL_SIDE;
const TREE = process.env.RF_VISUAL_TREE || ROOT;
const SHOTS = process.env.RF_VISUAL_SHOTS;
const REPORT_DIR = path.join(ROOT, 'test-results/visual-report');
const DIFF_DIR = path.join(REPORT_DIR, 'diff');
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];
const SCHEMES = ['light', 'dark'];

// `mask`: selectors of volatile regions, painted over in the shot (none found yet).
// `account`: alice (admin) or anonymous.
const KEY_SCREENS = [
  { name: 'login', path: '/login', account: 'anonymous', mask: [] },
  { name: 'list', path: '/app', mask: [] },
  { name: 'article', path: (s) => `/app?open_article_id=${s.articles.w1.id}`, mask: [] },
  { name: 'catch-me-up', path: '/app/catch-me-up', mask: [] },
  { name: 'settings-preferences', path: '/settings/preferences', mask: [] },
  { name: 'settings-feeds', path: '/settings/feeds', mask: [] },
  { name: 'help', path: '/help', mask: [] },
  { name: 'admin-settings', path: '/admin/settings', mask: [] },
];

// ---- in-page diff -------------------------------------------------------------------

// Decodes two PNGs on a canvas and runs diffRgba in the page. `paint` paints a 40x40
// red square on the second one first (the harness self-check). Returns the counts and,
// when pixels differ, a PNG of the differing pixels over the first shot.
async function compareInPage(page, aPng, bPng, { paint = false } = {}) {
  return page.evaluate(async ({ a, b, fn, paint }) => {
    const diffRgbaInPage = (0, eval)(`(${fn})`);
    async function decode(base64) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return { ctx, width: bmp.width, height: bmp.height };
    }
    const A = await decode(a);
    const B = await decode(b);
    if (A.width !== B.width || A.height !== B.height) {
      return { width: A.width, height: A.height, pixels: 0, ratio: 1, sizeMismatch: true };
    }
    if (paint) { B.ctx.fillStyle = '#ff0000'; B.ctx.fillRect(0, 0, 40, 40); }
    const da = A.ctx.getImageData(0, 0, A.width, A.height);
    const db = B.ctx.getImageData(0, 0, B.width, B.height);
    const { pixels, ratio } = diffRgbaInPage(da.data, db.data, A.width, A.height);
    let diffPng = null;
    if (pixels > 0) {
      const out = new ImageData(new Uint8ClampedArray(da.data), A.width, A.height);
      for (let i = 0; i < A.width * A.height; i++) {
        const o = i * 4;
        const d = Math.max(Math.abs(da.data[o] - db.data[o]), Math.abs(da.data[o + 1] - db.data[o + 1]),
          Math.abs(da.data[o + 2] - db.data[o + 2]), Math.abs(da.data[o + 3] - db.data[o + 3]));
        if (d > 3) { out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 0; out.data[o + 3] = 255; }
        else out.data[o + 3] = 80;
      }
      const canvas = document.createElement('canvas');
      canvas.width = A.width; canvas.height = A.height;
      canvas.getContext('2d').putImageData(out, 0, 0);
      diffPng = canvas.toDataURL('image/png').split(',')[1];
    }
    return { width: A.width, height: A.height, pixels, ratio, diffPng };
  }, { a: aPng.toString('base64'), b: bPng.toString('base64'), fn: diffRgba.toString(), paint });
}

// ---- helpers ------------------------------------------------------------------------

function makeAdmin(email) {
  execFileSync('uv', ['run', 'python', '../tests/e2e/fixtures/seed.py', 'role', email, 'admin'], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8',
  });
}

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}

// One screenshot in a fresh context: viewport, colour scheme, optional hover steps.
async function capture(browser, { storageState, viewport, scheme, url, mask = [], hover = [] }) {
  const context = await browser.newContext({
    baseURL: APP_ORIGIN, viewport, storageState, serviceWorkers: 'block',
  });
  try {
    await context.addInitScript((s) => localStorage.setItem('colorScheme', s), scheme);
    const page = await context.newPage();
    const response = await page.goto(url);
    // A 403 or a redirect (e.g. to /login) would look the same on both sides.
    expect(response?.ok(), `${url}: navigation status ${response?.status()}`).toBe(true);
    expect(new URL(page.url()).pathname, `${url}: final path`).toBe(new URL(url, APP_ORIGIN).pathname);
    await settle(page);
    for (const selector of hover) await page.locator(selector).first().hover({ timeout: 15_000 });
    if (hover.length) await page.waitForTimeout(300); // let hover transitions finish
    return await page.screenshot({
      animations: 'disabled', caret: 'hide', mask: mask.map((m) => page.locator(m)),
    });
  } finally {
    await context.close();
  }
}

// ---- tests --------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test('key screens: capture and diff', async ({ browser, request }) => {
  test.setTimeout(900_000);
  expect(['base', 'head']).toContain(SIDE);
  expect(SHOTS, 'RF_VISUAL_SHOTS').toBeTruthy();
  const s = seed();
  makeAdmin(s.alice.email);

  // This phase must serve its own tree: the linked stylesheet is that tree's file.
  const loginHtml = await (await request.get('/login')).text();
  const href = loginHtml.match(/<link[^>]+href="([^"]*tailwind\.css[^"]*)"/)?.[1];
  expect(href, 'tailwind.css link on /login').toBeTruthy();
  const served = Buffer.from(await (await request.get(href)).body());
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const onDisk = fs.readFileSync(path.join(TREE, 'backend/app/static/css/tailwind.css'));
  console.log(`visual: ${SIDE} css sha256 ${sha(served).slice(0, 12)}`);
  expect(sha(served)).toBe(sha(onDisk));

  // Log alice in once; every shot reuses the session.
  const ctx = await browser.newContext({ baseURL: APP_ORIGIN, serviceWorkers: 'block' });
  const loginPage = await ctx.newPage();
  await login(loginPage, s.alice.email, s.password);
  const storageState = await ctx.storageState();
  await ctx.close();

  const jobs = [];
  for (const screen of KEY_SCREENS) {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        jobs.push({
          name: `${screen.name}@${viewport.width}-${scheme}`, viewport, scheme, mask: screen.mask,
          storageState: screen.account === 'anonymous' ? undefined : storageState,
          url: typeof screen.path === 'function' ? screen.path(s) : screen.path,
        });
      }
    }
  }
  for (const scheme of SCHEMES) {
    jobs.push({
      name: `list-hover@1280-${scheme}`, viewport: VIEWPORTS[0], scheme, storageState, url: '/app',
      mask: [], hover: ['.article-row:visible', '.nav-item:visible'],
    });
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  const results = [];
  let diffPage = null;
  let diffContext = null;
  if (SIDE === 'head') {
    fs.rmSync(REPORT_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIFF_DIR, { recursive: true });
    diffContext = await browser.newContext();
    diffPage = await diffContext.newPage();
  }
  for (const job of jobs) {
    const png = await capture(browser, job);
    const file = path.join(SHOTS, `${job.name}.png`);
    if (SIDE === 'base') { fs.writeFileSync(file, png); continue; }
    const base = fs.readFileSync(file);
    const r = await compareInPage(diffPage, base, png);
    const entry = { screen: job.name, width: r.width, height: r.height, pixels: r.pixels, ratio: r.ratio };
    if (r.sizeMismatch) entry.sizeMismatch = true;
    if (r.diffPng) {
      const out = path.join(DIFF_DIR, `${job.name}.png`);
      fs.writeFileSync(out, Buffer.from(r.diffPng, 'base64'));
      entry.diff = path.relative(ROOT, out);
      fs.writeFileSync(path.join(DIFF_DIR, `${job.name}.head.png`), png);
      entry.head = path.relative(ROOT, path.join(DIFF_DIR, `${job.name}.head.png`));
    }
    results.push(entry);
  }
  await diffContext?.close();
  if (SIDE === 'head') {
    fs.writeFileSync(path.join(REPORT_DIR, 'results.json'), JSON.stringify(results, null, 2));
    expect(results).toHaveLength(34);
  } else {
    expect(fs.readdirSync(SHOTS)).toHaveLength(34);
  }
});

test('compat: button cursor and placeholder colour', async ({ page }) => {
  test.skip(SIDE !== 'head', 'head side only');
  await page.goto('/login');
  const cursor = await page.locator('form[data-rf-login] button[type=submit]')
    .evaluate((el) => getComputedStyle(el).cursor);
  expect(cursor).toBe('pointer');
  const placeholder = await page.locator('#email')
    .evaluate((el) => {
      // The login field has no placeholder text, so the pseudo-element is absent
      // until one is set; the rule under test is the stylesheet's, not the template's.
      el.setAttribute('placeholder', 'x');
      return getComputedStyle(el, '::placeholder').color;
    });
  expect(placeholder).toBe('rgb(156, 163, 175)');
});

test('harness: an altered shot is detected', async ({ browser }) => {
  test.skip(SIDE !== 'head', 'head side only');
  const base = fs.readFileSync(path.join(SHOTS, 'login@1280-light.png'));
  const context = await browser.newContext();
  const page = await context.newPage();
  const clean = await compareInPage(page, base, base);
  expect(clean.pixels).toBe(0);
  const altered = await compareInPage(page, base, base, { paint: true });
  await context.close();
  expect(altered.ratio).toBeGreaterThan(0.001);
});
