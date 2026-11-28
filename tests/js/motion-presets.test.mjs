// The motion engine of static/js/ui/motion.js: RFMotion.play over anime.waapi.animate,
// the preset registry, the trimmed springs, the cascade and the press wiring.
//
// jsdom has no Element.animate, so each test loads the real motion.js next to a stub
// anime whose waapi.animate records { target, params } and returns a fake instance
// ({ animations: [{ cancel }], complete, revert, cancel }); calling
// params.onComplete(instance) is how a test finishes it. The spring maths runs on the
// real vendored anime.umd.min.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOTION_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'ui', 'motion.js');
const ANIME_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'vendor', 'anime', 'anime.umd.min.js');
const TIMING = new Set(['duration', 'delay', 'endDelay', 'ease', 'onComplete', 'autoplay', 'composition']);
const KEYS = new Set(['opacity', 'scale', 'translate']);

function stubAnime(log = []) {
  const calls = [];
  const anime = {
    calls,
    log,
    waapi: {
      animate(target, params) {
        const keys = Object.keys(params).filter((k) => !TIMING.has(k));
        const inst = {
          target, params, keys, reverted: 0, completed: 0, cancelled: 0,
          animations: keys.map((property) => ({
            property, cancelled: 0,
            cancel() { this.cancelled++; log.push('cancel:' + property); },
          })),
          complete() { this.completed++; },
          revert() { this.reverted++; },
          cancel() { this.cancelled++; },
        };
        inst.finish = () => params.onComplete(inst);
        calls.push(inst);
        return inst;
      },
      convertEase: (fn) => 'linear(' + [0, 0.25, 0.5, 0.75, 1].map((t) => +fn(t).toFixed(4)).join(', ') + ')',
    },
    spring: ({ bounce, duration }) => ({
      bounce, duration, settlingDuration: duration * 3, ease: (t) => 1 - Math.pow(1 - t, 3),
    }),
  };
  return anime;
}

function load({ reduced = false, anime = stubAnime(), body = '', setup, times = 1, scripts = [MOTION_JS] } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://readfine.test/',
    beforeParse(w) {
      if (anime) w.anime = anime;
      w.__reduced = reduced;
      w.matchMedia = (q) => ({
        matches: q === '(prefers-reduced-motion: reduce)' ? w.__reduced : false,
        media: q, addEventListener() {}, removeEventListener() {},
      });
      if (setup) setup(w);
    },
  });
  const w = dom.window;
  for (let i = 0; i < times; i++) {
    for (const file of scripts) {
      const script = w.document.createElement('script');
      script.textContent = fs.readFileSync(file, 'utf8');
      w.document.head.appendChild(script);
    }
  }
  return { w, anime, $: (sel) => w.document.querySelector(sel) };
}

function pointer(w, el, type = 'pointerdown') {
  const e = new w.PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true, button: 0 });
  el.dispatchEvent(e);
  return e;
}

function key(w, el, k, repeat = false) {
  const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, repeat });
  el.dispatchEvent(e);
  return e;
}

// All rects at row i of a 20 px list; rows from `visible` on sit far below the viewport.
function rows(w, visible) {
  w.Element.prototype.getBoundingClientRect = function () {
    const parent = this.parentElement;
    const i = parent ? Array.prototype.indexOf.call(parent.children, this) : 0;
    const top = this.tagName === 'LI' && i >= visible ? 5000 + i * 20 : i * 20;
    return { top, bottom: top + 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: top };
  };
}

const last = (arr) => arr[arr.length - 1];

