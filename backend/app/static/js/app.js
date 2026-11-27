// ── CSRF token from the double-submit cookie, for hand-rolled fetch() calls.
// (HTMX requests get it automatically via csrf.js.) ──
function getCsrfToken() {
  var m = document.cookie.split('; ').find(function (r) { return r.startsWith('csrftoken='); });
  return m ? m.split('=')[1] : '';
}

// ── Generic: clear named input after HTMX swap (data-clear-on-swap="fieldname") ──
document.addEventListener('htmx:afterSwap', function (e) {
  var form = e.detail && e.detail.elt;
  if (!form || !form.dataset || !form.dataset.clearOnSwap) return;
  var inp = form.querySelector('[name="' + form.dataset.clearOnSwap + '"]');
  if (inp) inp.value = '';
});

// ── Generic: reset form after HTMX request (data-reset-on-request) ───────
document.addEventListener('htmx:afterRequest', function (e) {
  var el = e.detail && e.detail.elt;
  if (!el || !el.dataset || !('resetOnRequest' in el.dataset)) return;
  el.reset();
});

// ── Mobile side-nav: scroll the active tab into view on load ──────────────
// The strip is a horizontal scroll container and browsers restore its offset
// when you navigate (e.g. Admin → Settings), which lands *after* the first
// pass here and leaves the active tab off-screen. So run several passes, each
// a no-op once the tab is visible, and stop as soon as the user scrolls the
// strip by hand.
(function () {
  var userScrolled = false;

  function scrollActiveNavIntoView() {
    if (userScrolled) return;
    var active = document.querySelector('[data-mobile-nav] [data-mobile-nav-active]');
    if (!active) return;
    var bar = active.closest('[data-mobile-nav]');
    if (!bar || bar.offsetParent === null) return; // hidden (desktop): skip
    // offsetLeft is relative to the nearest positioned ancestor, not to the
    // strip, so measure against the strip itself.
    var left = active.getBoundingClientRect().left - bar.getBoundingClientRect().left;
    if (left >= 0 && left + active.offsetWidth <= bar.clientWidth) return; // already visible
    // Horizontally center the active tab without scrolling the page vertically.
    bar.scrollLeft += left - (bar.clientWidth - active.offsetWidth) / 2;
  }

  function markUserScroll(e) {
    if (e.target.closest && e.target.closest('[data-mobile-nav]')) userScrolled = true;
  }
  var listenOpts = { capture: true, passive: true };
  document.addEventListener('pointerdown', markUserScroll, listenOpts);
  document.addEventListener('touchstart', markUserScroll, listenOpts);
  document.addEventListener('wheel', markUserScroll, listenOpts);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scrollActiveNavIntoView);
  } else {
    scrollActiveNavIntoView();
  }
  requestAnimationFrame(scrollActiveNavIntoView);
  window.addEventListener('load', function () {
    scrollActiveNavIntoView();
    setTimeout(scrollActiveNavIntoView, 150);
  });
  window.addEventListener('pageshow', scrollActiveNavIntoView);

  // A boosted navigation or form post (creating an API token, say) swaps in a new strip
  // without a load event. The new strip has not been scrolled by hand, and its saved
  // offset (restored by the htmx:afterSettle listener on <body> below, which runs
  // before this one on <document>) may leave the active tab off-screen: re-centre it.
  var lastBar = null;
  document.addEventListener('htmx:afterSettle', function () {
    var bar = document.querySelector('[data-mobile-nav]');
    if (bar && bar !== lastBar) userScrolled = false;
    lastBar = bar;
    scrollActiveNavIntoView();
    requestAnimationFrame(scrollActiveNavIntoView);
  });
  lastBar = document.querySelector('[data-mobile-nav]');
})();

// ── Sidebar: remove touch-active class after feed refresh ─────────────────
document.addEventListener('htmx:afterRequest', function (e) {
  var btn = e.detail && e.detail.elt;
  if (!btn || btn.dataset.action !== 'feed-refresh') return;
  var row = btn.closest('.feed-nav-row');
  if (row) row.classList.remove('touch-active');
  btn.blur();
});

// ── Dark mode: system preference live listener ────────────────────────────
(function () {
  var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (!mq) return;
  mq.addEventListener('change', function () {
    var cs;
    try { cs = localStorage.getItem('colorScheme'); } catch(e) {}
    if ((cs || 'system') === 'system') {
      document.documentElement.classList.toggle('dark', mq.matches);
      if (window.syncThemeColor) window.syncThemeColor();
    }
  });
})();

// ── HTMX configRequest: inject dynamic params without eval ────────────────
document.body.addEventListener('htmx:configRequest', function (e) {
  var elt = e.detail.elt;
  // Sidebar pinned state
  if (elt.id === 'sidebar') {
    var bucket = document.documentElement.dataset.bucket;
    if (bucket === 'small') {
      // The phone sidebar is always the full one, sliding in (hideable-up).
      e.detail.parameters['pinned'] = 'true';
    } else {
      e.detail.parameters['pinned'] = window._sidebarPinned ? 'true' : 'false';
    }
  }
  // Mark-read before timestamp
  if (elt.dataset && elt.dataset.action === 'mark-read') {
    e.detail.parameters['before'] = new Date().toISOString();
  }
});

// ── Layout bucket system ──────────────────────────────────────────────────
(function () {
  var LAYOUT_DEFAULTS = { small: '1', medium: '2', large: '3' };

  function getBuckets() {
    var m = document.querySelector('meta[name="app-buckets"]');
    if (m) return { smallMax: parseInt(m.dataset.small), mediumMax: parseInt(m.dataset.medium) };
    return { smallMax: 640, mediumMax: 1100 };
  }

  function getCurrentBucket() {
    var b = getBuckets();
    var w = window.innerWidth;
    if (w <= b.smallMax) return 'small';
    if (w <= b.mediumMax) return 'medium';
    return 'large';
  }

  function getLayout(bucket) {
    try {
      return localStorage.getItem('layout_' + bucket) || LAYOUT_DEFAULTS[bucket];
    } catch (e) {
      return LAYOUT_DEFAULTS[bucket];
    }
  }

  function applyBucket() {
    var bucket = getCurrentBucket();
    var layout = getLayout(bucket);
    var html = document.documentElement;
    html.dataset.bucket = bucket;
    html.dataset.layout = layout;
    if (bucket === 'small') {
      // One phone sidebar mode since s7 (Collapsible retired); init.js does the same.
      try {
        if (localStorage.getItem('sidebar_mode_small') !== 'hideable-up') {
          localStorage.setItem('sidebar_mode_small', 'hideable-up');
        }
      } catch (e) {}
      html.dataset.sidebarMode = 'hideable-up';
    } else {
      html.classList.remove('mobile-sidebar-open', 'mobile-detail-open');
    }
    // The story window belongs to the layouts that read in the list, and its CSS is not
    // tied to a bucket, so resized into the 3-panel layout it kept the panel fixed over
    // the whole window. There the panel is beside the list already: drop the class and
    // the article it was carrying simply stays in it. Every other layout keeps the
    // window, which is where it still makes sense.
    if (layout === '3') html.classList.remove('story-detail-open');
  }

  window._getLayout = getLayout;
  window._getCurrentBucket = getCurrentBucket;
  window._applyBucket = applyBucket;

  document.addEventListener('DOMContentLoaded', applyBucket);
  window.addEventListener('resize', applyBucket);
})();

// How a phone opens an article: 'fullscreen' (the default since s4, owner answer Q2)
// or 'inline' in the list. Per device; a stored choice is kept.
var _DETAIL_MODE_SMALL_DEFAULT = 'fullscreen';
function _detailModeSmall() {
  try { return localStorage.getItem('detail_mode_small') || _DETAIL_MODE_SMALL_DEFAULT; }
  catch (e) { return _DETAIL_MODE_SMALL_DEFAULT; }
}

// Returns true when article clicks should expand inline in the list
function _shouldUseInline() {
  var bucket = document.documentElement.dataset.bucket;
  if (bucket === 'small') return _detailModeSmall() === 'inline';
  return document.documentElement.dataset.layout === '2';
}

// ── Open article content links in a new tab
function openProseLinksInNewTab(root) {
  (root || document).querySelectorAll('.prose a[href]').forEach(function (a) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}
document.addEventListener('DOMContentLoaded', function () { openProseLinksInNewTab(); });
document.body.addEventListener('htmx:afterSettle', function () { openProseLinksInNewTab(); });

// ── Videos in article content: play them here instead of leaving for the site
//
// Stored content carries only a thumbnail and a link (see app/utils/video.py, video_figure),
// and it stays that way until the reader clicks. No player is loaded before then, so no
// video service can set a cookie on an article you only scrolled past.
//
// The thumbnail's src is our own /img/video-thumb endpoint, not the video host, so
// opening an article no longer hands YouTube or Vimeo the reader's IP and the video id
// (see app/utils/video.py and video_thumb_service). That is a server-side matter and
// nothing here needs to touch it — including the old dance of upgrading the src to a
// sharper image and reverting on error, which the server now resolves once.
//
// The click is what loads the player, and the player is built here from the ids on the
// figure, never from markup a feed supplied. The id is checked against the shape it must
// have, because it goes into a URL and the figure may well have arrived in a feed's own
// HTML.
var VIDEO_PROVIDERS = {
  youtube: {
    id: /^[A-Za-z0-9_-]{6,20}$/,
    label: 'YouTube',
    // youtube-nocookie: no cookies until playback actually starts.
    src: function (id, start) {
      return 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0' +
        (start ? '&start=' + start : '');
    },
  },
  vimeo: {
    id: /^\d{5,15}$/,
    label: 'Vimeo',
    src: function (id, start) {
      return 'https://player.vimeo.com/video/' + id + '?autoplay=1' + (start ? '#t=' + start + 's' : '');
    },
  },
};

function _videoProvider(fig) {
  var spec = VIDEO_PROVIDERS[fig.getAttribute('data-video-provider')];
  return spec && spec.id.test(fig.getAttribute('data-video-id') || '') ? spec : null;
}

// Label every figure the handler below can act on. The caption states what the thing
// is and what playing it costs; it is deliberately not phrased as an instruction,
// since the badge on the thumbnail is what asks to be clicked and a caption reading
// "Play video" competes with it for the same click. The invitation lives on the
// thumbnail, in the badge and in its tooltip.
//
// Done in script rather than in the stored markup so articles saved before this
// existed are described the same way.
function markVideoFacades(root) {
  (root || document).querySelectorAll('.prose figure[data-video-id]').forEach(function (fig) {
    var spec = _videoProvider(fig);
    // data-video-playing: a figure whose player is already running must not be
    // described as a facade again by a swap somewhere else on the page.
    if (!spec || fig.hasAttribute('data-video-ready') || fig.hasAttribute('data-video-playing')) return;
    fig.setAttribute('data-video-ready', '');
    var link = fig.querySelector('a[href]');
    if (link) link.setAttribute('title', 'Play here (loads the player from ' + spec.label + ')');
    var caption = fig.querySelector('figcaption');
    if (caption) caption.textContent = spec.label + ' video, loaded only when you play it';
  });
}
document.addEventListener('DOMContentLoaded', function () { markVideoFacades(); });
document.body.addEventListener('htmx:afterSettle', function () { markVideoFacades(); });

// Start the player in *fig*, at *start* seconds when given. A player already running
// is re-pointed rather than rebuilt: reloading the frame is a second of black, but it
// needs no player API, which would mean loading a script from the video site and
// widening script-src for the sake of a smoother seek.
function playVideo(fig, spec, start) {
  var running = fig.querySelector('iframe.video-embed');
  if (running) {
    running.src = spec.src(fig.getAttribute('data-video-id'), start);
    return;
  }
  var frame = document.createElement('iframe');
  frame.src = spec.src(fig.getAttribute('data-video-id'), start);
  frame.className = 'video-embed';
  frame.title = spec.label + ' video player';
  frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  frame.setAttribute('allowfullscreen', '');
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

  // The player goes over the thumbnail, not in its place: the picture holds the box
  // while the frame loads, so there is no moment with the page background showing
  // between two dark things (see input.css). Nothing below the video moves either,
  // since the thumbnail keeps taking exactly the room it took, and the caption keeps
  // its line. What the caption says changes, though: the way out to the site is the
  // useful thing to offer once the video is already playing here.
  var link = fig.querySelector('a[href]');
  var href = link ? link.getAttribute('href') : null;
  if (link) {
    // One box around both, so the player takes the thumbnail's box exactly instead of
    // computing a near-identical one of its own (see input.css).
    var box = document.createElement('div');
    box.className = 'video-box';
    link.replaceWith(box);
    box.appendChild(link);
    box.appendChild(frame);
    // Hide the thumbnail once the frame has painted: it is there to cover the load and
    // nothing more. Hidden on the element itself rather than by a selector, so the
    // caption's link out to the site is not caught by the same rule. If the event
    // never comes, the picture stays behind the player, which is where it started.
    frame.addEventListener('load', function () { link.style.visibility = 'hidden'; }, { once: true });
  } else {
    fig.replaceChildren(frame);
  }

  var caption = fig.querySelector('figcaption');
  if (caption && href) {
    var out = document.createElement('a');
    out.href = href;
    out.target = '_blank';
    out.rel = 'noopener noreferrer';
    out.textContent = 'Watch on ' + spec.label;
    caption.replaceChildren(out);
  } else if (caption) {
    caption.textContent = spec.label;
  }

  // Off with the facade marks: the badge belongs to a thumbnail, and leaving the
  // figure clickable would have the play handler swallow the click on the link the
  // caption now holds.
  fig.removeAttribute('data-video-ready');
  fig.setAttribute('data-video-playing', '');
}

// Capture, and stopped there: the thumbnail is wrapped in an anchor to the video
// site, openProseLinksInNewTab has since marked it target="_blank", and the
// link-opened tracker counts any such click inside an article as the reader leaving
// for the source. That signal feeds retention and scoring, and pressing play here is
// not leaving. Bubbling would reach the tracker before this handler, so the click has
// to be taken on the way down.
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var fig = e.target.closest('.prose figure[data-video-ready]');
  if (!fig) return;
  var spec = _videoProvider(fig);
  // Without a provider we never reach here, but if we did, the anchor to the site is
  // the right thing to leave alone.
  if (!spec) return;
  e.preventDefault();
  e.stopPropagation();
  playVideo(fig, spec);
}, true);

// The video a chapter mark belongs to: the last one above it. A description sits
// under its own video, and an article holding several videos each with their own
// description would otherwise send every mark to the first player on the page.
function _videoForSeek(el) {
  var scope = el.closest('.prose');
  if (!scope) return null;
  var found = null;
  scope.querySelectorAll('figure[data-video-id]').forEach(function (fig) {
    if (fig.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = fig;
  });
  return found;
}

// Chapter marks in a description seek the player here instead of opening the video
// site at that point, which is what their href does for anyone this script never
// reaches. Same capture treatment as above, and for the same reason: the mark is an
// anchor out to the site, so a bubbling click would be filed as the reader leaving.
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  var mark = e.target.closest('.prose a[data-seek]');
  if (!mark) return;
  var seconds = parseInt(mark.getAttribute('data-seek'), 10);
  // Stored marks are written by _link_timestamps, but the same attribute in a feed's
  // own markup would arrive here too, so the value is read as a number or not at all.
  if (!isFinite(seconds) || seconds < 0) return;
  var fig = _videoForSeek(mark);
  if (!fig) return;
  var spec = _videoProvider(fig);
  if (!spec) return;
  e.preventDefault();
  e.stopPropagation();
  playVideo(fig, spec, seconds);
  // A long description puts the player off the top of the screen; block: 'nearest'
  // leaves it alone when it is already visible.
  fig.scrollIntoView({ block: 'nearest' });
}, true);

// Hide duplicate headings emitted by feed/readable content when they repeat the article title.
function normalizeArticleHeading(text) {
  var normalized = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.normalize) {
    normalized = normalized.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }
  return normalized
    .replace(/["'`]/g, '')
    .replace(/[.,!?;:()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function articleHeadingMatchesTitle(headingText, titleText) {
  var heading = normalizeArticleHeading(headingText);
  var title = normalizeArticleHeading(titleText);
  if (!heading || !title) return false;
  if (heading === title) return true;
  if (heading.slice(0, 80) === title.slice(0, 80)) return true;

  // Readable extractors often return just the article headline while feeds include
  // a site suffix, for example "Headline - Publisher".
  if (heading.length >= 20 && title.indexOf(heading) === 0) return true;
  if (title.length >= 20 && heading.indexOf(title) === 0) return true;
  return false;
}

function _hideDuplicateH1In(container) {
  if (!container) return;
  // data-title lives on the inner <article>, not on the outer [data-article-id] root.
  var articleEl = container.querySelector('[data-title]');
  if (!articleEl) return;
  var content = articleEl.querySelector('#article-content-' + articleEl.dataset.articleId);
  var prose = (content && content.querySelector('.prose')) || articleEl.querySelector('.prose');
  if (!prose) return;
  var headings = prose.querySelectorAll('h1, h2');
  for (var i = 0; i < headings.length && i < 3; i += 1) {
    if (articleHeadingMatchesTitle(headings[i].textContent, articleEl.dataset.title || '')) {
      headings[i].style.display = 'none';
      break;
    }
  }
}

function hideDuplicateH1() {
  // The article title is always shown outside the body — in the article list beside
  // the content (inline view) or in the detail header (single-column + 3-panel) —
  // so a body heading repeating it is redundant in every layout. The content lives in
  // the inline shell when a row is expanded in the list (medium 2-panel AND small/mobile
  // inline mode), and in the right panel otherwise.
  //
  // Both, rather than whichever comes first: the story window puts an article in the
  // panel while the shell underneath still holds the one it was opened from, and
  // preferring the shell left the article actually on screen wearing its title twice.
  // A container holding nothing is skipped, so this costs a lookup where it does not
  // apply, and hiding is idempotent where it does.
  _hideDuplicateH1In(document.getElementById('inline-article-detail-content'));
  _hideDuplicateH1In(document.getElementById('article-detail'));
}
document.addEventListener('DOMContentLoaded', hideDuplicateH1);
document.body.addEventListener('htmx:afterSettle', hideDuplicateH1);

// Dates are formatted server-side (Jinja `localtime`/`utctime` filters using the
// user's stored timezone), so no client-side localization is needed.

// Copy-to-clipboard for [data-copy] buttons
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.copy-btn[data-copy]');
  if (!btn) return;
  navigator.clipboard.writeText(btn.dataset.copy).then(function () {
    var svg = btn.querySelector('svg');
    svg.style.display = 'none';
    btn.insertAdjacentText('beforeend', '✓');
    btn.classList.add('text-green-500');
    setTimeout(function () {
      btn.lastChild.remove();
      svg.style.display = '';
      btn.classList.remove('text-green-500');
    }, 1500);
  });
});

// Copy-from-element for [data-copy-from] buttons — reads text from element with given ID
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.copy-from-btn[data-copy-from]');
  if (!btn) return;
  var el = document.getElementById(btn.dataset.copyFrom);
  if (!el) return;
  var text = el.value || el.textContent || '';
  navigator.clipboard.writeText(text).then(function () {
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('text-green-600');
    setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('text-green-600');
    }, 2000);
  });
});

// AI CSS selector generation — fill selector input and trigger preview after generation
document.body.addEventListener('selectorGenerated', function (e) {
  var input = document.getElementById('selector-input');
  if (input) input.value = e.detail.selector || '';
  var previewBtn = document.getElementById('preview-btn');
  if (previewBtn) previewBtn.click();
});

// [data-menu-toggle] button opens/closes its next sibling [data-menu]; click outside closes all
// Menu uses position:fixed — immune to parent overflow clipping
document.addEventListener('click', function (e) {
  var toggle = e.target.closest('[data-menu-toggle]');
  if (toggle) {
    var menu = toggle.nextElementSibling;
    if (!menu) return;
    var isOpen = !menu.classList.contains('hidden');
    document.querySelectorAll('[data-menu]').forEach(function (m) { m.classList.add('hidden'); });
    if (!isOpen) {
      var rect = toggle.getBoundingClientRect();
      var menuMinW = 144; // min-w-36
      menu.style.top = (rect.bottom + 4) + 'px';
      if (rect.right >= menuMinW) {
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        menu.style.left = '';
      } else {
        menu.style.left = Math.max(4, rect.left) + 'px';
        menu.style.right = '';
      }
      menu.classList.remove('hidden');
    }
    return;
  }
  if (!e.target.closest('[data-menu]')) {
    document.querySelectorAll('[data-menu]').forEach(function (m) { m.classList.add('hidden'); });
  }
});
document.body.addEventListener('htmx:afterRequest', function (e) {
  var menu = e.target.closest('[data-menu]');
  if (menu) menu.classList.add('hidden');
});

