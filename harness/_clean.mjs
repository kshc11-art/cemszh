import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const DIR=path.resolve(process.argv[2]||'..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'};
const srv=http.createServer((q,s)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(DIR,p);
 if(!f.startsWith(DIR)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){s.writeHead(404);s.end();return;}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream','cache-control':'no-cache'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const b=await chromium.launch({executablePath:process.env.CEMS_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
const pg=await (await b.newContext({viewport:{width:430,height:932},locale:'ko-KR'})).newPage();
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`,{waitUntil:'load',timeout:60000});
await pg.waitForTimeout(7000);
await pg.evaluate(async()=>{for(let i=0;i<90;i++){try{const w=await getAllWords();if(w?.length)return;}catch(_){}await new Promise(r=>setTimeout(r,1000));}});
console.log(JSON.stringify(await pg.evaluate(async()=>{
  const rows=(await getAllWords()).slice(0,3000);
  const clean=window.CEMSSafe.clean;
  let strings=0, withMarkup=0;
  for(const r of rows) for(const k of Object.keys(r)) { const v=r[k]; if(typeof v==='string'){strings++; if(v.indexOf('<')>=0||v.indexOf('&')>=0) withMarkup++;} }
  const t0=performance.now();
  for(const r of rows) clean(r);
  const ms=Math.round(performance.now()-t0);
  return {rows:rows.length, stringFields:strings, fieldsWithMarkup:withMarkup, cleanMs:ms, perRowMs:+(ms/rows.length).toFixed(3)};
}),null,1));
await b.close(); srv.close();
