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
function load({ body = ROWS, store = null, respond = echo(), realToast = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/settings/feeds',
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  w.setTimeout = (fn, ms) => setTimeout(fn, ms);
  w.clearTimeout = (t) => clearTimeout(t);
  w.Date.now = () => Date.now(); // follows node:test's mocked Date when a test enables it
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
  if (realToast) {
    for (const relative of ['vendor/basecoat/basecoat.min.js', 'vendor/basecoat/toast.min.js', 'ui/toast.js']) {
      const script = w.document.createElement('script');
      script.textContent = fs.readFileSync(path.join(ROOT, 'backend/app/static/js', relative), 'utf8');
      w.document.head.appendChild(script);
    }
  }

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
    // Date too: two clicks in the same millisecond are due together (one request).
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
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

test('pending: a timer flush sends only the deletes that are due', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { w, errors, calls } = load();
  w.RFPending.schedule({ kind: 'feed', id: 7, label: 'Seven' });
  t.mock.timers.tick(6000);
  w.RFPending.schedule({ kind: 'feed', id: 8, label: 'Eight' });
  t.mock.timers.tick(4000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, [{ kind: 'feed', id: 7 }], 'the younger delete keeps its window');
  assert.equal(w.RFPending.state('feed:8'), 'pending');
  await settle();
  t.mock.timers.tick(5999);
  assert.equal(calls.length, 1, 'still inside the second delete\'s 10 s');
  assert.equal(w.RFPending.state('feed:8'), 'pending');
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, [{ kind: 'feed', id: 8 }]);
  await settle();
  assert.equal(w.RFPending.state('feed:8'), 'done');
  assert.deepEqual(errors, []);
});

test('pending: undo keeps working for a delete younger than the one sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { w, errors, calls } = load();
  w.RFPending.schedule({ kind: 'feed', id: 7, label: 'Seven' });
  t.mock.timers.tick(6000);
  w.RFPending.schedule({ kind: 'feed', id: 8, label: 'Eight' });
  t.mock.timers.tick(4000);
  await settle();
  assert.equal(w.RFPending.undo('feed:8'), true, 'Undo still works 4 s into its 10 s');
  assert.equal(row(w, 'feed-row-8').hidden, false);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(calls.length, 1, 'the undone delete is never sent');
  assert.deepEqual(errors, []);
});

test('pending: schedule rejects unknown kinds, so the batch stays valid', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = ROWS + '<button id="del-x" type="button" data-rf-delete="article:5" data-rf-delete-label="X">x</button>';
  const { w, errors, toasts, calls } = load({ body });
  assert.equal(w.RFPending.schedule({ kind: 'article', id: 5, label: 'X' }), undefined);
  assert.equal(w.RFPending.schedule({ kind: '', id: 5, label: 'X' }), undefined);
  assert.equal(w.RFPending.schedule({ id: 5, label: 'X' }), undefined);
  click(w, row(w, 'del-x'));
  assert.equal(w.RFPending.state('article:5'), undefined);
  assert.equal(toasts.length, 0, 'no Undo toast for a rejected kind');
  w.RFPending.schedule({ kind: 'filter', id: 2, label: 'F' });
  t.mock.timers.tick(10000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, [{ kind: 'filter', id: 2 }]);
  assert.deepEqual(errors, []);
});

test('pending: a delete 50 ms younger is not sent early with the one that is due', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { w, errors, calls } = load();
  w.RFPending.schedule({ kind: 'feed', id: 7, label: 'Seven' });
  t.mock.timers.tick(50);
  w.RFPending.schedule({ kind: 'feed', id: 8, label: 'Eight' });
  t.mock.timers.tick(9950);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, [{ kind: 'feed', id: 7 }], 'no coalescing window: feed:8 keeps its full 10 s');
  assert.equal(w.RFPending.state('feed:8'), 'pending');
  await settle();
  t.mock.timers.tick(49);
  assert.equal(calls.length, 1);
  assert.equal(w.RFPending.state('feed:8'), 'pending', 'still inside its own 10 s');
  t.mock.timers.tick(1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, [{ kind: 'feed', id: 8 }]);
  await settle();
  assert.equal(w.RFPending.state('feed:8'), 'done');
  assert.deepEqual(errors, []);
});

// Sources' table/menu shape; ids here are subscription ids, not shared Feed ids.
function sourceRow(id, title = 'Source ' + id) {
  const escaped = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  return `<tr id="source-row-${id}" data-rf-delete-key="feed:${id}">
    <td>${escaped}</td><td><div data-rf-source-menu><div role="menu">
      <button type="button" role="menuitem" data-variant="destructive" data-rf-online-only
        data-rf-delete="feed:${id}" data-rf-delete-label="${escaped}">Remove</button>
    </div></div></td></tr>`;
}