test('motion core: loads once; reduced motion, a hidden tab or no anime.waapi play nothing and write nothing', async () => {
  // Two loads: one RFMotion, one set of listeners.
  const twice = load({ times: 2, body: '<button id="b">Go</button>' });
  const first = twice.w.RFMotion;
  assert.equal(typeof first.play, 'function');
  pointer(twice.w, twice.$('#b'));
  assert.equal(twice.anime.calls.length, 1, 'one call per pointerdown after two loads');
  assert.equal(twice.w.RFMotion, first);

  // Reduced motion: nothing plays, nothing is written, nothing is counted.
  const red = load({ reduced: true, body: '<div id="a"></div><button id="b">Go</button>' });
  const a = red.$('#a');
  for (const name of Object.keys(red.w.RFMotion.presets)) {
    assert.equal(red.w.RFMotion.play(name, a), null, name + ' under reduced motion');
  }
  pointer(red.w, red.$('#b'));
  key(red.w, red.$('#b'), 'Enter');
  red.w.RFMotion.enter(red.w.document);
  assert.equal(red.anime.calls.length, 0, 'no waapi.animate call');
  assert.equal(a.getAttribute('style'), null);
  assert.equal(red.$('#b').getAttribute('style'), null);
  assert.equal(red.w.RFMotion.activeCount(), 0);
  await red.w.RFMotion.idle();

  // Read per call: flipping the preference between plays takes effect at once.
  const flip = load({ body: '<div id="a"></div>' });
  assert.ok(flip.w.RFMotion.play('fade-up', flip.$('#a')));
  flip.w.__reduced = true;
  assert.equal(flip.w.RFMotion.play('fade-up', flip.$('#a')), null);
  assert.equal(flip.anime.calls.length, 1);

  // A hidden tab plays nothing.
  const hidden = load({
    body: '<div id="a"></div>',
    setup(w) { Object.defineProperty(w.document, 'hidden', { configurable: true, get: () => true }); },
  });
  assert.equal(hidden.w.RFMotion.play('pop', hidden.$('#a')), null);
  assert.equal(hidden.anime.calls.length, 0);

  // anime without waapi, or no anime at all: no throw, no writes, idle resolves.
  for (const anime of [{}, null]) {
    const bare = load({ anime, body: '<div id="a"></div><button id="b">Go</button>' });
    assert.equal(bare.w.RFMotion.play('fade-up', bare.$('#a')), null);
    assert.doesNotThrow(() => pointer(bare.w, bare.$('#b')));
    assert.equal(bare.$('#a').getAttribute('style'), null);
    assert.equal(bare.$('#b').getAttribute('style'), null);
    assert.equal(bare.w.RFMotion.activeCount(), 0);
    await bare.w.RFMotion.idle();
  }
  // Unknown names and detached targets: null.
  assert.equal(flip.w.RFMotion.play('no-such-preset', flip.$('#a')), null);
  flip.w.__reduced = false;
  assert.equal(flip.w.RFMotion.play('pop', flip.w.document.createElement('div')), null);
});

test('motion springs: each named spring fits its budget and ends at 1 on the real bundle', () => {
  const warns = [];
  const { w } = load({
    anime: null,
    scripts: [ANIME_JS, MOTION_JS],
    setup(win) { win.console.warn = (...args) => warns.push(args.join(' ')); },
  });
  assert.equal(typeof w.anime.waapi.animate, 'function', 'the real bundle is loaded');
  const { springs, springEase } = w.RFMotion;
  assert.ok(Object.isFrozen(springs));
  const budgets = { press: 165, pop: 400, panel: 400, snap: 165 };
  assert.deepEqual(Object.keys(springs).sort(), Object.keys(budgets).sort());
  for (const [name, budget] of Object.entries(budgets)) {
    const spec = springs[name];
    assert.equal(spec.budget, budget, name + ' budget');
    const se = springEase(name);
    assert.ok(se.duration > 0 && se.duration <= budget, name + ' duration ' + se.duration);
    assert.match(se.ease, /^linear\(0, .*, 1\)$/, name + ' ends at 1');
    const s = w.anime.spring({ bounce: spec.bounce, duration: spec.duration });
    const k = Math.min(1, budget / s.settlingDuration);
    assert.ok(Math.abs(1 - s.ease(k)) <= 0.02, name + ' residue ' + (1 - s.ease(k)));
  }
  assert.equal(springEase('nope'), null);
  assert.deepEqual(warns, [], 'no console.warn (no createSpring, no string eases)');
});

