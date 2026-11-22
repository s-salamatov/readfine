// Readfine dialogs, sheets and sidebars without inline handlers.
//
// A classic script, loaded deferred on every page (base.html), after the vendored
// Basecoat scripts. The CSP allows no inline script, so Basecoat's documented trigger
// (an inline handler attribute that calls showModal()) never runs. Markup uses data
// attributes instead:
//   - data-rf-open="<id>" on any element: a click opens the <dialog> with that id as a
//     modal (Basecoat dialog, alert dialog, command dialog and drawer / "sheet"), and
//     remembers the element so focus returns to it when the dialog closes, however it
//     closes (button, Escape, a form with method="dialog", Basecoat's drawer backdrop).
//     A target that is not a <dialog> but has a toggle() method (a Basecoat sidebar
//     after basecoat.js initialised it) is toggled.
//   - data-rf-close inside a dialog: a click closes that dialog. It goes through
//     dialog.close(), so Basecoat's drawer plays its closing transition.
// An unknown or empty id does nothing: no error, no log, the default action stays.
//
// Basecoat sidebars (.sidebar, ui/nav.html sidebar macro). The vendored sidebar.js
// decides the open state once at init (innerWidth against data-breakpoint, default
// 768; data-initial-open / data-initial-mobile-open) and has no key handler and no
// resize handling. Here, through its own element API (open() / close()):
//   - crossing the breakpoint re-applies Basecoat's initial rule for the new side: on
//     wide screens open unless data-initial-open="false", below it closed unless
//     data-initial-mobile-open="true". A resize that stays on one side changes nothing;
//   - Escape closes a sidebar that is open below its breakpoint (the overlay state),
//     unless a <dialog> is open (the dialog owns Escape), and focus returns to the
//     element that opened it (or the first [data-rf-open="<id>"]);
//   - every [data-rf-open="<id>"] of a sidebar carries aria-expanded, kept in sync with
//     the sidebar's aria-hidden, including Basecoat's own closes (link, backdrop);
//   - while it is open below its breakpoint (the overlay state) the rest of the page
//     is inert, and a data-rf-open click that opens it moves focus to its first
//     control; when the overlay closes, focus returns to the opener (s3 C6c).
// Global: one click and one keydown listener on document, one capture listener for
// basecoat:initialized, one matchMedia listener per sidebar breakpoint and one
// MutationObserver for sidebar aria-hidden.
(function () {
  'use strict';

  var DEFAULT_BREAKPOINT = 768; // sidebar.js: parseInt(data-breakpoint) || 768

  var openers = new WeakMap();
  var sidebarOpeners = new WeakMap();
  var watchedSidebars = new WeakSet();
  var queries = {};

  function focusQuietly(el) {
    if (el && el.isConnected && typeof el.focus === 'function') {
      try { el.focus(); } catch (e) { /* an opener that cannot take focus */ }
    }
  }

  function returnFocus(event) {
    var dialog = event.currentTarget;
    var opener = openers.get(dialog);
    openers.delete(dialog);
    focusQuietly(opener);
  }

  function open(dialog, opener) {
    if (dialog.open) return;
    openers.set(dialog, opener);
    // close does not bubble, so each opening adds its own one-shot listener.
    dialog.addEventListener('close', returnFocus, { once: true });
    dialog.showModal();
  }

  // --- sidebars ---

  function isSidebar(el) {
    return !!(el && el.classList && el.classList.contains('sidebar'));
  }

  function isSidebarOpen(sidebar) {
    return sidebar.getAttribute('aria-hidden') !== 'true';
  }

  function hasApi(sidebar) {
    return typeof sidebar.open === 'function' && typeof sidebar.close === 'function';
  }

  // Basecoat treats a breakpoint <= 0 as "no mobile mode".
  function breakpointOf(sidebar) {
    return parseInt(sidebar.getAttribute('data-breakpoint'), 10) || DEFAULT_BREAKPOINT;
  }

  function isWide(sidebar) {
    var bp = breakpointOf(sidebar);
    if (bp <= 0) return true;
    var query = queries[bp];
    return query ? query.matches : window.innerWidth >= bp;
  }

  function openersOf(sidebar) {
    if (!sidebar.id) return [];
    var all = document.querySelectorAll('[data-rf-open]');
    var found = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-rf-open') === sidebar.id) found.push(all[i]);
    }
    return found;
  }

  // --- the narrow-screen overlay: the page behind it is inert (s3 C6c) ---
  //
  // Below its breakpoint an open sidebar covers the page (Basecoat draws the aside as
  // a full-screen backdrop), but Basecoat only toggles the aside's own inert. While
  // it is in that state, every sibling of the sidebar and of each of its ancestors up
  // to <body> gets inert, except dialogs (top layer, they manage their own modality),
  // live regions (announcements must still be heard), non-rendered elements and
  // elements that were already inert. Only the attributes set here are removed again,
  // whichever way the overlay ends: toggle, Escape, Basecoat's link or backdrop
  // close, or the viewport crossing to wide.
  var INERT_SKIP = 'dialog, script, style, template, link, meta, [aria-live], .toaster';
  var inerted = new WeakMap(); // sidebar -> elements made inert for it

  function isOverlay(sidebar) {
    return isSidebarOpen(sidebar) && !isWide(sidebar);
  }

  function inertPage(sidebar) {
    if (inerted.has(sidebar)) return;
    var made = [];
    for (var node = sidebar; node && node.parentElement && node !== document.body; node = node.parentElement) {
      var siblings = node.parentElement.children;
      for (var i = 0; i < siblings.length; i++) {
        var el = siblings[i];
        if (el === node || el.hasAttribute('inert') || el.matches(INERT_SKIP)) continue;
        el.setAttribute('inert', '');
        made.push(el);
      }
    }
    inerted.set(sidebar, made);
  }

  // Returns true when the page was inert for this sidebar.
  function releasePage(sidebar) {
    var made = inerted.get(sidebar);
    if (!made) return false;
    inerted.delete(sidebar);
    for (var i = 0; i < made.length; i++) made[i].removeAttribute('inert');
    return true;
  }

  function focusInto(sidebar) {
    if (sidebar.contains(document.activeElement)) return;
    var first = sidebar.querySelector('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    focusQuietly(first);
  }

  function syncOverlay(sidebar) {
    if (isOverlay(sidebar)) {
      inertPage(sidebar);
      return;
    }
    var wasOverlay = releasePage(sidebar);
    // Closed (not widened): Basecoat's link and backdrop closes blur the focus, so
    // give it back to the opener unless it already moved elsewhere on purpose.
    var active = document.activeElement;
    if (wasOverlay && !isSidebarOpen(sidebar) && (!active || active === document.body || sidebar.contains(active))) {
      focusQuietly(sidebarOpeners.get(sidebar) || openersOf(sidebar)[0]);
    }
  }

  function syncExpanded(sidebar) {
    var state = isSidebarOpen(sidebar) ? 'true' : 'false';
    var list = openersOf(sidebar);
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('aria-expanded') !== state) list[i].setAttribute('aria-expanded', state);
    }
    syncOverlay(sidebar);
  }

  function applyBreakpoint(bp, wide) {
    var sidebars = document.querySelectorAll('.sidebar');
    for (var i = 0; i < sidebars.length; i++) {
      var sidebar = sidebars[i];
      if (breakpointOf(sidebar) !== bp || !hasApi(sidebar)) continue;
      var shouldOpen = wide
        ? sidebar.getAttribute('data-initial-open') !== 'false'
        : sidebar.getAttribute('data-initial-mobile-open') === 'true';
      if (shouldOpen) sidebar.open(); else sidebar.close();
      syncExpanded(sidebar);
    }
  }

  function listenBreakpoint(bp) {
    if (bp <= 0 || queries[bp] || typeof window.matchMedia !== 'function') return;
    var query = window.matchMedia('(min-width: ' + bp + 'px)');
    if (!query) return;
    queries[bp] = query;
    var handler = function (event) { applyBreakpoint(bp, !!event.matches); };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', handler);
    else if (typeof query.addListener === 'function') query.addListener(handler);
  }

  function watchSidebar(sidebar) {
    if (!isSidebar(sidebar)) return;
    if (!watchedSidebars.has(sidebar)) {
      watchedSidebars.add(sidebar);
      listenBreakpoint(breakpointOf(sidebar));
    }
    syncExpanded(sidebar);
  }

  function scanSidebars() {
    var sidebars = document.querySelectorAll('.sidebar');
    for (var i = 0; i < sidebars.length; i++) watchSidebar(sidebars[i]);
  }

  // basecoat:initialized does not bubble: catch it in the capture phase. It covers
  // sidebars that Basecoat initialises later (htmx swaps, its MutationObserver).
  document.addEventListener('basecoat:initialized', function (event) {
    watchSidebar(event.target);
  }, true);

  // Basecoat closes a mobile sidebar itself on a link or backdrop click.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (isSidebar(records[i].target)) syncExpanded(records[i].target);
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['aria-hidden'], subtree: true });
  }

  // A deferred script runs after parsing, so the breakpoint listeners start now.
  // basecoat.js initialises on DOMContentLoaded with a listener added before this
  // script's, so the second scan syncs aria-expanded with the initialised state.
  scanSidebars();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanSidebars);
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (document.querySelector('dialog[open]')) return;
    var sidebars = document.querySelectorAll('.sidebar');
    for (var i = 0; i < sidebars.length; i++) {
      var sidebar = sidebars[i];
      if (!hasApi(sidebar) || !isSidebarOpen(sidebar) || isWide(sidebar)) continue;
      event.preventDefault();
      sidebar.close();
      syncExpanded(sidebar);
      focusQuietly(sidebarOpeners.get(sidebar) || openersOf(sidebar)[0]);
    }
  });

  // --- clicks ---

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var opener = target.closest('[data-rf-open]');
    if (opener) {
      var id = opener.getAttribute('data-rf-open');
      var el = id ? document.getElementById(id) : null;
      if (!el) return;
      if (el.tagName === 'DIALOG' && typeof el.showModal === 'function') {
        event.preventDefault();
        open(el, opener);
      } else if (typeof el.toggle === 'function') {
        event.preventDefault();
        el.toggle();
        if (isSidebar(el)) {
          sidebarOpeners.set(el, opener);
          syncExpanded(el);
          if (isOverlay(el)) focusInto(el);
        }
      }
      return;
    }

    var closer = target.closest('[data-rf-close]');
    if (closer) {
      var dialog = closer.closest('dialog');
      if (dialog && dialog.open) {
        event.preventDefault();
        dialog.close();
      }
    }
  });
})();
