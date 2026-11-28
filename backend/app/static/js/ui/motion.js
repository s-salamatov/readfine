// Readfine motion layer: window.RFMotion over the vendored anime.js UMD (window.anime).
//
// A classic script, loaded deferred after anime.umd.min.js. It is the only place that
// animates (design: docs/arh-w-dev/designs/2026-11-28-motion-design.md, §6.1):
//   - core: tokens, reduced(), the engine run() over anime.waapi.animate, springs;
//   - the preset registry and RFMotion.play(name, target) as the one way in;
//   - wiring: presses (pointerdown / Enter / Space) and entrances (data-motion);
//   - RFMotion.transition for View Transitions; the trace tests read.
// Under prefers-reduced-motion: reduce, in a hidden tab or without anime.waapi no
// preset plays and nothing is written: the end state is already in the DOM.
// Durations come from the motion tokens in styles/tokens.css; the View Transition cap
// and the reduced-motion CSS reset live in styles/motion.css.
//
// Markup opts in with data-motion="fade-up|fade-up-short|pop|list-enter";
// RFMotion.enter(root) plays each element once and marks it data-motion-done. Nothing
// plays on first paint. data-motion-press="off|soft" tunes the press.
(function () {
  'use strict';
  if (window.RFMotion) return;

  var DEFAULTS = { fast: 125, fastMax: 165, med: 300, medMax: 400, slow: 700 };
  var VARS = { fast: '--t-fast', fastMax: '--t-fast-max', med: '--t-med', medMax: '--t-med-max', slow: '--t-slow' };
  var DONE = 'data-motion-done';
  var TRACE_ATTR = 'data-rf-motion-trace';
  var EASE_OUT = 'cubic-bezier(0, 0, 0.2, 1)';

  // "125ms", ".7s" or " 0.3s " -> milliseconds; anything else -> fallback.
  function toMs(raw, fallback) {
    var s = String(raw == null ? '' : raw).trim();
    var m = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/.exec(s);
    if (!m) return fallback;
    var n = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function rootVar(name) {
    try {
      return String(window.getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim();
    } catch (e) {
      return '';
    }
  }

  function readTokens() {
    var out = {};
    for (var k in DEFAULTS) out[k] = toMs(rootVar(VARS[k]), DEFAULTS[k]);
    return out;
  }

  var tokens = readTokens();

  // Read per call: styles/tokens.css may arrive after this script.
  function staggerStep() { return toMs(rootVar('--rf-stagger-step'), 20); }
  function staggerMax() {
    var n = parseInt(rootVar('--rf-stagger-max'), 10);
    return n > 0 && n <= 50 ? n : 10;
  }
  function easeOut() {
    var v = rootVar('--rf-ease-out');
    return /^cubic-bezier\(/.test(v) ? v : EASE_OUT;
  }

  function anime() { return window.anime || null; }

  function reduced() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function rethrow(e) { setTimeout(function () { throw e; }); }

  // --- springs ------------------------------------------------------------------
  //
  // anime 4.5.0 settles a spring only at full rest (440-740 ms here), far past the
  // budget, so springEase trims the invisible tail at the budget and normalises the
  // curve to end exactly at 1 (the last frame is the rest value, rule 3).
  var springs = Object.freeze({
    press: Object.freeze({ bounce: 0.35, duration: 140, budget: tokens.fastMax }),
    pop: Object.freeze({ bounce: 0.5, duration: 220, budget: tokens.medMax }),
    panel: Object.freeze({ bounce: 0.15, duration: 280, budget: tokens.medMax }),
    snap: Object.freeze({ bounce: 0.25, duration: 160, budget: tokens.fastMax }),
  });
  var springCache = {};

  function springEase(name) {
    if (!has(springs, name)) return null;
    if (springCache[name]) return springCache[name];
    var a = anime();
    if (!a || typeof a.spring !== 'function' || !a.waapi || typeof a.waapi.convertEase !== 'function') return null;
    var spec = springs[name];
    var s = a.spring({ bounce: spec.bounce, duration: spec.duration });
    var settle = s && s.settlingDuration;
    if (!(settle > 0) || typeof s.ease !== 'function') return null;
    var k = Math.min(1, spec.budget / settle);
    var end = s.ease(k);
    if (!(end > 0)) return null;
    var ease = a.waapi.convertEase(function (t) { return s.ease(t * k) / end; });
    springCache[name] = Object.freeze({ ease: ease, duration: Math.min(settle, spec.budget) });
    return springCache[name];
  }

  // --- the engine ---------------------------------------------------------------
  //
  // Every preset animation goes through run(): one anime.waapi.animate instance per
  // target per call, under the five rules of design §6.1:
  //   1. onComplete reverts the instance (native finish, cancel and override land there);
  //   2. keyframes are arrays only;
  //   3. the last frame is the rest value: own animations of the element sharing a key
  //      stop first, scale / translate rest at 'none', opacity at its computed value,
  //      and an opacity preset is skipped during a CSS opacity transition;
  //   4. persist is never set;
  //   5. a stop is native cancel() on the instance's animations (complete() as fallback).
  var REST = 'rest';
  var ALLOWED = { opacity: 1, scale: 1, translate: 1 };
  var EXCEPTION_KEYS = { transform: 1, visibility: 1 };
  var live = [];

  function waapi() {
    var a = anime();
    return a && a.waapi && typeof a.waapi.animate === 'function' ? a.waapi : null;
  }

  function canPlay() {
    return !reduced() && !document.hidden && !!waapi();
  }

  function forget(entry) {
    var i = live.indexOf(entry);
    if (i !== -1) live.splice(i, 1);
  }

  function stopEntry(entry) {
    if (entry.over) return;
    entry.over = true;
    forget(entry);
    var inst = entry.instance;
    if (inst) {
      try {
        var anims = inst.animations;
        if (anims && anims.length) {
          for (var i = 0; i < anims.length; i++) anims[i].cancel();
        } else if (typeof inst.complete === 'function') {
          inst.complete();
        }
      } catch (e) {
        rethrow(e);
      }
    }
    entry.resolve();
  }

  // Rule 3, first half: stop this element's own instances that share a key (whole
  // instance) before anything reads its computed style.
  function stopOwn(target, keys) {
    var hit = live.filter(function (e) {
      if (e.target !== target) return false;
      for (var i = 0; i < keys.length; i++) if (e.keys.indexOf(keys[i]) !== -1) return true;
      return false;
    });
    hit.forEach(stopEntry);
  }

  function opacityTransitionRunning(target) {
    if (typeof target.getAnimations !== 'function') return false;
    var list;
    try { list = target.getAnimations(); } catch (e) { return false; }
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && a.transitionProperty === 'opacity' && a.playState !== 'finished' && a.playState !== 'idle') return true;
    }
    return false;
  }

  function restValue(target, key) {
    var cs = null;
    try { cs = window.getComputedStyle(target); } catch (e) { cs = null; }
    var v = cs ? String(cs[key] == null ? '' : cs[key]).trim() : '';
    if (key === 'opacity') return v || '1';
    if (key === 'scale' || key === 'translate' || key === 'transform') return v && v !== 'none' ? v : 'none';
    return v;
  }

  // run(target, keyframes, opts) -> live entry | null. opts: { duration, delay, ease,
  // budget, exception }. Throws on a broken keyframe (the caller reports it).
  function run(target, keyframes, opts) {
    var a = anime();
    if (!waapi() || !target || target.nodeType !== 1 || !target.isConnected) return null;
    var keys = Object.keys(keyframes);
    keys.forEach(function (k) {
      var v = keyframes[k];
      if (!Array.isArray(v) || v.length < 2) throw new TypeError('motion: ' + k + ' keyframes must be an array');
      var exempt = opts.exception === 'visibility' && k === 'visibility';
      if (!exempt && v[v.length - 1] !== REST) throw new TypeError('motion: ' + k + ' must end at rest');
    });
    stopOwn(target, keys);
    if (has(keyframes, 'opacity') && opacityTransitionRunning(target)) return null;

    var params = {};
    keys.forEach(function (k) {
      params[k] = keyframes[k].map(function (v) { return v === REST ? restValue(target, k) : v; });
    });
    var budget = Math.min(opts.budget, tokens.slow);
    var duration = Math.max(0, Math.min(Number(opts.duration) || 0, budget));
    params.duration = duration;
    params.delay = Math.max(0, Math.min(Number(opts.delay) || 0, budget - duration));
    params.ease = opts.ease || easeOut();

    var entry = { target: target, keys: keys, instance: null, over: false, resolve: null, finished: null };
    entry.finished = new Promise(function (res) { entry.resolve = res; });
    params.onComplete = function (inst) {
      try { (inst || entry.instance).revert(); } catch (e) { rethrow(e); }
      entry.over = true;
      forget(entry);
      entry.resolve();
    };
    live.push(entry);
    try {
      entry.instance = a.waapi.animate(target, params);
    } catch (e) {
      entry.over = true;
      forget(entry);
      entry.resolve();
      throw e;
    }
    return entry;
  }

  // --- the preset registry ------------------------------------------------------
  //
  // A preset is { keys, budget (ms, whole call), frequent, exception?, build }, where
  // build(target, opts) returns steps [{ target, frames, duration, delay, ease }]; every
  // frame list ends at 'rest' (the core resolves it). Frequent presets fit --t-fast-max.
  var registry = {};
  var presetsView = Object.freeze({});

  function describe(name) {
    var p = registry[name];
    var out = { keys: Object.freeze(p.keys.slice()), budget: p.budget, frequent: p.frequent };
    if (p.exception) out.exception = p.exception;
    return Object.freeze(out);
  }

  function definePreset(name, spec) {
    if (typeof name !== 'string' || !name) throw new TypeError('motion: a preset needs a name');
    if (has(registry, name)) throw new Error('motion: preset ' + name + ' already exists');
    if (!isPlainObject(spec) || typeof spec.build !== 'function') throw new TypeError('motion: ' + name + ' needs build()');
    if (spec.exception !== undefined && spec.exception !== 'visibility') throw new TypeError('motion: unknown exception ' + spec.exception);
    if (!Array.isArray(spec.keys) || !spec.keys.length) throw new TypeError('motion: ' + name + ' needs keys');
    spec.keys.forEach(function (k) {
      if (ALLOWED[k] || (EXCEPTION_KEYS[k] && spec.exception === 'visibility')) return;
      throw new TypeError('motion: ' + name + ' may not animate ' + k);
    });
    var frequent = !!spec.frequent;
    var cap = frequent ? tokens.fastMax : tokens.slow;
    var budget = Number(spec.budget);
    if (!(budget > 0) || budget > cap) throw new RangeError('motion: ' + name + ' budget must be within ' + cap + ' ms');
    registry[name] = { keys: spec.keys.slice(), budget: budget, frequent: frequent, exception: spec.exception, build: spec.build };
    var view = {};
    Object.keys(registry).forEach(function (n) { view[n] = describe(n); });
    presetsView = Object.freeze(view);
  }

  function inView(el) {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
    var r = el.getBoundingClientRect();
    var h = window.innerHeight || document.documentElement.clientHeight;
    var w = window.innerWidth || document.documentElement.clientWidth;
    return r.bottom >= 0 && r.right >= 0 && r.top <= h && r.left <= w;
  }

  function fadeUp(distance, duration) {
    return function (target) {
      return [{ target: target, frames: { opacity: [0, REST], translate: ['0px ' + distance + 'px', REST] }, duration: duration }];
    };
  }

  function springStep(target, frames, spring, fallback) {
    var se = springEase(spring);
    return { target: target, frames: frames, duration: se ? se.duration : fallback, ease: se ? se.ease : null };
  }

  definePreset('press', {
    keys: ['scale'], budget: tokens.fastMax, frequent: true,
    build: function (t) { return [springStep(t, { scale: [1, 0.94, REST] }, 'press', tokens.fastMax)]; },
  });
  definePreset('press-soft', {
    keys: ['scale'], budget: tokens.fastMax, frequent: true,
    build: function (t) { return [springStep(t, { scale: [1, 0.985, REST] }, 'press', tokens.fastMax)]; },
  });
  definePreset('fade-up', { keys: ['opacity', 'translate'], budget: tokens.med, build: fadeUp(8, tokens.med) });
  definePreset('fade-up-short', {
    keys: ['opacity', 'translate'], budget: tokens.fast, frequent: true, build: fadeUp(4, tokens.fast),
  });
  definePreset('pop', {
    keys: ['opacity', 'scale'], budget: tokens.medMax,
    build: function (t) { return [springStep(t, { opacity: [0, REST], scale: [0.92, REST] }, 'pop', tokens.medMax)]; },
  });
  // fade-up at --t-fast-max on the first --rf-stagger-max children in view, one step
  // apart; the rest are already at rest and appear with the last one.
  definePreset('list-enter', {
    keys: ['opacity', 'translate'], budget: tokens.medMax,
    build: function (t) {
      var max = staggerMax();
      var step = staggerStep();
      var out = [];
      for (var i = 0; i < t.children.length && out.length < max; i++) {
        var child = t.children[i];
        if (!inView(child)) continue;
        var s = fadeUp(8, tokens.fastMax)(child)[0];
        s.delay = out.length * step;
        out.push(s);
      }
      return out;
    },
  });

  var trace = [];

  function record(name, target) {
    var root = document.documentElement;
    if (!root || !root.hasAttribute(TRACE_ATTR)) return;
    var t = window.performance && typeof performance.now === 'function' ? performance.now() : Date.now();
    trace.push({ name: name, target: target, t: t });
    if (trace.length > 500) trace.shift();
  }

  // play(name, target, opts) -> { stop(), finished } | null. null, with nothing
  // written, under reduced motion, in a hidden tab, without anime.waapi, for an unknown
  // name or a detached target, and when every step was skipped.
  function play(name, target, opts) {
    var preset = has(registry, name) ? registry[name] : null;
    if (!preset || !target || target.nodeType !== 1 || !target.isConnected || !canPlay()) return null;
    var entries = [];
    try {
      var steps = preset.build(target, opts || {}) || [];
      var budget = Math.min(preset.budget, preset.frequent ? tokens.fastMax : tokens.slow);
      for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        Object.keys(s.frames).forEach(function (k) {
          if (preset.keys.indexOf(k) === -1) throw new TypeError('motion: ' + name + ' does not declare ' + k);
        });
        var entry = run(s.target, s.frames, {
          duration: s.duration, delay: s.delay, ease: s.ease, budget: budget, exception: preset.exception,
        });
        if (entry) entries.push(entry);
      }
    } catch (e) {
      entries.forEach(stopEntry);
      rethrow(e);
      return null;
    }
    if (!entries.length) return null;
    record(name, target);
    return {
      stop: function () { entries.forEach(stopEntry); },
      finished: Promise.all(entries.map(function (e) { return e.finished; })).then(function () {}),
    };
  }

  function activeCount() {
    var n = 0;
    for (var i = 0; i < live.length; i++) if (live[i].target.isConnected) n++;
    return n;
  }

  // Resolves once no connected target animates and the current View Transition is
  // done. Waits re-check at least every --t-slow + 100 ms; detached targets do not
  // count, so an animation on a removed node never holds it.
  function idle() {
    return new Promise(function (resolve) {
      function check() {
        var waits = [];
        live.forEach(function (e) { if (e.target.isConnected) waits.push(e.finished); });
        if (running && running.finished && typeof running.finished.then === 'function') {
          waits.push(running.finished);
        }
        if (!waits.length) { resolve(); return; }
        var all = Promise.all(waits.map(function (p) { return Promise.resolve(p).then(null, function () {}); }));
        var tick = new Promise(function (res) { setTimeout(res, tokens.slow + 100); });
        Promise.race([all, tick]).then(check);
      }
      check();
    });
  }

  // --- presses ------------------------------------------------------------------
  //
  // One capture listener each for pointerdown and keydown (Enter / Space): a single
  // fire-and-forget press, nothing on release, never preventDefault (design §6.4.3).
  var PRESS = 'button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], '
    + '[role=tab], [role=option], summary, label.switch, [data-rf-open], [data-rf-nav], '
    + '[hx-get]:not([hx-trigger]), [hx-post]:not([hx-trigger]), [hx-trigger="click"]';
  var SOFT = '.article-row, #sidebar a, tr, [data-motion-press=soft]';
  var FIELD = 'input, textarea, select';

  function textEntry(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.matches('textarea, select')) return true;
    return el.matches('input') && !/^(checkbox|radio|button|submit|reset|image)$/i.test(el.type || '');
  }

  function pressTarget(from) {
    if (!from || from.nodeType !== 1 || typeof from.closest !== 'function') return null;
    if (textEntry(from)) return null;
    var el = from.closest(PRESS);
    // A matched <form hx-post> is never pressed, and the lookup stops there.
    if (!el || el.matches('form')) return null;
    if (el.matches(FIELD) || el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return null;
    if (el.closest('[data-motion-press="off"], [data-rf-swipe]')) return null;
    var display = '';
    try { display = window.getComputedStyle(el).display; } catch (e) { display = ''; }
    if (display === 'inline') return null;
    return el;
  }

  function press(from) {
    var el = pressTarget(from);
    if (el) play(el.matches(SOFT) ? 'press-soft' : 'press', el);
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button > 0) return;
    press(e.target);
  }, { capture: true, passive: true });

  document.addEventListener('keydown', function (e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    press(e.target);
  }, { capture: true, passive: true });

  // --- entrances ----------------------------------------------------------------
  var ENTRANCES = { 'fade-up': 1, 'fade-up-short': 1, pop: 1, 'list-enter': 1 };

  function enter(root) {
    root = root || document;
    if (typeof root.querySelectorAll !== 'function') return;
    var els = Array.prototype.slice.call(root.querySelectorAll('[data-motion]:not([' + DONE + '])'));
    if (root.nodeType === 1 && root.matches('[data-motion]:not([' + DONE + '])')) els.unshift(root);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.setAttribute(DONE, '');
      var name = el.getAttribute('data-motion');
      if (has(ENTRANCES, name)) play(name, el);
    }
  }

  // --- View Transitions ---------------------------------------------------------
  var running = null;

  function transition(update) {
    if (reduced() || typeof document.startViewTransition !== 'function') {
      var done = Promise.resolve(update());
      return { finished: done, updateCallbackDone: done, ready: done, skipTransition: function () {} };
    }
    if (running && typeof running.skipTransition === 'function') running.skipTransition();
    var vt = document.startViewTransition(update);
    running = vt;
    function clear() { if (running === vt) running = null; }
    if (vt && vt.ready && typeof vt.ready.catch === 'function') vt.ready.catch(function () {});
    if (vt && vt.finished && typeof vt.finished.then === 'function') vt.finished.then(clear, clear);
    return vt;
  }

  function spring(opts) {
    var a = anime();
    if (reduced() || !a || typeof a.spring !== 'function') return undefined;
    return a.spring(opts);
  }

  // rf-motion:legacy-animate start
  //
  // RFMotion.animate / RFMotion.stagger: the JS-engine path, kept with its contract
  // until its last callers move to RFMotion.play (read.js in s2, feeds-settings.js in
  // s4), then removed. Under reduced motion (or without anime.js) the end state is set
  // at once; every timing key is capped so the animation ends by --t-slow.

  // Keys anime.js reads as timing or callbacks, never as animated properties.
  var TIMING_KEYS = {
    duration: 1, delay: 1, endDelay: 1, ease: 1, easing: 1, loop: 1, loopDelay: 1, alternate: 1,
    reversed: 1, autoplay: 1, frameRate: 1, playbackRate: 1, playbackEase: 1,
    composition: 1, modifier: 1, keyframes: 1,
  };
  var SEGMENT_KEYS = ['duration', 'delay', 'endDelay'];

  // A timing value in ms for one target; junk and negatives count as 0.
  function ms(v, self, args) {
    var n = Number(typeof v === 'function' ? v.apply(self, args || []) : v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function hasTiming(o) {
    if (!isPlainObject(o)) return false;
    for (var i = 0; i < SEGMENT_KEYS.length; i++) if (has(o, SEGMENT_KEYS[i])) return true;
    return false;
  }

  // Caps the timing keys of `own` (in the order duration, delay, endDelay) into what
  // `budget` leaves after the `fixed` values, which count but are not ours to change.
  // Returns the capped keys: numbers when every input is static, functions otherwise.
  function fit(own, fixed, budget) {
    var keys = [];
    var dynamic = false;
    var i;
    for (i = 0; i < SEGMENT_KEYS.length; i++) {
      if (!has(own, SEGMENT_KEYS[i])) continue;
      keys.push(SEGMENT_KEYS[i]);
      if (typeof own[SEGMENT_KEYS[i]] === 'function') dynamic = true;
    }
    for (i = 0; i < fixed.length; i++) if (typeof fixed[i] === 'function') dynamic = true;
    function alloc(self, args) {
      var left = budget;
      for (var j = 0; j < fixed.length; j++) left -= ms(fixed[j], self, args);
      left = Math.max(0, left);
      var out = {};
      for (var k = 0; k < keys.length; k++) {
        out[keys[k]] = Math.min(ms(own[keys[k]], self, args), left);
        left -= out[keys[k]];
      }
      return out;
    }
    if (!dynamic) return alloc(null, []);
    var result = {};
    keys.forEach(function (key) {
      result[key] = function () { return alloc(this, arguments)[key]; };
    });
    return result;
  }

  // A keyframe sequence (an array, or an object of percentage keys) whose frames carry
  // their own delay / duration / endDelay: static values are scaled down together so
  // that their sum fits `budget`, keeping their proportions; each function-valued one
  // is capped at an equal share. Returns { frames: a copy, total: the capped sum (an
  // upper bound) }, or null when no frame carries timing (plain value arrays).
  function fitFrames(frames, budget) {
    var keys = Object.keys(frames);
    var count = 0;
    var fnCount = 0;
    var staticSum = 0;
    keys.forEach(function (k) {
      var f = frames[k];
      if (!hasTiming(f)) return;
      SEGMENT_KEYS.forEach(function (t) {
        if (!has(f, t)) return;
        count++;
        if (typeof f[t] === 'function') fnCount++;
        else staticSum += ms(f[t]);
      });
    });
    if (!count) return null;
    var share = budget / count;
    var scale = staticSum > 0 ? Math.min(1, Math.max(0, budget - fnCount * share) / staticSum) : 1;
    var out = Array.isArray(frames) ? frames.slice() : {};
    keys.forEach(function (k) {
      var f = frames[k];
      if (!hasTiming(f)) { out[k] = f; return; }
      var copy = {};
      for (var p in f) if (has(f, p)) copy[p] = f[p];
      SEGMENT_KEYS.forEach(function (t) {
        if (!has(f, t)) return;
        var v = f[t];
        copy[t] = typeof v === 'function'
          ? function () { return Math.min(ms(v, this, arguments), share); }
          : Math.floor(ms(v) * scale);
      });
      out[k] = copy;
    });
    return { frames: out, total: Math.floor(staticSum * scale) + fnCount * share };
  }

  function isFrameList(v) {
    if (!Array.isArray(v)) return false;
    for (var i = 0; i < v.length; i++) if (hasTiming(v[i])) return true;
    return false;
  }

  // The params anime gets: a copy with every timing key capped.
  function capParams(params) {
    var slow = tokens.slow;
    var copy = {};
    for (var key in params) if (has(params, key)) copy[key] = params[key];

    // 1. The top-level duration, defaulting to --t-med.
    var duration = fit({ duration: params.duration == null ? tokens.med : params.duration }, [], slow).duration;
    copy.duration = duration;

    // 2. Keyframe sequences (top-level keyframes and property keyframe arrays) fit in
    //    what a static top-level delay leaves; they may run longer than duration.
    var staticDelay = has(params, 'delay') && typeof params.delay !== 'function'
      ? Math.min(ms(params.delay), Math.max(0, slow - ms(duration))) : 0;
    var frameBudget = slow - staticDelay;
    var framesTotal = 0;
    for (key in copy) {
      if (!has(copy, key)) continue;
      var v = copy[key];
      var isKeyframes = key === 'keyframes' && v !== null && typeof v === 'object';
      if (!isKeyframes && (TIMING_KEYS[key] || !isFrameList(v))) continue;
      var fitted = fitFrames(v, frameBudget);
      if (!fitted) continue;
      copy[key] = fitted.frames;
      framesTotal = Math.max(framesTotal, fitted.total);
    }

    // 3. delay and endDelay take what the body (duration or the longest sequence) leaves.
    var body = duration;
    if (framesTotal > 0) {
      body = typeof duration === 'function'
        ? function () { return Math.max(ms(duration, this, arguments), framesTotal); }
        : Math.max(duration, framesTotal);
    }
    var own = {};
    if (has(params, 'delay')) own.delay = params.delay;
    if (has(params, 'endDelay')) own.endDelay = params.endDelay;
    var top = fit(own, [body], slow);
    if (has(top, 'delay')) copy.delay = top.delay;
    if (has(top, 'endDelay')) copy.endDelay = top.endDelay;

    // 4. Per-property timing objects ({ to, duration, delay }) fit in what the
    //    top-level values they inherit leave.
    for (key in copy) {
      if (!has(copy, key) || TIMING_KEYS[key] || !hasTiming(copy[key])) continue;
      var prop = copy[key];
      var fixed = [];
      if (!has(prop, 'duration')) fixed.push(duration);
      if (!has(prop, 'delay') && has(copy, 'delay')) fixed.push(copy.delay);
      var capped = fit(prop, fixed, slow);
      var inner = {};
      for (var p in prop) if (has(prop, p)) inner[p] = prop[p];
      for (p in capped) inner[p] = capped[p];
      copy[key] = inner;
    }
    return copy;
  }

  // The value a property ends on: [from, to] -> to; { from, to } -> to.
  function endValue(v) {
    if (Array.isArray(v)) return v.length ? endValue(v[v.length - 1]) : undefined;
    if (isPlainObject(v)) return 'to' in v ? endValue(v.to) : undefined;
    return v;
  }

  function endState(params) {
    var out = {};
    for (var key in params) {
      if (!has(params, key)) continue;
      if (TIMING_KEYS[key] || /^on[A-Z]/.test(key)) continue;
      var v = endValue(params[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }

  function toElements(targets) {
    if (!targets) return [];
    if (typeof targets === 'string') return Array.prototype.slice.call(document.querySelectorAll(targets));
    if (targets.nodeType === 1) return [targets];
    if (typeof targets.length === 'number') {
      var out = [];
      for (var i = 0; i < targets.length; i++) out = out.concat(toElements(targets[i]));
      return out;
    }
    return [];
  }

  var TRANSFORMS = {
    x: ['translateX', 'px'], y: ['translateY', 'px'], translateX: ['translateX', 'px'],
    translateY: ['translateY', 'px'], scale: ['scale', ''], scaleX: ['scaleX', ''],
    scaleY: ['scaleY', ''], rotate: ['rotate', 'deg'],
  };

  // Without anime.js: write the end state straight onto each element's style.
  function setStyles(targets, state) {
    var els = toElements(targets);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var transform = [];
      for (var key in state) {
        var v = typeof state[key] === 'function' ? state[key](el, i, els.length) : state[key];
        if (TRANSFORMS[key]) {
          var unit = typeof v === 'number' ? TRANSFORMS[key][1] : '';
          transform.push(TRANSFORMS[key][0] + '(' + v + unit + ')');
        } else {
          el.style[key] = String(v);
        }
      }
      if (transform.length) el.style.transform = transform.join(' ');
    }
  }

  // A settled stand-in for an anime.js animation. It resolves with undefined (never
  // with itself), so `await` terminates.
  function finished() {
    var p = Promise.resolve();
    function noop() { return api; }
    var api = {
      then: function (a, b) { return p.then(a, b); },
      catch: function (b) { return p.catch(b); },
      play: noop, pause: noop, resume: noop, restart: noop, complete: noop,
      cancel: noop, revert: noop, seek: noop,
      finished: p,
    };
    return api;
  }

  function animate(targets, params) {
    params = params || {};
    var a = anime();
    if (reduced() || !a || typeof a.animate !== 'function') {
      var state = endState(params);
      if (a && a.utils && typeof a.utils.set === 'function') a.utils.set(targets, state);
      else setStyles(targets, state);
      if (typeof params.onComplete === 'function') {
        try { params.onComplete(); } catch (e) { rethrow(e); }
      }
      return finished();
    }
    return a.animate(targets, capParams(params));
  }

  function stagger(value, opts) {
    var a = anime();
    if (reduced() || !a || typeof a.stagger !== 'function') return function () { return 0; };
    return a.stagger(value, opts);
  }
  // rf-motion:legacy-animate end

  var api = {
    tokens: tokens,
    reduced: reduced,
    animate: animate,
    stagger: stagger,
    spring: spring,
    enter: enter,
    transition: transition,
    play: play,
    definePreset: definePreset,
    springs: springs,
    springEase: springEase,
    activeCount: activeCount,
    idle: idle,
    trace: trace,
  };
  // A frozen snapshot, rebuilt by definePreset.
  Object.defineProperty(api, 'presets', { enumerable: true, get: function () { return presetsView; } });
  window.RFMotion = api;

  // htmx dispatches afterSwap on each swapped element. For an outerHTML swap that is
  // the new element, while detail.target is the detached old one, so prefer the
  // connected dispatch target.
  document.addEventListener('htmx:afterSwap', function (e) {
    var t = e.target;
    var root = t && t !== document && t.isConnected ? t : e.detail && e.detail.target;
    window.RFMotion.enter(root);
  });
})();