// Nav active state — persists across sidebarRefresh swaps
var _activeNavGet = null;
var _navSnapshot = null;
// When #sidebar last swapped in fresh counts (any trigger). Navigation refreshes
// the sidebar only when this is older than _NAV_SIDEBAR_REFRESH_MS: counts don't
// change on a view switch, but a refresh here heals one that got dropped elsewhere.
var _sidebarSwappedAt = 0;
var _NAV_SIDEBAR_REFRESH_MS = 60000;

// Each nav target is rendered twice (collapsed rail + full sidebar); highlight
// every copy so whichever one is visible shows the active state.
function _highlightNav(url) {
  document.querySelectorAll('.nav-item').forEach(function (i) { i.classList.remove('active'); });
  if (!url) return;
  document.querySelectorAll('.nav-item[hx-get="' + url + '"]').forEach(function (i) {
    i.classList.add('active');
  });
}

function _refreshSidebarAfterNav() {
  if (Date.now() - _sidebarSwappedAt < _NAV_SIDEBAR_REFRESH_MS) return;
  htmx.trigger(document.body, 'sidebarRefresh');
}

function _saveNavSnapshot() {
  var titleEl = document.getElementById('mobile-title-text');
  _navSnapshot = {
    url: _activeNavGet,
    title: titleEl ? titleEl.textContent : null,
  };
}

function _revertNavSnapshot() {
  if (!_navSnapshot) return;
  var snap = _navSnapshot;
  _navSnapshot = null;
  _activeNavGet = snap.url;
  try { if (snap.url) localStorage.setItem('lastNavItem', snap.url); } catch (e) {}
  // Restore the desktop sidebar active highlight to the previous nav item.
  if (snap.url) _highlightNav(snap.url);
  var titleEl = document.getElementById('mobile-title-text');
  if (titleEl && snap.title !== null) {
    titleEl.textContent = snap.title;
    try { localStorage.setItem('mobile_title_text', snap.title); } catch (e) {}
  }
  _syncMobileQuicklink();
  if (snap.url) htmx.ajax('GET', snap.url, { target: '#article-list', swap: 'innerHTML' });
}

// The one-off notice bars at the bottom of the reader (app/main.html).
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-notice-bar-close]');
  if (!btn) return;
  var bar = btn.closest('[data-notice-bar]');
  if (bar) bar.remove();
});

// Every toast goes through RFToast (static/js/ui/toast.js, on Basecoat's toaster).
// Global on purpose: share-target.js and catchup.js call it. Without RFToast (its
// script failed to load) there is nowhere to show it, so it does nothing.
function showToast(msg, type) {
  if (!window.RFToast) return;
  window.RFToast.show({ msg: msg, type: type });
}

function _showNavErrorToast() {
  showToast('Connection error — restoring previous view', 'info');
}

// HX-Trigger showToast: one {msg, type}, or a list of them, which htmx hands over
// wrapped as {value: [...]}. RFToast.fromTrigger takes all three shapes.
document.body.addEventListener('showToast', function (e) {
  if (window.RFToast) window.RFToast.fromTrigger(e.detail);
});

// Fallback reporting for htmx errors that nobody else took.
//
// htmx does not swap a 4xx/5xx response, so a request that fails with no listener of its
// own leaves the page exactly as it was: the spinner stops and the target keeps whatever
// was in it, which reads the same as a request that succeeded and found nothing. That is
// how a rate limit on the feed test and a failed share both came to look like nothing
// happening at all, until each got a handler of its own. Every other request on the site
// still had none.
//
// The rule for the scoped handlers is: claim the error only if you told the user
// something. Putting state back is not telling them, so a reverted star still gets a
// message from here, while the chat, which writes the failure into the thread, does not
// get a second one on top.
var _FALLBACK_ERROR_GAP_MS = 4000;
// -Infinity, not 0: performance.now() starts near zero, so a zero here would read as
// "just toasted" and swallow every failure in the page's first four seconds, which is
// the window the first list load lands in.
var _lastFallbackErrorAt = -Infinity;

function _claimHtmxError(e) {
  if (e && e.detail) e.detail._rfHandled = true;
}

// A polling element asks again by itself, so its failure is neither news nor actionable,
// and saying so every 2s until the user leaves the page would be worse than silence.
// hx-trigger is the only place that says an element polls. A trigger that both loads once
// and polls after ("load, ..., every 300s") counts as polling here, so the initial load
// failing is silent too: mistaking a one-shot for a poll only costs the message we have
// been living without, mistaking a poll for a one-shot costs a toast every other second.
function _isPollingRequest(elt) {
  if (!elt || !elt.getAttribute) return false;
  var trigger = elt.getAttribute('hx-trigger') || elt.getAttribute('data-hx-trigger') || '';
  return /(^|,)\s*every\s/.test(trigger);
}

function _reportUnhandledHtmxError(e, msg) {
  var detail = e.detail;
  if (!detail || _isPollingRequest(detail.elt)) return;
  // Decide a tick later so the scoped handlers get to run first, whatever order they
  // registered in. They cannot be relied on to register first: app.js is deferred and the
  // page scripts that carry two of them are not, so today they always do, and the day
  // app.js loses its defer they would silently stop.
  setTimeout(function () {
    if (detail._rfHandled) return;
    // One failure usually arrives with company, and a stack of identical error toasts
    // says nothing the first one did not, so one per gap is enough. Measured on
    // the monotonic clock: Date.now() steps whenever the OS corrects the wall clock,
    // which on a laptop waking from sleep is exactly when a pile of requests fails.
    var now = performance.now();
    if (now - _lastFallbackErrorAt < _FALLBACK_ERROR_GAP_MS) return;
    _lastFallbackErrorAt = now;
    showToast(msg, 'error');
  }, 0);
}

// Whether an HX-Trigger header fires showToast, read the way htmx reads it: a header
// starting with "{" is a JSON object whose keys are the event names, anything else a
// comma-separated list of names. A value that merely mentions showToast is not one.
function _triggersShowToast(header) {
  if (!header) return false;
  if (header.indexOf('{') === 0) {
    try {
      var parsed = JSON.parse(header);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.prototype.hasOwnProperty.call(parsed, 'showToast');
    } catch (err) {
      return false;
    }
  }
  return header.split(',').some(function (name) { return name.trim() === 'showToast'; });
}

document.body.addEventListener('htmx:responseError', function (e) {
  // An expired session does not come through here: it answers 200 with HX-Redirect to
  // the login page (main.py), so htmx navigates instead of failing.
  var xhr = e.detail && e.detail.xhr;
  var status = xhr ? xhr.status : 0;
  // A response that brought its own toast (the 400/409 safety nets in main.py) has
  // already said what went wrong, and htmx fired it before getting here.
  if (xhr && _triggersShowToast(xhr.getResponseHeader('HX-Trigger'))) {
    _claimHtmxError(e);
    return;
  }
  _reportUnhandledHtmxError(e, status === 429
    ? 'Too many requests in a row. Wait a minute and try again.'
    : 'That did not go through (HTTP ' + status + '). Please try again.');
});

document.body.addEventListener('htmx:sendError', function (e) {
  _reportUnhandledHtmxError(e, 'No connection. Check your network, then try again.');
});

// An article was removed from Saved. It no longer exists in the current view, so
// drop its row and clear the detail panel. No two-way state sync is needed here
// (unlike star/archive): nothing survives to keep in sync.
document.body.addEventListener('savedArticleRemoved', function (e) {
  var id = e.detail && e.detail.id;
  if (!id) return;
  // Scoped to a row in the list, because data-article-id is on five different things:
  // the row, the detail's outer div, the <article> inside it, the bottom bar, and the
  // inline container built below. An unscoped query takes the first in document order,
  // and the list comes before the detail. With the article open but its row not in the
  // list (opened from Saved, then another feed picked in the sidebar), that used to
  // remove the whole detail pane and then find nothing left to put the empty state in.
  var row = document.querySelector('#article-list .article-row[data-article-id="' + id + '"]');
  if (row) row.remove();
  // The 2-panel/mobile body is the row's sibling, not its child, so removing the row
  // leaves it behind: an expanded article with no row above it.
  var inline = document.getElementById('inline-article-detail');
  if (inline && inline.dataset.articleId === String(id)) inline.remove();
  var detail = document.getElementById('article-detail');
  // Exact, not a prefix: the id carries no suffix, and "article-content-1" is a prefix
  // of "article-content-12", so removing article 1 cleared the pane on article 12.
  var openDetail = detail && detail.querySelector('#article-content-' + id);
  if (openDetail) {
    // The empty state main.html renders, minus its icon: there is no round trip
    // here to render the real one, and this is the only place that needs it
    // client-side. Keep the wording in step with that template.
    detail.innerHTML =
      '<div class="flex items-center justify-center h-full text-gray-400">' +
      '<div class="text-center"><p class="text-sm">Select an article to read</p></div></div>';
  }
  showToast('Removed from Saved', 'ok');
});

// Height of a sticky list header (the Saved URL box, the search-results strip), which
// stays put while the list scrolls. A row aligned to the list's own top would slide
// underneath it. The mobile title bar is not counted: the shell reserves its height
// (see base.html), so the list already starts below it.
function listStickyOffset() {
  var listHeader = document.querySelector('#article-list [data-list-header]');
  return listHeader ? listHeader.getBoundingClientRect().height : 0;
}

// Bring a list row to the top of the list. Not scrollIntoView: that knows nothing about
// a sticky list header, so the row it aligns to the top can end up underneath one.
function scrollListRowToTop(row, behavior) {
  if (!row) return;
  var list = document.getElementById('article-list');
  if (!list) {
    row.scrollIntoView({ behavior: behavior || 'instant', block: 'start' });
    return;
  }
  var target = list.scrollTop + row.getBoundingClientRect().top
    - list.getBoundingClientRect().top - listStickyOffset();
  list.scrollTo({ top: Math.max(0, target), behavior: behavior || 'instant' });
}

// An article was added to Saved. The list is ordered by publication date, so the row
// rarely lands on top — a video from a feed you follow carries the date it was
// published and can sit far down. Bring it into view and flash it, so saving doesn't
// look like nothing happened.
//
// The event arrives before the list is swapped in (the save form sits inside
// #article-list, so the swap removes the very element an after-settle trigger would
// fire on), hence the two steps: remember the id, act once the new list has settled.
var _pendingSavedRowId = null;

document.body.addEventListener('savedArticleAdded', function (e) {
  _pendingSavedRowId = (e.detail && e.detail.id) || null;
});

document.body.addEventListener('htmx:afterSettle', function (e) {
  if (!_pendingSavedRowId) return;
  if (!e.detail.target || e.detail.target.id !== 'article-list') return;
  var id = _pendingSavedRowId;
  _pendingSavedRowId = null;
  var list = e.detail.target;
  var row = list && list.querySelector('[data-article-id="' + id + '"]');
  if (!row) {
    // Older than everything on the first page, so there is no row to point at. Stay
    // quiet if the server already sent a toast (the one for an article Readfine
    // already had): it already says where the article went.
    if (!document.querySelector('#toaster .toast:not([aria-hidden="true"])')) {
      showToast('Saved, further down the list', 'info');
    }
    return;
  }
  var offset = listStickyOffset();
  var rowRect = row.getBoundingClientRect();
  var listRect = list.getBoundingClientRect();
  // Move as little as possible: a visible row makes the list stay put, one below the
  // fold comes up to just above the bottom edge (so the articles you were looking at
  // keep their place), and one above the fold aligns under the sticky header.
  var target = null;
  if (rowRect.top < listRect.top + offset) {
    target = list.scrollTop + rowRect.top - listRect.top - offset;
  } else if (rowRect.bottom > listRect.bottom) {
    target = list.scrollTop + rowRect.bottom - listRect.bottom + 12;
  }
  if (target !== null) {
    // Instant, and with mark-as-read held off: the row can be hundreds of articles
    // down, and gliding there would run every article in between past the top edge,
    // which the read-on-scroll observer counts as read. The flash is what points the
    // row out, so nothing is lost by jumping straight to it.
    window._suppressMarkRead = true;
    list.scrollTo({ top: Math.max(0, target), behavior: 'instant' });
    setTimeout(function () { window._suppressMarkRead = false; }, 300);
  }
  row.classList.add('row-just-saved');
  setTimeout(function () { row.classList.remove('row-just-saved'); }, 2000);
});

// A manual feed refresh finished — if that feed is the one currently displayed,
// reload the article list so newly fetched items appear without re-clicking it.
document.body.addEventListener('feedRefreshed', function (e) {
  var feedId = e.detail && e.detail.feed_id;
  if (!feedId || !_activeNavGet) return;
  // Anchor to a full param value so feed_id=5 doesn't match feed_id=50.
  var re = new RegExp('[?&]feed_id=' + feedId + '(?:&|$)');
  if (re.test(_activeNavGet)) {
    htmx.ajax('GET', _activeNavGet, { target: '#article-list', swap: 'innerHTML' });
  }
});

document.body.addEventListener('htmx:sendError', function (e) {
  if (!e.detail.target || e.detail.target.id !== 'article-list') return;
  if (!_navSnapshot) return;
  _showNavErrorToast();
  _revertNavSnapshot();
});

// Server returned 4xx/5xx for the article-list load — htmx leaves the old list in
// place, so revert the nav chrome to match instead of showing a stale list under a
// new title/active item.
document.body.addEventListener('htmx:responseError', function (e) {
  if (!e.detail.target || e.detail.target.id !== 'article-list') return;
  if (!_navSnapshot) return;
  _claimHtmxError(e);
  _showNavErrorToast();
  _revertNavSnapshot();
});

// A successful list load commits the new nav state — drop the snapshot so a later
// unrelated #article-list error can't revert to a stale view.
document.body.addEventListener('htmx:afterSwap', function (e) {
  if (e.detail.target && e.detail.target.id === 'article-list') _navSnapshot = null;
});

// The list's loading state (skeleton rows after 150 ms) is ui/read.js.

// Dismissing the AI error (Settings → AI) fires this via HX-Trigger; clear any
// AI error dots still rendered on the page (e.g. the side-nav "AI" badge).
document.body.addEventListener('ai-error-dismissed', function () {
  document.querySelectorAll('.ai-error-badge').forEach(function (el) { el.remove(); });
});

document.addEventListener('click', function (e) {
  var navItem = e.target.closest('.nav-item');
  if (!navItem) return;
  _saveNavSnapshot(); // capture previous nav state so a failed list load can revert
  _activeNavGet = navItem.getAttribute('hx-get');
  if (_activeNavGet) _highlightNav(_activeNavGet);
  else {
    document.querySelectorAll('.nav-item').forEach(function (i) { i.classList.remove('active'); });
    navItem.classList.add('active');
  }
  try { if (_activeNavGet) localStorage.setItem('lastNavItem', _activeNavGet); } catch (err) {}
  if (_activeNavGet) _refreshSidebarAfterNav();
});

document.body.addEventListener('htmx:afterSwap', function (evt) {
  if (evt.detail.target.id === 'sidebar') _sidebarSwappedAt = Date.now();
});

document.body.addEventListener('htmx:beforeSwap', function (evt) {
  if (evt.detail.target.id !== 'sidebar') return;
  // Preserve scroll: the feed list scrolls inside #sidebar-scroll, which lives
  // inside the swapped innerHTML and is destroyed/recreated on every refresh —
  // resetting scrollTop to 0 and jumping the list up on background refreshes
  // (e.g. the mark-as-read sidebarRefresh after opening an article).
  var oldScroll = evt.detail.target.querySelector('#sidebar-scroll');
  window._sidebarScroll = oldScroll ? oldScroll.scrollTop : 0;
  // On the initial `load` swap _activeNavGet may not be set yet (it's assigned by
  // _autoLoadArticleList, which races this fetch) — fall back to the saved nav so
  // the active category is highlighted from the first render.
  var navGet = _activeNavGet;
  if (!navGet) { try { navGet = localStorage.getItem('lastNavItem'); } catch (e) {} }
  navGet = navGet || '/htmx/articles';
  var temp = document.createElement('div');
  temp.innerHTML = evt.detail.serverResponse;
  // Each nav target is rendered twice (collapsed rail + full sidebar); highlight
  // every match so whichever one is visible shows the active state.
  var matches = temp.querySelectorAll('.nav-item[hx-get="' + navGet + '"]');
  if (matches.length) {
    temp.querySelectorAll('.nav-item').forEach(function (i) { i.classList.remove('active'); });
    matches.forEach(function (m) { m.classList.add('active'); });
  }
  evt.detail.serverResponse = temp.innerHTML;
});

// Mobile quicklink toggles between two views: Labels <-> Starred for users who
// label articles, All articles <-> Starred for everyone else (data-alt, set
// server-side).
function _mobileQuicklinkTarget() {
  var link = document.getElementById('mobile-title-quicklink');
  var useAll = link && link.dataset.alt === 'all';
  var onAlt = useAll
    ? (!_activeNavGet || _activeNavGet === '/htmx/articles')
    : (_activeNavGet && _activeNavGet.indexOf('labeled_only=true') !== -1);
  if (onAlt) return { url: '/htmx/articles?starred_only=true', title: 'Starred', text: 'Starred →' };
  if (useAll) return { url: '/htmx/articles', title: 'All articles', text: 'All →' };
  return { url: '/htmx/articles?labeled_only=true', title: 'Labels', text: 'Labels →' };
}

function _syncMobileQuicklink() {
  var text = _mobileQuicklinkTarget().text;
  var link = document.getElementById('mobile-title-quicklink');
  if (link) link.textContent = text;
}

// The nav item restored on page load, until its list arrives (see below).
var _restoredNavGet = null;

// The remembered view (and its mobile title) lives in the browser, which outlives a
// logout. When another account signs in there, forget it, so the account does not
// reopen the previous one's view (its saved search answers 404) or see its name.
// A browser with no owner recorded yet keeps what it has.
(function () {
  var list = document.getElementById('article-list');
  var owner = list && list.dataset.navOwner;
  if (!owner) return;
  try {
    var prev = localStorage.getItem('lastNavOwner');
    if (prev && prev !== owner) {
      localStorage.removeItem('lastNavItem');
      localStorage.removeItem('mobile_title_text');
    }
    localStorage.setItem('lastNavOwner', owner);
  } catch (e) {}
})();

// An offline logout (offline/page.js) could not reach POST /logout and left
// rf-logout-pending for the next online start. The sign-in and register forms
// (data-rf-login) are only rendered with no session, so there is nothing left to end:
// forget it, or the next sign-in would be logged out at once.
(function () {
  if (!document.querySelector('form[data-rf-login]')) return;
  try { localStorage.removeItem('rf-logout-pending'); } catch (e) {}
})();

// Restore last-selected nav on page load; fall back to All Articles.
// A ?view=starred|labeled deep-link (e.g. from the Stats page) overrides the
// saved nav and is consumed from the URL, like ?open_article_id.
function _autoLoadArticleList() {
  if (!document.getElementById('article-list')) return;
  var url;
  var view = window.location.search.match(/[?&]view=(starred|labeled|saved)(?:&|$)/);
  if (view) {
    url = '/htmx/articles?' + view[1] + '_only=true';
    try { localStorage.setItem('lastNavItem', url); } catch (e) {}
    // Only view= is consumed: an open_article_id next to it (the share target's
    // "Read it now") is still read from the URL by _initDeeplinkDetail.
    var rest = window.location.search.replace(/([?&])view=[^&]*&?/, '$1').replace(/[?&]$/, '');
    history.replaceState(null, '', window.location.pathname + rest);
  } else {
    var saved;
    try { saved = localStorage.getItem('lastNavItem'); } catch (e) {}
    url = saved || '/htmx/articles';
  }
  _activeNavGet = url;
  _restoredNavGet = url;
  _syncMobileQuicklink();
  htmx.ajax('GET', url, { target: '#article-list', swap: 'innerHTML' });
}

// A view that is gone comes back as a 404: the one remembered from last time (the
// browser's, not the account's, so it can be another account's from an earlier
// login), or a saved search deleted on another device and clicked in a sidebar that
// has not caught up. Forget it and open All articles, with a word only when the
// reader clicked it. _restoredNavGet (declared above _autoLoadArticleList) is
// cleared by the first list that loads, so it marks only the restore itself.
document.body.addEventListener('htmx:afterSettle', function (e) {
  if (e.detail.target && e.detail.target.id === 'article-list') _restoredNavGet = null;
});
document.body.addEventListener('htmx:responseError', function (e) {
  var d = e.detail;
  if (!d || !d.target || d.target.id !== 'article-list') return;
  if (!d.xhr || d.xhr.status !== 404) return;
  var path = (d.pathInfo && d.pathInfo.requestPath) || '';
  var restoring = !!_restoredNavGet;
  if (!restoring && path.indexOf('saved_search_id=') === -1) return;
  d._rfHandled = true;
  if (!restoring) showToast('That saved search no longer exists.', 'warning');
  _restoredNavGet = null;
  _openAllArticles();
});

