import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const script = fs.readFileSync(new URL('../../backend/app/static/js/feeds-settings.js', import.meta.url), 'utf8');
const tabs = '<button id="tab-feeds" aria-pressed="true">Feeds</button><button id="tab-stats" aria-pressed="false">Stats</button>';
const select = (has = true) => '<select id="subscribe-folder-select"><option value="">No folder</option>' + (has ? '<option value="2">Two</option>' : '') + '</select>';

test('sources folders: swaps preserve selection and keyboard focus', () => {
  const dom = new JSDOM('<body>' + tabs + select() + '<div id="feeds-list"></div></body>', { runScripts: 'outside-only', url: 'https://readfine.test/sources' });
  const w = dom.window, d = w.document;
  let scrolls = 0, animations = 0, reduced = false;
  w.matchMedia = () => ({ matches: reduced });
  w.HTMLElement.prototype.scrollIntoView = () => { scrolls++; };
  w.RFMotion = { tokens: { med: 300 }, reduced: () => reduced, animate: (row, options) => {
    assert.equal(options.duration, 300); animations++; options.onComplete();
  } };
  const xhr = {};
  const emit = (name, path = '/sources/folders/2/move') => d.dispatchEvent(new w.CustomEvent(name, { bubbles: true, detail: { xhr, requestConfig: { path }, target: d.getElementById('feeds-list') } }));
  try {
    w.eval(script);
    d.dispatchEvent(new w.Event('DOMContentLoaded'));
    w.eval(script);
    d.dispatchEvent(new w.Event('DOMContentLoaded'));
    for (const direction of ['up', 'down']) {
      d.getElementById('subscribe-folder-select').value = '2';
      d.getElementById('tab-stats').click();
      assert.equal(d.getElementById('tab-stats').getAttribute('aria-pressed'), 'true');
      emit('htmx:beforeSwap');
      d.getElementById('subscribe-folder-select').outerHTML = select();
      d.getElementById('feeds-list').innerHTML = '<div id="folder-header-2"><button id="folder-move-' + direction + '-2">Move</button></div>';
      d.activeElement.blur();
      emit('htmx:afterSwap'); emit('htmx:afterSettle');
      assert.equal(d.getElementById('subscribe-folder-select').value, '2');
      assert.equal(d.activeElement.id, 'folder-move-' + direction + '-2');
      assert.equal(d.getElementById('tab-feeds').getAttribute('aria-pressed'), 'true');
    }
    assert.equal(scrolls, 2, 'script reinsertion must not duplicate listeners');
    assert.equal(animations, 2);
    reduced = true;
    emit('htmx:beforeSwap');
    d.getElementById('subscribe-folder-select').outerHTML = select(false);
    emit('htmx:afterSwap'); emit('htmx:afterSettle');
    assert.equal(d.getElementById('subscribe-folder-select').value, '');
    assert.equal(scrolls, 3); assert.equal(animations, 2);
    // Boost replaces the body, not the document listeners.
    d.body.innerHTML = tabs + '<div id="feeds-list"></div>';
    emit('htmx:afterSwap', '/sources');
    d.getElementById('tab-stats').click();
    emit('rf:sourceschanged');
    assert.equal(d.getElementById('tab-feeds').getAttribute('aria-pressed'), 'true');
  } finally { w.close(); }
});

test('sources folders: canonical responses restore the Feeds tab; old paths are ignored', () => {
  const dom = new JSDOM('<body>' + tabs + '<div id="feeds-list"></div></body>', { runScripts: 'outside-only', url: 'https://readfine.test/sources' });
  const w = dom.window, d = w.document;
  const swap = path => d.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { detail: { requestConfig: { path }, target: d.getElementById('feeds-list') } }));
  try {
    w.eval(script);
    for (const path of ['/sources/folders/2/rename', '/sources/folder-order', '/sources/feeds-list']) {
      d.getElementById('tab-stats').click();
      swap(path);
      assert.equal(d.getElementById('tab-feeds').getAttribute('aria-pressed'), 'true', path);
    }
    // The non-GET aliases are gone (s8): an old path answers only the stale toast.
    d.getElementById('tab-stats').click();
    swap('/settings/folders/2/rename');
    assert.equal(d.getElementById('tab-stats').getAttribute('aria-pressed'), 'true');
  } finally { w.close(); }
});
