// The reader shell (app/main.html): the sidebar's account menu and the phone tab bar
// with the sidebar sheet (window.RFShell).
//
// - Theme items ([data-rf-scheme], [data-rf-app-theme]) set the colour scheme and the
//   app theme through window.RFTheme (init.js); their aria-checked follows what is
//   stored, on load, after every #sidebar swap and whenever the menu opens.
// - "Offline reading" ([data-rf-offline-menu]) switches offline mode through the page
//   controller (RFOffline.page.current(), offline/page.js). It is hidden without one or
//   in a browser that cannot do offline mode, and reflects the controller's state.
// - #sidebar is re-swapped every 300 s and on sidebarRefresh, which would close an open
//   account menu. While the menu is open, the sidebar's own requests are dropped; when
//   it closes, one sidebarRefresh makes up for all of them.
//
// Basecoat's dropdown-menu.js opens and closes the menu and moves aria-checked of the
// clicked radio or checkbox itself (before this file's handler, on the menu); this file
// sets it again from the real state, so a failed switch never shows as done.
//
// Phone (mobile_bars.html, the small bucket):
// - #tab-bar marks its active tab with aria-current: Folders while the sidebar sheet is
//   open (html.mobile-sidebar-open), else Feed.
// - The Feed tab closes a full-screen article through its Back button; when Feed is
//   already active it clicks the sidebar footer's Refresh ([data-action="reload-list"]);
//   else (the sheet is open) it clicks the All articles row of the full sidebar.
// - The other tabs are plain hooks: Search is [data-action="open-search"], Add a link,
//   Assistant #mobile-bottom-chat-btn (app.js attachGeneralChat) or a link, Folders
//   [data-action="toggle-sidebar-pin"], which app.js turns into the overlay on a phone.
// - Sheet focus: when the sheet opens, focus goes to the first nav row of #sidebar-full
//   and #article-list / #article-detail become inert; when it closes, inert goes and
//   focus returns to the Folders tab if that is what opened it. app.js swallows the
//   Folders click in a document capture listener (stopImmediatePropagation), so the
//   opener is noted by a window capture listener, which runs before it.
(function () {
  var doc = document;
  var TRIGGER = 'account-menu-trigger';
  var dropped = false;

  function each(sel, fn) {
    Array.prototype.forEach.call(doc.querySelectorAll(sel), fn);
  }

  function setChecked(el, on) {
    el.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  function controller() {
    var RF = window.RFOffline;
    return (RF && RF.page && typeof RF.page.current === 'function' && RF.page.current()) || null;
  }

  // What offline/page.js's supported() asks of the browser.
  function offlineSupported() {
    var nav = window.navigator || {};
    return !!window.indexedDB && !!nav.serviceWorker && !!nav.locks && typeof nav.locks.request === 'function';
  }

  function syncThemes() {
    var t = window.RFTheme;
    if (!t) return;
    var scheme = t.colorScheme();
    var app = t.appTheme();
    each('[data-rf-scheme]', function (el) { setChecked(el, el.getAttribute('data-rf-scheme') === scheme); });
    each('[data-rf-app-theme]', function (el) { setChecked(el, el.getAttribute('data-rf-app-theme') === app); });
  }

  function syncOffline() {
    var ctl = controller();
    var usable = !!ctl && offlineSupported();
    each('[data-rf-offline-menu]', function (el) {
      el.hidden = !usable;
      // Basecoat's arrow keys skip only disabled items, not hidden ones.
      if (usable) el.removeAttribute('aria-disabled');
      else el.setAttribute('aria-disabled', 'true');
      setChecked(el, usable && !!(ctl.state && ctl.state.enabled));
    });
  }

  function sync() {
    syncThemes();
    syncOffline();
  }

  function note(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
  }

  var switching = false;
  function toggleOffline() {
    var ctl = controller();
    if (!ctl || switching) { syncOffline(); return; }
    var on = !!(ctl.state && ctl.state.enabled);
    switching = true;
    var p;
    try {
      p = Promise.resolve(on ? ctl.disable() : ctl.enable());
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(function (r) {
      if (on) note('Offline reading is off. Articles already stored stay until you remove them.', 'info');
      else if (r && r.persisted === false) note('Offline reading is on. The browser may still clear stored articles when it runs short of space.', 'info');
      else note('Offline reading is on. Articles are being stored on this device.', 'success');
    }, function () {
      note('Offline reading could not be switched. Reload the page and try again.', 'error');
    }).then(function () {
      switching = false;
      syncOffline();
    });
    // Until it settles the item shows the state as it is, not Basecoat's flip.
    syncOffline();
  }

  doc.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    var scheme = t.closest('[data-rf-scheme]');
    if (scheme && window.RFTheme) {
      window.RFTheme.setColorScheme(scheme.getAttribute('data-rf-scheme'));
      syncThemes();
      return;
    }
    var app = t.closest('[data-rf-app-theme]');
    if (app && window.RFTheme) {
      window.RFTheme.setAppTheme(app.getAttribute('data-rf-app-theme'));
      syncThemes();
      return;
    }
    if (t.closest('[data-rf-offline-menu]')) toggleOffline();
  });

  function menuOpen() {
    var trigger = doc.getElementById(TRIGGER);
    return !!trigger && trigger.getAttribute('aria-expanded') === 'true';
  }

  // Only the sidebar's own request (poll, sidebarRefresh): requests of the rows inside
  // it only bubble through #sidebar.
  doc.addEventListener('htmx:beforeRequest', function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt || elt.id !== 'sidebar' || !menuOpen()) return;
    e.preventDefault();
    dropped = true;
  });

  doc.addEventListener('htmx:afterSwap', function (e) {
    var target = e.detail && e.detail.target;
    if (target && target.id === 'sidebar') sync();
  });

  function fireRefresh() {
    if (window.htmx && typeof window.htmx.trigger === 'function') window.htmx.trigger(doc.body, 'sidebarRefresh');
    else doc.body.dispatchEvent(new CustomEvent('sidebarRefresh', { bubbles: true }));
  }

  // Basecoat sends no event when the menu opens or closes: watch the trigger's
  // aria-expanded. The trigger is replaced with every sidebar swap, so the observer
  // watches the document, not one element.
  function onExpanded(trigger) {
    if (trigger.getAttribute('aria-expanded') === 'true') {
      sync();
    } else if (dropped) {
      dropped = false;
      fireRefresh();
    }
  }

  if (typeof MutationObserver === 'function' && doc.body) {
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.target && r.target.id === TRIGGER) { onExpanded(r.target); return; }
      }
    }).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
  }

  // ── Phone: tab bar and sidebar sheet ─────────────────────────────────────
  var root = doc.documentElement;
  var FULLSCREEN = ['mobile-detail-open', 'story-detail-open', 'deeplink-detail-open'];
  var PANES = ['article-list', 'article-detail'];
  var sheetOpen = false;    // the sheet state seen at the last class change
  var madeInert = false;    // the panes carry inert set by this file
  var pendingOpener = null; // the Folders tab clicked in the current task
  var opener = null;        // the Folders tab that opened the open sheet

  function sheetIsOpen() { return root.classList.contains('mobile-sidebar-open'); }

  function activeTab() { return sheetIsOpen() ? 'folders' : 'feed'; }

  function syncTabs() {
    var active = activeTab();
    each('#tab-bar [data-rf-tab]', function (el) {
      if (el.getAttribute('data-rf-tab') === active) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  }

  function clickFirst(sel) {
    var el = doc.querySelector(sel);
    if (el) el.click();
  }

  function onFeed() {
    for (var i = 0; i < FULLSCREEN.length; i++) {
      if (root.classList.contains(FULLSCREEN[i])) {
        // article_detail.html also renders inside the inline shell in the list, under
        // the same id: the panel's own button is the one that closes the overlay.
        var back = doc.querySelector('#article-detail #mobile-detail-back-btn') || doc.getElementById('mobile-detail-back-btn');
        if (back) back.click();
        return;
      }
    }
    if (activeTab() === 'feed') clickFirst('#sidebar-full [data-action="reload-list"]');
    else clickFirst('#sidebar-full .nav-item[hx-get="/htmx/articles"]');
  }

  doc.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (t && t.closest('#tab-bar [data-rf-tab="feed"]')) onFeed();
  });

  window.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    var tab = t && t.closest('#tab-bar [data-action="toggle-sidebar-pin"]');
    if (!tab) return;
    pendingOpener = tab;
    setTimeout(function () { pendingOpener = null; }, 0);
  }, true);

  function setInert(on) {
    PANES.forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
    madeInert = on;
  }

  function focusSheet() {
    var first = doc.querySelector('#sidebar-full .nav-item');
    if (!first) return;
    // The nav rows are <a hx-get> without href, which take no focus of their own.
    if (!first.hasAttribute('href') && !first.hasAttribute('tabindex')) first.setAttribute('tabindex', '-1');
    first.focus();
  }

  function onSheet() {
    var open = sheetIsOpen();
    if (open === sheetOpen) return;
    sheetOpen = open;
    syncTabs();
    if (open) {
      opener = pendingOpener;
      pendingOpener = null;
      // The class means a sheet only on a phone (base.html's small-bucket rules).
      if (root.dataset.bucket !== 'small') return;
      setInert(true);
      focusSheet();
    } else {
      if (madeInert) setInert(false);
      var back = opener;
      opener = null;
      if (back && back.isConnected) back.focus();
    }
  }

  if (typeof MutationObserver === 'function') {
    new MutationObserver(onSheet).observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  window.RFShell = { sync: sync };

  // Deferred: the offline controller is created by a deferred script before this one
  // or on DOMContentLoaded (page.js autoInit), so sync now and once more then.
  syncTabs();
  onSheet();
  sync();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sync);
})();
