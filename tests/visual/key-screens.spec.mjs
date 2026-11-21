// Key screens and gallery pages for the base-vs-head visual harness (tests/visual/run.mjs).
// Both sides serve their own tree (RF_VISUAL_TREE, see playwright.visual.config.mjs).
// RF_VISUAL_MODE picks the test that runs:
// - pixel (default): RF_VISUAL_SIDE=base captures every key screen into RF_VISUAL_SHOTS,
//   head captures again and diffs each shot against the base one;
// - layout: base records the boxes (layout.mjs collectBoxes) of every key screen in two
//   passes, A with font requests aborted and B with fonts loaded; head records them again
//   and compares (pass A strict, pass B KEY_STRUCTURE only);
// - gallery: head screenshots GALLERY_PAGES x themes x schemes x widths and runs the
//   dark-patch probe on every dark job; base (only with RF_VISUAL_GALLERY_BASE=1)
//   screenshots each page once per scheme and width, for side-by-side review.
// Every context's init script sets localStorage colorScheme and appTheme (`neutral`
// unless the job says otherwise; trees without themes ignore appTheme).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { seed, login } from '../e2e/helpers.mjs';
import { APP_ENV, APP_ORIGIN, BACKEND, ROOT } from '../e2e/env.mjs';
import { diffRgba } from './diff.mjs';
import { collectBoxes, compareBoxes, KEY_STRUCTURE } from './layout.mjs';
import { DEV_UI_PAGE, GALLERY_PAGES, KEY_SCREEN_PAGES, LANDING_PAGE } from './gallery-pages.mjs';

const MODE = process.env.RF_VISUAL_MODE || 'pixel';
const SIDE = process.env.RF_VISUAL_SIDE;
const TREE = process.env.RF_VISUAL_TREE || ROOT;
const SHOTS = process.env.RF_VISUAL_SHOTS;
const REPORT_DIR = path.join(ROOT, 'test-results/visual-report');
const DIFF_DIR = path.join(REPORT_DIR, 'diff');
const GALLERY_DIR = path.join(REPORT_DIR, 'gallery');
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];
const SCHEMES = ['light', 'dark'];
const THEMES = ['neutral', 'paper', 'graphite'];
// Gallery narrowing for quicker runs (comma lists, default everything):
// RF_VISUAL_SCHEMES (e.g. `dark` for the dark-patch probe alone), RF_VISUAL_PAGES
// (gallery page names).
const listEnv = (name) => (process.env[name] || '').split(',').map((v) => v.trim()).filter(Boolean);
const GALLERY_SCHEMES = listEnv('RF_VISUAL_SCHEMES').length
  ? SCHEMES.filter((v) => listEnv('RF_VISUAL_SCHEMES').includes(v)) : SCHEMES;
const GALLERY_ONLY = listEnv('RF_VISUAL_PAGES');

// `mask`: selectors of volatile regions, painted over in the pixel shot (none found yet).
const KEY_SCREENS = KEY_SCREEN_PAGES.map((p) => ({ ...p, mask: [] }));

// Dark-patch probe exemptions: elements whose light background is content, not a
// leftover light surface. Calibrated on the base's dark mode (s2-T8, 1d7f2f4): with an
// empty list the probe found 0 patches on every gallery page at 1280 and 390, so the
// list holds only content that is light by nature. Keep it narrow: an inline
// `style="background:#..."` or a light `bg-*` utility left over in a template is
// exactly what the probe is for.
const PATCH_ALLOW = [
  { selector: 'img, video, picture, canvas, iframe', reason: 'media: content pixels, not a surface' },
  { selector: 'mark.search-hit', reason: 'search-hit highlight: a marker colour by design' },
];

// ---- in-page helpers (self-contained, evaluated with page.evaluate) -----------------

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

