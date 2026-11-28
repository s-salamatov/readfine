// The CSS half of the motion layer (motion design §6.3, §6.4.2, §6.6, §6.11): the motion
// tokens in styles/tokens.css, and styles/motion.css's view-transition cap, the
// cross-document transition, the closing-overlay rules and the reduced-motion reset.
// Read as text and parsed into flat rules, so nothing here builds or touches the
// committed tailwind.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (s) => s.trim().replace(/\s+/g, ' ');

// Every block that holds declarations becomes {media, selectors, declarations}: media is
// the stack of enclosing at-rule preludes, selectors the comma-split prelude (an at-rule
// with declarations, such as @view-transition, keeps its prelude as the one selector),
// declarations a property → value map ("!important" kept in the value).
function parseRules(source) {
  const css = stripComments(source);
  const rules = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") { i = css.indexOf(c, i + 1); continue; }
    if (c === '{') {
      stack.push({ prelude: squash(css.slice(start, i)), hasChild: false });
      if (stack.length > 1) stack[stack.length - 2].hasChild = true;
      start = i + 1;
    } else if (c === '}') {
      const node = stack.pop();
      const body = css.slice(start, i);
      if (node && !node.hasChild && body.trim()) {
        const declarations = {};
        for (const part of body.split(';')) {
          const at = part.indexOf(':');
          if (at > 0) declarations[squash(part.slice(0, at))] = squash(part.slice(at + 1));
        }
        const selectors = node.prelude.startsWith('@')
          ? [node.prelude]
          : splitSelectors(node.prelude);
        rules.push({ media: stack.map((s) => s.prelude), selectors, declarations });
      }
      start = i + 1;
    }
  }
  return rules;
}

// Splits on top-level commas only (":is(a, b)" stays whole).
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(squash(cur)); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(squash(cur));
  return out;
}

const REDUCED = /prefers-reduced-motion:\s*reduce/;
const NO_PREF = /prefers-reduced-motion:\s*no-preference/;
const isReduced = (r) => r.media.some((m) => REDUCED.test(m));
const motionRules = () => parseRules(read('styles', 'motion.css'));
const inputRules = () => parseRules(read('input.css'));
// The rules that list this exact selector, merged in source order.
function declsFor(rules, selector, pick = () => true) {
  const out = {};
  for (const r of rules) if (pick(r) && r.selectors.includes(selector)) Object.assign(out, r.declarations);
  return out;
}

const OVERLAYS = ['[data-motion]', '.toast', '[data-popover]', '.dialog', '.drawer', '.command-dialog'];
const COMPONENTS = ['.dialog', '.alert-dialog', '.command-dialog', '.drawer', '[data-popover]', '.toaster .toast',
  '.sidebar', '.tabs', '.switch', '.btn', '#sidebar', '#mobile-sidebar-backdrop'];
// Basecoat transitions that `.x *` does not reach: the switch is an input[role=switch]
// (templates/ui/forms.html) with its thumb on ::before; a tab's underline is its ::after.
const OWN_TRANSITIONS = ['input[role=switch]', 'input[role=switch]::before',
  ".tabs > [role='tablist'] > [role='tab']::after"];

test('motion css: no reduced-motion rule sets transition none on overlays or [data-motion]', () => {
  for (const [name, rules] of [['styles/motion.css', motionRules()], ['input.css', inputRules()]]) {
    for (const r of rules.filter(isReduced)) {
      for (const sel of r.selectors) {
        if (!OVERLAYS.some((o) => sel.includes(o))) continue;
        for (const [prop, value] of Object.entries(r.declarations)) {
          if (prop !== 'transition' && prop !== 'transition-property') continue;
          assert.ok(!/^none\b/.test(value), `${name}: ${sel} { ${prop}: ${value} } under reduced motion`);
        }
      }
    }
  }
  const reduced = motionRules().filter(isReduced);
  assert.deepEqual(declsFor(reduced, '[data-motion]'), {
    animation: 'none !important',
    'transition-duration': '0.01ms !important',
    'transition-delay': '0s !important',
  });
  assert.deepEqual(declsFor(reduced, '.rf-flash'), {
    animation: 'none !important',
    transition: 'none !important',
  });
});

test('motion css: Basecoat components and shell get 0.01 ms under reduced motion, descendants keep their animations', () => {
  const reduced = motionRules().filter(isReduced);
  for (const c of COMPONENTS) {
    for (const sel of [c, `${c} *`, `${c}::backdrop`]) {
      assert.equal(declsFor(reduced, sel)['transition-duration'], '0.01ms !important', `${sel} transition-duration`);
    }
    const own = declsFor(reduced, c);
    assert.ok(own['animation-duration'] === '0.01ms !important' || /^none\b/.test(own.animation ?? ''),
      `${c} animation-duration`);
    if (own['animation-duration']) assert.equal(own['animation-iteration-count'], '1 !important', `${c} iteration count`);
  }
  for (const sel of OWN_TRANSITIONS) {
    assert.equal(declsFor(reduced, sel)['transition-duration'], '0.01ms !important', `${sel} transition-duration`);
  }
  for (const r of reduced) {
    for (const sel of r.selectors) {
      assert.ok(!/^html\b|^:root\b/.test(sel), `reduced-motion rule on ${sel}`);
      if (!/ \*$|::(backdrop|before|after)$/.test(sel)) continue;
      const anim = Object.keys(r.declarations).filter((p) => p.startsWith('animation'));
      assert.deepEqual(anim, [], `${sel} must keep its animations (spinners)`);
    }
  }
});

