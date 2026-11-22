// The reader shell (app/main.html): the sidebar's account menu (window.RFShell).
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

  window.RFShell = { sync: sync };

  // Deferred: the offline controller is created by a deferred script before this one
  // or on DOMContentLoaded (page.js autoInit), so sync now and once more then.
  sync();
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sync);
})();