// Visible elements of at least 8x8 px whose fill is light on a dark page: the relative
// luminance of the fill exceeds `limit`, outside the `allow` selectors. The fill is
// - the background-color composited over the page background (the root's and body's
//   own backgrounds), so translucent light fills count too (`translucent a=…`);
// - every colour stop of a background-image gradient, composited over that fill
//   (`gradient stop …`); url() images are content and are skipped.
// Primary-filled controls are light by design in some dark themes (Appendix A: Neutral
// and Paper dark): an element is allowed when its opaque background equals the page's
// computed --primary and its text colour equals --primary-foreground, both resolved
// for the active theme. A light background with any other foreground, or any other
// light colour, still fails. Colours of any CSS space (oklch included) are resolved to
// sRGB through a 1x1 canvas. Returns `{ patches, allowedPrimary }`.
function probeDarkPatches({ allow, limit }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Paints `layers` bottom-up (an invalid or empty layer paints nothing) and reads the
  // pixel back. With one layer over the cleared canvas this is the colour itself.
  const paint = (...layers) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const css of layers) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      if (css) ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
    }
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const round = (x) => Math.round(x * 1000) / 1000;
  const rgbOf = (px) => `rgb(${px[0]}, ${px[1]}, ${px[2]})`;
  // The page background as painted: the canvas default (white) under the root's and
  // body's own background colours.
  const pageBg = rgbOf(paint('#ffffff', getComputedStyle(document.documentElement).backgroundColor,
    getComputedStyle(document.body).backgroundColor));
  // --primary / --primary-foreground as computed for the active theme. Without the
  // tokens (a tree before s2-T9) the probe span stays transparent and nothing matches.
  const primary = (() => {
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;background-color:var(--primary);color:var(--primary-foreground)';
    document.body.append(span);
    const cs = getComputedStyle(span);
    const out = { bg: paint(cs.backgroundColor), fg: paint(cs.color) };
    span.remove();
    return out.bg[3] === 255 ? out : null;
  })();
  const STOP = /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/g;
  const patches = [];
  let allowedPrimary = 0;
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(`${p}#${n.id}`); break; }
      const cls = [...n.classList].slice(0, 3).join('.');
      if (cls) p += `.${cls}`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const image = cs.backgroundImage || 'none';
    const hasBg = Boolean(bg) && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    const hasGradient = image.includes('gradient(');
    if (!hasBg && !hasGradient) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    if (allow.some((sel) => el.matches(sel))) continue;
    let fill = pageBg;
    let fillAllowed = false;
    if (hasBg) {
      const own = paint(bg);
      const over = paint(pageBg, bg);
      fill = rgbOf(over);
      const L = lum(over);
      if (L > limit) {
        // A --primary fill passes when its text is --primary-foreground. A text-free form
        // control (a checked checkbox, radio or switch input) has no text to match, so
        // for it the fill alone decides; still by computed colour, never by class.
        const textFree = el.matches('input[type="checkbox"], input[type="radio"], input[role="switch"]')
          && !el.textContent.trim() && el.childElementCount === 0;
        if (primary && own[3] === 255 && same(own, primary.bg)
            && (textFree || same(paint(cs.color), primary.fg))) {
          allowedPrimary += 1;
          fillAllowed = true;
        } else {
          const colour = own[3] >= 230 ? bg : `translucent a=${round(own[3] / 255)} ${bg} over ${pageBg}`;
          patches.push({ selector: pathOf(el), colour, luminance: round(L) });
        }
      }
    }
    if (hasGradient) {
      // A stop is judged as painted over the element's fill; a transparent stop over an
      // allowed primary fill is that fill, not a new patch.
      const stops = (image.replace(/url\([^)]*\)/g, '').match(STOP) || [])
        .map((stop) => ({ stop, px: paint(fill, stop), alpha: paint(stop)[3] }))
        .filter((s) => !(fillAllowed && s.alpha === 0))
        .map((s) => ({ ...s, L: lum(s.px) }));
      const worst = stops.reduce((m, s) => (!m || s.L > m.L ? s : m), null);
      if (worst && worst.L > limit) {
        patches.push({ selector: pathOf(el), colour: `gradient stop ${worst.stop} over ${fill}`, luminance: round(worst.L) });
      }
    }
  }
  return { patches, allowedPrimary };
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

// Seeds, promotes alice, checks this phase serves its own tree's CSS and returns the seed
// and alice's session.
async function prepare(browser, request) {
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
  return { s, storageState };
}

const urlOf = (page, s) => (typeof page.path === 'function' ? page.path(s) : page.path);

// A fresh context with viewport, scheme and theme, navigated to `url` (or through
// `setup`), checked for status and final path, and settled. The caller closes it.
async function open(browser, { storageState, viewport, scheme, theme = 'neutral', url, status, setup, blockFonts }) {
  const context = await browser.newContext({
    baseURL: APP_ORIGIN, viewport, storageState, serviceWorkers: 'block',
  });
  try {
    await context.addInitScript(({ scheme, theme }) => {
      localStorage.setItem('colorScheme', scheme);
      localStorage.setItem('appTheme', theme);
    }, { scheme, theme });
    if (blockFonts) await context.route('**/static/fonts/**', (r) => r.abort());
    const page = await context.newPage();
    const response = setup ? await setup(page) : await page.goto(url);
    // A 403 or a redirect (e.g. to /login) would look the same on both sides.
    if (status) expect(response?.status(), `${url}: navigation status`).toBe(status);
    else expect(response?.ok(), `${url}: navigation status ${response?.status()}`).toBe(true);
    expect(new URL(page.url()).pathname, `${url}: final path`).toBe(new URL(url, APP_ORIGIN).pathname);
    await settle(page);
    return { context, page };
  } catch (err) {
    await context.close();
    throw err;
  }
}

