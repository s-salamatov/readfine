// Readfine read zone: window.RFRead (s4-T5).
//
// A classic script, loaded deferred by app/main.html after app.js and the ui/ scripts.
// It holds the list and article behaviour that needs none of app.js's private state:
//   - the toasts after mark all read, with Undo keyed by the server's stamp;
//   - Undo after archiving an article;
//   - the View menu's reload and the folder chips;
//   - the skeleton rows while a list loads;
//   - swipe on list rows (touch only);
//   - the reading progress bar;
//   - "Show original" for AI-translated titles.
// What reads app.js's own state (the keyboard, the nav snapshot, the active view) stays
// in app.js; this file reaches it only through app.js's global _kbReload().
//
// Everything other scripts own (RFToast, RFPalette, RFMotion, htmx, _kbReload) is looked
// up when it is used, never when this file loads.
//
// API:
//   RFRead.undoMarkAll(stamp) -> Promise: posts the stamp back, byte for byte, to
//     /htmx/articles/mark-read/undo and shows how that went.
//   RFRead.goTo(url): a sidebar view by its hx-get (RFPalette.goTo).
//   RFRead.reloadList(): the open view again, sidebar included (app.js _kbReload).
(function () {
  'use strict';
  if (window.RFRead) return;

  function toast(opts) {
    return window.RFToast ? window.RFToast.show(opts) : null;
  }

  function csrfToken() {
    var m = document.cookie.split('; ').find(function (r) { return r.startsWith('csrftoken='); });
    return m ? m.split('=')[1] : '';
  }

  function reloadList() {
    if (typeof window._kbReload === 'function') window._kbReload();
  }

  function goTo(url) {
    if (window.RFPalette && typeof window.RFPalette.goTo === 'function') {
      window.RFPalette.goTo(url);
    } else if (window.htmx && typeof window.htmx.ajax === 'function') {
      window.htmx.ajax('GET', url, { target: '#article-list', swap: 'innerHTML' });
    }
  }

  // ---------------------------------------------------------------- mark all read

  var OFFLINE_UNDO = 'Couldn\'t undo while offline';
  var FAILED_UNDO = 'Couldn\'t undo. Try again.';

  // The showToast part of an HX-Trigger header, shown; false when there is none.
  function triggerToast(header) {
    if (!header || !window.RFToast) return false;
    var parsed;
    try { parsed = JSON.parse(header); } catch (e) { return false; }
    if (!parsed || typeof parsed !== 'object' || !parsed.showToast) return false;
    window.RFToast.fromTrigger(parsed.showToast);
    return true;
  }

  // The stamp is opaque: never parsed, sent back as it came. It holds a "+" (the UTC
  // offset), so it goes form-encoded, or the server reads a space and answers 400.
  function undoMarkAll(stamp) {
    var request;
    try {
      request = window.fetch('/htmx/articles/mark-read/undo', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'HX-Request': 'true',
          'x-csrftoken': csrfToken(),
        },
        body: 'stamp=' + encodeURIComponent(String(stamp)),
      });
    } catch (e) {
      request = Promise.reject(e);
    }
    return Promise.resolve(request).then(function (res) {
      var offline = res.headers.get('X-Readfine-Offline') === '1';
      return Promise.resolve(res.text()).catch(function () { return ''; }).then(function (body) {
        // The worker answers 200 offline: the header or the needs-connection page says so.
        if (offline || String(body || '').indexOf('data-rf-needs-connection') !== -1) {
          toast({ msg: OFFLINE_UNDO, type: 'info' });
          return;
        }
        var header = res.headers.get('HX-Trigger');
        // Success is the route's own 200, which always carries its showToast. A 200
        // reached through a redirect (an expired session lands on the login page) or
        // without that toast restored nothing.
        if (res.redirected) { toast({ msg: FAILED_UNDO, type: 'error' }); return; }
        if (res.status === 200) {
          if (triggerToast(header)) { reloadList(); return; }
          toast({ msg: FAILED_UNDO, type: 'error' });
          return;
        }
        if (!triggerToast(header)) toast({ msg: FAILED_UNDO, type: 'error' });
      });
    }, function () {
      toast({ msg: OFFLINE_UNDO, type: 'info' });
    });
  }

  // HX-Trigger rf:markedall from the four mark-all routes (and the offline worker,
  // which has no stamp to give: its reads reach the server only at the next sync).
  document.addEventListener('rf:markedall', function (e) {
    var d = e.detail || {};
    var count = Number(d.count) || 0;
    if (count <= 0) { toast({ msg: 'Nothing to mark as read', type: 'info' }); return; }
    var msg = 'Marked ' + count + ' as read';
    if (d.stamp === null || d.stamp === undefined || d.stamp === '') {
      toast({ msg: msg + ' · will sync', type: 'ok' });
      return;
    }
    var stamp = String(d.stamp);
    toast({
      msg: msg, type: 'ok', duration: 10000,
      action: { label: 'Undo', onClick: function () { undoMarkAll(stamp); } },
    });
  });

  // ---------------------------------------------------------------- archive Undo

  // The control of one article's detail, found by walking up from each, as app.js
  // _detailMenuControl does: the panel and the inline shell share every fixed id.
  function articleControl(articleId, attr) {
    var controls = document.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < controls.length; i++) {
      var root = controls[i].closest('[data-article-id]');
      if (root && root.dataset.articleId === String(articleId)) return controls[i];
    }
    return null;
  }

  function undoArchive(articleId) {
    var control = articleControl(articleId, 'data-header-archive');
    if (control) { control.click(); return; }
    if (window.htmx && typeof window.htmx.ajax === 'function') {
      window.htmx.ajax('POST', '/htmx/articles/' + articleId + '/archive', { swap: 'none' });
    }
  }

  // HX-Trigger articleArchiveChanged answers the reader's own archive click (online
  // from the server, offline from the worker). Unarchiving says nothing, so the Undo
  // itself (which unarchives) does not offer another one.
  document.addEventListener('articleArchiveChanged', function (e) {
    var d = e.detail || {};
    if (d.isArchived !== true || d.id === undefined || d.id === null) return;
    var id = String(d.id);
    toast({
      msg: 'Archived', type: 'ok',
      action: { label: 'Undo', onClick: function () { undoArchive(id); } },
    });
  });

  // ---------------------------------------------------------------- View menu, chips

  // POST /htmx/list-view saved one choice and answered rf:viewchanged: draw the list
  // again with it.
  document.addEventListener('rf:viewchanged', function () { reloadList(); });

  // Folder chips: data-rf-nav is the sidebar row's hx-get, as in the palette.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var chip = t.closest('#article-list [data-rf-nav]');
    if (!chip) return;
    var url = chip.getAttribute('data-rf-nav');
    if (!url) return;
    e.preventDefault();
    goTo(url);
  });

  // ---------------------------------------------------------------- skeleton

  // Switching views swaps #article-list asynchronously while the nav highlight moves at
  // once; skeleton rows over the old list keep the two from disagreeing. Only a request
  // that outlasts the delay shows them, so a quick load does not flash. The pagination
  // sentinel targets itself, not #article-list, so it never shows them.
  var LOADING_DELAY_MS = 150;
  var loadingTimer = null;

  function showListLoading() {
    if (loadingTimer) return;
    loadingTimer = setTimeout(function () {
      loadingTimer = null;
      var list = document.getElementById('article-list');
      if (!list || list.querySelector('.article-list-loading')) return;
      var veil = document.createElement('div');
      veil.className = 'article-list-loading';
      veil.setAttribute('aria-hidden', 'true');
      // Over the part of the list on screen, wherever it is scrolled to.
      veil.style.top = (list.scrollTop || 0) + 'px';
      var tpl = document.getElementById('rf-list-skeleton');
      if (tpl && tpl.content) veil.appendChild(tpl.content.cloneNode(true));
      list.appendChild(veil);
    }, LOADING_DELAY_MS);
  }

  function hideListLoading() {
    if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
    var list = document.getElementById('article-list');
    var veil = list && list.querySelector('.article-list-loading');
    if (veil) veil.remove();
  }

  function targetsList(e) {
    return !!(e.detail && e.detail.target && e.detail.target.id === 'article-list');
  }

  // On success the swap removes the veil with the old list; afterRequest also clears it
  // after a 4xx/5xx, which swaps nothing.
  document.addEventListener('htmx:beforeRequest', function (e) { if (targetsList(e)) showListLoading(); });
  document.addEventListener('htmx:afterRequest', function (e) { if (targetsList(e)) hideListLoading(); });

  // ---------------------------------------------------------------- swipe

  // Right stars, left toggles read, through the row's own controls, so the optimistic
  // star, the counts and articleReadChanged all behave as they do on a click. Touch
  // only; the axis is decided after 10 px, and a vertical start is the list scrolling
  // (input.css gives rows touch-action: pan-y, so the browser keeps vertical pans).
  // The action runs on release; the row then slides back through RFMotion, at once
  // under reduced motion. Nothing waits on that animation.
  var AXIS_LOCK_PX = 10;
  var COMMIT_MAX_PX = 96;
  var COMMIT_SHARE = 0.35;
  var CLICK_GUARD_MS = 600;

  var swipe = null;      // {row, id, pointerId, x0, y0, dx, axis}
  var swallow = null;    // {row, until}: the click a swipe can still produce

  function rowWidth(row) {
    var r = row.getBoundingClientRect();
    return (r && r.width) || row.offsetWidth || 0;
  }

  function threshold(row) {
    var w = rowWidth(row);
    return w > 0 ? Math.min(w * COMMIT_SHARE, COMMIT_MAX_PX) : COMMIT_MAX_PX;
  }

  function clearRow(row) {
    row.removeAttribute('data-rf-swipe');
    row.style.transform = '';
  }

  function snapBack(row, dx) {
    var motion = window.RFMotion;
    row.removeAttribute('data-rf-swipe');
    if (!dx || !motion || typeof motion.animate !== 'function' || (motion.reduced && motion.reduced())) {
      clearRow(row);
      return;
    }
    motion.animate(row, {
      x: [dx, 0],
      duration: motion.tokens && motion.tokens.fast,
      ease: 'out(3)',
      onComplete: function () { if (!row.hasAttribute('data-rf-swipe')) row.style.transform = ''; },
    });
  }

  function commit(s) {
    if (s.dx > 0) {
      var star = s.row.querySelector('[data-star-btn]');
      if (star) star.click();
    } else if (window.htmx && typeof window.htmx.ajax === 'function') {
      window.htmx.ajax('POST', '/htmx/articles/' + s.id + '/read', { swap: 'none' });
    }
  }

  document.addEventListener('pointerdown', function (e) {
    // A new touch starts afresh: a guard left by the last swipe must not eat its clicks.
    swallow = null;
    if (e.pointerType !== 'touch' || e.isPrimary === false) return;
    var t = e.target;
    var row = t && typeof t.closest === 'function' && t.closest('#article-list .article-row');
    if (!row || !row.dataset.articleId) { swipe = null; return; }
    swipe = { row: row, id: row.dataset.articleId, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, axis: null };
  }, { passive: true });

  document.addEventListener('pointermove', function (e) {
    var s = swipe;
    if (!s || e.pointerId !== s.pointerId) return;
    var dx = e.clientX - s.x0;
    var dy = e.clientY - s.y0;
    if (!s.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.axis === 'y') { swipe = null; return; }
    }
    s.dx = dx;
    s.row.setAttribute('data-rf-swipe', dx >= 0 ? 'right' : 'left');
    s.row.style.transform = 'translateX(' + Math.round(dx) + 'px)';
  }, { passive: true });

  document.addEventListener('pointerup', function (e) {
    var s = swipe;
    if (!s || e.pointerId !== s.pointerId) return;
    swipe = null;
    if (s.axis !== 'x') return;
    // The action first, then the guard: the guard would swallow the star's own click.
    if (Math.abs(s.dx) >= threshold(s.row)) commit(s);
    swallow = { row: s.row, until: Date.now() + CLICK_GUARD_MS };
    snapBack(s.row, s.dx);
  });

  document.addEventListener('pointercancel', function (e) {
    var s = swipe;
    if (!s || e.pointerId !== s.pointerId) return;
    swipe = null;
    snapBack(s.row, s.dx);
  });

  // A horizontal swipe never opens the article: the click it may end in is spent here,
  // before the row's own (htmx) listener sees it.
  document.addEventListener('click', function (e) {
    var g = swallow;
    if (!g) return;
    swallow = null;
    if (Date.now() > g.until || !g.row.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // ---------------------------------------------------------------- progress

  // --rf-progress (0 to 1) on the open article's [data-rf-progress]; base.html maps it
  // to the bar's scaleX and gives it no transition. The panel (#article-detail) scrolls
  // itself; read inline, the article scrolls with the list (#article-list).
  var progressQueued = false;

  function clamp(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function setProgress(bar, value) {
    bar.style.setProperty('--rf-progress', String(Math.round(clamp(value) * 1000) / 1000));
  }

  function updateProgress() {
    progressQueued = false;
    var panel = document.getElementById('article-detail');
    var bar = panel && panel.querySelector('[data-rf-progress]');
    if (bar) {
      var range = panel.scrollHeight - panel.clientHeight;
      setProgress(bar, range > 0 ? panel.scrollTop / range : 0);
    }
    var inline = document.getElementById('inline-article-detail-content');
    var list = document.getElementById('article-list');
    var inlineBar = inline && inline.querySelector('[data-rf-progress]');
    if (inlineBar && list) {
      var a = inline.getBoundingClientRect();
      var l = list.getBoundingClientRect();
      var span = a.height - l.height;
      setProgress(inlineBar, span > 0 ? (l.top - a.top) / span : (l.top >= a.top ? 1 : 0));
    }
  }

  function queueProgress() {
    if (progressQueued) return;
    progressQueued = true;
    window.requestAnimationFrame(updateProgress);
  }

  // scroll does not bubble: caught in the capture phase.
  document.addEventListener('scroll', function (e) {
    var id = e.target && e.target.id;
    if (id === 'article-detail' || id === 'article-list') queueProgress();
  }, { capture: true, passive: true });

  document.addEventListener('htmx:afterSettle', function (e) {
    var id = e.detail && e.detail.target && e.detail.target.id;
    if (id === 'article-detail' || id === 'inline-article-detail-content') queueProgress();
  });

  // ---------------------------------------------------------------- translated titles

  // "Show original" in the reading pane swaps an AI-translated title back to the
  // original, in the pane (its title and any other [data-detail-title] of the same
  // article root) and in the article's list row, until either is drawn again. The
  // summary snippet is in the original language, so it shows only next to the original
  // title. Both titles travel as data attributes on the pane's <article> and on the
  // row; nothing goes to the server.
  function applyTitle(holder, scope, showOriginal) {
    if (!holder || !holder.hasAttribute('data-title-translated')) return;
    if (showOriginal) holder.setAttribute('data-showing-original', '');
    else holder.removeAttribute('data-showing-original');
    var text = holder.getAttribute(showOriginal ? 'data-title-original' : 'data-title-translated');
    scope.querySelectorAll('[data-article-title], [data-detail-title]').forEach(function (t) {
      t.textContent = text;
    });
    scope.querySelectorAll('[data-translation-mark]').forEach(function (m) {
      m.classList.toggle('opacity-40', showOriginal);
    });
    var snippet = holder.querySelector('[data-article-snippet]');
    if (snippet) snippet.classList.toggle('hidden', !showOriginal);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var btn = t && typeof t.closest === 'function' && t.closest('[data-toggle-translation]');
    if (!btn) return;
    e.preventDefault();
    var id = btn.getAttribute('data-toggle-translation');
    var pane = btn.closest('article[data-article-id]');
    var showOriginal = !(pane && pane.hasAttribute('data-showing-original'));
    if (pane) applyTitle(pane, pane.closest('#article-detail-root') || pane, showOriginal);
    var row = document.getElementById('article-row-' + id);
    if (row) applyTitle(row, row, showOriginal);
    btn.textContent = showOriginal ? 'Show translation' : 'Show original';
  });

  window.RFRead = { undoMarkAll: undoMarkAll, goTo: goTo, reloadList: reloadList };
})();
