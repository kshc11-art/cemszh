import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const DIR=path.resolve(process.argv[2]||'..'), MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.md':'text/markdown'};
const srv=http.createServer((q,s)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';const f=path.join(DIR,p);if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){s.writeHead(404);s.end();return;}s.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream','cache-control':'no-cache'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const b=await chromium.launch({executablePath: process.env.CEMS_CHROMIUM_PATH || undefined, args:['--no-sandbox']});const pg=await (await b.newContext({viewport:{width:430,height:932}})).newPage();
await pg.goto(`http://127.0.0.1:${srv.address().port}/index.html`,{waitUntil:'load',timeout:60000});
await pg.waitForTimeout(6000);
await pg.evaluate(async()=>{for(let i=0;i<90;i++){try{const w=await getAllWords();if(w?.length)return;}catch(_){}await new Promise(r=>setTimeout(r,1000));}});
const out=await pg.evaluate(async()=>{
  const res={};
  for (const r of ['stats','lean','data','home','study']){
    window.showPage('home',true); await new Promise(x=>setTimeout(x,400));
    const t0=performance.now(); window.showPage(r,true);
    let ms=null;
    for(let i=0;i<60;i++){
      await new Promise(x=>setTimeout(x,100));
      const el=document.getElementById('page-'+r);
      if(el && (el.innerText||'').trim().length>150){ms=Math.round(performance.now()-t0);break;}
    }
    res[r]={renderedAfterMs:ms, finalLen:(document.getElementById('page-'+r)?.innerText||'').trim().length};
  }
  return res;
});
console.log(JSON.stringify(out,null,1));
await b.close(); srv.close();
