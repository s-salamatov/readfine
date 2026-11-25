// Digest, saved configurations and briefing sheet. One delegated owner across boosts.
(function () {
  'use strict';
  if (window.RFCatchup) return;
  var state = null;
  var requests = new WeakMap();
  var initialized = new WeakMap();
  function id(value) { return document.getElementById(value); }
  function byValue(root, selector, value) {
    return Array.from(root.querySelectorAll(selector)).find(function (el) { return el.value === value; });
  }
  function online(el) {
    var page = window.RFOffline && window.RFOffline.page;
    var current = page && page.current && page.current();
    return navigator.onLine !== false && !(current && current.isOffline()) &&
      !(el && (el.disabled || el.closest('[aria-disabled="true"], [disabled]')));
  }
  function toast(message) {
    if (window.RFToast) window.RFToast.show({ msg: message, type: 'error' });
    else if (window.showToast) window.showToast(message, 'error');
  }
  function notice(target, message) {
    if (!target) return;
    var alert = document.createElement('div');
    alert.className = 'alert'; alert.dataset.variant = 'destructive';
    alert.setAttribute('role', 'alert'); alert.textContent = message;
    target.replaceChildren(alert);
  }
  function cancel(s, kind) {
    s.pending.forEach(function (meta, xhr) {
      if (!kind || meta.kind === kind) {
        meta.cancelled = true;
        s.pending.delete(xhr);
        if (xhr.abort) xhr.abort();
      }
    });
  }
  function later(fn, ms) {
    var s = state;
    var timer = setTimeout(function () { s.timers.delete(timer); if (s === state && s.root.isConnected) fn(); }, ms);
    s.timers.add(timer); return timer;
  }
  function dispose(s) {
    s.timers.forEach(clearTimeout); clearTimeout(s.estimateTimer); cancel(s);
  }
  // Focus stays inside the briefing sheet, opened or refilled. Chromium focuses the
  // first control of a showModal() dialog; WebKit focuses the <dialog> itself, and a
  // Tab from there can leave it (the body ends up focused), while the sheet's own
  // content is still "Loading…" at open time. So open moves focus to the sheet's
  // close button, the loaded form gets the focus explicitly, and Tab is cycled here.
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      return !el.hidden && el.getClientRects().length > 0;
    });
  }
  function focusFirst(root) {
    var list = focusables(root);
    if (list.length) { list[0].focus(); return true; }
    return false;
  }
  function trapFocus(dialog, event) {
    if (!dialog.open) return;
    var list = focusables(dialog);
    if (!list.length) { event.preventDefault(); dialog.focus(); return; }
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (!dialog.contains(active) || active === dialog) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault(); first.focus();
    }
  }
  function init(root) {
    root = root || document;
    var section = root.id === 'assistant-catch-up' ? root : root.querySelector('#assistant-catch-up');
    if (state && !state.root.isConnected) { dispose(state); state = null; }
    if (!section || !section.isConnected) return;
    if (state && state.root === section) return;
    if (state) dispose(state);
    state = initialized.get(section);
    if (!state) {
      state = { root: section, pending: new Map(), timers: new Set(), estimateVersion: 0,
        sheetVersion: 0, busy: false, jobUrl: null, opener: null, configId: null };
      initialized.set(section, state);
    }
    updatePeriodDesc(); applyScoreFilter(); triggerEstimateRefresh();
    var dialog = id('rf-briefing-sheet');
    if (dialog && !dialog.dataset.catchupBound) {
      dialog.dataset.catchupBound = 'true';
      dialog.addEventListener('keydown', function (e) { if (e.key === 'Tab') trapFocus(dialog, e); });
      dialog.addEventListener('close', function () {
        if (!state || !state.root.contains(dialog)) return;
        state.sheetVersion++; cancel(state, 'sheet'); cancel(state, 'briefing'); cancel(state, 'test');
        var s = state;
        // RFDialog first returns focus to a connected opener. After a list swap,
        // find the equivalent action on the new row, or the section heading.
        queueMicrotask(function () {
          if (s !== state || !s.root.isConnected || dialog.open) return;
          var row = id('catchup-config-' + s.configId);
          var opener = row && row.querySelector('[data-action="open-briefing-modal"]');
          (opener || id('assistant-catch-up-heading')).focus();
        });
      });
    }
  }
  function updatePeriodDesc() {
    var data = id('period-descs-data'), descs = {};
    try { if (data) descs = JSON.parse(data.textContent) || {}; } catch (_) { /* optional context */ }
    var selected = document.querySelector('#catchup-form input[name="period"]:checked');
    if (id('period-desc')) id('period-desc').textContent = selected ? descs[selected.value] || '' : '';
  }
  function applyScoreFilter() {
    var enabled = id('score-filter-enabled'), input = id('score-filter-value');
    var on = !!(enabled && enabled.checked);
    if (id('score-value-row')) id('score-value-row').classList.toggle('hidden', !on);
    if (input) { if (on) input.name = 'filter_score_min'; else input.removeAttribute('name'); }
  }
  function triggerEstimateRefresh() {
    if (!state) return;
    var s = state;
    clearTimeout(s.estimateTimer); s.estimateVersion++; cancel(s, 'estimate');
    s.estimateTimer = setTimeout(function () {
      var form = id('catchup-form'), target = id('catchup-estimate');
      if (s !== state || !s.root.isConnected || !form || !target || !online(form)) return;
      var params = new URLSearchParams();
      new FormData(form).forEach(function (val, key) { if (key !== 'custom_prompt') params.append(key, val); });
      ajax('GET', '/htmx/catch-me-up/estimate?' + params.toString(), target, target);
    }, 300);
  }
  function ajax(method, url, source, target, values) {
    if (!state || !state.root.isConnected || !online(source)) return;
    var result = htmx.ajax(method, url, { source: source, target: target, swap: 'innerHTML', values: values || {} });
    if (result && result.catch) result.catch(function () { /* handled by request events */ });
  }
  function scrollToResult() {
    var result = id('catchup-result');
    if (result) result.scrollIntoView({ behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
  function _applyConfig(cfg, expandPanel) {
    var form = document.getElementById('catchup-form');
    var settingsPanel = document.getElementById('settings-panel');
    var settingsArrow = document.getElementById('settings-toggle-arrow');
    if (!form) return;

    // Expand settings panel if collapsed and requested
    if (expandPanel && settingsPanel && settingsPanel.classList.contains('hidden')) {
      settingsPanel.classList.remove('hidden');
      if (settingsArrow) settingsArrow.classList.add('rotate-90');
    }

    // Period
    var periodRadio = byValue(form, 'input[name="period"]', cfg.period);
    if (periodRadio) periodRadio.checked = true;

    // Filter status
    var statusRadio = byValue(form, 'input[name="filter_status"]', cfg.filter_status);
    if (statusRadio) statusRadio.checked = true;

    // Score filter (independent toggle; only present when scoring is available)
    var hasScore = cfg.filter_score_min !== null && cfg.filter_score_min !== undefined;
    var scoreEnabledCb = document.getElementById('score-filter-enabled');
    var scoreInput = document.getElementById('score-filter-value');
    if (scoreInput && hasScore) {
      scoreInput.value = Math.round(cfg.filter_score_min * 100);
    }
    if (scoreEnabledCb) {
      scoreEnabledCb.checked = hasScore;
      applyScoreFilter();
    }

    // Article limit
    var limitInput = document.getElementById('article-limit');
    if (limitInput) limitInput.value = cfg.article_limit;

    // Include snippet
    var snippetCb = form.querySelector('input[name="include_snippet"]');
    if (snippetCb) snippetCb.checked = !!cfg.include_snippet;

    // Custom prompt
    var promptTextarea = document.getElementById('custom-prompt');
    var promptPanel = document.getElementById('prompt-panel');
    var promptArrow = document.getElementById('prompt-toggle-arrow');
    if (promptTextarea) {
      promptTextarea.value = cfg.custom_prompt || '';
      if (cfg.custom_prompt && promptPanel) {
        promptPanel.classList.remove('hidden');
        if (promptArrow) promptArrow.classList.add('rotate-90');
      }
      if (window._refreshInsertDefaultLabels) window._refreshInsertDefaultLabels();
    }

    // Scope — update hidden input and re-init checkboxes
    var scopeHidden = document.getElementById('scope-value');
    if (scopeHidden) {
      scopeHidden.value = cfg.scope_include || '';
      // Re-init checkboxes
      var allCb = document.getElementById('scope-all');
      var items = document.querySelectorAll('input.scope-item-cb[data-selector="scope"]');
      items.forEach(function (cb) { cb.checked = false; cb.style.opacity = ''; });
      if (cfg.scope_include) {
        try {
          var selected = JSON.parse(cfg.scope_include);
          selected.forEach(function (val) {
            var cb = byValue(form, 'input.scope-item-cb[data-selector="scope"]', val);
            if (cb) cb.checked = true;
          });
          if (allCb) allCb.checked = false;
        } catch (e) {}
      } else {
        if (allCb) allCb.checked = true;
        items.forEach(function (cb) { cb.style.opacity = '0.35'; });
      }
    }

    // Labels — update hidden input and re-init checkboxes (mirrors scope)
    var labelHidden = document.getElementById('catchup-label-value');
    if (labelHidden) {
      labelHidden.value = cfg.label_filter || '';
      var labelAny = document.getElementById('catchup-label-any');
      var labelItems = document.querySelectorAll('input.label-item-cb[data-selector="catchup-label"]');
      if (labelAny) labelAny.checked = false;
      labelItems.forEach(function (cb) { cb.checked = false; cb.style.opacity = ''; });
      if (cfg.label_filter) {
        try {
          var selectedLabels = JSON.parse(cfg.label_filter);
          if (selectedLabels.indexOf('any') !== -1) {
            if (labelAny) labelAny.checked = true;
            labelItems.forEach(function (cb) { cb.style.opacity = '0.35'; });
          } else {
            selectedLabels.forEach(function (val) {
              var cb = byValue(form, 'input.label-item-cb[data-selector="catchup-label"]', val);
              if (cb) cb.checked = true;
            });
          }
        } catch (e) {}
      }
    }

    // Fill name input in save form
    var nameInput = document.querySelector('#save-config-form [name=name]');
    if (nameInput) nameInput.value = cfg.name;

    updatePeriodDesc();
    triggerEstimateRefresh();
  }

  function openBriefingModal(configId, configName, opener) {
    if (!state || !online(opener)) return;
    var dialog = id('rf-briefing-sheet'), body = id('rf-briefing-sheet-body');
    if (!dialog || !body) return;
    state.sheetVersion++; cancel(state, 'sheet'); cancel(state, 'briefing'); cancel(state, 'test');
    state.configId = String(configId); state.opener = opener;
    id('rf-briefing-sheet-title').textContent = 'Briefing — ' + configName;
    body.textContent = 'Loading…';
    window.RFDialog.open(dialog, opener);
    // The body has no control yet; keep focus on the sheet's own close button until
    // the form arrives (see focusables()).
    if (!focusFirst(dialog)) dialog.focus();
    ajax('GET', '/htmx/catchup-configs/' + encodeURIComponent(configId) + '/briefing', body, body);
  }
  function closeBriefingModal() {
    var dialog = id('rf-briefing-sheet');
    if (dialog && dialog.open) dialog.close();
  }
  function closeMenus() {
    document.querySelectorAll('[id^="config-menu-"]').forEach(function (menu) {
      if (!menu.id.startsWith('config-menu-container-')) menu.classList.add('hidden');
    });
  }
  function renameConfig(button) {
    closeMenus();
    var configId = button.dataset.configId, row = id('catchup-config-' + configId);
    if (!row || id('rename-input-' + configId)) return;
    var original = row.querySelector('[data-action="load-catchup-config"]');
    if (!original) return;
    var wrapper = document.createElement('div'); wrapper.className = 'flex gap-2 min-w-0';
    var input = document.createElement('input');
    input.id = 'rename-input-' + configId; input.className = 'input'; input.maxLength = 100;
    input.value = button.dataset.configName; input.setAttribute('aria-label', 'Configuration name');
    var save = document.createElement('button'); save.type = 'button'; save.className = 'btn';
    save.textContent = 'Save'; save.dataset.action = 'save-config-rename'; save.dataset.configId = configId;
    save.setAttribute('data-rf-online-only', '');
    wrapper.append(input, save); original.replaceWith(wrapper); input.focus(); input.select();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') wrapper.replaceWith(original);
      if (e.key === 'Enter') { e.preventDefault(); saveRename(configId, save); }
    });
    input.addEventListener('blur', function () {
      later(function () { if (wrapper.isConnected && !wrapper.contains(document.activeElement)) wrapper.replaceWith(original); }, 150);
    });
  }
  function saveRename(configId, source) {
    var input = id('rename-input-' + configId);
    if (!input || !input.value.trim()) { if (input) input.focus(); return; }
    ajax('PUT', '/htmx/catchup-configs/' + encodeURIComponent(configId) + '/rename', source,
      id('catchup-configs-list-wrapper'), { name: input.value.trim() });
  }
  function copyResult() {
    var result = id('catchup-result');
    if (!result || !result.querySelector('.prose') || !navigator.clipboard) return;
    navigator.clipboard.writeText((result.innerText || result.textContent).trim()).then(function () {
      if (window.RFToast) window.RFToast.show({ msg: 'Copied.', type: 'success' });
    }).catch(function () { toast('Could not copy. Please try again.'); });
  }
  document.addEventListener('click', function (e) {
    var button = e.target.closest('button, [data-action]');
    if (!button || !state || !state.root.contains(button)) return;
    if (button.id === 'catchup-copy-btn') { copyResult(); return; }
    if (button.id === 'settings-toggle' || button.id === 'prompt-toggle') {
      var prefix = button.id === 'settings-toggle' ? 'settings' : 'prompt';
      var panel = id(prefix + '-panel');
      if (panel) {
        var opening = panel.classList.contains('hidden'); panel.classList.toggle('hidden');
        button.setAttribute('aria-expanded', String(opening));
        if (id(prefix + '-toggle-arrow')) id(prefix + '-toggle-arrow').classList.toggle('rotate-90', opening);
        if (opening && prefix === 'settings') triggerEstimateRefresh();
      }
      return;
    }
    var action = button.dataset.action;
    if (action === 'close-briefing-modal') { closeBriefingModal(); return; }
    if (!action) return;
    if (!online(button)) { e.preventDefault(); toast('Connect to the internet to use Catch me up.'); return; }
    if (action === 'open-briefing-modal') openBriefingModal(button.dataset.configId, button.dataset.configName, button);
    else if (action === 'load-catchup-config' || action === 'generate-catchup-config') {
      var cfg;
      try { cfg = JSON.parse(button.dataset.config); } catch (_) { return; }
      if (!cfg || typeof cfg !== 'object') return;
      _applyConfig(cfg, action === 'load-catchup-config');
      if (action === 'generate-catchup-config' && !state.busy && !state.jobUrl) id('catchup-form').requestSubmit();
    } else if (action === 'toggle-config-menu') {
      var menu = id('config-menu-' + button.dataset.configId), wasHidden = menu && menu.classList.contains('hidden');
      closeMenus(); if (menu && wasHidden) menu.classList.remove('hidden');
    } else if (action === 'rename-config') renameConfig(button);
    else if (action === 'save-config-rename') saveRename(button.dataset.configId, button);
    else if (action === 'delete-config') {
      ajax('DELETE', '/htmx/catchup-configs/' + encodeURIComponent(button.dataset.configId), button, id('catchup-configs-list-wrapper'));
    } else if (action === 'retry-catchup-poll' && state.jobUrl) {
      ajax('GET', state.jobUrl, button, id('catchup-result'));
    }
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('[id^="config-menu-container-"]')) closeMenus(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });
  document.addEventListener('change', function (e) {
    if (!state || !state.root.contains(e.target)) return;
    if (e.target.closest('#catchup-form')) { applyScoreFilter(); updatePeriodDesc(); triggerEstimateRefresh(); }
    if (e.target.dataset.action === 'toggle-briefing-fields' && id('briefing-fields')) id('briefing-fields').classList.toggle('hidden', !e.target.checked);
    if (e.target.dataset.action === 'toggle-briefing-day' && id('briefing-day-row')) id('briefing-day-row').classList.toggle('hidden', e.target.value !== 'weekly');
  });
  document.addEventListener('input', function (e) { if (e.target.id === 'article-limit') triggerEstimateRefresh(); });

  function kindOf(elt) {
    if (!elt) return null;
    if (elt.id === 'catchup-estimate') return 'estimate';
    if (elt.id === 'rf-briefing-sheet-body') return 'sheet';
    if (elt.id === 'briefing-form') return 'briefing';
    if (elt.hasAttribute('data-briefing-test')) return 'test';
    if (elt.id === 'catchup-form') return 'generate';
    if (elt.id === 'save-config-form' || /^(save-config-rename|delete-config)$/.test(elt.dataset.action || '')) return 'list';
    if ((elt.getAttribute('hx-get') || '').startsWith('/htmx/catch-me-up/jobs/') || elt.dataset.action === 'retry-catchup-poll') return 'poll';
    return null;
  }
  function retryPoll(message) {
    notice(id('catchup-result'), message);
    if (state && state.jobUrl && id('catchup-result')) {
      var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn';
      retry.dataset.action = 'retry-catchup-poll'; retry.setAttribute('data-rf-online-only', '');
      retry.textContent = 'Check briefing again'; id('catchup-result').append(retry);
    }
  }
  function failure(meta, status) {
    if (!state || meta.state !== state || !state.root.isConnected) return;
    var message = status === 404 ? 'Configuration not found.' :
      status === 429 ? 'Wait a moment before sending another test.' :
      status === 403 ? 'Access denied. Refresh the page and try again.' :
      'Could not load the response. Check your connection or sign in, then try again.';
    if (meta.kind === 'sheet') notice(id('rf-briefing-sheet-body'), message);
    else if (meta.kind === 'briefing') notice(id('briefing-form-error'), message);
    else if (meta.kind === 'test') notice(id('briefing-test-result'), message);
    else if (meta.kind === 'poll') retryPoll('Could not check the briefing. Reconnect and try again.');
    else if (meta.kind === 'generate') { state.busy = false; notice(id('catchup-result'), message); }
    else if (meta.kind === 'estimate') notice(id('catchup-estimate'), message);
    else toast(message);
  }
  document.addEventListener('htmx:beforeRequest', function (e) {
    var detail = e.detail, kind = kindOf(detail.elt);
    if (!kind) return;
    if (!state || !state.root.isConnected || !state.root.contains(detail.elt) || !online(detail.elt)) {
      e.preventDefault(); stopOffline(); return;
    }
    if (kind === 'generate' && (state.busy || state.jobUrl)) { e.preventDefault(); return; }
    if (kind === 'poll' && Array.from(state.pending.values()).some(function (m) { return m.kind === 'poll'; })) { e.preventDefault(); return; }
    if ((kind === 'list' || kind === 'briefing' || kind === 'test') &&
        Array.from(state.pending.values()).some(function (m) { return m.source === detail.elt; })) { e.preventDefault(); return; }
    if (detail.elt.id === 'save-config-form' && !detail.elt.querySelector('[name=name]').value.trim()) {
      e.preventDefault(); toast('Enter a configuration name.'); return;
    }
    if (kind === 'generate') { state.busy = true; scrollToResult(); if (id('catchup-spinner')) id('catchup-spinner').classList.remove('hidden'); }
    var meta = { kind: kind, state: state, source: detail.elt, estimateVersion: state.estimateVersion, sheetVersion: state.sheetVersion };
    requests.set(detail.xhr, meta); state.pending.set(detail.xhr, meta);
    if (kind === 'poll') state.jobUrl = detail.elt.getAttribute('hx-get') || state.jobUrl;
  });
  function stale(meta) {
    return meta.cancelled || meta.state !== state || !state.root.isConnected || !online() ||
      (meta.kind === 'estimate' && meta.estimateVersion !== state.estimateVersion) ||
      (/^(sheet|briefing|test)$/.test(meta.kind) && meta.sheetVersion !== state.sheetVersion);
  }
  document.addEventListener('htmx:beforeOnLoad', function (e) {
    var detail = e.detail, meta = requests.get(detail.xhr);
    if (!meta) return;
    if (stale(meta)) { e.preventDefault(); return; }
    var xhr = detail.xhr, html = xhr.responseText || '', path = '';
    try { path = new URL(xhr.responseURL, location.href).pathname; } catch (_) { /* invalid response */ }
    var valid = xhr.status >= 200 && xhr.status < 300 && path.startsWith('/htmx/') &&
      !/<(?:!doctype|html|body|head)\b/i.test(html) && !xhr.getResponseHeader('X-Readfine-Offline');
    var parsed = document.createElement('template'); parsed.innerHTML = html;
    var content = parsed.content;
    var validation = meta.kind === 'briefing' && xhr.getResponseHeader('HX-Retarget') === '#briefing-form-error';
    if (valid && meta.kind === 'sheet') valid = !!content.querySelector('#briefing-form, .alert');
    if (valid && (meta.kind === 'list' || (meta.kind === 'briefing' && !validation))) valid = !!content.querySelector('[data-rf-catchup-list]');
    if (valid && validation) valid = !!content.querySelector('.alert');
    if (valid && meta.kind === 'test') valid = !!content.querySelector('.alert');
    if (valid && (meta.kind === 'generate' || meta.kind === 'poll')) {
      var progress = content.querySelector('[hx-get]');
      valid = !!content.querySelector('.prose, .alert') || !!(progress &&
        /^\/htmx\/catch-me-up\/jobs\/[\w-]+$/.test(progress.getAttribute('hx-get')) &&
        progress.getAttribute('hx-trigger') === 'load delay:3s' && progress.getAttribute('hx-target') === '#catchup-result');
      if (valid) state.jobUrl = progress ? progress.getAttribute('hx-get') : null;
    }
    if (!valid) { e.preventDefault(); meta.failed = true; failure(meta, xhr.status); }
  });
  document.addEventListener('htmx:beforeSwap', function (e) {
    var meta = requests.get(e.detail.xhr);
    if (meta && (meta.failed || stale(meta))) { e.detail.shouldSwap = false; e.preventDefault(); }
  });
  document.addEventListener('htmx:afterSwap', function (e) {
    var target = e.detail.target;
    if (!target || !state) return;
    var meta = requests.get(e.detail.xhr);
    // The sheet's form arrives after showModal(): move focus out of "Loading…" into
    // the loaded control (the close button had it), so Tab continues inside the sheet.
    if (target.id === 'rf-briefing-sheet-body' && meta && meta.kind === 'sheet' &&
        !target.contains(document.activeElement)) focusFirst(target);
    if (target.id === 'catchup-configs-list-wrapper' && meta && meta.kind === 'briefing' && target.querySelector('[data-rf-catchup-list]')) closeBriefingModal();
    if (target.id === 'catchup-result' && id('catchup-copy-btn')) id('catchup-copy-btn').classList.toggle('hidden', !target.querySelector('.prose'));
    if (target.id === 'briefing-test-result') {
      var ok = target.querySelector('[data-briefing-test-ok]');
      if (ok) later(function () { ok.remove(); }, 5000);
    }
  });
  document.addEventListener('htmx:afterRequest', function (e) {
    var meta = requests.get(e.detail.xhr);
    if (!meta) return;
    meta.state.pending.delete(e.detail.xhr);
    if (meta.state !== state || meta.cancelled) return;
    if (meta.kind === 'generate') { state.busy = false; if (id('catchup-spinner')) id('catchup-spinner').classList.add('hidden'); }
    if (meta.source.id === 'save-config-form' && !meta.failed && e.detail.successful) meta.source.querySelector('[name=name]').value = '';
  });
  ['htmx:sendError', 'htmx:timeout', 'htmx:responseError'].forEach(function (name) {
    document.addEventListener(name, function (e) {
      var meta = requests.get(e.detail.xhr);
      if (!meta && kindOf(e.detail.elt) === 'test') meta = { kind: 'test', state: state };
      if (!meta || meta.cancelled || meta.failed) return;
      e.detail._rfHandled = true; meta.failed = true;
      failure(meta, e.detail.xhr && e.detail.xhr.status);
    });
  });
  function stopOffline() {
    if (!state) return;
    if (online()) { state.offlineStopped = false; return; }
    if (state.offlineStopped) return;
    state.offlineStopped = true;
    clearTimeout(state.estimateTimer); cancel(state); state.busy = false;
    if (id('catchup-spinner')) id('catchup-spinner').classList.add('hidden');
    if (state.jobUrl) retryPoll('Connect to the internet to check this briefing.');
  }
  window.addEventListener('offline', stopOffline);
  document.addEventListener('rf:offline-change', stopOffline);
  // Forced offline changes online-only attributes through the shared overlay.
  new MutationObserver(function () {
    if (state && !state.root.isConnected) { dispose(state); state = null; }
    else stopOffline();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
  window.addEventListener('pagehide', function () { if (state) dispose(state); });
  document.addEventListener('DOMContentLoaded', function () { init(); });
  document.addEventListener('htmx:afterSettle', function () { init(); });
  window.openBriefingModal = openBriefingModal;
  window.closeBriefingModal = closeBriefingModal;
  window.RFCatchup = { init: init };
  if (document.readyState !== 'loading') init();
})();