// One pixel screenshot in a fresh context, optional hover steps.
async function capture(browser, job) {
  const { context, page } = await open(browser, job);
  try {
    for (const selector of job.hover || []) await page.locator(selector).first().hover({ timeout: 15_000 });
    if (job.hover?.length) await page.waitForTimeout(300); // let hover transitions finish
    return await page.screenshot({
      animations: 'disabled', caret: 'hide', mask: (job.mask || []).map((m) => page.locator(m)),
    });
  } finally {
    await context.close();
  }
}

// Boxes of one job, after `style` (a CSS string, the harness self-check) is injected.
async function boxes(browser, job, { blockFonts, style }) {
  const { context, page } = await open(browser, { ...job, blockFonts });
  try {
    if (style) await page.addStyleTag({ content: style });
    // Running animations (spinners rotate) change the box mid-flight: cancel them, so
    // every element sits in its unanimated state, as in an animations-disabled shot.
    await page.evaluate(() => {
      for (const a of document.getAnimations()) a.cancel();
      return new Promise(requestAnimationFrame);
    });
    return await page.evaluate(collectBoxes);
  } finally {
    await context.close();
  }
}

function keyScreenJobs(s, storageState) {
  const jobs = [];
  for (const screen of KEY_SCREENS) {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        jobs.push({
          name: `${screen.name}@${viewport.width}-${scheme}`, screen: screen.name, viewport, scheme, mask: screen.mask,
          storageState: screen.account === 'anonymous' ? undefined : storageState,
          url: urlOf(screen, s),
        });
      }
    }
  }
  return jobs;
}

// Pass A and pass B of one job against the base boxes.
function layoutResults(job, base, head) {
  const structure = KEY_STRUCTURE[`${job.screen}@${job.viewport.width}`] || [];
  const structKeys = new Set(structure.map((k) => k.key));
  const a = compareBoxes(base.A, head.A, { tolerance: 0.5 });
  const b = compareBoxes(base.B, head.B, { tolerance: 1, keys: structure });
  const present = new Set([...base.B, ...head.B].map((x) => x.key));
  const absent = structure.map((k) => k.key).filter((k) => !present.has(k));
  const reflow = compareBoxes(base.B, head.B, { tolerance: 1 }).moved.filter((m) => !structKeys.has(m.key));
  return [
    { pass: 'A', screen: job.screen, job: job.name, ...a },
    { pass: 'B', screen: job.screen, job: job.name, ...b, absent, reflow },
  ];
}

// Each admin settings save writes an audit_log row for alice, and audit_log.admin_id is
// ON DELETE RESTRICT: the next seed reset could not delete her. The gallery removes the
// rows it caused (every e2e user's, readfine_e2e only) once it is done.
const CLEAR_AUDIT_PY = `
import asyncio, sys
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from app.config import settings
if make_url(settings.database_url).database != "readfine_e2e":
    sys.exit("refusing: DATABASE_URL is not the readfine_e2e database")
async def main():
    engine = create_async_engine(settings.database_url)
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM audit_log WHERE admin_id IN "
                                "(SELECT id FROM users WHERE email LIKE '%@e2e.example')"))
    await engine.dispose()
asyncio.run(main())
`;
function clearE2eAudit() {
  execFileSync('uv', ['run', 'python', '-c', CLEAR_AUDIT_PY], {
    cwd: BACKEND, env: { ...process.env, ...APP_ENV }, encoding: 'utf8',
  });
}

