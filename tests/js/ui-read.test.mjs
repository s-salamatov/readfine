// The read zone (s4-T5): window.RFRead (static/js/ui/read.js) and the read code that
// stays in app.js.
//
// read.js runs after app.js, the way main.html loads it, in the harness's jsdom. A stub
// RFToast records every toast, a stub RFPalette.goTo records the chips' navigation, a
// stub fetch answers the undo, and app.js's _kbReload is replaced by a counter: the
// list reload is app.js's business, read.js only asks for it.
//
// Pinned (plan, Global Constraints): the mark-all toasts and the undo contract (the
// stamp goes back byte for byte, form-encoded, since it carries a "+"), swipe on rows
// (touch only, axis lock at 10 px, the action through the row's own controls, a
// committed swipe does not open the article), the View reload, the chips, the skeleton
// after 150 ms, the progress variable and the archive Undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './harness.mjs';

const STAMP = '2026-11-23T03:16:00.000000+00:00';

function answer(status, { headers = {}, body = '' } = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const key = Object.keys(headers).find((h) => h.toLowerCase() === String(name).toLowerCase());
        return key === undefined ? null : headers[key];
      },
    },
    text: async () => body,
  };
}

// `respond(url, opts)` answers each fetch; `reduce` is prefers-reduced-motion.
function load(body = '', { respond = null, reduce = false, scripts = ['ui/read.js'] } = {}) {
  const seen = { toasts: [], fetches: [], goTo: [], reloads: 0, ajax: [] };
  const w = browser(body, {
    before(win) {
      win.document.cookie = 'csrftoken=tok123';
      win.RFToast = {
        show(opts) { seen.toasts.push(opts); return { el: null, update() {}, close() {} }; },
        fromTrigger(value) { seen.toasts.push({ trigger: value }); return []; },
      };
      win.RFPalette = { open() {}, isOpen() { return false; }, goTo(url) { seen.goTo.push(url); } };
      win.fetch = (url, opts) => {
        seen.fetches.push({ url, opts });
        return respond ? respond(url, opts) : Promise.resolve(answer(200));
      };
      win.matchMedia = (q) => ({
        matches: reduce && /reduce/.test(q), media: q,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      });
      // node:test's mocked timers reach the window through these.
      win.setTimeout = (fn, ms) => setTimeout(fn, ms);
      win.clearTimeout = (id) => clearTimeout(id);
    },
    scripts,
  });
  w._kbReload = () => { seen.reloads += 1; };
  w.htmx.ajax = (verb, url, opts) => { seen.ajax.push({ verb, url, opts: opts || {} }); return Promise.resolve(); };
  return { w, seen };
}

function markedAll(w, detail) {
  w.document.body.dispatchEvent(new w.CustomEvent('rf:markedall', { detail, bubbles: true }));
}

const settle = () => new Promise((r) => setImmediate(r));
async function settled() { for (let i = 0; i < 5; i++) await settle(); }

// The last toast's text, or the showToast value handed to fromTrigger (copied out of
// the window's realm, so deepEqual compares it as data).
function lastMsg(seen) {
  const t = seen.toasts[seen.toasts.length - 1];
  if (!t) return undefined;
  return t.msg !== undefined ? t.msg : JSON.parse(JSON.stringify(t.trigger));
}

