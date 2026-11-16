// Small HTML fragments the offline router answers with, as strings.
//
// Plain script, no DOM: the service worker renders with these. Markup is copied from
// the Jinja partial named above each function, with the same classes and hx-*
// attributes, so the page's htmx and app.js treat an offline answer like the server's.
// Everything interpolated goes through esc(): unlike Jinja there is no autoescape here.
// Snapshots (row and detail HTML) are rendered by the server; these cover what the
// server would render per request: action responses, the sidebar, the label picker,
// list scaffolding, and the "needs a connection" stand-ins.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // A colour from the label list, used inside style="". Anything but a plain colour
  // value is dropped (the server validates colours; this is belt and braces).
  function color(c) {
    return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$/.test(String(c || '')) ? c : '#9ca3af';
  }

  // ---- numbers and dates (app/utils/formats.py, datetime_format.py) ------------------

  var PROFILES = {
    us: { group: ',', order: ['M', 'D', 'Y'], sep: '/' },
    uk: { group: ',', order: ['D', 'M', 'Y'], sep: '/' },
    eu: { group: ' ', order: ['D', 'M', 'Y'], sep: '.' },
    de: { group: '.', order: ['D', 'M', 'Y'], sep: '.' },
    iso: { group: '', order: ['Y', 'M', 'D'], sep: '-' },
  };
  function profile(key) { return PROFILES[key] || PROFILES.iso; }

  function num(n, prof) {
    var s = String(Math.round(Number(n) || 0));
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, profile(prof).group);
  }

  function zoned(ms, tz) {
    var opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    var parts;
    try { parts = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || 'UTC' }, opts)).formatToParts(ms); } catch (e) {
      parts = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts)).formatToParts(ms);
    }
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return { Y: o.year, M: o.month, D: o.day, hm: (o.hour === '24' ? '00' : o.hour) + ':' + o.minute };
  }

  // format_local: kind 'short' (today: HH:MM; this year: date without year + time;
  // older: date + time) or 'long' (date + time). -> '' for an unreadable time.
  function date(iso, tz, prof, kind, nowMs) {
    var ms = Date.parse(iso || '');
    if (isNaN(ms)) return '';
    var p = profile(prof);
    var d = zoned(ms, tz);
    var datePart = function (withYear) {
      return p.order.filter(function (k) { return withYear || k !== 'Y'; }).map(function (k) { return d[k]; }).join(p.sep);
    };
    if (kind === 'long') return datePart(true) + ' ' + d.hm;
    var n = zoned(nowMs === undefined ? Date.now() : nowMs, tz);
    if (n.Y === d.Y && n.M === d.M && n.D === d.D) return d.hm;
    if (n.Y === d.Y) return datePart(false) + ' ' + d.hm;
    return datePart(true) + ' ' + d.hm;
  }

  function hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  // ---- badges (badges.html) -----------------------------------------------------------

  function badgeUnread(n, prof) {
    return '<span class="mark-read-badge inline-block ml-auto flex-shrink-0 text-xs font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">' + num(n, prof) + '</span>';
  }
  function badgeTotal(n, prof) {
    return '<span class="mark-read-badge inline-block ml-auto flex-shrink-0 text-xs text-gray-400 px-1.5 py-0.5">' + num(n, prof) + '</span>';
  }
  function badge(c, prof) { return c.unread > 0 ? badgeUnread(c.unread, prof) : badgeTotal(c.total, prof); }

  // ---- state buttons -------------------------------------------------------------------

  // read_button.html
  function readButton(rec) {
    var r = !!rec.is_read;
    return '<button hx-post="/htmx/articles/' + rec.id + '/read"\n'
      + '        data-rf-read-classes="bg-blue-50 border-blue-200 text-blue-700"\n'
      + '        data-rf-unread-classes="border-gray-200 text-gray-500 hover:bg-gray-50"\n'
      + '        hx-target="#read-btn-' + rec.id + '"\n        hx-swap="innerHTML"\n'
      + '        title="' + (r ? 'Mark as unread' : 'Mark as read') + '"\n'
      + '        class="flex items-center gap-1 px-2 py-1 rounded text-xs border '
      + (r ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50') + '">\n  '
      + (r ? '✓ Read' : '○ Unread') + '\n</button>';
  }

  // star_icon.html: what the star route answers with.
  function starButton(rec) {
    var s = !!rec.is_starred;
    return '<button hx-post="/htmx/articles/' + rec.id + '/star"\n'
      + '        hx-target="#star-btn-' + rec.id + '"\n        hx-swap="innerHTML"\n'
      + '        class="leading-none cursor-pointer bg-transparent border-0 p-0 focus:outline-none"\n'
      + '        title="' + (s ? 'Remove star' : 'Star article') + '">\n  '
      + (s ? '<span class="text-lg text-gray-900">★</span>' : '<span class="text-lg text-gray-300 hover:text-gray-500">☆</span>')
      + '\n</button>';
  }

  // archive_button.html
  function archiveButton(rec) {
    var a = !!rec.is_archived;
    return '<button hx-post="/htmx/articles/' + rec.id + '/archive"\n'
      + '        hx-target="#archive-btn-' + rec.id + '"\n        hx-swap="innerHTML"\n'
      + '        title="' + (a ? 'Unarchive' : 'Archive') + '"\n'
      + '        class="flex items-center gap-1 px-2 py-1 rounded text-xs border '
      + (a ? 'bg-gray-100 border-gray-300 text-gray-700 dark:bg-gray-700 dark:border-gray-500 dark:text-gray-100'
        : 'border-gray-200 text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800')
      + '">\n  ' + (a ? '⊡ Archived' : '⊟ Archive') + '\n</button>';
  }

  // share_button.html. `pending` (offline): a share or revoke waits for the next sync.
  function shareButton(id, token, origin, pending) {
    var inner;
    if (pending) {
      inner = '<p class="text-xs text-gray-500 py-1">Requested – arrives after sync</p>';
    } else if (token) {
      inner = '<div class="flex items-center gap-2 py-1">\n  <span class="text-xs text-green-700 font-medium">Shared</span>\n'
        + '  <button hx-post="/htmx/articles/' + id + '/share" hx-target="#share-btn-' + id + '" hx-swap="outerHTML" class="text-xs text-red-500 hover:underline">Revoke</button>\n</div>\n'
        + '<input type="text" readonly value="' + esc((origin || '') + '/share/' + token) + '" data-action="select-all"'
        + ' class="w-full text-xs border border-gray-300 rounded px-1.5 py-0.5 font-mono bg-gray-50 cursor-pointer mt-0.5">';
    } else {
      inner = '<button hx-post="/htmx/articles/' + id + '/share" hx-target="#share-btn-' + id + '" hx-swap="outerHTML"'
        + ' class="w-full text-left text-sm px-1 py-1 hover:bg-gray-50 rounded text-gray-700">Share article…</button>';
    }
    return '<div id="share-btn-' + id + '" data-rf-slot="share">' + inner + '</div>';
  }

  // ---- labels --------------------------------------------------------------------------

  function assignedLabels(rec, labels) {
    var ids = rec.label_ids || [];
    return labels.filter(function (l) { return ids.indexOf(l.id) >= 0; });
  }

  // The row's label trigger (article_row.html, inside #article-labels-{id}).
  // compact: the +N text without ml-0.5.
  function rowLabelButton(rec, labels, display, compact) {
    if (display === 'none') return '';
    var mine = assignedLabels(rec, labels);
    var empty = '<span class="inline-block w-[9px] h-[9px] rounded-full border border-gray-300 dark:border-gray-500"></span>';
    var inner;
    if (display === 'indicator' || !display) {
      inner = mine.length ? '<span class="inline-block w-[9px] h-[9px] rounded-full bg-gray-400"></span>' : empty;
    } else if (mine.length) {
      inner = mine.slice(0, 5).map(function (l) {
        return '<span class="inline-block w-[9px] h-[9px] rounded-full opacity-80" style="background-color: ' + esc(color(l.color)) + '"></span>';
      }).join('');
      if (mine.length > 5) inner += '<span class="text-[10px] text-gray-500 leading-none' + (compact ? '' : ' ml-0.5') + '">+' + (mine.length - 5) + '</span>';
    } else {
      inner = empty;
    }
    return '<button class="flex items-center gap-0.5 cursor-pointer bg-transparent border-0 p-0 leading-none' + (compact ? ' translate-y-px' : '') + '"'
      + ' data-stop-propagation data-label-trigger hx-get="/htmx/articles/' + rec.id + '/labels"'
      + ' hx-target="#label-picker" hx-swap="innerHTML"'
      + ' title="' + esc(mine.length ? mine.map(function (l) { return l.name; }).join(', ') : 'Labels') + '">' + inner + '</button>';
  }

  // The detail's label list (#detail-labels-{id}) inner HTML.
  function labelChips(rec, labels) {
    return assignedLabels(rec, labels).map(function (l) {
      return '<span class="flex items-center gap-1 text-xs text-gray-500">'
        + '<span class="inline-block w-2 h-2 rounded-full flex-shrink-0" style="background-color: ' + esc(color(l.color)) + '"></span>'
        + esc(l.name) + '</span>';
    }).join('');
  }

  // The detail's bottom-bar label dot (#detail-labels-btn-{id}) inner HTML.
  function detailLabelDot(rec, labels) {
    var any = assignedLabels(rec, labels).length > 0;
    return '<button class="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100" data-stop-propagation data-label-trigger'
      + ' hx-get="/htmx/articles/' + rec.id + '/labels" hx-target="#label-picker" hx-swap="innerHTML" title="Labels">'
      + (any ? '<span class="inline-block w-[9px] h-[9px] rounded-full bg-gray-400"></span>'
        : '<span class="inline-block w-[9px] h-[9px] rounded-full border border-gray-300"></span>') + '</button>';
  }

  // label_picker.html; opts.oob adds the out-of-band label areas the toggle route sends.
  function labelPicker(rec, labels, opts) {
    opts = opts || {};
    var id = rec.id;
    var ids = rec.label_ids || [];
    var out = '<div class="flex justify-end px-2 pt-1 pb-0.5">\n  <button data-close-picker class="text-gray-400 hover:text-gray-600 bg-transparent border-0 cursor-pointer p-0.5 leading-none" title="Close">\n'
      + '    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>\n  </button>\n</div>\n';
    if (labels.length) {
      labels.forEach(function (l) {
        out += '<button class="flex w-full items-center gap-2 px-3 py-1.5 hover:bg-gray-50 text-left text-sm" data-stop-propagation'
          + ' hx-post="/htmx/articles/' + id + '/labels/' + l.id + '/toggle" hx-target="#label-picker" hx-swap="innerHTML">'
          + '<span class="w-3 h-3 rounded-full flex-shrink-0" style="background-color: ' + esc(color(l.color)) + '"></span>'
          + '<span class="flex-1 truncate text-gray-700">' + esc(l.name) + '</span>'
          + (ids.indexOf(l.id) >= 0 ? '<svg class="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>' : '')
          + '</button>\n';
      });
    } else {
      out += '<p class="px-3 py-2 text-xs text-gray-400">No labels created yet.</p>\n';
    }
    if (opts.oob) {
      var mine = assignedLabels(rec, labels);
      out += '<div id="detail-labels-btn-' + id + '" hx-swap-oob="outerHTML" class="detail-labels-btn flex" data-rf-slot="labels">' + detailLabelDot(rec, labels) + '</div>\n';
      out += '<div id="detail-labels-' + id + '" hx-swap-oob="outerHTML" data-rf-slot="labels" class="detail-labels-area'
        + (mine.length ? ' flex flex-wrap items-center gap-x-3 gap-y-1 mt-4' : '') + '">' + labelChips(rec, labels) + '</div>\n';
      out += '<div id="article-labels-' + id + '" hx-swap-oob="outerHTML" data-rf-slot="labels" class="flex items-center">'
        + rowLabelButton(rec, labels, opts.labelDisplay || 'indicator', false) + '</div>\n';
    }
    return out;
  }

  // ---- AI blocks (ai_blocks.html) -----------------------------------------------------
  // The HTML comes from the server (md_render_ai, the ai_markdown filter) via the sync
  // record, already sanitised there.

  function aiSummary(id, html, truncated) {
    return '<div id="ai-summary-' + id + '" class="border-l-2 border-blue-400 dark:border-blue-500 pl-4 text-gray-700 dark:text-gray-300">\n'
      + '<div class="text-xs font-semibold text-blue-500 dark:text-blue-400 mb-1">AI summary'
      + (truncated ? ' <span class="font-normal text-gray-400 dark:text-gray-500" title="The model hit its length limit, so the summary may end mid-thought.">· truncated</span>' : '')
      + '</div>\n<div class="prose dark:prose-invert max-w-none ai-text">' + html + '</div>\n</div>';
  }

  function aiContext(id, html) {
    return '<div id="ai-context-' + id + '" class="border-l-2 border-amber-400 dark:border-amber-500 pl-4 text-gray-700 dark:text-gray-300">\n'
      + '<div class="text-xs font-semibold text-amber-500 dark:text-amber-400 mb-1">AI context</div>\n'
      + '<div class="prose dark:prose-invert max-w-none ai-text">' + html + '</div>\n</div>';
  }

  // Stands in for a summary/context the device queued: it arrives with the next sync.
  function aiRequested(id, kind) {
    var summary = kind === 'summary';
    return '<div id="ai-' + (summary ? 'summary' : 'context') + '-' + id + '" data-rf-requested class="border-l-2 '
      + (summary ? 'border-blue-400' : 'border-amber-400') + ' pl-4 text-sm text-gray-500 py-2">'
      + 'AI ' + (summary ? 'summary' : 'context') + ': Requested – arrives after sync</div>';
  }

  // ---- scores and stories --------------------------------------------------------------

  // score_badge.html over a record's effective score.
  function scoreBadge(rec) {
    var ai = rec.ai_score !== null && rec.ai_score !== undefined;
    var s = ai ? rec.ai_score : rec.lexical_score;
    if (s === null || s === undefined) return '';
    var cls = s >= 0.75 ? 'ai-score-high' : (s >= 0.4 ? 'ai-score-mid' : 'ai-score-low');
    var n = Math.round(s * 100);
    return '<span class="text-xs ' + cls + '" title="' + (ai ? 'Relevance: AI score' : 'Relevance: basic score (word match, weaker than the AI score)') + '">' + (ai ? n : '~' + n) + '</span>';
  }

  // The detail footer's scores (article_content.html): AI and basic, each when known.
  function detailScore(rec) {
    var out = '';
    [['AI', rec.ai_score, ''], ['', rec.lexical_score, '~']].forEach(function (s) {
      if (s[1] === null || s[1] === undefined) return;
      var cls = s[1] >= 0.75 ? 'ai-score-high' : (s[1] >= 0.4 ? 'ai-score-mid' : 'ai-score-low');
      out += '<span>' + (s[0] ? s[0] + ' ' : '') + '<span class="' + cls + '">' + s[2] + Math.round(s[1] * 100) + '</span></span>';
    });
    return out;
  }

  function storyWords(info) {
    var total = info.total || info.others;
    var w = (info.others && info.others !== total) ? info.others + ' of ' + total + ' other sources'
      : (total === 1 ? '1 other source' : total + ' other sources');
    if (info.read) w += ' · ' + info.read + ' read';
    return w;
  }

  // story_marker (compact rows).
  function storyMarker(info) {
    var total = info.total || info.others;
    if (!total) return '';
    var title = (total === 1 ? '1 other source covered this' : total + ' other sources covered this')
      + (info.others !== total ? ', ' + info.others + ' of them in this view' : '')
      + (info.read ? ', ' + info.read + ' of them read' : '');
    return '<span class="text-xs text-gray-500 flex-shrink-0 whitespace-nowrap" title="' + esc(title) + '"><span aria-hidden="true">⧉</span>'
      + (info.others !== total ? ' +' + info.others + '/' + total : ' +' + total)
      + (info.read ? ' · ' + info.read + ' read' : '') + '</span>';
  }

  // story_line (comfortable/summary rows); interactive where the view folded the group.
  function storyLine(id, info, interactive) {
    var total = info.total || info.others;
    if (!total) return '';
    var words = esc(storyWords(info));
    if (interactive && info.others) {
      return '<div class="mt-1 pl-[26px]"><button type="button" data-stop-propagation data-story-toggle="' + id + '" aria-expanded="false"'
        + ' class="story-chip inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs cursor-pointer transition-opacity">'
        + '<span aria-hidden="true">⧉</span><span>' + words + '</span><span data-story-caret aria-hidden="true">▾</span></button></div>';
    }
    return '<div class="mt-1 pl-[26px]"><span class="inline-flex items-center gap-1 text-xs text-gray-500"><span aria-hidden="true">⧉</span><span>' + words + '</span></span></div>';
  }

  // story_block.html: "Same story" at the foot of the detail.
  function storyBlock(id, count) {
    if (!count) return '';
    return '<div id="story-block-' + id + '" class="mt-5 scroll-mb-16"><div class="border-l-2 border-gray-300 dark:border-gray-600 pl-4">'
      + '<div class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">Same story</div>'
      + '<button id="story-toggle-' + id + '" class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"'
      + ' hx-get="/htmx/articles/' + id + '/related" hx-target="#story-members-' + id + '" hx-swap="innerHTML" hx-disabled-elt="this" hx-indicator="#story-spinner-' + id + '">'
      + '<span aria-hidden="true">⧉</span><span>' + (count === 1 ? '1 other source covered this' : count + ' other sources covered this') + '</span>'
      + '<svg id="story-spinner-' + id + '" class="htmx-indicator animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/></svg>'
      + '</button><div id="story-members-' + id + '"></div></div></div>';
  }

  // story_members.html. ctx: {feedTitle(rec), showScore, tz, profile, now}
  function storyMembers(members, ctx) {
    var items = members.map(function (m) {
      var src = ctx.feedTitle(m) || hostname(m.url);
      var score = ctx.showScore ? scoreBadge(m) : '';
      return '<li class="text-sm leading-snug py-2.5 first:pt-0 last:pb-0" data-story-member="' + m.id + '">'
        + '<div class="flex items-baseline gap-1"><span data-story-member-star class="flex-shrink-0 w-3.5 text-center text-gray-500 dark:text-gray-400"'
        + (m.is_starred ? ' title="Starred">★' : '>') + '</span>'
        + '<a href="#" data-open-story-member="' + m.id + '" class="min-w-0 hover:underline '
        + (m.is_read ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100 font-medium') + '">' + esc(m.title) + '</a></div>'
        + '<div class="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500 mt-0.5 pl-[18px]"><span class="truncate min-w-0">' + esc(src) + '</span>'
        + (score ? '<span class="flex-shrink-0" aria-hidden="true">·</span><span class="flex-shrink-0">' + score + '</span>' : '')
        + (m.published_at ? '<span class="flex-shrink-0" aria-hidden="true">·</span><time class="flex-shrink-0 whitespace-nowrap" datetime="' + esc(m.published_at) + '">'
          + esc(date(m.published_at, ctx.tz, ctx.profile, 'short', ctx.now)) + '</time>' : '')
        + '<span data-story-member-read class="flex-shrink-0 hidden inline-flex items-center gap-1.5"><span aria-hidden="true">·</span><span>read</span></span>'
        + (m.url ? '<a href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer" class="flex-shrink-0 hover:text-gray-600 dark:hover:text-gray-300" title="Open at the source">↗</a>' : '')
        + '</div></li>';
    }).join('');
    return '<ul class="mt-3 divide-y divide-[#ecedf1] dark:divide-[#353535]">' + items + '</ul>';
  }

  // ---- lists (article_list.html, article_list_append.html) ---------------------------

  function sentinel(moreQs) {
    return '<div id="load-more-sentinel" hx-get="/htmx/articles/more?' + esc(moreQs) + '" hx-trigger="intersect once" hx-swap="outerHTML"></div>';
  }

  // The JSON island app.js reads after a list swap. A data block, not a script: CSP
  // does not apply to it and htmx does not run it, so it needs no nonce.
  function listCfg(cfg) {
    return '<script type="application/json" id="article-list-cfg">' + json(cfg) + '</script>';
  }

  // JSON safe inside <script>: no "<" can close it.
  function json(v) {
    return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  // The state the page-side overlay applies (overlay.js) before htmx swaps the fragment in.
  function stateIsland(state) {
    return '<script type="application/json" data-rf-state>' + json(state) + '</script>';
  }

  var BOOKMARK = '<svg class="w-3.5 h-3.5 flex-shrink-0 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>';
  var MAGNIFIER = '<svg class="w-3.5 h-3.5 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/></svg>';

  // The list header. Saved: the save-URL form (it works offline: the URL is queued).
  // Saved search: its name and count. Search: a short header that says it searched this
  // device. Others: none.
  function listHeader(ctx) {
    if (ctx.savedView) {
      return '<div data-list-header class="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border-b border-blue-100 text-sm sticky top-0 z-10 dark:bg-blue-950/40 dark:border-blue-900">'
        + BOOKMARK
        + '<form id="save-url-form" class="flex items-center gap-2 flex-1 min-w-0" hx-post="/htmx/articles/save-url" hx-target="#article-list" hx-swap="innerHTML" hx-indicator="#save-url-spinner" hx-disabled-elt="find button, find input">'
        + '<input type="url" name="url" required placeholder="Paste an article URL to save…" class="flex-1 min-w-0 h-6 text-sm px-2 rounded border border-blue-200 bg-white text-gray-800 placeholder-gray-400 focus:outline-none focus:border-blue-400 dark:bg-gray-800 dark:border-blue-900 dark:text-gray-200">'
        + '<button type="submit" class="flex-shrink-0 h-6 px-3 text-sm leading-none rounded bg-blue-600 hover:bg-blue-700 text-white border-0 cursor-pointer disabled:opacity-50">Save</button>'
        + '<svg id="save-url-spinner" class="htmx-indicator animate-spin h-4 w-4 flex-shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"/></svg>'
        + '</form></div>';
    }
    if (ctx.savedSearch) {
      var s = ctx.savedSearch;
      return '<div data-list-header data-search-header data-saved-search-id="' + s.id + '" data-saved-search-name="' + esc(s.name) + '"'
        + ' class="flex items-center gap-2 px-4 py-2.5 saved-search-header bg-gray-50 border-b border-gray-200 text-sm leading-6 sticky top-0 z-10">'
        + MAGNIFIER + '<span class="font-medium text-gray-800 truncate min-w-0 dark:text-gray-100" title="' + esc(s.name) + '">' + esc(s.name) + '</span>'
        + (ctx.resultCount !== null && ctx.resultCount !== undefined
          ? '<span class="text-gray-400 flex-shrink-0" aria-hidden="true">·</span><span class="text-gray-500 whitespace-nowrap flex-shrink-0">'
            + (ctx.viewUnread ? '<span data-view-unread-count>' + num(ctx.resultCount, ctx.profile) + '</span> unread'
              : num(ctx.resultCount, ctx.profile) + ' ' + (ctx.resultCount === 1 ? 'article' : 'articles')) + '</span>'
          : '')
        + '</div>';
    }
    if (ctx.search) {
      var words = ctx.resultCount === 1 ? 'result' : 'results';
      return '<div data-list-header data-search-header' + (ctx.query ? ' data-search-query="' + esc(ctx.query) + '"' : '')
        + ' class="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2.5 bg-blue-50 border-b border-blue-100 text-sm leading-6 sticky top-0 z-10">'
        + '<span class="text-gray-500 whitespace-nowrap flex-shrink-0">' + num(ctx.resultCount || 0, ctx.profile) + ' ' + words
        + (ctx.query ? ' for' : '') + '</span>'
        + (ctx.query ? '<strong class="text-gray-800 truncate min-w-0" title="' + esc(ctx.query) + '">' + esc(ctx.query) + '</strong>' : '')
        + '<span class="text-gray-400 flex-shrink-0" aria-hidden="true">·</span><span class="text-gray-500 whitespace-nowrap">Searching articles on this device</span>'
        + '<button data-action="refresh-articles" class="ml-auto text-gray-400 hover:text-gray-600 bg-transparent border-0 cursor-pointer p-0.5" title="Clear search">'
        + '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button></div>';
    }
    return '';
  }

  // A row for a URL saved offline: shown in Saved until a sync brings the article.
  function pendingSavedRow(op) {
    var url = (op.value && op.value.url) || '';
    return '<div class="border-b border-gray-100 pl-2 pr-4 pt-1.5 pb-2.5 opacity-75" data-rf-pending-save="' + esc(op.op_id) + '">'
      + '<div class="flex items-baseline gap-1"><span class="flex-shrink-0 w-5 text-center text-xs text-gray-400" aria-hidden="true">⏳</span>'
      + '<span class="min-w-0 break-words text-sm leading-snug text-gray-700">' + esc(url) + '</span></div>'
      + '<div class="text-xs text-gray-500 mt-1 pl-[26px]">Saved on this device – fetched after sync</div></div>';
  }

  // article_list.html: header, rows, sentinel, end spacer or empty state, cfg island.
  // ctx: {header, rows (html[]), hasMore, moreQs, empty ('saved'|'saved_search'|'search'|'plain'),
  //       savedSearch, viewFiltered, viewUnread, cfg}
  function listPage(ctx) {
    var out = ctx.header || '';
    if (ctx.rows.length) {
      out += ctx.rows.join('\n');
      if (ctx.hasMore) out += sentinel(ctx.moreQs);
      out += '<div aria-hidden="true" class="article-list-end-spacer"></div>';
    } else if (ctx.empty === 'saved') {
      out += '<div class="flex items-center justify-center h-48 text-gray-400 text-sm px-8 text-center">No saved articles on this device.</div>';
    } else if (ctx.empty === 'saved_search') {
      out += '<div class="flex flex-col items-center justify-center gap-2 h-48 text-gray-400 text-sm px-8 text-center"><p>'
        + (ctx.viewFiltered ? 'Nothing ' + (ctx.viewUnread ? 'unread' : 'with this status') + ' here.' : 'Nothing matches this search on this device.') + '</p>'
        + (ctx.viewFiltered && ctx.savedSearch ? '<button hx-get="/htmx/articles?saved_search_id=' + ctx.savedSearch.id + '&amp;show_read=true" hx-target="#article-list" hx-swap="innerHTML" class="text-blue-600 hover:underline bg-transparent border-0 cursor-pointer p-0 text-sm">Show read too</button>' : '')
        + '</div>';
    } else {
      out += '<div class="flex items-center justify-center h-48 text-gray-400 text-sm">'
        + (ctx.empty === 'search' ? 'No results on this device.' : 'No articles on this device.') + '</div>';
    }
    return out + '\n' + listCfg(ctx.cfg);
  }

  // ---- sidebar (sidebar.html) ----------------------------------------------------------

  var CHEVRON = '<svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7"/></svg>';
  var SEARCH_SVG = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/></svg>';
  var MARK_BTN = 'absolute right-1 top-1/2 -translate-y-1/2 opacity-0 flex items-center justify-center w-5 h-5 text-xs text-blue-600 bg-white hover:bg-blue-50 rounded cursor-pointer border border-blue-200';
  var RAIL_ITEM = 'nav-item w-8 h-8 flex items-center justify-center rounded text-gray-500 hover:bg-gray-100 cursor-pointer relative';
  var NAV = 'hx-target="#article-list" hx-swap="innerHTML" hx-push-url="false"';

  function railCount(n, total) {
    if (!(n > 0)) return '';
    return '<span class="absolute top-0 right-0 text-[9px] font-semibold ' + (total ? 'text-gray-400' : 'text-blue-500') + ' leading-none">' + (n < 100 ? n : '99+') + '</span>';
  }

  function markReadButton(post, vals) {
    return '<button class="' + MARK_BTN + '" title="Mark all as read" hx-post="' + post + '"' + (vals === null ? '' : " hx-vals='" + vals + "'")
      + ' hx-swap="none" data-action="mark-read">✓</button>';
  }

  function navRow(href, label, badgeHtml, post, vals, extraA) {
    return '<div class="group relative mark-read-row"><a class="nav-item flex items-center pl-3.5 pr-3 py-1.5 rounded text-sm font-bold text-gray-700 hover:bg-gray-100 cursor-pointer"'
      + ' hx-get="' + href + '" ' + NAV + (extraA || '') + '><span class="flex-1">' + label + '</span>' + badgeHtml + '</a>'
      + markReadButton(post, vals) + '</div>';
  }

  // Feeds grouped by folder in the server's default folder order (folder name, then
  // "No folder" last; feeds by title within).
  function groupFeeds(lists) {
    var folders = new Map(lists.folders.map(function (f) { return [f.id, f]; }));
    var feeds = lists.feeds.slice().sort(function (a, b) {
      var fa = a.folder_id === null || a.folder_id === undefined ? null : folders.get(a.folder_id);
      var fb = b.folder_id === null || b.folder_id === undefined ? null : folders.get(b.folder_id);
      var na = fa ? String(fa.name).toLowerCase() : null;
      var nb = fb ? String(fb.name).toLowerCase() : null;
      if (na !== nb) {
        if (na === null) return 1;
        if (nb === null) return -1;
        return na < nb ? -1 : 1;
      }
      if ((a.folder_id || 0) !== (b.folder_id || 0)) return (a.folder_id || 0) - (b.folder_id || 0);
      var ta = String(a.title || '').toLowerCase(), tb = String(b.title || '').toLowerCase();
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });
    var groups = [];
    feeds.forEach(function (f) {
      var fid = f.folder_id === undefined ? null : f.folder_id;
      var last = groups[groups.length - 1];
      if (!last || last.folderId !== fid) {
        groups.push({ folderId: fid, folder: fid === null ? null : (folders.get(fid) || { id: fid, name: 'Folder' }), feeds: [] });
      }
      groups[groups.length - 1].feeds.push(f);
    });
    return groups;
  }

  function byName(a, b) {
    var x = String(a.name || '').toLowerCase(), y = String(b.name || '').toLowerCase();
    return x < y ? -1 : (x > y ? 1 : 0);
  }

  // counts: RFOffline.lists.counts(); lists: the synced lists; opts: {displayName,
  // profile, autoAdvance}. Online-only parts (catch-me-up, chat, feed refresh, settings)
  // are drawn disabled with data-rf-online-only, or left out.
  function sidebar(counts, lists, opts) {
    opts = opts || {};
    var prof = opts.profile;
    var labels = lists.labels.slice().sort(function (a, b) { return ((a.position || 0) - (b.position || 0)) || byName(a, b); });
    var saved = lists.saved_searches.slice().sort(byName);
    var groups = groupFeeds(lists);
    var initial = esc(String(opts.displayName || '?').charAt(0).toUpperCase());

    var rail = '<div id="sidebar-rail" class="flex flex-col items-center py-2 gap-1 h-full">'
      + '<button data-action="toggle-sidebar-pin" class="w-8 h-8 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 cursor-pointer bg-transparent border-0 mb-2" title="Expand sidebar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg></button>'
      + '<button data-action="open-search" class="w-8 h-8 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 cursor-pointer bg-transparent border-0" title="Search &amp; filter">' + SEARCH_SVG + '</button>'
      + '<a class="' + RAIL_ITEM + ' text-sm font-medium" hx-get="/htmx/articles" ' + NAV + ' title="All articles">A' + railCount(counts.all.unread) + '</a>'
      + '<a class="' + RAIL_ITEM + ' text-base" hx-get="/htmx/articles?starred_only=true" ' + NAV + ' title="Starred">★' + railCount(counts.starred.total, true) + '</a>'
      + '<a class="' + RAIL_ITEM + ' text-sm font-medium" hx-get="/htmx/articles?archived_only=true" ' + NAV + ' title="Archived">Ar' + railCount(counts.archived.total, true) + '</a>'
      + '<a class="' + RAIL_ITEM + ' text-sm font-medium" hx-get="/htmx/articles?saved_only=true" ' + NAV + ' title="Saved">Sa' + railCount(counts.saved.total, true) + '</a>'
      + '<a class="' + RAIL_ITEM + ' text-sm font-medium" hx-get="/htmx/articles?labeled_only=true" ' + NAV + ' title="Labels">L' + railCount(counts.labeled.unread) + '</a>';
    if (saved.length) {
      rail += '<div class="w-6 border-t border-gray-200 my-1"></div>' + saved.map(function (s) {
        return '<a class="' + RAIL_ITEM + ' text-xs font-medium" hx-get="/htmx/articles?saved_search_id=' + s.id + '" ' + NAV + ' title="' + esc(s.name) + '">' + esc(String(s.name).slice(0, 2)) + '</a>';
      }).join('');
    }
    if (groups.length) {
      rail += '<div class="w-6 border-t border-gray-200 my-1"></div>' + groups.map(function (g) {
        if (g.folder) {
          return '<a class="' + RAIL_ITEM + ' text-xs font-medium" hx-get="/htmx/articles?folder_id=' + g.folderId + '" ' + NAV + ' title="' + esc(g.folder.name) + '">'
            + esc(String(g.folder.name).slice(0, 2)) + railCount((counts.folders[g.folderId] || {}).unread) + '</a>';
        }
        return '<a class="' + RAIL_ITEM + ' text-sm" hx-get="/htmx/articles?folder_id=0" ' + NAV + ' title="No folder">–' + railCount(counts.noFolder.unread) + '</a>';
      }).join('');
    }
    rail += '</div>';

    var full = '<div id="sidebar-full" class="flex flex-col h-full"' + (opts.autoAdvance ? ' data-auto-advance="1"' : '') + '>'
      + '<div class="flex items-center justify-between px-4 py-2.5 border-b border-gray-200"><div class="flex items-center gap-2">'
      + '<div class="relative" id="full-menu-container"><button data-action="toggle-user-menu" class="relative w-6 h-6 rounded-full bg-blue-200 flex items-center justify-center text-blue-700 text-[10px] font-semibold cursor-pointer border-0 hover:bg-blue-300 flex-shrink-0" title="' + esc(opts.displayName || '') + '">' + initial + '</button>'
      + '<div id="full-menu-dropdown" class="hidden absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 w-44">'
      + '<a href="/settings" data-rf-online-only class="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">Settings</a>'
      + '<a href="/help" data-rf-online-only class="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100">Help</a>'
      + '<hr class="my-1 border-gray-100"><form method="POST" action="/logout" data-rf-logout><button type="submit" class="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left cursor-pointer bg-transparent border-0">Logout</button></form>'
      + '</div></div>'
      + '<button data-action="open-search" class="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 cursor-pointer bg-transparent border-0 ml-1" title="Search &amp; filter">' + SEARCH_SVG + '</button>'
      + '</div><button data-action="toggle-sidebar-pin" class="text-gray-400 hover:text-gray-600 bg-transparent border-0 p-0 cursor-pointer" title="Collapse sidebar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg></button></div>'
      + '<nav class="px-2 py-3 space-y-1 border-b border-gray-200">'
      + navRow('/htmx/articles', 'All articles', badge(counts.all, prof), '/htmx/articles/mark-read', '{}')
      + navRow('/htmx/articles?starred_only=true', 'Starred', badge(counts.starred, prof), '/htmx/articles/mark-read', '{"starred_only": "1"}')
      + navRow('/htmx/articles?archived_only=true', 'Archived', badge(counts.archived, prof), '/htmx/articles/mark-read', '{"archived_only": "1"}')
      + navRow('/htmx/articles?saved_only=true', 'Saved', badge(counts.saved, prof), '/htmx/articles/mark-read', '{"saved_only": "1"}')
      + '</nav><div id="sidebar-scroll" class="flex-1 overflow-y-auto">';

    if (saved.length) {
      full += '<div class="px-2 py-3 space-y-1 border-b border-gray-200">' + saved.map(function (s) {
        var c = counts.savedSearches[s.id];
        return '<div class="group relative mark-read-row"><a class="nav-item flex items-center pl-3.5 pr-3 py-1.5 rounded text-sm font-bold text-gray-700 hover:bg-gray-100 cursor-pointer"'
          + ' hx-get="/htmx/articles?saved_search_id=' + s.id + '" hx-target="#article-list" hx-swap="innerHTML" data-nav-title="' + esc(s.name) + '" hx-push-url="false">'
          + '<span class="truncate">' + esc(s.name) + '</span><svg class="w-2.5 h-2.5 flex-shrink-0 ml-1.5 mt-0.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/></svg>'
          + '<span id="saved-count-' + s.id + '" class="ml-auto" data-saved-count>' + (c ? badge(c, prof) : '') + '</span></a>'
          + markReadButton('/htmx/saved-searches/' + s.id + '/mark-read', null) + '</div>';
      }).join('') + '</div>';
    }

    if (labels.length) {
      full += '<div class="px-2 py-3 border-b border-gray-200"><div class="group relative mark-read-row">'
        + '<a class="nav-item flex items-center pl-px pr-3 py-1.5 rounded text-sm font-bold text-gray-700 hover:bg-gray-100 cursor-pointer" hx-get="/htmx/articles?labeled_only=true" ' + NAV + '>'
        + '<span class="collapse-toggle flex-shrink-0 p-1 -ml-1 text-gray-400" data-collapse="labels">' + CHEVRON + '</span><span class="flex-1">Labels</span>'
        + '<span id="label-badge-all">' + badge(counts.labeled, prof) + '</span></a>'
        + markReadButton('/htmx/articles/mark-read', '{"labeled_only": "1"}') + '</div><div class="collapsible" id="collapse-labels">'
        + labels.map(function (l) {
          return '<div class="group relative mark-read-row"><a class="nav-item flex items-center pl-6 pr-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 cursor-pointer" hx-get="/htmx/articles?label_id=' + l.id + '" ' + NAV + '>'
            + '<span class="w-2 h-2 rounded-full flex-shrink-0 mr-2" style="background-color: ' + esc(color(l.color)) + '"></span><span class="flex-1 truncate">' + esc(l.name) + '</span>'
            + '<span id="label-badge-' + l.id + '">' + badge(counts.labels[l.id] || { unread: 0, total: 0 }, prof) + '</span></a>'
            + markReadButton('/htmx/articles/mark-read', '{"label_id": "' + l.id + '"}') + '</div>';
        }).join('') + '</div></div>';
    }

    full += '<div class="px-2 py-3">';
    if (!groups.length) full += '<p class="px-3 py-2 text-sm text-gray-400">No feeds yet.</p>';
    groups.forEach(function (g) {
      var key = g.folder ? g.folderId : 0;
      var c = g.folder ? (counts.folders[g.folderId] || { unread: 0, total: 0 }) : counts.noFolder;
      full += '<div class="group relative mark-read-row mt-1"><a class="nav-item flex items-center pl-px pr-3 py-1.5 rounded text-sm font-bold text-gray-700 hover:bg-gray-100 cursor-pointer"'
        + ' hx-get="/htmx/articles?folder_id=' + key + '" ' + NAV + '><span class="collapse-toggle flex-shrink-0 p-1 -ml-1 text-gray-400" data-collapse="folder-' + key + '">' + CHEVRON + '</span>'
        + (g.folder ? '<span class="flex-1 truncate">' + esc(g.folder.name) + '</span>' : '<span class="flex-1">No folder</span>')
        + badge(c, prof) + '</a>' + markReadButton('/htmx/folders/' + key + '/mark-read', '{}') + '</div>'
        + '<div class="collapsible" id="collapse-folder-' + key + '">';
      g.feeds.forEach(function (fe) {
        full += '<div class="group relative mark-read-row feed-nav-row"><a class="nav-item flex items-center pl-6 pr-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 cursor-pointer"'
          + ' hx-get="/htmx/articles?feed_id=' + fe.feed_id + '" ' + NAV + '><span id="feed-error-' + fe.feed_id + '"></span>'
          + '<span class="flex-1 truncate">' + esc(fe.title) + '</span><span id="feed-badge-' + fe.feed_id + '">' + badge(counts.feeds[fe.feed_id] || { unread: 0, total: 0 }, prof) + '</span></a>'
          + markReadButton('/htmx/feeds/' + fe.feed_id + '/mark-read', '{}') + '</div>';
      });
      full += '</div>';
    });
    full += '</div></div></div>';
    return rail + full + SIDEBAR_STYLE;
  }

  // The <style> block of sidebar.html, verbatim in substance.
  var SIDEBAR_STYLE = '<style>'
    + '.nav-item.active{background-color:#eff6ff;color:#1d4ed8}'
    + '.collapsible{overflow:hidden;max-height:2000px;transition:max-height 200ms ease-out}'
    + '.collapsible.collapsed{max-height:0;transition:max-height 200ms ease-in}'
    + '.collapse-toggle svg{transition:transform 200ms}.collapse-toggle.is-collapsed svg{transform:rotate(-90deg)}'
    + '.mark-read-row>a{padding-right:.25rem}.mark-read-row{touch-action:manipulation}'
    + '.mark-read-row.touch-active [data-action="mark-read"]{opacity:1}'
    + '.mark-read-row.touch-active .mark-read-badge{transform:translateX(-1.5rem)}'
    + '[data-action="mark-read"].htmx-request{opacity:1!important;transition:none!important;animation:spin-check .7s linear infinite}'
    + '@keyframes spin-check{to{transform:translateY(-50%) rotate(360deg)}}'
    + '.mark-read-row:has([data-action="mark-read"].htmx-request) .mark-read-badge{transform:translateX(-1.5rem)!important;transition:none!important}'
    + '@media (any-hover:hover){.mark-read-row [data-action="mark-read"]{transition:opacity 150ms 0ms}'
    + '.mark-read-row:hover [data-action="mark-read"],.mark-read-row:focus-within [data-action="mark-read"]{opacity:1;transition:opacity 150ms 1200ms}'
    + '.mark-read-row .mark-read-badge{transition:transform 150ms 0ms}'
    + '.mark-read-row:hover .mark-read-badge,.mark-read-row:focus-within .mark-read-badge{transform:translateX(-1.5rem);transition:transform 150ms 1200ms}}'
    + '@media (any-hover:hover) and (pointer:coarse){.mark-read-row:hover [data-action="mark-read"],.mark-read-row:focus-within [data-action="mark-read"]{transition-delay:600ms}'
    + '.mark-read-row:hover .mark-read-badge,.mark-read-row:focus-within .mark-read-badge{transition-delay:600ms}}'
    + '.mark-read-row:not(:has(.mark-read-badge.rounded-full)) [data-action="mark-read"]{display:none}'
    + '.mark-read-row:not(:has(.mark-read-badge.rounded-full)) .mark-read-badge{transform:none}'
    + '</style>';

  // ---- stand-ins -----------------------------------------------------------------------

  // What every /htmx/ route without an offline answer gets: 200, so htmx swaps it into
  // whatever the caller targeted, saying why nothing happened.
  function needsConnection(feature) {
    return '<div data-rf-needs-connection class="flex items-center gap-2 px-3 py-2 text-sm text-gray-500">'
      + '<span aria-hidden="true">⚡</span><span>' + esc(feature ? feature + ': needs a connection' : 'Needs a connection') + '</span></div>';
  }

  // report: {pending, lastSync (ISO|null)}
  function offlineBanner(report) {
    report = report || {};
    var p = report.pending || 0;
    return '<div data-rf-offline-banner class="px-4 py-1.5 text-xs text-gray-600 bg-amber-50 border-b border-amber-100 dark:bg-amber-950/40 dark:text-gray-300 dark:border-amber-900" role="status">'
      + 'Offline' + (p ? ' · ' + p + ' ' + (p === 1 ? 'action' : 'actions') + ' waiting' : '') + '</div>';
  }

  // A navigation that only the server can answer, while offline. No scripts, no
  // external resources: it has to render with nothing but itself.
  function offlinePage() {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Offline – Readfine</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#141414;color:#e5e5e5}'
      + 'main{max-width:28rem;padding:2rem;text-align:center}a{color:#93c5fd}</style></head><body><main><h1 style="font-size:1.25rem">Needs a connection</h1>'
      + '<p>This page is not available offline. Your articles stored on this device are in the <a href="/app">reader</a>.</p></main></body></html>';
  }

  RF.templates = {
    esc: esc,
    json: json,
    num: num,
    date: date,
    hostname: hostname,
    badgeUnread: badgeUnread,
    badgeTotal: badgeTotal,
    readButton: readButton,
    starButton: starButton,
    archiveButton: archiveButton,
    shareButton: shareButton,
    rowLabelButton: rowLabelButton,
    labelChips: labelChips,
    detailLabelDot: detailLabelDot,
    labelPicker: labelPicker,
    aiSummary: aiSummary,
    aiContext: aiContext,
    aiRequested: aiRequested,
    scoreBadge: scoreBadge,
    detailScore: detailScore,
    storyMarker: storyMarker,
    storyLine: storyLine,
    storyBlock: storyBlock,
    storyMembers: storyMembers,
    sentinel: sentinel,
    listCfg: listCfg,
    stateIsland: stateIsland,
    listHeader: listHeader,
    listPage: listPage,
    pendingSavedRow: pendingSavedRow,
    sidebar: sidebar,
    needsConnection: needsConnection,
    offlineBanner: offlineBanner,
    offlinePage: offlinePage,
  };
})(self);
