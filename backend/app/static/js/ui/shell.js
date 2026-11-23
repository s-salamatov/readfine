// The reader shell (app/main.html): the sidebar (pin, collapsible sections, long-press,
// account menu) and, on a phone, the tab bar with the sidebar sheet (window.RFShell).
// Loaded deferred after app.js, on the reader page only (the only page with a sidebar).
//
// Account menu (sidebar.html) and the same items in the command palette (palette.html):
// - Theme items ([data-rf-scheme], [data-rf-app-theme]) set the colour scheme and the
//   app theme through window.RFTheme (init.js); the menu's radios carry aria-checked
//   for what is stored, on load, after every #sidebar swap and whenever the menu opens.
//   Only menuitemradio / menuitemcheckbox items get aria-checked: the palette's plain
//   role="menuitem" copies never do.
// - "Offline reading" ([data-rf-offline-menu]) switches offline mode through the page
//   controller (RFOffline.page.current(), offline/page.js). It is hidden without one or
//   in a browser that cannot do offline mode, and reflects the controller's state.
//   While hidden it is also aria-disabled and aria-hidden="true": Basecoat's arrow keys
//   skip disabled items, and command.js's filter rewrites aria-hidden on every pass, so
//   it is set back while the item is hidden (or a palette search would "match" it, and
//   the empty state and its group would count it). When the item changes state the
//   palette's command element is refreshed, since command.js caches its enabled items.
// - #sidebar is re-swapped every 300 s and on sidebarRefresh, which would close an open
//   account menu. While the menu is open, the sidebar's own requests are dropped; when
//   it closes, one sidebarRefresh makes up for all of them.
//
// Basecoat's dropdown-menu.js opens and closes the menu and moves aria-checked of the
// clicked radio or checkbox itself (before this file's handler, on the menu); this file
// sets it again from the real state, so a failed switch never shows as done.
//
// Sidebar (moved from app.js in s3-T10):
// - [data-action="toggle-sidebar-pin"] pins and unpins the sidebar, client-side only
//   (window._sidebarPinned, localStorage sidebarPinned, w-60 / w-12). On a phone the
//   same click opens or closes the sidebar sheet instead (a document capture listener
//   that stops the click there); from the command palette it closes the palette first.
// - .collapse-toggle[data-collapse] folds .collapsible#collapse-<key> (localStorage
//   sidebar_col_<key>), restored on load and after every #sidebar swap.
// - A long touch on a .mark-read-row shows its mark-read button (touch-active).
//
// Phone (mobile_bars.html, the small bucket):
// - The sheet is html.mobile-sidebar-open, opened by Folders, the title bar's
//   #mobile-titlebar-open-btn or the palette's "Toggle sidebar", closed by the same
//   toggle, #mobile-sidebar-backdrop or window._closeMobileSidebarOverlay() (app.js
//   calls it after a sidebar row or a search). Opening pushes a history entry, closing
//   goes back through it (app.js's popstate listener syncs the class).
// - #tab-bar marks its active tab with aria-current: Folders while the sheet is open,
//   else Feed.
// - The Feed tab closes a full-screen article through its Back button; when Feed is
//   already active it clicks the sidebar footer's Refresh ([data-action="reload-list"]);
//   else (the sheet is open) it clicks the All articles row of the full sidebar.
// - The other tabs are plain hooks: Search is [data-action="open-search"], Add a link,
//   Assistant #mobile-bottom-chat-btn (app.js attachGeneralChat) or a link.
// - Sheet focus: when the sheet opens, focus goes to the first nav row of #sidebar-full
//   and #article-list / #article-detail become inert; when it closes, inert goes and
//   focus returns to the Folders tab or the title bar button if one of them opened it.
//   The opener is noted by a window capture listener, which runs before the toggle
//   stops the click.
// - The nav rows are <a hx-get> without href: neither focusable nor run by Enter of
//   their own. One row at a time takes tabindex="0" (roving focus); Up / Down / Home /
//   End move between the visible rows, Enter and Space click the focused one.
(function () {
  var doc = document;
  var root = doc.documentElement;
  var TRIGGER = 'account-menu-trigger';
  var dropped = false;

  function each(sel, fn) {
    Array.prototype.forEach.call(doc.querySelectorAll(sel), fn);
  }

  // The event's target as an element, so .closest() can be asked of it whatever it is
  // (the selector stays a literal at the call, where scripts/check-dom-contract.mjs
  // finds it).
  var NONE = { closest: function () { return null; } };
  function elementOf(e) {
    var t = e.target;
    return t && typeof t.closest === 'function' ? t : NONE;
  }

  function setChecked(el, on) {
    var role = el.getAttribute('role');
    if (role !== 'menuitemradio' && role !== 'menuitemcheckbox') return;
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

  // The command element (palette.html) an item belongs to: refresh() re-reads which of
  // its items are enabled and filters them again.
  function refreshCommand(el) {
    var cmd = el.closest('.command');
    if (cmd && typeof cmd.refresh === 'function') cmd.refresh();
  }

  function syncOffline() {
    var ctl = controller();
    var usable = !!ctl && offlineSupported();
    each('[data-rf-offline-menu]', function (el) {
      var before = el.hidden + '|' + el.getAttribute('aria-disabled');
      el.hidden = !usable;
      // Basecoat's arrow keys skip only disabled items, not hidden ones.
      if (usable) {
        el.removeAttribute('aria-disabled');
        if (el.getAttribute('aria-hidden') === 'true') el.removeAttribute('aria-hidden');
      } else {
        el.setAttribute('aria-disabled', 'true');
      }
      // The palette's filter runs again here and sets aria-hidden from the query...
      if (before !== el.hidden + '|' + el.getAttribute('aria-disabled')) refreshCommand(el);
      // ...which a hidden item must not keep.
      if (!usable) el.setAttribute('aria-hidden', 'true');
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
    var scheme = elementOf(e).closest('[data-rf-scheme]');
    if (scheme && window.RFTheme) {
      window.RFTheme.setColorScheme(scheme.getAttribute('data-rf-scheme'));
      syncThemes();
      return;
    }
    var app = elementOf(e).closest('[data-rf-app-theme]');
    if (app && window.RFTheme) {
      window.RFTheme.setAppTheme(app.getAttribute('data-rf-app-theme'));
      syncThemes();
      return;
    }
    if (elementOf(e).closest('[data-rf-offline-menu]')) toggleOffline();
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
  // watches the document, not one element. The same observer puts aria-hidden="true"
  // back on a hidden offline item after command.js's filter cleared it.
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
      var trigger = null;
      for (var i = 0; i < records.length; i++) {
        var el = records[i].target;
        if (!el) continue;
        if (records[i].attributeName === 'aria-expanded') {
          if (el.id === TRIGGER) trigger = el;
        } else if (el.hidden && el.hasAttribute('data-rf-offline-menu') && el.getAttribute('aria-hidden') !== 'true') {
          el.setAttribute('aria-hidden', 'true');
        }
      }
      if (trigger) onExpanded(trigger);
    }).observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-hidden'] });
  }

  // ── Sidebar collapsible sections ────────────────────────────────────────
  function restoreSidebarCollapse(animate) {
    each('.collapse-toggle[data-collapse]', function (btn) {
      var key = btn.dataset.collapse;
      try {
        if (localStorage.getItem('sidebar_col_' + key) === '1') {
          var content = doc.getElementById('collapse-' + key);
          if (content) {
            if (!animate) content.style.transition = 'none';
            content.classList.add('collapsed');
            if (!animate) requestAnimationFrame(function () {
              requestAnimationFrame(function () { content.style.transition = ''; });
            });
          }
          btn.classList.add('is-collapsed');
        }
      } catch (err) {}
    });
  }

  doc.addEventListener('click', function (e) {
    var btn = elementOf(e).closest('.collapse-toggle[data-collapse]');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    var key = btn.dataset.collapse;
    var content = doc.getElementById('collapse-' + key);
    if (!content) return;
    var collapsed = content.classList.toggle('collapsed');
    btn.classList.toggle('is-collapsed', collapsed);
    try {
      if (collapsed) localStorage.setItem('sidebar_col_' + key, '1');
      else localStorage.removeItem('sidebar_col_' + key);
    } catch (err) {}
  }, true);

  // The scroll position app.js saved before the swap (window._sidebarScroll).
  function restoreSidebarScroll(sb) {
    if (!window._sidebarScroll) return;
    var scroller = sb.querySelector('#sidebar-scroll');
    if (scroller) scroller.scrollTop = window._sidebarScroll;
  }

  // afterSwap fires before the browser paints — prevents collapsed-section flash on load.
  // Restore the scroll here too (before paint) to avoid a visible scroll-to-top flash.
  doc.body.addEventListener('htmx:afterSwap', function (e) {
    if (!(e.detail.target && e.detail.target.id === 'sidebar')) return;
    restoreSidebarCollapse(false);
    restoreSidebarScroll(e.detail.target);
  });

  // HTMX settle can re-apply server classes and drop client-added "collapsed".
  // Re-apply once more after settle to keep sections collapsed after sidebar refresh.
  doc.body.addEventListener('htmx:afterSettle', function (e) {
    if (!(e.detail.target && e.detail.target.id === 'sidebar')) return;
    restoreSidebarCollapse(false);
    restoreSidebarScroll(e.detail.target);
  });

  // ── Sidebar mark-read button: long-press on touch devices ───────────────
  (function () {
    var lpTimer = null;
    var lpHideTimer = null;
    var lpX = 0, lpY = 0;

    function hideActive() {
      if (lpHideTimer) { clearTimeout(lpHideTimer); lpHideTimer = null; }
      doc.querySelectorAll('.mark-read-row.touch-active').forEach(function (r) { r.classList.remove('touch-active'); });
    }

    doc.body.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      var row = elementOf(e).closest('.mark-read-row');
      // A new row tapped (or none): hide any button already showing.
      hideActive();
      if (!row) return;
      lpX = e.clientX;
      lpY = e.clientY;
      lpTimer = setTimeout(function () {
        row.classList.add('touch-active');
        lpTimer = null;
        // Auto-hide after 3s if no action taken
        lpHideTimer = setTimeout(hideActive, 3000);
      }, 600);
    });

    doc.body.addEventListener('pointerup', function (e) {
      if (e.pointerType !== 'touch') return;
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    });

    doc.body.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'touch' || !lpTimer) return;
      var dx = e.clientX - lpX;
      var dy = e.clientY - lpY;
      if (Math.sqrt(dx * dx + dy * dy) > 10) { clearTimeout(lpTimer); lpTimer = null; }
    });

    // Prevent browser context menu (Firefox long-press) on sidebar rows
    doc.body.addEventListener('contextmenu', function (e) {
      if (elementOf(e).closest('.mark-read-row')) e.preventDefault();
    });
  })();

  // ── Sidebar pin and the phone sheet ─────────────────────────────────────
  var FULLSCREEN = ['mobile-detail-open', 'story-detail-open', 'deeplink-detail-open'];
  var PANES = ['article-list', 'article-detail'];
  var OPENERS = '#tab-bar [data-action="toggle-sidebar-pin"], #mobile-titlebar-open-btn';
  var sheetOpen = false;    // the sheet state seen at the last class change
  var madeInert = false;    // the panes carry inert set by this file
  var pendingOpener = null; // the Folders tab or title bar button clicked in this task
  var opener = null;        // the element that opened the open sheet
  var rovingRow = null;     // the nav row holding tabindex="0"

  function isMobile() { return root.dataset.bucket === 'small'; }

  function sheetIsOpen() { return root.classList.contains('mobile-sidebar-open'); }

  function openSidebarOverlay() {
    // Collapsible mode swaps rail↔full purely by toggling this class (both are always
    // rendered and CSS picks one), so no sidebarRefresh is needed.
    root.classList.add('mobile-sidebar-open');
    history.pushState({ mobileSidebarOpen: true }, '');
  }

  function closeSidebarOverlay() {
    root.classList.remove('mobile-sidebar-open');
    history.back();
  }

  function toggleSheet() {
    if (sheetIsOpen()) closeSidebarOverlay();
    else openSidebarOverlay();
  }

  // Exposed so app.js (a sidebar row, a search submit) can dismiss the sheet.
  window._closeMobileSidebarOverlay = function () {
    if (!isMobile()) return;
    if (sheetIsOpen()) closeSidebarOverlay();
  };

  // Runs fn once the dialog has closed. The close event is a task of its own, and
  // palette.js gives focus back to its opener on it: anything focused earlier (the
  // sheet's first row) would lose it again.
  function afterClose(dlg, fn) {
    var done = false;
    function run() {
      if (done) return;
      done = true;
      dlg.removeEventListener('close', run);
      fn();
    }
    dlg.addEventListener('close', run);
    dlg.close();
    // A browser that sends no close event still gets its sheet.
    setTimeout(run, 100);
  }

  // Phone: the toggle opens or closes the sheet instead of pinning. Stopped here, so
  // the pin listener below (and command.js, which would close the palette) never see
  // the click; an item of the open palette closes the palette itself first.
  doc.addEventListener('click', function (e) {
    if (!isMobile()) return;
    var el = elementOf(e).closest('[data-action="toggle-sidebar-pin"]');
    if (!el) return;
    e.stopImmediatePropagation();
    var dlg = el.closest('dialog');
    if (dlg && dlg.open) afterClose(dlg, toggleSheet);
    else toggleSheet();
  }, true);

  // Sidebar pin toggle — fully client-side. Both the rail and the full sidebar are
  // always in the DOM, so this just flips the state class + width and CSS swaps which
  // block is shown. No server round-trip → instant collapse/expand.
  doc.body.addEventListener('click', function (e) {
    if (!elementOf(e).closest('[data-action="toggle-sidebar-pin"]')) return;
    var next = !window._sidebarPinned;
    window._sidebarPinned = next;
    try { localStorage.setItem('sidebarPinned', next ? 'true' : 'false'); } catch (err) {}
    root.classList.toggle('sidebar-unpinned', !next);
    var sidebar = doc.getElementById('sidebar');
    if (sidebar) {
      sidebar.classList.toggle('w-60', next);
      sidebar.classList.toggle('w-12', !next);
    }
  });

  // Title bar hamburger (hideable-up mode).
  doc.addEventListener('click', function (e) {
    if (!isMobile()) return;
    if (elementOf(e).closest('#mobile-titlebar-open-btn')) openSidebarOverlay();
  });

  // Backdrop: close the sheet.
  doc.addEventListener('click', function (e) {
    if (!elementOf(e).closest('#mobile-sidebar-backdrop')) return;
    closeSidebarOverlay();
  });

  // ── Phone: tab bar ──────────────────────────────────────────────────────
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
    if (elementOf(e).closest('#tab-bar [data-rf-tab="feed"]')) onFeed();
  });

  window.addEventListener('click', function (e) {
    var el = elementOf(e).closest(OPENERS);
    if (!el) return;
    pendingOpener = el;
    setTimeout(function () { pendingOpener = null; }, 0);
  }, true);

  // ── Phone: sheet focus and keys ─────────────────────────────────────────
  function setInert(on) {
    PANES.forEach(function (id) {
      var el = doc.getElementById(id);
      if (!el) return;
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
    madeInert = on;
  }

  // The nav rows a reader can reach: not inside a collapsed section.
  function navRows() {
    return Array.prototype.filter.call(doc.querySelectorAll('#sidebar-full .nav-item'), function (a) {
      return !a.closest('.collapsible.collapsed');
    });
  }

  function focusRow(row) {
    if (rovingRow && rovingRow !== row && rovingRow.isConnected && !rovingRow.hasAttribute('href')) {
      rovingRow.setAttribute('tabindex', '-1');
    }
    if (!row.hasAttribute('href')) row.setAttribute('tabindex', '0');
    rovingRow = row;
    row.focus();
  }

  function focusSheet() {
    var first = navRows()[0];
    if (first) focusRow(first);
  }

  doc.addEventListener('keydown', function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    var row = elementOf(e).closest('#sidebar-full .nav-item');
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') {
      // A row with href follows its link on Enter by itself.
      if (e.key === 'Enter' && row.hasAttribute('href')) return;
      e.preventDefault();
      row.click();
      return;
    }
    var rows = navRows();
    var at = rows.indexOf(row);
    var to = -1;
    if (e.key === 'ArrowDown') to = Math.min(at + 1, rows.length - 1);
    else if (e.key === 'ArrowUp') to = Math.max(at - 1, 0);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = rows.length - 1;
    else return;
    e.preventDefault();
    if (to >= 0 && rows[to]) focusRow(rows[to]);
  });

  function onSheet() {
    var open = sheetIsOpen();
    if (open === sheetOpen) return;
    sheetOpen = open;
    syncTabs();
    if (open) {
      opener = pendingOpener;
      pendingOpener = null;
      // The class means a sheet only on a phone (base.html's small-bucket rules).
      if (!isMobile()) return;
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
  restoreSidebarCollapse(false);
  syncTabs();
  onSheet();
  sync();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sync);
})();