test('motion cascade: list-enter animates at most 10 visible children, 20 ms apart, and ends by --t-med-max', () => {
  const items = Array.from({ length: 200 }, (_, i) => '<li id="i' + i + '">' + i + '</li>').join('');
  const { w, anime, $ } = load({ body: '<ul id="list" data-motion="list-enter">' + items + '</ul>', setup: (win) => rows(win, 30) });
  const list = $('#list');
  const handle = w.RFMotion.play('list-enter', list);
  assert.ok(handle && typeof handle.stop === 'function' && typeof handle.finished.then === 'function');
  assert.deepEqual(anime.calls.map((c) => c.target.id), Array.from({ length: 10 }, (_, i) => 'i' + i));
  assert.deepEqual(anime.calls.map((c) => c.params.delay), [0, 20, 40, 60, 80, 100, 120, 140, 160, 180]);
  for (const c of anime.calls) {
    assert.ok(c.params.duration <= 165, 'each child within --t-fast-max');
    assert.ok(c.params.delay + c.params.duration <= 400, 'the cascade ends by --t-med-max');
  }

  // enter() goes through the same preset; every value it passes is a keyframe array.
  const again = load({ body: '<main id="t"></main>', setup: (win) => rows(win, 30) });
  const t = again.$('#t');
  t.innerHTML = '<ul data-motion="list-enter"><li></li><li></li><li></li></ul><p data-motion="fade-up"></p><b data-motion="pop"></b>';
  again.w.RFMotion.enter(t);
  assert.equal(again.anime.calls.length, 5);
  for (const c of again.anime.calls) {
    for (const k of c.keys) assert.ok(Array.isArray(c.params[k]), k + ' is an array');
  }
});