// Open All articles in place of a view that is gone. Not by clicking its nav item:
// that request inherits the sidebar's hx-sync="this:abort" and is dropped while a
// sidebar refresh is in flight, which is just when a view has gone away.
function _openAllArticles() {
  _activeNavGet = '/htmx/articles';
  try {
    localStorage.removeItem('lastNavItem');
    localStorage.setItem('mobile_title_text', 'All articles');
  } catch (err) {}
  var titleText = document.getElementById('mobile-title-text');
  if (titleText) titleText.textContent = 'All articles';
  _syncMobileQuicklink();
  _highlightNav(_activeNavGet);
  htmx.ajax('GET', '/htmx/articles', { target: '#article-list', swap: 'innerHTML' });
  htmx.trigger(document.body, 'sidebarRefresh');
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _autoLoadArticleList);
} else {
  _autoLoadArticleList();
}

// On page load: restore fullscreen article from URL hash (small bucket + fullscreen mode only).
// Converts the hash URL to a list URL first (replaceState), so Back returns to the list.
function _restoreArticleFromHash() {
  if (window._getCurrentBucket() !== 'small') return;
  if (_detailModeSmall() !== 'fullscreen') return;
  var match = window.location.hash.match(/^#article-(\d+)$/);
  if (!match) return;
  history.replaceState(null, '', window.location.pathname);
  htmx.ajax('GET', '/htmx/articles/' + match[1], { target: '#article-detail', swap: 'innerHTML' });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _restoreArticleFromHash);
} else {
  _restoreArticleFromHash();
}

// On page load with a deep-link (?open_article_id=…), show the detail as a
// fullscreen overlay in non-large layouts where #article-detail is hidden.
// In the large/3-panel layout the panel is already visible — nothing to do.
function _initDeeplinkDetail() {
  // Read the URL param (not the loader element) — htmx may have already swapped it away.
  if (!/[?&]open_article_id=/.test(window.location.search)) return;
  if (window._getCurrentBucket() === 'large') return;
  document.documentElement.classList.add('deeplink-detail-open');
  // Back closes the overlay instead of leaving the app for the page the link was on
  // (the share target, Stats). The list takes over the current entry, without the id
  // so a reload lands on it, and the article gets one of its own, like the story overlay.
  history.replaceState(null, '', window.location.pathname);
  history.pushState({ deeplinkDetailOpen: true }, '');
}

// Emptied as well as lowered, for the same reason as the story overlay: the hidden
// panel would otherwise go on answering for the open article.
function _closeDeeplinkDetail() {
  if (!document.documentElement.classList.contains('deeplink-detail-open')) return false;
  if (window._dwellSend) window._dwellSend();
  document.documentElement.classList.remove('deeplink-detail-open');
  var panel = document.getElementById('article-detail');
  if (panel) panel.innerHTML = '';
  return true;
}
window._closeDeeplinkDetail = _closeDeeplinkDetail;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initDeeplinkDetail);
} else {
  _initDeeplinkDetail();
}

// ── Mobile title bar count badge ──────────────────────────────────────────
function _setTitleBarCount(count, type) {
  window._titleBarCountType = type || null;
  var badge = document.getElementById('mobile-title-count');
  if (!badge) return;
  if (count == null || count <= 0 || !type) {
    badge.className = 'hidden';
    return;
  }
  badge.textContent = count;
  if (type === 'starred' || type === 'total') {
    badge.className = 'shrink-0 text-[13px] font-medium text-gray-400 relative top-[-0.5px]';
  } else {
    badge.className = 'shrink-0 text-xs font-medium bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full';
  }
}

// The mobile title bar stands in for a saved search's own header, which base.html
// hides while the bar is shown: the search's name (as it is now, so a rename via
// Update shows too) and its Edit. Edit goes through the hidden header's data, as the
// header's own link does.
function _syncMobileTitleForView() {
  var header = document.querySelector('#article-list [data-saved-search-name]');
  var edit = document.getElementById('mobile-title-edit');
  if (edit) edit.classList.toggle('hidden', !header);
  if (!header) return;
  var titleEl = document.getElementById('mobile-title-text');
  var name = header.dataset.savedSearchName.slice(0, 40);
  if (titleEl) titleEl.textContent = name;
  try { localStorage.setItem('mobile_title_text', name); } catch (err) {}
}

// A row of the open list read or unread again (delta -1 / +1): the unread counts
// drawn over the list follow it, the mobile title bar and a saved search's header.
function _adjustUnreadCounts(delta) {
  if (window._titleBarCountType === 'unread') {
    var badge = document.getElementById('mobile-title-count');
    if (badge && !badge.classList.contains('hidden')) {
      _setTitleBarCount(Math.max(0, parseInt(badge.textContent, 10) + delta), 'unread');
    }
  }
  var el = document.querySelector('#article-list [data-view-unread-count]');
  if (!el) return;
  // Server-formatted with the reader's grouping ("1,234" / "1 234"); keep it.
  var text = el.textContent;
  var sep = (text.match(/\d(\D)\d{3}/) || [])[1] || ',';
  var n = Math.max(0, parseInt(text.replace(/\D/g, ''), 10) + delta);
  el.textContent = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

// Batched mark-as-read — collects IDs and sends one request per debounce window
var _pendingMarkRead = new Set();
var _markReadTimer = null;

function _flushMarkRead() {
  _markReadTimer = null;
  if (_pendingMarkRead.size === 0) return;
  var ids = Array.from(_pendingMarkRead);
  _pendingMarkRead.clear();
  var csrfToken = getCsrfToken();
  fetch('/htmx/articles/set-read-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrfToken },
    body: JSON.stringify({ ids: ids, unfolded: ids.filter(_storyUnfolded) }),
    credentials: 'same-origin',
    // Flushed on the way out too (visibilitychange, beforeunload), where a plain
    // request is cancelled with the page.
    keepalive: true,
  }).then(function (r) {
    if (r.ok) htmx.trigger(document.body, 'sidebarRefresh');
  }).catch(function (e) { console.warn('mark-read-batch failed:', e); });
}

// Whether this article's story is unfolded in the list, i.e. its members are rows of
// their own on screen. Reading a folded row finishes the whole story (the server does
// that, see _close_stories); reading one that is unfolded finishes only itself, since
// the rest are right there and the reader asked to see them. Only the browser knows
// which it is, so every human mark-as-read carries the answer.
//
// Both ends of the group have to answer yes. The row the group hangs from is the one
// with members under it; a member is a row carrying data-story-parent. Asking only the
// first question is how this went wrong once: a member's own id has nothing hanging
// under it, so reading one of them looked like reading a folded row and closed the
// whole group the reader had just opened.
function _storyUnfolded(id) {
  if (document.querySelector('[data-story-parent="' + id + '"]')) return true;
  var row = document.getElementById('article-row-' + id);
  return !!(row && row.hasAttribute('data-story-parent'));
}

function _queueMarkRead(id) {
  if (window._dwellSend) window._dwellSend();
  _pendingMarkRead.add(id);
  clearTimeout(_markReadTimer);
  _markReadTimer = setTimeout(_flushMarkRead, 500);
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') _flushMarkRead();
});
window.addEventListener('beforeunload', function () { _flushMarkRead(); });

// Article list: IntersectionObserver for mark-as-read on scroll
document.body.addEventListener('htmx:afterSettle', function (evt) {
  if (evt.detail.target.id !== 'article-list') return;

  var cfgEl = document.getElementById('article-list-cfg');
  if (!cfgEl) return;
  var cfg = JSON.parse(cfgEl.textContent);
  _setTitleBarCount(cfg.titleBarCount, cfg.titleBarCountType);
  _syncMobileTitleForView();

  var list = document.getElementById('article-list');
  if (!list) return;

  if (window._articleListMutationObserver) {
    window._articleListMutationObserver.disconnect();
    window._articleListMutationObserver = null;
  }
  // Disconnected, not just dropped. The mutation observer below hands every row the
  // swap adds to whatever _articleReadObserver points at, and it runs as a microtask,
  // so it has already fed the new list's rows to the previous observer by the time
  // this settle handler gets to run. Letting go of the reference leaves that observer
  // watching them, which is how a search still marked its results read after the
  // server had said not to.
  if (window._articleReadObserver) {
    window._articleReadObserver.disconnect();
    window._articleReadObserver = null;
  }

  if (!cfg.markReadOnScroll) return;

  var seen = new Set();

  // No inset needed for the mobile title bar: the shell reserves its height (see
  // base.html), so the list's own top edge already sits below it. A list header
  // (Saved, a saved search) is another matter: it is sticky inside the list, so a
  // row that has gone under it is out of sight but still inside the list's box, and
  // would only count as read one header height later, or not at all if the reader
  // stopped with it there. offsetHeight is 0 where the header is hidden (a saved
  // search under the mobile title bar).
  var listHeader = list.querySelector('[data-list-header]');
  var topOffset = listHeader ? listHeader.offsetHeight : 0;
  var bottomOffset = 0;

  // Where the list's own top edge sits, in the viewport coordinates the entry
  // rectangles use. It is not the top of the screen: in the mobile shell the list
  // starts below the fixed title bar and the status-bar inset, so a row leaves the
  // list a good deal before its rect turns negative. Comparing against 0 asked for
  // that extra distance, and the callback only runs when the visible fraction
  // crosses the threshold, i.e. as the row leaves the list and never again after
  // that, so scrolling on could not make up the difference. Every row but the last
  // is taller than the title bar alone, which is why a browser tab (no status-bar
  // inset) looked fine; installed, the last row, with exactly one list height of
  // spacer under it, could not clear it at all.
  // rootBounds is the root's rect with rootMargin applied, and can be null, hence
  // the fallback.
  function rootTopEdge(entry) {
    return entry.rootBounds ? entry.rootBounds.top : list.getBoundingClientRect().top;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      var id = el.dataset.articleId;
      var isRead = el.dataset.isRead === 'true';

      if (entry.isIntersecting) {
        seen.add(id);
      } else if (!isRead && entry.boundingClientRect.top < rootTopEdge(entry)) {
        // A jump the app made on the reader's behalf (pointing at a freshly saved
        // row) is not reading: whatever it flew past stays unread.
        if (window._suppressMarkRead) return;
        seen.delete(id);
        el.dataset.isRead = 'true';
        el.classList.add('opacity-75');
        var titleEl = el.querySelector('[data-article-title]');
        if (titleEl) {
          titleEl.classList.remove('font-bold', 'text-gray-900');
          titleEl.classList.add('font-medium', 'text-gray-800');
        }
        _queueMarkRead(id);
        _adjustUnreadCounts(-1);
      }
    });
  }, { root: list, threshold: 0.1, rootMargin: '-' + topOffset + 'px 0px -' + bottomOffset + 'px 0px' });

  window._articleReadObserver = observer;

  list.querySelectorAll('.article-row').forEach(function (el) {
    observer.observe(el);
  });

  // Watch for article rows appended by infinite scroll sentinel swaps. It hands them
  // to this observer, the one it was made alongside, rather than to whatever
  // _articleReadObserver happens to point at when it runs: it fires as a microtask,
  // which on a list swap is before the settle handler above has replaced anything, so
  // the two can disagree about which list is on screen.
  var mutObs = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        if (node.classList.contains('article-row')) {
          observer.observe(node);
        }
      });
    });
  });
  mutObs.observe(list, { childList: true });
  window._articleListMutationObserver = mutObs;
});

// Focus pw-error element when present (password change error in preferences)
function _focusPwError() {
  var el = document.getElementById('pw-error');
  if (el) el.focus();
}
document.addEventListener('DOMContentLoaded', _focusPwError);
document.body.addEventListener('htmx:afterSettle', _focusPwError);

// Article detail: auto mark-as-read timer
document.body.addEventListener('htmx:afterSettle', function (evt) {
  var targetId = evt.detail.target.id;
  var isDetailTarget = targetId === 'article-detail' || targetId === 'inline-article-detail-content';
  if (!isDetailTarget) return;

  var articleEl = evt.detail.target.querySelector('[data-article-id]');
  if (!articleEl) return;

  var articleId = articleEl.dataset.articleId;
  var isRead = articleEl.dataset.isRead === 'true';
  if (isRead) return;

  var timer = setTimeout(function () {
    var readBtn = evt.detail.target.querySelector('#read-btn-' + articleId);
    if (readBtn) {
      htmx.ajax('POST', '/htmx/articles/' + articleId + '/set-read?state=true', {
        target: '#read-btn-' + articleId,
        swap: 'innerHTML'
      });
    } else {
      // Article no longer in view — mark as read server-side only, skip UI swap.
      // Hand-built, so the htmx:configRequest hook further down never sees it: the
      // unfolded answer has to be put in the body here.
      var csrfToken = getCsrfToken();
      fetch('/htmx/articles/' + articleId + '/set-read?state=true', {
        method: 'POST',
        headers: {
          'x-csrftoken': csrfToken,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'story_unfolded=' + (_storyUnfolded(articleId) ? 'true' : 'false'),
      }).then(function (r) {
        if (!r.ok) console.warn('mark-as-read fallback failed: ' + r.status);
      }).catch(function () {});
    }
  }, 500);

  evt.detail.target.addEventListener(
    'htmx:beforeRequest', function () { clearTimeout(timer); }, { once: true }
  );
});

// Reset scroll to top when a new article loads into #article-detail
document.body.addEventListener('htmx:afterSwap', function (e) {
  if (e.detail.target.id === 'article-detail') e.detail.target.scrollTop = 0;
});

// Story block: bring the unfolded list into view when it needs it. It sits at the end of
// the article, so it often opens below the fold and the reader is left hunting for what
// they just asked to see.
//
// 'nearest', not 'end': 'end' aligns the block's bottom with the bottom of the viewport
// whether or not that is needed, so unfolding it while it sat near the top of the screen
// dragged it down, which reads as the page scrolling the wrong way. 'nearest' moves by
// the smallest amount that puts the end of the list on screen, and by nothing at all when
// it is already there.
document.body.addEventListener('htmx:afterSettle', function (e) {
  var id = e.detail.target.id || '';
  if (id.indexOf('story-members-') !== 0) return;
  var block = document.getElementById('story-block-' + id.slice('story-members-'.length));
  if (block) block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ── Story block: open another article covering the same story ─────────────────
// Not plain hx-get on the link: in every layout but the 3-panel one #article-detail is
// display:none, so a link aimed at it would look like a dead click.
//
// Where the reader sits in the inline shell (2-panel, and the small bucket in inline
// mode) the member gets a surface of its own rather than the shell. Swapping the shell
// left the list row above it describing one article and the content below it another,
// which on a short article looked like nothing had happened at all. The surface is
// #article-detail raised over the list, the same overlay the deep-link path already uses
// in those layouts (.deeplink-detail-open in base.html); the list stays in the DOM
// underneath with its scroll position, so closing is removing a class.
//
// Elsewhere there is nothing to raise: the 3-panel layout has the panel open beside the
// list, and the small bucket in fullscreen mode is already in this overlay, where a
// member replaces the article the same way the next one does.
function _openStoryMember(link, id) {
  var cl = document.documentElement.classList;
  // Anything already covering the list is a surface of its own: the phone's fullscreen
  // reader, a deep-linked article, or this overlay one member deep. On all of them the
  // member replaces the article the way the next one does, and raising a second overlay
  // over the first would only add a press of Back per article looked at.
  var raised = cl.contains('story-detail-open') || cl.contains('deeplink-detail-open') ||
               cl.contains('mobile-detail-open');
  // Never the article the list already has open, over itself. Every id in a detail but a
  // handful is built from the article's own id, so two details of one article mean two of
  // each: two #star-btn-N, two #read-btn-N, two #story-members-N. htmx resolves an
  // hx-target to the first in the document, which is the copy under the window, so the
  // window's own controls would work on something nobody can see, and its footer would
  // unfold into the dark. Asking for that article is asking to go back to it, since it is
  // the one the window was opened from, so that is what this does.
  var shell = document.getElementById('inline-article-detail');
  if (shell && shell.dataset.articleId === String(id)) {
    if (_closeStoryOverlay()) history.back();
    // The row, not the shell. The shell is only the body, hung under the row the article
    // was opened from, and the title inside it is hidden as a duplicate of the row's own
    // (hideDuplicateH1), so putting the shell at the top leaves the article headless.
    var row = document.querySelector('#article-list .article-row[data-article-id="' + id + '"]');
    if (row) scrollListRowToTop(row);
    else shell.scrollIntoView({ block: 'start' });
    return;
  }
  // The link goes along as the request's source. An inline layout turns every request
  // aimed at the panel into a row expansion (the beforeRequest guard further down this
  // file), and that guard needs something on the request to tell this one apart —
  // without it the request is cancelled and the window comes up empty.
  htmx.ajax('GET', '/htmx/articles/' + id, {
    source: link, target: '#article-detail', swap: 'innerHTML'
  });
  if (!_shouldUseInline() || raised) return;
  cl.add('story-detail-open');
  // No URL: a reload should land on the list, not on an article opened for its coverage.
  history.pushState({ storyDetailOpen: true }, '');
}

// Closing empties the panel as well as lowering it. #article-detail is the first place
// currentDetailArticleEl and the share lookups look, ahead of the inline shell, so a
// member left behind in a hidden panel would answer for the article the reader is
// actually on. Dwell is flushed before that and re-armed after, else the rest of the
// reading session on the underlying article is lost.
function _closeStoryOverlay() {
  if (!document.documentElement.classList.contains('story-detail-open')) return false;
  if (window._dwellSend) window._dwellSend();
  document.documentElement.classList.remove('story-detail-open');
  var panel = document.getElementById('article-detail');
  if (panel) panel.innerHTML = '';
  if (window._dwellResume) window._dwellResume();
  return true;
}
window._closeStoryOverlay = _closeStoryOverlay;

document.addEventListener('click', function (e) {
  var link = e.target.closest('[data-open-story-member]');
  if (!link) return;
  e.preventDefault();
  _openStoryMember(link, link.dataset.openStoryMember);
});

// Hardware Back and the browser's Back button. Not folded into the mobile popstate
// handler further down this file: that one returns early off the small bucket, and this
// overlay opens in the 2-panel layout on a desktop too.
window.addEventListener('popstate', function (e) {
  var state = e.state || {};
  if (state.storyDetailOpen || state.deeplinkDetailOpen) return;
  _closeStoryOverlay();
  _closeDeeplinkDetail();
});

// The read button and the set-read endpoint carry the same answer as the scroll batch:
// htmx builds these requests from attributes in the template, and whether a story is
// unfolded is not something a template can know, so it is added here on the way out.
//
// The path arrives exactly as the caller wrote it, query string and all, so the match
// has to end at the '?' as readily as at the end of the string: every set-read call in
// this file carries ?state=true, and an end-anchored pattern quietly matched none of
// them. The one hand-built set-read request is above and adds the parameter itself.
document.body.addEventListener('htmx:configRequest', function (e) {
  var m = /\/htmx\/articles\/(\d+)\/(read|set-read)(?:\?|$)/.exec(e.detail.path || '');
  if (m && _storyUnfolded(m[1])) e.detail.parameters.story_unfolded = 'true';
});

// ── Story rows: unfold the rest of a group under its row in the list ──────────
// The members arrive as ordinary list rows and are inserted after the row that was
// clicked, so opening, starring and labelling one of them needs nothing new: it is a
// row like its neighbours, only indented. Folding back up is removing them again,
// which is why this is a handler and not a pair of hx- attributes.
//
// Rows inserted here are watched by the list's IntersectionObserver (its mutation
// observer picks up new children), so they mark themselves read on scroll as any row
// does. That is the point: they are on screen because the reader asked for them.
//
// Capture phase, which is the one thing here that is not obvious. Every element in a
// row carrying data-stop-propagation is given a click listener that stops the event
// (further down this file), so that a control inside a row does not also open the
// article. The toggle needs that mark for the same reason, and a listener on document
// would then never see the click at all: capture runs on the way down, before the
// button's own listeners. The row's own request is cancelled for it in htmx:confirm.
document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('[data-story-toggle]');
  if (!btn) return;
  e.preventDefault();
  var id = btn.dataset.storyToggle;

  function setState(open) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    var caret = btn.querySelector('[data-story-caret]');
    if (caret) caret.textContent = open ? '▴' : '▾';
  }

  var shown = document.querySelectorAll('[data-story-parent="' + id + '"]');
  if (shown.length) {
    shown.forEach(function (el) { el.remove(); });
    setState(false);
    return;
  }

  var row = document.getElementById('article-row-' + id);
  if (!row) return;
  // Disabled at once, so a second click cannot send the same request again, but the
  // look of being busy is held back. The rows are one indexed query and a few hundred
  // bytes, so the round trip is over well inside the tenth of a second that reads as
  // instant, and a chip that dims and undims inside two frames reads as a fault rather
  // than as progress. Past this point the wait is long enough to want an answer, and
  // still far short of the second or so where a reader starts to wonder.
  btn.disabled = true;
  var dimming = setTimeout(function () { btn.classList.add('opacity-60'); }, 300);

  function done() {
    clearTimeout(dimming);
    btn.classList.remove('opacity-60');
    btn.disabled = false;
  }
  // Density travels with the request: the row knows which one it was rendered at, and
  // a member drawn at a different one would break the rhythm of the list it lands in.
  // The list's own filters travel with it too, so what comes back is what this list
  // folded rather than the whole group. Without them a label list would unfold
  // articles that were never in it, and those rows mark themselves read on scroll.
  var url = '/htmx/articles/' + id + '/story-rows'
    + '?density=' + encodeURIComponent(row.dataset.density || '')
    + (row.dataset.storyScope ? '&' + row.dataset.storyScope : '');
  var loaded = htmx.ajax('GET', url, { target: '#article-row-' + id, swap: 'afterend' });
  if (loaded && loaded.then) {
    loaded.then(function () {
      done();
      setState(document.querySelector('[data-story-parent="' + id + '"]') !== null);
    }, done);
  } else {
    done();
  }
}, true);