// Switches registration through the admin settings form (the same POST the page sends,
// with the double-submit CSRF header). The app drops its cached flag on this write.
async function setRegistration(browser, storageState, open) {
  const context = await browser.newContext({ baseURL: APP_ORIGIN, storageState, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto('/admin/settings');
    const status = await page.evaluate(async (open) => {
      const form = document.querySelector('form[action="/admin/settings"]');
      form.querySelector('input[name="registration_enabled"]').checked = open;
      const token = document.cookie.split('; ').find((c) => c.startsWith('csrftoken='))?.split('=')[1];
      const r = await fetch('/admin/settings', {
        method: 'POST', body: new FormData(form), headers: { 'x-csrftoken': token || '' },
      });
      return r.status;
    }, open);
    expect(status, `registration ${open ? 'on' : 'off'}: admin settings POST`).toBe(200);
  } finally {
    await context.close();
  }
}

// ---- tests --------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test('key screens: capture and diff', async ({ browser, request }) => {
  test.skip(MODE !== 'pixel', 'pixel mode only');
  test.setTimeout(900_000);
  const { s, storageState } = await prepare(browser, request);
  const jobs = keyScreenJobs(s, storageState);
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
    expect(results).toHaveLength(jobs.length);
  } else {
    expect(fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png'))).toHaveLength(jobs.length);
  }
});

test('key screens: layout boxes', async ({ browser, request }) => {
  test.skip(MODE !== 'layout', 'layout mode only');
  test.setTimeout(1_200_000);
  const { s, storageState } = await prepare(browser, request);
  const jobs = keyScreenJobs(s, storageState);
  const dir = path.join(SHOTS, 'layout');
  fs.mkdirSync(dir, { recursive: true });
  const results = [];
  for (const job of jobs) {
    const head = {
      A: await boxes(browser, job, { blockFonts: true }),
      B: await boxes(browser, job, { blockFonts: false }),
    };
    const file = path.join(dir, `${job.name}.json`);
    if (SIDE === 'base') { fs.writeFileSync(file, JSON.stringify(head)); continue; }
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));
    results.push(...layoutResults(job, base, head));
  }
  if (SIDE === 'head') {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'layout-results.json'), JSON.stringify(results, null, 2));
    expect(results).toHaveLength(jobs.length * 2);
  } else {
    expect(fs.readdirSync(dir)).toHaveLength(jobs.length);
  }
});

