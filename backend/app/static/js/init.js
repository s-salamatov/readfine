// Critical init: runs synchronously before first paint to prevent layout flash.
(function () {
  // Clear the launch handoff before app.js reads the query for list routing.
  try {
    if (location.pathname === '/' || location.pathname === '/app') {
      var url = new URL(location.href);
      if (url.searchParams.has('rf_launch')) {
        url.searchParams.delete('rf_launch');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      }
    }
  } catch (e) {
    // Continue layout and theme initialization if the URL cannot be updated.
  }

  var pinned = true;
  try { pinned = localStorage.getItem('sidebarPinned') !== 'false'; } catch (e) {}
  window._sidebarPinned = pinned;
  if (!pinned) document.documentElement.classList.add('sidebar-unpinned');

  var LAYOUT_DEFAULTS = { small: '1', medium: '2', large: '3' };
  var w = window.innerWidth;
  // Read the user's custom breakpoints from server-rendered <html> data attributes so
  // the first-paint bucket matches what app.js computes later (no layout flash on reload).
  var smallMax = parseInt(document.documentElement.dataset.bucketSmallMax, 10) || 640;
  var mediumMax = parseInt(document.documentElement.dataset.bucketMediumMax, 10) || 1100;
  var bucket = w <= smallMax ? 'small' : w <= mediumMax ? 'medium' : 'large';
  var layout;
  try { layout = localStorage.getItem('layout_' + bucket); } catch (e) {}
  document.documentElement.dataset.bucket = bucket;
  document.documentElement.dataset.layout = layout || LAYOUT_DEFAULTS[bucket];

  if (bucket === 'small') {
    var sidebarMode;
    try { sidebarMode = localStorage.getItem('sidebar_mode_small'); } catch (e) {}
    var resolvedMode = sidebarMode || 'hideable-up';
    if (resolvedMode === 'hideable') resolvedMode = 'hideable-up';
    document.documentElement.dataset.sidebarMode = resolvedMode;
  }

  // Dark mode and app theme: apply before first paint. Both are per-device choices
  // in localStorage; an unknown or missing appTheme is the default, neutral.
  var root = document.documentElement;
  var _cs;
  try { _cs = localStorage.getItem('colorScheme'); } catch (e) {}
  _cs = _cs || 'system';
  if (_cs === 'dark' || (_cs === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.classList.add('dark');
  }

  var APP_THEMES = { neutral: true, paper: true, graphite: true };
  function appTheme(name) {
    return Object.prototype.hasOwnProperty.call(APP_THEMES, name) ? name : 'neutral';
  }
  var _theme;
  try { _theme = localStorage.getItem('appTheme'); } catch (e) {}
  root.dataset.rfTheme = appTheme(_theme);

  // Browser/OS chrome around the page (address bar, status bar) follows the shell
  // background. Shared with the other places that change the scheme or theme —
  // app.js's system-preference listener and the pickers in settings — so the bar
  // never keeps the colour of the scheme the user just left.
  //
  // The colour is read, never written here: the theme's --background token when it
  // is hex or an rgb colour (iOS ignores OKLCH), otherwise the body's computed background.
  // Before <body> exists and without the token there is nothing to read yet, so the
  // meta is synced again once the document has parsed.
  var TRANSPARENT = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i;
  function themeColor() {
    var bg = getComputedStyle(root).getPropertyValue('--background').trim();
    if (/^#[0-9a-f]{3,8}$/i.test(bg) || /^rgba?\(/i.test(bg)) return bg;
    if (!document.body) return '';
    bg = getComputedStyle(document.body).backgroundColor;
    return /^rgba?\(/i.test(bg) && !TRANSPARENT.test(bg) ? bg : '';
  }
  window.syncThemeColor = function () {
    var color = themeColor();
    if (!color) return;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      (document.head || root).appendChild(meta);
    }
    meta.setAttribute('content', color);
  };

  window.setAppTheme = function (name) {
    var theme = appTheme(name);
    try { localStorage.setItem('appTheme', theme); } catch (e) {}
    root.dataset.rfTheme = theme;
    window.syncThemeColor();
  };

  window.syncThemeColor();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.syncThemeColor);
  }

  // Keep the install prompt so Settings can offer it on a button. Chrome decides on
  // its own when a page has earned the prompt, and fires this once when it does;
  // preventDefault() stops the browser showing its own banner and hands us the event
  // to raise later. It is single-use, so whoever calls prompt() clears it.
  //
  // Here rather than in app.js because the event can arrive before a deferred script
  // has run, and it is not replayed: this file is the first script in the head and
  // runs synchronously, so it cannot miss it. Nothing else in init.js touches paint.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window._installPrompt = e;
  });
})();
