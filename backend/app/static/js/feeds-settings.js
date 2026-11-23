// Sources table only. Add/discovery and sheet behaviour belong to ui/sources.js.
(function () {
  'use strict';
  // A boosted document may execute this script again and replace the entire body.
  if (window.RFSourcesFolders) return;
  window.RFSourcesFolders = { installed: true };

  function activate(which) {
    ['feeds', 'stats'].forEach(function (name) {
      var button = document.getElementById('tab-' + name);
      if (button) button.setAttribute('aria-pressed', String(name === which));
    });
  }
  function folderRequest(evt) {
    var cfg = evt.detail && evt.detail.requestConfig;
    return cfg && /^\/settings\/(?:folders(?:\/|$)|folder-order(?:\/|$))/.test(cfg.path || '');
  }
  // Keep state on the request, not in a shared slot: overlapping responses cannot
  // consume another request's OOB selection or focus restoration.
  var swaps = new WeakMap();
  document.addEventListener('click', function (evt) {
    var tab = evt.target.closest('#tab-feeds, #tab-stats');
    if (tab) activate(tab.id === 'tab-stats' ? 'stats' : 'feeds');
  });
  document.addEventListener('rf:sourceschanged', function () { activate('feeds'); });
  document.addEventListener('htmx:beforeSwap', function (evt) {
    if (!folderRequest(evt)) return;
    var cfg = evt.detail.requestConfig;
    var select = document.getElementById('subscribe-folder-select');
    var match = cfg.path.match(/\/folders\/(\d+)\/move$/);
    swaps.set(evt.detail.xhr || cfg, {
      selected: select ? select.value : null,
      moved: match ? match[1] : null,
    });
  });
  document.addEventListener('htmx:afterSwap', function (evt) {
    var target = evt.detail && evt.detail.target;
    var cfg = evt.detail && evt.detail.requestConfig;
    if (folderRequest(evt) || (target && target.id === 'feeds-list' && cfg && cfg.path === '/settings/feeds-list')) {
      activate('feeds');
    }
  });
  document.addEventListener('htmx:afterSettle', function (evt) {
    if (!folderRequest(evt)) return;
    var key = evt.detail.xhr || evt.detail.requestConfig;
    var state = swaps.get(key);
    if (!state) return;
    swaps.delete(key);
    var select = document.getElementById('subscribe-folder-select');
    if (select && state.selected !== null) {
      select.value = Array.prototype.some.call(select.options, function (o) {
        return o.value === state.selected;
      }) ? state.selected : '';
    }
    if (!state.moved) return;
    var header = document.getElementById('folder-header-' + state.moved);
    var row = header && (header.closest('tr') || header);
    if (row) {
      row.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      if (window.RFMotion && !window.RFMotion.reduced()) {
        var style = window.getComputedStyle(row);
        var previous = row.style.backgroundColor;
        window.RFMotion.animate(row, {
          backgroundColor: [style.getPropertyValue('--rf-flash').trim(), style.getPropertyValue('--rf-flash-end').trim()],
          duration: window.RFMotion.tokens.med,
          onComplete: function () { row.style.backgroundColor = previous; },
        });
      }
    }
    if (!document.activeElement || document.activeElement === document.body) {
      var arrow = document.getElementById('folder-move-up-' + state.moved) ||
        document.getElementById('folder-move-down-' + state.moved);
      if (arrow) arrow.focus({ preventScroll: true });
    }
  });
})();
