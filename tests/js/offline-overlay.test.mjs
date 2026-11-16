// Page-side overlay of offline fragments (offline/overlay.js + templates.js), on real
// DOM (jsdom). Fragments carry the hooks of the task 7 contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayPage } from './harness.mjs';

const PREFS = { timezone: 'Europe/Berlin', format_profile: 'eu', label_display: 'dots', ai_score_show_in_list: true };
const LABELS = [{ id: 1, name: 'Work', color: '#00ff00' }, { id: 2, name: '<b>x</b>', color: '#0000ff' }];

function row(id, { density = 'comfortable', read = false } = {}) {
  return '<div id="article-row-' + id + '" class="article-row border-b ' + (read ? 'opacity-75' : '') + ' pl-2 pr-4"'
    + ' data-rf-article="' + id + '" data-rf-read-classes="opacity-75" data-rf-unread-classes=""'
    + ' data-density="' + density + '" data-is-read="' + read + '">'
    + '<button data-star-btn data-rf-slot="star-button" title="Star article"><span class="' + (density === 'compact' ? 'text-base' : 'text-lg') + ' text-gray-300 hover:text-gray-500">☆</span></button>'
    + '<a data-article-title data-rf-read-classes="font-medium text-gray-800" data-rf-unread-classes="font-bold text-gray-900"'
    + ' class="min-w-0 text-sm ' + (read ? 'font-medium text-gray-800' : 'font-bold text-gray-900') + '">T</a>'
    + '<span data-archived-indicator data-rf-slot="archive-button" class="text-[10px] hidden">· archived</span>'
    + '<span data-rf-slot="score-badge" data-rf-placeholder></span>'
    + '<div id="article-labels-' + id + '" data-rf-slot="labels" class="flex items-center"></div>'
    + '<span class="text-xs text-gray-500"><time data-rf-time="2026-11-16T09:05:00+00:00">old</time></span>'
    + '<div data-rf-slot="related-count" data-rf-placeholder></div></div>';
}

function rec(id, over = {}) {
  return Object.assign({ id, is_read: false, is_starred: false, is_archived: false, saved_at: null,
    label_ids: [], share_token: null, ai_score: null, lexical_score: null }, over);
}

function render(w, html, record, ctx) {
  const host = w.document.createElement('div');
  host.innerHTML = html;
  w.document.body.appendChild(host);
  const root = host.querySelector('[data-rf-article]');
  w.RFOffline.overlay.apply(root, record, Object.assign({ labels: LABELS, prefs: PREFS, now: Date.parse('2026-11-16T12:00:00Z') }, ctx || {}));
  return root;
}

test('overlay toggles read classes exactly as listed on root', () => {
  const w = overlayPage();
  const root = render(w, row(1).replace('border-b ', 'border-b keep-me '), rec(1, { is_read: true }));
  assert.ok(root.classList.contains('opacity-75'));
  assert.ok(root.classList.contains('keep-me') && root.classList.contains('pl-2'));
  assert.equal(root.getAttribute('data-is-read'), 'true');
  const title = root.querySelector('[data-article-title]');
  assert.deepEqual([...title.classList].sort(), ['font-medium', 'min-w-0', 'text-gray-800', 'text-sm']);
  // And back: an unread record on a row drawn read.
  const back = render(w, row(2, { read: true }), rec(2, { is_read: false }));
  assert.ok(!back.classList.contains('opacity-75'));
  assert.equal(back.getAttribute('data-is-read'), 'false');
  assert.deepEqual([...back.querySelector('[data-article-title]').classList].sort(), ['font-bold', 'min-w-0', 'text-gray-900', 'text-sm']);
});

test('starred compact row keeps its size and takes the read colour', () => {
  const w = overlayPage();
  const root = render(w, row(3, { density: 'compact' }), rec(3, { is_starred: true, is_read: true }));
  const span = root.querySelector('[data-star-btn] span');
  assert.equal(span.textContent, '★');
  assert.ok(span.classList.contains('text-base') && span.classList.contains('text-gray-700'));
  assert.ok(!span.classList.contains('text-gray-900'));
  assert.equal(root.querySelector('[data-star-btn]').getAttribute('title'), 'Remove star');
});

