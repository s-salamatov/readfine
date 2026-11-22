// Toasts (s3-T5): every notice goes through window.RFToast (static/js/ui/toast.js),
// which builds Basecoat .toast nodes itself and hands them to Basecoat's toaster to
// run (timers, pause on hover, close on a footer click). It never calls the toaster's
// own toast() method: that writes the action / cancel buttons with an inline onclick,
// which the nonce CSP blocks (s3 Review Focus 7).
//
// The first group loads the real vendored basecoat.min.js and toast.min.js, then
// toast.js, into jsdom. The second runs app.js in the harness with a stub RFToast and
// checks what app.js hands it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { browser } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = path.join(ROOT, 'backend', 'app', 'static', 'js');
const SCRIPTS = [
  path.join(JS, 'vendor', 'basecoat', 'basecoat.min.js'),
  path.join(JS, 'vendor', 'basecoat', 'toast.min.js'),
  path.join(JS, 'ui', 'toast.js'),
];

// Read inside each test, so a missing toast.js fails every test, not the file.
function load(body = '') {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/',
  });
  const w = dom.window;
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  for (const file of SCRIPTS) {
    const script = w.document.createElement('script');
    script.textContent = fs.readFileSync(file, 'utf8');
    w.document.head.appendChild(script);
  }
  return { w, errors };
}

function click(w, el) {
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}

