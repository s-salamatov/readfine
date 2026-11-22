// Readfine motion layer: window.RFMotion over the vendored anime.js UMD (window.anime).
//
// A classic script, loaded deferred after anime.umd.min.js. Every animation goes
// through RFMotion so that two rules hold everywhere:
//   - under prefers-reduced-motion: reduce (or without anime.js) the end state is
//     applied instantly and anime.animate is never called;
//   - no animation runs longer than --t-slow.
// Durations come from the motion tokens in styles/tokens.css; the View Transition cap
// and the reduced-motion CSS reset live in styles/motion.css.
//
// Markup opts in with data-motion="list-enter|fade-up|pop". RFMotion.enter(root) runs
// each element once and marks it data-motion-done. The only global listener is
// htmx:afterSwap; nothing runs on first paint.
(function () {
  'use strict';

  var DEFAULTS = { fast: 125, fastMax: 165, med: 300, medMax: 400, slow: 700 };
  var VARS = { fast: '--t-fast', fastMax: '--t-fast-max', med: '--t-med', medMax: '--t-med-max', slow: '--t-slow' };
  // Keys anime.js reads as timing or callbacks, never as animated properties.
  var TIMING_KEYS = {
    duration: 1, delay: 1, ease: 1, easing: 1, loop: 1, loopDelay: 1, alternate: 1,
    reversed: 1, autoplay: 1, frameRate: 1, playbackRate: 1, playbackEase: 1,
    composition: 1, modifier: 1, keyframes: 1, persist: 1,
  };
  var DONE = 'data-motion-done';

  // "125ms", ".7s" or " 0.3s " -> milliseconds; anything else -> fallback.
  function toMs(raw, fallback) {
    var s = String(raw == null ? '' : raw).trim();
    var m = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/.exec(s);
    if (!m) return fallback;
    var n = parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function readTokens() {
    var out = {};
    var cs = null;
    try { cs = window.getComputedStyle(document.documentElement); } catch (e) { cs = null; }
    for (var k in DEFAULTS) {
      out[k] = toMs(cs && cs.getPropertyValue(VARS[k]), DEFAULTS[k]);
    }
    return out;
  }

  var tokens = readTokens();

  function anime() { return window.anime || null; }

  function reduced() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function cap(d) {
    if (typeof d === 'function') {
      return function () { return Math.min(Number(d.apply(this, arguments)) || 0, tokens.slow); };
    }
    if (d == null) return tokens.med;
    return Math.min(Number(d) || 0, tokens.slow);
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
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
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
        try { params.onComplete(); } catch (e) { setTimeout(function () { throw e; }); }
      }
      return finished();
    }
    var copy = {};
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var v = params[key];
      if (isPlainObject(v) && 'duration' in v) {
        var inner = {};
        for (var k in v) inner[k] = v[k];
        inner.duration = cap(v.duration);
        v = inner;
      }
      copy[key] = v;
    }
    copy.duration = cap(params.duration);
    return a.animate(targets, copy);
  }

  function stagger(value, opts) {
    var a = anime();
    if (reduced() || !a || typeof a.stagger !== 'function') return function () { return 0; };
    return a.stagger(value, opts);
  }

  function spring(opts) {
    var a = anime();
    if (reduced() || !a) return undefined;
    var fn = a.spring || a.createSpring;
    return typeof fn === 'function' ? fn(opts) : undefined;
  }

  var ENTER = {
    'fade-up': function (el) {
      return animate(el, { opacity: [0, 1], y: [8, 0], duration: tokens.med, ease: 'out(3)' });
    },
    pop: function (el) {
      return animate(el, { opacity: [0, 1], scale: [0.96, 1], duration: tokens.fastMax, ease: 'out(3)' });
    },
    'list-enter': function (el) {
      if (!el.children.length) return null;
      return animate(el.children, {
        opacity: [0, 1], y: [6, 0], duration: tokens.med, ease: 'out(3)', delay: stagger(30),
      });
    },
  };

  function enter(root) {
    root = root || document;
    if (typeof root.querySelectorAll !== 'function') return;
    var els = Array.prototype.slice.call(root.querySelectorAll('[data-motion]:not([' + DONE + '])'));
    if (root.nodeType === 1 && root.matches('[data-motion]:not([' + DONE + '])')) els.unshift(root);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.setAttribute(DONE, '');
      var run = ENTER[el.getAttribute('data-motion')];
      if (run) run(el);
    }
  }

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

  window.RFMotion = {
    tokens: tokens,
    reduced: reduced,
    animate: animate,
    stagger: stagger,
    spring: spring,
    enter: enter,
    transition: transition,
  };

  // htmx dispatches afterSwap on each swapped element. For an outerHTML swap that is
  // the new element, while detail.target is the detached old one, so prefer the
  // connected dispatch target.
  document.addEventListener('htmx:afterSwap', function (e) {
    var t = e.target;
    var root = t && t !== document && t.isConnected ? t : e.detail && e.detail.target;
    window.RFMotion.enter(root);
  });
})();
