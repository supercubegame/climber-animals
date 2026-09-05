#!/usr/bin/env node
// V4 browser gate adapter. The shared browser scenario predates the V4 camera
// contract, so patch only its test ruler at runtime and keep the shipped gate
// source readable. The product still owns the real clamp in the shell/core.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tools = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(tools, 'verify-browser.mjs');
const tempPath = join(tools, `.verify-browser-v4.${process.pid}.mjs`);
const source = readFileSync(sourcePath, 'utf8');
const oldRuler = 'const PITCH_MIN = 0.02, PITCH_MAX = 1.15;';
const newRuler = 'const PITCH_MIN = -0.55, PITCH_MAX = 1.30;';
if (!source.includes(oldRuler)) {
  console.error('V4 browser gate refused to run: legacy pitch ruler is missing, so the adapter may be stale.');
  process.exit(2);
}
writeFileSync(tempPath, source.replace(oldRuler, newRuler));
try {
  const result = spawnSync(process.execPath, [tempPath, ...process.argv.slice(2)], {
    cwd: join(tools, '..'), stdio: 'inherit',
  });
  process.exit(result.status === null ? 1 : result.status);
} finally {
  try { unlinkSync(tempPath); } catch {}
}
