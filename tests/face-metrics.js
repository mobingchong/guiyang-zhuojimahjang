/* 牌面度量：万字的"墨迹"上下留白、条子竹条的粗细对比
   用法: node tests/face-metrics.js "file:///.../贵阳麻将.html" */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9354;
const url=process.argv[2];
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_face_metrics_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,method,params){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method,params}));});}

// ① 万字：把 svg 塞进 DOM，用 getBBox 量"真实墨迹"的上下留白
const WAN=`(()=>{
  const host=document.createElement('div');
  host.style.cssText='position:fixed;left:-9999px;top:0;width:200px;height:280px';
  document.body.appendChild(host);
  const rows=[];
  for(let n=1;n<=9;n++){
    const c=n-1;
    host.innerHTML=tileFace(c);
    const svg=host.querySelector('svg');
    const texts=[...host.querySelectorAll('text')];
    const boxes=texts.map(t=>{const b=t.getBBox();return {t:t.textContent,x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2)};});
    let top=1e9,bot=-1e9;
    boxes.forEach(b=>{if(b.y<top)top=b.y;if(b.y+b.h>bot)bot=b.y+b.h;});
    rows.push({n,top:+top.toFixed(2),bot:+bot.toFixed(2),上留白:+top.toFixed(2),下留白:+(50-bot).toFixed(2),
      居中偏移:+(((50-bot)-top)/2).toFixed(2),boxes});
  }
  host.remove();
  return JSON.stringify(rows,null,1);
})()`;

// ② 条子：量每根竹条的宽度（柱身 rect 的 width）
const TIAO=`(()=>{
  const host=document.createElement('div');
  host.style.cssText='position:fixed;left:-9999px;top:0;width:200px;height:280px';
  document.body.appendChild(host);
  const out=[];
  for(let n=1;n<=9;n++){
    host.innerHTML=tileFace(9+n-1);
    const rects=[...host.querySelectorAll('rect')].map(r=>+(+r.getAttribute('width')).toFixed(2));
    // 柱身宽 = 各 rect 宽度里出现最多的那一档（排除细的高光/暗边条）
    const cnt={};rects.forEach(w=>{cnt[w]=(cnt[w]||0)+1;});
    const arr=Object.keys(cnt).map(Number).filter(w=>w>=3).sort((a,b)=>b*w_cnt(b,cnt)-a*w_cnt(a,cnt));
    function w_cnt(w,c){return c[w]||0;}
    const bars=rects.filter(w=>w>=4.2);
    const uniq=[...new Set(bars)].sort((a,b)=>a-b);
    out.push({n, 柱宽候选:uniq, rect数:rects.length, 圆数:[...host.querySelectorAll('circle')].length});
  }
  host.remove();
  return JSON.stringify(out,null,1);
})()`;

(async()=>{
  if(!fs.existsSync(PROFILE))fs.mkdirSync(PROFILE,{recursive:true});
  const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--user-data-dir='+PROFILE,`--remote-debugging-port=${PORT}`],{stdio:'ignore'});
  await sleep(3000);
  let list;try{list=await httpGet(`http://127.0.0.1:${PORT}/json/list`);}catch(e){console.log('CDP 失败 '+e.message);proc.kill();return;}
  const page=list.find(t=>t.type==='page')||{};
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r=>ws.onopen=r);
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const ev=async expr=>{
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return 'ERR '+String((ed.exception&&ed.exception.description)||ed.text).slice(0,300);
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  await send(ws,'Page.navigate',{url});await sleep(2600);
  await ev("(()=>{try{localStorage.setItem('gymj.v1',JSON.stringify({name:'量',records:{'量':{scores:[0,0,0,0],hands:0,dealer:0}}}));return 'ok';}catch(e){return 'err';}})()");
  console.log('===== 万字：墨迹上下留白（viewBox 0~50）=====');
  console.log(await ev(WAN));
  console.log('===== 条子：柱身宽 =====');
  console.log(await ev(TIAO));
  ws.close();proc.kill();
  await sleep(400);
  try{fs.renameSync(PROFILE,path.join(BASE,'_trash_face_'+Date.now()));}catch(e){}
  process.exit(0);
})();
