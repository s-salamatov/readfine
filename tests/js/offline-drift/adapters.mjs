// Cases of the offline drift harness: how templates.js draws each fragment whose
// server-side source backend/tests/test_offline_drift.py renders.
//
// Each case builds the IndexedDB-shaped record (and context) the offline overlay or
// router would hand its renderer, from the same data the Python case uses, so a
// difference in the output is a difference in the markup and not in the data.
//
//   { name, record, ctx, render: (T) => string, allowed?: [{ pattern, reason }] }
//
// `name` matches the Python case and backend/tests/fixtures/offline_drift/cases.json;
// it starts with the source the fragment comes from. `allowed` lists differences
// known on the day the harness was written (existing drift, see the s2-T5 and s2-T12 reports)
// or attributes only one side draws. Each pattern is applied, globally, to the
// normalised text of both sides before they are compared, and each carries a reason.
//
// Adding a case: add it to _cases() in test_offline_drift.py, to cases.json and here,
// then regenerate the fixtures with RF_UPDATE_GOLDENS=1.

import { JSDOM } from 'jsdom';

export const AID = 4242;
export const ORIGIN = 'http://testserver';

// Same data as LABELS in test_offline_drift.py.
export const LABELS = [
  { id: 1, name: 'R&D <x>', color: '#e11d48' },
  { id: 2, name: 'Work', color: '#2563eb' },
  { id: 3, name: 'Three', color: '#16a34a' },
  { id: 4, name: 'Four', color: '#ca8a04' },
  { id: 5, name: 'Five', color: '#9333ea' },
  { id: 6, name: 'Six', color: '#0891b2' },
  { id: 7, name: 'Seven', color: '#db2777' },
];
const TWO = LABELS.slice(0, 2);
const ALL_IDS = LABELS.map((l) => l.id);

// md_render_ai() of SUMMARY_MD / CONTEXT_MD in test_offline_drift.py: the sync
// payload carries the server's HTML (services/sync/payload.py, ai_summary_html).
const SUMMARY_HTML = '<p><strong>Key</strong> point &amp; &lt;i&gt;more&lt;/i&gt;</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n';
const CONTEXT_HTML = '<p>Context <em>here</em>.</p>\n';

// A record as the sync payload stores it (services/sync/payload.py).
export function record(over = {}) {
  return {
    id: AID, is_read: false, is_starred: false, is_archived: false, share_token: null,
    label_ids: [], ai_score: null, lexical_score: null,
    ai_summary_html: null, ai_summary_truncated: false, ai_context_html: null,
    ...over,
  };
}

// ---- allowed differences, each with its reason ------------------------------------

