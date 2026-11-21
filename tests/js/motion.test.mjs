// static/js/ui/motion.js is the motion layer: a classic script that wraps the vendored
// anime.js UMD (window.anime) as window.RFMotion. Motion must be instant under
// prefers-reduced-motion, every animation is capped at --t-slow, enter animations run
// once per element after an htmx swap, and View Transitions never overlap.
//
// Each test loads the real motion.js into jsdom next to a stub anime that records its
// calls, so the tests see exactly what motion.js asks anime.js to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOTION_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'ui', 'motion.js');

function stubAnime() {
  const calls = { animate: [], set: [], stagger: [], spring: [] };
  const anime = {
    calls,
    animate(targets, params) {
      calls.animate.push({ targets, params });
      return { then: (fn) => Promise.resolve(fn && fn()) };
    },
    utils: {
      set(targets, props) { calls.set.push({ targets, props }); },
    },
    stagger(value, opts) { calls.stagger.push({ value, opts }); return () => value; },
    spring(opts) { calls.spring.push(opts); return 'spring-ease'; },
  };
  return anime;
}

// Read inside each test, so a missing motion.js fails every test, not the file.
function load({ reduced = false, anime = stubAnime(), body = '', head = '', setup } = {}) {
  const source = fs.readFileSync(MOTION_JS, 'utf8');
  const dom = new JSDOM('<!doctype html><html><head>' + head + '</head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/',
    beforeParse(w) {
      if (anime) w.anime = anime;
      w.matchMedia = (q) => ({
        matches: q === '(prefers-reduced-motion: reduce)' ? reduced : false,
        media: q, addEventListener() {}, removeEventListener() {},
      });
      if (setup) setup(w);
    },
  });
  const w = dom.window;
  const script = w.document.createElement('script');
  script.textContent = source;
  w.document.head.appendChild(script);
  return { w, anime, source };
}

function afterSwap(w, target) {
  w.document.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { detail: { target } }));
}

