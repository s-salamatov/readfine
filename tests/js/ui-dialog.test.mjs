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

// --- Basecoat sidebar after a resize, Escape and aria-expanded (s2-T32) ---
//
// The vendored Basecoat sidebar decides its open state once at init (innerWidth
// against data-breakpoint, default 768) and has no key handler. dialog.js follows
// the breakpoint with matchMedia and drives the sidebar through Basecoat's own API
// (el.open() / el.close()), closes the mobile overlay on Escape and keeps every
// [data-rf-open="<id>"] opener's aria-expanded in sync. These tests load the real
// vendored basecoat.min.js and sidebar.min.js.
const BASECOAT_DIR = path.join(ROOT, 'backend', 'app', 'static', 'js', 'vendor', 'basecoat');

function fakeMatchMedia(w, width) {
  const queries = [];
  w.matchMedia = (query) => {
    const m = /min-width:\s*(\d+)px/.exec(query);
    const min = m ? Number(m[1]) : 0;
    const listeners = [];
    const mql = {
      media: query,
      get matches() { return w.innerWidth >= min; },
      addEventListener(type, fn) { if (type === 'change') listeners.push(fn); },
      removeEventListener() {},
      addListener(fn) { listeners.push(fn); },
      removeListener() {},
      listeners,
    };
    queries.push(mql);
    return mql;
  };
  Object.defineProperty(w, 'innerWidth', { configurable: true, writable: true, value: width });
  return {
    queries,
    // Fires change only on the queries whose result flips, as a browser does.
    resize(next) {
      const before = queries.map((q) => q.matches);
      w.innerWidth = next;
      queries.forEach((q, i) => {
        if (q.matches !== before[i]) for (const fn of q.listeners) fn({ matches: q.matches, media: q.media });
      });
    },
  };
}

function runScript(w, file) {
  const script = w.document.createElement('script');
  script.textContent = fs.readFileSync(file, 'utf8');
  w.document.head.appendChild(script);
}

// The admin page shape: a menu button with data-rf-open / aria-controls and no
// aria-expanded in the markup, the sidebar as the nav macro renders it.
const SIDEBAR_PAGE = (extra = '') => '<main><button id="menu" type="button" data-rf-open="admin-nav" aria-controls="admin-nav">Menu</button>'
  + '<button id="other" type="button">Other</button></main>'
  + '<aside id="admin-nav" class="sidebar" data-side="left" aria-hidden="false"' + extra + '>'
  + '<nav aria-label="Admin navigation"><section><div role="group"><ul>'
  + '<li><a id="nav-link" href="#feeds">Feeds</a></li></ul></div></section></nav></aside>';

function loadSidebar(width, body = SIDEBAR_PAGE()) {
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
  const media = fakeMatchMedia(w, width);
  // base.html order: basecoat.min.js, the component files, ..., dialog.js.
  runScript(w, path.join(BASECOAT_DIR, 'basecoat.min.js'));
  runScript(w, path.join(BASECOAT_DIR, 'sidebar.min.js'));
  w.basecoat.initAll();
  const script = w.document.createElement('script');
  script.textContent = source;
  w.document.head.appendChild(script);
  return { w, d: w.document, media, logged, errors };
}

const tick = (w) => new Promise((resolve) => w.setTimeout(resolve, 0));
const isOpen = (el) => el.getAttribute('aria-hidden') === 'false';
const escape = (w) => {
  const ev = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  (w.document.activeElement || w.document.body).dispatchEvent(ev);
  return ev;
};