test('motion engine: every preset follows the five rules', async () => {
  const log = [];
  const anime = stubAnime(log);
  const { w, $ } = load({
    anime,
    body: '<div id="host"></div><button id="btn">B</button><div id="row" style="transform: translateX(40px)"></div>',
    setup(win) {
      const real = win.getComputedStyle.bind(win);
      win.getComputedStyle = (el, pseudo) => {
        const cs = real(el, pseudo);
        if (el && el.id === 'faded') {
          return new Proxy(cs, {
            get(target, prop) {
              if (prop === 'opacity') { log.push('read:opacity'); return '0.75'; }
              const v = target[prop];
              return typeof v === 'function' ? v.bind(target) : v;
            },
          });
        }
        return cs;
      };
    },
  });
  const M = w.RFMotion;
  assert.ok(Object.isFrozen(M.presets));
  const names = Object.keys(M.presets);
  assert.deepEqual(names.sort(), ['fade-up', 'fade-up-short', 'list-enter', 'pop', 'press', 'press-soft']);

  for (const name of names) {
    const spec = M.presets[name];
    assert.ok(!('exception' in spec), name + ' has no exception');
    for (const k of spec.keys) assert.ok(KEYS.has(k), name + ' key ' + k);
    const el = w.document.createElement('div');
    el.innerHTML = '<span></span><span></span>';
    $('#host').appendChild(el);
    const before = anime.calls.length;
    const handle = M.play(name, el);
    assert.ok(handle, name + ' plays');
    const made = anime.calls.slice(before);
    assert.ok(made.length >= 1);
    for (const c of made) {
      assert.equal(typeof c.params.onComplete, 'function', name + ' onComplete');
      assert.ok(!('persist' in c.params), name + ' never persist');
      for (const k of c.keys) {
        assert.ok(KEYS.has(k), name + ' animates ' + k);
        assert.ok(Array.isArray(c.params[k]), name + ' ' + k + ' is an array');
        if (k === 'scale' || k === 'translate') assert.equal(last(c.params[k]), 'none', name + ' ' + k + ' ends at rest');
        if (k === 'opacity') assert.equal(last(c.params[k]), '1', name + ' opacity ends at rest');
      }
      assert.ok(c.params.delay + c.params.duration <= 700);
      if (spec.frequent) assert.ok(c.params.delay + c.params.duration <= 165, name + ' frequent');
    }
    assert.ok(M.activeCount() >= made.length);
    for (const c of made) c.finish();
    for (const c of made) assert.equal(c.reverted, 1, name + ' reverts in onComplete');
    assert.equal(M.activeCount(), 0, name + ' count back to 0');
  }

  // Opacity ends on the computed value, read after this element's own animations stop.
  const faded = w.document.createElement('div');
  faded.id = 'faded';
  $('#host').appendChild(faded);
  const pop = M.play('pop', faded);
  const popInst = last(anime.calls);
  log.length = 0;
  M.play('fade-up', faded);
  const fade = last(anime.calls);
  assert.equal(last(fade.params.opacity), '0.75');
  assert.ok(log.indexOf('cancel:opacity') > -1 && log.indexOf('cancel:opacity') < log.lastIndexOf('read:opacity'), log.join(' '));
  assert.ok(popInst.animations.every((a) => a.cancelled === 1), 'the whole pop instance stops');
  assert.equal(popInst.reverted + popInst.cancelled + popInst.completed, 0, 'native cancel only');
  await pop.finished;

  // A running CSS opacity transition: no opacity preset on that target; a press still plays.
  const busy = w.document.createElement('button');
  busy.getAnimations = () => [{ transitionProperty: 'opacity', playState: 'running' }];
  $('#host').appendChild(busy);
  const n = anime.calls.length;
  assert.equal(M.play('fade-up', busy), null);
  assert.equal(anime.calls.length, n);
  assert.ok(M.play('press', busy));

  // stop(): native cancel() on the instance's animations, nothing else.
  const h = M.play('fade-up-short', $('#host'));
  const inst = last(anime.calls);
  h.stop();
  assert.ok(inst.animations.every((a) => a.cancelled === 1));
  assert.equal(inst.reverted + inst.cancelled + inst.completed, 0);
  inst.finish();
  assert.equal(inst.reverted, 1, 'the late onComplete still reverts');

  // A press in the middle of a pop on the same button cancels both pop animations.
  const btn = $('#btn');
  M.play('pop', btn);
  const btnPop = last(anime.calls);
  M.play('press', btn);
  assert.deepEqual(btnPop.animations.map((a) => [a.property, a.cancelled]), [['opacity', 1], ['scale', 1]]);

  // An inline transform (the swipe's) survives a press.
  const row = $('#row');
  M.play('press', row);
  const press = last(anime.calls);
  assert.ok(!('transform' in press.params));
  press.finish();
  assert.equal(row.style.transform, 'translateX(40px)');

  // trace only while <html> carries data-rf-motion-trace.
  for (const c of anime.calls) if (!c.reverted) c.finish();
  assert.equal(M.trace.length, 0);
  w.document.documentElement.setAttribute('data-rf-motion-trace', '');
  M.play('pop', btn);
  assert.equal(M.trace.length, 1);
  assert.equal(M.trace[0].name, 'pop');
  assert.equal(M.trace[0].target, btn);
  assert.equal(typeof M.trace[0].t, 'number');
  last(anime.calls).finish();
  assert.equal(M.activeCount(), 0);
  await M.idle();

  // The registry rejects duplicates and keys outside the whitelist.
  assert.throws(() => M.definePreset('pop', { keys: ['opacity'], budget: 100, build: () => [] }));
  assert.throws(() => M.definePreset('slide', { keys: ['x'], budget: 100, build: () => [] }));
  assert.throws(() => M.definePreset('sheet', { keys: ['transform'], budget: 100, build: () => [] }));
  M.definePreset('sheet-out', { keys: ['transform', 'visibility'], budget: 400, exception: 'visibility', build: () => [] });
  assert.equal(M.presets['sheet-out'].exception, 'visibility');
});

