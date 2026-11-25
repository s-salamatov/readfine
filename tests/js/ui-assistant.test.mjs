import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browser } from './harness.mjs';

const script = 'backend/app/static/js/ui/assistant.js';
const html = () => `<main id="assistant-main"><section id="assistant-chat"><div id="rf-assistant-chat" data-article-id="7" data-article-title="An article">
<label for="assistant-chat-scope">Scope</label><select id="assistant-chat-scope"><option value="general">Everything (general)</option><option value="article" selected>This article</option></select>
<p id="assistant-chat-disclosure"></p><p id="assistant-chat-status" role="status"></p>
<input id="general-chat-history" name="history" value="[]"><input id="general-chat-article-id" name="article_id" value="7">
<input type="checkbox" id="general-chat-include-article" name="include_article" checked>
<div id="general-chat-messages"></div><div class="rf-assistant-compose"><textarea id="general-chat-input" name="message"></textarea>
<button id="general-chat-submit" hx-post="/htmx/ai-chat" hx-target="#rf-assistant-chat" hx-swap="outerHTML">Send</button></div></div></section></main>`;
function load(extra = '') {
  const vv = { height: 640, offsetTop: 0, listeners: new Map(), addEventListener(n, fn) { if (!this.listeners.has(n)) this.listeners.set(n, new Set()); this.listeners.get(n).add(fn); }, removeEventListener(n, fn) { this.listeners.get(n)?.delete(fn); } };
  const w = browser(html() + extra, { before(w) {
    w.visualViewport = vv;
    w.sessionStorage.setItem('_gchat_owner', 'another-account');
    w.sessionStorage.setItem('_gchat_history', '[{"role":"user","content":"SECRET"}]');
    w.sessionStorage.setItem('_gchat_html', 'SECRET');
    w.RFMotion = { reduced: () => true };
  }});
  if (fs.existsSync(script)) w.eval(fs.readFileSync(script, 'utf8'));
  return { w, vv, doc: w.document, get: (id) => w.document.getElementById(id) };
}
function event(w, name, detail) {
  const e = new w.CustomEvent(name, { bubbles: true, cancelable: true, detail });
  (detail.elt?.isConnected ? detail.elt : w.document.body).dispatchEvent(e);
  return e;
}
function xhr() { return { status: 200, responseURL: 'https://readfine.test/htmx/ai-chat', responseText: '<div id="rf-assistant-chat"></div>', aborts: 0, abort() { this.aborts++; }, getResponseHeader() { return null; } }; }