// ── The row whose article is open in the detail pane ──────────────────────────
// Read off the detail rather than set where the click happens. Every way an article
// reaches the pane ends in a swap into #article-detail — a row click, the
// ?open_article_id deep link, the Next button — so one place covers all of them, and
// a row the server re-rendered (the row-poll on a saved article, an out-of-band swap,
// infinite scroll) gets its mark back at the next settle instead of losing it.
//
// Which layouts show it is left to CSS: the class is kept up to date everywhere and
// only the 3-panel layout draws it, so switching layout cannot strand a stale mark.
(function () {
  var ACTIVE = 'article-active';

  function syncActiveRow() {
    var list = document.getElementById('article-list');
    if (!list) return;
    var open = document.querySelector('#article-detail [data-article-id]');
    var row = open
      ? list.querySelector('.article-row[data-article-id="' + open.dataset.articleId + '"]')
      : null;
    list.querySelectorAll('.' + ACTIVE).forEach(function (el) {
      if (el !== row) el.classList.remove(ACTIVE);
    });
    if (row) row.classList.add(ACTIVE);
  }

  document.body.addEventListener('htmx:afterSettle', syncActiveRow);
  document.addEventListener('DOMContentLoaded', syncActiveRow);
})();

// Feed subscribe form: auto-check "Private feed" when auth fields are filled
// Delegation also covers a form inserted into the shared Sources sheet later.
document.addEventListener('input', function (e) {
  var target = e.target;
  if (!target || (target.id !== 'feed-auth-user' && target.id !== 'feed-auth-pass')) return;
  var authUser = document.getElementById('feed-auth-user');
  var authPass = document.getElementById('feed-auth-pass');
  if (!(authUser && authUser.value.trim()) && !(authPass && authPass.value)) return;
  var cb = document.getElementById('feed-is-private');
  if (cb) cb.checked = true;
});

// ── Dwell stop on bottom un-star ───────────────────────────────────────────
document.body.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-bottom-star]');
  if (!btn) return;
  if (!btn._optimisticStarred) return;
  if (window._dwellSend) window._dwellSend();
});

// ── Link-opened tracking ───────────────────────────────────────────────────
// Top-level so the auto-open handler below can report a programmatic window.open,
// which never trips the delegated anchor listener.
function recordLinkOpened(articleId) {
  if (!articleId) return;
  fetch('/htmx/articles/' + articleId + '/link-opened', {
    method: 'POST',
    keepalive: true,
    credentials: 'include',
    headers: { 'x-csrftoken': getCsrfToken() },
  });
}

document.body.addEventListener('click', function (e) {
  var link = e.target.closest('a[target="_blank"]');
  if (!link) return;
  var row = link.closest('[data-article-id]');
  if (!row) return;
  recordLinkOpened(row.dataset.articleId);
});

// ── Search modal ───────────────────────────────────────────────────────────
// The saved search the list came from (window._activeSavedSearchId): set when one
// runs, kept while the reader tries changes to it with Search, so reopening the
// modal from those results edits it again with Update / Save as new at hand.
// Cleared by a fresh search and by leaving search for a feed or list.
function openSearchModal(prefill, savedId) {
  var overlay = document.getElementById('search-modal-overlay');
  if (overlay) overlay.classList.remove('hidden');
  // Marks the drawer's backdrop as redundant while this one is up (see base.html).
  document.documentElement.classList.add('search-modal-open');
  // Only restore the previous query/scope when reopening from the results header
  // (prefill); a fresh search from the menu or the "/" shortcut starts empty.
  window._searchPrefill = !!prefill;
  if (!prefill && !savedId) window._activeSavedSearchId = null;
  var url = '/htmx/search-modal';
  if (savedId && !prefill) {
    // The pencil in the saved list: the server fills the form from what is stored.
    url += '?saved_id=' + encodeURIComponent(savedId);
  } else if (prefill) {
    var qs = [];
    if (window._activeSavedSearchId) {
      qs.push('saved_id=' + encodeURIComponent(window._activeSavedSearchId));
      qs.push('edited=true');
    }
    if (window._lastSearchScope) qs.push('scope=' + encodeURIComponent(window._lastSearchScope));
    if (window._lastSearchSort) qs.push('sort=' + encodeURIComponent(window._lastSearchSort));
    if (window._lastSearchStatus) qs.push('status=' + encodeURIComponent(window._lastSearchStatus));
    if (window._lastSearchLabels) qs.push('labels=' + encodeURIComponent(window._lastSearchLabels));
    if (window._lastSearchScoreSource) qs.push('score_source=' + encodeURIComponent(window._lastSearchScoreSource));
    if (window._lastSearchScoreOp) qs.push('score_op=' + encodeURIComponent(window._lastSearchScoreOp));
    if (window._lastSearchScoreVal) qs.push('score_val=' + encodeURIComponent(window._lastSearchScoreVal));
    if (window._lastSearchSince) qs.push('since_days=' + encodeURIComponent(window._lastSearchSince));
    if (window._lastSearchState) qs.push('state=' + encodeURIComponent(window._lastSearchState));
    if (qs.length) url += '?' + qs.join('&');
  }
  htmx.ajax('GET', url, { target: '#search-modal-content', swap: 'innerHTML' });
  if (overlay && window.visualViewport && !_searchVvpListener) {
    _searchVvpListener = function () { _fitSearchToVisualViewport(overlay); };
    _fitSearchToVisualViewport(overlay);
    window.visualViewport.addEventListener('resize', _searchVvpListener);
    window.visualViewport.addEventListener('scroll', _searchVvpListener);
  }
}

// A phone's on-screen keyboard shrinks only the visual viewport, so the fixed
// overlay kept its full height and the lower half of the form sat behind the
// keyboard, out of reach of the modal's own scroll. Fitting the overlay to the
// visible area keeps the modal's foot above the keyboard (same trick as chat).
var _searchVvpListener = null;
function _fitSearchToVisualViewport(overlay) {
  var vv = window.visualViewport;
  overlay.style.top = vv.offsetTop + 'px';
  overlay.style.height = vv.height + 'px';
  overlay.style.bottom = 'auto';
  // The field you tapped may have ended up below the new, shorter box.
  var active = document.activeElement;
  if (active && active !== document.body && overlay.contains(active)) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function closeSearchModal() {
  var overlay = document.getElementById('search-modal-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.top = '';
    overlay.style.height = '';
    overlay.style.bottom = '';
  }
  if (_searchVvpListener && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', _searchVvpListener);
    window.visualViewport.removeEventListener('scroll', _searchVvpListener);
    _searchVvpListener = null;
  }
  document.documentElement.classList.remove('search-modal-open');
  // Drop the contents with it. The overlay is shown the moment you open the modal,
  // but its markup is fetched, so whatever was left from last time (your previous
  // scope and label chips, most visibly) sat there until the new copy arrived and
  // replaced it. The box holds its height from CSS while it is empty, so opening it
  // is a plain fade-in rather than a flash of the old state. Nothing reads these
  // fields while the modal is closed: the query and filters are remembered in
  // window._lastSearch*, and the chips are rendered server-side on reopen.
  var content = document.getElementById('search-modal-content');
  if (content) content.innerHTML = '';
}

// The Score row: Any is no condition, and picking a scorer brings the operator,
// the number and the note with it.
document.addEventListener('change', function (e) {
  if (!e.target || e.target.id !== 'search-score-source') return;
  var off = e.target.value === 'any';
  document.querySelectorAll('.search-score-cond').forEach(function (el) {
    // Keeps its place on a wide screen, gives it up where the columns stack.
    el.classList.toggle('invisible', off);
    el.classList.toggle('max-sm:hidden', off);
  });
  var note = document.getElementById('search-score-note');
  if (note) note.classList.toggle('hidden', off);
});

// The modal's search as the list endpoint's parameters, remembered as the last
// search on the way. Null (with focus on the field to fix) when it can't run.
function collectSearch() {
  var input = document.getElementById('search-input');
  if (!input) return null;
  var q = input.value.trim();
  // Multi-select scope: hidden input holds a JSON array like ["feed:1","folder:2"].
  var scopeEl = document.getElementById('search-scope-value');
  var scopeVal = scopeEl ? scopeEl.value.trim() : '';
  // Sort: relevance (default) | newest | oldest | score.
  var sortEl = document.getElementById('search-sort');
  var sortVal = sortEl ? sortEl.value : 'relevance';
  // Status: all (default, no filter) | unread | read.
  var statusEl = document.getElementById('search-status');
  var statusVal = statusEl ? statusEl.value : 'all';
  // Labels: JSON array like ["any"] or ["label:3"]. Empty = no label filter.
  var labelsEl = document.getElementById('search-labels-value');
  var labelsVal = labelsEl ? labelsEl.value.trim() : '';
  // Score: source (any | ai | basic | relevance), condition (gte | lt) and value.
  // Any is no condition. The row is only there when the reader has a scorer running.
  var scoreSrcEl = document.getElementById('search-score-source');
  var scoreOpEl = document.getElementById('search-score-op');
  var scoreValEl = document.getElementById('search-score-val');
  var scoreSrc = scoreSrcEl ? scoreSrcEl.value : 'any';
  var scoreActive = scoreSrc !== 'any';
  var scoreOp = scoreOpEl ? scoreOpEl.value : 'gte';
  var scoreVal = scoreValEl ? scoreValEl.value.trim() : '';
  if (scoreActive && (scoreVal === '' || !scoreValEl.checkValidity())) {
    scoreValEl.focus();
    if (scoreValEl.reportValidity) scoreValEl.reportValidity();
    return null;
  }
  if (!scoreActive) { scoreSrc = ''; scoreVal = ''; }
  // Published: days back from now, empty = any time.
  var sinceEl = document.getElementById('search-since');
  var sinceVal = sinceEl ? sinceEl.value : '';
  // List: starred | saved | archived, empty = any article.
  var stateEl = document.getElementById('search-state');
  var stateVal = stateEl ? stateEl.value : '';

  // Empty text is allowed as a pure filter view, but only when at least one
  // filter is set (sorting by score counts, that is the "best first" list);
  // otherwise it's just "all articles", so nudge for input.
  var hasFilter = !!scopeVal || !!labelsVal || (statusVal && statusVal !== 'all')
    || scoreActive || sortVal === 'score' || !!sinceVal || !!stateVal;
  if (!q && !hasFilter) { input.focus(); return null; }
  // With no words there is nothing to rank by relevance, and the list comes back
  // newest first. Say so, so reopening the modal shows the order actually used.
  if (!q && sortVal === 'relevance') sortVal = 'newest';

  window._lastSearchQuery = q;
  window._lastSearchScope = scopeVal;
  window._lastSearchSort = sortVal;
  window._lastSearchStatus = statusVal;
  window._lastSearchLabels = labelsVal;
  window._lastSearchScoreSource = scoreSrc;
  window._lastSearchScoreOp = scoreActive ? scoreOp : '';
  window._lastSearchScoreVal = scoreVal;
  window._lastSearchSince = sinceVal;
  window._lastSearchState = stateVal;
  return lastSearchParams();
}

// The last search (window._lastSearch*) as the list endpoint's parameters. Also what
// the results header saves, since that is the search those results came from.
function lastSearchParams() {
  var params = new URLSearchParams();
  if (window._lastSearchQuery) params.set('q', window._lastSearchQuery);
  if (window._lastSearchScope) params.set('scope_include', window._lastSearchScope);
  params.set('sort', window._lastSearchSort || 'relevance');
  var status = window._lastSearchStatus;
  if (status && status !== 'all') params.set('read_status', status);
  if (window._lastSearchLabels) params.set('label_filter', window._lastSearchLabels);
  // A score sort with Any sends no source, and the router sorts by AI, else basic,
  // the number the list shows.
  if (window._lastSearchScoreOp) {
    params.set('score_source', window._lastSearchScoreSource);
    params.set('score_op', window._lastSearchScoreOp);
    params.set('score_val', window._lastSearchScoreVal);
  }
  if (window._lastSearchSince) params.set('since_days', window._lastSearchSince);
  if (window._lastSearchState) params.set('state', window._lastSearchState);
  return params;
}

function _closeSearchForResults() {
  closeSearchModal();
  // On mobile the search modal is opened from inside the sidebar overlay; close
  // it so the results are immediately visible instead of hidden behind it.
  if (window._closeMobileSidebarOverlay) window._closeMobileSidebarOverlay();
}

// Run the last search. With a saved search it relates to, the results header says
// whether it still matches that one (Saved) or offers Update / Save as new.
function _runLastSearch() {
  var params = lastSearchParams();
  if (window._activeSavedSearchId) params.set('saved_ref', window._activeSavedSearchId);
  htmx.ajax('GET', '/htmx/articles?' + params.toString(), { target: '#article-list', swap: 'innerHTML' });
}

function submitSearch() {
  if (!collectSearch()) return;
  // Trying changes to a saved search keeps it the one being edited.
  var savedIdEl = document.getElementById('saved-search-id');
  window._activeSavedSearchId = savedIdEl ? savedIdEl.value : null;
  _runLastSearch();
  _closeSearchForResults();
}

// ── Saved searches ─────────────────────────────────────────────────────────
// Saving never swaps the list: the results stay search results, and a saved search
// behaves like a feed only when opened from the sidebar. The server answers with a
// savedSearchesChanged event, or puts a mistake on the form's error line.
var _savingFrom = null;  // 'modal' | 'header', for the event handler below

function runSavedSearch(id) {
  htmx.ajax('GET', '/htmx/articles?saved_search_id=' + encodeURIComponent(id),
    { target: '#article-list', swap: 'innerHTML' });
  _closeSearchForResults();
}

function _postSavedSearch(url, params, extra, from) {
  var values = {};
  params.forEach(function (v, k) { values[k] = v; });
  Object.keys(extra).forEach(function (k) { values[k] = extra[k]; });
  _savingFrom = from;
  htmx.ajax('POST', url, { swap: 'none', values: values });
}

function _savedSearchUrl(id) {
  return id ? '/htmx/saved-searches/' + encodeURIComponent(id) : '/htmx/saved-searches';
}

// The edit form in the search window: Update, or Save as new under the name typed.
function saveSearchFromModal(asNew) {
  var params = collectSearch();
  if (!params) return;
  var nameEl = document.getElementById('saved-search-name');
  var errEl = document.getElementById('saved-search-error');
  if (errEl) errEl.textContent = '';
  if (!nameEl || !nameEl.value.trim()) {
    if (nameEl) nameEl.focus();
    if (errEl) errEl.textContent = 'Give the search a name.';
    return;
  }
  var savedIdEl = document.getElementById('saved-search-id');
  _postSavedSearch(_savedSearchUrl(asNew ? null : savedIdEl && savedIdEl.value), params,
    { name: nameEl.value, error_target: 'saved-search-error' }, 'modal');
}

// The results header: the name field that opens under it, and Update.
function _headerSaveForm(show) {
  var header = document.querySelector('[data-search-header]');
  var form = header && header.querySelector('[data-save-search-form]');
  if (!form) return;
  form.classList.toggle('hidden', !show);
  // The form has its own Save; the link that opened it would be a second one.
  var area = header.querySelector('[data-save-search-area]');
  if (area) area.classList.toggle('hidden', show);
  var err = document.getElementById('header-save-error');
  if (err) err.textContent = '';
  if (show) document.getElementById('header-save-name').focus();
}

function saveSearchFromHeader() {
  var nameEl = document.getElementById('header-save-name');
  var errEl = document.getElementById('header-save-error');
  if (errEl) errEl.textContent = '';
  if (!nameEl || !nameEl.value.trim()) {
    if (nameEl) nameEl.focus();
    if (errEl) errEl.textContent = 'Give the search a name.';
    return;
  }
  _postSavedSearch(_savedSearchUrl(null), lastSearchParams(),
    { name: nameEl.value, error_target: 'header-save-error' }, 'header');
}

function updateSearchFromHeader(id) {
  // No name in the form: the saved search keeps its own.
  _postSavedSearch(_savedSearchUrl(id), lastSearchParams(),
    { error_target: 'header-save-error' }, 'header');
}

// The button asks twice itself (swap-confirm), like the other deletes.
function deleteSavedSearch(id) {
  htmx.ajax('POST', '/htmx/saved-searches/' + encodeURIComponent(id) + '/delete', { swap: 'none' });
}

document.body.addEventListener('savedSearchesChanged', function (e) {
  var from = _savingFrom;
  _savingFrom = null;
  window._activeSavedSearchId = String(e.detail.id);
  // A new or renamed search has to show up in the sidebar.
  htmx.trigger(document.body, 'sidebarRefresh');
  if (from === 'modal') {
    var current = document.querySelector('[data-search-header]');
    if (current && current.dataset.savedSearchId === String(e.detail.id)) {
      // Edited from its own view: back to that view, with the new parameters.
      runSavedSearch(e.detail.id);
    } else {
      // Edited from search results: back to them, now of the saved parameters.
      _runLastSearch();
      _closeSearchForResults();
    }
    return;
  }
  // From the header: the results are already these, only the header changes.
  var header = document.querySelector('[data-search-header]');
  if (!header) return;
  header.dataset.savedRef = e.detail.id;
  _headerSaveForm(false);
  var area = header.querySelector('[data-save-search-area]');
  if (area) {
    area.innerHTML = '<span class="text-gray-400" aria-hidden="true">·</span>' +
      '<span class="text-gray-500 whitespace-nowrap"></span>';
    area.lastChild.textContent = 'Saved';
    area.lastChild.title = 'Saved as “' + e.detail.name + '”';
  }
});

document.body.addEventListener('savedSearchDeleted', function (e) {
  closeSearchModal();
  htmx.trigger(document.body, 'sidebarRefresh');
  if (String(window._activeSavedSearchId) !== String(e.detail.id)) return;
  window._activeSavedSearchId = null;
  var header = document.querySelector('[data-search-header]');
  if (header && header.dataset.savedSearchId) {
    // Viewing the deleted search, which was the active sidebar item.
    _openAllArticles();
  } else if (header) {
    // Results of a search related to it: the same results, now unsaved.
    _runLastSearch();
  }
});

// A list that arrives with a saved search's header (or a search related to one)
// makes it the active one; a saved search's also sets the last search to its
// parameters. A list without any search header ends search.
document.body.addEventListener('htmx:afterSettle', function (evt) {
  if (!evt.detail.target || evt.detail.target.id !== 'article-list') return;
  var header = evt.detail.target.querySelector('[data-search-header]');
  if (!header) { window._activeSavedSearchId = null; return; }
  if (header.dataset.savedRef) { window._activeSavedSearchId = header.dataset.savedRef; return; }
  if (!header.dataset.savedSearchId) return;
  window._activeSavedSearchId = header.dataset.savedSearchId;
  var v;
  try { v = JSON.parse(header.dataset.savedSearchValues || '{}'); } catch (err) { return; }
  window._lastSearchQuery = v.q || '';
  window._lastSearchScope = v.scope || '';
  window._lastSearchSort = v.sort || '';
  window._lastSearchStatus = v.status || '';
  window._lastSearchLabels = v.labels || '';
  window._lastSearchScoreSource = v.score_source || '';
  window._lastSearchScoreOp = v.score_op || '';
  window._lastSearchScoreVal = v.score_val || '';
  window._lastSearchSince = v.since_days || '';
  window._lastSearchState = v.state || '';
});

// Focus search input when modal loads
document.body.addEventListener('htmx:afterSettle', function (evt) {
  if (evt.detail.target.id === 'search-modal-content') {
    var input = document.getElementById('search-input');
    if (input) {
      // Pre-fill with the previous query only when reopening from the results
      // header, so "search again" is one keystroke away.
      if (window._searchPrefill && window._lastSearchQuery) input.value = window._lastSearchQuery;
      input.focus();
      input.select();
    }
  }
});

// ── Search hits ────────────────────────────────────────────────────────────
// Marks the searched words in the result rows' titles and snippets. Done here, not
// on the server: it only has to catch the common case (the word in the title or at
// the start of the text), and the server's matching (stems, the index) can't be
// mirrored exactly anyway. Accents are ignored and a word matches by its beginning,
// with a common English ending dropped first, so "vote" also marks "voting".
function _foldForSearch(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Chinese, Japanese and Korean, the class CJK_CHARS in relevance_service.py. These
// have no spaces between words, so a CJK term is marked wherever it stands, one
// character included (the search finds those in titles).
var _CJK_RUN = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿가-힯ᄀ-ᇿ㄰-㆏]+/g;

function _searchHitTerms(query) {
  var terms = [];
  // A quoted phrase counts as its words; "-word" is excluded, so it's no hit; "or"
  // is an operator.
  query.replace(/"/g, ' ').split(/\s+/).forEach(function (w) {
    if (!w || w.charAt(0) === '-' || w.toLowerCase() === 'or') return;
    // Marks stay: folding keeps a kana's voicing mark (が is か + ゙) in the text too.
    w = _foldForSearch(w.replace(/\*+$/, '')).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
    // "OpenAI发布" is two terms, a Latin word and a CJK one.
    (w.match(_CJK_RUN) || []).forEach(function (run) { terms.push(run); });
    w = w.replace(_CJK_RUN, '');
    var stem = w.replace(/(ing|ed|es|s|e)$/, '');
    if (stem.length >= 3) w = stem;
    if (w.length >= 2) terms.push(w);
  });
  return terms;
}