test('gallery: capture and dark-patch probe', async ({ browser, request }) => {
  test.skip(MODE !== 'gallery', 'gallery mode only');
  test.setTimeout(3_600_000);
  const { s, storageState } = await prepare(browser, request);
  let pages = [...GALLERY_PAGES];
  if (process.env.RF_VISUAL_LANDING === '1') pages.push(LANDING_PAGE);
  if (process.env.RF_VISUAL_DEBUG === '1' && SIDE === 'head') pages.push(DEV_UI_PAGE);
  if (GALLERY_ONLY.length) pages = pages.filter((p) => GALLERY_ONLY.includes(p.name));
  expect(pages.length, 'gallery pages after RF_VISUAL_PAGES').toBeGreaterThan(0);
  expect(GALLERY_SCHEMES.length, 'schemes after RF_VISUAL_SCHEMES').toBeGreaterThan(0);
  // Registration-open pages last, so the switch flips once.
  pages.sort((a, b) => Number(a.state === 'registration-open') - Number(b.state === 'registration-open'));

  const themes = SIDE === 'head' ? THEMES : ['neutral'];
  const outDir = path.join(GALLERY_DIR, SIDE);
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [];
  const patches = [];
  const allowedPrimary = {}; // per theme: primary-filled elements the probe allowed
  const failures = [];
  let registrationOpen = false;
  try {
    await setRegistration(browser, storageState, false); // a known start state
    for (const page of pages) {
      if ((page.state === 'registration-open') !== registrationOpen) {
        registrationOpen = !registrationOpen;
        await setRegistration(browser, storageState, registrationOpen);
      }
      const url = urlOf(page, s);
      for (const viewport of VIEWPORTS.filter((v) => !page.widths || page.widths.includes(v.width))) {
        for (const theme of themes) {
          for (const scheme of GALLERY_SCHEMES) {
            const name = `${page.name}@${viewport.width}-${SIDE === 'head' ? `${theme}-` : ''}${scheme}`;
            try {
              const { context, page: p } = await open(browser, {
                url, viewport, scheme, theme, status: page.status, setup: page.setup,
                storageState: page.account === 'anonymous' ? undefined : storageState,
              });
              try {
                const file = path.join(outDir, `${name}.png`);
                fs.writeFileSync(file, await p.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' }));
                shots.push({ page: page.name, side: SIDE, theme: SIDE === 'head' ? theme : 'base', scheme,
                  width: viewport.width, file: path.relative(REPORT_DIR, file) });
                if (SIDE === 'head' && scheme === 'dark') {
                  const found = await p.evaluate(probeDarkPatches, { allow: PATCH_ALLOW.map((a) => a.selector), limit: 0.45 });
                  for (const f of found.patches) patches.push({ screen: `${page.name}@${viewport.width}`, theme, ...f });
                  allowedPrimary[theme] = (allowedPrimary[theme] || 0) + found.allowedPrimary;
                }
              } finally {
                await context.close();
              }
            } catch (err) {
              failures.push({ name, error: err.message.split('\n')[0] });
            }
          }
        }
      }
    }
  } finally {
    try {
      if (registrationOpen) await setRegistration(browser, storageState, false);
    } finally {
      clearE2eAudit();
    }
  }
  fs.writeFileSync(path.join(GALLERY_DIR, `${SIDE}.json`),
    JSON.stringify({ side: SIDE, pages: pages.map((p) => p.name), shots, patches, allowedPrimary, failures,
      patchAllow: PATCH_ALLOW }, null, 2));
  if (SIDE === 'head') console.log(`gallery: primary fills allowed per theme ${JSON.stringify(allowedPrimary)}`);
  for (const f of failures) console.error(`gallery: ${f.name}: ${f.error}`);
  expect(failures, 'gallery captures that failed').toEqual([]);
  const perPage = (SIDE === 'head' ? THEMES.length : 1) * GALLERY_SCHEMES.length;
  const expected = pages.reduce((n, p) => n + perPage * (p.widths?.length || VIEWPORTS.length), 0);
  expect(shots).toHaveLength(expected);
});

// Tailwind 4 changed two preflight defaults that input.css restores (Tailwind 3 compat):
// the pointer cursor on buttons and the gray-400 placeholder. The login form now uses
// Basecoat's .btn and .input, which bring their own cursor and placeholder, so the check
// runs on controls s2 does not restyle: the add form on /settings/labels (a plain input
// and a button with utility classes only, no cursor-* or placeholder-* class).
test('compat: button cursor and placeholder colour', async ({ page }) => {
  test.skip(SIDE !== 'head', 'head side only');
  const s = seed();
  await login(page, s.alice.email, s.password);
  await page.goto('/settings/labels');
  const form = page.locator('form[hx-post="/settings/labels"]');
  const button = await form.locator('button[type=submit]')
    .evaluate((el) => ({ cursor: getComputedStyle(el).cursor, cls: el.className }));
  expect(button.cls, 'the button must stay unrestyled for this check').not.toMatch(/\b(btn|cursor-)/);
  expect(button.cursor).toBe('pointer');
  const { placeholder, gray400, cls } = await form.locator('input[name=name]')
    .evaluate((el) => {
      // --color-gray-400 resolved the same way (a computed color), whatever the theme.
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-gray-400)';
      document.body.append(probe);
      const gray400 = getComputedStyle(probe).color;
      probe.remove();
      return { placeholder: getComputedStyle(el, '::placeholder').color, gray400, cls: el.className };
    });
  expect(cls, 'the input must stay unrestyled for this check').not.toMatch(/\b(input|placeholder:)/);
  expect(gray400).not.toBe('');
  expect(placeholder).toBe(gray400);
});

test('harness: an altered shot is detected', async ({ browser }) => {
  test.skip(SIDE !== 'head' || MODE !== 'pixel', 'pixel mode, head side only');
  const base = fs.readFileSync(path.join(SHOTS, 'login@1280-light.png'));
  const context = await browser.newContext();
  const page = await context.newPage();
  const clean = await compareInPage(page, base, base);
  expect(clean.pixels).toBe(0);
  const altered = await compareInPage(page, base, base, { paint: true });
  await context.close();
  expect(altered.ratio).toBeGreaterThan(0.001);
});

test('harness: an injected shift is detected', async ({ browser, request }) => {
  test.skip(SIDE !== 'head' || MODE !== 'layout', 'layout mode, head side only');
  test.setTimeout(180_000);
  const { s, storageState } = await prepare(browser, request);
  const job = keyScreenJobs(s, storageState).find((j) => j.name === 'list@1280-light');
  const key = KEY_STRUCTURE['list@1280'][0].key;
  const base = JSON.parse(fs.readFileSync(path.join(SHOTS, 'layout', `${job.name}.json`), 'utf8'));
  const style = `${key}{margin-left:3px !important}`;
  const head = {
    A: await boxes(browser, job, { blockFonts: true, style }),
    B: await boxes(browser, job, { blockFonts: false, style }),
  };
  const [a, b] = layoutResults(job, base, head);
  expect(a.moved.map((m) => m.key)).toContain(key);
  expect(b.moved.map((m) => m.key)).toContain(key);
});
