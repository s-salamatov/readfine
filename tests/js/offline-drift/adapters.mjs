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
// known on the day the harness was written (existing drift, see the s2-T5 report)
// or attributes only one side draws. Each pattern is applied, globally, to the
// normalised text of both sides before they are compared, and each carries a reason.
//
// Adding a case: add it to _cases() in test_offline_drift.py, to cases.json and here,
// then regenerate the fixtures with RF_UPDATE_GOLDENS=1.

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
