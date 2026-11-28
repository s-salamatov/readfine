// Motion s1 end to end (motion design 2026-11-28, plan s1-T6): presses answer with one
// short scale animation and leave nothing behind, a closing menu or dialog lets the click
// through at once, reduced motion keeps overlays working and still, and moving between
// screens is a cross-document View Transition within --t-fast-max.
// Every page gets an init script that turns RFMotion's trace on (data-rf-motion-trace),
// snapshots the Web Animations a press starts (in the same task as the pointerdown, so
// a 165 ms animation is never raced), and records each pagereveal with the durations of
// its ::view-transition* animations.
import { test, expect } from '@playwright/test';
import { seed, login } from './helpers.mjs';
import { requireE2eDatabaseUrl } from './db-guard.mjs';
requireE2eDatabaseUrl(); // Reject an unsafe DSN at collection, before seeding.

let s;
test.beforeEach(async ({ page }) => {
  s = seed();
  await page.addInitScript(instrument);
});

// ---- in-page instrumentation (runs before the page's own scripts) -------------------

function instrument() {
  const ATTR = 'data-rf-motion-trace';
  const mark = () => { if (document.documentElement) document.documentElement.setAttribute(ATTR, ''); };
  mark();
  new MutationObserver(mark).observe(document, { childList: true });
  document.addEventListener('DOMContentLoaded', mark);

  const label = (el) => (el && el.nodeType === 1
    ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.contains('article-row') ? '.article-row' : ''}${el.matches?.('form') ? '[form]' : ''}`
    : String(el));
  window.__label = label;

  // Script animations (anime.waapi -> Element.animate) present right after a press:
  // the window's bubbling listener runs after motion.js's capture listener on document.
  const scriptAnimations = () => document.getAnimations()
    .filter((a) => a.constructor.name === 'Animation' && !a.effect?.pseudoElement)
    .map((a) => ({
      target: label(a.effect?.target),
      scale: a.effect.getKeyframes().map((k) => k.scale),
      props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)
        .filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))],
      duration: a.effect.getComputedTiming().duration,
      endTime: a.effect.getComputedTiming().endTime,
    }));
  window.__presses = [];
  const onPress = (e) => window.__presses.push({ type: e.type, key: e.key, target: label(e.target), t: performance.now(), animations: scriptAnimations() });
  window.addEventListener('pointerdown', onPress);
  window.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onPress(e); });

  // Cross-document View Transitions: one record per pagereveal of this document.
  window.__vt = [];
  const vtAnimations = () => document.getAnimations()
    .filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition'))
    .map((a) => ({ pseudo: a.effect.pseudoElement, duration: a.effect.getComputedTiming().duration, endTime: a.effect.getComputedTiming().endTime }));
  window.__vtAnimations = vtAnimations;
  window.addEventListener('pagereveal', async (e) => {
    const vt = e.viewTransition || null;
    const rec = { vt: !!vt, t: performance.now(), anims: [], after: null, done: false };
    window.__vt.push(rec);
    if (!vt) { rec.done = true; return; }
    try {
      await vt.ready;
      rec.anims = vtAnimations();
      // A paused first frame, for the overlay observation (motion e2e case 5).
      if (sessionStorage.getItem('rf-e2e-pause-vt') === '1') {
        sessionStorage.removeItem('rf-e2e-pause-vt');
        const list = document.getAnimations().filter((a) => String(a.effect?.pseudoElement || '').startsWith('::view-transition'));
        list.forEach((a) => { a.pause(); a.currentTime = 0; });
        rec.paused = true;
        await new Promise((resolve) => { window.__resumeVt = () => { list.forEach((a) => a.play()); resolve(); }; });
      }
      await vt.finished;
    } catch (err) {
      rec.error = String(err);
    }
    rec.after = vtAnimations().length;
    rec.done = true;
  });
}

// ---- helpers -------------------------------------------------------------------------

const traceNames = (page) => page.evaluate(() => window.RFMotion.trace.map((r) => `${r.name} ${window.__label(r.target)}`));
const clearTrace = (page) => page.evaluate(() => { window.RFMotion.trace.length = 0; window.__presses.length = 0; });
const idle = (page) => page.evaluate(() => window.RFMotion.idle());
const frames = (page, n = 2) => page.evaluate((k) => new Promise((resolve) => {
  const step = (i) => (i ? requestAnimationFrame(() => step(i - 1)) : resolve());
  step(k);
}), n);

// Running animations, as in read.spec.mjs: Basecoat's dialog-scroll-lock (a no-op on
// <html>) and identity scale/translate transitions are left out; RFMotion's own count
// is reported too.
function runningAnimations(page) {
  return page.evaluate(() => {
    const identity = (a) => {
      if (a.constructor.name !== 'CSSTransition' || !['scale', 'translate'].includes(a.transitionProperty)) return false;
      // 'none', '1' and '0px' are all the identity.
      const rest = (v) => (/^(none|1( 1)*|0px( 0px)*)$/.test(String(v).trim()) ? 'rest' : v);
      const values = a.effect.getKeyframes().map((k) => k[a.transitionProperty]);
      return values.every((v) => rest(v) === rest(values[0]));
    };
    const out = document.getAnimations()
      .filter((a) => a.playState === 'running')
      .filter((a) => a.animationName !== 'dialog-scroll-lock' && !identity(a))
      .map((a) => `${a.constructor.name} ${a.animationName || a.transitionProperty || ''} on ${a.effect?.target?.id || a.effect?.target?.className || a.effect?.target?.tagName || '?'} (${a.effect?.getComputedTiming().duration} ms, t ${Math.round(a.currentTime)})`);
    if (window.RFMotion && window.RFMotion.activeCount() > 0) out.push(`RFMotion.activeCount ${window.RFMotion.activeCount()}`);
    return out;
  });
}

// The inline values a press could leave behind: every inline longhand (Chrome may
// re-serialise style text after revert(), design point 6) and the four motion ones.
async function inlineState(locator) {
  return locator.evaluate((el) => {
    const longhands = {};
    for (let i = 0; i < el.style.length; i++) longhands[el.style[i]] = el.style.getPropertyValue(el.style[i]);
    return {
      longhands,
      scale: el.style.scale, translate: el.style.translate, opacity: el.style.opacity, transform: el.style.transform,
      computed: { scale: getComputedStyle(el).scale, opacity: getComputedStyle(el).opacity },
    };
  });
}

async function center(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// A point on an element's own surface (a row, a form), off its links, buttons and
// fields, so a press there is the element's own.
async function rowSpot(locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((row) => {
    const r = row.getBoundingClientRect();
    for (const fy of [0.5, 0.6, 0.7, 0.8, 0.9, 0.4, 0.3, 0.2, 0.1]) {
      for (let fx = 0.95; fx > 0.05; fx -= 0.05) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (hit && row.contains(hit) && !hit.closest('a, button, [role=button], [role=switch], label, input, select, textarea')) return { x, y };
      }
    }
    throw new Error(`no bare spot on ${row.id}`);
  });
}

// Clicks on these targets are swallowed (capture, on window), so presses can repeat
// without opening articles or menus; the press itself is pointerdown.
async function swallowClicks(page, selectors) {
  await page.evaluate((sel) => {
    window.__swallow = (e) => { if (e.target.closest?.(sel)) { e.preventDefault(); e.stopImmediatePropagation(); } };
    window.addEventListener('click', window.__swallow, true);
    window.addEventListener('dblclick', window.__swallow, true);
  }, selectors.join(', '));
}

// Navigates by clicking a link, which a cross-document View Transition needs (a
// browser-UI navigation such as page.goto need not get one), and returns the new
// document's pagereveal record once its transition is over.
async function navigateBy(page, link, path) {
  await Promise.all([page.waitForURL((u) => u.pathname.startsWith(path)), link.click()]);
  await page.waitForFunction(() => window.__vt && window.__vt.length && window.__vt[0].done, null, { polling: 'raf', timeout: 15_000 });
  return page.evaluate(() => window.__vt[0]);
}

// Mean RGB of a rectangle of a PNG screenshot, decoded on a canvas in the page.
async function meanColour(page, png, rect) {
  return page.evaluate(async ({ b64, r }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(Math.round(r.x), Math.round(r.y), Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height))).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
    const n = d.length / 4;
    return sum.map((v) => Math.round(v / n));
  }, { b64: png.toString('base64'), r: rect });
}

const toasts = (page) => page.locator('#toaster .toast');

// A computed transition-duration list ('0.01ms', '1e-05s, 0.1s') in milliseconds.
const durationMs = (v) => v.split(',').map((x) => x.trim()).map((x) => (x.endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000));
const isInstant = (v) => durationMs(v).every((n) => Math.abs(n - 0.01) < 1e-6);

// The reduced-motion reset as computed values, which no timing can hide: the overlay
// (for a dialog, its backdrop and panel too) takes 0.01 ms. Soft, so that one run names
// every overlay that lost the reset.
async function expectInstant(overlay, what) {
  const values = await overlay.evaluate((el) => {
    const out = { self: getComputedStyle(el).transitionDuration };
    if (el.tagName === 'DIALOG') {
      out.backdrop = getComputedStyle(el, '::backdrop').transitionDuration;
      out.panel = getComputedStyle(el.firstElementChild).transitionDuration;
    }
    return out;
  });
  for (const [part, v] of Object.entries(values)) {
    expect.soft(isInstant(v), `${what}, ${part}: transition-duration ${v}, expected 0.01ms`).toBe(true);
  }
}

// ---- 1. a press -----------------------------------------------------------------------

test('motion e2e: a press plays one short scale animation and the click still lands', async ({ page }) => {
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const trigger = page.locator('#list-view-menu-trigger');
  await expect(trigger).toBeVisible();
  const menu = page.locator('#list-view-menu-popover');
  await idle(page);
  await clearTrace(page);

  // pointerdown on the list header's View options button: one script animation, on it,
  // scale 1 -> < 1 -> none, within --t-fast-max.
  const p = await center(trigger);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const down = await page.evaluate(() => window.__presses.at(-1));
  expect(down.type).toBe('pointerdown');
  expect(down.animations, JSON.stringify(down)).toHaveLength(1);
  const [anim] = down.animations;
  expect(anim.target).toBe('button#list-view-menu-trigger');
  expect(anim.props).toEqual(['scale']);
  expect(anim.scale[0]).toBe('1');
  expect(Number(anim.scale[1])).toBeLessThan(1);
  expect(anim.scale.at(-1)).toBe('none');
  expect(anim.endTime).toBeLessThanOrEqual(165);
  // Release: the menu is open at once, no animation was added on pointerup.
  await page.mouse.up();
  expect(await trigger.getAttribute('aria-expanded')).toBe('true');
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.constructor.name === 'Animation' && !a.effect?.pseudoElement).length)).toBeLessThanOrEqual(1);
  expect(await traceNames(page)).toEqual(['press button#list-view-menu-trigger']);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await idle(page);

  // A row answers with press-soft (scale ~0.985), and its click still opens the article.
  const id = s.articles.w2.id;
  const row = page.locator(`#article-row-${id}`);
  await clearTrace(page);
  const r = await rowSpot(row);
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  const rowDown = await page.evaluate(() => window.__presses.at(-1));
  expect(rowDown.animations, JSON.stringify(rowDown)).toHaveLength(1);
  expect(rowDown.animations[0].target).toBe(`div#article-row-${id}.article-row`);
  expect(Number(rowDown.animations[0].scale[1])).toBeGreaterThan(0.95);
  expect(rowDown.animations[0].scale.at(-1)).toBe('none');
  expect(rowDown.animations[0].endTime).toBeLessThanOrEqual(165);
  await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === `/htmx/articles/${id}` && res.request().method() === 'GET'),
    page.mouse.up(),
  ]);
  await expect(page.locator(`#article-detail article[data-article-id="${id}"]`)).toHaveCount(1);
  expect(await traceNames(page)).toContain(`press-soft div#article-row-${id}.article-row`);

  // Enter on a focused button presses once; a held key (repeat) adds nothing.
  await idle(page);
  await clearTrace(page);
  await trigger.focus();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter'); // held: Playwright sends this keydown with repeat
  await page.keyboard.up('Enter');
  expect(await page.evaluate(() => window.__presses.filter((e) => e.type === 'keydown').length)).toBe(2);
  expect(await traceNames(page)).toEqual(['press button#list-view-menu-trigger']);
  await page.keyboard.press('Escape');
});

