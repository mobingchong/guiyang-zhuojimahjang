/* 生成 app 图标（manifest 用）：绿底 + 一张牌，方形 512/192。
   用法: node tests/make-icon.js "file:///.../贵阳麻将.html"
   产物：icon-512.png、icon-192.png（项目根） */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9361;
const url=process.argv[2];
if(!url){console.log('用法: node tests/make-icon.js "file:///.../贵阳麻将.html"');process.exit(1);}
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_icon_profile');
const OUT=path.join(__dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,m,p){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});}

// 把牌面画进方形画布：深绿底 + 居中一张牌（用小圆角、带阴影）
const DRAW=(size)=>`(()=>{
  const S=${size};
  const cv=document.createElement('canvas');cv.width=S;cv.height=S;
  const ctx=cv.getContext('2d');
  const g=ctx.createLinearGradient(0,0,S,S);
  g.addColorStop(0,'#14603f');g.addColorStop(1,'#0b3d2e');
  ctx.fillStyle=g;ctx.fillRect(0,0,S,S);
  // 牌
  const w=Math.round(S*0.56), h=Math.round(w*50/36);
  const x=Math.round((S-w)/2), y=Math.round((S-h)/2);
  const r=Math.round(S*0.06);
  ctx.save();
  ctx.shadowColor='rgba(0,0,0,.45)';ctx.shadowBlur=Math.round(S*0.03);ctx.shadowOffsetY=Math.round(S*0.012);
  ctx.fillStyle='#f7f2e4';
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();ctx.fill();
  ctx.restore();
  // 牌面（一筒 = 大红饼，做图标最好认）
  const svg=tileFace(18);
  const img=new Image();
  img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  return new Promise(res=>{
    img.onload=()=>{ctx.drawImage(img,x,y,w,h);res(cv.toDataURL('image/png'));};
    img.onerror=()=>res('ERR svg');
  });
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
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return 'ERR '+String((ed.exception&&ed.exception.description)||ed.text).slice(0,200);
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  await send(ws,'Page.navigate',{url});await sleep(2600);
  for(const S of [512,192]){
    const d=await ev(DRAW(S));
    if(typeof d!=='string'||!d.startsWith('data:image/png')){console.log('X '+S+': '+d);continue;}
    fs.writeFileSync(path.join(OUT,'icon-'+S+'.png'),Buffer.from(d.split(',')[1],'base64'));
    console.log('已生成 icon-'+S+'.png');
  }
  ws.close();proc.kill();
  await sleep(400);
  try{fs.renameSync(PROFILE,path.join(BASE,'_trash_icon_'+Date.now()));}catch(e){}
  process.exit(0);
})();
