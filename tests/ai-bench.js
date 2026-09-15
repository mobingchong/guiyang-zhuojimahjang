/* AI 出牌质量基准（两段：初盘 / 终盘）
   ① 效率：AI 打完后向听数是否最优、进张数是否等于最优（理论最优 = 枚举所有候选）
   ② 防守：AI 的选择在"危险度模型"下是否接近最安全（新模型 vs 旧模型各算一遍）
      同时看两段（牌墙剩 60 张 = 初盘、剩 24 张 = 终盘）—— 防守权重本来就该随进度变化。
   用法：node tests/ai-bench.js "<file:///绝对路径/贵阳麻将.html>" [手数] */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9392;
const url = process.argv[2];
const N = parseInt(process.argv[3] || '200', 10);
const PROFILE = path.join('D:/MyProjects', '_aibench_profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpGet = u => new Promise((res, rej) => { const r = http.get(u, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res(d)); }); r.on('error', rej); r.setTimeout(4000, () => { r.destroy(); rej(new Error('timeout')); }); });
const send = (ws, method, params) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e6); const on = e => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener('message', on); res(m); } }; ws.addEventListener('message', on); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => rej(new Error('cdp timeout ' + method)), 120000); });

const EXPR = `(()=>{
  const N=${N};
  function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const t=a[i];a[i]=a[j];a[j]=t;}return a;}
  function randHand(){
    const pool=[];for(let i=0;i<27;i++)for(let k=0;k<4;k++)pool.push(i);shuffle(pool);
    const h=new Array(27).fill(0);for(let i=0;i<13;i++)h[pool[i]]++;return h;
  }
  // 三家随机牌河（每张牌从 108 张里扣掉，尽量不重复）
  function randTable(hand){
    const pool=[];
    for(let i=0;i<27;i++)for(let k=0;k<4-hand[i];k++)pool.push(i);
    shuffle(pool);
    return [[],[],shuffle(pool).splice(0,11),shuffle(pool).splice(0,11),shuffle(pool).splice(0,11)].slice(1);
  }
  // 旧的危险度模型（只数全场见过几张）—— 用来对比"AI 现在到底在优化哪个模型"
  function dangerOld(card,self){
    let seen=0;
    for(let p=0;p<4;p++){if(p===self)continue;(G.discards[p]||[]).forEach(x=>{if(x===card)seen++;});}
    if((G.discards[self]||[]).indexOf(card)>=0)return 0;
    if(seen>=3)return 0; if(seen>=2)return 1.5; if(seen>=1)return 4; return 8;
  }
  const stages=[{name:'初盘(墙60)',wall:60},{name:'终盘(墙24)',wall:24}];
  const out=[];
  for(const st of stages){
    let gap=0,opt=0,ratioSum=0,n=0;
    let dNewOpt=0,dOldOpt=0,sumNewPick=0,sumNewBest=0,sumOldPick=0,sumOldBest=0;
    for(let it=0;it<N;it++){
      const hand=randHand();
      G.discards=randTable(hand);G.melds=[[],[],[],[]];
      G.wall=new Array(st.wall).fill(0);
      // 理论最优（只按效率：先向听、后进张）
      let minSh=99,bestTiles=-1;
      const rows=[];
      for(let c=0;c<27;c++){
        if(!hand[c])continue;
        hand[c]--;
        const sh=shanten(fullCount(hand,[]),0);
        const ut=usefulTiles(hand,[]);
        hand[c]++;
        rows.push({c:c,sh:sh,tiles:ut.tiles});
        if(sh<minSh)minSh=sh;
      }
      rows.forEach(o=>{if(o.sh===minSh&&o.tiles>bestTiles)bestTiles=o.tiles;});
      // AI 的选择
      G.hands[0]=hand.slice();
      const pick=aiDiscardSmart(0);
      const row=rows.filter(o=>o.c===pick)[0];
      gap+=((row?row.sh:99)-minSh);
      if(row&&row.tiles===bestTiles)opt++;
      ratioSum+=(bestTiles>0&&row?Math.min(1,row.tiles/bestTiles):1);
      // 危险度对比：只看"效率同为最优"的候选，看 AI 选的是不是这一步里最安全的
      const pool=rows.filter(o=>o.sh===minSh&&o.tiles===bestTiles);
      let bn=99,bo=99,pn=0,po=0;
      pool.forEach(o=>{
        const dn=dangerScore(o.c,0), d0=dangerOld(o.c,0);
        if(dn<bn)bn=dn; if(d0<bo)bo=d0;
        if(o.c===pick){pn=dn;po=d0;}
      });
      if(pool.length){
        if(pn<=bn+0.6)dNewOpt++;
        if(po<=bo+0.6)dOldOpt++;
        sumNewPick+=pn;sumNewBest+=bn;sumOldPick+=po;sumOldBest+=bo;
      }
      n++;
    }
    out.push({stage:st.name,hands:n,shantenGapAvg:+(gap/n).toFixed(4),effOptRate:+(opt/n).toFixed(3),
      ukeireRatio:+(ratioSum/n).toFixed(4),
      dangerNewOptRate:+(dNewOpt/n).toFixed(3),dangerOldOptRate:+(dOldOpt/n).toFixed(3),
      dangerNew_pick_vs_best:+(sumNewPick/n).toFixed(2)+' / '+(sumNewBest/n).toFixed(2),
      dangerOld_pick_vs_best:+(sumOldPick/n).toFixed(2)+' / '+(sumOldBest/n).toFixed(2)});
  }
  return JSON.stringify(out,null,1);
})()`;

(async () => {
  if (!fs.existsSync(PROFILE)) fs.mkdirSync(PROFILE, { recursive: true });
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + PROFILE, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
  await sleep(3000);
  let list;
  try { list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`)); }
  catch (e) { console.log('CDP 失败: ' + e.message); proc.kill(); return; }
  const page = list.find(t => t.type === 'page') || {};
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  await send(ws, 'Page.enable'); await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 400, height: 871, deviceScaleFactor: 1, mobile: true });
  await send(ws, 'Page.navigate', { url }); await sleep(2500);
  const ev = async e => {
    const r = await send(ws, 'Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'ERR ' + String(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text).slice(0, 300);
    return r.result && r.result.result ? r.result.result.value : '(no value)';
  };
  await ev(`(()=>{try{localStorage.setItem('gymj.v1',JSON.stringify({name:'探针',records:{'探针':{scores:[0,0,0,0],hands:0,dealer:0}}}));return 'ok';}catch(e){return 'err';}})()`);
  await send(ws, 'Page.reload', { ignoreCache: true });
  for (let i = 0; i < 24; i++) { await sleep(500); if (await ev(`!!document.querySelector('#myHand .tile')`) === true) break; }
  await sleep(300);
  console.log('===== AI 出牌质量基准（每段 ' + N + ' 手随机牌）=====');
  console.log(await ev(EXPR));
  ws.close(); proc.kill(); await sleep(300); process.exit(0);
})();
