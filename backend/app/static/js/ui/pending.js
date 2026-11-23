// Readfine delayed delete: window.RFPending (s3-T6, design §5.4).
//
// A classic script, loaded deferred on every page (base.html) after ui/toast.js and
// before app.js. A delete hides the object's rows at once and shows a "Deleted <label>"
// toast with Undo; 10 s later every pending delete goes to the server in one request.
// Shared by the feeds (s5), labels and filters (s7) screens.
//
// Markup:
//   trigger  <button data-rf-delete="<kind>:<id>" data-rf-delete-label="…">
//            A delegated click calls schedule().
//   rows     every rendered row of that object carries data-rf-delete-key="<kind>:<id>".
//            Hidden rows get the hidden attribute plus data-rf-pending-delete; only rows
//            with that marker are ever unhidden.
//
// API:
//   RFPending.schedule({kind, id, label}) -> key "<kind>:<id>" (undefined for an id that
//     is not a positive integer or a kind other than feed | label | filter: one bad
//     trigger must not make the server reject a whole batch). Hides the rows, shows the
//     Undo toast (duration -1), starts a 10 s timer.
//     A key already pending or sending is not scheduled twice.
//   RFPending.undo(key) -> true when the entry was pending: drops it, unhides its rows
//     still in the DOM, closes the toast. False once it is sending, done or failed.
//   RFPending.flush(reason) -> reason: timer | nav | history | hidden | unload.
//     Moves every pending entry to sending (toast "Deleting <label>…", no Undo); a timer
//     flush moves only the entries that are due (their own 10 s are up; deletes scheduled
//     in the same millisecond share one request), so each delete keeps its full Undo window.
//     It writes the keys into sessionStorage['rf.deletedKeys'] and sends one keepalive
//     POST /settings/deletes with a JSON body [{kind, id}, …] and x-csrftoken from the
//     csrftoken cookie. timer / nav / history wait while a request is in flight and run
//     once it settles; hidden / unload send at once (the server's per-user lock
//     serialises the batches). Nothing pending sends nothing.
//   RFPending.state(key) -> pending | sending | done | failed | undefined.
//
// Flushes run on: an entry's timer; htmx:beforeRequest with detail.boosted (nav);
// htmx:beforeHistorySave (history); visibilitychange to hidden; pagehide and
// beforeunload (unload).
//
// Answer (batch route contract, s3-T4): success is r.ok, not r.redirected, and a JSON
// body whose results is an array. A done item's toast reads "Deleted <label>" and closes
// after 3 s; a failed item, or one missing from results, gets its rows back, leaves
// sessionStorage and reads "Couldn't delete <label>". Notices come from the HX-Trigger
// header's showToast, the same path htmx uses. Anything else (a network error, a
// followed redirect to the login page, 401, 403, 429, 5xx, a non-JSON body) fails every
// item of that request.
//
// Hide pass, on DOMContentLoaded and every htmx:afterSwap: rows whose key is pending,
// sending or in sessionStorage younger than 2 minutes are hidden, so back/forward or a
// reload right after a delete does not show the row again. Older keys are dropped.
//
// Labels reach the page only through RFToast, which sets textContent.
(function () {
  'use strict';

  var ENDPOINT = '/settings/deletes';
  var DELAY_MS = 10000;
  var DONE_TOAST_MS = 3000;
  var FAILED_TOAST_MS = 5000;
  var STORE = 'rf.deletedKeys';
  var STORE_TTL_MS = 2 * 60 * 1000;
  var WAITING = { timer: true, nav: true, history: true };
  var KINDS = { feed: true, label: true, filter: true };

  var entries = {}; // key -> {kind, id, label, state, toast, timer, at, due}
  var inFlight = 0;
  var queued = null; // reason of a normal flush waiting for the requests in flight

  function keyOf(kind, id) { return String(kind) + ':' + String(id); }

  function csrfToken() {
    var m = document.cookie.split('; ').find(function (r) { return r.startsWith('csrftoken='); });
    return m ? m.split('=')[1] : '';
  }

  // ---------------------------------------------------------------- sessionStorage

  function readStore() {
    var now = Date.now();
    var out = {};
    var raw = null;
    try { raw = JSON.parse(window.sessionStorage.getItem(STORE) || '{}'); } catch (e) { raw = null; }
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) {
        var at = Number(raw[k]);
        if (at > 0 && now - at < STORE_TTL_MS) out[k] = at;
      });
    }
    return out;
  }

  function writeStore(map) {
    try {
      if (Object.keys(map).length) window.sessionStorage.setItem(STORE, JSON.stringify(map));
      else window.sessionStorage.removeItem(STORE);
    } catch (e) { /* storage full or blocked: the hide pass just has less to go on */ }
  }

  function storeKeys(keys) {
    var map = readStore();
    var now = Date.now();
    keys.forEach(function (k) { map[k] = now; });
    writeStore(map);
  }

  function unstoreKey(key) {
    var map = readStore();
    delete map[key];
    writeStore(map);
  }

  // ---------------------------------------------------------------- rows

  // Compared by value, never built into a selector: a key is not selector-safe.
  function rowsOf(key) {
    var out = [];
    document.querySelectorAll('[data-rf-delete-key]').forEach(function (el) {
      if (el.getAttribute('data-rf-delete-key') === key) out.push(el);
    });
    return out;
  }

  function hideRow(el) {
    if (el.hasAttribute('data-rf-pending-delete')) return;
    // Remember a row that was hidden already, so a restore leaves it hidden.
    el.setAttribute('data-rf-pending-delete', el.hidden ? 'was-hidden' : '');
    el.hidden = true;
  }

  function hideRows(key) { rowsOf(key).forEach(hideRow); }

  function restoreRows(key) {
    rowsOf(key).forEach(function (el) {
      if (!el.hasAttribute('data-rf-pending-delete')) return;
      var wasHidden = el.getAttribute('data-rf-pending-delete') === 'was-hidden';
      el.removeAttribute('data-rf-pending-delete');
      if (!wasHidden) el.hidden = false;
    });
  }

  function hidePass() {
    var map = readStore();
    writeStore(map); // drops the keys older than 2 minutes
    document.querySelectorAll('[data-rf-delete-key]').forEach(function (el) {
      var key = el.getAttribute('data-rf-delete-key');
      var e = entries[key];
      if ((e && (e.state === 'pending' || e.state === 'sending')) || map[key]) hideRow(el);
    });
  }

  // ---------------------------------------------------------------- toasts

  var NO_TOAST = { el: null, update: function () {}, close: function () {} };

  function toast(opts) {
    if (!window.RFToast || typeof window.RFToast.show !== 'function') return NO_TOAST;
    try { return window.RFToast.show(opts) || NO_TOAST; } catch (e) { return NO_TOAST; }
  }

  function showNotices(header) {
    if (!header || !window.RFToast || typeof window.RFToast.fromTrigger !== 'function') return;
    var parsed;
    try { parsed = JSON.parse(header); } catch (e) { return; }
    if (parsed && typeof parsed === 'object' && parsed.showToast != null) {
      window.RFToast.fromTrigger(parsed.showToast);
    }
  }

  // ---------------------------------------------------------------- API

  function schedule(opts) {
    opts = opts || {};
    var kind = String(opts.kind);
    var id = parseInt(opts.id, 10);
    // An unknown kind would make the server answer 422 for the whole batch.
    if (!(id > 0) || !Object.prototype.hasOwnProperty.call(KINDS, kind)) return undefined;
    var key = keyOf(kind, id);
    var old = entries[key];
    if (old && (old.state === 'pending' || old.state === 'sending')) return key;
    var label = opts.label == null ? '' : String(opts.label);
    var entry = { kind: kind, id: id, label: label, state: 'pending', toast: NO_TOAST, timer: null, at: Date.now(), due: false };
    entries[key] = entry;
    hideRows(key);
    entry.toast = toast({
      msg: 'Deleted ' + label,
      action: { label: 'Undo', onClick: function () { undo(key); } },
      duration: -1,
    });
    entry.timer = window.setTimeout(function () { markDue(entry); flush('timer'); }, DELAY_MS);
    return key;
  }

  // An entry's timer fired: it is due, and so is every pending entry scheduled no later
  // than it (same millisecond or older): their 10 s are up too. A younger one is not.
  function markDue(entry) {
    entry.timer = null;
    entry.due = true;
    Object.keys(entries).forEach(function (k) {
      var other = entries[k];
      if (other.state === 'pending' && other.at <= entry.at) other.due = true;
    });
  }

  function undo(key) {
    var entry = entries[key];
    if (!entry || entry.state !== 'pending') return false;
    window.clearTimeout(entry.timer);
    delete entries[key];
    restoreRows(key);
    entry.toast.close();
    return true;
  }

  function state(key) {
    var entry = entries[key];
    return entry ? entry.state : undefined;
  }

  function flush(reason) {
    if (WAITING[reason] && inFlight > 0) {
      // nav / history outrank a queued timer flush: they send everything pending.
      if (!queued || reason !== 'timer') queued = reason;
      return;
    }
    var batch = [];
    Object.keys(entries).forEach(function (key) {
      var entry = entries[key];
      if (entry.state !== 'pending') return;
      // A timer flush sends only the entries whose own 10 s are up; the others keep Undo.
      if (reason === 'timer' && !entry.due) return;
      window.clearTimeout(entry.timer);
      entry.timer = null;
      entry.state = 'sending';
      entry.toast.update({ msg: 'Deleting ' + entry.label + '…' });
      batch.push(key);
    });
    if (!batch.length) return;
    // Stored before the request leaves: a back/forward during it must not show the row.
    storeKeys(batch);
    send(batch);
  }

  function send(batch) {
    inFlight++;
    var body = batch.map(function (key) { return { kind: entries[key].kind, id: entries[key].id }; });
    var request;
    try {
      request = window.fetch(ENDPOINT, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrfToken() },
        body: JSON.stringify(body),
      });
    } catch (e) {
      request = Promise.reject(e);
    }
    Promise.resolve(request).then(function (r) {
      if (!r || !r.ok || r.redirected) throw new Error('delete batch answered ' + (r && r.status));
      var header = r.headers && r.headers.get ? r.headers.get('HX-Trigger') : null;
      return r.json().then(function (data) {
        if (!data || !Array.isArray(data.results)) throw new Error('delete batch: no results');
        return { results: data.results, header: header };
      });
    }).then(function (answer) {
      var status = {};
      answer.results.forEach(function (it) {
        if (it && it.kind != null && it.id != null) status[keyOf(it.kind, it.id)] = it.status;
      });
      batch.forEach(function (key) {
        if (status[key] === 'done') done(key);
        else failed(key);
      });
      showNotices(answer.header);
    }, function (err) {
      if (window.console) console.warn('delete batch failed:', err);
      batch.forEach(failed);
    }).then(settled, settled);
  }

  function settled() {
    inFlight--;
    if (inFlight > 0 || !queued) return;
    var reason = queued;
    queued = null;
    flush(reason);
  }

  function done(key) {
    var entry = entries[key];
    if (!entry || entry.state !== 'sending') return;
    entry.state = 'done';
    entry.toast.update({ msg: 'Deleted ' + entry.label, duration: DONE_TOAST_MS });
  }

  function failed(key) {
    var entry = entries[key];
    if (!entry || entry.state !== 'sending') return;
    entry.state = 'failed';
    unstoreKey(key);
    restoreRows(key);
    entry.toast.update({ msg: "Couldn't delete " + entry.label, type: 'error', duration: FAILED_TOAST_MS });
  }

  // ---------------------------------------------------------------- wiring

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-rf-delete]') : null;
    if (!btn) return;
    var spec = btn.getAttribute('data-rf-delete') || '';
    var cut = spec.lastIndexOf(':');
    if (cut <= 0) return;
    e.preventDefault();
    schedule({
      kind: spec.slice(0, cut),
      id: spec.slice(cut + 1),
      label: btn.getAttribute('data-rf-delete-label') || '',
    });
  });

  document.addEventListener('htmx:beforeRequest', function (e) {
    if (e.detail && e.detail.boosted) flush('nav');
  });
  document.addEventListener('htmx:beforeHistorySave', function () { flush('history'); });
  document.addEventListener('htmx:afterSwap', hidePass);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush('hidden');
  });
  window.addEventListener('pagehide', function () { flush('unload'); });
  window.addEventListener('beforeunload', function () { flush('unload'); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hidePass);
  else hidePass();

  window.RFPending = { schedule: schedule, undo: undo, flush: flush, state: state };
})();
