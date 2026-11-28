import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { motionCallHits, sourceFiles } from '../../scripts/check-motion-calls.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 'backend/app/templates';
const JS = 'backend/app/static/js';
const MOTION = `${JS}/ui/motion.js`;

const hits = (path, text) => motionCallHits([{ path, text }]);
const rules = (path, text) => hits(path, text).map((h) => `${h.line} ${h.rule}`);

test('motion calls: the repository passes', () => {
  const files = sourceFiles(REPO);
  const paths = new Set(files.map((f) => f.path));
  for (const p of [MOTION, `${JS}/app.js`, `${JS}/ui/read.js`, `${JS}/feeds-settings.js`, `${T}/dev/ui.html`, `${T}/base.html`]) {
    assert.ok(paths.has(p), `${p} is scanned`);
  }
  for (const p of paths) {
    assert.ok(!p.includes('/vendor/') && !p.endsWith('/htmx.min.js'), `${p} is not scanned`);
    assert.match(p, /^backend\/app\/(static\/js\/.*\.js|templates\/.*\.html)$/);
  }
  assert.ok(files.length > 150, `${files.length} files`);
  assert.deepEqual(motionCallHits(files), []);
});

test('motion calls: anime, animate and view transitions outside motion.js are reported, comments and script tags are not', () => {
  const js = [
    "anime.animate(el, { opacity: [0, 1] });",
    "var a = window.anime;",
    "el.animate([{ opacity: 0 }], 100);",
    "document.startViewTransition(fn);",
    "window.RFMotion.animate(el, {});",
    "// anime.animate(el); el.animate(); document.startViewTransition()",
    "/* RFMotion.animate(el) */ var s = 'a // b'; var u = '*/'; el.animate(x);",
  ].join('\n');
  assert.deepEqual(rules(`${JS}/x.js`, js), [
    '1 anime-call',
    '2 window-anime',
    '3 animate-call',
    '4 view-transition',
    '5 rfmotion-animate',
    '7 animate-call',
  ]);
  // Optional chaining and line breaks do not hide a call.
  const chained = [
    'el?.animate([], 1);', // 1
    'el.animate?.([], 1);', // 2
    'el', // 3
    '  .animate', // 4
    '  ([], 1);', // 5
    'el?.', // 6
    '  animate ?. ([], 1);', // 7
    'anime?.animate(el);', // 8
    'anime . animate?.(el);', // 9
    'var a = window?.anime;', // 10
    'var b = window', // 11
    '  .anime;', // 12
    'document?.startViewTransition?.(fn);', // 13
    'window.RFMotion?.animate(el, {});', // 14
    'RFMotion', // 15
    '  .animate?.(el, {});', // 16
    "window.RFMotion?.play('pop', el);", // 17
    'RFMotion.enter?.(document);', // 18
    'window.RFMotion?.transition(k, f);', // 19
    'window.RFMotion', // 20
    '  .play (1, el);', // 21
  ].join('\n');
  assert.deepEqual(rules(`${JS}/x.js`, chained), [
    '1 animate-call',
    '2 animate-call',
    '4 animate-call',
    '6 animate-call',
    '8 anime-call',
    '9 anime-call',
    '10 window-anime',
    '11 window-anime',
    '13 view-transition',
    '14 rfmotion-animate',
    '15 rfmotion-animate',
    '17 rfmotion-play',
    '18 rfmotion-enter',
    '19 rfmotion-transition',
    '20 rfmotion-play',
  ]);
  // A / after a keyword starts a regex, so its \// and \/* open no comment.
  const regexes = [
    'function f(u) { return /^\\//.test(u) && el.animate([], 1); }', // 1
    'function g(u) { return /^\\/*/.test(u); }', // 2
    'el.animate([], 1); /* end */', // 3
    'var t = typeof /\\//; el.animate(x);', // 4
    'switch (v) { case /\\//.source: el.animate(x); }', // 5
    'if (v) {} else /\\//.test(v), el.animate(x);', // 6
    'var r = o.return / 2; // el.animate()', // 7 division
    'var s = myreturn / 2; // el.animate()', // 8 division
    'var q = total /* c */ / 2; // el.animate()', // 9 division
    'return /* c */ /\\//.test(u) && el.animate(x);', // 10
  ].join('\n');
  assert.deepEqual(rules(`${JS}/x.js`, regexes), [
    '1 animate-call',
    '3 animate-call',
    '4 animate-call',
    '5 animate-call',
    '6 animate-call',
    '10 animate-call',
  ]);
  const html = [
    '{# anime.animate(el) and data-rf-vt in a Jinja comment #}',
    '<!-- el.animate() and document.startViewTransition() -->',
    "<script src=\"{{ static_url('js/vendor/anime/anime.umd.min.js') }}\" defer></script>",
    '<p>Engine: anime.js 4.5.0, see https://animejs.com/</p>',
    '<script>',
    '  // window.anime is read by motion.js',
    "  var url = 'https://x'; el.animate([], 1);",
    '</script>',
  ].join('\n');
  assert.deepEqual(rules(`${T}/page.html`, html), ['7 animate-call']);
  // motion.js itself may call anime.
  assert.deepEqual(hits(MOTION, 'var a = window.anime; a.waapi.animate(el, { opacity: [0, 1] });'), []);
});

