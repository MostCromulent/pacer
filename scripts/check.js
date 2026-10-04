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
  for (const m of source.matchAll(/^import \{([^}]+)\} from '(\.[^']+)'/gm)) {
    const target = read(join(f, '..', m[2]).replace(/\\/g, '/'));
    for (const name of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      if (uses(source, name) < 2) problems.push(`${f}: imports ${name} but never uses it`);
      const exported = new RegExp(`^export (?:async )?(?:function|const|let|class) ${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'm').test(target)
        || new RegExp(`^export \\{[^}]*\\b${name}\\b[^}]*\\}`, 'm').test(target);
      if (!exported) problems.push(`${f}: imports ${name}, which ${m[2]} does not export`);
    }
  }
  for (const m of source.matchAll(/^(?:async )?function (\w+)/gm)) {
    if (uses(source, m[1]) < 2) problems.push(`${f}: function ${m[1]} is never called`);
  }
}

// A UI module that uses something another module exports must import it. (The
// browser only finds this out when the line runs.)
const exportedBy = new Map();
for (const f of [...list('src/core'), ...list('src/ui')]) {
  for (const m of read(f).matchAll(/^export (?:async )?(?:function|const|let|class) ([\w$]+)/gm)) exportedBy.set(m[1], f);
}
for (const f of list('src/ui')) {
  const source = read(f);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/^import .*$/gm, '');
  const imported = new Set([...source.matchAll(/^import \{([^}]+)\}/gm)].flatMap((m) => m[1].split(',').map((x) => x.trim())));
  for (const [name, home] of exportedBy) {
    if (home === f || imported.has(name)) continue;
    const n = name.replace(/\$/g, '\\$');
    // Declared here, a parameter, or a method of the same name.
    const local = new RegExp(`(?:function|const|let|class)\\s+${n}(?![\\w$])|[(,{]\\s*${n}\\s*[,)}=:]|\\b${n}\\s*=>|^\\s+${n}\\s*\\([^)]*\\)\\s*\\{`, 'm').test(code);
    const called = new RegExp(`(?<![\\w$.'"\`-])${n}\\s*[(.]`).test(code);
    if (called && !local) problems.push(`${f}: uses ${name} (from ${home}) without importing it`);
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
