// Offline drift: templates.js draws what the server's partials draw.
//
// The JS half of the drift harness (the server half and the full story are in
// backend/tests/test_offline_drift.py). Each case in offline-drift/adapters.mjs is
// rendered by the real templates.js, loaded in a vm context as the service worker
// loads it, normalised exactly as normalise() in the Python half does and compared
// with the fixture the Python half rendered from the Jinja source.
//
// A failure here means a partial and its templates.js mirror disagree: change the
// mirror (or, for a deliberate offline-only difference, add an `allowed` entry with
// its reason to the case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { CASES } from './offline-drift/adapters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATES_JS = path.join(ROOT, 'backend', 'app', 'static', 'js', 'offline', 'templates.js');
const FIXTURE_DIR = path.join(ROOT, 'backend', 'tests', 'fixtures', 'offline_drift');

// templates.js as the service worker runs it: a plain script that hangs its API on
// `self.RFOffline`.
function loadTemplates() {
  const ctx = { URL };
  ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync(TEMPLATES_JS, 'utf8'), ctx, { filename: TEMPLATES_JS });
  return ctx.RFOffline.templates;
}

// ---- normalisation (mirrors normalise() in test_offline_drift.py) -----------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
const byName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function attrs(el) {
  return Array.from(el.attributes, (a) => {
    const name = a.name.toLowerCase();
    const value = name === 'class' ? a.value.split(/\s+/).filter(Boolean).sort().join(' ') : collapse(a.value);
    return [name, value];
  }).sort(byName).map(([n, v]) => (v ? ` ${n}="${escAttr(v)}"` : ` ${n}`)).join('');
}

// One node per line, indented by depth; see the Python docstring for the rules.
export function normalise(html) {
  const lines = [];
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = collapse(child.data);
        if (text) lines.push(pad + escText(text));
      } else if (child.nodeType === 1) {
        const name = child.localName.toLowerCase();
        lines.push(`${pad}<${name}${attrs(child)}>`);
        if (VOID.has(name)) continue;
        walk(child, depth + 1);
        lines.push(`${pad}</${name}>`);
      }
    }
  };
  walk(JSDOM.fragment(html), 0);
  return lines.length ? lines.join('\n') + '\n' : '';
}

function strip(text, allowed = []) {
  return allowed.reduce((s, a) => s.replace(new RegExp(a.pattern.source, a.pattern.flags.replace('g', '') + 'g'), ''), text);
}

// One case against its committed fixture text: both normalised, the case's allowed
// differences stripped from both.
// `unused` names the allowed entries that match neither side: a difference that is
// gone, whose entry should go too.
export function compareCase(c, T, committed) {
  const server = normalise(committed);
  const offline = normalise(c.render(T));
  const expected = strip(server, c.allowed);
  const actual = strip(offline, c.allowed);
  const hits = (a, s) => new RegExp(a.pattern.source, a.pattern.flags.replace('g', '')).test(s);
  const unused = (c.allowed || []).filter((a) => !hits(a, server) && !hits(a, offline)).map((a) => a.reason);
  return { name: c.name, ok: expected === actual, expected, actual, unused };
}

// The names of the cases whose rendering differs from their fixture.
export function driftReport(cases, T, loadFixture) {
  return cases.map((c) => compareCase(c, T, loadFixture(c.name))).filter((r) => !r.ok).map((r) => r.name);
}

const readFixture = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name + '.html'), 'utf8');
const casesJson = () => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cases.json'), 'utf8'));

// ---- tests ----------------------------------------------------------------------------

test('drift: every committed fragment matches its templates.js counterpart', async (t) => {
  const T = loadTemplates();
  await t.test('CASES equal the server-rendered entries of cases.json', () => {
    const entries = casesJson();
    assert.deepEqual(CASES.map((c) => c.name).sort(), entries.filter((e) => e.source).map((e) => e.name).sort());
    for (const c of CASES) {
      for (const a of c.allowed || []) assert.ok(a.reason && a.pattern instanceof RegExp, `${c.name}: allowed entry without a reason`);
    }
  });
  for (const c of CASES) {
    await t.test(c.name, () => {
      const file = path.join(FIXTURE_DIR, c.name + '.html');
      assert.ok(fs.existsSync(file), `missing fixture ${c.name}.html: run RF_UPDATE_GOLDENS=1 uv run pytest tests/test_offline_drift.py`);
      const committed = readFixture(c.name);
      // The two normalisers agree: the Python output is a fixed point of this one.
      assert.equal(normalise(committed), committed, `${c.name}: JS and Python normalisation disagree`);
      const r = compareCase(c, T, committed);
      assert.equal(r.actual, r.expected, `${c.name}: templates.js drifted from its source`);
      assert.deepEqual(r.unused, [], `${c.name}: allowed entries that no longer match anything`);
    });
  }
});

test('drift: a changed partial without its mirror fails', () => {
  const T = loadTemplates();
  const target = 'read_button-read';
  const committed = readFixture(target);
  assert.match(committed, /bg-blue-50/);
  // The partial gained a class (as if read_button.html changed and templates.js did not).
  const changed = committed.replace(/bg-blue-50(?= )/, 'bg-blue-100');
  assert.notEqual(changed, committed);
  // Only this case: the per-case test above covers the rest, and a case added later
  // without its fixture yet must not break this one.
  const cases = CASES.filter((c) => c.name === target);
  assert.equal(cases.length, 1);
  assert.deepEqual(driftReport(cases, T, () => changed), [target]);
  assert.deepEqual(driftReport(cases, T, readFixture), []);
});

test('drift: normalisation ignores attribute and class order only', () => {
  const base = normalise('<button id="b-1" class="a b  c" data-x title="It\'s &amp; more">\n  Go <span>now</span>\n</button>');
  // Same fragment with attributes and class tokens reordered, the boolean attribute in
  // its other form, other entity forms and other whitespace.
  assert.equal(normalise('<button title="It&#39;s &#38; more" data-x="" class="c a b" id="b-1">Go\n<span> now </span></button>'), base);
  // Anything else is a difference: a class, a value, the text, an attribute, the tag.
  for (const other of [
    '<button id="b-1" class="a b d" data-x title="It\'s &amp; more">Go <span>now</span></button>',
    '<button id="b-2" class="a b c" data-x title="It\'s &amp; more">Go <span>now</span></button>',
    '<button id="b-1" class="a b c" data-x title="It\'s &amp; more">Go <span>later</span></button>',
    '<button id="b-1" class="a b c" title="It\'s &amp; more">Go <span>now</span></button>',
    '<button id="b-1" class="a b c" data-x title="It\'s &amp; more">Go <b>now</b></button>',
  ]) assert.notEqual(normalise(other), base, other);
});