test('motion calls: motion.js keeps the engine rules, except inside the legacy fence', () => {
  const engine = [
    "a.waapi.animate(el, { opacity: [0, 'none'] });", // 1 ok
    "a.waapi.animate(el, { persist: true });", // 2
    "inst.commitStyles();", // 3
    "a.waapi.animate(el, { x: [0, 8], translateY: [0, 1] });", // 4 x, 4 translateY
    "var k = { 'scaleX': 1, rotateZ: 2, skewX: 3 };", // 5 three keys
    "el.animate([], 1);", // 6
    "var t = c ? x : y; // persist: here is a comment, x: too", // 7 ok
  ].join('\n');
  assert.deepEqual(rules(MOTION, engine), [
    '2 persist',
    '3 commit-styles',
    '4 transform-key',
    '4 transform-key',
    '5 transform-key',
    '5 transform-key',
    '5 transform-key',
    '6 animate-call',
  ]);
  const chained = [
    'a.waapi?.animate(el, {});', // 1 ok
    'a.waapi', // 2
    '  .animate?.(el, {});', // 3 ok
    'a . waapi ?. animate (el, {});', // 4 ok
    'el?.animate([], 1);', // 5
    'el.animate?.([], 1);', // 6
    'el', // 7
    '  .animate', // 8
    '  ([], 1);', // 9
  ].join('\n');
  assert.deepEqual(rules(MOTION, chained), ['5 animate-call', '6 animate-call', '8 animate-call']);
  const fence = [
    'var ok = 1;',
    '  // rf-motion:legacy-animate start',
    "  var TRANSFORMS = { x: ['translateX', 'px'], scaleX: ['scaleX', ''], rotate: ['rotate', 'deg'] };",
    '  function animate(t, p) { return a.animate(t, p); }',
    '  // rf-motion:legacy-animate end',
  ];
  assert.deepEqual(hits(MOTION, fence.join('\n')), []);
  const second = [...fence.slice(0, 4), '  function again(t) { return a.animate(t, {}); }', fence[4]];
  assert.deepEqual(rules(MOTION, second.join('\n')), ['5 animate-call']);
  const secondChained = [...fence.slice(0, 4), '  function again(t) { return a?.animate?.(t, {}); }', fence[4]];
  assert.deepEqual(rules(MOTION, secondChained.join('\n')), ['5 animate-call']);
  // Outside the fence the same keys are reported; an unterminated fence exempts nothing.
  assert.deepEqual(rules(MOTION, `${fence[2]}`), ['1 transform-key', '1 transform-key', '1 transform-key']);
  assert.deepEqual(rules(MOTION, fence.slice(0, 4).join('\n')), [
    '2 legacy-fence-unterminated',
    '3 transform-key',
    '3 transform-key',
    '3 transform-key',
    '4 animate-call',
  ]);
});

