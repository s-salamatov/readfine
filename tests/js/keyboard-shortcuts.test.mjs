// Keyboard shortcuts in the reader.
//
// Every shortcut clicks the control the mouse would use, so what is worth pinning down
// is which control that is: the next row after the article that is open (in whichever
// layout it is open), the ··· menu of that article and not of another one in the page,
// and nothing at all while the reader is typing or another window is in front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browser, list, row } from './harness.mjs';

function reader(w, { layout = '3', bucket = 'large' } = {}) {
  w.document.documentElement.dataset.layout = layout;
  w.document.documentElement.dataset.bucket = bucket;
  return w;
}

// An article as article_detail.html draws it, with the ··· menu controls the keys use.
function article(id) {
  return (
    '<div id="article-detail-root" data-article-id="' + id + '">'
    + '<div class="article-detail-title-row"><a href="https://example.com/' + id + '" data-external-link>t</a></div>'
    + '<button data-header-star></button><button data-header-read></button><button data-header-archive></button>'
    + '</div>'
  );
}

function panel(id = null) {
  return '<main id="article-detail">' + (id === null ? '' : article(id)) + '</main>';
}

function inline(id) {
  return '<div id="inline-article-detail"><div id="inline-article-detail-content">' + article(id) + '</div></div>';
}

function press(w, key, opts = {}, target = null) {
  const e = new w.KeyboardEvent('keydown', Object.assign({ key: key, bubbles: true, cancelable: true }, opts));
  (target || w.document.body).dispatchEvent(e);
  return e;
}

// What got clicked, as a short name: "row 2", "star 1", "nav /htmx/articles".
function clicks(w) {
  const seen = [];
  w.document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.classList.contains('article-row')) seen.push('row ' + t.dataset.articleId);
    else if (t.closest('[data-article-id]')) {
      const id = t.closest('[data-article-id]').dataset.articleId;
      if (t.hasAttribute('data-header-star')) seen.push('star ' + id);
      if (t.hasAttribute('data-header-read')) seen.push('read ' + id);
      if (t.hasAttribute('data-header-archive')) seen.push('archive ' + id);
    }
    if (t.classList.contains('nav-item')) seen.push('nav ' + t.getAttribute('hx-get'));
    if (t.dataset.action === 'mark-read') seen.push('mark-read');
  }, true);
  return seen;
}

test('j and k move from the article open in the panel', () => {
  const w = reader(browser(list(row(1), row(2), row(3)) + panel(2)));
  const seen = clicks(w);
  press(w, 'j');
  press(w, 'k');
  assert.deepEqual(seen, ['row 3', 'row 1']);
});

test('the TT-RSS keys n and p do the same', () => {
  const w = reader(browser(list(row(1), row(2), row(3)) + panel(2)));
  const seen = clicks(w);
  press(w, 'n');
  press(w, 'p');
  assert.deepEqual(seen, ['row 3', 'row 1']);
});

test('with nothing open, j starts at the top', () => {
  const w = reader(browser(list(row(1), row(2)) + panel()));
  const seen = clicks(w);
  press(w, 'j');
  assert.deepEqual(seen, ['row 1']);
});

test('at the end of the list j stays put', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(2)));
  const seen = clicks(w);
  press(w, 'j');
  assert.deepEqual(seen, []);
});

test('reading inline, the open article is the one in the list, not the panel', () => {
  // The panel keeps whatever it last held in the 2-panel layout; moving from it would
  // jump to wherever that article happens to be.
  const w = reader(browser(list(row(1), row(2), row(3)) + inline(1) + panel(2)), { layout: '2', bucket: 'medium' });
  const seen = clicks(w);
  press(w, 'j');
  press(w, 's');
  assert.deepEqual(seen, ['row 2', 'star 1']);
});

test('after closing the inline article, j carries on from it', () => {
  const w = reader(browser(list(row(1), row(2), row(3)) + panel()), { layout: '2', bucket: 'medium' });
  w.document.getElementById('article-row-2').click();
  const seen = clicks(w);
  press(w, 'j');
  assert.deepEqual(seen, ['row 3']);
});

test('a new list starts the cursor over', () => {
  const w = reader(browser(list(row(1), row(2), row(3)) + panel()), { layout: '2', bucket: 'medium' });
  w.document.getElementById('article-row-2').click();
  w.document.body.dispatchEvent(new w.CustomEvent('htmx:afterSwap', {
    bubbles: true, detail: { target: w.document.getElementById('article-list') },
  }));
  const seen = clicks(w);
  press(w, 'j');
  assert.deepEqual(seen, ['row 1']);
});

