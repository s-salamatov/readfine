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