// ---- 2. no traces ---------------------------------------------------------------------

test('motion e2e: presses leave no trace', async ({ page }) => {
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const button = page.locator('#list-view-menu-trigger');
  // w3 becomes read by opening it (opacity-75, base.html's opacity transition); w1 stays
  // unread.
  const readRow = page.locator(`#article-row-${s.articles.w3.id}`);
  const unreadRow = page.locator(`#article-row-${s.articles.w1.id}`);
  await readRow.click();
  await expect(page.locator(`#article-detail article[data-article-id="${s.articles.w3.id}"]`)).toHaveCount(1);
  await expect(readRow).toHaveAttribute('data-is-read', 'true');
  await page.waitForFunction(() => !document.querySelector('.htmx-request, .htmx-settling, .htmx-swapping'), null, { polling: 'raf' });
  await expect(unreadRow).toHaveAttribute('data-is-read', 'false');
  await expect(readRow).toBeVisible();
  // Inline state a press must keep: an inline transition and opacity on the button.
  await button.evaluate((el) => { el.style.transition = 'all 150ms'; el.style.opacity = '0.9'; });
  await idle(page);
  await swallowClicks(page, ['#list-view-menu-trigger', '.article-row']);
  await readRow.evaluate((el) => {
    window.__opacityRuns = 0;
    el.addEventListener('transitionrun', (e) => { if (e.propertyName === 'opacity') window.__opacityRuns++; });
  });

  // The element's own CSS transitions (the inline `all 150ms` above, a hover colour) are
  // over: computed values are compared at rest.
  const settleOwn = (target) => target.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {})));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  // Transitions still running on the element once RFMotion is idle, by property and
  // keyframes (an identity scale/translate transition after revert() is a no-op).
  const leftovers = (target) => target.evaluate((el) => el.getAnimations()
    .filter((a) => a.playState === 'running')
    .map((a) => {
      const prop = a.transitionProperty || a.animationName || '';
      const values = a.effect.getKeyframes().map((k) => k[prop]);
      const rest = (v) => (/^(none|1( 1)*|0px( 0px)*)$/.test(String(v).trim()) ? 'rest' : v);
      return { kind: a.constructor.name, prop, identity: values.length > 0 && values.every((v) => rest(v) === rest(values[0])), values };
    }));

  for (const [name, target] of [['button', button], ['read row', readRow], ['unread row', unreadRow]]) {
    await settleOwn(target);
    const before = await inlineState(target);
    const p = name === 'button' ? await center(target) : await rowSpot(target);
    await clearTrace(page);
    // Single, double (the second press lands during the first), cancelled (released off).
    await page.mouse.click(p.x, p.y);
    await page.mouse.dblclick(p.x, p.y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x, p.y + 400, { steps: 4 });
    await page.mouse.up();
    const presses = await page.evaluate(() => window.__presses.filter((e) => e.type === 'pointerdown').length);
    expect(presses, name).toBe(4);
    expect((await traceNames(page)).length, `${name}: every press played`).toBe(4);
    await idle(page);
    const left = await leftovers(target);
    if (left.length) test.info().annotations.push({ type: `${name}: transitions left once idle`, description: JSON.stringify(left) });
    for (const l of left) {
      expect(l.kind === 'CSSTransition' && ['scale', 'translate'].includes(l.prop) && l.identity, `${name}: ${JSON.stringify(left)}`).toBe(true);
    }
    await settleOwn(target);
    const after = await inlineState(target);
    expect(after, `${name}: inline values after the presses`).toEqual(before);
    expect(await page.evaluate(() => window.RFMotion.activeCount()), name).toBe(0);
    expect(await target.evaluate((el) => el.getAnimations().filter((a) => a.constructor.name === 'Animation').length), name).toBe(0);
  }
  expect(await page.evaluate(() => window.__opacityRuns), 'no opacity transition on the read row').toBe(0);

  // Inside forms only the control dips, never the form (carried check 4): a submit
  // button of a plain form, and the non-control area of an hx-post form.
  await page.goto('/settings/profile');
  const form = page.locator('form[action="/settings/profile/name"]');
  const submit = form.getByRole('button', { name: 'Save name' });
  await expect(submit).toBeVisible();
  await idle(page);
  await page.evaluate(() => document.addEventListener('submit', (e) => e.preventDefault(), true));
  await clearTrace(page);
  const sp = await center(submit);
  await page.mouse.move(sp.x, sp.y);
  await page.mouse.down();
  const submitDown = await page.evaluate(() => window.__presses.at(-1));
  await page.mouse.up();
  expect(submitDown.animations.map((a) => a.target), JSON.stringify(submitDown)).toEqual(['button']);
  expect(await traceNames(page)).toEqual(['press button']);
  expect(await form.evaluate((el) => el.getAnimations().length)).toBe(0);

  await page.goto('/settings/reading');
  const hxForm = page.locator('#reading-form');
  await expect(hxForm).toHaveAttribute('hx-post', /./);
  await idle(page);
  await clearTrace(page);
  // A bare spot of the form, beside its fields.
  const spot = await rowSpot(hxForm);
  const hitForm = await page.evaluate(({ x, y }) => window.__label(document.elementFromPoint(x, y)), spot);
  // The spot is inside the form and on no control.
  expect(await hxForm.evaluate((form, { x, y }) => {
    const el = document.elementFromPoint(x, y);
    return form.contains(el) && !el.closest('a, button, [role=button], [role=switch], label, input, select, textarea');
  }, spot), hitForm).toBe(true);
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  const formDown = await page.evaluate(() => window.__presses.at(-1));
  await page.mouse.up();
  expect(formDown.animations, `${hitForm}: ${JSON.stringify(formDown)}`).toEqual([]);
  expect(await traceNames(page)).toEqual([]);
  expect(await hxForm.evaluate((el) => el.getAnimations().length)).toBe(0);
});

