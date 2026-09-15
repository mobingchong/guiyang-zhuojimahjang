#!/usr/bin/env node
/* 贵阳捉鸡麻将 · 音效自测
 *
 * 用法：node tests/sound-test.js "file:///D:/MyProjects/gymj/index.html"
 *
 * 它要回答三个问题（截图和"点了有声音"都答不了的那种）：
 *   ① **引擎在不在**：WebAudio 可用、23 条音效配方齐全、没有一条会抛错；
 *   ② **真的出声了吗**：包住 AudioContext 的 createOscillator / createBufferSource 计数 ——
 *      每条音效排出的音频节点数必须与配方一致（例如"碰"=3 个撞击声、自摸=7 个乐音）。
 *      只说"调用没抛错"是不够的：配方里参数写错、数组越界，都会被 try/catch 吞掉、
 *      听起来只是"变小声了"，肉眼和耳朵都发现不了；
 *   ③ **挂点接对了吗**：把 SFX.play 换成记录器，再真跑一遍牌局流程（摇色子/发牌/摸打/碰杠胡/
 *      荒庄/抢杠/叫牌），断言每个事件都发出了**该发的那一声**，而且"胡→翻鸡→结算"三个音的
 *      延迟是错开的（0 / 0.75 / 1.1 秒），不是一个音糊在另一个音上。
 */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9362;
const url=process.argv[2];
if(!url){console.log('用法: node tests/sound-test.js "file:///.../index.html"');process.exit(1);}
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_edge_sound_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,method,params){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method,params}));});}

let PASS=0,FAIL=0;
function ok(cond,label,extra){ if(cond){PASS++;console.log('  ✅ '+label);} else {FAIL++;console.log('  ❌ '+label+(extra!==undefined?'  实际='+JSON.stringify(extra):''));} }

// 每条音效应该排出的音频节点数（配方实测值；改了配方就要同步改这里 —— 这正是它的价值）
const EXPECT={
  tap:[2,0], deny:[0,1], discard:[2,0], draw:[2,0],
  peng:[3,0], gang:[4,0], angang:[2,1], bugang:[2,0],
  ting:[0,2], prompt:[0,2], alert:[0,3], huReady:[0,5],
  hu:[0,4], zimo:[0,7], huBig:[0,9], qianggang:[1,2], hotcannon:[0,3],
  dice:[7,1], diceStop:[2,0], deal:[10,0], settle:[0,2], chicken:[2,2], liuju:[0,2]
};