test('motion press: one scale call per pointerdown, none on release, skipped targets, second press stops the first', () => {
  const { w, anime, $ } = load({
    body: '<button id="b">B</button>'
      + '<button id="dis" disabled>D</button><button id="aria" aria-disabled="true">A</button>'
      + '<button id="off" data-motion-press="off">O</button>'
      + '<div class="article-row" id="swiped" data-rf-swipe="right" hx-trigger="click"><button id="in-swipe">S</button></div>'
      + '<div role="option" id="opt"><input id="field" type="text"></div>'
      + '<p>text <a id="inline" href="/x">link</a></p>'
      + '<aside id="sidebar" hx-get="/htmx/sidebar" hx-trigger="load"><a id="side" href="/f" style="display:block">Feed</a></aside>'
      + '<div class="article-row" id="row" hx-get="/a/1" hx-trigger="click">Row</div>'
      + '<div role="button" id="wrap"><form id="form" hx-post="/save">'
      + '<label id="form-label" for="form-check">L</label><div id="form-gap"></div>'
      + '<input id="form-check" type="checkbox"><button id="form-button">Save</button></form></div>',
  });
  const M = w.RFMotion;
  const b = $('#b');
  const down = pointer(w, b);
  assert.equal(anime.calls.length, 1, 'one call per pointerdown');
  const first = anime.calls[0];
  assert.deepEqual(first.keys, ['scale']);
  const [from, dip, rest] = first.params.scale;
  assert.equal(first.params.scale.length, 3);
  assert.equal(from, 1);
  assert.ok(dip < 1 && dip > 0.9, 'dip ' + dip);
  assert.equal(rest, 'none');
  assert.equal(first.params.ease, M.springEase('press').ease, 'the press spring');
  assert.ok(first.params.duration + first.params.delay <= 165);
  assert.equal(down.defaultPrevented, false, 'never preventDefault');

  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) pointer(w, b, type);
  assert.equal(anime.calls.length, 1, 'nothing on release');
  assert.equal(first.animations[0].cancelled, 0, 'release stops nothing');

  for (const id of ['dis', 'aria', 'off', 'in-swipe', 'swiped', 'field', 'inline', 'sidebar']) pointer(w, $('#' + id));
  assert.equal(anime.calls.length, 1, 'skipped targets play nothing');

  // A form is never a press target, nor is whatever merely wraps it; its controls are.
  for (const id of ['form-label', 'form-gap', 'form-check', 'form']) pointer(w, $('#' + id));
  assert.equal(anime.calls.length, 1, 'a form and its non-controls play nothing');
  pointer(w, $('#form-button'));
  assert.equal(anime.calls.length, 2, 'a button inside a form presses');
  assert.equal(last(anime.calls).target.id, 'form-button', 'the button presses itself');
  assert.equal(last(anime.calls).params.scale[1], dip, 'with the normal dip');

  pointer(w, $('#row'));
  assert.deepEqual([...last(anime.calls).params.scale.slice(0, 2)], [1, 0.985], '.article-row presses soft');
  pointer(w, $('#side'));
  assert.equal(last(anime.calls).params.scale[1], 0.985, '#sidebar a presses soft');
  assert.equal(last(anime.calls).target.id, 'side');

  const n = anime.calls.length;
  key(w, b, 'Enter');
  assert.equal(anime.calls.length, n + 1, 'Enter presses once');
  key(w, b, 'Enter', true);
  assert.equal(anime.calls.length, n + 1, 'no press on key repeat');
  key(w, b, ' ');
  assert.equal(anime.calls.length, n + 2, 'Space presses');
  key(w, $('#field'), ' ');
  assert.equal(anime.calls.length, n + 2, 'typing in a field presses nothing');

  // A second press on the same button stops the first before starting.
  const c = $('#b');
  pointer(w, c);
  const one = last(anime.calls);
  pointer(w, c);
  const two = last(anime.calls);
  assert.notEqual(one, two);
  assert.equal(one.animations[0].cancelled, 1, 'the first press is cancelled');
  assert.equal(two.params.scale[0], 1, 'the second starts from 1');
});
