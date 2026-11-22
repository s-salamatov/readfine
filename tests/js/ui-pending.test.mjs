// Delayed delete (s3-T6, design §5.4): window.RFPending (static/js/ui/pending.js) hides
// the rows of an object at once, offers Undo for 10 s, then sends every pending delete
// in one keepalive POST /settings/deletes (the batch route of s3-T4). Exits (a boosted
// navigation, a history save, a hidden tab, pagehide, beforeunload) flush early. Sent
// keys stay in sessionStorage for 2 minutes so a re-rendered row (back/forward, a
// reload) stays hidden (s3 Review Focus 1-3).
//
// Each test loads pending.js alone into its own jsdom with a stub RFToast that records
// calls, a fake fetch and node:test's mocked setTimeout handed to the window.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PENDING = path.join(ROOT, 'backend', 'app', 'static', 'js', 'ui', 'pending.js');
const STORE = 'rf.deletedKeys';

const ROWS =
  '<ul>' +
  '<li id="feed-row-7" data-rf-delete-key="feed:7">Seven ' +
  '<button id="del-7" type="button" data-rf-delete="feed:7" data-rf-delete-label="Seven">x</button></li>' +
  '<li id="feed-row-8" data-rf-delete-key="feed:8">Eight ' +
  '<button id="del-8" type="button" data-rf-delete="feed:8" data-rf-delete-label="Eight">x</button></li>' +
  '<li id="label-row-3" data-rf-delete-key="label:3">Three</li>' +
  '</ul>';

function ok(results, { trigger = null } = {}) {
  return {
    ok: true, status: 200, redirected: false,
    headers: { get: (n) => (n.toLowerCase() === 'hx-trigger' ? trigger : null) },
    json: async () => ({ results, notices: [] }),
  };
}

function bad({ status = 200, redirected = false, json = true } = {}) {
  return {
    ok: status >= 200 && status < 300, status, redirected,
    headers: { get: () => null },
    json: async () => {
      if (!json) throw new SyntaxError('Unexpected token <');
      return { detail: 'x' };
    },
  };
}

// Echoes every requested item back as done, unless `failed` lists its key.
function echo(failed = []) {
  return (body) => ok(body.map((it) => ({
    kind: it.kind, id: it.id,
    status: failed.includes(it.kind + ':' + it.id) ? 'failed' : 'done',
  })));
}

// Read inside each test, so a missing pending.js fails every test, not the file.
function load({ body = ROWS, store = null, respond = echo() } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/settings/feeds',
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  w.setTimeout = (fn, ms) => setTimeout(fn, ms);
  w.clearTimeout = (t) => clearTimeout(t);
  w.document.cookie = 'csrftoken=tok123';
  if (store) w.sessionStorage.setItem(STORE, store);

  const toasts = [];
  w.RFToast = {
    show(opts) {
      const t = { opts, updates: [], closed: false };
      t.handle = {
        el: null,
        update: (next) => t.updates.push(next),
        close: () => { t.closed = true; },
      };
      toasts.push(t);
      return t.handle;
    },
    fromTrigger(value) { toasts.push({ trigger: value }); return []; },
  };

  const calls = [];
  w.fetch = (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, body });
    let settle;
    const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const r = respond(body, calls.length);
    if (r === 'hold') {
      calls[calls.length - 1].settle = settle;
      return p;
    }
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };

  const script = w.document.createElement('script');
  script.textContent = fs.readFileSync(PENDING, 'utf8');
  w.document.head.appendChild(script);
  return { w, errors, toasts, calls };
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 6; i++) await drain(); }

function row(w, id) { return w.document.getElementById(id); }
function click(w, el) {
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function stored(w) { return JSON.parse(w.sessionStorage.getItem(STORE) || '{}'); }
function setHidden(w, hidden) {
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
}

test('pending: undo restores the row and sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, toasts, calls } = load();
  click(w, row(w, 'del-7'));
  const r7 = row(w, 'feed-row-7');
  assert.equal(r7.hidden, true);
  assert.ok(r7.hasAttribute('data-rf-pending-delete'));
  assert.equal(w.RFPending.state('feed:7'), 'pending');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].opts.msg, 'Deleted Seven');
  assert.equal(toasts[0].opts.duration, -1);
  assert.equal(toasts[0].opts.action.label, 'Undo');

  toasts[0].opts.action.onClick(toasts[0].handle);
  assert.equal(r7.hidden, false);
  assert.equal(r7.hasAttribute('data-rf-pending-delete'), false);
  assert.equal(toasts[0].closed, true);
  assert.equal(w.RFPending.state('feed:7'), undefined);
  t.mock.timers.tick(20000);
  w.dispatchEvent(new w.Event('beforeunload'));
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(errors, []);
});