(async()=>{
  if(!fs.existsSync(PROFILE))fs.mkdirSync(PROFILE,{recursive:true});
  const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--user-data-dir='+PROFILE,`--remote-debugging-port=${PORT}`,url],{stdio:'ignore'});
  await sleep(3200);
  let list;try{list=await httpGet(`http://127.0.0.1:${PORT}/json/list`);}catch(e){console.log('CDP 失败 '+e.message);proc.kill();return;}
  const page=list.find(t=>t.type==='page')||{};
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r=>ws.onopen=r);
  const errs=[];
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails.exception&&m.params.exceptionDetails.exception.description||m.params.exceptionDetails.text).slice(0,220));
  };
  const ev=async expr=>{
    // ⚠️ awaitPromise 必须开：②的批量测音是个 async 循环，不开的话 Runtime.evaluate
    //    立刻返回一个 Promise 对象（拿到 undefined），循环还会在页面里继续跑、
    //    把后面⑤的记录器污染掉（实测踩过）。
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return {__err:String((ed.exception&&ed.exception.description)||ed.text).slice(0,300)};
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  await send(ws,'Runtime.enable',{});await send(ws,'Page.enable',{});
  await send(ws,'Emulation.setDeviceMetricsOverride',{width:400,height:871,deviceScaleFactor:1,mobile:true});
  // 显式再导航一次并等页面就绪：Edge 新建 profile 的首次启动会多花时间，
  // 光靠 spawn 时带的 url + 固定 sleep，第一次 evaluate 有几率打在还没跑完脚本的页面上
  // （表现是 SFX 未定义 → 断言全崩）。多这一步比加长 sleep 可靠。
  const nav=async()=>{await send(ws,'Page.navigate',{url});await sleep(2800);};
  await nav();
  for(let i=0;i<12;i++){                       // 等脚本跑完（最多 ~6s）
    const ready=await ev("typeof SFX!=='undefined' && !!document.getElementById('sndBtn')");
    if(ready===true)break;
    await sleep(500);
  }

  console.log('\n===== ① 引擎在场：WebAudio 可用 + 配方齐全 =====');
  let s=await ev(`(()=>({has:typeof SFX==='object',avail:SFX.available,on:SFX.on(),names:SFX.names().slice().sort(),
     ctx:!!SFX._ctx(), btn:!!document.getElementById('sndBtn')}))()`);
  if(s&&s.__err){console.log('  ❌ 页面里取不到 SFX：'+s.__err);proc.kill();process.exit(1);}
  console.log('  '+JSON.stringify({has:s.has,avail:s.avail,on:s.on,ctx:s.ctx,btn:s.btn,音效数:(s.names||[]).length}));
  ok(s.has===true,'音效引擎已加载');
  ok(s.avail===true,'浏览器支持 WebAudio');
  ok(s.btn===true,'右上角音效开关按钮已插入');
  const want=Object.keys(EXPECT).sort();
  ok(JSON.stringify(s.names)===JSON.stringify(want),'音效清单与设计一致（'+want.length+' 条）',s.names);

  console.log('\n===== ② 每条音效真的排出了音频节点（不是"没报错"就算过） =====');
  await ev(`(()=>{
    window.__osc=0;window.__src=0;
    const AC=window.AudioContext||window.webkitAudioContext;
    if(AC&&!AC.prototype.__patched){
      AC.prototype.__patched=true;
      const o=AC.prototype.createOscillator,s=AC.prototype.createBufferSource;
      AC.prototype.createOscillator=function(){window.__osc++;return o.apply(this,arguments);};
      AC.prototype.createBufferSource=function(){window.__src++;return s.apply(this,arguments);};
    }
    return 'ok';
  })()`);
  const counts=await ev(`(async()=>{
    const out={};const names=Object.keys(${JSON.stringify(EXPECT)});
    for(const n of names){
      SFX.unlock();
      await new Promise(r=>setTimeout(r,70));      // 越过 tap/draw 的节流窗口
      window.__osc=0;window.__src=0;
      try{ SFX.play(n); }catch(e){ out[n]='抛错: '+e.message; continue; }
      out[n]=[window.__src,window.__osc];
    }
    return out;
  })()`);
  let bad=[];
  for(const n of want){
    const got=counts[n], exp=EXPECT[n];
    const good=Array.isArray(got)&&got[0]===exp[0]&&got[1]===exp[1];
    if(!good)bad.push(n+' 期望'+JSON.stringify(exp)+' 实得'+JSON.stringify(got));
  }
  ok(bad.length===0,'23 条音效的音频节点数与配方逐条一致（撞击声/乐音各多少个）',bad);

  console.log('\n===== ③ 音效开关：可关、可开、状态能记住 =====');
  s=await ev(`(()=>{
    const r={};
    SFX.setOn(false);
    window.__osc=0;window.__src=0;SFX.play('discard');
    const muted=[window.__src,window.__osc];
    const storeOff=JSON.parse(localStorage.getItem('gymj.sfx.v1')||'null');   // 关掉之后先落一次盘
    SFX.setOn(true);
    const storeOn=JSON.parse(localStorage.getItem('gymj.sfx.v1')||'null');
    window.__osc=0;window.__src=0;SFX.play('discard');
    const onAgain=[window.__src,window.__osc];
    return {muted:muted,onAgain:onAgain,storeOff:storeOff,storeOn:storeOn};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.muted[0]===0&&s.muted[1]===0,'关掉音效后**一个音频节点都不排**（不是调成 0 音量）');
  ok(s.storeOff&&s.storeOff.on===false,'关掉的状态立刻落盘（刷新后仍是静音）');
  ok(s.storeOn&&s.storeOn.on===true,'重新打开也落盘');
  ok(s.onAgain[0]===2,'重新打开后立刻恢复出声');

  console.log('\n===== ④ 节流：连点不会叠成噪音 =====');
  s=await ev(`(()=>{window.__src=0;for(let i=0;i<10;i++)SFX.play('tap');return window.__src;})()`);
  console.log('  连打 10 次 tap → 实际排出 '+s+' 个撞击声');
  ok(s<=2,'同一音效 55ms 内的重复调用被丢弃（10 次只出 ≤2 声）',s);

  console.log('\n===== ⑤ 事件挂点：把 play 换成记录器，真跑一遍牌局 =====');
  await ev(`(()=>{ window.__snd=[]; const _p=SFX.play;
    SFX.play=function(n,o){ window.__snd.push([n,(o&&o.delay)||0]); return _p.apply(this,arguments); };
    return 'instrumented'; })()`);

  // 5.1 开局：摇色子 → 落定 → 发牌 → 摸牌
  await ev(`(()=>{window.__snd=[];startHand();return 'go';})()`);
  await sleep(900);
  let a1=await ev('window.__snd.map(x=>x[0])');
  await sleep(1400);
  let a2=await ev('window.__snd.map(x=>x[0])');
  console.log('  开局 0.9s：'+JSON.stringify(a1));
  console.log('  开局 2.3s：'+JSON.stringify(a2));
  ok(a1.includes('dice'),'摇色子 → 骰子滚动声');
  ok(a1.includes('diceStop'),'色子落定 → 清脆一响');
  ok(a2.includes('deal'),'发牌 → 一把「唰」过去');
  ok(a2.includes('draw'),'摸牌 → 摸牌声');

  // 5.2 出牌 / 点牌 / 非法点击
  s=await ev(`(()=>{
    const r={};
    G.melds[0]=[];G.hands[0]=emptyC();[0,1,2,3,4,5,6,7,8,9,10,11,12,13].forEach(c=>G.hands[0][c]++);
    G.phase='discard';G.turn=0;G.pendingAction=null;G.actions=[];G.picked=null;G.melds[1]=G.melds[2]=G.melds[3]=[];
    G.hands[1]=emptyC();G.hands[2]=emptyC();G.hands[3]=emptyC();
    window.__snd=[];discard(0,13);r.discard=window.__snd.slice(0,2);
    G.hands[0]=emptyC();[0,1,2,3,4,5,6,7,8,9,10,11,12,13].forEach(c=>G.hands[0][c]++);
    G.phase='discard';G.turn=0;G.pendingAction=null;G.picked=null;
    window.__snd=[];onTileClick(7);r.pick=window.__snd.slice(0,2);
    window.__snd=[];onTileClick(7);r.discard2=window.__snd.slice(0,2);
    G.hands[0]=emptyC();[0,1,2,3,4,5,6,7,8,9,10,11,12,13].forEach(c=>G.hands[0][c]++);
    G.turn=2;G.pendingAction=null;window.__snd=[];onTileClick(3);r.deny=window.__snd.slice(0,2);
    return r;
  })()`);
  console.log('  '+JSON.stringify(s));
  // 记录器存的是 [名字, 延迟] 二元组，所以取 [0][0]
  ok(s.discard[0][0]==='discard','出牌 → 牌拍桌面的那一声');
  ok(s.pick[0][0]==='tap','第一次点牌（预选）→ 轻点');
  ok(s.discard2[0][0]==='discard','第二次点同一张（真打出）→ 出牌声');
  ok(s.deny[0][0]==='deny','不是自己回合还点牌 → 「唔」');

  // 5.3 碰 / 明杠 / 暗杠 / 补杠
  s=await ev(`(()=>{
    const r={};
    G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];
    G.hands[1]=emptyC();G.hands[1][5]=2;G.discards[0]=[5];
    window.__snd=[];doPeng(1,5,0);r.peng=window.__snd.slice(0,1);
    G.melds=[[],[],[],[]];G.hands[1]=emptyC();G.hands[1][6]=3;G.discards[0]=[6];
    window.__snd=[];doGang(1,6,0);r.gang=window.__snd.slice(0,1);
    G.melds=[[],[],[],[]];G.hands[1]=emptyC();G.hands[1][7]=4;
    window.__snd=[];doAnGang(1,7);r.angang=window.__snd.slice(0,1);
    G.melds=[[],[{type:'peng',card:8,from:0}],[],[]];G.hands[1]=emptyC();G.hands[1][8]=1;G.discards[0]=[8];
    G.hands[2]=emptyC();G.hands[3]=emptyC();G.hands[0]=emptyC();
    window.__snd=[];doBuGang(1,8);r.bugang=window.__snd.slice(0,1);
    return r;
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.peng[0][0]==='peng','碰 → 三声嗒嗒嗒');
  ok(s.gang[0][0]==='gang','明杠 → 四声、更重');
  ok(s.angang[0][0]==='angang','暗杠 → 闷响');
  ok(s.bugang[0][0]==='bugang','补杠 → 中音双响');

  // 5.4 有可选动作 / 可胡 的提示音（走真实入口 checkClaims）
  s=await ev(`(()=>{
    const r={};
    G.hands[0]=emptyC();[0,0,1,1,2,2,4,5,6,7,8,9,10].forEach(c=>G.hands[0][c]++);
    G.melds=[[],[],[],[]];G.phase='discard';G.turn=1;G.pendingAction=null;G.actions=[];
    G.discards[1]=[0];
    window.__snd=[];checkClaims(1,0);r.pengReady=window.__snd.slice(0,2);
    G.actions=[];window.__snd=[];setActions([{type:'hu',card:0,from:1}]);r.huReady=window.__snd.slice(0,2);
    return r;
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.pengReady[0][0]==='alert','有牌可碰 → 三连叮提示');
  ok(s.huReady[0][0]==='huReady','能胡 → 五音上行（比提示音更醒目）');

  // 5.5 胡牌 → 翻鸡 → 结算窗：三个音的时序必须是错开的。
  //     ⚠️ 番数要用**引擎自己的那个数**：doHu 判"大牌"看的是 settle() 出来的 res.pat.fan
  //        （已经含自摸 +1 等加成），不是裸 huPattern 的结果。这里包一层 showResult 把它取出来，
  //        否则断言会因为我算错了门槛而假报错（实测踩过）。
  s=await ev(`(()=>{
    const _sr=showResult;
    showResult=function(res){ window.__fan=res.pat?res.pat.fan:1; return _sr.apply(this,arguments); };
    showResult._t=_sr._t;
    G.hands[0]=emptyC();[0,0,0,1,1,1,2,2,2,3,3,3,4,4].forEach(c=>G.hands[0][c]++);
    G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.wall=[];G.tingFlag=false;
    for(let i=0;i<23;i++)G.wall.push(i%27);
    G.firstDraw=[false,false,false,false];
    window.__snd=[];window.__fan=null;doHu(0,-1,true);
    const out={snd:window.__snd,fan:window.__fan};
    showResult=_sr;
    return out;
  })()`);
  console.log('  '+JSON.stringify(s));
  const zimoName=((s.fan||1)>=17)?'huBig':'zimo';
  const byName=Object.fromEntries((s.snd||[]).map(x=>[x[0],x[1]]));
  ok(s.snd.some(x=>x[0]===zimoName),'自摸胡 → '+(zimoName==='huBig'?'大牌型音（结算 '+s.fan+' 番 ≥17）':'自摸音（结算 '+s.fan+' 番）'));
  ok(byName['chicken']===0.75,'翻鸡牌音延后 0.75 秒（排在胡牌音之后，不糊在一起）',byName['chicken']);
  ok(byName['settle']===1.1,'结算窗音延后 1.1 秒（落在长音尾巴上）',byName['settle']);
  ok((s.snd.find(x=>x[0]===zimoName)||[])[1]===0,'胡牌音立刻响（延迟 0）');

  // 5.6 抢杠：玩家能抢 → 亮提示音；电脑抢 → 抢杠音
  s=await ev(`(()=>{
    const r={};
    const tingHand=[0,0,0,1,1,1,2,2,2,3,3,4,4];        // 13 张，叫 4
    G.hands[0]=emptyC();tingHand.forEach(c=>G.hands[0][c]++);
    G.melds=[[],[{type:'peng',card:4,from:0}],[],[]];
    G.hands[1]=emptyC();G.hands[1][4]=1;G.hands[2]=emptyC();G.hands[3]=emptyC();
    G.phase='discard';G.pendingAction=null;G.actions=[];G.discards=[[4],[],[],[]];
    window.__snd=[];doBuGang(1,4);r.playerQG=window.__snd.slice(0,3);
    // 换成立家(2)叫牌 → 电脑抢
    G.hands[0]=emptyC();[0,1,2,3,5,6,7,8,9,10,11,12,13].forEach(c=>G.hands[0][c]++);
    G.hands[2]=emptyC();tingHand.forEach(c=>G.hands[2][c]++);
    G.melds=[[],[{type:'peng',card:4,from:0}],[],[]];
    G.hands[1]=emptyC();G.hands[1][4]=1;G.hands[3]=emptyC();
    G.phase='discard';G.pendingAction=null;G.actions=[];G.discards=[[4],[],[],[]];G.wall=[];for(let i=0;i<20;i++)G.wall.push(i%27);
    window.__snd=[];doBuGang(1,4);r.aiQG=window.__snd.slice(0,3).map(x=>x[0]);
    return r;
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.playerQG[0][0]==='bugang'&&s.playerQG.some(x=>x[0]==='huReady'),'补杠后你能抢杠胡 → 补杠音 + 最亮的提示音');
  ok(s.aiQG.includes('qianggang'),'电脑抢杠胡 → 抢杠音',s.aiQG);

  // 5.7 叫牌提示音 / 荒庄
  s=await ev(`(()=>{
    const r={};
    G.hands=[[],[],[],[]].map(()=>emptyC());
    [0,0,0,1,1,1,2,2,2,3,3,3,4,4].forEach(c=>G.hands[0][c]++);
    G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.phase='discard';G.turn=0;G.pendingAction=null;G.tingFlag=false;
    G.wall=[];for(let i=0;i<20;i++)G.wall.push(i%27);
    window.__snd=[];discard(0,3);                       // 打出多余的 3 → 成叫牌（叫 4）
    r.ting=window.__snd.map(x=>x[0]).slice(0,3);
    r.isTing=isTing(0);
    window.__snd=[];endGame();r.liuju=window.__snd.map(x=>x[0]).slice(0,2);
    return r;
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.isTing===true,'打出后确实成叫牌（否则这条断言没意义）');
  ok(s.ting.includes('ting'),'刚叫牌 → 金铃提示音',s.ting);
  ok(s.liuju.includes('liuju'),'荒庄 → 下行两音',s.liuju);

  console.log('\n===== ⑥ 音效开关与全屏按钮不打架 =====');  s=await ev(`(()=>{
    document.body.className=document.body.className.replace(/isResult|isDice|isName/g,'');
    const R=id=>{const e=document.getElementById(id);if(!e)return null;const b=e.getBoundingClientRect();
      return {l:Math.round(b.left),t:Math.round(b.top),r:Math.round(b.right),b:Math.round(b.bottom),
              vis:getComputedStyle(e).display!=='none'};};
    return {fs:R('fsBtn'),snd:R('sndBtn')};
  })()`);
  console.log('  '+JSON.stringify(s));
  const ov=(a,b)=>a&&b&&a.l<b.r&&b.l<a.r&&a.t<b.b&&b.t<a.b;
  ok(s.snd&&s.snd.vis,'音效按钮在牌局中可见');
  ok(!ov(s.fs,s.snd),'音效按钮与全屏按钮不重叠',
     '音效 '+JSON.stringify(s.snd)+' 全屏 '+JSON.stringify(s.fs));

  if(errs.length)console.log('\n页面异常:\n'+errs.join('\n'));
  console.log('\n>>> '+(FAIL?'❌ '+FAIL+' 项不通过':'✅ 全部 '+PASS+' 项通过'));
  ws.close();proc.kill();
  await sleep(500);
  try{fs.renameSync(PROFILE,path.join(BASE,'_trash_sound_'+Date.now()));}catch(e){}
  process.exit(FAIL?1:0);
})();
