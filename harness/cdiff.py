import json,sys,collections
A=json.load(open(f'./out/css-{sys.argv[1]}/styles.json'))
B=json.load(open(f'./out/css-{sys.argv[2]}/styles.json'))
diffs=[]
for route,snap in A.get('pages',{}).items():
    if route not in B.get('pages',{}): continue
    for sel,props in (snap or {}).items():
        pb=B['pages'][route].get(sel)
        if props is None and pb is None: continue
        if props is None or pb is None:
            diffs.append((route,sel,'(요소 존재)', 'before' if props else 'after')); continue
        for p,v in props.items():
            w=pb.get(p)
            if v!=w: diffs.append((route,sel,p,f'{v}  ->  {w}'))
# 토큰
for n,v in (A.get('tokens',{}).get('root') or {}).items():
    w=(B.get('tokens',{}).get('root') or {}).get(n)
    if v!=w: diffs.append(('(토큰)','root',n,f'{v}  ->  {w}'))
# 아이콘 pseudo
for k,v in (A.get('pseudo') or {}).items():
    w=(B.get('pseudo') or {}).get(k)
    if v is None and w is None: continue
    if json.dumps(v,sort_keys=True)!=json.dumps(w,sort_keys=True):
        diffs.append(('(아이콘)',k,'::before',f'{json.dumps(v,ensure_ascii=False)[:70]} -> {json.dumps(w,ensure_ascii=False)[:70]}'))
cnt=collections.Counter(d[2] for d in diffs)
print(f'차이 {len(diffs)}건')
print('\n속성별:')
for p,c in cnt.most_common(25): print(f'  {c:5}  {p}')
print('\n라우트별:', dict(collections.Counter(d[0] for d in diffs)))
print('\n대표 40건:')
for d in diffs[:40]: print(f'  [{d[0]}] {d[1]}  ·  {d[2]}\n        {d[3]}')
json.dump(diffs,open('./out/cdiff.json','w'),ensure_ascii=False,indent=1)