function _highlightIn(el, terms) {
  var text = el.textContent;
  // Fold one character at a time, keeping where each folded one came from, so a
  // match in the folded text maps back onto the original.
  var folded = '', origin = [];
  for (var i = 0; i < text.length; i++) {
    var f = _foldForSearch(text.charAt(i));
    for (var k = 0; k < f.length; k++) { folded += f.charAt(k); origin.push(i); }
  }
  var hits = [];
  terms.forEach(function (t) {
    var lead = t.match(_CJK_RUN) ? '()' : '(^|[^\\p{L}\\p{N}])';
    var re = new RegExp(lead + '(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gu');
    var m;
    while ((m = re.exec(folded))) {
      var start = m.index + m[1].length;
      hits.push([origin[start], origin[start + m[2].length - 1] + 1]);
    }
  });
  if (!hits.length) return;
  hits.sort(function (a, b) { return a[0] - b[0]; });
  var frag = document.createDocumentFragment(), pos = 0;
  hits.forEach(function (h) {
    if (h[0] < pos) return;  // overlaps a hit already marked
    if (h[0] > pos) frag.appendChild(document.createTextNode(text.slice(pos, h[0])));
    var mark = document.createElement('mark');
    mark.className = 'search-hit';
    mark.textContent = text.slice(h[0], h[1]);
    frag.appendChild(mark);
    pos = h[1];
  });
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  el.textContent = '';
  el.appendChild(frag);
}

function highlightSearchHits() {
  var list = document.getElementById('article-list');
  var header = list && list.querySelector('[data-search-query]');
  if (!header) return;
  var terms = _searchHitTerms(header.getAttribute('data-search-query') || '');
  if (!terms.length) return;
  // Rows arrive in pages, unfolded stories and polled replacements: mark each once.
  list.querySelectorAll('[data-article-title]:not([data-hl]), [data-article-snippet]:not([data-hl])')
    .forEach(function (el) {
      el.setAttribute('data-hl', '');
      _highlightIn(el, terms);
    });
}
document.body.addEventListener('htmx:afterSettle', highlightSearchHits);

// ── Feedback modal ─────────────────────────────────────────────────────────
function openFeedbackModal() {
  var overlay = document.getElementById('feedback-modal-overlay');
  if (!overlay) return;
  var content = document.getElementById('feedback-modal-content');
  if (content) {
    content.innerHTML = '<div class="py-6 flex items-center justify-center gap-2 text-sm text-gray-400">' +
      '<svg class="animate-spin h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">' +
      '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
      '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8z"></path>' +
      '</svg>Loading…</div>';
  }
  overlay.classList.remove('hidden');
  htmx.ajax('GET', '/htmx/feedback', { target: '#feedback-modal-content', swap: 'innerHTML' });
}

function closeFeedbackModal() {
  var overlay = document.getElementById('feedback-modal-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// The shortcuts sheet: a native modal <dialog> (app/partials/shortcuts_dialog.html), so
// the browser traps focus in it and Escape closes it.
function _shortcutsOpen() {
  var dlg = document.getElementById('shortcuts-dialog');
  return !!(dlg && dlg.open);
}

function openShortcutsModal() {
  var dlg = document.getElementById('shortcuts-dialog');
  // showModal() throws on a dialog that is already open.
  if (!dlg || dlg.open || typeof dlg.showModal !== 'function') return;
  var opener = document.activeElement;
  // Focus goes back to where it was, however the dialog closes, unless another dialog
  // took over meanwhile ('/' closes this one and opens the palette): close fires after.
  dlg.addEventListener('close', function () {
    if (document.querySelector('dialog[open]')) return;
    if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (err) { /* an opener that cannot take focus */ }
    }
  }, { once: true });
  dlg.showModal();
}

function closeShortcutsModal() {
  var dlg = document.getElementById('shortcuts-dialog');
  if (dlg && dlg.open) dlg.close();
}

// A click on the backdrop lands on the <dialog> itself (its panel is the child):
// it closes the sheet, as a click beside the old overlay did.
document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'shortcuts-dialog') closeShortcutsModal();
});

// The command palette (ui/palette.js, RFPalette) where the page has it, the search
// modal where it does not. Answers whether anything could open, so a key the page
// cannot use stays with the browser.
function _paletteReady() {
  return !!(window.RFPalette && typeof window.RFPalette.open === 'function');
}

function _paletteIsOpen() {
  if (!_paletteReady()) return false;
  if (typeof window.RFPalette.isOpen === 'function') return !!window.RFPalette.isOpen();
  var dlg = document.getElementById('rf-palette');
  return !!(dlg && dlg.open);
}

function _openPalette() {
  if (_paletteReady()) {
    if (!_paletteIsOpen()) window.RFPalette.open();
    return true;
  }
  if (!document.getElementById('search-modal-overlay')) return false;
  openSearchModal(false);
  return true;
}

function _closePalette() {
  if (typeof window.RFPalette.close === 'function') { window.RFPalette.close(); return; }
  var dlg = document.getElementById('rf-palette');
  if (dlg && dlg.open) dlg.close();
}

// ⌘K / Ctrl+K: opens the palette, or closes it when it is up.
function _togglePalette() {
  if (!_paletteIsOpen()) return _openPalette();
  _closePalette();
  return true;
}

// The K of ⌘K / Ctrl+K: e.key when it is a Latin letter, else the physical key.
function _isPaletteKey(e) {
  var key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if (/^[a-z]$/.test(key)) return key === 'k';
  return e.code === 'KeyK';
}

// An open Basecoat dropdown menu or popover (the account menu, the View menu, the
// article's ··· menu): its trigger says aria-expanded="true".
var _OPEN_MENU_TRIGGER = '.dropdown-menu > button[aria-expanded="true"], '
  + '.popover > button[aria-expanded="true"], [aria-haspopup][aria-expanded="true"]';
function _openMenuTriggers() {
  return Array.prototype.slice.call(document.querySelectorAll(_OPEN_MENU_TRIGGER));
}

function _closeOpenMenus() {
  _openMenuTriggers().forEach(function (trigger) {
    var holder = trigger.parentElement;
    if (holder && typeof holder.close === 'function') { holder.close(); return; }
    trigger.setAttribute('aria-expanded', 'false');
    var pop = holder && holder.querySelector(':scope > [data-popover]');
    if (pop) pop.setAttribute('aria-hidden', 'true');
  });
}

// Whether a menu was open when the current key went down. Basecoat closes its menu on
// Escape from a listener on the menu itself, which runs before the document's, so by
// the time app.js hears that Escape the menu already looks closed. Recorded in the
// capture phase, ahead of Basecoat.
var _kbMenuAtKeydown = false;
document.addEventListener('keydown', function () {
  _kbMenuAtKeydown = _openMenuTriggers().length > 0;
}, true);

// Is any modal up? Asked before Escape is handed to anything underneath them. Any open
// <dialog> counts: the shortcuts sheet, the palette and the Basecoat dialogs; so does an
// open menu or popover.
function _anyModalOpen() {
  if (_openMenuTriggers().length) return true;
  if (document.documentElement.classList.contains('search-modal-open')) return true;
  if (document.querySelector('dialog[open]')) return true;
  var feedback = document.getElementById('feedback-modal-overlay');
  return !!(feedback && !feedback.classList.contains('hidden'));
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
// The set follows Google Reader as Inoreader and Miniflux kept it (j/k, o, m, v,
// Shift+A, ?), with the TT-RSS keys as aliases (n/p, u, s), so readers coming from
// either keep their habits. The list a reader sees is app/partials/shortcuts.html;
// a key added here goes there too.
//
// Every action goes through the control a click would use (the row, the ··· menu of
// the open article, the sidebar), so the optimistic star, the read counts, dwell and
// the 2-panel inline shell all behave exactly as they do with the mouse.

// The article the last j/k or row click landed on. In the 2-panel layout the reader
// can close the article again, and j should then carry on from it, not from the top.
var _kbCursorId = null;

document.addEventListener('click', function (e) {
  var row = e.target.closest('#article-list .article-row');
  if (row && !e.target.closest('[data-stop-propagation]')) _kbCursorId = row.dataset.articleId;
  // A picker opened with the mouse is used with the mouse: no focus moved into it.
  if (e.isTrusted && e.target.closest('[data-label-trigger]')) _kbPickerFocus = null;
}, true);

document.body.addEventListener('htmx:afterSwap', function (e) {
  if (e.detail.target && e.detail.target.id === 'article-list') _kbCursorId = null;
});

// The open article: the one in the story overlay when that is up, the inline one in
// the 2-panel layout (and on a phone set to read inline), the panel otherwise. On a
// phone reading full-screen the panel keeps its last article after Back, so it only
// counts while it is on screen.
function _kbOpenArticle() {
  var html = document.documentElement;
  var box;
  if (html.classList.contains('story-detail-open') || html.classList.contains('deeplink-detail-open')) {
    box = document.getElementById('article-detail');
  } else if (_shouldUseInline()) {
    box = document.getElementById('inline-article-detail-content');
  } else {
    if (html.dataset.bucket === 'small' && !html.classList.contains('mobile-detail-open')) return null;
    box = document.getElementById('article-detail');
  }
  return box ? box.querySelector('[data-article-id]') : null;
}

function _kbRows() {
  var list = document.getElementById('article-list');
  return list ? Array.prototype.slice.call(list.querySelectorAll('.article-row')) : [];
}

// Keep the row j/k moved to in sight. The inline shell scrolls its row to the top by
// itself; the 3-panel list only needs the row not to be cut off.
function _kbRevealRow(row) {
  var list = document.getElementById('article-list');
  if (!list) return;
  var box = list.getBoundingClientRect();
  var r = row.getBoundingClientRect();
  if (r.top < box.top + listStickyOffset()) scrollListRowToTop(row);
  else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
}

function _kbOpenRow(row) {
  if (!row) return;
  _kbCursorId = row.dataset.articleId;
  row.click();
  if (!_shouldUseInline()) _kbRevealRow(row);
}

function _kbMove(step) {
  var rows = _kbRows();
  if (!rows.length) return;
  var open = _kbOpenArticle();
  var id = open ? open.dataset.articleId : _kbCursorId;
  var at = -1;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].dataset.articleId === id) { at = i; break; }
  }
  // Nothing open yet: either key starts at the top, the way a list is read.
  _kbOpenRow(at === -1 ? rows[0] : rows[at + step]);
}

function _kbToggleOpen() {
  var open = _kbOpenArticle();
  if (open) {
    // Only the inline shell closes; the 3-panel detail stays as it is.
    if (!_shouldUseInline()) return;
    var expanded = document.querySelector('#article-list .article-row.inline-expanded');
    if (expanded) expanded.click();
    return;
  }
  var row = _kbCursorId && document.getElementById('article-row-' + _kbCursorId);
  _kbOpenRow(row || _kbRows()[0]);
}

// A control in the ··· menu of the open article. The menu is usually closed, which
// does not matter to click().
function _kbArticleControl(selector) {
  var open = _kbOpenArticle();
  var control = open && open.querySelector(selector);
  if (control) control.click();
}

function _kbReload() {
  if (document.querySelector('#article-list [data-save-search-area]')) { _runLastSearch(); return; }
  htmx.ajax('GET', _activeNavGet || '/htmx/articles', { target: '#article-list', swap: 'innerHTML' });
  htmx.trigger(document.body, 'sidebarRefresh');
}

// The ✓ on the sidebar row of the view that is open. Online it is not asked first: the
// toast that follows has Undo (ui/read.js, owner answer Q1). Offline there is no Undo,
// so the question stays: by keyboard it is a single slip.
function _kbMarkAllRead() {
  if (document.querySelector('#article-list [data-save-search-area]')) {
    showToast('Search results can’t be marked read all at once', 'info');
    return;
  }
  var active = document.querySelectorAll('.nav-item.active');
  for (var i = 0; i < active.length; i++) {
    var row = active[i].closest('.mark-read-row');
    var btn = row && row.querySelector('[data-action="mark-read"]');
    if (!btn) continue;
    if (navigator.onLine !== false || confirm('Mark everything in this view as read?')) btn.click();
    return;
  }
}

function _kbGoTo(url) {
  var item = document.querySelector('#sidebar-full .nav-item[hx-get="' + url + '"]') ||
             document.querySelector('.nav-item[hx-get="' + url + '"]');
  if (item) item.click();
}

// Shift+J / Shift+K: the next or previous entry of the sidebar, top to bottom as it is
// drawn (views, saved searches, labels, folders, feeds), skipping what a collapsed
// section hides. The way TT-RSS and Inoreader walk their trees, and like them it
// does not skip a feed with nothing unread. It stops at either end rather than wrap.
function _kbSidebarStep(step) {
  var full = document.getElementById('sidebar-full');
  if (!full) return;
  var items = Array.prototype.filter.call(full.querySelectorAll('.nav-item[hx-get]'), function (a) {
    return !a.closest('.collapsible.collapsed');
  });
  if (!items.length) return;
  var at = -1;
  for (var i = 0; i < items.length; i++) {
    if (items[i].classList.contains('active')) { at = i; break; }
  }
  var next = at === -1 ? items[step > 0 ? 0 : items.length - 1] : items[at + step];
  if (!next) return;
  next.click();
  next.scrollIntoView({ block: 'nearest' });
}

// t: the label picker of the open article. Focus goes into it, so the arrows, Enter
// and Esc do the rest without the mouse.
function _kbLabels() {
  var open = _kbOpenArticle();
  var trigger = open && open.querySelector('[data-label-trigger]');
  if (!trigger) return;
  _kbPickerFocus = 0;
  trigger.click();
}

var _kbPickerFocus = null;

document.body.addEventListener('htmx:afterSettle', function (e) {
  if (_kbPickerFocus === null || !e.detail.target || e.detail.target.id !== 'label-picker') return;
  // Toggling a label redraws the picker, so the focus goes back to the same line.
  var buttons = e.detail.target.querySelectorAll('button[hx-post]');
  var btn = buttons[Math.min(_kbPickerFocus, buttons.length - 1)];
  if (btn) btn.focus();
});

document.addEventListener('keydown', function (e) {
  var picker = document.getElementById('label-picker');
  if (!picker || picker.classList.contains('hidden') || !picker.contains(e.target)) return;
  if (e.key === 'Escape') { _kbPickerFocus = null; e.target.blur(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  var buttons = Array.prototype.slice.call(picker.querySelectorAll('button[hx-post]'));
  var at = buttons.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1);
  if (at >= 0 && at < buttons.length) buttons[at].focus();
});

document.addEventListener('focusin', function (e) {
  var picker = document.getElementById('label-picker');
  if (_kbPickerFocus === null || !picker || !picker.contains(e.target)) return;
  var buttons = Array.prototype.slice.call(picker.querySelectorAll('button[hx-post]'));
  var at = buttons.indexOf(e.target);
  if (at !== -1) _kbPickerFocus = at;
});

// Space: a screen further down the article, and the next article once the end of this
// one is in sight, as in Google Reader and Inoreader. Shift+Space goes back up.
function _kbSpace(back) {
  var inline = _shouldUseInline() && !document.documentElement.classList.contains('story-detail-open');
  var surface = document.getElementById(inline ? 'article-list' : 'article-detail');
  if (!surface) return;
  var page = surface.clientHeight * 0.85;
  if (back) { surface.scrollBy({ top: -page, behavior: 'smooth' }); return; }
  var open = _kbOpenArticle();
  var atEnd;
  if (inline) {
    var shell = document.getElementById('inline-article-detail');
    atEnd = !open || !shell || shell.getBoundingClientRect().bottom <= surface.getBoundingClientRect().bottom + 2;
  } else {
    atEnd = !open || surface.scrollTop + surface.clientHeight >= surface.scrollHeight - 2;
  }
  if (atEnd) {
    // The story overlay is one article, there is no next one to go to.
    if (!document.documentElement.classList.contains('story-detail-open')) _kbMove(1);
    return;
  }
  surface.scrollBy({ top: page, behavior: 'smooth' });
}

// Another window over the reader: keys belong to it, not to the list underneath.
function _kbCovered() {
  if (_anyModalOpen()) return true;
  var html = document.documentElement;
  if (html.classList.contains('mobile-sidebar-open')) return true;
  var ids = ['general-chat-modal', 'briefing-modal-overlay', 'label-picker'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el && !el.classList.contains('hidden')) return true;
  }
  return !!document.querySelector('[id^="chat-modal-"]:not(.hidden)');
}

var _kbPendingG = 0;

document.addEventListener('keydown', function (e) {
  // ⌘K / Ctrl+K: the command palette, from anywhere, fields included (the palette's own
  // field closes it again). Taken before the modifier rule below hands Ctrl and Cmd to
  // the browser. AltGr (Ctrl+Alt on Windows), Alt and Shift combinations stay with the
  // browser (Ctrl+Shift+K is Firefox's console), and so does a page with neither the
  // palette nor the search modal. On a layout without Latin letters (Russian: e.key is
  // a Cyrillic letter) the physical K key (e.code 'KeyK') counts; where e.key is a
  // Latin letter it decides, so Dvorak's Ctrl+K is the key labelled K.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing
      && _isPaletteKey(e)
      && !(e.getModifierState && e.getModifierState('AltGraph'))) {
    if (_shortcutsOpen()) closeShortcutsModal();
    if (_togglePalette()) e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    // Whatever is on top answers for it. The story overlay is over the list, but the
    // modals are drawn over the overlay (one z-index higher) and '/' opens the search one
    // from there, so taking the overlay first left the modal hanging over a window that
    // had gone. The overlay is next in line, and it has a history entry to go back
    // through rather than just a class to drop.
    // The palette is drawn over everything, the search modal included: Escape closes
    // the palette alone (here rather than by the browser's own cancel, so the event is
    // spent on it and nothing under it closes too).
    if (_paletteIsOpen()) { e.preventDefault(); _closePalette(); return; }
    // An open menu or popover takes this Escape alone (S3W-F5): it closes, and nothing
    // under it closes or goes back.
    if (_kbMenuAtKeydown) { _closeOpenMenus(); return; }
    if (_anyModalOpen()) { closeSearchModal(); closeFeedbackModal(); closeShortcutsModal(); return; }
    if (window._closeStoryOverlay && window._closeStoryOverlay()) { history.back(); return; }
    if (window._closeDeeplinkDetail && window._closeDeeplinkDetail()) { history.back(); return; }
    closeSearchModal(); closeFeedbackModal(); closeShortcutsModal(); return;
  }
  if (e.key === 'Enter' && e.target.id === 'search-input') { submitSearch(); return; }
  // Enter in a name field saves: the edited search in the window, a new one under
  // the results header.
  if (e.key === 'Enter' && e.target.id === 'saved-search-name') { saveSearchFromModal(false); return; }
  if (e.key === 'Enter' && e.target.id === 'header-save-name') { saveSearchFromHeader(); return; }

  var t = e.target;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
  // Ctrl, Alt and Cmd combinations belong to the browser. AltGr is Ctrl+Alt on Windows
  // and is how some layouts type '/' or '?', so it does not count.
  var altGr = e.getModifierState && e.getModifierState('AltGraph');
  if (e.metaKey || ((e.ctrlKey || e.altKey) && !altGr)) return;
  if (e.isComposing) return;

  if (e.key === '?') {
    if (!document.getElementById('shortcuts-dialog')) return;
    e.preventDefault();
    if (_shortcutsOpen()) closeShortcutsModal();
    else if (!_kbCovered()) openShortcutsModal();
    return;
  }
  // '/': the command palette, as ⌘K, but it only opens (in its field '/' is typed).
  if (e.key === '/') {
    if (_shortcutsOpen()) closeShortcutsModal();
    if (_openPalette()) e.preventDefault();
    return;
  }
  // The rest act on the reader, which has to be on this page and in front.
  if (!document.getElementById('article-list') || _kbCovered()) return;

  if (_kbPendingG) {
    var fresh = Date.now() - _kbPendingG < 1500;
    _kbPendingG = 0;
    if (fresh && (e.key === 'a' || e.key === 's')) {
      e.preventDefault();
      _kbGoTo(e.key === 'a' ? '/htmx/articles' : '/htmx/articles?starred_only=true');
      return;
    }
  }

  // The story overlay is one article over the list: the keys for it work, moving
  // through the list under it does not.
  var overStory = document.documentElement.classList.contains('story-detail-open');
  var handled = true;
  switch (e.key) {
    case 'j': case 'n': if (!overStory) _kbMove(1); break;
    case 'k': case 'p': if (!overStory) _kbMove(-1); break;
    case 'o': if (!overStory) _kbToggleOpen(); break;
    case 'Enter':
      // A focused link or button keeps its own Enter.
      if (t !== document.body || overStory) { handled = false; break; }
      _kbToggleOpen();
      break;
    case 'm': case 'u': _kbArticleControl('[data-header-read]'); break;
    case 's': case 'f': _kbArticleControl('[data-header-star]'); break;
    case 'e': _kbArticleControl('[data-header-archive]'); break;
    case 'v': _kbArticleControl('.article-detail-title-row [data-external-link]'); break;
    case ' ':
      if (t !== document.body) { handled = false; break; }
      _kbSpace(e.shiftKey);
      break;
    case 't': case 'T': case 'l': _kbLabels(); break;
    case 'J': if (!overStory) _kbSidebarStep(1); break;
    case 'K': if (!overStory) _kbSidebarStep(-1); break;
    case 'r': if (!overStory) _kbReload(); break;
    case 'A': if (!overStory) _kbMarkAllRead(); break;
    case 'g': if (!overStory) _kbPendingG = Date.now(); break;
    default: handled = false;
  }
  if (handled) e.preventDefault();
});

