import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const list = (id = 1) => `<ul data-rf-catchup-list id="catchup-configs-list"><li id="catchup-config-${id}"><button data-action="open-briefing-modal" data-config-id="${id}" data-config-name="&lt;bad&gt;">Schedule</button><button data-action="rename-config" data-config-id="${id}" data-config-name="&lt;bad&gt;">Rename</button><button data-action="delete-config" data-config-id="${id}">Delete</button><button data-action="load-catchup-config" data-config='${JSON.stringify({name: 'saved', period: 'today', scope_include: '["feed:2"]', article_limit: 25})}'>Load</button><button data-action="generate-catchup-config" data-config='{"name":"saved","period":"today","article_limit":25}'>Generate</button></li></ul>`;
const section = () => `<section id="assistant-catch-up"><h2 id="assistant-catch-up-heading" tabindex="-1">Catch me up</h2><div id="catchup-configs-list-wrapper">${list()}</div><form id="save-config-form"><input name="name"></form><div id="settings-panel"><form id="catchup-form" hx-post="/htmx/catch-me-up/generate"><input name="period" type="radio" value="today"><input name="period" type="radio" value="7days" checked><input id="scope-value" name="scope_include"><input id="article-limit" name="article_limit" value="500"><button>Generate</button></form></div><div id="catchup-estimate"></div><div id="catchup-result"></div><button id="catchup-copy-btn" class="hidden">Copy</button><dialog id="rf-briefing-sheet"><h2 id="rf-briefing-sheet-title"></h2><div id="rf-briefing-sheet-body"></div></dialog></section>`;
const sheet = '<form id="briefing-form" hx-put="/htmx/catchup-configs/1/briefing" hx-target="#catchup-configs-list-wrapper" hx-swap="innerHTML"><input name="briefing_time" value="08:00"><div id="briefing-form-error"></div></form><button data-briefing-test hx-post="/htmx/catchup-configs/1/briefing/test">Test</button><div id="briefing-test-result"></div>';
function setup() {
  const dom = new JSDOM(section(), { url: 'https://readfine.test/assistant', runScripts: 'outside-only' });
  const w = dom.window, d = w.document, requests = [], timers = new Map();
  let now = 0, next = 0, forced = false;
  w.setTimeout = (fn, ms = 0) => { timers.set(++next, { fn, at: now + ms }); return next; };
  w.clearTimeout = id => timers.delete(id);
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = function (options) { this.scrollOptions = options; };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.RFOffline = { page: { current: () => ({ isOffline: () => forced }) } };
  w.eval(fs.readFileSync('backend/app/static/js/ui/toast.js', 'utf8'));
  const event = (name, detail = {}, target = d) => {
    const e = new w.CustomEvent(name, { detail, bubbles: true, cancelable: true });
    target.dispatchEvent(e); return e;
  };
  w.htmx = { ajax(method, url, options) {
    const target = typeof options.target === 'string' ? d.querySelector(options.target) : options.target;
    const req = { method, url, options, elt: options.source || target, target,
      xhr: { status: 200, responseURL: new URL(url, w.location).href, getResponseHeader: () => null, abort() { this.aborted = true; } } };
    if (!event('htmx:beforeRequest', req).defaultPrevented) requests.push(req);
    return Promise.resolve();
  }, process() {}, trigger: (el, name, detail) => event(name, detail, el) };
  function reply(req, html, status = 200, responseURL = req.xhr.responseURL, headers = {}) {
    Object.assign(req.xhr, { status, responseURL, responseText: html, getResponseHeader: name => headers[name] || null });
    const detail = { ...req, shouldSwap: status < 400, serverResponse: html };
    const accepted = !event('htmx:beforeOnLoad', detail).defaultPrevented;
    if (accepted && headers['HX-Trigger'] === 'closeBriefingModal') event('closeBriefingModal');
    if (accepted && !event('htmx:beforeSwap', detail).defaultPrevented && detail.shouldSwap) {
      req.target.innerHTML = html; event('htmx:afterSwap', detail);
    }
    event('htmx:afterRequest', { ...detail, failed: status >= 400, successful: status < 400 });
  }
  w.eval(fs.readFileSync('backend/app/static/js/ui/dialog.js', 'utf8'));
  w.eval(fs.readFileSync('backend/app/static/js/catchup.js', 'utf8'));
  w.RFCatchup.init();
  const tick = ms => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { dom, w, d, requests, event, reply, tick, click, force: value => { forced = value; } };
}

