// Readfine command palette: window.RFPalette (s3-T7).
//
// A classic script, loaded deferred by app/partials/palette.html (the reader page only)
// after base.html's htmx, Basecoat command.min.js and dialog.js. The markup is the
// command_palette macro (ui/nav.html) with id "rf-palette": Basecoat's command.js
// filters its items, moves the active one with the arrow keys, runs it on Enter and
// closes the dialog after a click on any visible item.
//
// What this adds:
//   - RFPalette.open(prefill): remembers the focused element, opens the <dialog> as a
//     modal, fills the input with prefill (or empties it) and focuses it. However the
//     dialog closes (Escape, an item, a click outside), focus returns to that element.
//     Opening an open palette only refocuses the input. RFPalette.isOpen().
//   - Server matches: typing is debounced 200 ms, then GET /htmx/palette?q= with
//     HX-Request: true through an AbortController; a newer query aborts the older one
//     and a sequence number drops any answer that still arrives. A 200 body goes into
//     #rf-palette-results (htmx.process, then the command element's refresh(), so the
//     new items, which carry data-force, join the list). States, as a
//     <p data-rf-palette-state="…">, never a menu item:
//       error   - a non-2xx answer, a followed redirect, a network failure online;
//       offline - the service worker's answer (X-Readfine-Offline: 1 or a
//                 data-rf-needs-connection body) or a network failure offline;
//       empty   - the server's own empty state, or a blank body.
//     An HX-Redirect header (an expired session) navigates there. Below two characters
//     nothing is sent and the results are cleared.
//   - [data-rf-nav="<url>"] items: click the sidebar row with that hx-get, the full
//     sidebar's first (as app.js's _kbGoTo does), else load the list into
//     #article-list with htmx.ajax().
//   - [data-rf-palette-advanced] ("Advanced search…"): closes the palette and opens the
//     old search modal (app.js openSearchModal; it also works offline). Its first
//     argument is the "reopen the last search" flag, so the modal is opened fresh and
//     the typed query goes into its #search-input once htmx has loaded it.
// Everything else ([data-action], [data-rf-scheme], [data-rf-app-theme],
// [data-rf-offline-menu]) is run by its owner's delegated click listener (app.js,
// ui/shell.js).
// Global: one click, one input and one capture-phase close listener on document.
(function () {
  'use strict';

  // Loaded once per document: a second copy (a script re-run by a swap) would add
  // its listeners twice.
  if (window.RFPalette) return;

  var ID = 'rf-palette';
  var URL_BASE = '/htmx/palette?q=';
  var DEBOUNCE_MS = 200;
  var MIN_CHARS = 2;
  var MSG = {
    error: 'Search failed. Try again.',
    offline: 'Search needs a connection. Advanced search works offline.',
    empty: 'No articles, saved searches or feeds match.',
  };

  var opener = null;
  var timer = null;
  var inflight = null; // AbortController of the request in flight
  var seq = 0;
  var pendingQuery = null; // the one-shot afterSettle listener of Advanced search

  function dialogEl() { return document.getElementById(ID); }
  function inputEl() { return document.getElementById(ID + '-input'); }
  function resultsEl() { return document.getElementById(ID + '-results'); }

  function refresh() {
    var dlg = dialogEl();
    var cmd = dlg && dlg.querySelector('.command');
    if (cmd && typeof cmd.refresh === 'function') cmd.refresh();
  }

  function focusQuietly(el) {
    if (el && el.isConnected && typeof el.focus === 'function') {
      try { el.focus(); } catch (e) { /* an element that cannot take focus */ }
    }
  }

  // Server markup (already escaped by Jinja), or '' to clear.
  function setResults(html) {
    var box = resultsEl();
    if (!box) return;
    box.innerHTML = html;
    if (html && window.htmx && typeof window.htmx.process === 'function') window.htmx.process(box);
    refresh();
  }

  function showState(name) {
    var box = resultsEl();
    if (!box) return;
    var p = document.createElement('p');
    p.setAttribute('data-rf-palette-state', name);
    p.className = 'px-2 py-3 text-sm text-muted-foreground';
    p.textContent = MSG[name];
    box.replaceChildren(p);
    refresh();
  }

  // Drops the scheduled search and the one in flight; their answers are ignored.
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (inflight) { inflight.abort(); inflight = null; }
    seq++;
  }

  function isOffline(res, body) {
    return res.headers.get('X-Readfine-Offline') === '1' || body.indexOf('data-rf-needs-connection') !== -1;
  }

  function search(q) {
    timer = null;
    var mine = ++seq;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    inflight = ctl;
    var opts = { headers: { 'HX-Request': 'true' }, credentials: 'same-origin' };
    if (ctl) opts.signal = ctl.signal;
    window.fetch(URL_BASE + encodeURIComponent(q), opts).then(function (res) {
      if (mine !== seq) return null;
      var redirect = res.headers.get('HX-Redirect');
      if (redirect) {
        window.location.href = redirect;
        return null;
      }
      return res.text().then(function (body) {
        if (mine !== seq) return;
        inflight = null;
        if (isOffline(res, body)) showState('offline');
        else if (!res.ok || res.redirected) showState('error');
        else if (!body.trim()) showState('empty');
        else setResults(body);
      });
    }).catch(function (err) {
      if (mine !== seq || (err && err.name === 'AbortError')) return;
      inflight = null;
      showState(window.navigator && window.navigator.onLine === false ? 'offline' : 'error');
    });
  }

  function onInput() {
    var input = inputEl();
    if (!input) return;
    cancel();
    var q = input.value.trim();
    if (q.length < MIN_CHARS) {
      if (resultsEl() && resultsEl().firstChild) setResults('');
      return;
    }
    timer = setTimeout(function () { search(q); }, DEBOUNCE_MS);
  }

  function isOpen() {
    var dlg = dialogEl();
    return !!(dlg && dlg.open);
  }

  function open(prefill) {
    var dlg = dialogEl();
    var input = inputEl();
    if (!dlg || typeof dlg.showModal !== 'function') return false;
    if (dlg.open) {
      focusQuietly(input);
      return true;
    }
    opener = document.activeElement;
    cancel();
    // Theme checks and the offline item as they are now (ui/shell.js).
    if (window.RFShell && typeof window.RFShell.sync === 'function') window.RFShell.sync();
    if (input) input.value = typeof prefill === 'string' ? prefill : '';
    setResults('');
    dlg.showModal();
    focusQuietly(input);
    if (input && input.value.trim()) onInput();
    return true;
  }

  function onClose() {
    cancel();
    var el = opener;
    opener = null;
    if (el) focusQuietly(el);
  }

  function goTo(url) {
    var row = null;
    var full = document.querySelectorAll('#sidebar-full .nav-item[hx-get]');
    var any = document.querySelectorAll('#sidebar .nav-item[hx-get]');
    var lists = [full, any];
    for (var l = 0; l < lists.length && !row; l++) {
      for (var i = 0; i < lists[l].length; i++) {
        if (lists[l][i].getAttribute('hx-get') === url) { row = lists[l][i]; break; }
      }
    }
    if (row) {
      row.click();
    } else if (window.htmx && typeof window.htmx.ajax === 'function') {
      window.htmx.ajax('GET', url, { target: '#article-list', swap: 'innerHTML' });
    }
  }

  function openAdvanced(q) {
    var dlg = dialogEl();
    if (dlg && dlg.open) dlg.close();
    if (typeof window.openSearchModal !== 'function') return;
    if (pendingQuery) {
      document.body.removeEventListener('htmx:afterSettle', pendingQuery);
      pendingQuery = null;
    }
    if (q) {
      pendingQuery = function (event) {
        var target = event.detail && event.detail.target;
        if (!target || target.id !== 'search-modal-content') return;
        document.body.removeEventListener('htmx:afterSettle', pendingQuery);
        pendingQuery = null;
        var field = document.getElementById('search-input');
        if (!field) return;
        field.value = q;
        focusQuietly(field);
        if (typeof field.select === 'function') field.select();
      };
      // After app.js's own afterSettle listener on body, which focuses the field.
      document.body.addEventListener('htmx:afterSettle', pendingQuery);
    }
    window.openSearchModal(false);
  }

  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === ID + '-input') onInput();
  });

  // command.js closes the dialog from the menu's own click listener, before this one
  // runs; the input keeps its value until the next open.
  document.addEventListener('click', function (event) {
    var t = event.target;
    if (!t || typeof t.closest !== 'function') return;
    var dlg = dialogEl();
    if (!dlg || !dlg.contains(t)) return;
    var item = t.closest('[role="menuitem"]');
    if (!item || item.getAttribute('aria-disabled') === 'true') return;
    if (item.hasAttribute('data-rf-palette-advanced')) {
      event.preventDefault();
      var input = inputEl();
      openAdvanced(input ? input.value.trim() : '');
      return;
    }
    var url = item.getAttribute('data-rf-nav');
    if (url) {
      event.preventDefault();
      if (dlg.open) dlg.close();
      goTo(url);
    }
  });

  // close does not bubble: caught in the capture phase, so a re-rendered dialog is
  // covered too.
  document.addEventListener('close', function (event) {
    if (event.target && event.target.id === ID) onClose();
  }, true);

  window.RFPalette = { open: open, isOpen: isOpen, goTo: goTo };
})();