test('read: mark-all Undo posts the stamp unchanged and reloads the list; offline and stampless answers have no Undo', async (t) => {
  await t.test('online: Marked N with Undo for 10 s, the stamp posted exactly', async () => {
    const { w, seen } = load();
    assert.ok(w.RFRead, 'window.RFRead');
    markedAll(w, { stamp: STAMP, count: 3 });
    assert.equal(seen.toasts.length, 1);
    const toast = seen.toasts[0];
    assert.equal(toast.msg, 'Marked 3 as read');
    assert.equal(toast.duration, 10000);
    assert.equal(toast.action && toast.action.label, 'Undo');
    toast.action.onClick();
    await settled();
    assert.equal(seen.fetches.length, 1);
    const { url, opts } = seen.fetches[0];
    assert.equal(url, '/htmx/articles/mark-read/undo');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.credentials, 'same-origin');
    assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(opts.headers['HX-Request'], 'true');
    assert.equal(opts.headers['x-csrftoken'], 'tok123');
    assert.equal(opts.body, 'stamp=' + encodeURIComponent(STAMP));
    assert.equal(new URLSearchParams(opts.body).get('stamp'), STAMP, 'the "+" survives');
  });

  await t.test('200: the server toast, then the list reloads', async () => {
    const trigger = JSON.stringify({ sidebarRefresh: true, showToast: { msg: 'Restored 3', type: 'ok' } });
    const { w, seen } = load('', { respond: () => Promise.resolve(answer(200, { headers: { 'HX-Trigger': trigger } })) });
    await w.RFRead.undoMarkAll(STAMP);
    assert.deepEqual(lastMsg(seen), { msg: 'Restored 3', type: 'ok' });
    assert.equal(seen.reloads, 1);
  });

  await t.test('an offline answer or a failed fetch: Couldn\'t undo while offline', async () => {
    const cases = [
      () => Promise.resolve(answer(200, { headers: { 'X-Readfine-Offline': '1' }, body: '<div>x</div>' })),
      () => Promise.resolve(answer(200, { body: '<div data-rf-needs-connection>Needs a connection</div>' })),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ];
    for (const respond of cases) {
      const { w, seen } = load('', { respond });
      await w.RFRead.undoMarkAll(STAMP);
      assert.equal(lastMsg(seen), 'Couldn\'t undo while offline');
      assert.equal(seen.reloads, 0, 'the list stays as it is');
    }
  });

  await t.test('410: the server\'s toast; a bare failure: Couldn\'t undo. Try again.', async () => {
    const late = JSON.stringify({ showToast: { msg: 'Too late to undo', type: 'info' } });
    let r = load('', { respond: () => Promise.resolve(answer(410, { headers: { 'HX-Trigger': late } })) });
    await r.w.RFRead.undoMarkAll(STAMP);
    assert.deepEqual(lastMsg(r.seen), { msg: 'Too late to undo', type: 'info' });
    assert.equal(r.seen.reloads, 0);
    r = load('', { respond: () => Promise.resolve(answer(500, { headers: { 'HX-Trigger': 'not json{' } })) });
    await r.w.RFRead.undoMarkAll(STAMP);
    assert.equal(lastMsg(r.seen), 'Couldn\'t undo. Try again.');
    assert.equal(r.seen.reloads, 0);
  });

  await t.test('no stamp (offline): will sync, no Undo; nothing marked: no Undo', () => {
    const { w, seen } = load();
    markedAll(w, { stamp: null, count: 4 });
    assert.equal(seen.toasts[0].msg, 'Marked 4 as read · will sync');
    assert.ok(!seen.toasts[0].action, 'no Undo offline');
    markedAll(w, { stamp: STAMP, count: 0 });
    assert.equal(seen.toasts[1].msg, 'Nothing to mark as read');
    assert.ok(!seen.toasts[1].action, 'no Undo for nothing');
    assert.equal(seen.fetches.length, 0);
  });
});

// A row as article_row.html draws it: the row opens on click (htmx), the star button
// stops that.
const ROW = '<div id="article-list"><div id="article-row-7" class="article-row" data-article-id="7" data-is-read="false"'
  + ' hx-get="/htmx/articles/7" hx-trigger="click">'
  + '<button data-star-btn data-stop-propagation><span>☆</span></button>'
  + '<p data-article-title>Title</p></div></div>';