test('catchup: sheet save refreshes list and restores focus', async () => {
  const { dom, w, d, requests, event, reply, click, tick } = setup();
  try {
    const open = () => click(d.querySelector('[data-action="open-briefing-modal"]'));
    open(); assert.equal(requests.length, 1);
    assert.equal(d.querySelector('dialog').open, true);
    assert.match(d.querySelector('#rf-briefing-sheet-title').textContent, /<bad>/);
    const old = requests.at(-1);
    d.querySelector('#catchup-configs-list-wrapper').innerHTML = list(2);
    w.RFCatchup.init(); event('htmx:afterSettle'); open();
    assert.equal(requests.length, 2);
    reply(old, sheet.replace('08:00', 'stale'));
    assert.doesNotMatch(d.querySelector('#rf-briefing-sheet-body').textContent, /stale/);
    reply(requests.at(-1), sheet);
    const form = d.querySelector('#briefing-form'); form.querySelector('input').value = '12:34';
    const validation = { elt: form, target: d.querySelector('#briefing-form-error'), xhr: {
      status: 200, responseURL: 'https://readfine.test/htmx/catchup-configs/2/briefing',
      getResponseHeader: name => name === 'HX-Retarget' ? '#briefing-form-error' : null } };
    event('htmx:beforeRequest', validation);
    reply(validation, '<div role="alert" class="alert">Invalid time</div>', 200, validation.xhr.responseURL, { 'HX-Retarget': '#briefing-form-error' });
    assert.equal(d.querySelector('#briefing-form-error').textContent, 'Invalid time');
    assert.equal(form.querySelector('input').value, '12:34'); assert.equal(d.querySelector('dialog').open, true);
    const saved = { ...validation, target: d.querySelector('#catchup-configs-list-wrapper') };
    event('htmx:beforeRequest', saved);
    reply(saved, list(2), 200, saved.xhr.responseURL, { 'HX-Trigger': 'closeBriefingModal' });
    assert.equal(d.querySelector('dialog').open, false);
    await Promise.resolve();
    assert.equal(d.activeElement.dataset.configId, '2');
    const preserved = d.querySelector('#catchup-configs-list-wrapper').innerHTML;
    for (const [status, url] of [[404, null], [403, null], [429, null], [200, 'https://readfine.test/login']]) {
      open(); reply(requests.at(-1), '<html><body>Login</body></html>', status, url || requests.at(-1).xhr.responseURL);
      assert.ok(d.querySelector('#rf-briefing-sheet-body [role="alert"]'));
      assert.equal(d.querySelector('#catchup-configs-list-wrapper').innerHTML, preserved);
    }
    open(); event('htmx:sendError', requests.at(-1));
    assert.ok(d.querySelector('#rf-briefing-sheet-body [role="alert"]'));
    open(); reply(requests.at(-1), sheet);
    event('htmx:responseError', { elt: d.querySelector('[data-briefing-test]'), xhr: { status: 429 } });
    assert.match(d.querySelector('#briefing-test-result').textContent, /Wait/);
    d.querySelector('#briefing-test-result').innerHTML = '<div class="alert" data-briefing-test-ok>Sent</div>';
    event('htmx:afterSwap', { target: d.querySelector('#briefing-test-result') }); tick(5000);
    assert.equal(d.querySelector('[data-briefing-test-ok]'), null);
    click(d.querySelector('[data-action="load-catchup-config"]'));
    assert.equal(d.querySelector('#scope-value').value, '["feed:2"]');
    click(d.querySelector('[data-action="rename-config"]'));
    const input = d.querySelector('#rename-input-2'); assert.equal(input.value, '<bad>');
    input.value = 'new'; input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.match(requests.at(-1).url, /\/2\/rename$/);
    reply(requests.at(-1), '<p>refused</p>', 403);
    assert.equal(d.querySelector('#catchup-configs-list-wrapper').innerHTML.includes('catchup-config-2'), true);
    assert.match(d.querySelector('#toaster').textContent, /Access denied/);
    click(d.querySelector('[data-action="delete-config"]'));
    assert.equal(requests.at(-1).method, 'DELETE');
    const deleting = requests.at(-1), count = requests.length;
    click(d.querySelector('[data-action="delete-config"]'));
    assert.equal(requests.length, count); // an in-flight mutation is not repeated
    reply(deleting, list(2));
    const digestForm = d.querySelector('#catchup-form');
    digestForm.addEventListener('submit', e => {
      e.preventDefault();
      w.htmx.ajax('POST', '/htmx/catch-me-up/generate', {
        source: digestForm, target: d.querySelector('#catchup-result'),
      });
    });
    click(d.querySelector('[data-action="generate-catchup-config"]'));
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).method, 'POST');
    click(d.querySelector('[data-action="generate-catchup-config"]'));
    assert.equal(requests.length, count + 1);
    const openButton = d.querySelector('[data-action="open-briefing-modal"]');
    openButton.setAttribute('aria-disabled', 'true'); click(openButton);
    assert.equal(requests.length, count + 1);
    assert.match(d.querySelector('#toaster').textContent, /Connect to the internet/);
  } finally { dom.window.close(); }
});