test('labels, archive, score, time and story line', () => {
  const w = overlayPage();
  const root = render(w, row(4), rec(4, { label_ids: [1, 2], is_archived: true, ai_score: 0.81 }), {
    stories: { 4: { others: 2, total: 3, read: 1 } }, interactive: true, storyScope: 'folder_id=1',
  });
  const dots = root.querySelectorAll('#article-labels-4 [style]');
  assert.equal(dots.length, 2);
  assert.equal(root.querySelector('#article-labels-4 button').getAttribute('title'), 'Work, <b>x</b>');
  assert.equal(root.querySelector('#article-labels-4 b'), null);
  assert.ok(!root.querySelector('[data-archived-indicator]').classList.contains('hidden'));
  assert.equal(root.querySelector('[data-rf-slot="score-badge"]').textContent, '81');
  // 09:05 UTC is 10:05 in Berlin, the same day: the short form is the time alone.
  assert.equal(root.querySelector('time').textContent, '10:05');
  const chip = root.querySelector('[data-story-toggle="4"]');
  assert.ok(chip);
  assert.match(chip.textContent, /2 of 3 other sources · 1 read/);
  assert.equal(root.getAttribute('data-story-scope'), 'folder_id=1');
});

test('detail: AI context, share link, saved icon and long dates', () => {
  const w = overlayPage();
  const html = '<div id="article-detail-root" data-rf-article="5"><article class="reading-area" data-is-read="false">'
    + '<span class="detail-meta-date"><time data-rf-time="2025-01-02T03:04:00+00:00">x</time></span>'
    + '<button data-show-context-panel="5" data-rf-slot="ai-context-action"><svg></svg>\n Generate context\n</button>'
    + '<div data-rf-slot="saved-icon" class="border-t hidden"></div>'
    + '<div class="hidden"><div id="share-btn-5" data-rf-slot="share"><button>Share article…</button></div></div>'
    + '<div class="mb-5 space-y-3 hidden" data-rf-placeholder="ai"><div data-rf-slot="ai-summary"></div>'
    + '<div id="ai-context-area-5" data-rf-slot="ai-context"><div id="ai-context-5"></div></div></div>'
    + '</article></div>';
  const root = render(w, html, rec(5, { ai_context_html: '<p>ctx</p>', share_token: 'tok', saved_at: '2026-01-01T00:00:00Z' }),
    { origin: 'https://readfine.test' });
  assert.match(root.querySelector('#ai-context-5').textContent, /AI context\s*ctx/);
  assert.ok(!root.querySelector('[data-rf-placeholder="ai"]').classList.contains('hidden'));
  assert.match(root.querySelector('[data-show-context-panel]').textContent, /Regenerate context/);
  assert.ok(root.querySelector('[data-show-context-panel] svg'));
  assert.equal(root.querySelector('#share-btn-5 input').value, 'https://readfine.test/share/tok');
  assert.ok(!root.querySelector('[data-rf-slot="saved-icon"]').classList.contains('hidden'));
  assert.equal(root.querySelector('time').textContent, '02.01.2025 04:04');
});

test('install rewrites offline responses before htmx swaps them', () => {
  const w = overlayPage();
  const island = '<script type="application/json" data-rf-state>'
    + JSON.stringify({ records: { 6: rec(6, { is_read: true }) }, labels: [], prefs: PREFS }) + '</script>';
  const detail = { serverResponse: row(6) + island };
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeSwap', { detail, bubbles: true }));
  assert.ok(!detail.serverResponse.includes('data-rf-state'));
  assert.match(detail.serverResponse, /data-is-read="true"/);
  // Online answers carry no island and pass through untouched.
  const online = { serverResponse: '<div data-rf-article="7" data-is-read="false"></div>' };
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeSwap', { detail: online, bubbles: true }));
  assert.equal(online.serverResponse, '<div data-rf-article="7" data-is-read="false"></div>');
});
