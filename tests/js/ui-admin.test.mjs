// Admin behaviour (s8-T2): window.RFAdmin (static/js/ui/admin.js), the one script of the
// admin pages: the feeds A–Z / By-host choice kept per device, the two feed dialogs, the
// switches on Admin → Settings that show and hide their notes, and the traffic chart.
// Admin pages are reached by boosted navigation too, so the module binds once on document
// and init(root) applies the state of whatever htmx has just settled.
//
// Each test loads admin.js alone into its own jsdom with the pinned hooks and a stub htmx
// that records requests. jsdom has no modal dialogs, so close() is polyfilled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN = path.join(ROOT, 'backend', 'app', 'static', 'js', 'ui', 'admin.js');

function polyfillDialog(w) {
  const proto = w.HTMLDialogElement.prototype;
  proto.close = function () {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  if (!('open' in proto)) {
    Object.defineProperty(proto, 'open', { get() { return this.hasAttribute('open'); } });
  }
}

// Read inside each test, so a missing admin.js fails every test, not the file.
function evaluate(w) {
  const s = w.document.createElement('script');
  s.textContent = fs.readFileSync(ADMIN, 'utf8');
  w.document.head.appendChild(s);
}

async function load(body, { stored = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>' + body + '</body></html>', {
    runScripts: 'dangerously',
    url: 'https://readfine.test/admin/feeds',
    beforeParse: polyfillDialog,
  });
  const w = dom.window;
  if (w.document.readyState === 'loading') {
    await new Promise((r) => w.document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  if (stored !== null) w.localStorage.setItem('admin_feeds_group', stored);
  const requests = [];
  w.htmx = { ajax: (...args) => { requests.push(JSON.stringify(args)); } };
  const errors = [];
  w.addEventListener('error', (e) => errors.push(e.error || e.message));
  evaluate(w);
  const $ = (sel) => w.document.querySelector(sel);
  return { w, $, requests, errors };
}

function click(w, el) {
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function settle(w, elt) {
  elt.dispatchEvent(new w.CustomEvent('htmx:afterSettle', { bubbles: true, detail: { elt } }));
}

const FEEDS =
  '<div id="toolbar">' +
  '<button type="button" data-feeds-group="az" aria-pressed="true">A–Z</button>' +
  '<button type="button" data-feeds-group="host" aria-pressed="false">By host</button>' +
  '</div><div id="feeds-table" data-group-mode="az"></div>';

const HOST_REQUEST = JSON.stringify(
  ['GET', '/admin/feeds/table?group=host', { target: '#feeds-table', swap: 'outerHTML' }]);

const pressed = ($) => ['az', 'host']
  .map((m) => $(`[data-feeds-group="${m}"]`).getAttribute('aria-pressed'));

test('admin: the feeds grouping persists per device and reloads the table', async () => {
  const first = await load(FEEDS);
  assert.equal(typeof first.w.RFAdmin.init, 'function');
  assert.deepEqual(first.requests, [], 'nothing stored, nothing reloaded');
  click(first.w, first.$('[data-feeds-group="host"]'));
  assert.equal(first.w.localStorage.getItem('admin_feeds_group'), 'host');
  assert.deepEqual(pressed(first.$), ['false', 'true']);
  click(first.w, first.$('[data-feeds-group="az"]'));
  assert.equal(first.w.localStorage.getItem('admin_feeds_group'), 'az');
  assert.deepEqual(pressed(first.$), ['true', 'false']);
  assert.deepEqual(first.requests, [], 'a click leaves the request to the button\'s hx-get');

  const next = await load(FEEDS, { stored: 'host' });
  next.w.RFAdmin.init(next.w.document);
  assert.deepEqual(next.requests, [HOST_REQUEST], 'one request, also after a second init');
  assert.deepEqual(pressed(next.$), ['false', 'true']);
  // A redrawn table alone (a saved feed, a toggle click) is not a page arrival.
  next.$('#feeds-table').outerHTML = '<div id="feeds-table" data-group-mode="az"></div>';
  settle(next.w, next.$('#feeds-table'));
  assert.equal(next.requests.length, 1);
  // A boosted arrival on the page is: the toggle and the table are new.
  next.w.document.body.innerHTML = '<main>' + FEEDS + '</main>';
  settle(next.w, next.$('main'));
  assert.deepEqual(next.requests, [HOST_REQUEST, HOST_REQUEST]);
  assert.deepEqual(pressed(next.$), ['false', 'true']);
  assert.deepEqual(next.errors, []);
});

const SETTINGS = (checked) =>
  '<form>' +
  `<input type="checkbox" role="switch" name="registration_enabled"${checked}>` +
  `<input type="checkbox" role="switch" name="dormant_warning_enabled"${checked}>` +
  '<div id="legal-warning" class="mb-6"></div>' +
  '<section id="legal-section" class="flex flex-col"></section>' +
  '<p id="traffic-closed-note" class="text-xs hidden"></p>' +
  '<div id="dormant-url-note"></div></form>';

const DIALOGS =
  '<dialog id="feed-edit-overlay" open><div><form id="edit"></form></div></dialog>' +
  '<dialog id="rate-limits-overlay" open><div id="rate-limits-content">rows</div></dialog>';

test('admin: dialogs and switches behave as before', async () => {
  const { w, $, errors } = await load(DIALOGS + SETTINGS(' checked'));
  $('#edit').dispatchEvent(new w.CustomEvent('feedEditDone', { bubbles: true }));
  assert.equal($('#feed-edit-overlay').open, false);
  click(w, $('#rate-limits-content'));
  assert.equal($('#rate-limits-overlay').open, true, 'a click inside keeps the dialog');
  click(w, $('#rate-limits-overlay'));
  assert.equal($('#rate-limits-overlay').open, false, 'a backdrop click closes it');

  const cls = (id) => [...$('#' + id).classList].sort().join(' ');
  const toggle = (name, on) => {
    const box = $(`[name="${name}"]`);
    box.checked = on;
    box.dispatchEvent(new w.Event('change', { bubbles: true }));
  };
  toggle('registration_enabled', false);
  assert.equal(cls('legal-section'), 'flex-col hidden', 'hidden replaces the display class');
  assert.equal(cls('legal-warning'), 'hidden mb-6');
  assert.equal(cls('traffic-closed-note'), 'text-xs');
  toggle('registration_enabled', true);
  assert.equal(cls('legal-section'), 'flex flex-col', 'the display class comes back');
  assert.equal(cls('legal-warning'), 'mb-6');
  assert.equal(cls('traffic-closed-note'), 'hidden text-xs');
  toggle('dormant_warning_enabled', false);
  assert.equal(cls('dormant-url-note'), 'hidden');
  toggle('dormant_warning_enabled', true);
  assert.equal(cls('dormant-url-note'), '');

  // A boosted save swaps in new elements; their classes follow the switches again. The
  // legal warning is absent once the legal fields are filled in.
  $('form').outerHTML = SETTINGS('').replace('<div id="legal-warning" class="mb-6"></div>', '');
  settle(w, $('form'));
  assert.equal(cls('legal-section'), 'flex-col hidden');
  assert.equal(cls('traffic-closed-note'), 'text-xs');
  assert.equal(cls('dormant-url-note'), 'hidden');
  assert.deepEqual(errors, []);
});

const bar = (day, tab) =>
  `<button type="button" tabindex="${tab}" data-readout="${day} &lt;b&gt;"><span></span></button>`;
const CHART =
  '<a href="#how-to-read">Why?</a>' +
  '<div id="traffic-bars"><div></div>' + bar('mon', -1) + bar('tue', -1) + bar('wed', 0) + '</div>' +
  '<div id="traffic-readout">wed &lt;b&gt;</div>' +
  '<details id="how-to-read"><summary>How</summary></details>';

test('admin: chart keys move the readout', async () => {
  const { w, $, errors } = await load(CHART);
  const bars = [...w.document.querySelectorAll('#traffic-bars button')];
  const readout = $('#traffic-readout');
  const press = (key) => {
    const e = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    w.document.activeElement.dispatchEvent(e);
    return e;
  };
  const at = (index, day) => {
    assert.deepEqual(bars.map((b) => b.getAttribute('tabindex')),
      bars.map((_, i) => (i === index ? '0' : '-1')), `tab stop on ${day}`);
    assert.equal(w.document.activeElement, bars[index], `focus on ${day}`);
    assert.equal(readout.textContent, `${day} <b>`, 'text, not markup');
    assert.equal(readout.children.length, 0);
    assert.deepEqual(bars.map((b) => b.classList.contains('ring-ring')),
      bars.map((_, i) => i === index), `ring on ${day} only`);
  };
  bars[2].focus();
  assert.equal(press('ArrowLeft').defaultPrevented, true);
  at(1, 'tue');
  press('Home');
  at(0, 'mon');
  assert.equal(press('ArrowLeft').defaultPrevented, false, 'no bar before the first');
  at(0, 'mon');
  press('ArrowRight');
  at(1, 'tue');
  press('End');
  at(2, 'wed');

  // Hovering is a look: the line returns to the picked bar when the pointer leaves.
  const pointer = (type, el, relatedTarget = null) => el.dispatchEvent(
    new w.MouseEvent(type, { bubbles: true, relatedTarget }));
  pointer('pointerover', bars[0].firstChild);
  assert.equal(readout.textContent, 'mon <b>');
  pointer('pointerout', bars[0], bars[1]);
  assert.equal(readout.textContent, 'mon <b>', 'still over the chart');
  pointer('pointerout', bars[0], w.document.body);
  assert.equal(readout.textContent, 'wed <b>');

  assert.equal($('#how-to-read').open, false);
  click(w, $('a[href="#how-to-read"]'));
  assert.equal($('#how-to-read').open, true);
  assert.deepEqual(errors, []);
});

test('admin: loading the module twice binds once', async () => {
  const { w, $, requests, errors } = await load(FEEDS, { stored: 'host' });
  const api = w.RFAdmin;
  const bound = [];
  for (const target of [w, w.document, w.document.body]) {
    const add = target.addEventListener;
    target.addEventListener = function (type, ...rest) { bound.push(type); return add.call(this, type, ...rest); };
  }
  const writes = [];
  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) { writes.push([key, value].join('=')); return setItem.call(this, key, value); };
  evaluate(w);
  assert.equal(w.RFAdmin, api);
  assert.deepEqual(bound, [], 'the second load adds no listener');
  click(w, $('[data-feeds-group="az"]'));
  assert.deepEqual(writes, ['admin_feeds_group=az']);
  assert.deepEqual(requests, [HOST_REQUEST], 'one request for the page, not one per load');
  assert.deepEqual(errors, []);
});
