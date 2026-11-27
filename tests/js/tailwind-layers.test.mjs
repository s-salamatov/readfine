// Inline <style> blocks and the offline mirror keep the v3 cascade order by sitting in @layer utilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', 'app');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');

test('layers: inline <style> blocks and the offline mirror sit in @layer utilities', () => {
  for (const f of [['templates', 'base.html'], ['templates', 'app', 'partials', 'sidebar.html']]) {
    const m = read(...f).match(/<style>\s*(\S[^\n]*)/);
    assert.ok(m, `${f.join('/')}: no <style>`);
    assert.ok(m[1].startsWith('@layer utilities {'), `${f.join('/')}: starts with ${m[1]}`);
  }
  const js = read('static', 'js', 'offline', 'templates.js');
  assert.ok(/var SIDEBAR_STYLE = '<style>@layer utilities\{'/.test(js), 'SIDEBAR_STYLE must start with <style>@layer utilities{');
});

// An unlayered rule beats every utility class on the same element whatever its specificity.
test('layers: Sources and Assistant rules sit in @layer utilities', () => {
  const css = fs.readFileSync(path.join(APP, '..', '..', 'input.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = [];
  const found = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") { i = css.indexOf(c, i + 1); continue; }
    if (c === '{') {
      const prelude = css.slice(start, i).trim().replace(/\s+/g, ' ');
      if (/\.rf-(sources|assistant)-/.test(prelude)) {
        found.push(prelude);
        assert.ok(stack.includes('@layer utilities'), `unlayered: ${prelude} (inside ${JSON.stringify(stack)})`);
      }
      stack.push(prelude);
      start = i + 1;
    } else if (c === '}') {
      stack.pop();
      start = i + 1;
    } else if (c === ';') {
      start = i + 1;
    }
  }
  assert.equal(stack.length, 0, 'balanced braces');
  assert.ok(found.length >= 20, `found ${found.length} Sources/Assistant rules`);
});

// v4's -translate-y-1/2 centres the sidebar buttons with the separate `translate` property,
// so a spin keyframe that also translates would offset them a second time while spinning.
test('layers: spin keyframes carry no translate', () => {
  for (const f of [['templates', 'app', 'partials', 'sidebar.html'], ['static', 'js', 'offline', 'templates.js']]) {
    const text = read(...f);
    const frames = [];
    const re = /@keyframes\s+(spin-[\w-]+)\s*\{/g;
    let m;
    while ((m = re.exec(text))) {
      let depth = 1;
      let i = re.lastIndex;
      while (depth && i < text.length) depth += { '{': 1, '}': -1 }[text[i++]] || 0;
      frames.push({ name: m[1], body: text.slice(re.lastIndex, i - 1) });
    }
    assert.ok(frames.length >= 1, `${f.join('/')}: no spin keyframes`);
    for (const k of frames) assert.ok(!/translate/.test(k.body), `${f.join('/')}: @keyframes ${k.name} has ${k.body.trim()}`);
  }
});