// ---- 3. closing overlays --------------------------------------------------------------

test('motion e2e: a closing menu lets the click through at once', async ({ page, browserName }) => {
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  // Record, in the page, each Escape and each click with what it hit and whether the
  // overlay was still on its way out at that moment.
  await page.evaluate(() => {
    window.__close = [];
    const exiting = (el) => !!el && (el.getAnimations({ subtree: false }).some((a) => a.playState === 'running')
      || (Number(getComputedStyle(el).opacity) > 0 && Number(getComputedStyle(el).opacity) < 1));
    window.__exitTarget = null;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__close.push({ type: 'escape', t: performance.now() }); }, true);
    // Armed for one click after each Escape below; that click is swallowed, so the
    // page stays as it is.
    window.addEventListener('click', (e) => {
      if (!window.__exitTarget) return;
      e.preventDefault(); e.stopImmediatePropagation();
      const el = document.querySelector(window.__exitTarget);
      window.__exitTarget = null;
      window.__close.push({ type: 'click', t: performance.now(), target: window.__label(e.target), inside: !!el?.contains(e.target), exiting: exiting(el) });
    }, true);
  });
  const lastPair = () => page.evaluate(() => {
    const esc = window.__close.filter((r) => r.type === 'escape').at(-1);
    const click = window.__close.filter((r) => r.type === 'click').at(-1);
    return { esc, click, delta: click && esc ? click.t - esc.t : null };
  });

  // The list header's View options menu.
  const trigger = page.locator('#list-view-menu-trigger');
  const pop = page.locator('#list-view-menu-popover');
  await trigger.click();
  await expect(pop).toBeVisible();
  await idle(page);
  await page.waitForFunction(() => document.querySelector('#list-view-menu-popover').getAnimations().every((a) => a.playState !== 'running'));
  const item = pop.getByRole('menuitemradio').first();
  const ip = await center(item);
  await page.evaluate(() => { window.__exitTarget = '#list-view-menu-popover'; });
  await page.keyboard.press('Escape');
  await page.mouse.click(ip.x, ip.y);
  const menuPair = await lastPair();
  expect(menuPair.click.inside, JSON.stringify(menuPair)).toBe(false);
  expect(menuPair.click.exiting, `the menu was still fading: ${JSON.stringify(menuPair)}`).toBe(true);
  expect(menuPair.delta).toBeLessThan(125);
  await expect(pop).toBeHidden();

  // The shortcuts dialog ('?').
  await page.locator('body').focus();
  await page.keyboard.press('?');
  const dlg = page.locator('#shortcuts-dialog');
  await expect(dlg).toHaveJSProperty('open', true);
  await idle(page);
  await page.waitForFunction(() => document.querySelector('#shortcuts-dialog').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
  const panel = dlg.locator('> *').first();
  const dp = await center(panel);
  await page.evaluate(() => { window.__exitTarget = '#shortcuts-dialog'; });
  await page.keyboard.press('Escape');
  await page.mouse.click(dp.x, dp.y);
  const dialogPair = await lastPair();
  expect(dialogPair.click.inside, JSON.stringify(dialogPair)).toBe(false);
  // Chrome keeps a closing <dialog> fading (allow-discrete); in WebKit nothing was still
  // running on it 41 ms after Escape (2026-11-28), so there the passing click is enough.
  if (browserName === 'chromium') expect(dialogPair.click.exiting, `the dialog was still fading: ${JSON.stringify(dialogPair)}`).toBe(true);
  expect(dialogPair.delta).toBeLessThan(125);
  await expect(dlg).toHaveJSProperty('open', false);
  expect(await dlg.evaluate((el) => el.matches(':modal'))).toBe(false);
  test.info().annotations.push({ type: 'closing overlays', description: JSON.stringify({ menu: menuPair, dialog: dialogPair }) });
});