// ── data-action delegation ─────────────────────────────────────────────────
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  // Every "Search" entry opens the palette; the search modal stays its fallback.
  if (action === 'open-search') { if (!_openPalette()) openSearchModal(false); return; }
  if (action === 'open-shortcuts') { openShortcutsModal(); return; }
  if (action === 'mark-all-read') { _kbMarkAllRead(); return; }
  if (action === 'reload-list') { _kbReload(); return; }
  if (action === 'open-search-again') { openSearchModal(true); return; }
  if (action === 'close-search') { closeSearchModal(); return; }
  if (action === 'open-feedback-modal') { openFeedbackModal(); return; }
  if (action === 'close-feedback-modal') { closeFeedbackModal(); return; }
  if (action === 'submit-search') { submitSearch(); return; }
  if (action === 'run-saved-search') { runSavedSearch(el.dataset.savedId); return; }
  if (action === 'edit-saved-search') { openSearchModal(false, el.dataset.savedId); return; }
  if (action === 'save-search-new') { saveSearchFromModal(true); return; }
  if (action === 'save-search-update') { saveSearchFromModal(false); return; }
  if (action === 'open-save-search-inline') { _headerSaveForm(true); return; }
  if (action === 'close-save-search-inline') { _headerSaveForm(false); return; }
  if (action === 'save-search-inline') { saveSearchFromHeader(); return; }
  if (action === 'update-search-inline') { updateSearchFromHeader(el.dataset.savedId); return; }
  if (action === 'delete-saved-search') { deleteSavedSearch(el.dataset.savedId); return; }
  if (action === 'select-all') { el.select(); return; }
  if (action === 'refresh-articles') {
    // Clearing search returns to the active nav category (where you were before
    // searching), so the list matches the still-highlighted nav item.
    htmx.ajax('GET', _activeNavGet || '/htmx/articles', { target: '#article-list', swap: 'innerHTML' });
    return;
  }

});

// A control in the ··· menu of one article's detail, asked for by article rather than
// taken as the first in the document. The panel and the inline shell each carry a
// detail, and while the story overlay is up they carry different articles: the update
// went to the menu under the overlay, so the article being read kept the state it was
// opened with and the one underneath took a change it never got.
// Found by walking up from each control rather than down from an id: the two details
// share every fixed id in article_detail.html, and a selector starting at one of those
// ids is exactly what an engine is free to answer from its id map, first match only.
function _detailMenuControl(articleId, attr) {
  var controls = document.querySelectorAll('[' + attr + ']');
  for (var i = 0; i < controls.length; i++) {
    var root = controls[i].closest('[data-article-id]');
    if (root && root.dataset.articleId === String(articleId)) return controls[i];
  }
  return null;
}

// A line in the story footer, wherever one names this article. The list is rendered
// once, when it is unfolded, so what happens to an article in the window opened from it
// has to be written back here or the reader returns to the state they left.
// The class names mirror story_members.html.
function _syncStoryFooterLine(articleId, isRead) {
  var READ = ['text-gray-500', 'dark:text-gray-400'];
  var UNREAD = ['text-gray-900', 'dark:text-gray-100', 'font-medium'];
  document.querySelectorAll('[data-story-member="' + articleId + '"]').forEach(function (item) {
    var mark = item.querySelector('[data-story-member-read]');
    // Exactly one of hidden / inline-flex: v4 emits .inline-flex after .hidden.
    if (mark) { mark.classList.toggle('hidden', !isRead); mark.classList.toggle('inline-flex', isRead); }
    var title = item.querySelector('[data-open-story-member]');
    if (!title) return;
    READ.forEach(function (c) { title.classList.toggle(c, isRead); });
    UNREAD.forEach(function (c) { title.classList.toggle(c, !isRead); });
  });
}

// ── Article read state (class toggle, no DOM swap) ────────────────────────
// The open (read) and closed (unread) envelope, as article_detail.html and
// article_content.html draw them; static strings, no user text.
var _READ_ICON_PATH = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 10.07V19a2 2 0 01-2 2H5a2 2 0 01-2-2v-8.93M21 10.07A2 2 0 0020.11 8.4l-7-4.667a2 2 0 00-2.22 0L3.9 8.4A2 2 0 003 10.07M21 10.07l-7.44 4.96a2 2 0 01-2.12 0L3 10.07"/>';
var _UNREAD_ICON_PATH = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>';
function _setReadIcon(svg, isRead) {
  if (!svg) return;
  if (isRead) {
    svg.classList.replace('text-gray-400', 'text-gray-600');
    svg.innerHTML = _READ_ICON_PATH;
  } else {
    svg.classList.replace('text-gray-600', 'text-gray-400');
    svg.innerHTML = _UNREAD_ICON_PATH;
  }
}

document.addEventListener('articleReadChanged', function (e) {
  var detail = e.detail;
  _syncStoryFooterLine(detail.id, detail.isRead);
  document.querySelectorAll('.article-bottom-bar[data-article-id="' + detail.id + '"] [data-bottom-read]').forEach(function (btn) {
    _setReadIcon(btn.querySelector('svg'), detail.isRead);
  });
  var headerRead = _detailMenuControl(detail.id, 'data-header-read');
  if (headerRead) {
    _setReadIcon(headerRead.querySelector('svg'), detail.isRead);
    var hrLabel = headerRead.querySelector('[data-label]');
    if (hrLabel) hrLabel.textContent = detail.isRead ? 'Mark as unread' : 'Mark as read';
  }
  var row = document.getElementById('article-row-' + detail.id);
  if (!row) return;
  var isRead = detail.isRead;
  var wasRead = row.dataset.isRead === 'true';
  if (isRead !== wasRead) _adjustUnreadCounts(isRead ? -1 : 1);
  row.classList.toggle('opacity-75', isRead);
  row.dataset.isRead = isRead ? 'true' : 'false';
  var title = row.querySelector('p, [data-article-title]');
  if (title) {
    if (isRead) {
      title.classList.remove('font-bold', 'text-gray-900');
      title.classList.add('font-medium', 'text-gray-800');
    } else {
      title.classList.remove('font-medium', 'text-gray-800');
      title.classList.add('font-bold', 'text-gray-900');
    }
  }
});

document.addEventListener('articleStarChanged', function (e) {
  var detail = e.detail;
  var bottomBar = document.querySelector('.article-bottom-bar[data-article-id="' + detail.id + '"]');
  if (bottomBar && !bottomBar.classList.contains('hidden')) {
    var bsBtn = bottomBar.querySelector('[data-bottom-star]');
    if (bsBtn) {
      var bsSpan = bsBtn.querySelector('span');
      if (bsSpan) {
        bsSpan.textContent = detail.isStarred ? '★' : '☆';
        bsSpan.className = 'text-base leading-none ' + (detail.isStarred ? 'text-gray-600' : 'text-gray-300');
      }
      bsBtn.title = detail.isStarred ? 'Remove star' : 'Star';
    }
  }
  // The story footer, where this article may well have been opened from. Its list is
  // rendered once, when it is unfolded, so without this the star it was given in the
  // window over it is missing from the line the reader comes back to. All of them, not
  // the first: two articles of one story each have a footer naming the rest.
  document.querySelectorAll(
    '[data-story-member="' + detail.id + '"] [data-story-member-star]'
  ).forEach(function (el) {
    el.textContent = detail.isStarred ? '★' : '';
    if (detail.isStarred) el.setAttribute('title', 'Starred');
    else el.removeAttribute('title');
  });
  var headerStar = _detailMenuControl(detail.id, 'data-header-star');
  if (headerStar) {
    var hsSvg = headerStar.querySelector('svg');
    if (hsSvg) hsSvg.setAttribute('fill', detail.isStarred ? 'currentColor' : 'none');
    var hsLabel = headerStar.querySelector('[data-label]');
    if (hsLabel) hsLabel.textContent = detail.isStarred ? 'Starred' : 'Star';
  }
  if (e.target === document && window._titleBarCountType === 'starred') {
    var badge = document.getElementById('mobile-title-count');
    if (badge && !badge.classList.contains('hidden')) {
      var cur = parseInt(badge.textContent, 10);
      _setTitleBarCount(Math.max(0, cur + (detail.isStarred ? 1 : -1)), 'starred');
    }
  }
  var row = document.getElementById('article-row-' + detail.id);
  if (!row) return;
  var btn = row.querySelector('[data-star-btn]');
  if (!btn) return;
  var isStarred = detail.isStarred;
  var isRead = row.dataset.isRead === 'true';
  var span = btn.querySelector('span');
  if (span) {
    var sizeClass = (span.className.match(/text-(?:xs|sm|base|lg|xl)/) || ['text-base'])[0];
    if (isStarred) {
      span.textContent = '★';
      span.className = sizeClass + ' ' + (isRead ? 'text-gray-700' : 'text-gray-900');
    } else {
      span.textContent = '☆';
      span.className = sizeClass + ' text-gray-300 hover:text-gray-500';
    }
  }
  btn.title = isStarred ? 'Remove star' : 'Star article';
});

// Starring queues a summary that runs in the background. If the article is open,
// pull in the polling spinner so the reader can see one is being generated.
document.addEventListener('summaryStarted', function (e) {
  var id = e.detail && e.detail.id;
  var block = id ? document.getElementById('ai-summary-' + id) : null;
  if (!block) return;
  htmx.ajax('GET', '/htmx/articles/' + id + '/ai-summary/poll', { target: block, swap: 'outerHTML' });
});

// Optimistic star toggle: fire articleStarChanged immediately on click, revert on error.
// One path for list rows ([data-star-btn]), the detail bottom bar ([data-bottom-star])
// and the detail header menu ([data-header-star]).
var _STAR_SELECTOR = '[data-star-btn], [data-bottom-star], [data-header-star]';

function _starArticleId(btn) {
  var row = btn.closest('.article-row');
  if (row) return row.dataset.articleId ? parseInt(row.dataset.articleId, 10) : NaN;
  var bar = btn.closest('.article-bottom-bar');
  if (bar) return bar.dataset.articleId ? parseInt(bar.dataset.articleId, 10) : NaN;
  // header-menu star: the id is on the article this button belongs to. Asked of the
  // document instead, the answer is whichever detail comes first in it, and the panel
  // and the inline shell can hold different articles at once (the story overlay).
  var own = btn.closest('[data-article-id]');
  if (own) return own.dataset.articleId ? parseInt(own.dataset.articleId, 10) : NaN;
  var el = document.querySelector('#article-detail [data-article-id], #inline-article-detail-content [data-article-id]');
  return el ? parseInt(el.dataset.articleId, 10) : NaN;
}

function _starIsStarred(btn) {
  var svg = btn.querySelector('svg');           // detail header star
  if (svg) return svg.getAttribute('fill') === 'currentColor';
  var span = btn.querySelector('span');         // list rows + bottom bar use a ★ glyph
  return !!(span && span.textContent.trim() === '\u2605');
}

document.addEventListener('click', function (e) {
  var btn = e.target.closest(_STAR_SELECTOR);
  if (!btn) return;
  var articleId = _starArticleId(btn);
  if (isNaN(articleId)) return;
  var wasStarred = _starIsStarred(btn);
  btn._optimisticStarred = wasStarred;
  document.dispatchEvent(new CustomEvent('articleStarChanged', {
    detail: { id: articleId, isStarred: !wasStarred }
  }));
}, true);

function _revertOptimisticStar(elt) {
  var btn = elt && elt.closest ? elt.closest(_STAR_SELECTOR) : null;
  if (!btn || typeof btn._optimisticStarred === 'undefined') return;
  var articleId = _starArticleId(btn);
  if (isNaN(articleId)) return;
  document.dispatchEvent(new CustomEvent('articleStarChanged', {
    detail: { id: articleId, isStarred: btn._optimisticStarred }
  }));
  delete btn._optimisticStarred;
}

// These two deliberately do not claim the error: putting the star back says that it did
// not stick, not why, and a star bouncing back on its own is exactly the kind of thing
// the app-wide fallback exists to explain. Starring several articles quickly enough to
// hit the rate limit is the case that needs the words.
document.body.addEventListener('htmx:sendError', function (e) { _revertOptimisticStar(e.detail.elt); });
document.body.addEventListener('htmx:responseError', function (e) { _revertOptimisticStar(e.detail.elt); });
document.body.addEventListener('htmx:afterRequest', function (e) {
  var btn = e.detail.elt && e.detail.elt.closest ? e.detail.elt.closest(_STAR_SELECTOR) : null;
  if (btn) delete btn._optimisticStarred;
});

document.addEventListener('articleArchiveChanged', function (e) {
  var detail = e.detail;
  var bottomBar = document.querySelector('.article-bottom-bar[data-article-id="' + detail.id + '"]');
  if (bottomBar && !bottomBar.classList.contains('hidden')) {
    var baBtn = bottomBar.querySelector('[data-bottom-archive]');
    if (baBtn) {
      var baSvg = baBtn.querySelector('svg');
      if (baSvg) {
        baSvg.classList.toggle('text-gray-700', detail.isArchived);
        baSvg.classList.toggle('dark:text-gray-200', detail.isArchived);
        baSvg.classList.toggle('text-gray-400', !detail.isArchived);
        baSvg.classList.toggle('dark:text-gray-500', !detail.isArchived);
      }
      baBtn.title = detail.isArchived ? 'Unarchive' : 'Archive';
    }
  }
  var headerArchive = _detailMenuControl(detail.id, 'data-header-archive');
  if (headerArchive) {
    var haSvg = headerArchive.querySelector('svg');
    if (haSvg) {
      haSvg.classList.toggle('text-gray-700', detail.isArchived);
      haSvg.classList.toggle('text-gray-400', !detail.isArchived);
    }
    var haLabel = headerArchive.querySelector('[data-label]');
    if (haLabel) haLabel.textContent = detail.isArchived ? 'Archived' : 'Archive';
  }
  var row = document.getElementById('article-row-' + detail.id);
  if (!row) return;
  var indicator = row.querySelector('[data-archived-indicator]');
  if (indicator) indicator.classList.toggle('hidden', !detail.isArchived);
});

document.body.addEventListener('htmx:afterSettle', function (e) {
  var id = e.detail.target.id || '';
  if (!id.startsWith('archive-btn-')) return;
  var archiveBtn = e.detail.target.querySelector('button');
  var isArchived = !!(archiveBtn && archiveBtn.classList.contains('bg-gray-100'));
  var articleId = id.replace('archive-btn-', '');
  var bottomBar = document.querySelector('.article-bottom-bar[data-article-id="' + articleId + '"]');
  if (!bottomBar) return;
  var baBtn = bottomBar.querySelector('[data-bottom-archive]');
  if (!baBtn) return;
  var baSvg = baBtn.querySelector('svg');
  if (baSvg) {
    baSvg.classList.toggle('text-gray-700', isArchived);
    baSvg.classList.toggle('dark:text-gray-200', isArchived);
    baSvg.classList.toggle('text-gray-400', !isArchived);
    baSvg.classList.toggle('dark:text-gray-500', !isArchived);
  }
  baBtn.title = isArchived ? 'Unarchive' : 'Archive';
});

// ── Label picker ──────────────────────────────────────────────────────────
(function () {
  function closePicker() {
    var p = document.getElementById('label-picker');
    if (p) p.classList.add('hidden');
  }

  var _pickerTriggerRect = null;

  function _vh() { return window.visualViewport ? window.visualViewport.height : window.innerHeight; }

  // Position picker near trigger; open above if not enough space below
  document.body.addEventListener('htmx:beforeRequest', function (e) {
    if (!e.target.hasAttribute('data-label-trigger')) return;
    _pickerTriggerRect = e.target.getBoundingClientRect();
    // Opened from the keyboard (t), the trigger in the article's bottom bar can be far
    // off screen. The picker then opens in the upper middle of the window instead.
    var r = _pickerTriggerRect;
    if (!r.width || r.bottom < 0 || r.top > _vh()) {
      var y = Math.round(_vh() / 4);
      _pickerTriggerRect = { left: Math.max(4, (window.innerWidth - 220) / 2), top: y, bottom: y };
    }
    var p = document.getElementById('label-picker');
    if (!p) return;
    var left = _pickerTriggerRect.left;
    if (left + 220 > window.innerWidth) left = window.innerWidth - 224;
    var spaceBelow = _vh() - _pickerTriggerRect.bottom;
    var top = spaceBelow < 300
      ? Math.max(4, _pickerTriggerRect.top - 300 - 2)
      : _pickerTriggerRect.bottom + 2;
    p.style.top = top + 'px';
    p.style.left = left + 'px';
    p.classList.remove('hidden');
  });

  // After content loads, fine-tune with actual picker height
  document.body.addEventListener('htmx:afterSettle', function (e) {
    if (!_pickerTriggerRect) return;
    var p = document.getElementById('label-picker');
    if (!p || p.classList.contains('hidden')) return;
    var rect = _pickerTriggerRect;
    _pickerTriggerRect = null;
    requestAnimationFrame(function () {
      var h = p.offsetHeight;
      var spaceBelow = _vh() - rect.bottom;
      p.style.top = (spaceBelow < h + 8
        ? Math.max(4, rect.top - h - 2)
        : rect.bottom + 2) + 'px';
    });
  });

  // Close on outside click
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close-picker]')) { closePicker(); return; }
    if (!e.target.closest('#label-picker') && !e.target.closest('[data-label-trigger]')) {
      closePicker();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePicker();
  });
})();

