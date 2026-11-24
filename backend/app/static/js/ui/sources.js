// One Sources sheet per document. HTMX owns HTML transport and swapping; this
// controller owns lifecycle, discovery timing and stale/failed response guards.
(function () {
  'use strict';
  if (window.RFSources) return; // boosted pages can load this script again
  var doc = document;
  var sheetId = 'rf-source-sheet';
  var bodyId = 'rf-source-sheet-body';
  var addPath = '/sources/add';
  var sequence = 0;
  var opening = 0;
  var discovery = 0;
  var timer = null;
  var requests = new WeakMap();
  var lastDiscovery = new WeakMap();
  var queued = new Map();
  var menus = new Map();
  var watchedSheets = new WeakSet();
  var originalOpener = null;

  function offline() {
    var page = window.RFOffline && window.RFOffline.page;
    var ctl = page && page.current && page.current();
    return navigator.onLine === false || !!(ctl && ctl.isOffline && ctl.isOffline());
  }
  function connectionMessage() {
    if (window.RFToast) window.RFToast.show('Connect to the internet to manage sources.', 'error');
  }
  function disabled(element) {
    return element && element.closest && element.closest('[aria-disabled="true"]');
  }
  function allowed(url) {
    try {
      var parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin || parsed.username || parsed.password) return null;
      if (!/^\/(?:settings\/feeds\/(?:add|\d+\/edit|scrape-setup)|settings\/opml|sources\/(?:add|feeds\/\d+\/edit|opml|scrape))$/.test(parsed.pathname)) return null;
      return parsed.pathname + parsed.search;
    } catch (e) { return null; }
  }
  function addForm(element) {
    return element && element.closest && element.closest('[data-rf-source-form="add"]');
  }
  function cancelDiscovery() {
    clearTimeout(timer);
    timer = null;
    discovery++;
  }
  function visible(el) {
    if (!el || !el.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var css = window.getComputedStyle(node);
      if (css.display === 'none' || css.visibility === 'hidden') return false;
      if (node.tagName === 'DIALOG' && !node.open) return false;
    }
    return true;
  }
  function watchSheet(sheet) {
    if (watchedSheets.has(sheet)) return;
    watchedSheets.add(sheet);
    sheet.addEventListener('close', function () {
      opening++;
      cancelDiscovery();
      var opener = originalOpener;
      // RFDialog's own close listener restores its opener first. A microtask
      // supplies the fallback only when the original trigger is no longer visible.
      Promise.resolve().then(function () {
        if (!visible(opener)) {
          var heading = doc.querySelector('#sources-heading, #sources-main h1, main h1');
          if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
        }
      });
      var body = doc.getElementById(bodyId);
      if (body) body.replaceChildren(); // release inputs/credentials on close
    });
  }
  function send(method, url, source, target, record, values) {
    if (!window.htmx) return;
    var id = String(++sequence);
    queued.set(id, record);
    var options = {
      source: source, target: target, swap: 'innerHTML', values: values || {},
      headers: { 'X-RF-Sources-Request': id, 'HX-Target': target.slice(1) },
    };
    var result = window.htmx.ajax(method, url, options);
    // HTMX reports failures as events; consume the rejected Promise as well.
    if (result && result.catch) result.catch(function () { fail(record, 'Network error. Check your connection and retry.'); });
  }
  function current(record) {
    return record && record.target && record.target.isConnected &&
      (record.kind === 'discovery' || record.version === opening) &&
      (record.kind !== 'discovery' || record.version === discovery);
  }
  function fail(record, message) {
    if (!current(record)) return;
    var target = record.target;
    if (record.kind === 'form' && target.querySelector('form')) {
      var error = target.querySelector('[data-rf-source-error]');
      if (!error) {
        error = doc.createElement('p');
        error.setAttribute('data-rf-source-error', '');
        error.setAttribute('role', 'alert');
        error.className = 'text-sm text-destructive';
        target.prepend(error);
      }
      error.textContent = message;
    } else target.textContent = message;
  }
  function afterDialogClose(dialog, next) {
    dialog.addEventListener('close', next, { once: true });
    dialog.close();
  }
  function standaloneForm(sheet) {
    return Array.from(doc.querySelectorAll('form[data-rf-source-form], form[data-rf-online-only], main form')).find(function (form) {
      if (sheet.contains(form)) return false;
      if (form.hasAttribute('data-rf-source-form')) return true;
      // Legacy edit/OPML/scrape pages lack the Add marker. Their shipped
      // actions identify Sources forms without capturing unrelated settings.
      var action = form.getAttribute('action') || form.getAttribute('hx-post');
      if (!action) return false;
      try {
        var url = new URL(action, location.href);
        return url.origin === location.origin && /^\/(?:settings\/(?:feeds(?:\/\d+\/edit|\/scrape)?|opml\/(?:import|export))|sources(?:\/feeds\/\d+\/edit|\/scrape|\/opml\/(?:import|export))?)$/.test(url.pathname);
      } catch (e) { return false; }
    });
  }
  function open(url, opener) {
    if (disabled(opener)) return;
    var path = allowed(url);
    if (!path) return;
    if (offline()) { connectionMessage(); return; }
    var sheet = doc.getElementById(sheetId), body = doc.getElementById(bodyId);
    if (!sheet || !body) return;
    var pageForm = standaloneForm(sheet);
    if (pageForm) {
      if (pageForm.matches('[data-rf-source-form="add"]') && /\/add$/.test(path)) {
        var input = pageForm.querySelector('#feed-url-input');
        if (input) input.focus();
      } else location.assign(path);
      return;
    }
    cancelDiscovery();
    var version = ++opening;
    function show() {
      if (version !== opening || !sheet.isConnected || disabled(opener)) return;
      if (offline()) { connectionMessage(); return; }
      if (!sheet.open) {
        originalOpener = opener;
        window.RFDialog.open(sheet, opener);
        watchSheet(sheet);
      }
      body.textContent = 'Loading…';
      doc.getElementById('rf-source-sheet-title').textContent = 'Source';
      send('GET', path, body, '#' + bodyId, { kind: 'load', version: version, target: body });
    }
    function afterPalette() {
      if (doc.documentElement.classList.contains('mobile-sidebar-open') && window._closeMobileSidebarOverlay) {
        // Shell closes its phone sheet via history.back(); focus settles on popstate.
        window.addEventListener('popstate', show, { once: true });
        window._closeMobileSidebarOverlay();
      } else show();
    }
    var modal = doc.querySelector('dialog[open]:not(#' + sheetId + ')');
    if (modal) afterDialogClose(modal, afterPalette);
    else afterPalette();
  }
  function discoverySignature(form) {
    return JSON.stringify(['url', 'fetch_auth_user', 'fetch_auth_pass'].map(function (name) {
      var input = form.elements.namedItem(name);
      return input ? (name === 'url' ? input.value.trim() : input.value) : '';
    }));
  }
  function discover(form, automatic) {
    if (!visible(form)) return;
    var signature = discoverySignature(form);
    if (automatic && lastDiscovery.get(form) === signature) return;
    cancelDiscovery();
    var input = form.querySelector('#feed-url-input');
    var target = form.querySelector('#feed-test-result');
    if (!input || !input.value.trim() || !target) return;
    if (offline()) { target.textContent = 'Connect to the internet to test this source.'; return; }
    var values = {};
    new FormData(form).forEach(function (value, key) { values[key] = value; });
    lastDiscovery.set(form, signature);
    target.textContent = 'Checking feed…';
    var action = form.getAttribute('action') || form.getAttribute('hx-post') || '/sources';
    send('POST', action + '/test', form, '#feed-test-result', {
      kind: 'discovery', version: discovery, target: target,
    }, values);
  }
  function refresh() {
    var target = doc.getElementById('feeds-list');
    if (target && window.htmx && !offline()) {
      var tab = doc.getElementById('tab-feeds');
      var path = (tab && tab.getAttribute('hx-get')) || '/sources/feeds-list';
      var result = window.htmx.ajax('GET', path, { target: '#feeds-list', swap: 'outerHTML', source: tab || target });
      if (result && result.catch) result.catch(function () { connectionMessage(); });
    }
  }

  // Capture before palette/Basecoat item handlers close their modal or HTMX boosts
  // the real fallback href. Modified clicks retain ordinary browser navigation.
  doc.addEventListener('click', function (event) {
    var target = event.target.closest && event.target.closest('a');
    if (!target) return;
    var href = target.getAttribute('href') || '';
    if (href === '/settings/feeds#feed-url-input' || href === '/sources#feed-url-input') href = addPath;
    else if (!target.hasAttribute('data-rf-source-sheet')) return;
    if (!allowed(href)) return;
    if (!disabled(target) && (event.button || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open(href, target);
  }, true);
  doc.addEventListener('click', function (event) {
    var form = addForm(event.target);
    if (!form) return;
    var candidate = event.target.closest('[data-select-detected-feed]');
    if (candidate) {
      event.preventDefault();
      cancelDiscovery();
      form.querySelector('#feed-url-input').value = candidate.getAttribute('data-url') || '';
      var title = form.querySelector('#feed-custom-title');
      title.placeholder = candidate.getAttribute('data-title') || title.dataset.defaultPlaceholder;
      form.querySelector('#feed-test-result').replaceChildren();
      return;
    }
    if (event.target.closest('[data-rf-source-test]')) { event.preventDefault(); discover(form); }
  });
  doc.addEventListener('input', function (event) {
    var form = addForm(event.target);
    if (!form || !/^(url|fetch_auth_user|fetch_auth_pass)$/.test(event.target.name)) return;
    clearTimeout(timer);
    timer = null;
    if (lastDiscovery.get(form) === discoverySignature(form)) return;
    cancelDiscovery();
    if (!visible(form)) return;
    var title = form.querySelector('#feed-custom-title');
    title.placeholder = title.dataset.defaultPlaceholder || 'Custom title (optional)';
    form.querySelector('#feed-test-result').replaceChildren();
    timer = setTimeout(function () { discover(form, true); }, 800);
  });
  doc.addEventListener('keydown', function (event) {
    var form = addForm(event.target);
    if (form && event.target.id === 'feed-url-input' && event.key === 'Enter') {
      event.preventDefault(); discover(form);
    }
  });
  doc.addEventListener('submit', function (event) {
    if (addForm(event.target)) cancelDiscovery();
  }, true);

  doc.addEventListener('htmx:beforeRequest', function (event) {
    var detail = event.detail;
    var config = detail.requestConfig || {};
    var id = config.headers && config.headers['X-RF-Sources-Request'];
    var record = queued.get(id);
    if (record) queued.delete(id);
    var source = detail.elt;
    var scope = '#rf-source-sheet, [data-rf-source-sheet], [data-rf-online-only], [data-rf-source-form]';
    var sourceRequest = source && source.closest && (source.closest(scope) || (source.form && source.form.closest(scope)));
    if (sourceRequest && offline()) {
      event.preventDefault();
      cancelDiscovery();
      connectionMessage();
      return;
    }
    if (!record && detail.elt && detail.elt.closest && detail.elt.closest('#' + bodyId)) {
      record = { kind: 'form', target: detail.target, version: opening };
    }
    if (record && detail.xhr) requests.set(detail.xhr, record);
  });
  doc.addEventListener('htmx:beforeOnLoad', function (event) {
    var detail = event.detail, record = requests.get(detail.xhr);
    if (!record) return;
    if (!current(record)) { event.preventDefault(); return; }
    var xhr = detail.xhr;
    var html = xhr.responseText || '';
    var responsePath = '';
    try { responsePath = new URL(xhr.responseURL, location.href).pathname; } catch (e) { /* network failure */ }
    // This event precedes HX-Redirect/HX-Trigger processing, not only the swap.
    if (xhr.status === 429) {
      event.preventDefault();
      fail(record, 'Too many requests (429). Wait a minute, then use Test to retry.');
    } else if (responsePath === '/login' || /<(?:!doctype|html|body)\b/i.test(html) || xhr.getResponseHeader('HX-Redirect')) {
      event.preventDefault();
      fail(record, 'Your session may have expired. Sign in and retry.');
    } else if (xhr.status >= 400) {
      event.preventDefault();
      fail(record, 'Could not load this source (' + xhr.status + '). Check the address and retry.');
    }
  });
  ['htmx:sendError', 'htmx:timeout', 'htmx:responseError'].forEach(function (name) {
    doc.addEventListener(name, function (event) {
      fail(requests.get(event.detail.xhr), 'Network error. Check your connection and retry.');
    });
  });
  doc.addEventListener('htmx:afterSwap', function (event) {
    var record = requests.get(event.detail.xhr);
    if (record && record.kind === 'discovery' && current(record)) {
      var result = record.target.querySelector('[data-feed-title]');
      var form = addForm(record.target);
      if (form && result && result.dataset.feedTitle) form.querySelector('#feed-custom-title').placeholder = result.dataset.feedTitle;
    }
    var body = doc.getElementById(bodyId);
    if (record && record.kind === 'load' && current(record)) {
      var first = record.target.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
      if (first) first.focus();
    }
    if (body && body.contains(event.detail.target)) {
      var title = body.querySelector('[data-rf-source-title], h1, h2');
      if (title) doc.getElementById('rf-source-sheet-title').textContent = title.dataset.rfSourceTitle || title.textContent;
    }
    bootstrap();
  });
  doc.addEventListener('rf:sourceschanged', function (event) {
    cancelDiscovery();
    var sheet = doc.getElementById(sheetId);
    if (event.detail.kind !== 'opml' && sheet && sheet.open) sheet.close();
    refresh();
  });

  // Basecoat owns click/keyboard/Escape. Only placement belongs here: a fixed
  // panel must escape the table scroller and remain reachable at the viewport edge.
  function positionMenu(root) {
    var trigger = root.querySelector('[aria-expanded]');
    var panel = root.querySelector('[data-popover]');
    if (!trigger || !panel || trigger.getAttribute('aria-expanded') !== 'true') return;
    var anchor = trigger.getBoundingClientRect(), box = panel.getBoundingClientRect();
    var margin = 8;
    var left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin));
    var top = anchor.bottom + 4;
    if (top + box.height > window.innerHeight - margin) top = anchor.top - box.height - 4;
    top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
    panel.style.position = 'fixed';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';
    panel.style.maxWidth = Math.max(0, window.innerWidth - margin * 2) + 'px';
    panel.style.maxHeight = Math.max(0, window.innerHeight - margin * 2) + 'px';
    panel.style.overflowY = 'auto';
  }
  function positionMenus() {
    menus.forEach(function (observer, root) {
      if (!root.isConnected) { observer.disconnect(); menus.delete(root); }
    });
    doc.querySelectorAll('[data-rf-source-menu]').forEach(function (root) {
      if (!menus.has(root)) {
        var observer = new MutationObserver(function () { if (root.isConnected) positionMenu(root); });
        observer.observe(root, { attributes: true, subtree: true, attributeFilter: ['aria-expanded', 'aria-hidden', 'hidden'] });
        menus.set(root, observer);
      }
      positionMenu(root);
    });
  }
  doc.addEventListener('scroll', positionMenus, true);
  window.addEventListener('resize', positionMenus);
  new MutationObserver(positionMenus).observe(doc.documentElement, { childList: true, subtree: true });
  function bootstrap() {
    positionMenus();
    if (/^(?:\/settings\/feeds|\/sources)\/?$/.test(location.pathname)) {
      var url = new URL(location.href);
      if (url.searchParams.has('added')) {
        url.searchParams.delete('added');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      }
    }
    if (location.hash === '#feed-url-input' && /^(?:\/settings\/feeds|\/sources)\/?$/.test(location.pathname)) {
      history.replaceState(history.state, '', location.pathname + location.search);
      open(addPath, null);
    }
  }
  window.RFSources = { open: open, refresh: refresh, positionMenus: positionMenus };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
