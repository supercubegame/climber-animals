// Generates the shipped single file climber-animals.html by inlining the pure
// core into src/shell/template.html.
//
// Why inline instead of `import`: the deliverable must run by double-clicking on
// Windows 11, i.e. over file://, where ES module imports are blocked by CORS and
// a CDN <script> would need internet. So the HTML holds a COPY of the core.
//
// A copy is exactly the thing that goes green while the truth drifts, so
// `--check` rebuilds and byte-compares. There is no "close enough" here.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_FILE = join(ROOT, 'climber-animals.html');
export const TEMPLATE = join(ROOT, 'src/shell/template.html');
export const MARKER = '/* @INLINE:CORE */';

// Explicit and ordered. reach.mjs is verification-only and must NOT reach the
// shipped file; the player should never download the test harness.
export const INLINE_ORDER = ['rng.mjs', 'constants.mjs', 'camera.mjs', 'animal.mjs', 'level.mjs', 'player.mjs'];

function stripModuleSyntax(src, name) {
  // Multi-line imports exist in level.mjs / player.mjs, hence [\s\S] not .
  let out = src.replace(/^import\s[\s\S]*?;[ \t]*\r?\n/gm, '');
  out = out.replace(/^export\s+/gm, '');
  if (/\bimport\s/.test(out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))) {
    throw new Error(`${name}: an import survived stripping (namespace import?)`);
  }
  if (/^export\s/m.test(out)) throw new Error(`${name}: an export survived stripping`);
  return out.trim();
}

export function buildHtml() {
  const tpl = readFileSync(TEMPLATE, 'utf8');
  if (!tpl.includes(MARKER)) throw new Error(`template is missing ${MARKER}`);
  const parts = INLINE_ORDER.map((f) => {
    const src = readFileSync(join(ROOT, 'src/core', f), 'utf8');
    return `// ---- src/core/${f} ----\n${stripModuleSyntax(src, f)}`;
  });
  return tpl.replace(MARKER, parts.join('\n\n'));
}

const isCheck = process.argv.includes('--check');
const html = buildHtml();

if (isCheck) {
  let current = '';
  try { current = readFileSync(OUT_FILE, 'utf8'); } catch { current = ''; }
  if (current === html) {
    console.log(`build:check OK (${html.length} bytes)`);
    process.exit(0);
  }
  console.error('build:check STALE — climber-animals.html does not match src/.');
  console.error(`  committed: ${current.length} bytes, rebuilt: ${html.length} bytes`);
  console.error('  fix: node tools/build.mjs && commit the result');
  process.exit(1);
} else {
  writeFileSync(OUT_FILE, html);
  console.log(`built climber-animals.html (${html.length} bytes)`);
}
