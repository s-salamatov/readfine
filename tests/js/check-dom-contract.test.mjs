// DOM contract check: extraction of the ids, data-* attributes and classes that code and
// tests depend on, and verification against docs/ui-dom-contract.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropTestLocal, extract, parseContract, verify } from '../../scripts/check-dom-contract.mjs';

const APP = 'backend/app/static/js/app.js';

function contract(rows) {
  return parseContract([
    '| item | kind | consumers |',
    '|---|---|---|',
    ...rows.map(([item, kind]) => `| \`${item}\` | ${kind} | static/js/app.js |`),
  ].join('\n'));
}

test('contract: runtime-built id becomes a prefix pattern', () => {
  const found = extract([
    { path: APP, text: "const el = document.getElementById('article-row-' + id);" },
    { path: 'tests/js/x.test.mjs', text: 'w.document.querySelector(`#chat-area-${n} .msg`);' },
    // The part after a runtime value is unknown, so nothing is recorded for it.
    { path: 'backend/app/static/js/a.js', text: "document.getElementById(sid + '-value');" },
  ]);
  assert.deepEqual(found, [
    { item: 'article-row-*', kind: 'id', path: APP },
    { item: 'chat-area-*', kind: 'id', path: 'tests/js/x.test.mjs' },
    { item: 'msg', kind: 'class', path: 'tests/js/x.test.mjs' },
  ]);
  const listed = contract([['article-row-*', 'id']]);
  const only = found.slice(0, 1);
  const template = { path: 'backend/app/templates/app/partials/article_row.html', text: '<div id="article-row-{{ a.id }}" class="article-row">' };
  assert.deepEqual(verify(listed, only, { rendered: [], code: [template] }), { missing: [], unused: [], unrendered: [] });
  assert.deepEqual(verify(listed, only, { rendered: [], code: [] }).unrendered, [{ item: 'article-row-*', kind: 'id' }]);
});

test('contract: selector in code but not in contract is missing', () => {
  const found = extract([{ path: APP, text: "el.closest('[data-article-id]'); document.querySelectorAll('#sidebar .nav-item')" }]);
  const page = { path: 'backend/tests/fixtures/dom_contract/shell.html', text: '<nav id="sidebar"><a class="nav-item" data-article-id="1"></a></nav>' };
  const r = verify(contract([['sidebar', 'id'], ['nav-item', 'class']]), found, { rendered: [page], code: [] });
  assert.deepEqual(r.missing, [{ item: 'data-article-id', kind: 'data', path: APP }]);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.unrendered, []);
});

test('contract: listed item found nowhere is unused', () => {
  const found = extract([{ path: APP, text: "document.getElementById('shortcuts-modal-overlay')" }]);
  const page = { path: 'backend/tests/fixtures/dom_contract/shortcuts.html', text: '<div id="shortcuts-modal-overlay"></div><div id="gone"></div>' };
  const r = verify(contract([['shortcuts-modal-overlay', 'id'], ['gone', 'id']]), found, { rendered: [page], code: [] });
  assert.deepEqual(r.unused, [{ item: 'gone', kind: 'id' }]);
  assert.deepEqual(r.missing, []);
});

test('contract: dataset and Playwright locators are extracted', () => {
  const found = extract([
    { path: APP, text: 'const t = el.dataset.headerTitle;' },
    { path: 'tests/e2e/offline.spec.mjs', text: "await expect(page.locator('#sidebar .nav-item')).toBeVisible();" },
    { path: 'backend/tests/test_x.py', text: `assert 'id="ai-summary-10"' in resp.text\nsoup.select_one("[data-rf-search-text]")\nsoup.find(id=f"chat-modal-{a.id}")` },
  ]);
  assert.deepEqual(found, [
    { item: 'data-header-title', kind: 'data', path: APP },
    { item: 'sidebar', kind: 'id', path: 'tests/e2e/offline.spec.mjs' },
    { item: 'nav-item', kind: 'class', path: 'tests/e2e/offline.spec.mjs' },
    { item: 'ai-summary-*', kind: 'id', path: 'backend/tests/test_x.py' },
    { item: 'data-rf-search-text', kind: 'data', path: 'backend/tests/test_x.py' },
    { item: 'chat-modal-*', kind: 'id', path: 'backend/tests/test_x.py' },
  ]);
});

test('contract: ids composed in templates verify, test-local fixtures are dropped', () => {
  const fixture = `'<input id="x"><div id="shortcuts-modal-overlay"></div>'`;
  const found = extract([
    { path: 'backend/app/static/js/catchup.js', text: "document.getElementById('catchup-label-any'); document.querySelector('.sm\\\\:hidden')" },
    { path: 'tests/js/k.test.mjs', text: `load(${fixture}); w.document.getElementById('x'); w.document.getElementById('shortcuts-modal-overlay');` },
  ]);
  const code = [
    { path: 'backend/app/templates/app/partials/label_selector.html', text: '{% set selector_id = selector_id | default("label-filter") %}<input id="{{ selector_id }}-any">' },
    { path: 'backend/app/templates/app/catch_me_up.html', text: '{% with selector_id="catchup-label" %}{% include "x" %}{% endwith %}<nav class="sm:hidden"></nav>' },
    { path: 'backend/app/templates/app/partials/shortcuts.html', text: '<div id="shortcuts-modal-overlay" class="hidden">' },
  ];
  const kept = dropTestLocal(found, [{ path: 'tests/js/k.test.mjs', text: fixture }], code);
  assert.deepEqual(kept.map((e) => e.item), ['catchup-label-any', 'sm:hidden', 'shortcuts-modal-overlay']);
  const listed = contract([['catchup-label-any', 'id'], ['sm:hidden', 'class'], ['shortcuts-modal-overlay', 'id']]);
  assert.deepEqual(verify(listed, kept, { rendered: [], code }), { missing: [], unused: [], unrendered: [] });
  // Without the template that renders it, the overlay id is reported, not silently kept.
  assert.deepEqual(verify(listed, kept, { rendered: [], code: code.slice(0, 2) }).unrendered, [{ item: 'shortcuts-modal-overlay', kind: 'id' }]);
});