// ---- 4. reduced motion ----------------------------------------------------------------

test('motion e2e: reduced motion keeps overlays working and still', async ({ page }) => {
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  await idle(page);
  // Turned on mid-session: from here nothing plays or is written.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await clearTrace(page);
  // WebKit can list a 0.01 ms transition as running (currentTime 0) for a few frames
  // after it starts: give it up to ten frames to end, then nothing may run. The retries
  // also outlast a 100 ms transition, so expectInstant is what proves the CSS reset.
  const still = async (what) => {
    let running = [];
    for (let i = 0; i < 5; i++) {
      await frames(page);
      running = await runningAnimations(page);
      if (!running.length) break;
    }
    expect(running, what).toEqual([]);
  };

  // A press: nothing.
  const trigger = page.locator('#list-view-menu-trigger');
  const p = await center(trigger);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const down = await page.evaluate(() => window.__presses.at(-1));
  expect(down.animations).toEqual([]);
  expect(await page.evaluate(() => window.RFMotion.activeCount())).toBe(0);
  expect(await trigger.evaluate((el) => el.getAttribute('style'))).toBeNull();

  // The menu opens and closes, still.
  await page.mouse.up();
  const pop = page.locator('#list-view-menu-popover');
  await expect(pop).toBeVisible();
  await expectInstant(pop, 'menu open');
  await still('menu open');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expectInstant(pop, 'menu closed');
  await still('menu closed');

  // The shortcuts dialog: open, closed, not modal after.
  await page.locator('body').focus();
  await page.keyboard.press('?');
  const dlg = page.locator('#shortcuts-dialog');
  await expect(dlg).toHaveJSProperty('open', true);
  await expectInstant(dlg, 'dialog open');
  await still('dialog open');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveJSProperty('open', false);
  expect(await dlg.evaluate((el) => el.matches(':modal'))).toBe(false);
  await expectInstant(dlg, 'dialog closed');
  await still('dialog closed');

  // A toast: arrives without an entrance, and leaves the DOM when closed.
  await page.evaluate(() => { window.__toast = window.RFToast.show({ msg: 'Motion e2e reduced toast', duration: -1 }); });
  const toast = toasts(page).filter({ hasText: 'Motion e2e reduced toast' });
  await expect(toast).toBeVisible();
  await expectInstant(toast, 'toast open');
  await still('toast open');
  await page.evaluate(() => window.__toast.close());
  await expect(toast).toHaveCount(0);
  await still('toast closed');

  expect(await traceNames(page)).toEqual([]);
  expect(await page.evaluate(() => window.RFMotion.activeCount())).toBe(0);

  // No View Transition from /app to /settings (pagereveal fires, without one).
  const rec = await navigateBy(page, page.locator('#sidebar a[href="/settings"]:visible').first(), '/settings');
  expect(rec.vt, JSON.stringify(rec)).toBe(false);

  // Carried check 1: switches (and their ::before thumbs) and a line tab's ::after
  // underline take 0.01 ms. The seed has no AI panel (the one line-tab user, gated on AI
  // config) and /dev/ui needs DEBUG, so the tab is the markup ui/nav.html emits.
  await page.goto('/settings/reading');
  const sw = page.locator('input[role=switch]').first();
  await expect(sw).toBeAttached();
  const durations = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'tabs';
    host.innerHTML = '<nav role="tablist" aria-orientation="horizontal" data-variant="line"><button type="button" role="tab" aria-selected="true" tabindex="0">One</button><button type="button" role="tab" aria-selected="false" tabindex="-1">Two</button></nav>';
    document.body.appendChild(host);
    const sw = document.querySelector('input[role=switch]');
    const tab = host.querySelector('[role=tab]');
    const out = {
      switch: getComputedStyle(sw).transitionDuration,
      switchBefore: getComputedStyle(sw, '::before').transitionDuration,
      tabAfter: getComputedStyle(tab, '::after').transitionDuration,
    };
    host.remove();
    return out;
  });
  for (const [k, v] of Object.entries(durations)) {
    expect(isInstant(v), `${k}: ${JSON.stringify(durations)}`).toBe(true);
  }
});