test('article keys act on the open article, aliases included', () => {
  const w = reader(browser(list(row(1)) + panel(1)));
  const seen = clicks(w);
  for (const key of ['s', 'f', 'm', 'u', 'e']) press(w, key);
  assert.deepEqual(seen, ['star 1', 'star 1', 'read 1', 'read 1', 'archive 1']);
});

test('a phone reading full-screen has no open article once it went back to the list', () => {
  const w = reader(browser(list(row(1)) + panel(1)), { layout: '3', bucket: 'small' });
  w.localStorage.setItem('detail_mode_small', 'fullscreen');
  const seen = clicks(w);
  press(w, 's');
  assert.deepEqual(seen, []);
});

test('over a story, the keys star that article and leave the list alone', () => {
  const w = reader(browser(list(row(1), row(2)) + inline(1) + panel(7)), { layout: '2', bucket: 'medium' });
  w.document.documentElement.classList.add('story-detail-open');
  const seen = clicks(w);
  press(w, 'j');
  press(w, 's');
  assert.deepEqual(seen, ['star 7']);
});

test('typing in a field is typing', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1) + '<input id="x"><textarea id="y"></textarea>'));
  const seen = clicks(w);
  press(w, 'j', {}, w.document.getElementById('x'));
  press(w, 's', {}, w.document.getElementById('y'));
  assert.deepEqual(seen, []);
});

test('Ctrl and Alt combinations stay with the browser', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1)));
  const seen = clicks(w);
  press(w, 'j', { ctrlKey: true });
  press(w, 's', { altKey: true });
  press(w, 'j', { metaKey: true });
  assert.deepEqual(seen, []);
});

test('nothing moves while a window is in front of the list', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1)
    + '<div id="general-chat-modal"></div>'));
  const seen = clicks(w);
  press(w, 'j');
  assert.deepEqual(seen, []);
});

test('g then a goes to All articles, g then s to Starred', () => {
  const w = reader(browser(list(row(1)) + panel()
    + '<div id="sidebar-full"><a class="nav-item" hx-get="/htmx/articles"></a>'
    + '<a class="nav-item" hx-get="/htmx/articles?starred_only=true"></a></div>'));
  const seen = clicks(w);
  press(w, 'g'); press(w, 'a');
  press(w, 'g'); press(w, 's');
  assert.deepEqual(seen, ['nav /htmx/articles', 'nav /htmx/articles?starred_only=true']);
});

test('g followed by anything else lets that key through', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1)));
  const seen = clicks(w);
  press(w, 'g'); press(w, 'j');
  assert.deepEqual(seen, ['row 2']);
});

// The browser's connection state. Marking a view read asks first only offline, where
// there is no Undo (s4 Q1); online the Undo toast covers it.
function offline(w, off = true) {
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => !off });
  return w;
}

function sidebarRow(active) {
  return '<div class="mark-read-row"><a class="nav-item' + (active ? ' active' : '') + '" hx-get="/htmx/articles?feed_id=1"></a>'
    + '<button data-action="mark-read"></button></div>';
}

test('Shift+A marks the open view read once confirmed', () => {
  const w = offline(reader(browser(list(row(1)) + panel() + sidebarRow(true))));
  let asked = 0;
  w.confirm = function () { asked++; return true; };
  const seen = clicks(w);
  press(w, 'A', { shiftKey: true });
  assert.equal(asked, 1);
  assert.deepEqual(seen, ['mark-read']);
});

test('Shift+A does nothing when the question is turned down', () => {
  const w = offline(reader(browser(list(row(1)) + panel() + sidebarRow(true))));
  w.confirm = function () { return false; };
  const seen = clicks(w);
  press(w, 'A', { shiftKey: true });
  assert.deepEqual(seen, []);
});

test('Shift+A leaves search results alone', () => {
  // The sidebar still highlights the view the search was started from, and marking
  // that read is not what the reader looking at results asked for.
  const w = reader(browser(
    '<div id="article-list"><div data-save-search-area></div>' + row(1) + '</div>'
    + panel() + sidebarRow(true)));
  let asked = 0;
  w.confirm = function () { asked++; return true; };
  const seen = clicks(w);
  press(w, 'A', { shiftKey: true });
  assert.equal(asked, 0);
  assert.deepEqual(seen, []);
});