test('toast: text is set as text and role follows the type', () => {
  const { w, errors } = load();
  try {
    const evil = '<img src=x onerror=1>';
    const info = w.RFToast.show({ msg: evil });
    const toaster = w.document.getElementById('toaster');
    assert.ok(toaster, 'the toaster is created when the page has none');
    assert.equal(toaster.className, 'toaster');
    assert.equal(toaster.getAttribute('data-align'), 'end');
    assert.equal(info.el.parentNode, toaster);
    assert.equal(info.el.querySelector('.toast-content > section > h2').textContent, evil);
    assert.equal(toaster.querySelector('img'), null, 'the message never becomes markup');
    assert.equal(info.el.getAttribute('role'), 'status');
    assert.equal(info.el.getAttribute('aria-atomic'), 'true');
    assert.equal(info.el.getAttribute('data-category'), 'info');
    assert.ok(info.el.querySelector('.toast-content > svg'), 'an icon');
    // Basecoat's toast registration took the node over (its timer and close()).
    assert.equal(info.el.getAttribute('data-toast-initialized'), 'true');

    const err = w.RFToast.show({ msg: 'Broken', type: 'error' });
    assert.equal(err.el.getAttribute('role'), 'alert');
    assert.equal(err.el.getAttribute('data-category'), 'error');
    const ok = w.RFToast.show({ msg: 'Done', type: 'ok', duration: 1234 });
    assert.equal(ok.el.getAttribute('role'), 'status');
    assert.equal(ok.el.getAttribute('data-category'), 'success');
    assert.equal(ok.el.getAttribute('data-duration'), '1234');
    const warn = w.RFToast.show({ msg: 'Careful', type: 'warning' });
    assert.equal(warn.el.getAttribute('data-category'), 'warning');
    assert.equal(toaster.querySelectorAll('.toast').length, 4);
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});

test('toast: action runs its listener and no onclick attribute exists', () => {
  const { w, errors } = load();
  try {
    let runs = 0;
    const h = w.RFToast.show({ msg: 'Feed deleted', action: { label: 'Undo', onClick() { runs += 1; } }, duration: -1 });
    const btn = h.el.querySelector('.toast-content footer > button.btn[data-toast-action]');
    assert.ok(btn, 'an action button in the footer');
    assert.equal(btn.getAttribute('type'), 'button');
    assert.equal(btn.textContent, 'Undo');
    assert.equal(h.el.getAttribute('data-duration'), '-1');
    assert.equal(w.document.querySelectorAll('#toaster [onclick]').length, 0);
    click(w, btn);
    assert.equal(runs, 1);
    assert.equal(h.el.getAttribute('aria-hidden'), 'true', 'a footer click closes the toast');
    assert.equal(w.document.querySelectorAll('#toaster [onclick]').length, 0);
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});

test('toast: update drops the action and close hides the toast', () => {
  const { w, errors } = load('<div id="toaster" class="toaster" data-align="end"></div>');
  try {
    const h = w.RFToast.show({ msg: 'Deleting…', action: { label: 'Undo', onClick() {} }, duration: -1 });
    assert.equal(w.document.querySelectorAll('#toaster').length, 1, 'the existing toaster is reused');
    h.update({ msg: 'Could not delete', type: 'error' });
    assert.equal(h.el.querySelector('h2').textContent, 'Could not delete');
    assert.equal(h.el.querySelector('footer'), null);
    assert.equal(h.el.getAttribute('data-category'), 'error');
    assert.equal(h.el.getAttribute('role'), 'alert');
    assert.equal(h.el.querySelectorAll('.toast-content > svg').length, 1, 'the icon is replaced, not added');
    h.update({ msg: 'Retry?', action: { label: 'Retry', onClick() {} } });
    assert.equal(h.el.querySelector('[data-toast-action]').textContent, 'Retry');
    assert.equal(h.el.getAttribute('data-category'), 'error', 'type is kept when not given');
    h.close();
    // jsdom fires no transitionend, so Basecoat never removes the node.
    assert.equal(h.el.getAttribute('aria-hidden'), 'true');
    assert.ok(h.el.isConnected);
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});

test("toast: fromTrigger shows an object, an array and htmx's {value: []}", () => {
  const { w, errors } = load();
  try {
    const count = () => w.document.querySelectorAll('#toaster .toast').length;
    w.RFToast.fromTrigger({ msg: 'One', type: 'ok' });
    assert.equal(count(), 1);
    w.RFToast.fromTrigger([{ msg: 'Two', type: 'info' }, { msg: 'Three', type: 'error' }]);
    assert.equal(count(), 3);
    w.RFToast.fromTrigger({ value: [{ msg: 'Four', type: 'warning' }, { msg: 'Five' }], elt: w.document.body });
    assert.equal(count(), 5);
    const titles = [...w.document.querySelectorAll('#toaster .toast h2')].map((h) => h.textContent);
    assert.deepEqual(titles, ['One', 'Two', 'Three', 'Four', 'Five']);
    w.RFToast.fromTrigger(null);
    w.RFToast.fromTrigger({ value: [] });
    w.RFToast.fromTrigger({ type: 'info' });
    assert.equal(count(), 5, 'nothing to say shows nothing');
    assert.deepEqual(errors, []);
  } finally {
    w.close();
  }
});

// ---- app.js against a stub RFToast --------------------------------------------------

function stubToast(w) {
  const calls = { show: [], fromTrigger: [] };
  w.RFToast = {
    show(opts) { calls.show.push(opts); return { el: null, update() {}, close() {} }; },
    fromTrigger(value) { calls.fromTrigger.push(value); },
  };
  w.__toastCalls = calls;
}

test('app: a showToast list trigger shows each notice', () => {
  const w = browser('', { before: stubToast });
  try {
    const calls = w.__toastCalls;
    const notices = [{ msg: 'Feed removed', type: 'ok' }, { msg: 'Label removed', type: 'ok' }];
    w.document.body.dispatchEvent(new w.CustomEvent('showToast', { detail: { value: notices }, bubbles: true }));
    assert.equal(calls.fromTrigger.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.fromTrigger[0].value)), notices);
    // The global function share-target.js and catchup.js call goes through RFToast too.
    w.showToast('Link copied', 'ok');
    assert.deepEqual(JSON.parse(JSON.stringify(calls.show)), [{ msg: 'Link copied', type: 'ok' }]);
    // Without RFToast (its script failed to load) showToast does nothing, and throws nothing.
    delete w.RFToast;
    w.showToast('Nobody hears this', 'info');
  } finally {
    w.close();
  }
});

test('app: responseError is claimed only for a real showToast key', async () => {
  const w = browser('', { before: stubToast });
  try {
    const fire = (header) => {
      const detail = {
        elt: w.document.body,
        xhr: { status: 500, getResponseHeader: (name) => (name === 'HX-Trigger' ? header : null) },
      };
      w.document.body.dispatchEvent(new w.CustomEvent('htmx:responseError', { detail, bubbles: true }));
      return detail;
    };
    assert.equal(fire('{"showToast": {"msg": "Bad name", "type": "error"}}')._rfHandled, true);
    assert.equal(fire('sidebarRefresh, showToast')._rfHandled, true);
    assert.equal(fire('showToast')._rfHandled, true);
    assert.notEqual(fire('{"x": "showToast"}')._rfHandled, true, 'a value is not a key');
    assert.notEqual(fire('showToastLater')._rfHandled, true, 'names match exactly');
    assert.notEqual(fire('{not json, showToast')._rfHandled, true, 'a broken JSON header claims nothing');
    assert.notEqual(fire(null)._rfHandled, true);
    await new Promise((r) => w.setTimeout(r, 5));
    // The unclaimed errors fall back to one generic toast (the rest are inside its gap).
    assert.equal(w.__toastCalls.show.length, 1);
    assert.equal(w.__toastCalls.show[0].type, 'error');
    assert.match(w.__toastCalls.show[0].msg, /HTTP 500/);
  } finally {
    w.close();
  }
});
