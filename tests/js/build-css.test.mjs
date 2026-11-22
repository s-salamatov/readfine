// Unit tests for scripts/build-css.mjs (s2-T39). No real Tailwind runs: a fake binary
// (a Node script run as a separate process) or a `run` hook supplies the outputs.
// Fixtures are built from FRAGILE_RULES, so no selector literal appears here for
// scripts/check-dom-contract.mjs to read as a consumer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCss, missingRules, FRAGILE_RULES } from '../../scripts/build-css.mjs';

const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'build-css-test-')); scratch.push(d); return d; };

const COMPLETE = '@layer components{.a{color:red}' + FRAGILE_RULES.map((r) => r.rule).join('') + '.z{color:blue}}';
const byName = (name) => FRAGILE_RULES.find((r) => r.name === name);
const without = (name) => COMPLETE.replace('}' + byName(name).rule, '}');

// A `run` hook that returns the given outputs in order and records each call.
function scripted(outputs) {
  const calls = [];
  return { calls, run: (o) => { calls.push(o); if (calls.length > outputs.length) throw new Error('too many runs'); return outputs[calls.length - 1]; } };
}

// A fake tailwindcss: a Node script that writes outputs[n] to -o on its n-th start
// and records argv and stdin, so the separate-process plumbing is exercised.
function fakeBin(outputs) {
  const dir = tmp();
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(outputs));
  writeFileSync(join(dir, 'fake.mjs'), [
    "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
    'const dir = ' + JSON.stringify(dir) + ';',
    "const cnt = join('count');",
    "function join(f) { return dir + '/' + f; }",
    "const n = existsSync(cnt) ? Number(readFileSync(cnt, 'utf8')) : 0;",
    "writeFileSync(cnt, String(n + 1));",
    "const a = process.argv.slice(2);",
    "const plan = JSON.parse(readFileSync(join('plan.json'), 'utf8'));",
    "const stdin = a[a.indexOf('-i') + 1] === '-' ? readFileSync(0, 'utf8') : null;",
    "writeFileSync(join('call-' + n + '.json'), JSON.stringify({ argv: a, stdin, cwd: process.cwd() }));",
    "if (n >= plan.length) { process.stderr.write('fake: out of outputs'); process.exit(2); }",
    "writeFileSync(a[a.indexOf('-o') + 1], plan[n]);",
  ].join('\n'));
  const call = (n) => JSON.parse(readFileSync(join(dir, `call-${n}.json`), 'utf8'));
  const count = () => (existsSync(join(dir, 'count')) ? Number(readFileSync(join(dir, 'count'), 'utf8')) : 0);
  return { bin: [process.execPath, join(dir, 'fake.mjs')], call, count, dir };
}

test('build-css: the complete fixture has every fragile rule', () => {
  assert.deepEqual(missingRules(COMPLETE), []);
  assert.ok(FRAGILE_RULES.length >= 6);
});

test('build-css: a rule only present as the tail of a longer selector list is missing', () => {
  // The s2-T38 combined override ends with the .select option selector; dropping the
  // standalone rule must still count as missing.
  const name = 'select aria-hidden option';
  const css = without(name);
  assert.ok(css.includes(byName(name).rule), 'still present inside the combined override');
  assert.deepEqual(missingRules(css), [name]);
});

test('build-css: agreeing complete runs are written, through separate processes', () => {
  const fake = fakeBin([COMPLETE, COMPLETE, COMPLETE]);
  const dir = tmp();
  const out = join(dir, 'tw.css');
  const css = buildCss({ bin: fake.bin, cwd: dir, out });
  assert.equal(css, COMPLETE);
  assert.equal(readFileSync(out, 'utf8'), COMPLETE);
  assert.equal(fake.count(), 3);
  const outs = new Set([0, 1, 2].map((n) => fake.call(n).argv));
  for (const argv of outs) {
    assert.deepEqual(argv.slice(0, 2), ['-i', 'input.css']);
    assert.ok(argv.includes('--minify'));
    assert.notEqual(argv[argv.indexOf('-o') + 1], out, 'each run writes to scratch, not to out');
  }
  assert.equal(fake.call(0).cwd, dir);
});

test('build-css: stdin input is piped to every process', () => {
  const fake = fakeBin([COMPLETE, COMPLETE, COMPLETE]);
  const css = buildCss({ bin: fake.bin, cwd: tmp(), input: '-', stdin: '@import "tailwindcss";' });
  assert.equal(css, COMPLETE);
  for (const n of [0, 1, 2]) {
    assert.equal(fake.call(n).argv[1], '-');
    assert.equal(fake.call(n).stdin, '@import "tailwindcss";');
  }
  assert.throws(() => buildCss({ bin: fake.bin, stdin: 'x' }), /stdin needs input "-"/);
});

test('build-css: a disagreeing round is retried', () => {
  const short = without('tabs tab svg pointer-events');
  const fake = fakeBin([COMPLETE, short, COMPLETE, COMPLETE, COMPLETE, COMPLETE]);
  const dir = tmp();
  const out = join(dir, 'tw.css');
  assert.equal(buildCss({ bin: fake.bin, cwd: dir, out }), COMPLETE);
  assert.equal(fake.count(), 6);
  assert.equal(readFileSync(out, 'utf8'), COMPLETE);
});

test('build-css: disagreement in every round fails and leaves out untouched', () => {
  const short = without('dark outline button border');
  const s = scripted(Array.from({ length: 5 }, () => [COMPLETE, COMPLETE, short]).flat());
  const dir = tmp();
  const out = join(dir, 'tw.css');
  writeFileSync(out, 'previous');
  assert.throws(() => buildCss({ run: s.run, cwd: dir, out }), /disagreed in all 5 rounds/);
  assert.equal(s.calls.length, 15);
  assert.equal(readFileSync(out, 'utf8'), 'previous');
  // Each round uses fresh run indexes (fresh scratch outputs).
  assert.equal(new Set(s.calls.map((c) => c.index)).size, 15);
});

test('build-css: an agreed build missing a fragile rule fails and leaves out untouched', () => {
  for (const { name } of FRAGILE_RULES) {
    const short = without(name);
    const s = scripted([short, short, short]);
    const dir = tmp();
    const out = join(dir, 'tw.css');
    writeFileSync(out, 'previous');
    assert.throws(() => buildCss({ run: s.run, cwd: dir, out }), new RegExp(`lacks fragile rules: ${name.replace(/[()]/g, '\\$&')}$`));
    assert.equal(readFileSync(out, 'utf8'), 'previous');
  }
});

test('build-css: check:false accepts a build without the fragile rules (Basecoat-free baseline)', () => {
  const s = scripted(['.a{color:red}', '.a{color:red}', '.a{color:red}']);
  assert.equal(buildCss({ run: s.run, check: false }), '.a{color:red}');
});

test('build-css: a failing tailwind process fails the build', () => {
  const fake = fakeBin([COMPLETE]);
  const dir = tmp();
  const out = join(dir, 'tw.css');
  assert.throws(() => buildCss({ bin: fake.bin, cwd: dir, out }));
  assert.equal(existsSync(out), false);
});
