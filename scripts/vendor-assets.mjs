// Copies the vendored front-end files (Basecoat JS, anime.js, fonts and their
// licences) from node_modules into backend/app/static, byte for byte.
//
// The copies are committed: the app serves them as plain static files and the
// offline shell discovers them through static <script src> tags and CSS url().
// This script is their only producer; `npm run build` runs it before Tailwind,
// and CI fails when the committed copies differ from a fresh run.
//
// Usage: node scripts/vendor-assets.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASECOAT = ['basecoat', 'dropdown-menu', 'popover', 'tabs', 'select', 'command', 'sidebar', 'drawer', 'toast'];
const FONT_FAMILIES = [
  { pkg: '@fontsource-variable/geist', family: 'geist' },
  { pkg: '@fontsource-variable/source-serif-4', family: 'source-serif-4' },
];

// `from` is relative to node_modules, `to` to backend/app/static.
export const VENDOR = [
  ...BASECOAT.map((name) => ({
    from: `basecoat-css/dist/js/${name}.min.js`,
    to: `js/vendor/basecoat/${name}.min.js`,
  })),
  { from: 'basecoat-css/LICENSE.md', to: 'js/vendor/basecoat/LICENSE.md' },
  { from: 'animejs/dist/bundles/anime.umd.min.js', to: 'js/vendor/anime/anime.umd.min.js' },
  { from: 'animejs/LICENSE.md', to: 'js/vendor/anime/LICENSE.md' },
  ...FONT_FAMILIES.flatMap(({ pkg, family }) => [
    ...['normal', 'italic'].map((style) => ({
      from: `${pkg}/files/${family}-latin-wght-${style}.woff2`,
      to: `fonts/${family}-latin-wght-${style}.woff2`,
    })),
    { from: `${pkg}/LICENSE`, to: `fonts/OFL-${family}.txt` },
  ]),
];

// Directories this script owns outright: anything in them that is not in
// VENDOR is stale and removed. js/vendor itself is not owned (minisearch.js
// lives there and is maintained by hand).
const OWNED_DIRS = ['js/vendor/basecoat', 'js/vendor/anime', 'fonts'];

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

export class MissingSourceError extends Error {
  constructor(path) {
    super(`vendor: missing source ${path} (run npm ci)`);
    this.path = path;
  }
}

/**
 * Copy every VENDOR entry under `root` (the repository root) and remove stale
 * files from the owned directories.
 * @param {string} root
 * @returns {{ copied: number, bytes: number }}
 */
export function vendor(root) {
  const modules = join(root, 'node_modules');
  const staticDir = join(root, 'backend', 'app', 'static');

  // Check every source before writing anything, so a missing package leaves
  // the committed copies untouched.
  for (const { from } of VENDOR) {
    const src = join(modules, from);
    if (!existsSync(src)) throw new MissingSourceError(src);
  }

  let bytes = 0;
  for (const { from, to } of VENDOR) {
    const dst = join(staticDir, to);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(modules, from), dst);
    bytes += statSync(dst).size;
  }

  const wanted = new Set(VENDOR.map(({ to }) => to));
  for (const dir of OWNED_DIRS) {
    for (const path of listFiles(join(staticDir, dir))) {
      const rel = relative(staticDir, path).split(sep).join('/');
      if (!wanted.has(rel)) rmSync(path);
    }
  }

  return { copied: VENDOR.length, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const { copied, bytes } = vendor(root);
    console.log(`vendor: ${copied} files, ${bytes} B`);
  } catch (err) {
    if (err instanceof MissingSourceError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