function swipeRig(opts = {}) {
  const r = load(ROW, opts);
  const row = r.w.document.getElementById('article-row-7');
  row.getBoundingClientRect = () => ({ width: 300, height: 60, left: 0, top: 0, right: 300, bottom: 60, x: 0, y: 0 });
  const got = { stars: 0, opens: 0 };
  row.querySelector('[data-star-btn]').addEventListener('click', () => { got.stars += 1; });
  // htmx's own listener sits on the row itself.
  row.addEventListener('click', (e) => { if (!e.target.closest('[data-star-btn]')) got.opens += 1; });
  return Object.assign(r, { row, got });
}

function gesture(w, el, moves, { pointerType = 'touch', click = true } = {}) {
  const ev = (type, x, y) => new w.PointerEvent(type, {
    pointerType, pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true,
  });
  const title = el.querySelector('[data-article-title]');
  title.dispatchEvent(ev('pointerdown', 100, 100));
  let last = [100, 100];
  for (const [dx, dy] of moves) {
    last = [100 + dx, 100 + dy];
    title.dispatchEvent(ev('pointermove', last[0], last[1]));
  }
  title.dispatchEvent(ev('pointerup', last[0], last[1]));
  // The click a finger lift can still produce: it must not open the article.
  if (click) title.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}