test('motion: reduced motion sets end state instantly and never calls anime.animate', async () => {
  const { w, anime, source } = load({ reduced: true, body: '<div id="a"></div>' });
  // CSP: no eval, no Function constructor, no inline handler strings.
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b|\bon[a-z]+\s*=\s*["']/);
  assert.equal(w.RFMotion.reduced(), true);

  const el = w.document.getElementById('a');
  let completed = 0;
  const params = { opacity: [0, 1], y: { from: 12, to: 0 }, duration: 300, delay: 50, onComplete: () => completed++ };
  const result = w.RFMotion.animate(el, params);
  assert.equal(anime.calls.animate.length, 0, 'anime.animate is never called');
  assert.equal(anime.calls.set.length, 1);
  assert.deepEqual({ ...anime.calls.set[0].props }, { opacity: 1, y: 0 }, 'end state only, no timing keys');
  assert.ok(anime.calls.set[0].props !== params, 'set gets a copy');
  assert.equal(completed, 1, 'onComplete runs once');
  assert.equal(await result, undefined, 'the result settles under await');

  // stagger and spring are no-ops, and anime is not consulted.
  assert.equal(typeof w.RFMotion.stagger(40), 'function');
  assert.equal(w.RFMotion.stagger(40)(el, 3), 0);
  assert.equal(anime.calls.stagger.length, 0);
  assert.equal(w.RFMotion.spring({ bounce: 0.3 }), undefined);
  assert.equal(anime.calls.spring.length, 0);

  // Without anime at all, the end state goes straight onto the element's style.
  const bare = load({ reduced: false, anime: null, body: '<div id="b"></div>' });
  const b = bare.w.document.getElementById('b');
  await bare.w.RFMotion.animate(b, { opacity: [0, 1], y: [8, 0], scale: [0.9, 1] });
  assert.equal(b.style.opacity, '1');
  assert.equal(b.style.transform, 'translateY(0px) scale(1)');
});

test('motion: enter runs once per element on afterSwap', () => {
  const { w, anime } = load({ body: '<div id="old" data-motion="fade-up"></div><main id="t"></main>' });
  assert.equal(anime.calls.animate.length, 0, 'nothing runs before a swap');

  const target = w.document.getElementById('t');
  target.innerHTML = '<p data-motion="fade-up"></p><ul data-motion="list-enter"><li></li><li></li></ul>'
    + '<span data-motion="pop"></span><b data-motion="unknown"></b>';
  afterSwap(w, target);

  assert.equal(anime.calls.animate.length, 3, 'one animation per known kind');
  const [fade, list, pop] = anime.calls.animate;
  assert.equal(fade.targets, target.querySelector('p'));
  assert.deepEqual([...list.targets], [...target.querySelectorAll('li')], 'list-enter animates the children');
  assert.equal(anime.calls.stagger.length, 1, 'list-enter staggers');
  assert.equal(pop.targets, target.querySelector('span'));
  for (const el of target.querySelectorAll('[data-motion]')) {
    assert.ok(el.hasAttribute('data-motion-done'), el.tagName + ' is marked done');
  }
  assert.ok(!w.document.getElementById('old').hasAttribute('data-motion-done'), 'only the swap target is scanned');

  afterSwap(w, target);
  assert.equal(anime.calls.animate.length, 3, 'a second swap event replays nothing');

  target.insertAdjacentHTML('beforeend', '<i data-motion="pop"></i>');
  afterSwap(w, target);
  assert.equal(anime.calls.animate.length, 4, 'only the new element runs');

  // The swap target itself can carry data-motion.
  const self = w.document.createElement('section');
  self.setAttribute('data-motion', 'fade-up');
  w.document.body.appendChild(self);
  afterSwap(w, self);
  assert.equal(anime.calls.animate[4].targets, self);
});

test('motion: transition skips a running view transition and falls back without the API', async () => {
  const started = [];
  const withApi = load({
    setup(w) {
      w.document.startViewTransition = (update) => {
        const vt = {
          skipped: 0,
          skipTransition() { this.skipped++; },
          finished: new Promise(() => {}),
          ready: Promise.reject(new Error('skipped')),
          updateCallbackDone: Promise.resolve(),
        };
        update();
        started.push(vt);
        return vt;
      };
    },
  });
  let updates = 0;
  withApi.w.RFMotion.transition(() => updates++);
  withApi.w.RFMotion.transition(() => updates++);
  assert.equal(started.length, 2);
  assert.equal(started[0].skipped, 1, 'the running transition is skipped first');
  assert.equal(started[1].skipped, 0);
  assert.equal(updates, 2);

  // No API: update runs directly and synchronously.
  const bare = load();
  let ran = 0;
  const res = bare.w.RFMotion.transition(() => ran++);
  assert.equal(ran, 1);
  await res.finished;

  // Reduced motion with the API present: the API is not used.
  let calledApi = 0;
  const reduced = load({
    reduced: true,
    setup(w) { w.document.startViewTransition = () => { calledApi++; return {}; }; },
  });
  let ranReduced = 0;
  await reduced.w.RFMotion.transition(() => ranReduced++).finished;
  assert.equal(calledApi, 0);
  assert.equal(ranReduced, 1);
});

test('motion: durations are capped at --t-slow', () => {
  const defaults = load();
  assert.deepEqual({ ...defaults.w.RFMotion.tokens }, { fast: 125, fastMax: 165, med: 300, medMax: 400, slow: 700 });

  // Values come from the CSS variables; the minifier may write them in seconds.
  const vars = { '--t-fast': ' 100ms', '--t-fast-max': '.15s', '--t-med': '250ms', '--t-med-max': 'junk', '--t-slow': '.5s' };
  const { w, anime } = load({
    setup(win) {
      const real = win.getComputedStyle.bind(win);
      win.getComputedStyle = (el, pseudo) => {
        const cs = real(el, pseudo);
        return { getPropertyValue: (name) => (name in vars ? vars[name] : cs.getPropertyValue(name)) };
      };
    },
    body: '<div id="a"></div>',
  });
  assert.deepEqual({ ...w.RFMotion.tokens }, { fast: 100, fastMax: 150, med: 250, medMax: 400, slow: 500 });

  const el = w.document.getElementById('a');
  w.RFMotion.animate(el, { opacity: [0, 1], duration: 5000 });
  w.RFMotion.animate(el, { opacity: [0, 1] });
  w.RFMotion.animate(el, { opacity: { to: 1, duration: 9000 }, duration: 200 });
  w.RFMotion.animate(el, { opacity: 1, duration: () => 4000 });
  const p = anime.calls.animate.map((c) => c.params);
  assert.equal(p[0].duration, 500, 'an explicit long duration is capped');
  assert.equal(p[1].duration, 250, 'a missing duration defaults to --t-med, not anime\'s 1000');
  assert.equal(p[2].duration, 200);
  assert.equal(p[2].opacity.duration, 500, 'per-property durations are capped');
  assert.equal(p[3].duration(el, 0, 1), 500, 'function durations are capped');
});
