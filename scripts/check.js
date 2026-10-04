// A small lint, in keeping with the project having no dependencies.
//   node scripts/check.js
//
// It fails on: a file that doesn't parse, an import that is never used, a
// top-level function that is never called, and an element id that the page
// script looks up but index.html doesn't have.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const list = (dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);
const files = [...list('src/core'), ...list('src/ui'), ...list('scripts'), ...list('test')];
const read = (f) => readFileSync(join(root, f), 'utf8');
const uses = (source, name) => (source.match(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) || []).length;

const problems = [];

for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${f}: does not parse\n${String(err.stderr).trim()}`);
    continue;
  }
  const source = read(f);
  for (const m of source.matchAll(/^import \{([^}]+)\} from/gm)) {
    for (const name of m[1].split(',').map((x) => x.trim().split(' as ').pop()).filter(Boolean)) {
      if (uses(source, name) < 2) problems.push(`${f}: imports ${name} but never uses it`);
    }
  }
  for (const m of source.matchAll(/^(?:async )?function (\w+)/gm)) {
    if (uses(source, m[1]) < 2) problems.push(`${f}: function ${m[1]} is never called`);
  }
}

// Every id the UI asks for by name must exist, in the page or in markup the UI builds.
const markup = read('index.html') + list('src/ui').map(read).join('\n');
const ids = new Set([...markup.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
for (const f of list('src/ui')) {
  for (const m of read(f).matchAll(/\$\('([\w-]+)'\)/g)) {
    if (!ids.has(m[1])) problems.push(`${f}: looks up #${m[1]}, which index.html does not have`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`${files.length} files checked, no problems`);
