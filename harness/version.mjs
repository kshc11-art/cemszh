/**
 * CEMS 버전 표시 회귀 테스트
 *
 * 화면에 보이는 버전 문자열을 쓰는 모듈이 여섯이었고 각자 자기 상수를 썼다.
 * 그 결과 9.5.0 빌드가 사용자에게 "v9.4.4" 로 보였고, <html data-cems-version> 이
 * 두 값 사이를 계속 오갔다(learning-ui 의 관찰자가 매번 되돌려 씀).
 * 이 스크립트는 실제 브라우저에서 (1) 표시 문자열이 VERSION 과 같은지,
 * (2) 속성이 흔들리지 않는지를 확인한다.
 *
 * 사용법: node version.mjs <앱디렉터리>
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(process.argv[2] || '..');
const EXPECTED = fs.readFileSync(path.join(APP_DIR, 'VERSION'), 'utf8').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};
const srv = http.createServer((q, s) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(APP_DIR, p);
  if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: process.env.CEMS_CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'ko-KR' })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));

await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(7000);
await page.evaluate(async () => { for (let i = 0; i < 90; i++) { try { const w = await getAllWords(); if (w?.length) return; } catch (_) {} await new Promise((r) => setTimeout(r, 1000)); } });

/* 모든 레이어의 지연 초기화가 한 번씩 돌도록 화면을 순회하며 속성 변화를 센다 */
await page.evaluate(() => {
  window.__verWrites = [];
  new MutationObserver(() => window.__verWrites.push(document.documentElement.dataset.cemsVersion))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-cems-version'] });
});
for (const r of ['home', 'settings', 'stats', 'study', 'lean', 'data', 'home']) {
  await page.evaluate((x) => window.showPage(x, true), r);
  await page.waitForTimeout(900);
}
await page.waitForTimeout(3000);

const seen = await page.evaluate(() => ({
  htmlAttr: document.documentElement.dataset.cemsVersion,
  title: document.title,
  meta: document.querySelector('meta[name="app-version"]')?.content,
  splash: [...document.querySelectorAll('.splash-sub')].map((x) => x.textContent),
  brand: [...document.querySelectorAll('.cems82-brand-sub')].map((x) => x.textContent),
  build: document.getElementById('phase8-build-status')?.textContent,
  settingsCard: (() => { const c = [...document.querySelectorAll('#page-settings .card')].find((c) => c.querySelector('.card-title')?.textContent.includes('버전 정보')); return c?.querySelector('strong')?.textContent; })(),
  writes: window.__verWrites,
}));

const fails = [];
const want = 'v' + EXPECTED;
const check = (name, value) => {
  if (value === undefined || value === null) return;
  const list = Array.isArray(value) ? value : [value];
  for (const v of list) {
    if (!String(v).includes(want)) fails.push(`${name}: "${v}" 에 ${want} 가 없음`);
    const other = String(v).match(/v\d+(?:\.\d+)+/g)?.filter((m) => m !== want);
    if (other?.length) fails.push(`${name}: 다른 버전 문자열 ${other.join(',')} 이 함께 보임`);
  }
};
if (seen.htmlAttr !== EXPECTED) fails.push(`data-cems-version="${seen.htmlAttr}" (기대 ${EXPECTED})`);
if (seen.meta !== EXPECTED) fails.push(`meta[app-version]="${seen.meta}" (기대 ${EXPECTED})`);
check('title', seen.title);
check('splash-sub', seen.splash);
check('cems82-brand-sub', seen.brand);
check('phase8-build-status', seen.build);
check('설정 버전 카드', seen.settingsCard);
const badWrites = seen.writes.filter((v) => v !== EXPECTED);
if (badWrites.length) fails.push(`data-cems-version 에 다른 값이 ${badWrites.length}회 쓰임: ${[...new Set(badWrites)].join(',')}`);
if (pageErrors.length) fails.push(`미처리 예외 ${pageErrors.length}건: ${pageErrors.slice(0, 3).join(' | ')}`);

console.log(`\n기대 버전: ${EXPECTED}`);
console.log(JSON.stringify(seen, null, 1));
console.log('');
if (fails.length) { fails.forEach((f) => console.log('  FAIL ' + f)); console.log(`\n버전 표시: ${fails.length}건 실패`); }
else console.log(`버전 표시: 통과 (속성 쓰기 ${seen.writes.length}회, 전부 ${EXPECTED})`);

await browser.close(); srv.close();
process.exit(fails.length ? 1 : 0);