test('read: swipe right stars, left marks read, vertical scroll does nothing, reduced motion keeps the action', async (t) => {
  await t.test('right past the threshold stars the row and does not open it', () => {
    const { w, row, got, seen } = swipeRig();
    gesture(w, row, [[5, 0], [40, 2], [120, 4]], { click: false });
    assert.equal(got.stars, 1);
    assert.equal(got.opens, 0, 'a committed swipe never opens the article');
    assert.equal(seen.ajax.length, 0);
    assert.equal(row.hasAttribute('data-rf-swipe'), false, 'the state is cleared on release');
    // A second swipe right away (the click guard of the first still armed) stars again.
    gesture(w, row, [[30, 0], [120, 0]]);
    assert.equal(got.stars, 2);
    assert.equal(got.opens, 0);
  });

  await t.test('left past the threshold posts read with swap none', () => {
    const { w, row, got, seen } = swipeRig();
    gesture(w, row, [[-20, 1], [-120, 2]]);
    assert.equal(got.stars, 0);
    assert.equal(got.opens, 0);
    assert.deepEqual(seen.ajax.map((a) => [a.verb, a.url, a.opts.swap]), [['POST', '/htmx/articles/7/read', 'none']]);
  });

  await t.test('the row follows the finger while it moves', () => {
    const { w, row } = swipeRig();
    const ev = (type, x, y) => new w.PointerEvent(type, { pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: x, clientY: y, bubbles: true });
    row.dispatchEvent(ev('pointerdown', 100, 100));
    row.dispatchEvent(ev('pointermove', 160, 102));
    assert.equal(row.getAttribute('data-rf-swipe'), 'right');
    assert.match(row.style.transform, /translateX\(60px\)/);
    row.dispatchEvent(ev('pointercancel', 160, 102));
    assert.equal(row.hasAttribute('data-rf-swipe'), false);
  });

  await t.test('vertical movement, a short swipe and a mouse do nothing', () => {
    for (const [moves, type] of [[[[2, 15], [4, 80]], 'touch'], [[[20, 0], [50, 0]], 'touch'], [[[60, 0], [150, 0]], 'mouse']]) {
      const { w, row, got, seen } = swipeRig();
      gesture(w, row, moves, { pointerType: type });
      assert.equal(got.stars, 0, JSON.stringify(moves) + ' ' + type);
      assert.equal(seen.ajax.length, 0);
      assert.equal(row.hasAttribute('data-rf-swipe'), false);
      assert.ok(['', 'translateX(0px)'].includes(row.style.transform), row.style.transform);
    }
    // A plain tap still opens the article.
    const { w, row, got } = swipeRig();
    row.querySelector('[data-article-title]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.equal(got.opens, 1);
  });

  await t.test('reduced motion: the action runs and the row snaps back at once', () => {
    const { w, row, got } = swipeRig({ reduce: true, scripts: ['ui/motion.js', 'ui/read.js'] });
    assert.equal(w.RFMotion.reduced(), true);
    gesture(w, row, [[30, 0], [130, 0]]);
    assert.equal(got.stars, 1);
    assert.ok(['', 'translateX(0px)'].includes(row.style.transform), row.style.transform);
    assert.equal(row.hasAttribute('data-rf-swipe'), false);
  });
});

test('read: View change reloads the list, chips go through RFPalette.goTo, skeleton waits 150 ms, progress follows scroll, archive shows Undo', async (t) => {
  await t.test('View change and chips', () => {
    const { w, seen } = load('<div id="article-list"><div data-rf-chips>'
      + '<button type="button" data-rf-nav="/htmx/articles" aria-pressed="true">All</button>'
      + '<button type="button" data-rf-nav="/htmx/articles?folder_id=2" aria-pressed="false">Tech</button>'
      + '</div><button id="v" data-rf-view="sort:oldest"></button></div>');
    w.document.getElementById('v').dispatchEvent(new w.CustomEvent('rf:viewchanged', { detail: { field: 'sort', value: 'oldest' }, bubbles: true }));
    assert.equal(seen.reloads, 1);
    w.document.querySelector('[data-rf-nav="/htmx/articles?folder_id=2"]').click();
    assert.deepEqual(seen.goTo, ['/htmx/articles?folder_id=2']);
  });

  await t.test('skeleton after 150 ms, gone after the request', (tt) => {
    tt.mock.timers.enable({ apis: ['setTimeout'] });
    const { w } = load('<section id="article-list"></section>'
      + '<template id="rf-list-skeleton"><div data-rf-skeleton aria-hidden="true"><div class="skeleton"></div></div></template>');
    const list = w.document.getElementById('article-list');
    const fire = (name) => w.document.body.dispatchEvent(new w.CustomEvent(name, { detail: { target: list, elt: list }, bubbles: true }));
    fire('htmx:beforeRequest');
    tt.mock.timers.tick(149);
    assert.equal(list.querySelector('.article-list-loading'), null, 'a quick load shows nothing');
    tt.mock.timers.tick(1);
    const veil = list.querySelectorAll('.article-list-loading');
    assert.equal(veil.length, 1);
    assert.ok(veil[0].querySelector('[data-rf-skeleton] .skeleton'), 'the skeleton rows are cloned in');
    assert.equal(veil[0].querySelector('svg'), null, 'no spinner');
    fire('htmx:afterRequest');
    assert.equal(list.querySelector('.article-list-loading'), null);
    // A request that ends before the delay never shows it.
    fire('htmx:beforeRequest');
    fire('htmx:afterRequest');
    tt.mock.timers.tick(500);
    assert.equal(list.querySelector('.article-list-loading'), null);
  });

  await t.test('progress follows the panel\'s scroll', async () => {
    const { w } = load('<main id="article-detail"><div id="article-detail-root" data-article-id="7">'
      + '<div data-article-toolbar><div data-rf-progress></div></div><article data-article-id="7"></article></div></main>');
    const panel = w.document.getElementById('article-detail');
    Object.defineProperty(panel, 'scrollHeight', { value: 1100 });
    Object.defineProperty(panel, 'clientHeight', { value: 100 });
    panel.scrollTop = 500;
    panel.dispatchEvent(new w.Event('scroll'));
    await new Promise((r) => w.requestAnimationFrame(() => w.requestAnimationFrame(r)));
    const bar = panel.querySelector('[data-rf-progress]');
    assert.equal(Number(bar.style.getPropertyValue('--rf-progress')), 0.5);
    panel.scrollTop = 1000;
    panel.dispatchEvent(new w.Event('scroll'));
    await new Promise((r) => w.requestAnimationFrame(() => w.requestAnimationFrame(r)));
    assert.equal(Number(bar.style.getPropertyValue('--rf-progress')), 1);
  });

  await t.test('archive shows Undo, which goes through the open article or a plain post', () => {
    const { w, seen } = load('<main id="article-detail"><div id="article-detail-root" data-article-id="7">'
      + '<button data-header-archive></button></div></main>');
    let clicked = 0;
    w.document.querySelector('[data-header-archive]').addEventListener('click', () => { clicked += 1; });
    const archived = (id, isArchived) => w.document.body.dispatchEvent(
      new w.CustomEvent('articleArchiveChanged', { detail: { id, isArchived }, bubbles: true }));
    archived(7, false);
    assert.equal(seen.toasts.length, 0, 'unarchiving says nothing');
    archived(7, true);
    assert.equal(seen.toasts.length, 1);
    assert.equal(seen.toasts[0].msg, 'Archived');
    assert.equal(seen.toasts[0].action.label, 'Undo');
    seen.toasts[0].action.onClick();
    assert.equal(clicked, 1, 'the open article\'s archive control');
    assert.equal(seen.ajax.length, 0);
    archived(9, true);
    seen.toasts[1].action.onClick();
    assert.deepEqual(seen.ajax.map((a) => [a.verb, a.url, a.opts.swap]), [['POST', '/htmx/articles/9/archive', 'none']]);
  });
});

// The chat thread as chat.html draws it: the messages, then the input row.
function chatArea(id, inner = '') {
  return '<div id="chat-area-' + id + '"><div id="chat-messages-' + id + '">' + inner + '</div>'
    + '<div class="shrink-0 pt-2"><textarea id="chat-input-' + id + '"></textarea>'
    + '<button id="send-' + id + '" hx-post="/htmx/articles/' + id + '/ai-chat">Send</button></div></div>';
}

test('chat: a reply with data-chat-error puts the message back for retry', () => {
  const { w } = load('<div id="chat-modal-5" data-chat-modal-id="5">' + chatArea(5) + '</div>');
  const doc = w.document;
  const send = (text) => {
    doc.getElementById('chat-input-5').value = text;
    doc.body.dispatchEvent(new w.CustomEvent('htmx:beforeRequest', { detail: { elt: doc.getElementById('send-5') }, bubbles: true }));
  };
  const swapIn = (inner) => {
    const area = doc.getElementById('chat-area-5');
    area.outerHTML = chatArea(5, inner);
    doc.body.dispatchEvent(new w.CustomEvent('htmx:afterSwap', { detail: { target: doc.getElementById('chat-area-5') }, bubbles: true }));
  };

  // The server's error (chat.html: alert with data-chat-error) gives the message back.
  send('What is new?');
  assert.equal(doc.getElementById('chat-input-5').value, '');
  swapIn('<div class="alert" data-variant="destructive" role="alert" data-chat-error><section>AI failed</section></div>');
  assert.equal(doc.getElementById('chat-input-5').value, 'What is new?');

  // A reply without one leaves the field empty; the old red text is no error any more.
  send('Second');
  swapIn('<div class="text-red-500">a quote in red</div><div>answer</div>');
  assert.equal(doc.getElementById('chat-input-5').value, '');

  // A failed request: the client's own error is the same alert, its text set as text.
  send('Third');
  doc.body.dispatchEvent(new w.CustomEvent('htmx:responseError', {
    detail: { elt: doc.getElementById('send-5'), xhr: { status: 500, getResponseHeader: () => null } }, bubbles: true,
  }));
  const err = doc.querySelector('#chat-area-5 [data-chat-error]');
  assert.ok(err, 'an error with the hook');
  assert.equal(err.tagName, 'DIV');
  assert.ok(err.classList.contains('alert'));
  assert.equal(err.getAttribute('data-variant'), 'destructive');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.equal(err.textContent, 'Request failed — please try again.');
  assert.equal(err.querySelectorAll('*').length <= 1, true, 'text only, at most a section');
  assert.equal(err.classList.contains('text-red-500'), false);
  assert.equal(doc.getElementById('chat-input-5').value, 'Third');
});
