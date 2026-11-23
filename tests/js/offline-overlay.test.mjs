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
  // The tabbed AI panel of article_detail.html as a snapshot draws it: Summary and
  // Context tabs, the context's Generate button beside its area.
  const html = '<div id="article-detail-root" data-rf-article="5"><article class="reading-area" data-is-read="false">'
    + '<span class="detail-meta-date"><time data-rf-time="2025-01-02T03:04:00+00:00">x</time></span>'
    + '<div data-rf-slot="saved-icon" class="border-t hidden"></div>'
    + '<div class="hidden"><div id="share-btn-5" data-rf-slot="share"><button>Share article…</button></div></div>'
    + '<section class="ai-panel relative mb-6 hidden" data-rf-placeholder="ai" aria-label="AI"><div class="tabs" id="ai-panel-5">'
    + '<nav role="tablist"><button type="button" role="tab" id="ai-panel-5-tab-1" aria-controls="ai-panel-5-panel-1" aria-selected="true">Summary</button>'
    + '<button type="button" role="tab" id="ai-panel-5-tab-2" aria-controls="ai-panel-5-panel-2" aria-selected="false">Context</button></nav>'
    + '<div role="tabpanel" id="ai-panel-5-panel-1" aria-labelledby="ai-panel-5-tab-1"><div class="ai-summary-zone pt-3"><div data-rf-slot="ai-summary"></div></div></div>'
    + '<div role="tabpanel" id="ai-panel-5-panel-2" aria-labelledby="ai-panel-5-tab-2" hidden><div class="pt-3">'
    + '<div id="ai-context-area-5" data-rf-slot="ai-context"><div id="ai-context-5"></div></div>'
    + '<div id="context-panel-5"><button type="button" class="btn" data-variant="secondary" data-size="sm" data-rf-slot="ai-context-action">Generate</button></div>'
    + '</div></div></div></section>'
    + '</article></div>';
  const root = render(w, html, rec(5, { ai_context_html: '<p>ctx</p>', share_token: 'tok', saved_at: '2026-01-01T00:00:00Z' }),
    { origin: 'https://readfine.test' });
  assert.match(root.querySelector('#ai-context-5').textContent, /AI context\s*ctx/);
  assert.ok(root.querySelector('#ai-panel-5-panel-2 #ai-context-5'), 'the context stays in its tab');
  assert.ok(!root.querySelector('[data-rf-placeholder="ai"]').classList.contains('hidden'));
  assert.equal(root.querySelector('[data-rf-slot="ai-context-action"]').textContent.trim(), 'Regenerate');
  // No summary on the record: its slot stays empty.
  assert.equal(root.querySelector('[data-rf-slot="ai-summary"]').innerHTML, '');
  assert.equal(root.querySelector('#share-btn-5 input').value, 'https://readfine.test/share/tok');
  assert.ok(!root.querySelector('[data-rf-slot="saved-icon"]').classList.contains('hidden'));
  assert.equal(root.querySelector('time').textContent, '02.01.2025 04:04');
});