test('pending: sent once after 10 s with csrf header, keepalive and JSON body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, toasts, calls } = load();
  const key = w.RFPending.schedule({ kind: 'feed', id: 7, label: 'Seven' });
  assert.equal(key, 'feed:7');
  t.mock.timers.tick(9999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  const { url, opts, body } = calls[0];
  assert.equal(url, '/settings/deletes');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.keepalive, true);
  assert.equal(opts.credentials, 'same-origin');
  assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.equal(opts.headers['x-csrftoken'], 'tok123');
  assert.deepEqual(body, [{ kind: 'feed', id: 7 }]);
  assert.ok(stored(w)['feed:7'] > 0, 'the key is stored before the answer');
  await settle();
  assert.equal(w.RFPending.state('feed:7'), 'done');
  assert.equal(row(w, 'feed-row-7').hidden, true);
  const last = toasts[0].updates.at(-1);
  assert.equal(last.msg, 'Deleted Seven');
  assert.equal(last.duration, 3000);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(calls.length, 1, 'sent exactly once');
  assert.deepEqual(errors, []);
});

test('pending: beforeunload sends both in one keepalive request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, calls } = load();
  click(w, row(w, 'del-7'));
  click(w, row(w, 'del-8'));
  w.dispatchEvent(new w.Event('beforeunload'));
  w.dispatchEvent(new w.Event('pagehide'));
  assert.equal(calls.length, 1, 'one request, and the pagehide after it sends nothing');
  assert.equal(calls[0].opts.keepalive, true);
  assert.deepEqual(calls[0].body, [{ kind: 'feed', id: 7 }, { kind: 'feed', id: 8 }]);
  assert.deepEqual(Object.keys(stored(w)).sort(), ['feed:7', 'feed:8']);
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(calls.length, 1, 'the timers were cleared by the flush');
  assert.deepEqual(errors, []);
});

test('pending: boosted navigation and beforeHistorySave flush', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, calls } = load();
  click(w, row(w, 'del-7'));
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeRequest', { bubbles: true, detail: { boosted: false } }));
  assert.equal(calls.length, 0, 'a plain htmx request does not flush');
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeRequest', { bubbles: true, detail: { boosted: true } }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, [{ kind: 'feed', id: 7 }]);
  await settle();

  click(w, row(w, 'del-8'));
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeHistorySave', { bubbles: true, detail: {} }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, [{ kind: 'feed', id: 8 }]);
  await settle();
  assert.equal(w.RFPending.state('feed:8'), 'done');
  assert.deepEqual(errors, []);
});

test('pending: hidden tab removes Undo and reads Deleting…', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, toasts, calls } = load({ respond: () => 'hold' });
  click(w, row(w, 'del-7'));
  setHidden(w, true);
  assert.equal(calls.length, 1);
  assert.equal(w.RFPending.state('feed:7'), 'sending');
  const upd = toasts[0].updates[0];
  assert.equal(upd.msg, 'Deleting Seven…');
  assert.ok(!upd.action, 'Undo is gone');
  assert.equal(w.RFPending.undo('feed:7'), false, 'undo does nothing once sending');
  assert.equal(row(w, 'feed-row-7').hidden, true);
  setHidden(w, false);
  assert.equal(calls.length, 1, 'turning visible sends nothing');
  assert.deepEqual(errors, []);
});

test('pending: sent keys hide re-rendered rows after reload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = load({ respond: () => 'hold' });
  click(first.w, row(first.w, 'del-7'));
  first.w.dispatchEvent(new first.w.Event('pagehide'));
  const saved = JSON.parse(first.w.sessionStorage.getItem(STORE));
  saved['label:3'] = Date.now() - 3 * 60 * 1000; // older than 2 min

  const second = load({ store: JSON.stringify(saved) });
  await settle(); // jsdom fires DOMContentLoaded after the constructor returns
  assert.equal(row(second.w, 'feed-row-7').hidden, true, 'a sent key hides the row at load');
  assert.equal(row(second.w, 'feed-row-8').hidden, false);
  assert.equal(row(second.w, 'label-row-3').hidden, false, 'an old key does not hide');
  assert.deepEqual(Object.keys(stored(second.w)), ['feed:7'], 'old keys are dropped');

  // A swapped-in copy of the row is hidden too.
  const ul = second.w.document.querySelector('ul');
  ul.insertAdjacentHTML('beforeend', '<li id="feed-row-7b" data-rf-delete-key="feed:7">Seven again</li>');
  second.w.document.body.dispatchEvent(new second.w.CustomEvent('htmx:afterSwap', { bubbles: true, detail: {} }));
  assert.equal(row(second.w, 'feed-row-7b').hidden, true);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
});