test('sidebar: crossing the breakpoint opens and closes it through Basecoat', async () => {
  // Loaded at 390: Basecoat starts it closed.
  const { w, d, media, logged, errors } = loadSidebar(390);
  const nav = d.getElementById('admin-nav');
  assert.equal(nav.dataset.sidebarInitialized, 'true', 'the real Basecoat sidebar ran');
  assert.equal(isOpen(nav), false);

  media.resize(1280);
  await tick(w);
  assert.equal(isOpen(nav), true, '390 -> 1280 opens the desktop sidebar');
  assert.equal(nav.hasAttribute('inert'), false);

  media.resize(390);
  await tick(w);
  assert.equal(isOpen(nav), false, '1280 -> 390 closes the overlay');
  assert.equal(nav.hasAttribute('inert'), true);

  // A resize that stays on one side does not override the user's choice.
  nav.open();
  media.resize(500);
  await tick(w);
  assert.equal(isOpen(nav), true, 'no crossing, no change');

  // data-initial-open="false" (the macro's open=false) is not forced open on desktop.
  const closed = loadSidebar(390, SIDEBAR_PAGE(' data-initial-open="false" inert'));
  const nav2 = closed.d.getElementById('admin-nav');
  closed.media.resize(1280);
  await tick(closed.w);
  assert.equal(isOpen(nav2), false, 'a sidebar meant to start closed stays closed');

  assert.deepEqual(logged, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(closed.errors, []);
});

test('sidebar: Escape closes the mobile overlay and returns focus to the opener', async () => {
  const { w, d, errors } = loadSidebar(390);
  const nav = d.getElementById('admin-nav');
  const menu = d.getElementById('menu');

  menu.focus();
  click(w, menu);
  assert.equal(isOpen(nav), true, 'data-rf-open toggles it open');
  d.getElementById('nav-link').focus();
  escape(w);
  assert.equal(isOpen(nav), false, 'Escape closes the mobile sidebar');
  assert.equal(d.activeElement, menu, 'focus returns to the opener');

  // An open modal dialog owns Escape: the sidebar is left alone.
  const dlg = d.createElement('dialog');
  dlg.id = 'dlg';
  d.body.appendChild(dlg);
  click(w, menu);
  dlg.showModal();
  escape(w);
  assert.equal(isOpen(nav), true, 'Escape with a dialog open does not close the sidebar');
  dlg.close();

  // On desktop the sidebar is not an overlay: Escape does nothing.
  const wide = loadSidebar(1280);
  const nav2 = wide.d.getElementById('admin-nav');
  assert.equal(isOpen(nav2), true);
  wide.d.getElementById('nav-link').focus();
  const ev = escape(wide.w);
  assert.equal(isOpen(nav2), true, 'Escape on desktop leaves it open');
  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(wide.errors, []);
});

test('sidebar: the opener aria-expanded follows the open state', async () => {
  const { w, d, media, errors } = loadSidebar(390);
  const nav = d.getElementById('admin-nav');
  const menu = d.getElementById('menu');
  await tick(w);
  assert.equal(menu.getAttribute('aria-expanded'), 'false', 'set at init');

  click(w, menu);
  assert.equal(menu.getAttribute('aria-expanded'), 'true', 'after data-rf-open');

  // Basecoat closes the mobile sidebar itself on a link click: aria-expanded follows.
  click(w, d.getElementById('nav-link'));
  await tick(w);
  assert.equal(isOpen(nav), false);
  assert.equal(menu.getAttribute('aria-expanded'), 'false', 'after a Basecoat-internal close');

  media.resize(1280);
  await tick(w);
  assert.equal(menu.getAttribute('aria-expanded'), 'true', 'after crossing to desktop');

  // A plain dialog opener does not get aria-expanded from this.
  const plain = load('<button id="o" type="button" data-rf-open="dlg">Open</button><dialog id="dlg"></dialog>');
  await tick(plain.w);
  assert.equal(plain.w.document.getElementById('o').hasAttribute('aria-expanded'), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(plain.errors, []);
});

test('sidebar: the mobile overlay moves focus in and makes the page inert', async () => {
  // s3 C6c, the admin-nav shape: below the breakpoint the open sidebar is a modal
  // overlay, so focus moves into it and the rest of the page is inert until it closes
  // by any route. Dialogs, live regions and elements already inert are left alone.
  const page = SIDEBAR_PAGE() + '<div id="toaster" class="toaster" aria-live="polite"></div>'
    + '<dialog id="dlg"></dialog><footer id="foot" inert>Foot</footer>';
  const { w, d, media, errors } = loadSidebar(390, page);
  const nav = d.getElementById('admin-nav');
  const menu = d.getElementById('menu');
  const main = d.querySelector('main');
  const inert = (id) => d.getElementById(id).hasAttribute('inert');

  menu.focus();
  click(w, menu);
  assert.equal(isOpen(nav), true);
  assert.equal(d.activeElement, d.getElementById('nav-link'), 'focus moves into the overlay');
  assert.equal(main.hasAttribute('inert'), true, 'the page behind it is inert');
  assert.equal(nav.hasAttribute('inert'), false);
  assert.equal(inert('toaster') || inert('dlg'), false, 'live regions and dialogs stay usable');

  escape(w);
  assert.equal(main.hasAttribute('inert'), false, 'Escape releases the page');
  assert.equal(d.activeElement, menu);
  assert.equal(inert('foot'), true, 'an element inert before stays inert');

  // Basecoat's own backdrop close (a click on the aside outside its nav).
  click(w, menu);
  click(w, nav);
  await tick(w);
  assert.equal(isOpen(nav), false);
  assert.equal(main.hasAttribute('inert'), false, 'a backdrop close releases the page');
  assert.equal(d.activeElement, menu, 'and focus returns to the opener');

  // Crossing to desktop while open: the sidebar is no longer an overlay.
  click(w, menu);
  media.resize(1280);
  await tick(w);
  assert.equal(isOpen(nav), true);
  assert.equal(main.hasAttribute('inert'), false, 'nothing is inert on desktop');

  // On desktop a toggle never inerts the page.
  click(w, menu);
  click(w, menu);
  assert.equal(isOpen(nav), true);
  assert.equal(main.hasAttribute('inert'), false);
  assert.deepEqual(errors, []);
});
