// Shared reader-modal and Assistant-page chat lifecycle; HTMX is the transport.
(function () {
  if (window.RFAssistant) { window.RFAssistant.init(); return; }
  var _chatPending = {};
  var _requests = new WeakMap();
  var _active = new Map();
  var _generation = 0;
  var _page = null;
  var _articleId = '';
  var _articleTitle = '';
  var _viewports = new Map();

  function isOffline() {
    var page = window.RFOffline && window.RFOffline.page && window.RFOffline.page.current();
    return navigator.onLine === false || !!(page && page.isOffline());
  }
  function disabled(el) {
    return !el || !!el.closest('[disabled], [aria-disabled="true"]');
  }
  function chatArea(el) {
    return el && el.closest('#rf-assistant-chat, #general-chat-area, [id^="chat-area-"]');
  }
  function requestRecord(e) {
    return e.detail && e.detail.xhr && _requests.get(e.detail.xhr);
  }
  function stale(record) {
    return record && (record.done || !record.root.isConnected ||
      (record.page && record.generation !== _generation));
  }
  function finish(record) {
    if (!record) return;
    record.done = true;
    if (_active.get(record.root.id) === record) _active.delete(record.root.id);
    record.button.disabled = false;
    record.root.removeAttribute('aria-busy');
  }
  function releaseViewport(root) {
    var fn = _viewports.get(root);
    if (!fn) return;
    window.visualViewport.removeEventListener('resize', fn);
    window.visualViewport.removeEventListener('scroll', fn);
    _viewports.delete(root);
  }
  // A watched root is re-applied, not skipped: htmx settle puts back the swapped-in
  // element's own attributes, which drops the inline viewport value after every reply.
  function watchViewport(root, page) {
    if (!window.visualViewport) return;
    var fn = _viewports.get(root);
    if (fn) { fn(); return; }
    fn = function () {
      if (!root.isConnected) { releaseViewport(root); return; }
      if (page) root.style.setProperty('--rf-assistant-viewport-height', window.visualViewport.height + 'px');
      else applyVisualViewport(root);
    };
    _viewports.set(root, fn);
    window.visualViewport.addEventListener('resize', fn);
    window.visualViewport.addEventListener('scroll', fn);
    fn();
  }
  function cleanup() {
    _viewports.forEach(function (_, root) { if (!root.isConnected) releaseViewport(root); });
    _active.forEach(function (record) {
      if (!record.root.isConnected) {
        finish(record);
        delete _chatPending[record.key];
        if (record.xhr) record.xhr.abort();
      }
    });
  }
  function setScope(kind, articleId, fromHistory) {
    var area = document.getElementById('rf-assistant-chat');
    if (!area || (kind !== 'general' && kind !== 'article')) return false;
    if (kind === 'article' && (!_articleId || (articleId != null && String(articleId) !== _articleId))) return false;
    _generation++;
    var pending = _active.get(area.id);
    if (pending) { finish(pending); if (pending.xhr) pending.xhr.abort(); }
    delete _chatPending.general;
    area.querySelectorAll('[data-chat-error]').forEach(function (el) { el.remove(); });
    area.querySelector('#general-chat-history').value = '[]';
    area.querySelector('#general-chat-input').value = '';
    area.querySelector('#general-chat-messages').replaceChildren();
    area.querySelector('#general-chat-article-id').value = _articleId;
    area.querySelector('#general-chat-include-article').checked = kind === 'article';
    area.querySelector('#assistant-chat-scope').value = kind;
    area.querySelector('#assistant-chat-disclosure').textContent = kind === 'article'
      ? 'This conversation uses the selected article only.'
      : 'General conversation; it does not search your feeds or library.';
    area.querySelector('#assistant-chat-status').textContent = 'New conversation — ' + (kind === 'article' ? 'this article' : 'everything (general)');
    if (!fromHistory) {
      var url = new URL(location.href);
      url.searchParams.set('scope', kind);
      if (_articleId) url.searchParams.set('article_id', _articleId);
      history.pushState({}, '', url);
    }
    return true;
  }
  function syncProfileCounter() {
    var input = document.getElementById('ai_preference_text');
    if (!input) return;
    var count = input.value.length;
    document.querySelectorAll('#pref-char-count, .pref-char-count').forEach(function (counter) {
      counter.textContent = count;
      counter.parentElement.classList.toggle('text-destructive', count > 5000);
      counter.parentElement.classList.toggle('text-muted-foreground', count <= 5000);
    });
    input.setAttribute('aria-invalid', String(count > 5000));
  }
  function init(root) {
    cleanup();
    attachChatModal(root);
    attachChatKeydown(root);
    attachChatAttachBtn(root);
    attachArticlePlaceholder(root);
    attachGeneralChat();
    attachGeneralChatKeydown();
    syncProfileCounter();
    restoreGeneralChatSession();
    var page = document.getElementById('rf-assistant-chat');
    if (page && page !== _page) {
      _generation++;
      _page = page;
      _articleId = page.dataset.articleId || '';
      _articleTitle = page.dataset.articleTitle || '';
      if (new URL(location.href).searchParams.get('scope') === 'general') setScope('general', null, true);
    } else if (!page) { _page = null; }
    if (page) watchViewport(page, true);
    syncGeneralChatContext();
  }
  window.RFAssistant = { init: init, setScope: setScope, isOffline: isOffline };

  document.addEventListener('change', function (e) {
    if (e.target.id === 'assistant-chat-scope') setScope(e.target.value);
  });
  window.addEventListener('popstate', function () {
    var scope = new URL(location.href).searchParams.get('scope');
    setScope(scope === 'general' ? 'general' : (_articleId ? 'article' : 'general'), null, true);
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'ai_preference_text') syncProfileCounter();
  });
  document.addEventListener('htmx:oobAfterSwap', syncProfileCounter);

  // Capture before target listeners, including the profile's forms.
  function onlineGuard(e) {
    var el = e.detail && e.detail.elt || e.target;
    if (!el || !el.closest) return;
    if (!el.closest('[data-rf-online-only]') && !chatArea(el)) return;
    if (!isOffline() && !disabled(el)) return;
    e.preventDefault();
    if (e.type === 'click' || e.type === 'submit') e.stopImmediatePropagation();
  }
  document.addEventListener('click', onlineGuard, true);
  document.addEventListener('submit', onlineGuard, true);
  document.addEventListener('htmx:beforeRequest', onlineGuard, true);
  document.addEventListener('htmx:beforeRequest', function (e) {
    if (e.defaultPrevented) return;
    var btn = e.detail.elt;
    if (!btn.closest('#assistant-profile') || !btn.dataset.loadingTarget) return;
    var target = document.getElementById(btn.dataset.loadingTarget);
    if (target) { target.textContent = btn.dataset.loadingText || 'Loading…'; target.setAttribute('role', 'status'); }
  });
  // HTMX handles navigation headers before beforeSwap, including the auth
  // handler's 200 + HX-Redirect. Keep this single-response chat in place.
  function guardChatResponse(e) {
    var record = requestRecord(e);
    if (!record) return;
    if (stale(record)) { e.preventDefault(); return; }
    var xhr = e.detail.xhr;
    if (xhr.getResponseHeader('HX-Redirect') !== null ||
        xhr.getResponseHeader('HX-Location') !== null ||
        xhr.getResponseHeader('HX-Refresh') === 'true') {
      e.preventDefault();
      _handleChatCommError(record.button, 'Your session expired. Sign in in a new tab, then return here to retry your message.', true);
      _claimHtmxError(e);
    }
  }
  document.addEventListener('htmx:beforeSwap', function (e) {
    var record = requestRecord(e);
    if (!record) return;
    if (stale(record)) { e.detail.shouldSwap = false; e.preventDefault(); return; }
    var xhr = e.detail.xhr;
    var parsed = new DOMParser().parseFromString(xhr.responseText || '', 'text/html');
    var responsePath = xhr.responseURL ? new URL(xhr.responseURL, location.href).pathname : '';
    if (isOffline() || (responsePath && responsePath !== record.button.getAttribute('hx-post')) ||
        !parsed.getElementById(record.root.id) || parsed.querySelector('[data-rf-needs-connection]')) {
      e.detail.shouldSwap = false;
      e.preventDefault();
      _handleChatCommError(record.button, 'Request failed — please try again.');
      _claimHtmxError(e);
    }
  }, true);
  window.addEventListener('offline', function () {
    _active.forEach(function (record) {
      _handleChatCommError(record.button, 'No connection — please try again.');
      if (record.xhr) record.xhr.abort();
    });
  });

  function _escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _userBubble(msg, page) {
    var d = document.createElement('div');
    if (page) {
      d.className = 'rf-assistant-message'; d.dataset.role = 'user';
      d.textContent = msg; return d;
    }
    d.className = 'flex justify-end';
    d.innerHTML = '<div class="max-w-[85%] bg-blue-50 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200">' + _escHtml(msg) + '</div>';
    return d;
  }
  function _typingIndicator(id, page) {
    var d = document.createElement('div');
    d.id = id;
    d.setAttribute('role', 'status');
    d.setAttribute('aria-label', 'Waiting for reply');
    if (page || (window.RFMotion && window.RFMotion.reduced())) { d.textContent = 'Waiting for reply…'; return d; }
    d.className = 'flex justify-start';
    d.innerHTML = '<div class="bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-3 flex gap-1 items-center">'
      + '<span class="w-1 h-1 bg-gray-400 dark:bg-gray-500 rounded-full animate-chat-bounce" style="animation-delay:0ms"></span>'
      + '<span class="w-1 h-1 bg-gray-400 dark:bg-gray-500 rounded-full animate-chat-bounce" style="animation-delay:150ms"></span>'
      + '<span class="w-1 h-1 bg-gray-400 dark:bg-gray-500 rounded-full animate-chat-bounce" style="animation-delay:300ms"></span>'
      + '</div>';
    return d;
  }
  // The same alert chat.html draws for a server-side error, with a safe sign-in
  // action for expired sessions and the data-chat-error hook used by retries.
  function _inlineChatError(area, msg, sessionExpired) {
    area.querySelectorAll('[data-chat-error]').forEach(function (el) { el.remove(); });
    var err = document.createElement('div');
    err.className = 'alert mb-2';
    err.setAttribute('data-variant', 'destructive');
    err.setAttribute('role', 'alert');
    err.setAttribute('data-chat-error', '');
    var text = document.createElement('section');
    text.textContent = msg;
    err.appendChild(text);
    if (sessionExpired) {
      var login = document.createElement('a');
      login.href = '/login';
      login.target = '_blank';
      login.rel = 'noopener';
      login.textContent = 'Sign in (new tab)';
      err.appendChild(login);
    }
    var inputDiv = area.querySelector('.rf-assistant-compose, .shrink-0.pt-2');
    if (inputDiv) area.insertBefore(err, inputDiv); else area.appendChild(err);
  }

  function applyVisualViewport(modal) {
    if (!window.visualViewport) return;
    var vv = window.visualViewport;
    modal.style.top = vv.offsetTop + 'px';
    modal.style.height = vv.height + 'px';
    modal.style.bottom = 'auto';
  }

  function openChatModal(articleId) {
    var modal = document.getElementById('chat-modal-' + articleId);
    if (!modal) return;
    modal.classList.remove('hidden');
    watchViewport(modal, false);
    scrollChatToBottom(modal);
    var input = document.getElementById('chat-input-' + articleId);
    if (input) input.focus();
  }

  function updateChatIndicator(articleId, hasMessages) {
    var el = document.getElementById('chat-indicator-' + articleId);
    if (el) el.classList.toggle('hidden', !hasMessages);
  }

  function closeChatModal(articleId) {
    var modal = document.getElementById('chat-modal-' + articleId);
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.top = '';
    modal.style.height = '';
    modal.style.bottom = '';
    releaseViewport(modal);
    var msgs = document.getElementById('chat-messages-' + articleId);
    updateChatIndicator(articleId, msgs && msgs.children.length > 0);
  }

  function attachChatModal(root) {
    (root || document).querySelectorAll('[data-show-chat-modal]').forEach(function (btn) {
      if (btn._aiChatAttached) return;
      btn._aiChatAttached = true;
      btn.addEventListener('click', function () {
        var articleId = btn.getAttribute('data-show-chat-modal');
        document.querySelectorAll('[data-menu]').forEach(function (m) { m.classList.add('hidden'); });
        openChatModal(articleId);
      });
    });
    (root || document).querySelectorAll('[data-close-chat-modal]').forEach(function (el) {
      if (el._aiChatCloseAttached) return;
      el._aiChatCloseAttached = true;
      el.addEventListener('click', function () {
        closeChatModal(el.getAttribute('data-close-chat-modal'));
      });
    });
  }

  function scrollChatToBottom(root) {
    (root || document).querySelectorAll('[id^="chat-messages-"]').forEach(function (el) {
      requestAnimationFrame(function () {
        var last = el.lastElementChild;
        if (last) {
          last.scrollIntoView({ block: 'start', behavior: 'instant' });
        } else {
          el.scrollTop = el.scrollHeight;
        }
      });
    });
  }

  function confirmLongMessage(textarea) {
    if (textarea.value.length <= 2000) return true;
    return confirm(textarea.value.length + ' characters — may use significant AI tokens. Send anyway?');
  }

  // Enter submits, Shift+Enter inserts newline

  function attachChatAttachBtn(root) {
    (root || document).querySelectorAll('[id^="chat-attach-btn-"]').forEach(function (btn) {
      if (btn._attachBtnAttached) return;
      btn._attachBtnAttached = true;
      var articleId = btn.id.replace('chat-attach-btn-', '');
      var chk = document.getElementById('chat-article-' + articleId);
      var textarea = document.getElementById('chat-input-' + articleId);
      if (!chk) return;
      btn.addEventListener('click', function () {
        chk.checked = !chk.checked;
        chk.dispatchEvent(new Event('change'));
        if (textarea) textarea.focus();
      });
    });
  }

  function attachArticlePlaceholder(root) {
    (root || document).querySelectorAll('[id^="chat-article-"]').forEach(function (chk) {
      if (chk._placeholderAttached) return;
      chk._placeholderAttached = true;
      var articleId = chk.id.replace('chat-article-', '');
      var input = document.getElementById('chat-input-' + articleId);
      if (!input) return;
      function update() {
        input.placeholder = chk.checked
          ? 'Ask a question about this article…'
          : 'Ask a question…';
        input.focus();
        var attachBtn = document.getElementById('chat-attach-btn-' + articleId);
        if (attachBtn) {
          attachBtn.classList.toggle('text-blue-500', chk.checked);
          attachBtn.classList.toggle('text-gray-400', !chk.checked);
        }
      }
      chk.addEventListener('change', update);
    });
  }

  function attachChatKeydown(root) {
    (root || document).querySelectorAll('[data-chat-input-id]').forEach(function (el) {
      if (el._chatKeyAttached) return;
      el._chatKeyAttached = true;
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        var area = el.closest('[id^="chat-area-"]');
        var sendBtn = area && area.querySelector('button[hx-post*="/ai-chat"]');
        if (sendBtn && !disabled(sendBtn) && !isOffline()) {
          if (!confirmLongMessage(el)) return;
          htmx.trigger(sendBtn, 'click');
        }
      });
    });
  }

  // Capture-phase click intercept for long message warning on Send button
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[hx-post*="/ai-chat"]');
    if (!btn) return;
    var match = (btn.getAttribute('hx-post') || '').match(/articles\/(\d+)\/ai-chat/);
    if (!match) return;
    var input = document.getElementById('chat-input-' + match[1]);
    if (input && !confirmLongMessage(input)) {
      e.stopImmediatePropagation();
    }
  }, true);

  // Clear textarea + scroll + re-attach keydown after HTMX swap of #chat-area-*
  document.addEventListener('htmx:afterSwap', function (e) {
    var target = e.detail.target;
    if (!target || !target.id || !target.id.startsWith('chat-area-')) return;
    var record = requestRecord(e) || _active.get(target.id);
    finish(record);
    var articleId = target.id.replace('chat-area-', '');
    var newArea = document.getElementById('chat-area-' + articleId);
    if (!newArea) return;
    var input = document.getElementById('chat-input-' + articleId);
    if (input) input.value = '';
    scrollChatToBottom(newArea);
    attachChatKeydown(newArea);

    attachChatAttachBtn(newArea);
    attachArticlePlaceholder(newArea);
    var msgs = document.getElementById('chat-messages-' + articleId);
    updateChatIndicator(articleId, msgs && msgs.children.length > 0);
    if (input) input.focus();
    var pending = _chatPending[articleId];
    if (pending) {
      if (newArea.querySelector('[data-chat-error]') && input) { input.value = pending; input.focus(); }
      delete _chatPending[articleId];
    }
  });

  // General (non-article) chat modal
  function syncGeneralChatContext() {
    if (document.getElementById('rf-assistant-chat')) return;
    // The panel first while the story window is up: article_detail.html brings its
    // #article-detail-root wherever it renders, so the shell in the list has one too,
    // and by id the chat would attach the article underneath the window instead of the
    // one being read.
    var root = (document.documentElement.classList.contains('story-detail-open')
                && document.querySelector('#article-detail [data-article-id]'))
      || document.getElementById('article-detail-root');
    var artId = root ? (root.getAttribute('data-article-id') || '') : '';
    var artInput = document.getElementById('general-chat-article-id');
    if (artInput) artInput.value = artId;
    var attachBtn = document.getElementById('general-chat-attach-btn');
    var titleSpan = document.getElementById('general-chat-attach-title');
    var short = '';
    if (artId) {
      var artElem = document.querySelector('article[data-article-id="' + artId + '"]');
      // The title the reader sees: a translation where there is one.
      var title = artElem ? (artElem.getAttribute('data-title-translated') ||
                             artElem.getAttribute('data-title') || '') : '';
      short = title.length > 25 ? title.slice(0, 25) + '…' : title;
    }
    if (attachBtn) attachBtn.classList.toggle('hidden', !artId);
    if (titleSpan) {
      titleSpan.classList.toggle('hidden', !artId);
      titleSpan.textContent = short;
    }
  }

  function openGeneralChat() {
    var modal = document.getElementById('general-chat-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    syncGeneralChatContext();
    watchViewport(modal, false);
    var input = document.getElementById('general-chat-input');
    if (input) input.focus();
  }

  function closeGeneralChat() {
    var modal = document.getElementById('general-chat-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.style.top = '';
    modal.style.height = '';
    modal.style.bottom = '';
    releaseViewport(modal);
  }

  function attachGeneralChat() {
    ['sidebar-chat-btn'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn && !btn._generalChatAttached) {
        btn._generalChatAttached = true;
        btn.addEventListener('click', openGeneralChat);
      }
    });
    var genAttachBtn = document.getElementById('general-chat-attach-btn');
    if (genAttachBtn && !genAttachBtn._attachBtnAttached) {
      genAttachBtn._attachBtnAttached = true;
      var genChk = document.getElementById('general-chat-include-article');
      genAttachBtn.addEventListener('click', function () {
        if (genChk) {
          genChk.checked = !genChk.checked;
          genAttachBtn.classList.toggle('text-blue-500', genChk.checked);
          genAttachBtn.classList.toggle('text-gray-400', !genChk.checked);
        }
        var inp = document.getElementById('general-chat-input');
        if (inp) {
          inp.placeholder = (genChk && genChk.checked)
            ? 'Ask a question about this article…'
            : 'Ask a question…';
          inp.focus();
        }
      });
    }
    var closeBtn = document.getElementById('general-chat-close-btn');
    if (closeBtn && !closeBtn._generalChatCloseAttached) {
      closeBtn._generalChatCloseAttached = true;
      closeBtn.addEventListener('click', closeGeneralChat);
    }
    var backdrop = document.getElementById('general-chat-backdrop');
    if (backdrop && !backdrop._generalChatCloseAttached) {
      backdrop._generalChatCloseAttached = true;
      backdrop.addEventListener('click', closeGeneralChat);
    }
  }

  function attachGeneralChatKeydown() {
    var input = document.getElementById('general-chat-input');
    if (input && !input._generalChatKeyAttached) {
      input._generalChatKeyAttached = true;
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        var sendBtn = document.getElementById('general-chat-submit');
        if (sendBtn && !disabled(sendBtn) && !isOffline()) {
          if (input.value.length > 2000 && !confirm(input.value.length + ' characters — may use significant AI tokens. Send anyway?')) return;
          htmx.trigger(sendBtn, 'click');
        }
      });
    }
  }

  // Esc closes open chat modals, unless it was spent on an open menu (S3W-F5).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (_kbMenuAtKeydown) return;
    document.querySelectorAll('[id^="chat-modal-"]').forEach(function (modal) {
      if (!modal.classList.contains('hidden')) {
        closeChatModal(modal.getAttribute('data-chat-modal-id'));
      }
    });
    closeGeneralChat();
  });

  // After HTMX swap of #general-chat-area: clear textarea, scroll, re-attach keydown
  document.addEventListener('htmx:afterSwap', function (e) {
    var target = e.detail && e.detail.target;
    if (!target || (target.id !== 'general-chat-area' && target.id !== 'rf-assistant-chat')) return;
    var newArea = document.getElementById(target.id);
    var record = requestRecord(e) || _active.get(target.id);
    finish(record);
    if (target.id === 'rf-assistant-chat' && newArea) {
      _page = newArea;
      if (_articleId && !newArea.querySelector('option[value="article"]')) {
        var option = document.createElement('option'); option.value = 'article';
        option.textContent = 'This article — ' + _articleTitle;
        newArea.querySelector('#assistant-chat-scope').appendChild(option);
      }
      newArea.dataset.articleId = _articleId; newArea.dataset.articleTitle = _articleTitle;
      var scope = record && record.scope || 'general';
      newArea.querySelector('#assistant-chat-scope').value = scope;
      newArea.querySelector('#general-chat-article-id').value = _articleId;
      newArea.querySelector('#general-chat-include-article').checked = scope === 'article';
      cleanup(); watchViewport(newArea, true);
    }
    if (!newArea) return;
    var input = document.getElementById('general-chat-input');
    if (input) input.value = '';
    var msgs = document.getElementById('general-chat-messages');
    if (msgs) {
      requestAnimationFrame(function () {
        var last = msgs.lastElementChild;
        if (last) last.scrollIntoView({ block: 'start', behavior: 'instant' });
        else msgs.scrollTop = msgs.scrollHeight;
      });
    }
    attachGeneralChatKeydown();
    syncGeneralChatContext();
    if (input) input.focus();
    var pending = _chatPending['general'];
    if (pending) {
      if (newArea.querySelector('[data-chat-error]') && input) { input.value = pending; input.focus(); }
      delete _chatPending['general'];
    }
    if (target.id === 'rf-assistant-chat') return;
    var hist = document.getElementById('general-chat-history');
    var msgsEl = document.getElementById('general-chat-messages');
    if (hist && hist.value === '[]') {
      _forgetGeneralChat();
    } else if (hist && msgsEl) {
      try {
        sessionStorage.setItem('_gchat_owner', _generalChatOwner());
        sessionStorage.setItem('_gchat_history', hist.value);
        sessionStorage.setItem('_gchat_html', msgsEl.innerHTML);
      } catch (e) {}
    }
  });

  // The conversation is kept per tab so a reload doesn't lose it, and a tab outlives
  // a logout: the next account to sign in there must not get it back, nor send it to
  // the model as its own history. So it is stored with the id of the account it
  // belongs to and only restored for that account.
  function _generalChatOwner() {
    var modal = document.getElementById('general-chat-modal');
    return (modal && modal.dataset.chatOwner) || '';
  }

  function _forgetGeneralChat() {
    try {
      sessionStorage.removeItem('_gchat_owner');
      sessionStorage.removeItem('_gchat_history');
      sessionStorage.removeItem('_gchat_html');
    } catch (e) {}
  }

  // Optimistic UI: show user message + typing indicator before server responds
  document.addEventListener('htmx:beforeRequest', function (e) {
    if (e.defaultPrevented) return;
    var postUrl = (e.detail.elt.getAttribute('hx-post') || '');
    var artMatch = postUrl.match(/articles\/(\d+)\/ai-chat/);
    var isGeneral = postUrl === '/htmx/ai-chat';
    if (!artMatch && !isGeneral) return;
    var key     = artMatch ? artMatch[1] : 'general';
    var inputId = artMatch ? 'chat-input-' + artMatch[1] : 'general-chat-input';
    var msgsId  = artMatch ? 'chat-messages-' + artMatch[1] : 'general-chat-messages';
    var typingId = artMatch ? 'chat-typing-' + artMatch[1] : 'general-chat-typing';
    var input = document.getElementById(inputId);
    var area = chatArea(e.detail.elt);
    if (!input || !input.value.trim() || !area || _active.has(area.id) || disabled(e.detail.elt) || isOffline()) { e.preventDefault(); return; }
    var record = { root: area, button: e.detail.elt, xhr: e.detail.xhr, key: key,
      generation: _generation, page: area.id === 'rf-assistant-chat', done: false,
      scope: area.querySelector('#assistant-chat-scope') && area.querySelector('#assistant-chat-scope').value };
    _active.set(area.id, record);
    if (record.xhr) _requests.set(record.xhr, record);
    // Listen on the source too when it is detached; its events no longer reach
    // document. Re-adding the same listener on retries does not duplicate it.
    record.button.addEventListener('htmx:beforeOnLoad', guardChatResponse);
    record.button.disabled = true;
    area.setAttribute('aria-busy', 'true');
    area.querySelectorAll('[data-chat-error]').forEach(function (el) { el.remove(); });
    var msg = input.value.trim();
    _chatPending[key] = msg;
    input.value = '';
    var msgs = document.getElementById(msgsId);
    if (msgs) {
      record.bubble = _userBubble(msg, record.page); record.typing = _typingIndicator(typingId, record.page);
      msgs.appendChild(record.bubble);
      msgs.appendChild(record.typing);
      requestAnimationFrame(function () {
        var last = msgs.lastElementChild;
        if (last) last.scrollIntoView({ block: 'start', behavior: 'instant' });
      });
    }
  });

  // Returns whether the failure was actually reported in the thread, which is what
  // decides if the app-wide fallback should stay quiet about it.
  function _handleChatCommError(elt, errMsg, sessionExpired) {
    var postUrl = (elt.getAttribute('hx-post') || '');
    var artMatch = postUrl.match(/articles\/(\d+)\/ai-chat/);
    var isGeneral = postUrl === '/htmx/ai-chat';
    if (!artMatch && !isGeneral) return false;
    var key     = artMatch ? artMatch[1] : 'general';
    var inputId = artMatch ? 'chat-input-' + artMatch[1] : 'general-chat-input';
    var msgsId  = artMatch ? 'chat-messages-' + artMatch[1] : 'general-chat-messages';
    var areaId  = artMatch ? 'chat-area-' + artMatch[1] : (elt.closest('#rf-assistant-chat') ? 'rf-assistant-chat' : 'general-chat-area');
    var msgs = document.getElementById(msgsId);
    var record = _active.get(areaId);
    if (record && record.bubble) record.bubble.remove();
    if (record && record.typing) record.typing.remove();
    finish(record);
    var area = document.getElementById(areaId);
    if (area) _inlineChatError(area, errMsg, sessionExpired);
    var pending = _chatPending[key];
    if (pending) {
      var input = document.getElementById(inputId);
      if (input) { input.value = pending; input.focus(); }
      delete _chatPending[key];
    }
    return !!area;
  }

  document.addEventListener('htmx:responseError', function (e) {
    if (stale(requestRecord(e))) { _claimHtmxError(e); return; }
    if (_handleChatCommError(e.detail.elt, 'Request failed — please try again.')) _claimHtmxError(e);
  });
  document.addEventListener('htmx:sendError', function (e) {
    if (stale(requestRecord(e))) { _claimHtmxError(e); return; }
    if (_handleChatCommError(e.detail.elt, 'Network error — please try again.')) _claimHtmxError(e);
  });

  document.addEventListener('DOMContentLoaded', function () { init(); scrollChatToBottom(); });
  document.addEventListener('htmx:afterSettle', function () { init(); });
  document.addEventListener('htmx:beforeCleanupElement', function (e) {
    var el = e.detail && e.detail.elt;
    _viewports.forEach(function (_, root) { if (el && (el === root || el.contains(root))) releaseViewport(root); });
  });
  init();

  function restoreGeneralChatSession() {
    try {
      // No modal, no owner to compare with: a page without the chat leaves it be.
      var owner = _generalChatOwner();
      var modal = document.getElementById('general-chat-modal');
      if (!owner || document.getElementById('rf-assistant-chat') || modal._restoredOwner === owner) return;
      modal._restoredOwner = owner;
      if (sessionStorage.getItem('_gchat_owner') !== owner) { _forgetGeneralChat(); return; }
      var html = sessionStorage.getItem('_gchat_html');
      var history = sessionStorage.getItem('_gchat_history');
      if (!html || !history || history === '[]') return;
      var msgs = document.getElementById('general-chat-messages');
      var hist = document.getElementById('general-chat-history');
      if (msgs) msgs.innerHTML = html;
      if (hist) hist.value = history;
    } catch (e) {}
  }
})();