// ── Article list resizer ───────────────────────────────────────────────────
(function () {
  var KEY_3 = 'article-list-width';
  var KEY_2 = 'article-list-width-2';
  var MIN_WIDTH = 200;
  var MAX_WIDTH = 1600;

  function is2panel() { return document.documentElement.dataset.layout === '2'; }
  function storageKey() { return is2panel() ? KEY_2 : KEY_3; }

  function defaultWidth2panel() {
    // article max-w-208 + px-6 both sides = 832 + 48 = 880px, capped at available space
    var sidebar = document.getElementById('sidebar');
    var available = window.innerWidth - (sidebar ? sidebar.offsetWidth : 224) - 4;
    return Math.min(880, Math.max(MIN_WIDTH, available));
  }

  function applyWidth(px) {
    var el = document.getElementById('article-list');
    if (el) el.style.width = px + 'px';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var key = storageKey();
    var saved = parseInt(localStorage.getItem(key), 10);
    if (saved && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
      applyWidth(saved);
    } else if (is2panel()) {
      applyWidth(defaultWidth2panel());
    }

    var resizer = document.getElementById('article-list-resizer');
    if (!resizer) return;

    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var list = document.getElementById('article-list');
      var startX = e.clientX;
      var startWidth = list.offsetWidth;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      resizer.classList.add('bg-blue-500');

      function onMove(e) {
        var sidebar = document.getElementById('sidebar');
        var maxAvail = window.innerWidth - (sidebar ? sidebar.offsetWidth : 0) - 4;
        var w = Math.min(maxAvail, Math.max(MIN_WIDTH, startWidth + e.clientX - startX));
        applyWidth(w);
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        resizer.classList.remove('bg-blue-500');
        var list = document.getElementById('article-list');
        if (list) localStorage.setItem(storageKey(), list.offsetWidth);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
})();

// ── 2-panel: inline article detail ────────────────────────────────────────
(function () {
  var INLINE_ID = 'inline-article-detail';
  var CONTENT_ID = INLINE_ID + '-content';

  // sameTabFallback defaults to true: when the user clicked a link, navigating this
  // tab is the honest outcome of a blocked popup. Pass false for opens the user did
  // not ask for — throwing the reader out of the app on a plain row click would lose
  // the list position and scroll. Returns whether a tab actually opened.
  function openExternal(url, sameTabFallback) {
    // Do not pass a features string — window.open with 'noopener' intentionally returns null
    // even on success, making the blocked-popup check unreliable. Modern browsers apply
    // noopener by default for cross-origin _blank. Fall back to same-tab only when truly blocked.
    var w = window.open(url, '_blank');
    if (!w && sameTabFallback !== false) window.location.href = url;
    return !!w;
  }

  function currentDetailArticleId() {
    var el = document.querySelector('#article-detail [data-article-id]');
    return el ? el.dataset.articleId : null;
  }

  // Articles with nothing to show: open the source straight from the click, while the
  // user gesture is still live. Doing it after the HTMX response would be a bare
  // window.open and the popup blocker would eat it.
  document.addEventListener('click', function (e) {
    if (document.documentElement.dataset.openOriginalEmpty !== '1') return;
    var row = e.target.closest('.article-row');
    if (!row || !row.dataset.noBody || !row.dataset.url) return;
    // Star and label buttons, whose clicks never open the row (htmx:confirm below).
    if (e.target.closest('[data-stop-propagation]')) return;
    // An expanded row is handled by the collapse path and by the title handler above,
    // either of which would otherwise produce a second tab.
    if (_shouldUseInline() && row.classList.contains('inline-expanded')) return;
    // 3-panel has no expanded class, so without this a repeat click on the article
    // already in the detail pane opens another tab.
    if (currentDetailArticleId() === row.dataset.articleId) return;
    if (!openExternal(row.dataset.url, false)) return;
    // The delegated tracker already covers a real anchor click; avoid a duplicate POST.
    if (!e.target.closest('a[target="_blank"]')) recordLinkOpened(row.dataset.articleId);
    if (window._trackExternalVisit) window._trackExternalVisit(row.dataset.articleId);
    // No preventDefault: HTMX still loads the detail behind the new tab.
  }, true);

  // Title <a> click handling: prevent native navigation except when row is expanded in 2-panel
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-article-title]');
    if (!a || !a.href) return;
    var row = a.closest('.article-row');
    if (!row) return;
    var isExpanded = _shouldUseInline() && row.classList.contains('inline-expanded');
    if (isExpanded) {
      e.stopImmediatePropagation(); // block HTMX
      e.preventDefault();
      if (row.dataset.density === 'compact') {
        closeInline();
      }
      openExternal(a.href);
    } else {
      e.preventDefault(); // block link navigation, let HTMX load detail
    }
  }, true);

  // External links in article detail panel: use openExternal for popup-blocked fallback
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-external-link]');
    if (!a || !a.href) return;
    e.preventDefault();
    openExternal(a.href);
  });

  function closeInline() {
    var el = document.getElementById(INLINE_ID);
    if (el) el.remove();
    var expandedRow = document.querySelector('.article-row.inline-expanded');
    if (expandedRow) expandedRow.classList.remove('inline-expanded');
  }

  window._closeInlineDetail = closeInline;

  // Load article content into the inline shell with one-shot error recovery.
  function _loadInlineContent(articleId) {
    function isContentTarget(ev) {
      return ev.detail && ev.detail.target && ev.detail.target.id === CONTENT_ID;
    }
    function cleanup() {
      document.body.removeEventListener('htmx:sendError', onError);
      document.body.removeEventListener('htmx:responseError', onError);
      document.body.removeEventListener('htmx:afterSettle', onSettle);
    }
    function onSettle(ev) { if (isContentTarget(ev)) cleanup(); }
    function onError(ev) {
      if (!isContentTarget(ev)) return;
      cleanup();
      var content = document.getElementById(CONTENT_ID);
      if (!content) return;
      _claimHtmxError(ev);
      content.innerHTML = '<div class="px-6 py-6 text-sm text-gray-400">' +
        'Couldn’t load this article. ' +
        '<button type="button" data-inline-retry class="text-blue-600 underline">Retry</button></div>';
      content.querySelector('[data-inline-retry]').addEventListener('click', function () {
        content.innerHTML = '<div class="px-6 py-6 flex items-center gap-2 text-sm text-gray-400">' +
          '<svg class="animate-spin h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">' +
          '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
          '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8z"></path>' +
          '</svg>Loading…</div>';
        _loadInlineContent(articleId);
      });
    }
    document.body.addEventListener('htmx:sendError', onError);
    document.body.addEventListener('htmx:responseError', onError);
    document.body.addEventListener('htmx:afterSettle', onSettle);
    htmx.ajax('GET', '/htmx/articles/' + articleId, {
      target: '#' + CONTENT_ID,
      swap: 'innerHTML'
    });
  }

  // Intercept HTMX requests targeting #article-detail for inline expand
  document.body.addEventListener('htmx:beforeRequest', function (e) {
    if (!_shouldUseInline()) return;
    if (!e.detail.target || e.detail.target.id !== 'article-detail') return;
    // Deep-link (?open_article_id=…) loads the detail panel directly (handled as a
    // fullscreen overlay), bypassing inline expansion which needs an .article-row.
    if (e.detail.elt && e.detail.elt.hasAttribute && e.detail.elt.hasAttribute('data-deeplink-open')) return;
    // A source from the story footer, which is opened over the list rather than in a row
    // of it: there is no row to expand, and the article is usually not in the list at all.
    if (e.detail.elt && e.detail.elt.closest && e.detail.elt.closest('[data-open-story-member]')) return;
    // Skip action buttons (star, etc.) — hx-target="#article-detail" is inherited from parent row
    if (e.detail.elt && e.detail.elt.closest('[data-stop-propagation]')) return;

    e.preventDefault();

    var row = e.detail.elt.closest('.article-row') || e.detail.elt;
    if (!row || !row.dataset.articleId) return;

    var articleId = row.dataset.articleId;

    if (row.classList.contains('inline-expanded')) {
      // Title clicks are intercepted by capture listener before HTMX sees them.
      // Any click reaching here (▲, feed name, date, padding…) collapses the row.
      closeInline();
      return;
    }

    // Different article: close previous, open new
    closeInline();

    // Build inline container
    var container = document.createElement('div');
    container.id = INLINE_ID;
    container.dataset.articleId = articleId;
    container.className = 'border-b border-gray-200 bg-white';
    container.style.boxShadow = 'inset 0 -6px 8px -6px var(--rf-shadow-faint)';

    var content = document.createElement('div');
    content.id = CONTENT_ID;
    content.innerHTML = '<div class="px-6 py-6 flex items-center gap-2 text-sm text-gray-400">' +
      '<svg class="animate-spin h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24">' +
      '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
      '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8z"></path>' +
      '</svg>Loading…</div>';
    container.appendChild(content);

    row.insertAdjacentElement('afterend', container);
    row.classList.add('inline-expanded');

    // Load article content, with one-shot error recovery so a failed load doesn't
    // leave the "Loading…" shell spinning forever.
    _loadInlineContent(articleId);

    // Scroll the row into view, clearing anything pinned above it (see
    // scrollListRowToTop). The delay lets the shell take its height first.
    setTimeout(function () { scrollListRowToTop(row, 'smooth'); }, 50);
  });

  // Close inline when article list reloads (nav change)
  document.body.addEventListener('htmx:beforeSwap', function (e) {
    if (e.detail.target.id !== 'article-list') return;
    closeInline();
  });

  // Start the new list at the top. This has to happen after the swap, not before:
  // resetting the outgoing list scrolls content the reader is still looking at, and
  // that jump reaches the screen a frame or two before the new list replaces it.
  // Setting it here runs before the browser paints the new content, so the list
  // simply arrives at the top.
  document.body.addEventListener('htmx:afterSwap', function (e) {
    if (e.detail.target.id !== 'article-list') return;
    e.detail.target.scrollTop = 0;
  });
})();

// ── Saved search badges across a sidebar refresh ─────────────────────────
// A saved search's count loads after the sidebar (see sidebar.html), so every
// refresh would draw its row without a badge for a moment and the whole block would
// flicker. The badge it had goes into the new placeholder until the new count
// replaces it; a search that has since gone over budget loses it then.
(function () {
  var carried = {};
  document.body.addEventListener('htmx:beforeSwap', function (e) {
    if (e.detail.target.id !== 'sidebar') return;
    carried = {};
    e.detail.target.querySelectorAll('[data-saved-count]').forEach(function (b) {
      if (b.innerHTML) carried[b.id] = b.innerHTML;
    });
  });
  document.body.addEventListener('htmx:afterSwap', function (e) {
    if (e.detail.target.id !== 'sidebar') return;
    e.detail.target.querySelectorAll('[data-saved-count]').forEach(function (p) {
      if (carried[p.id]) p.innerHTML = carried[p.id];
    });
    carried = {};
  });
})();

// ── Auto-advance: after marking a feed/folder/label read, open the next one
// with unread (opt-in via the sidebar's data-auto-advance flag). ────────────
function _autoAdvanceParam(hx) {
  if (/[?&]feed_id=/.test(hx)) return 'feed_id';
  if (/[?&]folder_id=/.test(hx)) return 'folder_id';
  if (/[?&]label_id=/.test(hx)) return 'label_id';
  if (/[?&]saved_search_id=/.test(hx)) return 'saved_search_id';
  return null; // special rows (All / Starred / Archived / Labels header)
}

// Un-collapse a section so the target row is visible and stays open after the
// sidebarRefresh re-render (which restores collapse state from localStorage).
function _expandCollapsible(key) {
  var content = document.getElementById('collapse-' + key);
  var toggle = document.querySelector('.collapse-toggle[data-collapse="' + key + '"]');
  if (content) content.classList.remove('collapsed');
  if (toggle) toggle.classList.remove('is-collapsed');
  try { localStorage.removeItem('sidebar_col_' + key); } catch (err) {}
}

// Returns true if it navigated to a next scope; false if none applied.
function _markReadAutoAdvance(clickedRow) {
  var full = document.getElementById('sidebar-full');
  if (!full || !full.hasAttribute('data-auto-advance') || !clickedRow) return false;
  var clickedA = clickedRow.querySelector('.nav-item[hx-get]');
  if (!clickedA) return false;
  var param = _autoAdvanceParam(clickedA.getAttribute('hx-get') || '');
  if (!param) return false;

  // Same-kind rows in visual order (feeds cross folder boundaries).
  var rows = Array.from(full.querySelectorAll('.mark-read-row')).filter(function (r) {
    var a = r.querySelector('.nav-item[hx-get]');
    return a && new RegExp('[?&]' + param + '=').test(a.getAttribute('hx-get') || '');
  });
  var start = rows.indexOf(clickedRow);
  if (start === -1) return false;

  var nextRow = null;
  for (var i = start + 1; i < rows.length; i++) {
    // Unread badge is the pill variant (.rounded-full); total badge is not.
    if (rows[i].querySelector('.mark-read-badge.rounded-full')) { nextRow = rows[i]; break; }
  }
  if (!nextRow) return false;

  var nextA = nextRow.querySelector('.nav-item[hx-get]');
  var url = nextA.getAttribute('hx-get');

  // Expand any collapsed ancestor section (feed inside a folder, label list)…
  var anc = nextRow.parentElement ? nextRow.parentElement.closest('.collapsible') : null;
  while (anc) {
    if (anc.id && anc.id.indexOf('collapse-') === 0) _expandCollapsible(anc.id.slice(9));
    anc = anc.parentElement ? anc.parentElement.closest('.collapsible') : null;
  }
  // …and, when advancing to a folder, open the folder itself.
  if (param === 'folder_id') {
    var m = url.match(/[?&]folder_id=(\d+)/);
    if (m) _expandCollapsible('folder-' + m[1]);
  }

  _saveNavSnapshot();
  _highlightNav(url);
  _activeNavGet = url;
  try { localStorage.setItem('lastNavItem', url); } catch (err) {}
  _syncMobileQuicklink();
  nextRow.scrollIntoView({ block: 'nearest' });
  htmx.ajax('GET', url, { target: '#article-list', swap: 'innerHTML' });
  return true;
}

// ── Label badges sent out-of-band with a label list ───────────────────────
// Opening a label view re-sends its sidebar badges (_label_badge_oob). A badge put in
// while the pointer is still on the row takes the hover position at once, since a new
// element has no transition to delay it, so it jumped left on every click. Swap only
// when the count actually changed.
document.body.addEventListener('htmx:oobBeforeSwap', function (e) {
  var target = e.detail.target;
  if (!target || !/^label-badge-/.test(target.id)) return;
  var current = target.querySelector('.mark-read-badge');
  var next = e.detail.fragment && e.detail.fragment.querySelector('.mark-read-badge');
  if (current && next && current.className === next.className
      && current.textContent === next.textContent) {
    e.detail.shouldSwap = false;
  }
});

// ── Sidebar mark-all-as-read: refresh sidebar + article list after action ──
document.body.addEventListener('htmx:afterRequest', function (e) {
  if (!e.detail.elt || e.detail.elt.dataset.action !== 'mark-read') return;
  document.querySelectorAll('.mark-read-row.touch-active').forEach(function (r) {
    r.classList.remove('touch-active');
  });
  if (!e.detail.successful) return;
  e.detail.elt.style.display = 'none';
  // Replace badge with server-returned total badge HTML
  var row = e.detail.elt.closest('.mark-read-row');
  if (row && e.detail.xhr && e.detail.xhr.responseText) {
    var badge = row.querySelector('.mark-read-badge');
    if (badge) badge.outerHTML = e.detail.xhr.responseText;
  }
  // Marking a feed/folder read also changes sibling counts (labels, other feeds
  // sharing an article). The endpoint sends HX-Trigger: sidebarRefresh, but that
  // event races the POST inside #sidebar's hx-sync="this:abort" context and gets
  // dropped, leaving those counts stale. Re-trigger once the request has fully
  // settled so the whole sidebar recomputes.
  setTimeout(function () { htmx.trigger(document.body, 'sidebarRefresh'); }, 0);
  // Opt-in: jump to the next unread feed/folder/label instead of just refreshing.
  if (_markReadAutoAdvance(row)) return;
  var active = document.querySelector('.nav-item.active[hx-get]');
  var url = active ? active.getAttribute('hx-get') : '/htmx/articles';
  htmx.ajax('GET', url, { target: '#article-list', swap: 'innerHTML' });
});

// ── Settings mobile nav: preserve horizontal scroll across navigation ─────
document.addEventListener('click', function (e) {
  var link = e.target.closest('a[href]');
  if (!link) return;
  var href = link.getAttribute('href') || '';
  if (!href.startsWith('/settings') && !href.startsWith('/admin')) return;
  var nav = document.querySelector('.sm\\:hidden .overflow-x-auto');
  if (nav) {
    try { sessionStorage.setItem('_snav_scroll', nav.scrollLeft); } catch (e) {}
  }
});

function _restoreSettingsNavScroll() {
  var nav = document.querySelector('.sm\\:hidden .overflow-x-auto');
  if (!nav) return;
  try {
    var saved = sessionStorage.getItem('_snav_scroll');
    if (saved !== null) nav.scrollLeft = parseInt(saved, 10);
  } catch (e) {}
}
document.addEventListener('DOMContentLoaded', _restoreSettingsNavScroll);
document.body.addEventListener('htmx:afterSettle', _restoreSettingsNavScroll);

// ── Label edit panel expand/collapse ──────────────────────────────────────
document.addEventListener('click', function (e) {
  var toggle = e.target.closest('.label-edit-toggle');
  if (toggle) {
    var li = toggle.closest('li');
    var panel = li.querySelector('.label-edit-panel');
    var isHidden = panel.classList.toggle('hidden');
    toggle.textContent = isHidden ? 'Edit' : 'Close';
    return;
  }
  var cancel = e.target.closest('.label-edit-cancel');
  if (cancel) {
    var li = cancel.closest('li');
    li.querySelector('.label-edit-panel').classList.add('hidden');
    li.querySelector('.label-edit-toggle').textContent = 'Edit';
  }
});

// ── Swap confirm: two-click destructive action without layout shift ───────
// First click arms the button (changes text + style); second click fires.
// Disarm on outside click or 3.5s timeout. Works with htmx by stopping the
// first click in capture phase, so htmx's bubble listener never sees it.
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.swap-confirm');
  if (!btn) return;
  if (btn.dataset.armed === '1') return;
  e.stopPropagation();
  e.preventDefault();
  btn.dataset.armed = '1';
  btn.dataset.origText = btn.textContent;
  btn.dataset.origClass = btn.className;
  btn.textContent = btn.dataset.confirmText || 'Confirm';
  if (btn.dataset.confirmClass) {
    btn.className = btn.dataset.confirmClass.trim() + ' swap-confirm';
  }

  var timer;
  var disarm = function () {
    if (btn.dataset.armed !== '1') return;
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.origText;
    btn.className = btn.dataset.origClass;
    clearTimeout(timer);
    document.removeEventListener('click', outside, true);
  };
  var outside = function (ev) {
    if (!btn.contains(ev.target)) disarm();
  };
  timer = setTimeout(disarm, 3500);
  setTimeout(function () { document.addEventListener('click', outside, true); }, 0);
}, true);

// ── Dismiss apply-preview: remove the inline preview block ─────────────────
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.apply-cancel');
  if (!btn) return;
  var preview = btn.closest('.apply-preview');
  if (preview) preview.remove();
});

// ── Color swatches (label color picker) ───────────────────────────────────
document.addEventListener('click', function (e) {
  var swatch = e.target.closest('.color-swatch');
  if (!swatch) return;
  e.preventDefault();
  var group = swatch.closest('.color-swatch-group');
  group.querySelectorAll('.color-swatch').forEach(function (s) {
    s.classList.remove('ring-2', 'ring-gray-700', 'ring-offset-1');
    s.setAttribute('aria-pressed', 'false');
  });
  swatch.classList.add('ring-2', 'ring-gray-700', 'ring-offset-1');
  swatch.setAttribute('aria-pressed', 'true');
  var form = swatch.closest('form');
  if (!form) return;
  var input = form.querySelector('input[type="hidden"][name="color"]');
  if (input) input.value = swatch.dataset.color;
  var customInput = form.querySelector('.color-custom-input');
  if (customInput) customInput.value = '';
  var preview = form.querySelector('.color-custom-preview');
  if (preview) preview.style.backgroundColor = '';
});

document.addEventListener('input', function (e) {
  var customInput = e.target.closest('.color-custom-input');
  if (!customInput) return;
  var form = customInput.closest('form');
  if (!form) return;
  var val = customInput.value.trim();
  if (val && !val.startsWith('#')) val = '#' + val;
  var isValid = /^#[0-9a-fA-F]{6}$/.test(val);
  var preview = form.querySelector('.color-custom-preview');
  var hiddenInput = form.querySelector('input[type="hidden"][name="color"]');
  if (isValid) {
    form.querySelectorAll('.color-swatch').forEach(function (s) {
      s.classList.remove('ring-2', 'ring-gray-700', 'ring-offset-1');
      s.setAttribute('aria-pressed', 'false');
    });
    if (preview) preview.style.backgroundColor = val;
    if (hiddenInput) hiddenInput.value = val;
  } else {
    if (preview) preview.style.backgroundColor = '';
  }
});

// ── Preferences: layout bucket selects ────────────────────────────────────
(function () {
  var defaults = { small: '1', medium: '2', large: '3' };
  var minimums = { small: '1', medium: '2', large: '2' };
  document.querySelectorAll('[data-layout-bucket]').forEach(function (sel) {
    var bucket = sel.dataset.layoutBucket;
    var val;
    try { val = localStorage.getItem('layout_' + bucket); } catch (e) {}
    if (val && parseInt(val) < parseInt(minimums[bucket])) val = minimums[bucket];
    sel.value = val || defaults[bucket];
    sel.addEventListener('change', function () {
      try { localStorage.setItem('layout_' + bucket, sel.value); } catch (e) {}
      if (window._applyBucket) window._applyBucket();
    });
  });
})();