// jsdom has <dialog> but neither showModal() nor close(): both are filled in with the
// open attribute and the close event, as in ui-dialog.test.mjs.
function polyfillDialog(w) {
  const proto = w.HTMLDialogElement.prototype;
  proto.showModal = function () {
    if (this.hasAttribute('open')) throw new w.DOMException('already open', 'InvalidStateError');
    this.setAttribute('open', '');
  };
  proto.close = function () {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  if (!('open' in proto)) {
    Object.defineProperty(proto, 'open', { get() { return this.hasAttribute('open'); } });
  }
}

const SHORTCUTS = '<dialog id="shortcuts-dialog"></dialog>';

// A reader with dialogs. `palette` adds the palette's <dialog> and a stand-in for
// RFPalette (ui/palette.js) with the two calls app.js may make: open() and isOpen().
function dialogReader(body, { palette = true } = {}) {
  const w = reader(browser(body + (palette ? '<dialog id="rf-palette"></dialog>' : ''), {
    before(win) {
      polyfillDialog(win);
      if (!palette) return;
      win.RFPalette = {
        opened: 0,
        open() { this.opened++; win.document.getElementById('rf-palette').showModal(); },
        isOpen() { return win.document.getElementById('rf-palette').open; },
      };
    },
  }));
  return w;
}

test('⌘K and Ctrl+K open the palette, also from an input', () => {
  const w = dialogReader(list(row(1)) + panel() + '<input id="x">');
  const palette = w.document.getElementById('rf-palette');
  const e = press(w, 'k', { metaKey: true });
  assert.equal(w.RFPalette.opened, 1);
  assert.equal(e.defaultPrevented, true, 'the browser does not get ⌘K');
  // A second press closes it again, from its own field as from anywhere.
  press(w, 'k', { ctrlKey: true }, w.document.getElementById('x'));
  assert.equal(palette.open, false);
  press(w, 'K', { ctrlKey: true }, w.document.getElementById('x'));
  assert.equal(w.RFPalette.opened, 2, 'Caps Lock does not matter');
  assert.equal(palette.open, true);
  // A layout without Latin letters (Russian: the K key types л) still has the K key.
  press(w, 'л', { ctrlKey: true, code: 'KeyK' });
  assert.equal(palette.open, false);
  press(w, 'Л', { metaKey: true, code: 'KeyK' });
  assert.equal(w.RFPalette.opened, 3);
  // Where the key is a Latin letter it decides (Dvorak: the K position types t).
  const t = press(w, 't', { ctrlKey: true, code: 'KeyK' });
  assert.equal(t.defaultPrevented, false);
  assert.equal(palette.open, true);
});

test('Escape with the palette open closes the palette alone', () => {
  const w = dialogReader(list(row(1)) + panel() + SHORTCUTS
    + '<div id="search-modal-overlay"></div><div id="feedback-modal-overlay"></div>');
  const palette = w.document.getElementById('rf-palette');
  // The palette opened over the search modal and the feedback window.
  w.document.documentElement.classList.add('search-modal-open');
  w.RFPalette.open();
  const e = press(w, 'Escape', {}, palette);
  assert.equal(palette.open, false);
  assert.equal(e.defaultPrevented, true, 'the browser does not act on it a second time');
  assert.equal(w.document.documentElement.classList.contains('search-modal-open'), true, 'the search modal stays');
  assert.equal(w.document.getElementById('search-modal-overlay').classList.contains('hidden'), false);
  assert.equal(w.document.getElementById('feedback-modal-overlay').classList.contains('hidden'), false);
  // The next Escape reaches the search modal.
  press(w, 'Escape');
  assert.equal(w.document.documentElement.classList.contains('search-modal-open'), false);
});

test('/ opens the palette, falling back to the search modal', () => {
  const w = dialogReader(list(row(1)) + panel());
  press(w, '/');
  assert.equal(w.RFPalette.opened, 1);
  // Pressed again with the palette up, it does not open it a second time.
  press(w, '/');
  assert.equal(w.RFPalette.opened, 1);

  const old = dialogReader(list(row(1)) + panel() + '<div id="search-modal-overlay" class="hidden"></div>', { palette: false });
  press(old, '/');
  assert.equal(old.document.getElementById('search-modal-overlay').classList.contains('hidden'), false);
});

test('? opens the shortcuts dialog and Escape closes it', () => {
  const w = dialogReader(list(row(1)) + panel() + SHORTCUTS + '<button id="opener"></button>');
  const dlg = w.document.getElementById('shortcuts-dialog');
  const opener = w.document.getElementById('opener');
  opener.focus();
  press(w, '?', { shiftKey: true }, opener);
  assert.equal(dlg.open, true);
  press(w, 'Escape');
  assert.equal(dlg.open, false);
  assert.equal(w.document.activeElement, opener, 'focus goes back where it was');
  // ? again toggles: open, then closed.
  press(w, '?', { shiftKey: true });
  press(w, '?', { shiftKey: true });
  assert.equal(dlg.open, false);
});

test('an open dialog covers the reader', () => {
  const w = dialogReader(list(row(1), row(2)) + panel(1) + SHORTCUTS + '<dialog id="other"></dialog>');
  w.document.getElementById('other').showModal();
  const seen = clicks(w);
  press(w, 'j');
  press(w, '?', { shiftKey: true });
  assert.deepEqual(seen, [], 'the dialog is in front, so j does nothing');
  assert.equal(w.document.getElementById('shortcuts-dialog').open, false, '? does not stack on another dialog');
});

test('shell actions: open-search, open-shortcuts, mark-all-read, reload-list', () => {
  const w = dialogReader(list(row(1)) + panel() + SHORTCUTS + sidebarRow(true)
    + '<button data-action="open-search"></button><button data-action="open-shortcuts"></button>'
    + '<button data-action="mark-all-read"></button><button data-action="reload-list"></button>');
  offline(w);
  const button = (action) => w.document.querySelector('[data-action="' + action + '"]');
  button('open-search').click();
  assert.equal(w.RFPalette.opened, 1);
  w.document.getElementById('rf-palette').close();

  button('open-shortcuts').click();
  assert.equal(w.document.getElementById('shortcuts-dialog').open, true);
  w.document.getElementById('shortcuts-dialog').close();

  let asked = 0;
  w.confirm = function () { asked++; return true; };
  const seen = clicks(w);
  button('mark-all-read').click();
  assert.equal(asked, 1);
  assert.deepEqual(seen, ['mark-read']);

  const requests = [];
  w.htmx.ajax = function (method, url, opts) { requests.push([method, url, opts.target]); return Promise.resolve(); };
  button('reload-list').click();
  assert.deepEqual(requests, [['GET', '/htmx/articles', '#article-list']]);

  // Without the palette, Search is the search modal it always was.
  const old = dialogReader('<div id="search-modal-overlay" class="hidden"></div><button data-action="open-search"></button>', { palette: false });
  old.document.querySelector('[data-action="open-search"]').click();
  assert.equal(old.document.getElementById('search-modal-overlay').classList.contains('hidden'), false);
});

// The sidebar as sidebar.html draws it: one active entry, and a folder whose feeds sit
// in a section that can be collapsed.
function sidebar({ active = null, collapsed = false } = {}) {
  const item = (url) => '<a class="nav-item' + (url === active ? ' active' : '') + '" hx-get="' + url + '"></a>';
  return '<div id="sidebar-full">'
    + item('/htmx/articles') + item('/htmx/articles?starred_only=true')
    + item('/htmx/articles?folder_id=1')
    + '<div class="collapsible' + (collapsed ? ' collapsed' : '') + '" id="collapse-folder-1">'
    + item('/htmx/articles?feed_id=1') + item('/htmx/articles?feed_id=2') + '</div>'
    + item('/htmx/articles?feed_id=3')
    + '</div>';
}

test('Shift+J and Shift+K walk the sidebar from the open entry', () => {
  const w = reader(browser(list(row(1)) + panel() + sidebar({ active: '/htmx/articles?folder_id=1' })));
  const seen = clicks(w);
  // The highlight follows each click, so K comes back to where J started.
  press(w, 'J', { shiftKey: true });
  press(w, 'K', { shiftKey: true });
  press(w, 'K', { shiftKey: true });
  assert.deepEqual(seen, [
    'nav /htmx/articles?feed_id=1', 'nav /htmx/articles?folder_id=1', 'nav /htmx/articles?starred_only=true',
  ]);
});

test('a collapsed folder is stepped over, not into', () => {
  const w = reader(browser(list(row(1)) + panel()
    + sidebar({ active: '/htmx/articles?folder_id=1', collapsed: true })));
  const seen = clicks(w);
  press(w, 'J', { shiftKey: true });
  assert.deepEqual(seen, ['nav /htmx/articles?feed_id=3']);
});

test('the sidebar walk stops at the end instead of starting over', () => {
  const w = reader(browser(list(row(1)) + panel() + sidebar({ active: '/htmx/articles?feed_id=3' })));
  const seen = clicks(w);
  press(w, 'J', { shiftKey: true });
  assert.deepEqual(seen, []);
});

test('t opens the labels of the open article', () => {
  const w = reader(browser(list(row(1)) + '<main id="article-detail"><div id="article-detail-root" data-article-id="1">'
    + '<button data-label-trigger></button></div></main>'));
  let opened = 0;
  w.document.querySelector('[data-label-trigger]').addEventListener('click', () => opened++);
  press(w, 't');
  press(w, 'l');
  assert.equal(opened, 2);
});

function scrollable(el, { height, client, top }) {
  Object.defineProperty(el, 'scrollHeight', { value: height });
  Object.defineProperty(el, 'clientHeight', { value: client });
  el.scrollTop = top;
  const scrolled = [];
  el.scrollBy = (opts) => scrolled.push(opts.top);
  return scrolled;
}

test('Space pages down the article while there is more of it', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1)));
  const scrolled = scrollable(w.document.getElementById('article-detail'), { height: 1000, client: 400, top: 0 });
  const seen = clicks(w);
  press(w, ' ');
  assert.deepEqual(seen, []);
  assert.equal(scrolled.length, 1);
  assert.ok(scrolled[0] > 0);
});