test('motion calls: the allow list holds its upper bounds', () => {
  const run = (text) => rules(`${JS}/app.js`, text);
  const helper = [
    'function _shellTransition(key, fn) {',
    "  if (window.RFMotion) return RFMotion.transition(key, fn);",
    '  fn();',
    '}',
  ];
  const valid = [
    "_shellTransition('mobile-detail-open:on', open);",
    "_shellTransition('mobile-detail-open:off', function () { close(); });",
    "_shellTransition(\"story-detail-open:on\", open);",
    "_shellTransition('story-detail-open:off', close);",
    "_shellTransition(wasOpen === 'x' ? 'deeplink-detail-open:off' : 'story-detail-open:off', close);",
    "_shellTransition(open ? 'mobile-detail-open:on' : 'mobile-detail-open:off', fn);",
  ];
  assert.deepEqual(run([...helper, ...valid].join('\n')), []);
  const bad = [
    ...helper, // 1-4
    ...valid, // 5-10
    "_shellTransition('mobile-detail-open:on', open);", // 11: seventh
    "_shellTransition('foo:on', open);", // 12
    '_shellTransition(key, open);', // 13
    "_shellTransition(a ? 'story-detail-open:on' : b ? 'story-detail-open:off' : 'mobile-detail-open:on', f);", // 14
    'RFMotion.transition(k, f);', // 15
    "RFMotion.play('pop', el);", // 16
    'RFMotion.enter(el);', // 17
  ].join('\n');
  assert.deepEqual(run(bad), [
    '11 shell-transition-count',
    '12 shell-transition-key',
    '13 shell-transition-key',
    '14 shell-transition-key',
    '15 rfmotion-transition',
    '16 rfmotion-play',
    '17 rfmotion-enter',
  ]);
  // A second transition( inside the helper is over the bound.
  const twice = ['function _shellTransition(key, fn) {', '  RFMotion.transition(key, fn);', '  RFMotion.transition(key, fn);', '}'];
  assert.deepEqual(run(twice.join('\n')), ['3 rfmotion-transition']);
  // ?. and line breaks: the same homes and bounds.
  const chainedHelper = [
    'function _shellTransition(key, fn) {',
    '  if (window.RFMotion) return window.RFMotion?.transition?.(key, fn);',
    '}',
  ];
  assert.deepEqual(run(chainedHelper.join('\n')), []);
  assert.deepEqual(run([...chainedHelper, 'window.RFMotion', '  ?.transition (k, f);'].join('\n')), ['4 rfmotion-transition']);
  const six = [...valid.slice(0, 5), "_shellTransition?.(open ? 'mobile-detail-open:on' : 'mobile-detail-open:off', fn);"];
  assert.deepEqual(run(six.join('\n')), []);
  assert.deepEqual(run([...six, "_shellTransition ?. ('foo:on', f);"].join('\n')), ['7 shell-transition-count', '7 shell-transition-key']);
  // play names and homes.
  assert.deepEqual(rules(`${JS}/ui/read.js`, "RFMotion.play('swipe-snap', row, { from: dx });"), []);
  assert.deepEqual(rules(`${JS}/ui/read.js`, "RFMotion.play('pop', row);"), ['1 rfmotion-play']);
  assert.deepEqual(rules(`${JS}/feeds-settings.js`, "window.RFMotion.play('flash', row);"), []);
  assert.deepEqual(rules(`${JS}/feeds-settings.js`, "RFMotion.play('swipe-snap', row);"), ['1 rfmotion-play']);
  assert.deepEqual(rules(`${JS}/ui/other.js`, "RFMotion.play('flash', row);"), ['1 rfmotion-play']);
  assert.deepEqual(rules(`${T}/dev/ui.html`, '<script>RFMotion.play(name, target); RFMotion.enter(document);</script>'), []);
  assert.deepEqual(rules(`${T}/other.html`, '<script>RFMotion.enter(document);</script>'), ['1 rfmotion-enter']);
  assert.deepEqual(rules(`${JS}/ui/read.js`, "window.RFMotion?.play?.('swipe-snap', row);"), []);
  assert.deepEqual(rules(`${JS}/ui/read.js`, "RFMotion\n  .play\n  ('swipe-snap', row);"), []);
  assert.deepEqual(rules(`${JS}/ui/read.js`, "RFMotion?.play('pop', row);"), ['1 rfmotion-play']);
  assert.deepEqual(rules(`${JS}/feeds-settings.js`, "RFMotion.play ?. ('flash', row);"), []);
  assert.deepEqual(rules(`${T}/dev/ui.html`, '<script>RFMotion?.play(name, target); RFMotion.enter?.(document);</script>'), []);
  assert.deepEqual(rules(`${T}/other.html`, '<script>RFMotion?.enter?.(document);</script>'), ['1 rfmotion-enter']);
  // Reading RFMotion is not an animation call.
  assert.deepEqual(rules(`${JS}/ui/assistant.js`, 'if (window.RFMotion && RFMotion.reduced()) x = RFMotion.tokens.med;'), []);
});

test('motion calls: transitional calls are bounded and data-rf-vt stays out of templates', () => {
  const snap = "motion.animate(row, { x: [dx, 0] });";
  assert.deepEqual(rules(`${JS}/ui/read.js`, snap), []);
  assert.deepEqual(rules(`${JS}/ui/read.js`, `${snap}\n${snap}`), ['2 animate-call']);
  assert.deepEqual(rules(`${JS}/ui/read.js`, 'RFMotion.animate(row, {});'), ['1 rfmotion-animate']);
  const flash = 'window.RFMotion.animate(row, { duration: 1 });';
  assert.deepEqual(rules(`${JS}/feeds-settings.js`, flash), []);
  assert.deepEqual(rules(`${JS}/feeds-settings.js`, `${flash}\n${flash}`), ['2 rfmotion-animate']);
  assert.deepEqual(rules(`${JS}/feeds-settings.js`, 'row.animate([], 1);'), ['1 animate-call']);
  assert.deepEqual(rules(`${JS}/ui/sources.js`, flash), ['1 rfmotion-animate']);
  const snapChained = 'motion?.animate?.(row, {});';
  assert.deepEqual(rules(`${JS}/ui/read.js`, snapChained), []);
  assert.deepEqual(rules(`${JS}/ui/read.js`, `${snapChained}\nrow\n  .animate ([]);`), ['3 animate-call']);
  for (const chained of ['window.RFMotion?.animate(row, {});', 'RFMotion.animate?.(row, {});', 'RFMotion ?. animate (row, {});']) {
    assert.deepEqual(rules(`${JS}/feeds-settings.js`, chained), [], chained);
    assert.deepEqual(rules(`${JS}/feeds-settings.js`, `${chained}\n${chained}`), ['2 rfmotion-animate'], chained);
  }
  assert.deepEqual(rules(`${T}/base.html`, '<html lang="en">\n<body data-rf-vt>'), ['2 data-rf-vt']);
  assert.deepEqual(rules(`${T}/base.html`, '{# data-rf-vt is set by app.js #}\n<!-- data-rf-vt -->'), []);
  assert.deepEqual(rules(`${JS}/app.js`, "document.documentElement.setAttribute('data-rf-vt', '');"), []);
});
