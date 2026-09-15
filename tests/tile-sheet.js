#!/usr/bin/env node
/* 牌面条样：把 27 张牌面渲染成图片，用来肉眼验收"图形是否变形/协调".
   （布局回归测不出图形问题，只能出图看；但"圆是否重叠"这类可以写成几何断言，
     见 verify-layout.js 的"牌面图形"检查。）

   用法：node tests/tile-sheet.js "file:///.../贵阳麻将.html"
   产物：tests/牌面条样-全览.png、tests/牌面条样-关键张放大.png
*/
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9353;
const url=process.argv[2];
if(!url){console.log('用法: node tests/tile-sheet.js "file:///.../贵阳麻将.html"');process.exit(1);}
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_tile_sheet_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,method,params){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method,params}));});}

const sheetExpr=(codes,size)=>`(()=>{
  document.querySelectorAll('#sheetbox').forEach(e=>e.remove());
  const box=document.createElement('div');
  box.id='sheetbox';
  box.style.cssText='position:fixed;left:0;top:0;z-index:99999;background:#0d5c3c;display:flex;flex-wrap:wrap;gap:6px;padding:8px;box-sizing:border-box';
  const W=${size}, H=Math.round(W*50/36);
  ${JSON.stringify(codes)}.forEach(c=>{
    const d=document.createElement('div');
    d.style.cssText='width:'+W+'px;height:'+H+'px;background:linear-gradient(175deg,#fffef8,#f4f2e6);border:1px solid #cfcbb8;border-radius:'+Math.round(W*0.13)+'px;box-shadow:0 2px 5px rgba(0,0,0,.35);position:relative;overflow:hidden;flex:0 0 auto';
    d.innerHTML=tileFace(c);
    box.appendChild(d);
  });
  document.body.appendChild(box);
  const r=box.getBoundingClientRect();
  return Math.round(r.width)+'x'+Math.round(r.height);
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
  await ev("(()=>{try{localStorage.setItem('gymj.v1',JSON.stringify({name:'样张',records:{'样张':{scores:[0,0,0,0],hands:0,dealer:0}}}));return 'ok';}catch(e){return 'err';}})()");

  const shots=[
    {n:'牌面条样-全览', codes:[...Array(27).keys()], w:1080, h:640, size:104, dsf:2},
    {n:'牌面条样-关键张放大', codes:[16,25,24,15,23,26], w:1180, h:420, size:180, dsf:2},
  ];
  for(const s of shots){
    await send(ws,'Emulation.setDeviceMetricsOverride',{width:s.w,height:s.h,deviceScaleFactor:s.dsf,mobile:false});
    const info=await ev(sheetExpr(s.codes,s.size));
    await sleep(400);
    const r=await send(ws,'Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(__dirname,s.n+'.png'),Buffer.from(r.result.data,'base64'));
    console.log(s.n+' → '+info);
  }
  ws.close();proc.kill();
  await sleep(400);
  try{fs.renameSync(PROFILE,path.join(BASE,'_trash_sheet_'+Date.now()));}catch(e){}
  process.exit(0);
})();
