/**
 * CSS 경량 재측정 — css-before 덤프에 기록된 "바로 그 셀렉터·속성"만 다시 재고 비교한다.
 * 전체 라우트 스캔·풀페이지 스크린샷을 생략해 회당 2~3분으로 줄인다.
 *
 * 사용법: node css-recheck.mjs <앱디렉터리> <라벨>
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = process.argv[2] || path.resolve('..');
const LABEL = process.argv[3] || 'recheck';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE = JSON.parse(fs.readFileSync(path.join(HERE, 'out', 'css-before', 'styles.json'), 'utf8'));
const OUT = path.join(HERE, 'out', `css-${LABEL}`);
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };
const srv = http.createServer((q, s) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(APP_DIR, p);
  if (!f.startsWith(APP_DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await (await browser.newContext({ viewport: { width: 430, height: 932 }, locale: 'ko-KR' })).newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(6000);
await page.evaluate(async () => { for (let i = 0; i < 90; i++) { try { const w = await getAllWords(); if (w?.length) return; } catch (_) {} await new Promise((r) => setTimeout(r, 1000)); } });

const PROPS = BEFORE.props || [];
const result = { label: LABEL, capturedAt: new Date().toISOString(), tokens: {}, pages: {}, pseudo: {}, pageErrors: [] };

result.tokens = await page.evaluate((props) => {
  const grab = (el) => { const cs = getComputedStyle(el); const o = {}; for (const p of props) if (p.startsWith('--')) o[p] = cs.getPropertyValue(p).trim(); return o; };
  const names = Object.keys((window.__cemsTokenNames || {}));
  const read = (el) => {
    const cs = getComputedStyle(el); const o = {};
    for (const n of names) o[n] = cs.getPropertyValue(n).trim();
    return o;
  };
  return { _htmlClass: document.documentElement.className, _bodyClass: document.body.className };
}, PROPS);

// before 덤프에 있던 토큰 이름을 그대로 다시 잰다
const tokenNames = Object.keys((BEFORE.tokens && BEFORE.tokens.root) || {});
result.tokens.root = await page.evaluate((names) => {
  const cs = getComputedStyle(document.documentElement); const o = {};
  for (const n of names) o[n] = cs.getPropertyValue(n).trim();
  return o;
}, tokenNames);

for (const [route, snapshot] of Object.entries(BEFORE.pages || {})) {
  const selectors = Object.keys(snapshot);
  if (route === 'session') continue; // 세션 진입은 별도 흐름 — 경량 재측정에서는 제외
  await page.evaluate((r) => { try { window.showPage(r, true); } catch (_) {} }, route);
  await page.waitForTimeout(route === 'lean' ? 2500 : 900);
  result.pages[route] = await page.evaluate(({ sels, props }) => {
    const out = {};
    for (const sel of sels) {
      let el = null;
      try { el = sel === 'html' ? document.documentElement : sel === 'body' ? document.body : document.querySelector(sel); } catch (_) {}
      if (!el) { out[sel] = null; continue; }
      const cs = getComputedStyle(el); const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p);
      out[sel] = o;
    }
    return out;
  }, { sels: selectors, props: PROPS });
  process.stdout.write(`  ${route.padEnd(10)} ${selectors.length}개 셀렉터\n`);
}

// 아이콘 ::before (아이콘 소실 회귀 감지)
if (BEFORE.pseudo && Object.keys(BEFORE.pseudo).length) {
  result.pseudo = await page.evaluate((keys) => {
    const out = {};
    for (const k of keys) {
      const sel = k.replace(/::(before|after)$/, '');
      const pseudo = k.endsWith('::after') ? '::after' : '::before';
      let el = null; try { el = document.querySelector(sel); } catch (_) {}
      if (!el) { out[k] = null; continue; }
      const cs = getComputedStyle(el, pseudo);
      out[k] = { content: cs.content, display: cs.display, mask: cs.webkitMaskImage || cs.maskImage, background: cs.backgroundColor, opacity: cs.opacity };
    }
    return out;
  }, Object.keys(BEFORE.pseudo));
}

result.pageErrors = pageErrors;
for (const r of ['home', 'study', 'data', 'settings']) {
  try { await page.evaluate((n) => window.showPage(n, true), r); await page.waitForTimeout(500); await page.screenshot({ path: path.join(OUT, `${r}.png`) }); } catch (_) {}
}
fs.writeFileSync(path.join(OUT, 'styles.json'), JSON.stringify(result, null, 1));
console.log(`  → ${path.join(OUT, 'styles.json')}  (페이지오류 ${pageErrors.length}건)`);
await browser.close(); srv.close();
