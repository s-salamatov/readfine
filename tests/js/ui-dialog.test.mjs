// static/js/ui/dialog.js opens Basecoat dialogs and sheets without inline handlers:
// a delegated click on [data-rf-open="<id>"] calls showModal() on that <dialog>,
// [data-rf-close] inside a dialog closes it, and on close focus returns to the
// element that opened it. The CSP has no 'unsafe-inline' for scripts, so Basecoat's
// documented inline showModal() call on the trigger would never run.
//
// Each test loads the real dialog.js into jsdom. jsdom has no modal dialogs, so
// showModal() / close() are polyfilled with the attribute and the close event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIALOG_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'ui', 'dialog.js');

function polyfillDialog(w) {
  const proto = w.HTMLDialogElement.prototype;
  proto.showModal = function () {
    if (this.hasAttribute('open')) throw new w.DOMException('already open', 'InvalidStateError');
    this.setAttribute('open', '');
    this.showModalCalls = (this.showModalCalls || 0) + 1;
  };
  proto.close = function () {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  if (!('open' in proto)) {
    Object.defineProperty(proto, 'open', { get() { return this.hasAttribute('open'); } });
  }
}

// Read inside each test, so a missing dialog.js fails every test, not the file.
function load(body) {
  const source = fs.readFileSync(DIALOG_JS, 'utf8');
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/',
    beforeParse: polyfillDialog,
  });
  const w = dom.window;
  const logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    w.console[level] = (...args) => logged.push([level, ...args]);
  }
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  const script = w.document.createElement('script');
  script.textContent = source;
  w.document.head.appendChild(script);
  return { w, source, logged, errors };
}

function click(w, el) {
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

test('dialog: data-rf-open opens and returns focus', () => {
  const { w, source, errors } = load(
    '<button id="opener" type="button" data-rf-open="dlg"><span id="opener-icon">+</span> Open</button>'
    + '<button id="other" type="button">Other</button>'
    + '<dialog id="dlg" class="dialog"><div><h2>Title</h2>'
    + '<button id="closer" type="button" data-rf-close><span id="closer-icon">x</span></button></div></dialog>'
    + '<a id="sheet-link" href="/fallback" data-rf-open="sheet">Sheet</a>'
    + '<dialog id="sheet" class="drawer" data-side="right"><div><button id="sheet-close" data-rf-close>Close</button></div></dialog>',
  );
  // CSP: no eval, no Function constructor, no inline handler strings.
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b|\bon[a-z]+\s*=\s*["']/);
  const d = w.document;
  const dlg = d.getElementById('dlg');
  const opener = d.getElementById('opener');

  opener.focus();
  // A click on a child of the opener still opens (closest()).
  click(w, d.getElementById('opener-icon'));
  assert.equal(dlg.hasAttribute('open'), true, 'the dialog is open');
  assert.equal(dlg.showModalCalls, 1, 'opened as a modal');

  // A second click while open does not call showModal() again (it would throw).
  click(w, opener);
  assert.equal(dlg.showModalCalls, 1);

  d.getElementById('other').focus();
  click(w, d.getElementById('closer-icon'));
  assert.equal(dlg.hasAttribute('open'), false, 'data-rf-close closes it');
  assert.equal(d.activeElement, opener, 'focus returns to the opener');

  // Opening again works, and Escape (a native close) also returns focus.
  click(w, opener);
  assert.equal(dlg.showModalCalls, 2);
  d.getElementById('other').focus();
  dlg.close();
  assert.equal(d.activeElement, opener);

  // A sheet (Basecoat drawer) opens through the same attribute, from a link whose
  // navigation is cancelled.
  const link = d.getElementById('sheet-link');
  link.focus();
  const ev = click(w, link);
  assert.equal(ev.defaultPrevented, true, 'the link does not navigate');
  assert.equal(d.getElementById('sheet').hasAttribute('open'), true);
  click(w, d.getElementById('sheet-close'));
  assert.equal(d.getElementById('sheet').hasAttribute('open'), false);
  assert.equal(d.activeElement, link);

  // Exactly one close listener per opening: a later close does not refocus again.
  d.getElementById('other').focus();
  dlg.dispatchEvent(new w.Event('close'));
  assert.equal(d.activeElement, d.getElementById('other'));
  assert.deepEqual(errors, []);
});

test('dialog: unknown id does nothing and logs nothing', () => {
  const { w, logged, errors } = load(
    '<a id="missing" href="#nowhere" data-rf-open="nope">Missing</a>'
    + '<button id="empty" type="button" data-rf-open="">Empty</button>'
    + '<button id="stray-close" type="button" data-rf-close>Close outside a dialog</button>'
    + '<div id="not-dialog"></div><button id="div-opener" type="button" data-rf-open="not-dialog">Div</button>'
    + '<dialog id="dlg"><div>Body</div></dialog>',
  );
  const d = w.document;
  for (const id of ['missing', 'empty', 'stray-close', 'div-opener']) {
    const ev = click(w, d.getElementById(id));
    assert.equal(ev.defaultPrevented, false, id + ': the default action is left alone');
  }
  assert.equal(d.getElementById('dlg').hasAttribute('open'), false);
  assert.deepEqual(logged, [], 'nothing is logged');
  assert.deepEqual(errors, [], 'nothing throws');
});
