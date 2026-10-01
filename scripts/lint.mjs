import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'data']);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = collect(root);
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const relative = path.relative(root, file);
  if (result.status === 0) {
    console.log(`ok   ${relative}`);
  } else {
    failed += 1;
    console.error(`FAIL ${relative}\n${(result.stderr || '').trim()}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} files parsed`);
process.exit(failed ? 1 : 0);