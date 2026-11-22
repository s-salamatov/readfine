import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, colourHits } from '../../scripts/check-colours.mjs';

const T = 'backend/app/templates';
const JS = 'backend/app/static/js';

test('colours: literal in CSS, style attribute, arbitrary class and JS string is reported', () => {
  const hits = colourHits([
    { path: 'input.css', text: '.a {\n  color: #1f2937;\n}\n' },
    { path: `${T}/x.html`, text: '<div style="background: rgba(0, 0, 0, .5)">x</div>' },
    { path: `${T}/y.html`, text: '<ul class="divide-y divide-[#ecedf1]"></ul>' },
    { path: `${JS}/z.js`, text: "var c = 'oklch(0.7 0.1 250)';" },
  ]);
  assert.deepEqual(hits, [
    { path: 'input.css', line: 2, literal: '#1f2937' },
    { path: `${T}/x.html`, line: 1, literal: 'rgba(' },
    { path: `${T}/y.html`, line: 1, literal: '#ecedf1' },
    { path: `${JS}/z.js`, line: 1, literal: 'oklch(' },
  ]);
});

test('colours: entities, id references and allowed paths are not reported', () => {
  const html = [
    '<p>it&#39;s &#123; &#x1F;</p>',
    '<a href="#top">top</a> <a href="#add">add</a>',
    '<button hx-target="#feed" hx-select="#bad" hx-include="#cafe" hx-indicator="#dead">x</button>',
    '<label for="abc">x</label><label for="#abc">y</label>',
    '<div class="x" data-x="#feed-list"></div>',
    '{# a comment about #fff and rgb(1,2,3) #}',
    '<script>document.querySelector(\'#add\'); el.closest("#bad"); el.matches(`#fade`);',
    'document.getElementById("#abc"); document.querySelectorAll(\'#ace, #bed\');',
    "if (location.hash === '#ace') {}</script>",
  ].join('\n');
  assert.deepEqual(colourHits([{ path: `${T}/page.html`, text: html }]), []);
  assert.deepEqual(colourHits([{ path: `${T}/email/x.html`, text: '<td style="color:#333">x</td>' }]), []);
});

test('colours: only the four Q2 exceptions are allowed', () => {
  assert.equal(ALLOW.length, 4);
  for (const entry of ALLOW) assert.ok(entry.reason, `${JSON.stringify(entry)} has a reason`);
  const css = ':root { --background: #fff; }';
  assert.deepEqual(colourHits([{ path: 'styles/tokens.css', text: css }]), []);
  assert.equal(colourHits([{ path: 'input.css', text: css }]).length, 1);
  assert.equal(colourHits([{ path: `${JS}/offline/launch.js`, text: "var b = '#141414';" }]).length, 0);
  assert.equal(colourHits([{ path: `${T}/landing.example.html`, text: '<p style="color:#123456">x</p>' }]).length, 1);
  assert.equal(colourHits([{ path: `${T}/settings/labels.html`, text: '<span data-color="#6366f1"></span>' }]).length, 1);
  const templates = [
    "  function labelDot() { return '<i style=\"background:#6366f1\"></i>'; }",
    '  function offlinePage(url) {',
    "    var x = '{'; // a brace in a string does not end the function",
    "    return '<style>body{background:#141414;color:#e5e5e5}</style><p>it\\'s</p>';",
    '  }',
    "  var after = 'rgb(1, 2, 3)';",
  ].join('\n');
  assert.deepEqual(colourHits([{ path: `${JS}/offline/templates.js`, text: templates }]), [
    { path: `${JS}/offline/templates.js`, line: 1, literal: '#6366f1' },
    { path: `${JS}/offline/templates.js`, line: 6, literal: 'rgb(' },
  ]);
});