// ── stopPropagation for action buttons inside article rows ─────────────────
// Attached via htmx:afterSettle so each button gets its own listener —
// bubbling phase only, so hx-post on the button fires first.
document.body.addEventListener('htmx:afterSettle', function (evt) {
  if (evt.detail.target.id !== 'article-list') return;
  evt.detail.target.querySelectorAll('[data-stop-propagation]').forEach(function (el) {
    el.addEventListener('click', function (e) { e.stopPropagation(); });
  });
});

// ── Trigger conditions that used to be hx-trigger event filters ────────────
// Filters like click[...] are evaluated with eval, which htmx has switched off
// (allowEval in base.html), so the condition is checked here instead: htmx:confirm
// comes before anything else a request does, and cancelling it drops the request.
//   - An article row opens on a click anywhere in it except its action buttons. The
//     stopPropagation above covers rows loaded into the list; this also covers rows
//     inserted any other way.
document.body.addEventListener('htmx:confirm', function (e) {
  var elt = e.detail.elt;
  var evt = e.detail.triggeringEvent;
  if (!elt || !evt) return;
  if (elt.classList.contains('article-row') && evt.type === 'click'
      && evt.target.closest && evt.target.closest('[data-stop-propagation]')) {
    e.preventDefault();
  }
});

// ── Mobile navigation (small bucket) ──────────────────────────────────────
// The sidebar sheet itself (open, close, backdrop, the toggle-sidebar-pin intercept,
// window._closeMobileSidebarOverlay) is ui/shell.js; what stays here reads app.js's
// own state (_saveNavSnapshot, _activeNavGet, _highlightNav) or the article panes.
(function () {
  function isMobile() { return document.documentElement.dataset.bucket === 'small'; }

  // Restore title bar text after page refresh
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var saved = localStorage.getItem('mobile_title_text');
      var titleText = document.getElementById('mobile-title-text');
      if (saved && titleText) titleText.textContent = saved;
    } catch (err) {}
    _syncMobileQuicklink();
  });

  // Sidebar item click: close overlay + update title bar text
  document.addEventListener('click', function (e) {
    if (!isMobile()) return;
    var item = e.target.closest('#sidebar [hx-target="#article-list"]');
    if (!item) return;
    _saveNavSnapshot();
    var titleEl = item.querySelector('span.flex-1');
    var title = (item.dataset.navTitle
      || (titleEl ? titleEl.textContent : (item.getAttribute('title') || ''))).trim().slice(0, 40);
    var titleText = document.getElementById('mobile-title-text');
    if (titleText) titleText.textContent = title;
    try { localStorage.setItem('mobile_title_text', title); } catch (err) {}
    _syncMobileQuicklink();
    // The sheet (ui/shell.js) closes behind the chosen row.
    if (window._closeMobileSidebarOverlay) window._closeMobileSidebarOverlay();
  });

  // Quicklink click: navigate to Labels/All articles or Starred
  document.addEventListener('click', function (e) {
    if (!isMobile()) return;
    if (!e.target.closest('#mobile-title-quicklink')) return;
    _saveNavSnapshot();
    var target = _mobileQuicklinkTarget();
    var targetUrl = target.url;
    var targetTitle = target.title;
    _activeNavGet = targetUrl;
    try { localStorage.setItem('lastNavItem', targetUrl); } catch (err) {}
    var titleText = document.getElementById('mobile-title-text');
    if (titleText) titleText.textContent = targetTitle;
    try { localStorage.setItem('mobile_title_text', targetTitle); } catch (err) {}
    _syncMobileQuicklink();
    _highlightNav(targetUrl);
    htmx.ajax('GET', targetUrl, { target: '#article-list', swap: 'innerHTML' });
    _refreshSidebarAfterNav();
  });

  // Detail back button: close fullscreen detail
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#mobile-detail-back-btn')) return;
    // The story overlay flushes dwell and empties the panel itself, and it pushed one
    // entry however many members were read on it, so Back returns to the list either way.
    if (window._closeStoryOverlay && window._closeStoryOverlay()) { history.back(); return; }
    if (window._closeDeeplinkDetail && window._closeDeeplinkDetail()) { history.back(); return; }
    // Flush dwell + stop the clock, else list-browsing time gets attributed to this article.
    if (window._dwellSend) window._dwellSend();
    document.documentElement.classList.remove('mobile-detail-open', 'deeplink-detail-open');
    history.back();
  });

  // After an article loads into #article-detail on a phone reading full screen: open it.
  document.body.addEventListener('htmx:afterSettle', function (e) {
    if (e.detail.target.id !== 'article-detail') return;
    if (!isMobile()) return;
    if (_detailModeSmall() !== 'fullscreen') return;
    var articleEl = e.detail.target.querySelector('[data-article-id]');
    var articleId = articleEl ? articleEl.dataset.articleId : null;
    var articleHash = articleId ? '#article-' + articleId : '';
    if (document.documentElement.classList.contains('mobile-detail-open')) {
      history.replaceState({ mobileDetailOpen: true, articleId: articleId }, '', articleHash || window.location.pathname);
    } else {
      document.documentElement.classList.add('mobile-detail-open');
      history.pushState({ mobileDetailOpen: true, articleId: articleId }, '', articleHash || window.location.pathname);
    }
    e.detail.target.scrollTop = 0;
  });

  // Share ([data-bottom-share]: the bottom bar, the phone toolbar, the ··· menu): the picker
  var _pendingShareTitle = null;

  function _showShareToast(msg) {
    showToast(msg, 'ok');
  }

  function _execCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    return ok;
  }

  function _copyWithFeedback(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { _showShareToast('Link copied'); })
        .catch(function () { if (_execCopy(text)) _showShareToast('Link copied'); });
    } else if (_execCopy(text)) {
      _showShareToast('Link copied');
    }
  }

  function doShare(title, url) {
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        _copyWithFeedback(url);
      });
    } else {
      _copyWithFeedback(url);
    }
  }

  // Place the picker so its bottom sits at the click point (grows upward from where
  // the user tapped), aligning its right edge to the anchor and clamping into the
  // viewport. Drops below only when there isn't room above.
  function positionSharePicker(picker, rect) {
    picker.style.zIndex = '60';
    picker.style.right = '';
    picker.style.bottom = '';
    picker.style.maxWidth = '';

    var margin = 8;
    var pickerH = picker.offsetHeight;
    var pickerW = picker.offsetWidth;
    var aboveTop = rect.bottom - pickerH;
    var top = aboveTop >= margin ? aboveTop : rect.bottom + 4;
    var left = Math.min(rect.right - pickerW, window.innerWidth - pickerW - margin);
    left = Math.max(margin, left);
    picker.style.top = top + 'px';
    picker.style.left = left + 'px';
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-bottom-share]');
    if (!trigger) return;
    var picker = document.getElementById('detail-share-picker');
    if (!picker) return;
    var isOpen = !picker.classList.contains('hidden');
    if (isOpen) { picker.classList.add('hidden'); e.stopPropagation(); return; }
    // Measure the actual clicked button before the menu (and this trigger) is hidden,
    // so the picker appears right where the user tapped.
    var anchorRect = trigger.getBoundingClientRect();
    document.querySelectorAll('[data-menu]').forEach(function (m) { m.classList.add('hidden'); });
    picker.classList.remove('hidden');
    positionSharePicker(picker, anchorRect);
    e.stopPropagation();
  });

  document.addEventListener('click', function (e) {
    var picker = document.getElementById('detail-share-picker');
    if (picker && !e.target.closest('#detail-share-picker') && !e.target.closest('[data-bottom-share]')) {
      picker.classList.add('hidden');
    }
  });

  // The article's url/title live on the <article> element, not on the wrapper div
  // that also carries data-article-id. Matching on the tag keeps a bare
  // '[data-article-id]' query from picking up the wrapper and losing the source URL.
  function currentDetailArticleEl() {
    return (document.querySelector('#article-detail article[data-article-id]') ||
            document.querySelector('#inline-article-detail-content article[data-article-id]'));
  }

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#detail-share-pick-original')) return;
    document.getElementById('detail-share-picker').classList.add('hidden');
    var articleEl = currentDetailArticleEl();
    if (!articleEl) return;
    doShare(articleEl.dataset.title || '', articleEl.dataset.url || window.location.href);
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('#detail-share-pick-readfine')) return;
    document.getElementById('detail-share-picker').classList.add('hidden');
    var articleEl = currentDetailArticleEl();
    if (!articleEl) return;
    var id = articleEl.dataset.articleId;
    var title = articleEl.dataset.title || '';
    var shareInput = (document.querySelector('#article-detail [id^="share-btn-"] input[type="text"]') ||
                      document.querySelector('#inline-article-detail-content [id^="share-btn-"] input[type="text"]'));
    if (shareInput && shareInput.value) {
      doShare(title, shareInput.value);
    } else {
      _pendingShareTitle = title;
      htmx.ajax('POST', '/htmx/articles/' + id + '/share', { target: '#share-btn-' + id, swap: 'outerHTML' });
    }
  });

  // Copy article: title + source + body as rich HTML with a plain-text fallback.
  // Writes both text/html and text/plain to the clipboard so rich editors (Docs,
  // Word, email) paste formatting + images, while plain fields get clean text.
  function _htmlEscape(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Rewrite relative img/href URLs to absolute (against the article's own URL) so
  // images and links still resolve once pasted outside the app.
  function _absolutizeUrls(el, base) {
    if (!base) return;
    el.querySelectorAll('img[src]').forEach(function (img) {
      var raw = img.getAttribute('src');
      try { img.setAttribute('src', new URL(raw, base).href); } catch (e) {}
    });
    el.querySelectorAll('a[href]').forEach(function (a) {
      var raw = a.getAttribute('href');
      try { a.setAttribute('href', new URL(raw, base).href); } catch (e) {}
    });
  }

  // Mirror the stylesheet's table handling in the copied markup: layout tables
  // (no <th> — e.g. Reddit's image+meta wrappers) are rendered as stacked blocks
  // via CSS, so unwrap their cells into <div>s here too; genuine data tables
  // (with <th>) are kept intact.
  function _unwrapLayoutTables(root) {
    root.querySelectorAll('table').forEach(function (table) {
      if (!table.parentNode || table.querySelector('th')) return;
      var frag = document.createDocumentFragment();
      table.querySelectorAll('td').forEach(function (td) {
        var div = document.createElement('div');
        while (td.firstChild) div.appendChild(td.firstChild);
        frag.appendChild(div);
      });
      table.replaceWith(frag);
    });
  }

  function _copyPlainFallback(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { _showShareToast('Article copied'); })
        .catch(function () { if (_execCopy(text)) _showShareToast('Article copied'); });
    } else if (_execCopy(text)) {
      _showShareToast('Article copied');
    }
  }

  function _copyArticle(html, text) {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      try {
        var item = new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        });
        navigator.clipboard.write([item])
          .then(function () { _showShareToast('Article copied'); })
          .catch(function () { _copyPlainFallback(text); });
        return;
      } catch (e) { /* fall through to plain */ }
    }
    _copyPlainFallback(text);
  }

  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-copy-article]');
    if (!trigger) return;
    var root = trigger.closest('article[data-article-id]');
    if (!root) return;
    var body = root.querySelector('.article-body');
    if (!body) return;

    var title = root.dataset.title || '';
    var url = root.dataset.url || '';
    var feed = root.dataset.feedTitle || '';

    var clone = body.cloneNode(true);
    _unwrapLayoutTables(clone);
    _absolutizeUrls(clone, url);

    var header = '';
    if (title) {
      header += url ? '<h1><a href="' + _htmlEscape(url) + '">' + _htmlEscape(title) + '</a></h1>'
                    : '<h1>' + _htmlEscape(title) + '</h1>';
    }
    var srcBits = [];
    if (feed) srcBits.push(_htmlEscape(feed));
    if (url) srcBits.push('<a href="' + _htmlEscape(url) + '">' + _htmlEscape(url) + '</a>');
    if (srcBits.length) header += '<p>' + srcBits.join(' &middot; ') + '</p>';
    var html = header + clone.innerHTML;

    var textLines = [];
    if (title) textLines.push(title);
    var srcLine = [feed, url].filter(Boolean).join(' · ');
    if (srcLine) textLines.push(srcLine);
    textLines.push('');
    textLines.push(body.innerText || body.textContent || '');
    _copyArticle(html, textLines.join('\n'));
  });

  // After share token generated: complete pending share
  document.body.addEventListener('htmx:afterSettle', function (e) {
    if (_pendingShareTitle === null) return;
    var targetId = (e.detail.target && e.detail.target.id) || '';
    if (!targetId.startsWith('share-btn-')) return;
    var input = document.getElementById(targetId) && document.getElementById(targetId).querySelector('input[type="text"]');
    if (input) doShare(_pendingShareTitle, input.value);
    _pendingShareTitle = null;
  });

  // Bottom next: mark current as read, load next article from list
  document.addEventListener('click', function (e) {
    if (!isMobile() || !e.target.closest('[data-bottom-next]')) return;
    var detailArticle = currentDetailArticleEl();
    if (!detailArticle) return;
    var currentId = detailArticle.dataset.articleId;
    htmx.ajax('POST', '/htmx/articles/' + currentId + '/set-read?state=true', { swap: 'none' });
    detailArticle.dataset.isRead = 'true';
    var currentRow = document.querySelector('#article-list [data-article-id="' + currentId + '"]');
    if (!currentRow) return;
    var next = currentRow.nextElementSibling;
    while (next && !next.dataset.articleId) next = next.nextElementSibling;
    if (!next) return;
    htmx.ajax('GET', '/htmx/articles/' + next.dataset.articleId, { target: '#article-detail', swap: 'innerHTML' });
  });

  // Browser back: sync classes with history state
  window.addEventListener('popstate', function (e) {
    if (!isMobile()) return;
    var state = e.state || {};
    document.documentElement.classList.toggle('mobile-sidebar-open', !!state.mobileSidebarOpen);
    document.documentElement.classList.toggle('mobile-detail-open', !!state.mobileDetailOpen);
  });

  // Bottom action bar: always visible when article is loaded
  function _syncBottomBar() {
    // The story overlay puts an article in the panel in layouts that otherwise read
    // inline, and its bar is the one on screen — asking the layout alone would sync the
    // shell underneath and leave the overlay's bar hidden.
    var inInline = _shouldUseInline() && !document.documentElement.classList.contains('story-detail-open');
    var containerId = inInline ? 'inline-article-detail-content' : 'article-detail';
    var container = document.getElementById(containerId);
    if (!container) return;
    var bar = container.querySelector('.article-bottom-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    var readBtn = bar.querySelector('[data-bottom-read]');
    if (readBtn) readBtn.classList.remove('hidden');
    var nextBtn = bar.querySelector('[data-bottom-next]');
    // Next walks the list, and on the story overlay the reader is not in it.
    var inStory = document.documentElement.classList.contains('story-detail-open');
    if (nextBtn) nextBtn.classList.toggle('hidden', inStory || !(isMobile() && !inInline));
  }
  document.body.addEventListener('htmx:afterSettle', function (e) {
    var id = e.detail.target.id;
    if (id === 'article-detail' || id === 'inline-article-detail-content' || (id && id.startsWith('article-content-'))) _syncBottomBar();
  });

  // Reading & appearance page: sync the small-bucket select with localStorage
  var prefPairs = [
    { id: 'detail-mode-small',  key: 'detail_mode_small',  def: _DETAIL_MODE_SMALL_DEFAULT }
  ];
  prefPairs.forEach(function (p) {
    var sel = document.getElementById(p.id);
    if (!sel) return;
    try { sel.value = localStorage.getItem(p.key) || p.def; } catch (e) {}
    sel.addEventListener('change', function () {
      try { localStorage.setItem(p.key, sel.value); } catch (e) {}
    });
  });
})();

// ── "insert default" links for prompt fields ──────────────────────────────
// The default prompt is rendered into each textarea's placeholder. The link
// copies it into the value so it can be used as an editable starting point.
// Label is contextual: "insert default" when empty, "reset to default" when filled.
(function () {
  function refresh() {
    document.querySelectorAll('[data-insert-default]').forEach(function (btn) {
      var ta = document.querySelector(btn.getAttribute('data-insert-default'));
      if (ta) btn.textContent = ta.value.trim() ? 'reset to default' : 'insert default';
    });
  }
  window._refreshInsertDefaultLabels = refresh;

  function disarmInsertBtn(btn) {
    if (btn.dataset.armed !== '1') return;
    btn.dataset.armed = '';
    btn.className = btn.dataset.origClass || btn.className;
    clearTimeout(Number(btn.dataset.armTimer));
    if (window._refreshInsertDefaultLabels) window._refreshInsertDefaultLabels();
    document.removeEventListener('click', btn._insertOutside, true);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-insert-default]');
    if (!btn) return;
    var ta = document.querySelector(btn.getAttribute('data-insert-default'));
    if (!ta) return;

    if (btn.dataset.armed === '1') {
      // Second click: clear field and disarm
      disarmInsertBtn(btn);
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      return;
    }

    if (ta.value.trim()) {
      // Arm for confirmation
      btn.dataset.armed = '1';
      btn.dataset.origText = btn.textContent;
      btn.dataset.origClass = btn.className;
      btn.textContent = 'Confirm reset';
      btn.className = 'text-xs text-red-600 font-medium hover:text-red-800 bg-transparent border-0 p-0 cursor-pointer';
      btn._insertOutside = function (ev) { if (!btn.contains(ev.target)) disarmInsertBtn(btn); };
      btn.dataset.armTimer = setTimeout(function () { disarmInsertBtn(btn); }, 3500);
      setTimeout(function () { document.addEventListener('click', btn._insertOutside, true); }, 0);
    } else {
      // Empty field: insert editable copy of the default immediately
      ta.value = ta.placeholder;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target && e.target.matches && e.target.matches('textarea[id]')) {
      var btn = document.querySelector('[data-insert-default="#' + e.target.id + '"]');
      if (btn) btn.textContent = e.target.value.trim() ? 'reset to default' : 'insert default';
    }
  });

  document.addEventListener('DOMContentLoaded', refresh);
  refresh();
})();


// --- Expandable error text ----------------------------------------------------------
// Error messages in tables and feed rows clamp to two lines (see
// templates/partials/error_text.html). The full text lives in the title attribute,
// which is a mouse-only affordance: on a phone the clipped tail was simply unreadable.
// Measure each one after render and reveal its "Show more" toggle when there is more
// text than the clamp shows, so the short majority stays exactly as it was.
(function () {
  function sync(el) {
    if (el.dataset.expanded === '1') return;  // open already, nothing to measure
    var btn = el.parentElement && el.parentElement.querySelector('[data-expand-toggle]');
    if (!btn) return;
    btn.classList.toggle('hidden', el.scrollHeight <= el.clientHeight + 1);
  }

  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-expand]'), sync);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-expand-toggle]');
    if (!btn) return;
    var el = btn.parentElement.querySelector('[data-expand]');
    if (!el) return;
    var open = el.dataset.expanded === '1';
    el.classList.toggle('line-clamp-2', open);
    el.dataset.expanded = open ? '0' : '1';
    btn.textContent = open ? 'Show more' : 'Show less';
  });

  // A swapped-in table and a rotated phone both change what fits into two lines.
  document.body.addEventListener('htmx:afterSettle', scan);
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(scan, 150);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
})();

// ── Service worker registration ───────────────────────────────────────────
// Always "/sw.js" (or "/sw.js?offline=1" with offline mode on), never static_url(): the
// registration URL is the worker's identity, so a cache-busting query would leave a
// second worker behind on every deploy. Without offline mode the worker answers
// nothing; it is there so the browser will offer to install the app.
// (Absent on http:// origins, hence the capability check rather than a try/catch alone.)
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    // An existing registration is left alone: which of the two URLs it has is offline
    // mode's business (offline/page.js reconciles it on a signed-in page). Only with
    // nothing registered yet does this register plain "/sw.js". The browser checks an
    // existing worker for updates by itself; updateViaCache 'none' (set at
    // registration) makes that check see new offline scripts at once.
    var sw = navigator.serviceWorker;
    var reg = (window.RFOffline && window.RFOffline.sw)
      ? window.RFOffline.sw.ensure()
      : sw.getRegistration('/').then(function (r) {
        return r || sw.register('/sw.js', { updateViaCache: 'none' });
      });
    reg.catch(function () {
      // Registration failing costs the install prompt and nothing else, so it stays
      // silent rather than logging on every page load of an unsupported setup.
    });
  });
})();
