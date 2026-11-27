// Immediate save on Settings (s7-T1, design §5.2): window.RFSettings
// (static/js/ui/settings.js) posts one choice to POST /settings/field the moment a
// control marked data-rf-autosave changes. Success shows the server's toast; any
// failure (offline, 403, 429, 5xx, a redirect to /login, a network error) puts the
// control back to the last value the server confirmed and says the choice was not
// saved. The response to the newest change of a field wins (s7 Review Focus 1).
//
// Each test loads settings.js alone into its own jsdom with a stub RFToast that records
// calls and a fake fetch whose responses the test settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTINGS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'ui', 'settings.js');

const SAVED = JSON.stringify({ showToast: { msg: 'Saved', type: 'ok' },
  'rf:settingsaved': { field: 'x', value: 'y' } });

function response({ status = 200, redirected = false, trigger = SAVED } = {}) {
  return {
    ok: status >= 200 && status < 300, status, redirected,
    headers: { get: (n) => (n.toLowerCase() === 'hx-trigger' ? trigger : null) },
  };
}

// Read inside each test, so a missing settings.js fails every test, not the file.
function load(body, { online = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/settings/reading',
  });
  const w = dom.window;
  w.document.cookie = 'csrftoken=tok-123';
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => online });
  const toasts = [];
  const shown = (o) => { toasts.push(o); return {}; };
  w.RFToast = {
    show: shown,
    fromTrigger: (v) => { (Array.isArray(v) ? v : [v]).forEach((o) => shown(o)); return []; },
  };
  const calls = [];
  w.fetch = (url, opts) => new Promise((resolve, reject) => {
    calls.push({ url, opts, resolve, reject });
  });
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(SETTINGS, 'utf8');
  w.document.head.appendChild(s);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return { w, toasts, calls };
}

function change(w, el) {
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('autosave: a change posts field and value with the CSRF header and shows the server toast', async () => {
  const { w, toasts, calls } = load(
    '<input type="checkbox" name="mark_read_on_scroll" data-rf-autosave id="c">');
  assert.equal(typeof w.RFSettings.save, 'function');
  const box = w.document.getElementById('c');
  box.checked = true;
  change(w, box);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/settings/field');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(String(calls[0].opts.body), 'field=mark_read_on_scroll&value=true');
  const headers = calls[0].opts.headers;
  assert.equal(headers['x-csrftoken'], 'tok-123');
  assert.match(headers['Content-Type'], /application\/x-www-form-urlencoded/);
  calls[0].resolve(response());
  await tick();
  assert.deepEqual(toasts.map((t) => t.msg), ['Saved']);
  assert.equal(box.checked, true);
});

const SELECT =
  '<select name="list_density_web" data-rf-autosave data-rf-autosave-label="List density" id="s">' +
  '<option value="comfortable" selected>Comfortable</option>' +
  '<option value="compact">Compact</option></select>';

test('autosave: a failed save restores the last confirmed value and says so', async () => {
  const failures = [
    ['403', (c) => c.resolve(response({ status: 403, trigger: null }))],
    ['429', (c) => c.resolve(response({ status: 429, trigger: null }))],
    ['500', (c) => c.resolve(response({ status: 500, trigger: null }))],
    ['redirected', (c) => c.resolve(response({ redirected: true }))],
    ['network error', (c) => c.reject(new TypeError('Failed to fetch'))],
  ];
  for (const [name, settle] of failures) {
    const { w, toasts, calls } = load(SELECT);
    const sel = w.document.getElementById('s');
    sel.value = 'compact';
    change(w, sel);
    assert.equal(calls.length, 1, name);
    settle(calls[0]);
    await tick();
    assert.equal(sel.value, 'comfortable', name);
    assert.equal(toasts.length, 1, name);
    assert.equal(toasts[0].type, 'error', name);
    assert.match(toasts[0].msg, /List density/, name);
    assert.ok(!toasts.some((t) => t.msg === 'Saved'), name);
  }

  const { w, toasts, calls } = load(SELECT, { online: false });
  const sel = w.document.getElementById('s');
  sel.value = 'compact';
  change(w, sel);
  await tick();
  assert.equal(calls.length, 0, 'nothing is sent while offline');
  assert.equal(sel.value, 'comfortable');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'error');
  assert.match(toasts[0].msg, /offline/i);
  assert.match(toasts[0].msg, /List density/);
});