test('pending sources: menu action undo and swapped row use the same key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { w, errors, toasts, calls } = load({
    body: '<table><tbody>' + sourceRow(107) + '</tbody></table>', respond: () => 'hold',
  });
  try {
    const action = () => w.document.querySelector('[data-rf-delete="feed:107"]');
    click(w, action());
    assert.equal(row(w, 'source-row-107').hidden, true);
    t.mock.timers.tick(9999);
    assert.equal(calls.length, 0);
    toasts[0].opts.action.onClick(toasts[0].handle);
    assert.equal(row(w, 'source-row-107').hidden, false);
    t.mock.timers.tick(10000);
    assert.equal(calls.length, 0, 'Undo cancelled the send');

    click(w, action());
    t.mock.timers.tick(10000);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, [{ kind: 'feed', id: 107 }]);
    w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeRequest', { bubbles: true, detail: { boosted: true } }));
    w.document.querySelector('tbody').innerHTML = sourceRow(107);
    w.document.body.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { bubbles: true }));
    assert.equal(w.RFPending.state('feed:107'), 'sending');
    assert.equal(row(w, 'source-row-107').hidden, true, 'a swapped sending row stays hidden');
    assert.equal(calls.length, 1, 'navigation never resends an in-flight subscription');
    calls[0].settle.resolve(ok([{ kind: 'feed', id: 107, status: 'done' }]));
    await settle();
    w.document.querySelector('tbody').innerHTML = sourceRow(107);
    w.document.body.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { bubbles: true }));
    w.dispatchEvent(new w.Event('pagehide'));
    assert.equal(row(w, 'source-row-107').hidden, true, 'a swapped done row stays hidden');
    assert.equal(calls.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});

test('pending sources: 51 entries fail safely as one request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const ids = Array.from({ length: 51 }, (_, i) => i + 101);
  const { w, errors, toasts, calls } = load({
    body: '<table><tbody>' + ids.map((id) => sourceRow(id)).join('') + '</tbody></table>',
    respond: () => 'hold',
  });
  try {
    for (const id of ids) w.RFPending.schedule({ kind: 'feed', id, label: 'Source ' + id });
    w.RFPending.flush('unload');
    assert.equal(calls.length, 1, 'no splitting of the exit request');
    assert.equal(calls[0].url, '/settings/deletes');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.keepalive, true);
    assert.equal(calls[0].opts.headers['x-csrftoken'], 'tok123');
    assert.deepEqual(calls[0].body, ids.map((id) => ({ kind: 'feed', id })));
    assert.equal(Object.keys(stored(w)).length, 51);
    for (const [index, id] of ids.entries()) {
      assert.equal(row(w, 'source-row-' + id).hidden, true);
      assert.equal(w.RFPending.undo('feed:' + id), false);
      assert.ok(!toasts[index].updates.at(-1).action, 'Undo disappears once sent');
    }
    calls[0].settle.resolve(bad({ status: 422 }));
    await settle();
    for (const [index, id] of ids.entries()) {
      assert.equal(w.RFPending.state('feed:' + id), 'failed');
      assert.equal(row(w, 'source-row-' + id).hidden, false);
      assert.equal(row(w, 'source-row-' + id).hasAttribute('data-rf-pending-delete'), false);
      assert.equal(w.RFPending.undo('feed:' + id), false);
      assert.ok(!toasts[index].updates.at(-1).action);
      assert.equal(toasts[index].updates.at(-1).type, 'error');
    }
    assert.deepEqual(stored(w), {});
    t.mock.timers.tick(20000);
    w.dispatchEvent(new w.Event('pagehide'));
    assert.equal(calls.length, 1, 'a failed batch is not silently retried');
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});

test('pending sources: failed send restores only affected subscriptions and notices stay text', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const hostile = '\"><img src=x onerror="window.executed=true"> & source';
  const notice = 'Deactivated filter <img src=x onerror="window.executed=true">';
  const { w, errors, calls } = load({
    body: '<table><tbody>' + sourceRow(107, hostile) + sourceRow(108, hostile) + '</tbody></table>',
    realToast: true,
    respond: () => ok([
      { kind: 'feed', id: 107, status: 'done' },
      { kind: 'feed', id: 108, status: 'failed' },
    ], { trigger: JSON.stringify({ showToast: [{ msg: notice, type: 'warning' }] }) }),
  });
  try {
    await settle(); // let Basecoat register before interacting with the real toasts
    for (const action of w.document.querySelectorAll('[data-rf-delete]')) {
      assert.equal(action.getAttribute('data-rf-delete-label'), hostile);
      click(w, action);
    }
    const messages = () => Array.from(w.document.querySelectorAll('#toaster h2'), (el) => el.textContent);
    assert.deepEqual(messages(), ['Deleted ' + hostile, 'Deleted ' + hostile]);
    assert.equal(w.document.querySelectorAll('#toaster [data-toast-action]').length, 2, 'both have Undo before sending');
    t.mock.timers.tick(10000);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(row(w, 'source-row-107').hidden, true);
    assert.equal(row(w, 'source-row-108').hidden, false);
    assert.equal(w.RFPending.state('feed:107'), 'done');
    assert.equal(w.RFPending.state('feed:108'), 'failed');
    assert.deepEqual(Object.keys(stored(w)), ['feed:107']);
    assert.deepEqual(messages(), ['Deleted ' + hostile, "Couldn't delete " + hostile, notice]);
    assert.equal(w.document.querySelectorAll('#toaster [data-toast-action]').length, 0, 'no Undo after sending');
    assert.equal(w.document.querySelector('img, [onerror]'), null, 'title and notice never become executable elements');
    assert.equal(w.executed, undefined);
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});