// ---- 5. between screens ---------------------------------------------------------------

test('motion e2e: navigating between screens cross-fades within --t-fast-max', async ({ page, browserName }, testInfo) => {
  await login(page, s.alice.email, s.password);
  await page.goto('/app');
  const supported = await page.evaluate(() => typeof document.startViewTransition === 'function' && 'onpagereveal' in window);

  // Carried check 2: #sidebar is a view-transition-name stacking context. The account
  // menu still opens inside the viewport and on top, and resting pixels (menu open and
  // closed) equal those without the name.
  const shot =() => page.screenshot({ animations: 'disabled', caret: 'hide' });
  // The same page with the name taken off #sidebar (an inline !important declaration, so
  // the CSP's style-src cannot block it), checked on the computed value both ways.
  const sidebarName = () => page.locator('#sidebar').evaluate((el) => getComputedStyle(el).viewTransitionName);
  const named = await sidebarName();
  if (supported) expect(named).toBe('rf-sidebar');
  const unnamed = async (fn) => {
    await page.locator('#sidebar').evaluate((el) => el.style.setProperty('view-transition-name', 'none', 'important'));
    try {
      expect(await sidebarName()).toBe('none');
      return await fn();
    } finally {
      await page.locator('#sidebar').evaluate((el) => el.style.removeProperty('view-transition-name'));
      expect(await sidebarName()).toBe(named);
    }
  };
  await idle(page);
  await frames(page);
  expect(await shot(), 'resting /app, with and without the name').toEqual(await unnamed(shot));
  const accTrigger = page.locator('#account-menu-trigger');
  const accPop = page.locator('#account-menu-popover');
  await accTrigger.click();
  await expect(accPop).toBeVisible();
  await page.waitForFunction(() => document.querySelector('#account-menu-popover').getAnimations({ subtree: true }).every((a) => a.playState !== 'running'));
  await idle(page);
  const fit = await accPop.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const corners = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]];
    return { inView: r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, hits: corners.map(([x, y]) => el.contains(document.elementFromPoint(x, y))) };
  });
  expect(fit, JSON.stringify(fit)).toEqual({ inView: true, hits: [true, true, true, true] });
  expect(await shot(), 'account menu open, with and without the name').toEqual(await unnamed(shot));
  await page.keyboard.press('Escape');
  await expect(accPop).toBeHidden();

  // /app -> /settings by the sidebar link.
  const rec = await navigateBy(page, page.locator('#sidebar a[href="/settings"]:visible').first(), '/settings');
  testInfo.annotations.push({ type: 'view transition /app -> /settings', description: JSON.stringify(rec) });
  if (browserName === 'chromium') {
    expect(supported).toBe(true);
    expect(rec.vt, JSON.stringify(rec)).toBe(true);
    const pseudos = rec.anims.map((a) => a.pseudo);
    expect(pseudos).toEqual(expect.arrayContaining(['::view-transition-old(root)', '::view-transition-new(root)']));
  } else if (rec.vt) {
    expect(rec.anims.length).toBeGreaterThan(0);
  }
  for (const a of rec.anims) expect(a.endTime, JSON.stringify(a)).toBeLessThanOrEqual(165);
  expect(rec.after, 'nothing of the transition is left').toBe(0);
  expect(rec.error ?? null).toBeNull();

  // Carried check 3, an observation: navigation started from an open overlay. The named
  // shell groups (old snapshots) paint above the root snapshot, scrim and toasts
  // included, for at most the transition. Recorded with a paused first frame; only what
  // persists after the transition fails.
  // `go` starts the navigation (a click, or Enter on a focused link that a toast covers).
  // `regions` are selectors whose box (inset, at most 160 px) is sampled before, on the
  // paused first frame and after; what is topmost at each centre beforehand is recorded.
  const observe = async (name, open, go, path, regions) => {
    await page.goto('/app');
    await idle(page);
    await open();
    await frames(page);
    const rects = [];
    for (const sel of regions) {
      const b = await page.locator(sel).first().boundingBox();
      const r = { x: b.x + 8, y: b.y + 8, width: Math.max(1, Math.min(b.width - 16, 160)), height: Math.max(1, Math.min(b.height - 16, 160)) };
      r.topmost = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return `${window.__label(el)} in ${window.__label(el?.closest('#sidebar, #tab-bar, .toast, dialog, [data-popover], #mobile-sidebar-backdrop'))}`;
      }, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
      rects.push([sel, r]);
    }
    const before = await shot();
    if (browserName === 'chromium') await page.evaluate(() => sessionStorage.setItem('rf-e2e-pause-vt', '1'));
    await Promise.all([page.waitForURL((u) => u.pathname.startsWith(path)), go()]);
    let paused = null;
    let during = null;
    if (browserName === 'chromium') {
      paused = await page.waitForFunction(() => window.__vt?.[0]?.paused || window.__vt?.[0]?.done, null, { polling: 'raf', timeout: 10_000 })
        .then(() => page.evaluate(() => !!window.__vt[0].paused)).catch(() => false);
      if (paused) {
        try { during = await page.screenshot({ caret: 'hide', timeout: 5_000 }); } catch { during = null; }
        await page.evaluate(() => window.__resumeVt && window.__resumeVt());
      }
    }
    await page.waitForFunction(() => window.__vt?.[0]?.done, null, { polling: 'raf', timeout: 15_000 });
    const after = await page.evaluate(() => ({ rec: window.__vt[0], left: window.__vtAnimations().length }));
    await page.evaluate(() => sessionStorage.removeItem('rf-e2e-pause-vt'));
    const final = await shot();
    const colours = {};
    for (const [sel, r] of rects) {
      colours[sel] = {
        topmost: r.topmost,
        before: await meanColour(page, before, r),
        firstFrame: during ? await meanColour(page, during, r) : null,
        after: await meanColour(page, final, r),
      };
    }
    const note = { paused, groups: after.rec.anims.map((a) => a.pseudo).filter((p) => !/\(root\)/.test(p)), colours, left: after.left };
    testInfo.annotations.push({ type: `overlay -> navigation: ${name}`, description: JSON.stringify(note) });
    console.log(`overlay -> navigation (${name}): ${JSON.stringify(note)}`);
    expect(after.left, `${name}: no transition left after it ended`).toBe(0);
    for (const a of after.rec.anims) expect(a.endTime, `${name}: ${JSON.stringify(a)}`).toBeLessThanOrEqual(165);
  };

  // Desktop: the command palette (a dialog with a scrim over the sidebar) -> Settings.
  await observe('palette over the sidebar',
    async () => {
      await page.locator('body').press('Control+k');
      await expect(page.locator('#rf-palette')).toHaveJSProperty('open', true);
      await page.locator('#rf-palette-input').fill('settings');
      await expect(page.locator('#rf-palette').getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
    },
    () => page.locator('#rf-palette').getByRole('menuitem', { name: 'Settings', exact: true }).click(),
    '/settings', ['#sidebar']);

  // Phone: a lasting toast and the sidebar sheet (a named group) -> Settings; sampled on
  // the toast and on the tab bar.
  await page.setViewportSize({ width: 390, height: 844 });
  await observe('sheet and toast over the tab bar',
    async () => {
      await page.evaluate(() => window.RFToast.show({ msg: 'Motion e2e lasting toast', duration: -1 }));
      await expect(toasts(page).filter({ hasText: 'Motion e2e lasting toast' })).toBeVisible();
      await page.getByRole('navigation', { name: 'Main' }).locator('.tab-bar-item').filter({ hasText: 'Folders' }).click();
      await expect(page.locator('#sidebar a[href="/settings"]:visible').first()).toBeVisible();
      await idle(page);
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
    },
    async () => {
      // The lasting toast sits over the sheet's footer links: Enter, as a keyboard user.
      await page.locator('#sidebar a[href="/settings"]:visible').first().focus();
      await page.keyboard.press('Enter');
    },
    '/settings', ['#toaster .toast:not([aria-hidden="true"])', '#tab-bar']);
});