// The read, star and archive controls of article_detail.html's toolbar and of the
// article_content.html bottom (phone: floating) bar, as a snapshot draws them.
const ICON_READ = 'M21 10.07V19a2 2 0 01-2 2H5a2 2 0 01-2-2v-8.93M21 10.07A2 2 0 0020.11 8.4l-7-4.667a2 2 0 00-2.22 0L3.9 8.4A2 2 0 003 10.07M21 10.07l-7.44 4.96a2 2 0 01-2.12 0L3 10.07';
const ICON_UNREAD = 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z';
function toolbarDetail(id, { read = false, starred = false, archived = false } = {}) {
  const btn = (attrs, inner) => '<button type="button" class="btn" data-variant="ghost" data-size="icon-sm" ' + attrs + '>' + inner + '</button>';
  const svg = (cls, d, fill = 'none') => '<svg class="' + cls + '" fill="' + fill + '" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  return '<div id="article-detail-root" data-article-id="' + id + '" data-rf-article="' + id + '">'
    + '<div id="mobile-detail-back-bar"><div data-article-toolbar class="article-detail-menu"><div class="article-toolbar-state flex">'
    + btn('data-header-read data-rf-slot="read-button" hx-post="/htmx/articles/' + id + '/read"',
      svg('w-4 h-4 shrink-0 ' + (read ? 'text-gray-600' : 'text-gray-400'), read ? ICON_READ : ICON_UNREAD)
      + '<span data-label class="sr-only">' + (read ? 'Mark as unread' : 'Mark as read') + '</span>')
    + btn('data-header-star data-rf-slot="star-button" hx-post="/htmx/articles/' + id + '/star"',
      svg('w-4 h-4 shrink-0', 'M1 1', starred ? 'currentColor' : 'none') + '<span data-label class="sr-only">' + (starred ? 'Starred' : 'Star') + '</span>')
    + btn('data-header-archive data-rf-slot="archive-button" hx-post="/htmx/articles/' + id + '/archive"',
      svg('w-4 h-4 shrink-0 ' + (archived ? 'text-gray-700' : 'text-gray-400'), 'M2 2') + '<span data-label class="sr-only">' + (archived ? 'Archived' : 'Archive') + '</span>')
    + '</div></div></div>'
    + '<article class="reading-area" data-article-id="' + id + '" data-is-read="' + read + '">'
    + '<div class="article-bottom-bar hidden flex" data-article-id="' + id + '"><div class="flex items-center gap-1">'
    + '<button data-bottom-read hx-post="/htmx/articles/' + id + '/read" class="w-8 h-8 flex" aria-label="Mark as read or unread" title="Mark as read or unread">'
    + svg('w-4 h-4 ' + (read ? 'text-gray-600' : 'text-gray-400'), read ? ICON_READ : ICON_UNREAD) + '</button>'
    + '<button data-bottom-star data-rf-slot="star-button" class="w-8 h-8 flex" title="' + (starred ? 'Remove star' : 'Star') + '">'
    + '<span class="text-[16px] leading-none ' + (starred ? 'text-gray-600' : 'text-gray-300') + '" style="margin-top:-2px">' + (starred ? '★' : '☆') + '</span></button>'
    + '<button data-bottom-archive data-rf-slot="archive-button" class="w-8 h-8 flex" title="' + (archived ? 'Unarchive' : 'Archive') + '">'
    + '<svg class="w-4 h-4 ' + (archived ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500') + '" style="margin-top:1px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M2 2"/></svg></button>'
    + '</div></div></article></div>';
}

test('overlay: toolbar and floating-bar buttons follow read, star and archive', () => {
  const w = overlayPage();
  const cls = (el) => [...el.classList].sort().join(' ');
  // A neutral snapshot (unread, unstarred, active) and a record that is all three.
  const on = render(w, toolbarDetail(11), rec(11, { is_read: true, is_starred: true, is_archived: true }));
  const hRead = on.querySelector('[data-header-read]');
  assert.equal(cls(hRead), 'btn', 'the toolbar button itself is kept');
  assert.equal(hRead.getAttribute('data-variant'), 'ghost');
  const hReadSvg = hRead.querySelector('svg');
  assert.equal(hReadSvg.querySelector('path').getAttribute('d'), ICON_READ);
  assert.equal(cls(hReadSvg), 'h-4 shrink-0 text-gray-600 w-4');
  assert.equal(hReadSvg.getAttribute('aria-hidden'), 'true');
  assert.equal(hRead.querySelector('[data-label]').textContent, 'Mark as unread');
  const bRead = on.querySelector('[data-bottom-read] svg');
  assert.equal(bRead.querySelector('path').getAttribute('d'), ICON_READ);
  assert.equal(cls(bRead), 'h-4 text-gray-600 w-4');
  assert.equal(bRead.getAttribute('aria-hidden'), 'true');
  assert.equal(on.querySelector('[data-header-star] svg').getAttribute('fill'), 'currentColor');
  assert.equal(on.querySelector('[data-header-star] [data-label]').textContent, 'Starred');
  assert.equal(on.querySelector('[data-bottom-star]').getAttribute('title'), 'Remove star');
  assert.equal(on.querySelector('[data-bottom-star] span').textContent, '★');
  assert.ok(on.querySelector('[data-header-archive] svg').classList.contains('text-gray-700'));
  assert.ok(!on.querySelector('[data-header-archive] svg').classList.contains('text-gray-400'));
  assert.equal(on.querySelector('[data-header-archive] [data-label]').textContent, 'Archived');
  assert.equal(on.querySelector('[data-bottom-archive]').getAttribute('title'), 'Unarchive');
  assert.equal(cls(on.querySelector('[data-bottom-archive] svg')), 'dark:text-gray-200 h-4 text-gray-700 w-4');
  // And back: a snapshot drawn read, starred and archived, a record that is none of them.
  const off = render(w, toolbarDetail(12, { read: true, starred: true, archived: true }), rec(12));
  assert.equal(off.querySelector('[data-header-read] svg path').getAttribute('d'), ICON_UNREAD);
  assert.equal(cls(off.querySelector('[data-header-read] svg')), 'h-4 shrink-0 text-gray-400 w-4');
  assert.equal(off.querySelector('[data-header-read] [data-label]').textContent, 'Mark as read');
  assert.equal(off.querySelector('[data-bottom-read] svg path').getAttribute('d'), ICON_UNREAD);
  assert.equal(cls(off.querySelector('[data-bottom-read] svg')), 'h-4 text-gray-400 w-4');
  assert.equal(off.querySelector('[data-header-star] svg').getAttribute('fill'), 'none');
  assert.equal(off.querySelector('[data-bottom-star] span').textContent, '☆');
  assert.equal(cls(off.querySelector('[data-header-archive] svg')), 'h-4 shrink-0 text-gray-400 w-4');
  assert.equal(cls(off.querySelector('[data-bottom-archive] svg')), 'dark:text-gray-500 h-4 text-gray-400 w-4');
  assert.equal(off.querySelector('article').getAttribute('data-is-read'), 'false');
});

test('install rewrites offline responses before htmx swaps them', () => {
  const w = overlayPage();
  const xhr = (offline) => ({ getResponseHeader: (h) => (offline && h === 'X-Readfine-Offline' ? '1' : null) });
  const island = '<script type="application/json" data-rf-state>'
    + JSON.stringify({ records: { 6: rec(6, { is_read: true }) }, labels: [], prefs: PREFS }) + '</script>';
  const detail = { serverResponse: row(6) + island, xhr: xhr(true) };
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeSwap', { detail, bubbles: true }));
  assert.ok(!detail.serverResponse.includes('data-rf-state'));
  assert.match(detail.serverResponse, /data-is-read="true"/);
  // Online answers are not parsed, island or not.
  const online = { serverResponse: row(6) + island, xhr: xhr(false) };
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:beforeSwap', { detail: online, bubbles: true }));
  assert.equal(online.serverResponse, row(6) + island);
});

test('online-only links are disabled and their clicks swallowed', () => {
  const w = overlayPage();
  const host = w.document.createElement('div');
  host.innerHTML = '<div data-rf-article="8" id="article-detail-root"><a href="/settings" data-rf-online-only>Settings</a>'
    + '<button data-rf-online-only>Chat</button></div>';
  w.document.body.appendChild(host);
  w.RFOffline.overlay.install(w.document);
  w.RFOffline.overlay.applyState(host, { records: { 8: rec(8) }, prefs: PREFS, labels: [] });
  const a = host.querySelector('a');
  assert.equal(a.getAttribute('aria-disabled'), 'true');
  assert.ok(a.classList.contains('pointer-events-none'));
  assert.ok(!a.hasAttribute('disabled'));
  assert.ok(host.querySelector('button').hasAttribute('disabled'));
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true });
  let reached = false;
  host.addEventListener('click', () => { reached = true; });
  a.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented);
  assert.equal(reached, false);
});