test('motion css: the cross-document transition is declared only under no-preference and capped', () => {
  const all = [...motionRules(), ...inputRules()];
  const vt = all.filter((r) => r.selectors.includes('@view-transition'));
  assert.equal(vt.length, 1, 'one @view-transition');
  assert.ok(vt[0].media.some((m) => NO_PREF.test(m)), `@view-transition inside ${JSON.stringify(vt[0].media)}`);
  assert.ok(!vt[0].media.some((m) => REDUCED.test(m)));
  assert.equal(vt[0].declarations.navigation, 'auto');
  const rules = motionRules();
  for (const sel of ['::view-transition-group(*)', '::view-transition-old(*)', '::view-transition-new(*)']) {
    assert.equal(declsFor(rules, sel, (r) => r.media.length === 0)['animation-duration'], 'var(--t-fast-max)', sel);
  }
  const noPref = (r) => r.media.some((m) => NO_PREF.test(m));
  assert.equal(declsFor(rules, '#sidebar', noPref)['view-transition-name'], 'rf-sidebar');
  assert.equal(declsFor(rules, '#tab-bar', noPref)['view-transition-name'], 'rf-tab-bar');
  for (const r of all.filter((x) => 'view-transition-name' in x.declarations)) {
    assert.ok(noPref(r), `view-transition-name on ${r.selectors.join(', ')} inside ${JSON.stringify(r.media)}`);
  }
});

test('motion css: closing overlays stop catching the pointer at once and exit on tokens', () => {
  const src = read('styles', 'motion.css');
  const LIST = ":is(.dialog, .alert-dialog, .command-dialog, .drawer):not([open]), .drawer[data-closing], [data-popover][aria-hidden='true'], .toaster .toast[aria-hidden='true'] { pointer-events: none; }";
  assert.ok(src.includes(LIST), 'the pointer-events rule, verbatim');
  const rules = parseRules(src);
  for (const sel of [':is(.dialog, .alert-dialog, .command-dialog, .drawer):not([open])', '.drawer[data-closing]',
    "[data-popover][aria-hidden='true']", ".toaster .toast[aria-hidden='true']"]) {
    assert.equal(declsFor(rules, sel, (r) => r.media.length === 0)['pointer-events'], 'none', `${sel} at top level`);
  }
  const plain = rules.filter((r) => !isReduced(r));
  for (const sel of ['.dialog:not([open])', '.alert-dialog:not([open])', '.command-dialog:not([open])',
    "[data-popover][aria-hidden='true']"]) {
    const d = declsFor(plain, sel);
    assert.equal(d['transition-duration'], 'var(--t-fast)', `${sel} exit duration`);
    assert.equal(d['transition-timing-function'], 'var(--rf-ease-in)', `${sel} exit easing`);
  }
  assert.equal(declsFor(plain, ".toaster .toast[aria-hidden='true']")['transition-duration'], 'var(--t-fast-max)');
  for (const r of plain) {
    for (const [prop, value] of Object.entries(r.declarations)) {
      assert.ok(!/(^|[^\w.-])\d*\.?\d+m?s\b/.test(value), `${r.selectors.join(', ')} { ${prop}: ${value} }: a time literal outside the reduced block`);
    }
  }
});

test('motion tokens: new motion tokens exist, durations unchanged, the dead folder flash is gone', () => {
  const tokens = read('styles', 'tokens.css');
  const root = declsFor(parseRules(tokens), ':root');
  const expected = {
    '--t-fast': '125ms', '--t-fast-max': '165ms', '--t-med': '300ms', '--t-med-max': '400ms', '--t-slow': '700ms',
    '--rf-ease-standard': 'cubic-bezier(0.2, 0, 0, 1)', '--rf-ease-out': 'cubic-bezier(0, 0, 0.2, 1)',
    '--rf-ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
    '--rf-stagger-step': '20ms', '--rf-stagger-max': '10', '--rf-ease-overshoot': 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(root[name], value, name);
  assert.ok(!stripComments(tokens).includes('--t-press'), 'no --t-press');
  const input = read('input.css');
  assert.ok(!input.includes('folder-just-moved'), '.folder-just-moved removed');
  assert.equal(declsFor(parseRules(input), '.row-just-saved').animation, 'row-just-saved 2s ease-out', '.row-just-saved kept');
  assert.ok(read('styles', 'motion.css').includes('.row-just-saved'), 'motion.css names the .row-just-saved exception');
});