test('catchup: estimates and jobs survive swaps without leaking requests', async () => {
  const { dom, w, d, requests, event, reply, tick, click, force } = setup();
  try {
    w.RFCatchup.init(); event('htmx:afterSettle'); tick(299); assert.equal(requests.length, 0);
    tick(1); assert.equal(requests.length, 1); const first = requests[0];
    d.querySelector('#scope-value').value = '["folder:4"]';
    event('change', {}, d.querySelector('#scope-value')); tick(300);
    assert.equal(requests.length, 2); assert.match(decodeURIComponent(requests[1].url), /folder:4/);
    reply(first, '<div>stale estimate</div>'); assert.doesNotMatch(d.querySelector('#catchup-estimate').textContent, /stale/);
    reply(requests[1], '<div>10 articles</div>'); assert.match(d.querySelector('#catchup-estimate').textContent, /10 articles/);
    const form = d.querySelector('#catchup-form');
    const generation = { elt: form, target: d.querySelector('#catchup-result'), xhr: { abort() {}, getResponseHeader: () => null } };
    assert.equal(event('htmx:beforeRequest', generation).defaultPrevented, false);
    assert.equal(event('htmx:beforeRequest', { ...generation, xhr: {} }).defaultPrevented, true);
    const progress = '<div hx-get="/htmx/catch-me-up/jobs/one" hx-trigger="load delay:3s" hx-target="#catchup-result" hx-swap="innerHTML">Pending</div>';
    reply(generation, progress, 200, 'https://readfine.test/htmx/catch-me-up/generate');
    assert.equal(d.querySelector('#catchup-result').scrollOptions.behavior, 'auto');
    assert.equal(event('htmx:beforeRequest', { ...generation, xhr: {} }).defaultPrevented, true);
    const poll = { elt: d.querySelector('#catchup-result [hx-get]'), target: generation.target, xhr: { abort() { this.aborted = true; }, getResponseHeader: () => null } };
    assert.equal(event('htmx:beforeRequest', poll).defaultPrevented, false);
    force(true); event('rf:offline-change');
    assert.equal(event('htmx:beforeRequest', poll).defaultPrevented, true);
    assert.equal(poll.xhr.aborted, true);
    force(false);
    const retry = d.querySelector('[data-action="retry-catchup-poll"]'); assert.ok(retry);
    const count = requests.length; click(retry);
    assert.equal(requests.length, count + 1); assert.match(requests.at(-1).url, /jobs\/one$/);
    reply(requests.at(-1), '<p>malformed</p>');
    assert.ok(d.querySelector('#catchup-result [role="alert"]'));
    assert.ok(d.querySelector('#catchup-copy-btn').classList.contains('hidden'));
    click(d.querySelector('[data-action="retry-catchup-poll"]'));
    reply(requests.at(-1), '<div class="alert" role="alert">This briefing expired.</div>');
    assert.ok(d.querySelector('#catchup-copy-btn').classList.contains('hidden'));
    // A fresh generation can follow a terminal expired response.
    assert.equal(event('htmx:beforeRequest', generation).defaultPrevented, false);
    reply(generation, '<div class="prose">Digest</div>', 200, 'https://readfine.test/htmx/catch-me-up/generate');
    let copied;
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
    click(d.querySelector('#catchup-copy-btn')); await Promise.resolve(); assert.equal(copied, 'Digest');
    assert.match(d.querySelector('#toaster').textContent, /Copied/);
    event('change', {}, d.querySelector('#scope-value')); tick(300);
    const pendingEstimate = requests.at(-1);
    const beforeDetach = requests.length;
    d.querySelector('#assistant-catch-up').remove(); event('htmx:afterSettle'); tick(300);
    assert.equal(requests.length, beforeDetach);
    assert.equal(pendingEstimate.xhr.aborted, true);
    d.body.innerHTML = section(); w.RFCatchup.init(); tick(300);
    assert.equal(requests.length, beforeDetach + 1);
    reply(pendingEstimate, '<div>detached response</div>');
    assert.doesNotMatch(d.querySelector('#catchup-estimate').textContent, /detached/);
    Object.defineProperty(w.navigator, 'onLine', { value: false, configurable: true });
    w.dispatchEvent(new w.Event('offline'));
    event('change', {}, d.querySelector('#scope-value')); tick(300);
    assert.equal(requests.length, beforeDetach + 1);
  } finally { dom.window.close(); }
});