const THREE =
  '<select name="list_density_web" data-rf-autosave id="s">' +
  '<option value="comfortable" selected>Comfortable</option>' +
  '<option value="compact">Compact</option><option value="tiny">Tiny</option></select>';

// The newest change fails while an older one is still out, or just after it: either
// way the server holds the older choice, and so must the control and the next rollback.
test('autosave: an older success shows even when the newest change fails', async () => {
  const failures = {
    '500': (c) => c.resolve(response({ status: 500, trigger: null })),
    'network error': (c) => c.reject(new TypeError('Failed to fetch')),
    offline: null, // fails at once, nothing is sent
  };
  for (const [kind, settle] of Object.entries(failures)) {
    for (const olderFirst of [false, true]) {
      const name = kind + (olderFirst ? ', older answers first' : ', older answers last');
      const { w, toasts, calls } = load(THREE);
      let online = true;
      Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => online });
      const sel = w.document.getElementById('s');
      sel.value = 'compact';
      change(w, sel);
      online = !!settle;
      sel.value = 'tiny';
      change(w, sel);
      online = true;
      const failNewest = async () => { if (settle) settle(calls[1]); await tick(); };
      const olderSucceeds = async () => { calls[0].resolve(response()); await tick(); };
      if (olderFirst && settle) {
        await olderSucceeds();
        assert.equal(sel.value, 'tiny', name + ': the pending choice stays on screen');
        await failNewest();
      } else if (olderFirst) {
        // An offline change fails synchronously, so no answer can precede it.
        continue;
      } else {
        await failNewest();
        assert.equal(sel.value, 'comfortable', name);
        await olderSucceeds();
      }
      assert.equal(sel.value, 'compact', name);
      assert.deepEqual(toasts.map((t) => t.type), ['error'], name);

      // The next rollback goes to the older choice the server accepted.
      sel.value = 'tiny';
      change(w, sel);
      calls[calls.length - 1].resolve(response({ status: 500, trigger: null }));
      await tick();
      assert.equal(sel.value, 'compact', name + ': later rollback');
    }
  }
});

test('autosave: an older success never overrides a newer success', async () => {
  const { w, calls } = load(THREE);
  const sel = w.document.getElementById('s');
  sel.value = 'compact';
  change(w, sel);
  sel.value = 'tiny';
  change(w, sel);
  calls[1].resolve(response());
  await tick();
  calls[0].resolve(response());
  await tick();
  assert.equal(sel.value, 'tiny');
  sel.value = 'comfortable';
  change(w, sel);
  calls[2].resolve(response({ status: 500, trigger: null }));
  await tick();
  assert.equal(sel.value, 'tiny');
});

test('autosave: a late older success restores the radio group', async () => {
  const { w, calls } = load(['a', 'b', 'c'].map((v) =>
    '<input type="radio" name="list_density_web" value="' + v + '" id="' + v + '" data-rf-autosave' +
    (v === 'a' ? ' checked' : '') + '>').join(''));
  const radio = (id) => w.document.getElementById(id);
  for (const id of ['b', 'c']) {
    radio(id).checked = true;
    change(w, radio(id));
  }
  calls[1].resolve(response({ status: 500, trigger: null }));
  await tick();
  calls[0].resolve(response());
  await tick();
  assert.equal(radio('b').checked, true);
});

test('autosave: an older response never overrides a newer choice', async () => {
  const { w, toasts, calls } = load(
    '<select name="list_density_web" data-rf-autosave id="s">' +
    '<option value="comfortable" selected>Comfortable</option>' +
    '<option value="compact">Compact</option><option value="tiny">Tiny</option></select>');
  const sel = w.document.getElementById('s');
  sel.value = 'compact';
  change(w, sel);
  sel.value = 'tiny';
  change(w, sel);
  assert.equal(calls.length, 2);
  calls[1].resolve(response());
  await tick();
  calls[0].resolve(response({ status: 500, trigger: null }));
  await tick();
  assert.equal(sel.value, 'tiny');
  assert.ok(!toasts.some((t) => t.type === 'error'));
});
