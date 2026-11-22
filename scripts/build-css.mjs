// Stable minified Tailwind build (plan s2-T39, amendment 27).
//
// Tailwind 4.3.5's plain output is the same in every process, but its lightningcss minify
// pass gives a different result in about 2-3% of fresh processes (the same result within
// one process). The minority outputs only lose or merge declarations, so the majority
// output is the complete one. This wrapper runs `tailwindcss --minify` as separate
// processes (RUNS per round), accepts the output only when every run of a round is
// byte-identical, retries up to ROUNDS rounds and then fails loudly. Before writing it
// checks the rules known to go missing (FRAGILE_RULES). `out` is written atomically and
// only after every check, so a failed build leaves the previous file untouched.
//
// CLI:    node scripts/build-css.mjs -i input.css -o backend/app/static/css/tailwind.css
//         (`-i -` reads the input CSS from stdin; paths resolve against the working dir)
// Module: buildCss({ input, stdin, out, cwd, check, runs, rounds, bin, run }) -> css string
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TAILWIND_BIN = join(REPO, 'node_modules', '.bin', 'tailwindcss');
export const RUNS = 3;
export const ROUNDS = 5;

// Whole minified rules (selector + block) as the complete build emits them. Each must
// start right after a `}` or `{`, so a rule is not satisfied by the tail of a longer
// selector list (the s2-T38 combined override ends with the `.select` selector).
export const FRAGILE_RULES = [
  { name: 'command aria-hidden item', rule: '.command [role=menuitem][aria-hidden=true]{display:none}' },
  { name: 'dropdown-menu aria-hidden item', rule: '.dropdown-menu :is([role=menuitem],[role=menuitemcheckbox],[role=menuitemradio])[aria-hidden=true]{display:none}' },
  { name: 'select aria-hidden option', rule: '.select:not(select) [role=option][aria-hidden=true]{display:none}' },
  { name: 'aria-hidden override (s2-T38)', rule: '.command [role=menuitem][aria-hidden=true],.dropdown-menu :is([role=menuitem],[role=menuitemcheckbox],[role=menuitemradio])[aria-hidden=true],.select:not(select) [role=option][aria-hidden=true]{display:none}' },
  { name: 'dark outline button border', rule: '.btn[data-variant=outline]:is(.dark *){border-color:var(--color-input);background-color:var(--color-input)}' },
  { name: 'tabs tab svg pointer-events', rule: '.tabs>[role=tablist]>[role=tab] svg{pointer-events:none;flex-shrink:0}' },
  { name: 'sidebar item truncate', rule: ':is(.sidebar>nav>section ul li>a,.sidebar>nav>section ul li>button,.sidebar>nav>section ul li>details>summary)>span:last-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}' },
];

// Names of the fragile rules missing from `css`.
export function missingRules(css, rules = FRAGILE_RULES) {
  return rules.filter(({ rule }) => !(css.startsWith(rule) || css.includes('}' + rule) || css.includes('{' + rule))).map((r) => r.name);
}

const md5 = (s) => createHash('md5').update(s).digest('hex');

// One `tailwindcss --minify` process; returns the output CSS.
function tailwindRun({ bin, input, stdin, cwd, scratch, index }) {
  const out = join(scratch, `run-${index}.css`);
  const [cmd, ...pre] = Array.isArray(bin) ? bin : [bin];
  execFileSync(cmd, [...pre, '-i', input, '-o', out, '--minify'], {
    cwd,
    input: stdin,
    stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return readFileSync(out, 'utf8');
}

export function buildCss({
  input = 'input.css',
  stdin,
  out,
  cwd = REPO,
  check = true,
  runs = RUNS,
  rounds = ROUNDS,
  bin = TAILWIND_BIN,
  run = tailwindRun,
} = {}) {
  if (stdin !== undefined && input !== '-') throw new Error('build-css: stdin needs input "-"');
  if (runs < 2) throw new Error('build-css: at least two runs are needed to compare');
  const scratch = mkdtempSync(join(tmpdir(), 'build-css-'));
  const seen = [];
  let css;
  try {
    for (let round = 1; round <= rounds && css === undefined; round++) {
      const outputs = [];
      for (let i = 0; i < runs; i++) outputs.push(run({ bin, input, stdin, cwd, scratch, index: (round - 1) * runs + i, round }));
      const sums = outputs.map(md5);
      seen.push(sums.map((s) => s.slice(0, 8)).join(' '));
      if (sums.every((s) => s === sums[0])) css = outputs[0];
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (css === undefined) {
    throw new Error(`build-css: the ${runs} minified builds disagreed in all ${rounds} rounds (md5 per round: ${seen.join(' | ')})`);
  }
  if (check) {
    const missing = missingRules(css, check === true ? FRAGILE_RULES : check);
    if (missing.length) throw new Error(`build-css: the agreed build lacks fragile rules: ${missing.join(', ')}`);
  }
  if (out !== undefined) {
    const target = resolve(cwd, out);
    const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
    writeFileSync(tmp, css);
    renameSync(tmp, target);
  }
  return css;
}

function parseArgs(argv) {
  const args = { input: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i' || a === '--input') args.input = argv[++i];
    else if (a === '-o' || a === '--output') args.out = argv[++i];
    else throw new Error(`build-css: unknown argument ${a}`);
  }
  if (!args.input || !args.out) throw new Error('usage: node scripts/build-css.mjs -i <input.css|-> -o <output.css>');
  return args;
}

function main(argv) {
  const { input, out } = parseArgs(argv);
  const cwd = process.cwd();
  const stdin = input === '-' ? readFileSync(0, 'utf8') : undefined;
  const css = buildCss({ input: input === '-' ? '-' : resolve(cwd, input), stdin, out: resolve(cwd, out), cwd });
  process.stderr.write(`build-css: ${out} (${css.length} bytes, md5 ${md5(css)})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // execFileSync's message already carries the failed process's stderr.
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
