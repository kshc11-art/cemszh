/** 문법 검사 — 외부 JS 전부 + index.html 인라인 스크립트 전부 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { spawnSync } from 'node:child_process';

/* ESM 문법 검사에는 --experimental-vm-modules 가 필요하다.
   플래그 없이 실행됐으면 스스로 붙여서 한 번 더 실행한다. */
if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath,
    ['--experimental-vm-modules', '--no-warnings', ...process.argv.slice(1)],
    { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const DIR = process.argv[2] || path.resolve('..');
let errors = 0, checked = 0;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'harness' || e.name === 'out') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

for (const f of walk(DIR)) {
  const src = fs.readFileSync(f, 'utf8');
  const isModule = f.endsWith('.mjs') || /^\s*(import|export)\s/m.test(src);
  try {
    if (isModule) new vm.SourceTextModule(src, { identifier: f });
    else new vm.Script(src, { filename: f });
    checked++;
  } catch (e) {
    errors++; console.log(`FAIL ${path.relative(DIR, f)}\n     ${e.message.split('\n')[0]}`);
  }
}

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0;
while ((m = re.exec(html))) {
  i++;
  const body = m[1];
  const line = html.slice(0, m.index).split('\n').length;
  try { new vm.Script(body, { filename: `index.html#inline${i}@L${line}` }); checked++; }
  catch (e) { errors++; console.log(`FAIL index.html 인라인#${i} (L${line})\n     ${e.message.split('\n')[0]}`); }
}

console.log(`\n문법 검사: ${checked}개 통과, ${errors}개 실패 (인라인 ${i}개 포함)`);
process.exit(errors ? 1 : 0);