test('pending: failed responses restore rows', async (t) => {
  const cases = {
    redirected: () => bad({ redirected: true }),
    401: () => bad({ status: 401 }),
    403: () => bad({ status: 403 }),
    429: () => bad({ status: 429 }),
    500: () => bad({ status: 500 }),
    network: () => new TypeError('Failed to fetch'),
    'non-JSON': () => bad({ json: false }),
  };
  for (const [name, respond] of Object.entries(cases)) {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { w, errors, toasts, calls } = load({ respond });
      click(w, row(w, 'del-7'));
      click(w, row(w, 'del-8'));
      mock.timers.tick(10000);
      await settle();
      assert.equal(calls.length, 1, name);
      for (const [key, id, label, toast] of [['feed:7', 'feed-row-7', 'Seven', toasts[0]], ['feed:8', 'feed-row-8', 'Eight', toasts[1]]]) {
        assert.equal(w.RFPending.state(key), 'failed', name + ' ' + key);
        assert.equal(row(w, id).hidden, false, name + ' restores ' + id);
        assert.equal(row(w, id).hasAttribute('data-rf-pending-delete'), false, name);
        const last = toast.updates.at(-1);
        assert.equal(last.msg, "Couldn't delete " + label, name);
        assert.equal(last.type, 'error', name);
      }
      assert.deepEqual(stored(w), {}, name + ' leaves sessionStorage');
      assert.deepEqual(errors, [], name);
    } finally {
      mock.timers.reset();
    }
  }
});

test('pending: a failed item restores only its row', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, toasts } = load({ respond: echo(['feed:8']) });
  click(w, row(w, 'del-7'));
  click(w, row(w, 'del-8'));
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(w.RFPending.state('feed:7'), 'done');
  assert.equal(w.RFPending.state('feed:8'), 'failed');
  assert.equal(row(w, 'feed-row-7').hidden, true);
  assert.equal(row(w, 'feed-row-8').hidden, false);
  assert.deepEqual(Object.keys(stored(w)), ['feed:7']);
  assert.equal(toasts[0].updates.at(-1).msg, 'Deleted Seven');
  assert.equal(toasts[1].updates.at(-1).msg, "Couldn't delete Eight");
  assert.deepEqual(errors, []);
});

test('pending: notices from HX-Trigger are shown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const notices = [{ msg: 'Turned off 1 filter', type: 'warning' }, { msg: 'Other', type: 'info' }];
  const { w, errors, toasts } = load({
    respond: () => ok([{ kind: 'label', id: 3, status: 'done' }], { trigger: JSON.stringify({ showToast: notices }) }),
  });
  w.RFPending.schedule({ kind: 'label', id: 3, label: 'Three' });
  assert.equal(row(w, 'label-row-3').hidden, true);
  t.mock.timers.tick(10000);
  await settle();
  const shown = toasts.filter((x) => 'trigger' in x);
  assert.equal(shown.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(shown[0].trigger)), notices); // across realms
  assert.deepEqual(errors, []);
});

test('pending: a request in flight delays a timer flush, not an unload flush', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { w, errors, calls } = load({ respond: () => 'hold' });
  w.RFPending.schedule({ kind: 'feed', id: 7, label: 'Seven' });
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1);

  w.RFPending.schedule({ kind: 'feed', id: 8, label: 'Eight' });
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1, 'the timer flush waits for the request in flight');
  assert.equal(w.RFPending.state('feed:8'), 'pending');

  w.RFPending.schedule({ kind: 'label', id: 3, label: 'Three' });
  w.dispatchEvent(new w.Event('beforeunload'));
  assert.equal(calls.length, 2, 'the unload flush sends at once');
  assert.deepEqual(calls[1].body, [{ kind: 'feed', id: 8 }, { kind: 'label', id: 3 }], 'never re-sends what is in flight');

  // A fresh timer flush queued behind the first request runs once it settles, failed or not.
  const third = { kind: 'feed', id: 9, label: 'Nine' };
  w.RFPending.schedule(third);
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 2);
  calls[0].settle.reject(new TypeError('Failed to fetch'));
  calls[1].settle.resolve(ok([{ kind: 'feed', id: 8, status: 'done' }, { kind: 'label', id: 3, status: 'done' }]));
  await settle();
  assert.equal(w.RFPending.state('feed:7'), 'failed');
  assert.equal(calls.length, 3, 'the queued flush ran after the request settled');
  assert.deepEqual(calls[2].body, [{ kind: 'feed', id: 9 }]);
  assert.deepEqual(errors, []);
});