// Online the slot hooks sit on the element around the fragment; the offline renderer
// that redraws the whole element adds them itself.
const SLOT_SHARE = { pattern: / data-rf-slot="share"/, reason: 'offline adds the overlay slot hook to the share wrapper; online it sits on the enclosing #share-btn in article_detail.html' };
const SLOT_LABELS = { pattern: / data-rf-slot="labels"/, reason: 'offline adds the overlay slot hook to the OOB label areas; label_picker.html draws them without it (article_row.html and article_content.html carry it)' };
// Existing drift (backlog lines in the s2-T5 report).
const OOB_PLUS_N = { pattern: /(?<=class="leading-none ml-0\.5 text-\[10px\]) text-gray-(400|500)(?=")/, reason: 'existing drift: label_picker.html OOB row trigger draws "+N" text-gray-400, article_row.html and templates.js text-gray-500' };
const OOB_EMPTY_DOT_DARK = { pattern: / dark:border-gray-500(?= h-\[9px\] inline-block rounded-full w-\[9px\]">)/, reason: 'existing drift: label_picker.html OOB row trigger draws the empty dot without dark:border-gray-500, article_row.html and templates.js with it' };

// ---- cases --------------------------------------------------------------------------

function c(name, rec, ctx, render, allowed) {
  const out = { name, record: rec, ctx, render: (T) => render(T, rec, ctx) };
  if (allowed) out.allowed = allowed;
  return out;
}

// router.js picks the badge the same way _badge_html does (templates.js:77-80 hold
// the two badges; the choice is router.js:124/469).
const badgeHtml = (T, rec, ctx) => (rec.unread > 0 ? T.badgeUnread(rec.unread, ctx.profile) : T.badgeTotal(rec.total, ctx.profile));

const rowLabels = (T, rec, ctx) => T.rowLabelButton(rec, ctx.labels, ctx.display, ctx.compact);
const story = (info) => ({ others: info[0], total: info[1], read: info[2] });

export const CASES = [
  // badges.html and _badge_html
  c('badges-unread', { n: 12345 }, { profile: 'iso' }, (T, r, x) => T.badgeUnread(r.n, x.profile)),
  c('badges-total', { n: 7 }, { profile: 'iso' }, (T, r, x) => T.badgeTotal(r.n, x.profile)),
  c('badge_html-unread', { unread: 5, total: 9 }, { profile: 'iso' }, badgeHtml),
  c('badge_html-total', { unread: 0, total: 1234 }, { profile: 'iso' }, badgeHtml),

  // state buttons
  c('read_button-read', record({ is_read: true }), {}, (T, r) => T.readButton(r)),
  c('read_button-unread', record(), {}, (T, r) => T.readButton(r)),
  c('star_icon-starred', record({ is_starred: true }), {}, (T, r) => T.starButton(r)),
  c('star_icon-unstarred', record(), {}, (T, r) => T.starButton(r)),
  c('archive_button-archived', record({ is_archived: true }), {}, (T, r) => T.archiveButton(r)),
  c('archive_button-active', record(), {}, (T, r) => T.archiveButton(r)),
  c('share_button-shared', record({ share_token: 'tok' }), { origin: ORIGIN },
    (T, r, x) => T.shareButton(r.id, r.share_token, x.origin, false), [SLOT_SHARE]),
  c('share_button-unshared', record(), { origin: ORIGIN },
    (T, r, x) => T.shareButton(r.id, r.share_token, x.origin, false), [SLOT_SHARE]),

  // the row's label trigger
  c('article_row-labels-indicator-some', record({ label_ids: [1, 2] }), { labels: TWO, display: 'indicator', compact: false }, rowLabels),
  c('article_row-labels-indicator-empty', record(), { labels: TWO, display: 'indicator', compact: false }, rowLabels),
  c('article_row-labels-dots-seven', record({ label_ids: ALL_IDS }), { labels: LABELS, display: 'dots', compact: false }, rowLabels),
  c('article_row-labels-dots-seven-compact', record({ label_ids: ALL_IDS }), { labels: LABELS, display: 'dots', compact: true }, rowLabels),
  c('article_row-labels-dots-empty', record(), { labels: LABELS, display: 'dots', compact: false }, rowLabels),
  c('article_row-labels-none', record({ label_ids: [1, 2] }), { labels: TWO, display: 'none', compact: false }, rowLabels),

  // the detail's label parts
  c('article_content-labels-chips', record({ label_ids: [1, 2] }), { labels: TWO }, (T, r, x) => T.labelChips(r, x.labels)),
  c('article_content-labels-chips-empty', record(), { labels: TWO }, (T, r, x) => T.labelChips(r, x.labels)),
  c('article_content-label-dot-some', record({ label_ids: [1, 2] }), { labels: TWO }, (T, r, x) => T.detailLabelDot(r, x.labels)),
  c('article_content-label-dot-empty', record(), { labels: TWO }, (T, r, x) => T.detailLabelDot(r, x.labels)),

  // label_picker.html
  c('label_picker-list', record({ label_ids: [2] }), { labels: TWO }, (T, r, x) => T.labelPicker(r, x.labels)),
  c('label_picker-empty', record(), { labels: [] }, (T, r, x) => T.labelPicker(r, x.labels)),
  c('label_picker-oob', record({ label_ids: [1, 2] }), { labels: LABELS, labelDisplay: 'indicator' },
    (T, r, x) => T.labelPicker(r, x.labels, { oob: true, labelDisplay: x.labelDisplay }), [SLOT_LABELS]),
  c('label_picker-oob-unassigned', record(), { labels: TWO, labelDisplay: 'indicator' },
    (T, r, x) => T.labelPicker(r, x.labels, { oob: true, labelDisplay: x.labelDisplay }), [SLOT_LABELS, OOB_EMPTY_DOT_DARK]),
  c('label_picker-oob-dots', record({ label_ids: ALL_IDS }), { labels: LABELS, labelDisplay: 'dots' },
    (T, r, x) => T.labelPicker(r, x.labels, { oob: true, labelDisplay: x.labelDisplay }), [SLOT_LABELS, OOB_PLUS_N]),

  // ai_blocks.html
  c('ai_blocks-summary', record({ ai_summary_html: SUMMARY_HTML }), {}, (T, r) => T.aiSummary(r.id, r.ai_summary_html, !!r.ai_summary_truncated)),
  c('ai_blocks-summary-truncated', record({ ai_summary_html: SUMMARY_HTML, ai_summary_truncated: true }), {},
    (T, r) => T.aiSummary(r.id, r.ai_summary_html, !!r.ai_summary_truncated)),
  c('ai_blocks-context', record({ ai_context_html: CONTEXT_HTML }), {}, (T, r) => T.aiContext(r.id, r.ai_context_html)),

  // score_badge.html
  c('score_badge-ai-high', record({ ai_score: 0.82, lexical_score: 0.31 }), {}, (T, r) => T.scoreBadge(r)),
  c('score_badge-basic-mid', record({ lexical_score: 0.52 }), {}, (T, r) => T.scoreBadge(r)),
  c('score_badge-ai-low', record({ ai_score: 0.13 }), {}, (T, r) => T.scoreBadge(r)),
  c('score_badge-none', record(), {}, (T, r) => T.scoreBadge(r)),

  // the detail footer's scores
  c('article_content-score-both', record({ ai_score: 0.82, lexical_score: 0.52 }), {}, (T, r) => T.detailScore(r)),
  c('article_content-score-basic', record({ lexical_score: 0.13 }), {}, (T, r) => T.detailScore(r)),

  // story_block.html and the row story parts
  c('story_block-one', record(), { related: 1 }, (T, r, x) => T.storyBlock(r.id, x.related)),
  c('story_block-many', record(), { related: 4 }, (T, r, x) => T.storyBlock(r.id, x.related)),
  c('story_block-none', record(), { related: 0 }, (T, r, x) => T.storyBlock(r.id, x.related)),
  c('article_row-story-marker', record(), { info: story([3, 3, 0]) }, (T, r, x) => T.storyMarker(x.info)),
  c('article_row-story-marker-filtered', record(), { info: story([2, 7, 1]) }, (T, r, x) => T.storyMarker(x.info)),
  c('article_row-story-line', record(), { info: story([1, 1, 0]), interactive: false },
    (T, r, x) => T.storyLine(r.id, x.info, x.interactive)),
  c('article_row-story-line-interactive-filtered', record(), { info: story([2, 7, 1]), interactive: true },
    (T, r, x) => T.storyLine(r.id, x.info, x.interactive)),
];

// ---- allowed differences of the list, sidebar and story fragments (s2-T12) ----------

// An element and its whole subtree in the normalised text: the line of its open tag
// (which contains `frag`, a regex source), the deeper-indented lines under it and its
// closing tag at the same indent.
const block = (tag, frag) => new RegExp('^( *)<' + tag + '\\b[^\\n]*' + frag + '[^\\n]*>\\n(?:\\1 [^\\n]*\\n)*\\1</' + tag + '>\\n', 'm');
const re = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// The text line of an element. A difference is listed as a pair, one entry per side
// (server first), so a fixed drift leaves an entry that matches nothing and fails.
const line = (text) => new RegExp('(?<=\\n *)' + re(text) + '(?=\\n)');
const wording = (server, offline, reason) => [{ pattern: line(server), reason: reason + ' (server side)' }, { pattern: line(offline), reason: reason + ' (offline side)' }];

// story_members.html
const WR2_F4_WHY = 'existing drift (WR2-F4): story_members.html shows "· read" (inline-flex) for a member the reader read themselves (read_by_reader); templates.js always draws it hidden, the synced record has no read_by_reader';
const WR2_F4 = [
  { pattern: /(?<=<span class="gap-1\.5 )inline-flex(?= items-center shrink-0" data-story-member-read>)/, reason: WR2_F4_WHY + ' (server side)' },
  { pattern: /(?<=<span class="gap-1\.5 )hidden(?= items-center shrink-0" data-story-member-read>)/, reason: WR2_F4_WHY + ' (offline side)' },
];
const SAME_LINK = { pattern: /^( *)<span aria-hidden="true" class="shrink-0">\n\1 {2}·\n\1<\/span>\n\1<span class="shrink-0" title="Same link as this article, from another feed">\n\1 {2}same link\n\1<\/span>\n/m, reason: 'existing drift: story_members.html marks a member with the same link through another feed "· same link"; templates.js has no such marker (lists.storyMembers leaves same-URL members out instead)' };

// article_list.html
const NONCE = { pattern: / nonce="[^"]*"(?= type="application\/json")/, reason: 'server-only: the cfg island carries the CSP nonce online; offline it is a JSON data block that CSP does not apply to (templates.js listCfg)' };
const BOOKMARK_ARIA = { pattern: / aria-hidden="true"(?= class="h-3\.5 shrink-0 text-blue-400 w-3\.5")/, reason: 'existing drift: templates.js marks the Saved header bookmark aria-hidden, saved_icons.html bookmark_icon() does not' };
const SAVED_SEARCH_VALUES = { pattern: / data-saved-search-values="[^"]*"/, reason: 'server-only: the saved search modal values Edit reopens the server search modal with; offline has no Edit and no full modal' };
const SAVED_SEARCH_EDIT = { pattern: block('button', re('title="Change the search, rename or delete it"')), reason: 'existing drift: the saved-search header Edit button (opens the server search modal to change, rename or delete it) is not drawn offline' };
const SEARCH_NEW = { pattern: block('button', re('title="New search"')), reason: 'online-only: the search header "New search" button reopens the server search modal; offline search is the words-only searchModal, opened from the sidebar' };
const SEARCH_SAVE_AREA = { pattern: block('span', 'data-save-search-area'), reason: 'online-only: saving a search (Save / Update / Saved) needs the server; offline does not draw it' };
const SEARCH_SAVE_FORM = { pattern: block('div', 'data-save-search-form'), reason: 'online-only: the inline name field for saving a search needs the server; offline does not draw it' };
const SEARCH_SAVE_ERROR = { pattern: block('p', re('id="header-save-error"')), reason: 'online-only: the error line of saving a search; offline does not draw it' };
const SEARCH_ON_DEVICE = { pattern: /^( *)<span aria-hidden="true" class="shrink-0 text-gray-400">\n\1 {2}·\n\1<\/span>\n\1<span class="text-gray-500 whitespace-nowrap">\n\1 {2}Searching articles on this device\n\1<\/span>\n/m, reason: 'offline-only: the offline search header says it searched this device' };
const ON_DEVICE = 'offline wording: empty states say "on this device"';
const EMPTY_SAVED = wording('No saved articles yet. Paste a URL above to save one.', 'No saved articles on this device.', ON_DEVICE);
const EMPTY_SAVED_SEARCH = wording('Nothing matches this search yet.', 'Nothing matches this search on this device.', ON_DEVICE);
const EMPTY_SEARCH = wording('No results found.', 'No results on this device.', ON_DEVICE);
const EMPTY_PLAIN = wording('No articles found.', 'No articles on this device.', ON_DEVICE);

// sidebar.html
const CATCHUP = { pattern: block('a', re('href="/app/catch-me-up"')), reason: 'online-only (data-rf-online-only): Catch me up & Briefings is left out offline' };
const CHAT = { pattern: block('button', re('id="sidebar-chat-btn"')), reason: 'online-only (data-rf-online-only): the AI chat button is left out offline' };
const FEED_REFRESH = { pattern: block('button', re('data-action="feed-refresh"')), reason: 'online-only (data-rf-online-only): the per-feed refresh button is left out offline' };
const FEED_REFRESH_CSS = { pattern: /^ *@layer utilities\{[^\n]*(?:feed-refresh|spin-refresh|\.feed-nav-row)[^\n]*\n/m, reason: 'online-only: the sidebar.html <style> rules for the feed refresh button and the badge shift that makes room for it; SIDEBAR_STYLE leaves them out with the button' };
const FEED_MARK_WHY = 'existing drift: the feed-row mark-read button is h-6 w-6 right-2 (md: h-5 w-5 right-1) in sidebar.html, h-5 w-5 right-1 at every size in templates.js';
const IN_FEED_MARK_BTN = '(?=(?: [^"]*)?" data-action="mark-read" hx-post="\\/htmx\\/feeds\\/)';
const FEED_MARK_BTN = [
  { pattern: new RegExp(' (?:h-6|md:h-5|md:right-1|md:w-5|right-2|w-6)' + IN_FEED_MARK_BTN), reason: FEED_MARK_WHY + ' (server side)' },
  { pattern: new RegExp(' (?:h-5|right-1|w-5)' + IN_FEED_MARK_BTN), reason: FEED_MARK_WHY + ' (offline side)' },
];
const FEED_ERROR_BAR = { pattern: /^( *)<span class="shrink-0" style="width:\.18rem;[^"]*" title="[^"]*">\n\1<\/span>\n/m, reason: 'existing drift: sidebar.html draws the red error bar (feed_error.html) for a feed in error; the synced feed list has no status, so templates.js leaves #feed-error-N empty' };
const SAVED_COUNTS_LOADER = { pattern: block('span', re('hx-get="/htmx/saved-searches/counts"')), reason: 'server-only: online the saved-search counts load after the sidebar through this hidden loader; offline they are drawn in place' };
const MENU_ICONS = { pattern: block('svg', re('class="h-4 shrink-0 text-gray-400 w-4"')), reason: 'existing drift: user_menu_items.html draws an icon before Settings, Help and Logout; templates.js draws the items without icons' };
const MENU_VERSION = { pattern: block('div', re('class="pb-2 pt-2 px-3 text-gray-400 text-right text-xs"')), reason: 'existing drift: user_menu_items.html ends with the version and a "What\'s new" link; templates.js has no version line' };

// ---- story_members.html --------------------------------------------------------------

// Records as lists.storyMembers hands them over; same data as _story_member() in Python.
function member(over = {}) {
  return record({
    id: AID + 1, title: 'Other <take>', url: 'https://www.news.example/b', feed_id: 7,
    published_at: '2020-01-02T03:04:00+00:00', ...over,
  });
}

// router.js related(): the feed title from the synced feed list, or '' (then the host).
const FEED_TITLES = new Map([[7, 'Feed T']]);
function storyCtx(showScore) {
  return { feedTitle: (m) => FEED_TITLES.get(m.feed_id) || '', showScore, tz: 'UTC', profile: 'iso' };
}
const members = (T, recs, x) => T.storyMembers(recs, x);

function STORY_MEMBER_CASES() {
  return [
    c('story_members-mixed', [
      member({ is_starred: true, ai_score: 0.82, lexical_score: 0.31 }),
      member({ id: AID + 2, title: 'Read one', feed_id: 8, is_read: true, lexical_score: 0.52, url: 'https://www.other.example/c' }),
      member({ id: AID + 3, title: 'Bare', url: null, published_at: null }),
    ], storyCtx(true), members),
    c('story_members-no-score', [member({ ai_score: 0.82 })], storyCtx(false), members),
    c('story_members-read-by-reader', [member({ is_read: true })], storyCtx(true), members, [...WR2_F4]),
    c('story_members-same-link', [member()], storyCtx(true), members, [SAME_LINK]),
  ];
}

// ---- article_list.html ---------------------------------------------------------------

// Same data as SAVED_SEARCH in Python (the parsed saved search router.js passes).
const SAVED_SEARCH = { id: 3, name: 'Daily <AI> & more' };
const CFG = { markReadOnScroll: true, density: 'comfortable', labelDisplay: 'indicator', titleBarCount: null, titleBarCountType: null };
// Rows are snapshot HTML the server rendered; the Python case swaps each for this.
const rowStub = (id) => '<div data-drift-row="' + id + '"></div>';
const header = (T, r) => T.listHeader({ profile: 'iso', ...r });
// The header has cases of its own, so the page cases are drawn without one.
const page = (T, r) => T.listPage({ header: '', rows: [], hasMore: false, moreQs: '', savedSearch: null, viewFiltered: false, viewUnread: false, ...r, cfg: { ...CFG, ...r.cfg } });

function LIST_CASES() {
  return [
    c('article_list-header-saved', { savedView: true }, {}, header, [BOOKMARK_ARIA]),
    c('article_list-header-saved-search-unread', { savedSearch: SAVED_SEARCH, resultCount: 1234, viewUnread: true }, {}, header, [SAVED_SEARCH_VALUES, SAVED_SEARCH_EDIT]),
    c('article_list-header-saved-search-total', { savedSearch: SAVED_SEARCH, resultCount: 1, viewUnread: false }, {}, header, [SAVED_SEARCH_VALUES, SAVED_SEARCH_EDIT]),
    c('article_list-header-search', { search: true, query: 'R&D "x"', resultCount: 2 }, {}, header,
      [SEARCH_NEW, SEARCH_SAVE_AREA, SEARCH_SAVE_FORM, SEARCH_SAVE_ERROR, SEARCH_ON_DEVICE]),

    c('article_list-page-rows-more', { rows: [rowStub(AID), rowStub(AID + 1)], hasMore: true, moreQs: 'cursor_id=4243&feed_id=7', empty: 'plain' }, {}, page, [NONCE]),
    c('article_list-page-rows-end', { rows: [rowStub(AID)], empty: 'plain' }, {}, page, [NONCE]),
    c('article_list-page-empty-saved', { empty: 'saved' }, {}, page, [...EMPTY_SAVED, NONCE]),
    c('article_list-page-empty-saved-search', { empty: 'saved_search', savedSearch: SAVED_SEARCH }, {}, page, [...EMPTY_SAVED_SEARCH, NONCE]),
    c('article_list-page-empty-saved-search-unread', {
      empty: 'saved_search', savedSearch: SAVED_SEARCH, viewFiltered: true, viewUnread: true,
      cfg: { titleBarCount: 0, titleBarCountType: 'unread' },
    }, {}, page, [NONCE]),
    c('article_list-page-empty-search', { empty: 'search', cfg: { markReadOnScroll: false } }, {}, page, [...EMPTY_SEARCH, NONCE]),
    c('article_list-page-empty-plain', { empty: 'plain', cfg: { density: 'compact' } }, {}, page, [...EMPTY_PLAIN, NONCE]),
  ];
}

// ---- sidebar.html --------------------------------------------------------------------

// The synced lists (services/sync/payload.py) and RFOffline.lists.counts(); same data
// as SIDEBAR_FEEDS, SIDEBAR_COUNTS and SIDEBAR_SAVED in Python. The saved-search
// counts are left out: online they arrive after the sidebar (/htmx/saved-searches/
// counts), so the sidebar.html fixture has the slots empty.
const SIDEBAR_LISTS = {
  labels: [{ ...LABELS[0], position: 0 }, { ...LABELS[1], position: 1 }],
  saved_searches: [{ id: 3, name: 'Daily <AI> & more' }, { id: 4, name: 'zed' }],
  folders: [{ id: 10, name: 'Alpha & co', position: 0 }, { id: 11, name: 'beta', position: 1 }],
  feeds: [
    { feed_id: 101, title: 'Ann <custom>', folder_id: 10, position: 0 },
    { feed_id: 102, title: 'Zeta news', folder_id: 10, position: 1 },
    { feed_id: 103, title: 'Broken feed', folder_id: 11, position: 0 },
    { feed_id: 104, title: 'Loose feed', folder_id: null, position: 0 },
  ],
};
const b = (unread, total) => ({ unread, total });
const SIDEBAR_COUNTS = {
  all: b(5, 9), starred: b(0, 2), archived: b(0, 0), saved: b(1, 3), labeled: b(0, 4),
  labels: { 1: b(2, 3), 2: b(0, 1) },
  folders: { 10: b(3, 5), 11: b(0, 2) }, noFolder: b(120, 130),
  feeds: { 101: b(3, 4), 102: b(0, 1), 103: b(0, 2), 104: b(120, 130) },
  savedSearches: {},
};
const EMPTY_LISTS = { labels: [], saved_searches: [], folders: [], feeds: [] };
const EMPTY_COUNTS = {
  all: b(0, 0), starred: b(0, 0), archived: b(0, 0), saved: b(0, 0), labeled: b(0, 0),
  labels: {}, folders: {}, noFolder: b(0, 0), feeds: {}, savedSearches: {},
};

// A part of the rendered sidebar, picked as the Python case picks it from sidebar.html.
function part(html, pick) {
  const frag = JSDOM.fragment(html);
  if (pick === 'no-style') {
    frag.querySelectorAll('style').forEach((el) => el.remove());
    return Array.from(frag.childNodes, (n) => n.outerHTML || n.textContent).join('');
  }
  const el = frag.querySelector(pick);
  return el ? el.outerHTML : '';
}
const sidebarPart = (T, r, x) => part(T.sidebar(r.counts, r.lists, x.opts), x.pick);
// autoAdvance: the renderer draws data-auto-advance as sidebar.html does; router.js does
// not pass it today (see the s2-T12 report), the case checks the renderer.
const FULL_OPTS = { displayName: 'ann', profile: 'iso', autoAdvance: true };

function SIDEBAR_CASES() {
  const full = { counts: SIDEBAR_COUNTS, lists: SIDEBAR_LISTS };
  return [
    c('sidebar-rail', full, { opts: FULL_OPTS, pick: '#sidebar-rail' }, sidebarPart),
    c('sidebar-full', full, { opts: FULL_OPTS, pick: '#sidebar-full' }, sidebarPart, [
      MENU_ICONS, MENU_VERSION, CATCHUP, CHAT, SAVED_COUNTS_LOADER, FEED_REFRESH, ...FEED_MARK_BTN, FEED_ERROR_BAR]),
    c('sidebar-empty', { counts: EMPTY_COUNTS, lists: EMPTY_LISTS }, { opts: { displayName: 'ann', profile: 'iso' }, pick: 'no-style' }, sidebarPart,
      [MENU_ICONS, MENU_VERSION]),
    c('sidebar-style', full, { opts: FULL_OPTS, pick: 'style' }, sidebarPart, [FEED_REFRESH_CSS]),
  ];
}

// The list, sidebar and story fragments (s2-T12), after the data they read is defined.
CASES.push(...STORY_MEMBER_CASES(), ...LIST_CASES(), ...SIDEBAR_CASES());