test('Space at the end of the article opens the next one', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1)));
  scrollable(w.document.getElementById('article-detail'), { height: 1000, client: 400, top: 600 });
  const seen = clicks(w);
  press(w, ' ');
  assert.deepEqual(seen, ['row 2']);
});

test('Shift+Space only goes back up', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(2)));
  const scrolled = scrollable(w.document.getElementById('article-detail'), { height: 1000, client: 400, top: 600 });
  const seen = clicks(w);
  press(w, ' ', { shiftKey: true });
  assert.deepEqual(seen, []);
  assert.ok(scrolled[0] < 0);
});

test('Space on a focused button presses the button', () => {
  const w = reader(browser(list(row(1), row(2)) + panel(1) + '<button id="b"></button>'));
  const seen = clicks(w);
  const e = press(w, ' ', {}, w.document.getElementById('b'));
  assert.deepEqual(seen, []);
  assert.equal(e.defaultPrevented, false);
});

// S3W-F5 and Q1 (s4). A Basecoat menu or popover open over the reader is in front of
// it, like a dialog: the list keys do nothing, and Escape closes the menu alone, even
// when Basecoat's own Escape handler (on the menu, so before app.js's) already closed
// it. Shift+A asks first only offline.
test('keyboard: an open menu covers the reader; Shift+A confirms only offline', async (t) => {
  await t.test('an open menu takes the keys and Escape', () => {
    const menu = '<div class="dropdown-menu" id="m"><button id="m-trigger" aria-haspopup="menu" aria-expanded="true"></button>'
      + '<div data-popover aria-hidden="false"><div role="menu"></div></div></div>';
    const w = reader(browser(list(row(1), row(2)) + panel(1) + sidebarRow(true) + menu
      + '<div id="chat-modal-1" data-chat-modal-id="1"></div>'));
    const trigger = w.document.getElementById('m-trigger');
    // Basecoat's dropdown closes itself on Escape from a listener on the menu.
    w.document.getElementById('m').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') trigger.setAttribute('aria-expanded', 'false');
    });
    let asked = 0;
    w.confirm = function () { asked++; return true; };
    let backs = 0;
    w.history.back = () => { backs++; };
    w._closeStoryOverlay = () => true;
    const seen = clicks(w);
    for (const key of ['j', 'k', 'm', 's', 'e', 'v']) press(w, key);
    press(w, 'A', { shiftKey: true });
    assert.deepEqual(seen, [], 'nothing reaches the list or the article');
    assert.equal(asked, 0);

    press(w, 'Escape', {}, trigger);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(backs, 0, 'Escape closed the menu, not the story overlay');
    assert.equal(w.document.getElementById('chat-modal-1').classList.contains('hidden'), false,
      'nor the chat modal');

    // A menu left open with the focus elsewhere: Escape still closes only the menu.
    trigger.setAttribute('aria-expanded', 'true');
    press(w, 'Escape');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(backs, 0);

    // Closed (and the chat modal too), the keys are back.
    w.document.getElementById('chat-modal-1').classList.add('hidden');
    press(w, 'j');
    assert.deepEqual(seen, ['row 2']);
    press(w, 'Escape');
    assert.equal(backs, 1);
  });

  await t.test('Shift+A: no question online, the question offline', () => {
    const w = reader(browser(list(row(1)) + panel() + sidebarRow(true)));
    let asked = 0;
    w.confirm = function () { asked++; return false; };
    const seen = clicks(w);
    press(w, 'A', { shiftKey: true });
    assert.equal(asked, 0, 'online: Undo covers it');
    assert.deepEqual(seen, ['mark-read']);
    offline(w);
    press(w, 'A', { shiftKey: true });
    assert.equal(asked, 1, 'offline: asked');
    assert.deepEqual(seen, ['mark-read'], 'and turned down');
  });
});
