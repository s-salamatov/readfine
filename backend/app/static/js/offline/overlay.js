// Page-side overlay for offline fragments.
//
// Why on the page: the service worker has no DOM, and the fragments it answers with are
// server-rendered snapshots in a neutral state (unread, unstarred, no labels, no AI
// text). Filling their slots needs real HTML parsing, so the worker sends the snapshot
// HTML plus one data island,
//   <script type="application/json" data-rf-state>{...}</script>
// and this script applies it before htmx swaps the fragment in (htmx:beforeSwap, by
// rewriting detail.serverResponse). The DOM app.js sees after the swap is already the
// right one, so its afterSwap/settle handlers (data-is-read, the list config) read
// final values. A data island is not executed (CSP does not apply to it, htmx does not
// evaluate non-JS script types), and it is removed before the swap.
//
// Without this script loaded the offline fragments still render, in their neutral
// state. Task 11 loads offline/*.js before app.js; loading this file installs the hook.
//
// Hooks applied (contract: task-7-report.md, "Hook contract"):
//   data-rf-article, data-rf-slot (star-button, archive-button, read-button, saved-icon,
//   labels, score-badge, related-count, ai-summary, ai-context, ai-summary-action,
//   ai-context-action, share), data-rf-read-classes / data-rf-unread-classes,
//   data-rf-time, data-rf-placeholder="ai", data-rf-online-only.
(function (root) {
  'use strict';
  var RF = root.RFOffline = root.RFOffline || {};
  function T() { return RF.templates; }

  var READ_SVG = '<svg class="w-4 h-4 shrink-0 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 10.07V19a2 2 0 01-2 2H5a2 2 0 01-2-2v-8.93M21 10.07A2 2 0 0020.11 8.4l-7-4.667a2 2 0 00-2.22 0L3.9 8.4A2 2 0 003 10.07M21 10.07l-7.44 4.96a2 2 0 01-2.12 0L3 10.07"/></svg>';
  var UNREAD_SVG = '<svg class="w-4 h-4 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>';

  function classes(v) { return String(v || '').split(/\s+/).filter(Boolean); }

  // The element itself and its descendants matching sel.
  function within(el, sel) {
    var out = el.matches && el.matches(sel) ? [el] : [];
    return out.concat(Array.prototype.slice.call(el.querySelectorAll(sel)));
  }

  function toggle(el, cls, on) {
    if (on) el.classList.add(cls); else el.classList.remove(cls);
  }

  function setLabel(el, text) {
    var l = el.querySelector('[data-label]');
    if (l) l.textContent = text;
  }

  // Replaces the last non-empty text node of el (keeps an icon in front of it).
  function setTrailingText(el, text) {
    for (var n = el.lastChild; n; n = n.previousSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = ' ' + text + ' '; return; }
    }
    el.appendChild(el.ownerDocument.createTextNode(text));
  }

  function readClasses(rootEl, isRead) {
    within(rootEl, '[data-rf-read-classes],[data-rf-unread-classes]').forEach(function (el) {
      var on = classes(el.getAttribute(isRead ? 'data-rf-read-classes' : 'data-rf-unread-classes'));
      var off = classes(el.getAttribute(isRead ? 'data-rf-unread-classes' : 'data-rf-read-classes'));
      off.forEach(function (c) { if (on.indexOf(c) < 0) el.classList.remove(c); });
      on.forEach(function (c) { el.classList.add(c); });
    });
    within(rootEl, '[data-is-read]').forEach(function (el) { el.setAttribute('data-is-read', isRead ? 'true' : 'false'); });
  }

  function star(el, rec) {
    var s = !!rec.is_starred;
    if (el.hasAttribute('data-star-btn')) {
      var size = el.querySelector('.text-base') ? 'text-base' : 'text-lg';
      el.setAttribute('title', s ? 'Remove star' : 'Star article');
      el.innerHTML = s
        ? '<span data-rf-read-classes="text-gray-700" data-rf-unread-classes="text-gray-900" class="' + size + ' ' + (rec.is_read ? 'text-gray-700' : 'text-gray-900') + '">★</span>'
        : '<span class="' + size + ' text-gray-300 hover:text-gray-500">☆</span>';
    } else if (el.hasAttribute('data-header-star')) {
      var svg = el.querySelector('svg');
      if (svg) svg.setAttribute('fill', s ? 'currentColor' : 'none');
      setLabel(el, s ? 'Starred' : 'Star');
    } else if (el.hasAttribute('data-bottom-star')) {
      el.setAttribute('title', s ? 'Remove star' : 'Star');
      el.innerHTML = '<span class="text-[16px] leading-none ' + (s ? 'text-gray-600' : 'text-gray-300') + '" style="margin-top:-2px">' + (s ? '★' : '☆') + '</span>';
    } else {
      el.innerHTML = T().starButton(rec);
    }
  }

  function archive(el, rec) {
    var a = !!rec.is_archived;
    if (el.hasAttribute('data-archived-indicator')) {
      toggle(el, 'hidden', !a);
    } else if (el.hasAttribute('data-header-archive')) {
      var svg = el.querySelector('svg');
      if (svg) { toggle(svg, 'text-gray-700', a); toggle(svg, 'text-gray-400', !a); }
      setLabel(el, a ? 'Archived' : 'Archive');
    } else if (el.hasAttribute('data-bottom-archive')) {
      el.setAttribute('title', a ? 'Unarchive' : 'Archive');
      var s2 = el.querySelector('svg');
      if (s2) {
        ['text-gray-700', 'dark:text-gray-200', 'text-gray-400', 'dark:text-gray-500'].forEach(function (c) { s2.classList.remove(c); });
        (a ? ['text-gray-700', 'dark:text-gray-200'] : ['text-gray-400', 'dark:text-gray-500']).forEach(function (c) { s2.classList.add(c); });
      }
    } else {
      el.innerHTML = T().archiveButton(rec);
    }
  }

  function readButton(el, rec) {
    var r = !!rec.is_read;
    if (el.hasAttribute('data-header-read')) {
      var svg = el.querySelector('svg');
      if (svg) svg.outerHTML = r ? READ_SVG : UNREAD_SVG;
      setLabel(el, r ? 'Mark as unread' : 'Mark as read');
    } else {
      el.innerHTML = T().readButton(rec);
    }
  }

  function labels(el, rec, ctx) {
    var labelsList = ctx.labels || [];
    var id = el.getAttribute('id') || '';
    if (id.indexOf('article-labels-') === 0) {
      var row = el.closest('[data-density]');
      var compact = !!row && row.getAttribute('data-density') === 'compact';
      el.innerHTML = T().rowLabelButton(rec, labelsList, (ctx.prefs || {}).label_display || 'indicator', compact);
    } else if (id.indexOf('detail-labels-btn-') === 0) {
      el.innerHTML = T().detailLabelDot(rec, labelsList);
    } else if (id.indexOf('detail-labels-') === 0) {
      el.innerHTML = T().labelChips(rec, labelsList);
      var any = (rec.label_ids || []).some(function (lid) { return labelsList.some(function (l) { return l.id === lid; }); });
      ['flex', 'flex-wrap', 'items-center', 'gap-x-3', 'gap-y-1', 'mt-4'].forEach(function (c) { toggle(el, c, any); });
    }
  }

  function scoreBadge(el, rec, ctx) {
    if (el.closest('.article-row')) {
      el.innerHTML = (ctx.prefs || {}).ai_score_show_in_list ? T().scoreBadge(rec) : '';
    } else {
      el.innerHTML = T().detailScore(rec);
    }
  }

  function related(el, rec, ctx) {
    if (ctx.storyChild) { el.remove(); return; }
    if (el.closest('.article-row')) {
      var info = (ctx.stories || {})[rec.id];
      if (!info) { el.innerHTML = ''; return; }
      el.innerHTML = el.tagName === 'SPAN' ? T().storyMarker(info) : T().storyLine(rec.id, info, !!ctx.interactive);
    } else {
      el.innerHTML = T().storyBlock(rec.id, (ctx.related || {})[rec.id] || 0);
    }
  }

  function ai(rootEl, rec, ctx) {
    var req = (ctx.requested || {})[rec.id] || {};
    var section = rootEl.querySelector('[data-rf-placeholder="ai"]');
    var shown = false;
    var summarySlot = rootEl.querySelector('[data-rf-slot="ai-summary"]');
    if (summarySlot && rec.ai_summary_html) {
      summarySlot.innerHTML = T().aiSummary(rec.id, rec.ai_summary_html, !!rec.ai_summary_truncated);
      shown = true;
    } else if (summarySlot && req.summary) {
      summarySlot.innerHTML = T().aiRequested(rec.id, 'summary');
      shown = true;
    }
    if (rec.ai_summary_html || req.summary) {
      within(rootEl, '[data-rf-slot="ai-summary-action"]').forEach(function (b) { b.classList.add('hidden'); });
    }
    var ctxEl = rootEl.querySelector('#ai-context-' + rec.id);
    if (ctxEl && rec.ai_context_html) {
      ctxEl.outerHTML = T().aiContext(rec.id, rec.ai_context_html);
      shown = true;
    } else if (ctxEl && req.context) {
      ctxEl.outerHTML = T().aiRequested(rec.id, 'context');
      shown = true;
    }
    if (rec.ai_context_html) {
      within(rootEl, '[data-rf-slot="ai-context-action"]').forEach(function (b) {
        setTrailingText(b, b.hasAttribute('data-show-context-panel') ? 'Regenerate context' : 'Regenerate');
      });
    }
    if (section && shown) section.classList.remove('hidden');
  }

  function share(el, rec, ctx) {
    var pending = !!(ctx.sharePending || {})[rec.id];
    var holder = el.ownerDocument.createElement('div');
    holder.innerHTML = T().shareButton(rec.id, rec.share_token, ctx.origin || '', pending);
    var fresh = holder.firstElementChild;
    if (fresh) el.replaceWith(fresh);
  }

  function times(rootEl, ctx) {
    var prefs = ctx.prefs || {};
    within(rootEl, '[data-rf-time]').forEach(function (el) {
      var kind = el.closest('.detail-meta-date') ? 'long' : 'short';
      var text = T().date(el.getAttribute('data-rf-time'), prefs.timezone || 'UTC', prefs.format_profile, kind, ctx.now);
      if (!text) return;
      var inner = el.tagName === 'TIME' ? null : el.querySelector('time');
      if (!inner) el.textContent = text;
    });
  }

  // Buttons get `disabled`; links cannot be disabled, so they get aria-disabled,
  // pointer-events-none and the click guard install() sets up. What the element had
  // before is kept in data-rf-offline-off, so restoreOnlineOnly gives exactly that back
  // once the connection returns (page.js); an element already marked is left alone.
  var OFF = 'data-rf-offline-off';

  function onlineOnly(rootEl) {
    within(rootEl, '[data-rf-online-only]').forEach(function (el) {
      if (el.hasAttribute(OFF)) return;
      el.setAttribute(OFF, JSON.stringify({
        d: el.hasAttribute('disabled'), t: el.getAttribute('title'),
        a: el.getAttribute('aria-disabled'), p: el.classList.contains('pointer-events-none'),
      }));
      if (el.tagName !== 'A') el.setAttribute('disabled', '');
      else el.classList.add('pointer-events-none');
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('title', 'Needs a connection');
    });
  }

  function restoreOnlineOnly(rootEl) {
    within(rootEl, '[' + OFF + ']').forEach(function (el) {
      var prev = {};
      try { prev = JSON.parse(el.getAttribute(OFF)) || {}; } catch (e) { /* defaults */ }
      el.removeAttribute(OFF);
      if (!prev.d) el.removeAttribute('disabled');
      if (prev.t === null || prev.t === undefined) el.removeAttribute('title'); else el.setAttribute('title', prev.t);
      if (prev.a === null || prev.a === undefined) el.removeAttribute('aria-disabled'); else el.setAttribute('aria-disabled', prev.a);
      if (!prev.p) el.classList.remove('pointer-events-none');
    });
  }

  // Fills one fragment root (an element carrying data-rf-article) from its record.
  // ctx ("lists"): {labels, prefs, stories, interactive, storyScope, storyChild,
  //   related, requested, sharePending, origin, now}
  function apply(rootEl, rec, ctx) {
    ctx = ctx || {};
    if (!rootEl || !rec) return;
    var isRow = rootEl.classList.contains('article-row');
    if (isRow && ctx.storyChild) {
      rootEl.classList.remove('pl-2');
      rootEl.classList.add('pl-7');
      rootEl.setAttribute('data-story-parent', String(ctx.storyChild));
    }
    if (isRow && ctx.storyScope) rootEl.setAttribute('data-story-scope', ctx.storyScope);

    // Slots before read classes: the starred row icon brings its own read-class pair.
    within(rootEl, '[data-rf-slot]').forEach(function (el) {
      // An earlier slot may have replaced the element this one sat in.
      if (el !== rootEl && !rootEl.contains(el)) return;
      switch (el.getAttribute('data-rf-slot')) {
        case 'star-button': star(el, rec); break;
        case 'archive-button': archive(el, rec); break;
        case 'read-button': readButton(el, rec); break;
        case 'saved-icon': toggle(el, 'hidden', !rec.saved_at); break;
        case 'labels': labels(el, rec, ctx); break;
        case 'score-badge': scoreBadge(el, rec, ctx); break;
        case 'related-count': related(el, rec, ctx); break;
        case 'share': share(el, rec, ctx); break;
        default: break;
      }
    });
    if (!isRow) ai(rootEl, rec, ctx);
    readClasses(rootEl, !!rec.is_read);
    times(rootEl, ctx);
    onlineOnly(rootEl);
  }

  // Applies a parsed state island to every fragment root in a container (a template's
  // content, or a swapped element). state: {records: {id: record}, ...ctx}.
  function applyState(container, state) {
    var records = state.records || {};
    within(container, '[data-rf-article]').forEach(function (el) {
      var rec = records[el.getAttribute('data-rf-article')];
      if (rec) apply(el, rec, state);
    });
    onlineOnly(container);
  }

  // Response HTML in, overlaid HTML out; unchanged when it carries no state island.
  function transform(html, doc) {
    if (typeof html !== 'string' || html.indexOf('data-rf-state') < 0) return html;
    var tpl = doc.createElement('template');
    tpl.innerHTML = html;
    var island = tpl.content.querySelector('script[data-rf-state]');
    if (!island) return html;
    var state;
    try { state = JSON.parse(island.textContent); } catch (e) { return html; }
    island.remove();
    applyState(tpl.content, state);
    return tpl.innerHTML;
  }

  // Hooks htmx: offline answers are overlaid before they are swapped in. Idempotent.
  function install(doc) {
    doc = doc || root.document;
    if (!doc || doc.__rfOverlayInstalled) return;
    doc.__rfOverlayInstalled = true;
    // Capture phase on the document: runs before app.js's own beforeSwap listeners on
    // document.body, so they see the overlaid response.
    // Only answers the offline router sent (X-Readfine-Offline: 1) are parsed at all.
    doc.addEventListener('htmx:beforeSwap', function (e) {
      var d = e.detail;
      if (!d || typeof d.serverResponse !== 'string' || !d.xhr) return;
      if (d.xhr.getResponseHeader('X-Readfine-Offline') !== '1') return;
      d.serverResponse = transform(d.serverResponse, doc);
    }, true);
    // A disabled online-only link (or anything marked so) does nothing when clicked.
    doc.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('[data-rf-online-only][aria-disabled="true"]');
      if (t) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  RF.overlay = {
    disableOnlineOnly: onlineOnly,
    restoreOnlineOnly: restoreOnlineOnly,
    apply: apply,
    applyState: applyState,
    transform: transform,
    install: install,
  };

  if (root.document && typeof root.document.addEventListener === 'function') install(root.document);
})(self);