async function realChatTransport(w) {
  const sent = [];
  // Only the wire is fake; shipped HTMX owns request/response lifecycle events.
  class Wire extends w.EventTarget {
    constructor() { super(); this.upload = new w.EventTarget(); this.headers = {}; }
    open(method, path) { this.method = method; this.path = path; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    overrideMimeType() {}
    getAllResponseHeaders() { return Object.entries(this.responseHeaders || {}).map(([k, v]) => `${k}: ${v}`).join('\r\n'); }
    getResponseHeader(name) { return this.responseHeaders?.[name] ?? null; }
    send(body) { this.body = body; sent.push(this); }
    // Allow delivery after abort to exercise late response isolation.
    abort() { this.aborted = true; }
    reply(headers, status = 200) {
      this.status = status; this.responseHeaders = headers;
      this.response = this.responseText = '';
      this.responseURL = new URL(this.path, w.location).href;
      this.onload();
    }
  }
  w.XMLHttpRequest = Wire;
  const evaluate = w.XPathExpression.prototype.evaluate;
  w.XPathExpression.prototype.evaluate = function (node, type = 0, result = null) { return evaluate.call(this, node, type, result); };
  await new Promise(resolve => w.setTimeout(resolve, 0));
  w.eval(fs.readFileSync('backend/app/static/js/htmx.min.js', 'utf8'));
  w.htmx.process(w.document.body);
  return sent;
}

test('assistant: scope changes isolate pending replies and history', () => {
  const { w, doc, get } = load();
  assert.ok(w.RFAssistant, 'shared controller exists');
  w.RFAssistant.init(); w.RFAssistant.init();
  assert.equal(get('general-chat-history').value, '[]');
  assert.doesNotMatch(get('general-chat-messages').textContent, /SECRET/);
  const requests = [];
  w.htmx.trigger = (elt) => { const detail = { elt, target: get('rf-assistant-chat'), xhr: xhr() }; if (!event(w, 'htmx:beforeRequest', detail).defaultPrevented) requests.push(detail); };
  get('general-chat-input').value = 'Old question';
  get('general-chat-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(requests.length, 1);
  const old = requests[0];
  assert.equal(get('general-chat-submit').disabled, true);
  w.RFAssistant.setScope('general');
  assert.equal(old.xhr.aborts, 1);
  assert.equal(get('general-chat-history').value, '[]');
  assert.equal(get('general-chat-input').value, '');
  assert.equal(get('general-chat-include-article').checked, false);
  assert.equal(get('general-chat-submit').disabled, false);
  assert.match(get('assistant-chat-status').textContent, /New conversation.*general/i);
  assert.equal(new URL(w.location.href).searchParams.get('scope'), 'general');
  const late = { ...old, shouldSwap: true };
  event(w, 'htmx:beforeSwap', late);
  assert.equal(late.shouldSwap, false);
  event(w, 'htmx:responseError', old);
  assert.equal(get('general-chat-input').value, '');
  assert.equal(get('general-chat-messages').textContent, '');
  w.RFAssistant.setScope('article', 7);
  assert.equal(get('general-chat-include-article').checked, true);
  assert.equal(get('general-chat-history').value, '[]');
  w.history.replaceState({}, '', '/assistant?scope=general&article_id=7');
  w.dispatchEvent(new w.PopStateEvent('popstate'));
  assert.equal(get('general-chat-include-article').checked, false);
  assert.equal(w.RFAssistant.setScope('folder', 7), false);
  doc.body.innerHTML = html();
  event(w, 'htmx:afterSettle', { target: doc.body });
  w.RFAssistant.init();
  get('general-chat-input').value = 'After navigation';
  get('general-chat-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(requests.length, 2, 'no duplicate listeners after body replacement');
  const detached = requests[1];
  get('assistant-main').remove();
  const stale = { ...detached, shouldSwap: true };
  event(w, 'htmx:beforeSwap', stale);
  assert.equal(stale.shouldSwap, false);
  // Reader-only storage remains owner keyed, including a boosted return to Read.
  doc.body.innerHTML = '<div id="general-chat-modal" data-chat-owner="current"><div id="general-chat-messages"></div><input id="general-chat-history" value="[]"></div>';
  w.RFAssistant.init();
  assert.equal(get('general-chat-messages').textContent, '');
  assert.equal(w.sessionStorage.getItem('_gchat_history'), null);
  w.sessionStorage.setItem('_gchat_owner', 'current');
  w.sessionStorage.setItem('_gchat_history', '[{"role":"user","content":"Owned history"}]');
  w.sessionStorage.setItem('_gchat_html', '<p>Owned history</p>');
  doc.body.innerHTML = '<div id="general-chat-modal" data-chat-owner="current"><div id="general-chat-messages"></div><input id="general-chat-history" value="[]"></div>';
  w.RFAssistant.init();
  assert.equal(get('general-chat-messages').textContent, 'Owned history');
  // Reader navigation must not open quick chat or move focus into its modal.
  get('general-chat-modal').classList.add('hidden');
  get('general-chat-modal').insertAdjacentHTML('beforeend', '<textarea id="general-chat-input"></textarea>');
  doc.body.insertAdjacentHTML('beforeend', '<a id="mobile-bottom-chat-btn" href="/assistant">Assistant</a><button id="sidebar-chat-btn">Quick chat</button>');
  w.RFAssistant.init();
  const mobileLink = get('mobile-bottom-chat-btn');
  mobileLink.focus();
  // Observe the click before cancelling only jsdom's unsupported navigation.
  let navigationPrevented;
  doc.addEventListener('click', e => {
    if (e.target === mobileLink) {
      navigationPrevented = e.defaultPrevented;
      e.preventDefault();
    }
  });
  mobileLink.click();
  assert.equal(navigationPrevented, false, 'assistant navigation remains available');
  assert.equal(get('general-chat-modal').classList.contains('hidden'), true, 'mobile navigation leaves quick chat closed');
  assert.equal(doc.activeElement, mobileLink, 'mobile navigation does not take focus');
  get('sidebar-chat-btn').click();
  assert.equal(get('general-chat-modal').classList.contains('hidden'), false, 'sidebar quick chat still opens');
  assert.equal(doc.activeElement, get('general-chat-input'), 'sidebar quick chat focuses its input');
  w.close();
});

test('assistant: lifecycle retains article retry and phone viewport', async () => {
  const { w, vv, doc, get } = load('<section id="assistant-profile"><button id="profile-generate" hx-post="/assistant/profile/generate" data-rf-online-only data-loading-target="preference-message" data-loading-text="Generating…">Generate</button><div id="preference-message"></div></section><button data-show-chat-modal="5">Ask</button><div class="hidden" id="chat-modal-5" data-chat-modal-id="5"><div id="chat-area-5"><div id="chat-messages-5"></div><div class="shrink-0 pt-2"><textarea id="chat-input-5" data-chat-input-id="5"></textarea><button id="article-send" hx-post="/htmx/articles/5/ai-chat">Send</button></div></div></div><div><span id="pref-char-count"></span></div><textarea id="ai_preference_text"></textarea>');
  assert.ok(w.RFAssistant);
  w.RFAssistant.init();
  doc.querySelector('[data-show-chat-modal]').click();
  assert.equal(get('chat-modal-5').classList.contains('hidden'), false);
  assert.equal(get('chat-modal-5').style.height, '640px');
  let triggers = 0;
  w.htmx.trigger = (elt) => { triggers++; event(w, 'htmx:beforeRequest', { elt, xhr: xhr(), target: get('rf-assistant-chat') }); };
  get('general-chat-input').value = 'line';
  get('general-chat-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  assert.equal(triggers, 0);
  for (const failure of ['provider', 403, 429, 'network']) {
    get('general-chat-input').value = '<img src=x onerror=evil()> retry';
    const detail = { elt: get('general-chat-submit'), target: get('rf-assistant-chat'), xhr: xhr() };
    event(w, 'htmx:beforeRequest', detail);
    assert.equal(get('general-chat-submit').disabled, true);
    assert.equal(get('general-chat-messages').querySelector('img'), null);
    assert.match(get('general-chat-messages').textContent, /<img/);
    assert.equal(get('general-chat-messages').querySelector('.animate-chat-bounce'), null, 'reduced motion');
    assert.equal(event(w, 'htmx:beforeRequest', { ...detail, xhr: xhr() }).defaultPrevented, true);
    if (failure === 'provider') {
      const area = get('rf-assistant-chat');
      const replacement = doc.createElement('div'); replacement.innerHTML = html();
      const next = replacement.querySelector('#rf-assistant-chat');
      next.insertAdjacentHTML('afterbegin', '<div data-chat-error role="alert">Provider failed</div>');
      area.replaceWith(next);
      event(w, 'htmx:afterSwap', { ...detail, target: next });
    } else {
      detail.xhr.status = typeof failure === 'number' ? failure : 0;
      event(w, failure === 'network' ? 'htmx:sendError' : 'htmx:responseError', detail);
      event(w, failure === 'network' ? 'htmx:sendError' : 'htmx:responseError', detail);
    }
    assert.equal(get('general-chat-input').value, '<img src=x onerror=evil()> retry');
    assert.equal(get('general-chat-submit').disabled, false);
    assert.equal(get('rf-assistant-chat').querySelectorAll('[data-chat-error]').length, 1);
  }
  // auth_redirect_handler returns 200 + HX-Redirect, without a beforeSwap event.
  const real = load('<button id="unrelated" hx-get="/unrelated">Unrelated</button>');
  try {
    const sent = await realChatTransport(real.w);
    let responseEvent, swaps = 0;
    real.doc.addEventListener('htmx:beforeOnLoad', e => { responseEvent = e; });
    real.doc.addEventListener('htmx:beforeSwap', () => { swaps++; });
    for (const headers of [
      { 'HX-Redirect': '/login' },
      { 'HX-Location': '/login' },
      { 'HX-Location': '{"path":"/login"}' },
      { 'HX-Refresh': 'true' },
    ]) {
      real.get('general-chat-input').value = '<img src=x onerror=evil()> retry';
      const count = sent.length;
      real.get('general-chat-submit').click();
      assert.equal(sent.length, count + 1);
      assert.equal(real.get('general-chat-input').value, '');
      assert.equal(real.get('general-chat-submit').disabled, true);
      sent.at(-1).reply(headers);
      assert.equal(real.get('general-chat-input').value, '<img src=x onerror=evil()> retry', 'auth response restores pending draft');
      assert.equal(responseEvent.defaultPrevented, true, 'cancel before HTMX processes navigation headers');
      assert.equal(real.get('general-chat-submit').disabled, false);
      assert.equal(real.get('rf-assistant-chat').hasAttribute('aria-busy'), false);
      assert.equal(real.get('general-chat-messages').textContent, '');
      const alerts = real.get('rf-assistant-chat').querySelectorAll('[data-chat-error][role="alert"]');
      assert.equal(alerts.length, 1);
      assert.match(alerts[0].textContent, /session.*expired/i);
      assert.match(alerts[0].textContent, /retry/i);
      assert.equal(alerts[0].querySelector('a').getAttribute('href'), '/login');
      assert.equal(alerts[0].querySelector('a').getAttribute('target'), '_blank', 'sign in without discarding the current draft');
      assert.equal(sent.length, count + 1, 'no redirect follow-up request');
      assert.equal(swaps, 0);

      real.get('general-chat-submit').click();
      const old = sent.at(-1);
      real.w.RFAssistant.setScope('general');
      real.get('general-chat-input').value = 'New scope draft';
      old.reply(headers);
      assert.equal(responseEvent.defaultPrevented, true, 'stale responses cannot navigate');
      assert.equal(real.get('general-chat-input').value, 'New scope draft');
      assert.equal(real.get('general-chat-submit').disabled, false);
      assert.equal(real.doc.querySelector('[data-chat-error]'), null, 'stale auth errors do not affect the new scope');
      assert.equal(real.get('general-chat-history').value, '[]');
    }
    real.get('general-chat-submit').click();
    const detached = sent.at(-1);
    responseEvent = null;
    real.get('general-chat-submit').addEventListener('htmx:beforeOnLoad', e => { responseEvent = e; });
    real.get('assistant-main').remove();
    detached.reply({ 'HX-Redirect': '/login' });
    assert.equal(responseEvent.defaultPrevented, true, 'detached chat responses cannot navigate');
    real.get('unrelated').click();
    sent.at(-1).reply({}, 204);
    assert.equal(responseEvent.defaultPrevented, false, 'unrelated HTMX responses remain untouched');
  } finally { real.w.close(); }
  // A successful page swap preserves the offered article even in general scope.
  w.RFAssistant.setScope('general');
  get('general-chat-input').value = 'Successful question';
  const success = { elt: get('general-chat-submit'), target: get('rf-assistant-chat'), xhr: xhr() };
  event(w, 'htmx:beforeRequest', success);
  const swap = { ...success, shouldSwap: true };
  event(w, 'htmx:beforeSwap', swap);
  assert.equal(swap.shouldSwap, true);
  const replacement = doc.createElement('div'); replacement.innerHTML = html();
  const next = replacement.querySelector('#rf-assistant-chat');
  next.querySelector('option[value="article"]').remove();
  next.querySelector('#general-chat-messages').textContent = 'Successful answer';
  next.querySelector('#general-chat-history').value = '[{"role":"assistant","content":"Successful answer"}]';
  next.querySelector('#general-chat-messages').scrollTop = 0;
  Object.defineProperty(next.querySelector('#general-chat-messages'), 'scrollHeight', { value: 80 });
  get('rf-assistant-chat').replaceWith(next);
  event(w, 'htmx:afterSwap', { ...success, target: next });
  await new Promise((resolve) => w.requestAnimationFrame(resolve));
  assert.equal(get('general-chat-messages').scrollTop, 80);
  assert.equal(get('general-chat-input').value, '');
  assert.equal(get('general-chat-submit').disabled, false);
  assert.equal(get('assistant-chat-scope').value, 'general');
  assert.ok(doc.querySelector('option[value="article"]'));
  assert.equal(w.sessionStorage.getItem('_gchat_owner'), 'another-account', 'page never writes legacy storage');
  event(w, 'htmx:beforeRequest', { elt: get('profile-generate') });
  assert.equal(get('preference-message').textContent, 'Generating…');
  for (const forced of [false, true]) {
    Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: forced });
    w.RFOffline = { page: { current: () => ({ isOffline: () => forced }) } };
    assert.equal(event(w, 'htmx:beforeRequest', { elt: get('general-chat-submit'), xhr: xhr() }).defaultPrevented, true);
    assert.equal(event(w, 'htmx:beforeRequest', { elt: get('profile-generate') }).defaultPrevented, true);
  }
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, value: true });
  w.RFOffline = null;
  for (let i = 0; i < 2; i++) {
    get('ai_preference_text').outerHTML = '<textarea id="ai_preference_text"></textarea>';
    get('ai_preference_text').value = 'x'.repeat(5001);
    get('ai_preference_text').dispatchEvent(new w.Event('input', { bubbles: true }));
    assert.equal(get('pref-char-count').textContent, '5001');
    assert.equal(get('ai_preference_text').getAttribute('aria-invalid'), 'true');
  }
  vv.height = 280;
  for (const fn of vv.listeners.get('resize') || []) fn();
  assert.equal(get('rf-assistant-chat').style.getPropertyValue('--rf-assistant-viewport-height'), '280px');
  get('assistant-main').remove(); get('chat-modal-5').remove();
  event(w, 'htmx:afterSettle', { target: doc.body });
  assert.equal([...vv.listeners.values()].reduce((n, s) => n + s.size, 0), 0);
  w.close();
});
