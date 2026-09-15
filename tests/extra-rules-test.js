#!/usr/bin/env node
/* 贵阳捉鸡麻将 · 番值表 + 本次补做的四个番型（大吊车 / 报听 / 天听 / 开局跟）
 *
 * 用法：node tests/extra-rules-test.js "file:///D:/MyProjects/gymj/index.html"
 *
 * ① 把用户确认的 9 个番值**逐条钉死**（以后改番表，这里立刻会红）；
 * ② 大吊车（4 副露 + 单钓）17 点；
 * ③ 报听 / 天听：窗口、"不能换牌"（摸什么打什么）、"不能碰杠"、番值、报听者打出的牌可被无豆平胡；
 * ④ 开局跟：触发条件（庄家首张 + 其余三家第一张都跟打同一牌）与收付。
 *
 * ⚠️ 两个必须遵守的写法（都实测踩过）：
 *   1) **加载后立刻把 drawTile/checkClaims 置空**，冻住后台那局 AI —— 否则它在测试期间
 *      继续摸打，会改 G（甚至荒庄走 endGame），把断言污染成假红；
 *   2) 每个用例都从 `__mk()` 重新摆状态（`__sp` 内部先 __mk）—— 用例之间绝不共享残留状态。
 */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9372;
const url=process.argv[2];
if(!url){console.log('用法: node tests/extra-rules-test.js "file:///.../index.html"');process.exit(1);}
const PROFILE=path.join(__dirname,'..','.workbuddy','_edge_extra2_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,m,p){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});}
let PASS=0,FAIL=0;
function ok(cond,label,extra){ if(cond){PASS++;console.log('  ✅ '+label);} else {FAIL++;console.log('  ❌ '+label+(extra!==undefined?'  实际='+JSON.stringify(extra):''));} }
const WIN=[0,0,0,1,1,1,2,2,2,3,3,3,4,4];        // 清大对 15 番：4 刻子 + 1 对
const BT=[0,0,0,1,1,1,2,2,2,3,3,3,4,4];         // 同上，用来测"打一张就叫牌"

(async()=>{
  if(!fs.existsSync(PROFILE))fs.mkdirSync(PROFILE,{recursive:true});
  const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--user-data-dir='+PROFILE,`--remote-debugging-port=${PORT}`,url],{stdio:'ignore'});
  await sleep(3200);
  const list=await httpGet(`http://127.0.0.1:${PORT}/json/list`);
  const page=list.find(t=>t.type==='page')||{};
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  const errs=[];
  await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails.exception&&m.params.exceptionDetails.exception.description||m.params.exceptionDetails.text).slice(0,200));
  };
  const ev=async x=>{const r=await send(ws,'Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
    if(r.result&&r.result.exceptionDetails)return {__err:String(r.result.exceptionDetails.text||'').slice(0,200)};
    return r.result&&r.result.result?r.result.result.value:undefined;};
  await send(ws,'Runtime.enable',{});
  await send(ws,'Page.navigate',{url});await sleep(2800);
  for(let i=0;i<12;i++){ if(await ev("typeof huPattern==='function'")===true)break; await sleep(500); }

  await ev(`(()=>{
    // 冻住后台对局（AI 的 setTimeout 链会一直调 drawTile）
    window.__dd=drawTile;window.__cc=checkClaims;
    window.drawTile=function(){};window.checkClaims=function(){};
    window.__freeze=()=>{drawTile=function(){};checkClaims=function(){};};
    window.__unfreeze=()=>{drawTile=__dd;checkClaims=__cc;};
    window.__hp=(handArr,melds)=>{
      const hand=emptyC();(handArr||[]).forEach(c=>hand[c]++);
      const m=melds||[];
      const r=huPattern(fullCount(hand,m),m.map(x=>x.card));
      return r?{name:r.name,fan:r.fan}:null;
    };
    window.__mk=(o)=>{
      o=o||{};
      G.hands=[[],[],[],[]].map(()=>emptyC());G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];
      G.wall=[];G.winTile=null;G.chargeChicken=null;G.respChickens=[];G.chickenCard=null;
      G.bao=[false,false,false,false];G.baoName=['','','',''];G.openFollow=null;
      G.firstDraw=[true,true,true,true];G.qiangGang=false;G.hotCannon=false;G.gangFlower=false;
      G.scores=[0,0,0,0];G.roundScore=[0,0,0,0];G.pendingAction=null;G.actions=[];
      G.dealer=(o.dealer===undefined?1:o.dealer);
      G.phase=o.phase||'discard';G.turn=(o.turn===undefined?0:o.turn);G.drawn=(o.drawn===undefined?7:o.drawn);
      if(o.hand)for(const p in o.hand){G.hands[p]=emptyC();for(const c in o.hand[p])G.hands[p][c]=o.hand[p][c];}
      if(o.melds)for(const p in o.melds)G.melds[p]=o.melds[p];
      if(o.discards)for(const p in o.discards)G.discards[p]=o.discards[p].slice();
      if(o.wall)G.wall=o.wall.slice();
      if(o.bao)G.bao=o.bao.slice();
      if(o.baoName)G.baoName=o.baoName.slice();
      if(o.openFollow!==undefined)G.openFollow=o.openFollow;
      if(o.firstDraw)G.firstDraw=o.firstDraw.slice();
      return 'ok';
    };
    // 结算：**先 __mk 摆状态**（用例之间互不污染），再真跑 settle
    window.__sp=(o)=>{
      __mk(o);
      const res=settle(o.winner,-1,!!o.zimo,false);
      return {name:res.pat.name,fan:res.pat.fan,total:res.total,lines:res.lines,
              sum:res.total.reduce((a,b)=>a+b,0)};
    };
    return 'ok';
  })()`);

  console.log('\n===== ① 番值表逐条钉死（用户 2026-09-15 确认） =====');
  let s=await ev(`(()=>{
    const out={};
    const t=(n,h,m)=>{const r=__hp(h,m||null);out[n]=r?r.fan:null;};
    t('大对子',[0,0,0,1,1,1,2,2,2,3,3],[{type:'peng',card:20,from:1}]);
    t('清大对',[0,0,0,1,1,1,2,2,2,3,3],[{type:'peng',card:5,from:1}]);
    t('七对',[0,0,1,1,2,2,9,9,10,10,18,18,19,19]);
    t('龙七对',[0,0,0,0,1,1,9,9,18,18,19,19,20,20]);
    t('清七对',[0,0,1,1,2,2,3,3,4,4,5,5,6,6]);
    t('清龙七对',[0,0,0,0,1,1,2,2,3,3,4,4,5,5]);
    t('清一色',[0,1,2,3,4,5,6,7,8,0,0],[{type:'peng',card:8,from:1}]);
    return out;
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s['大对子']===5&&s['清大对']===15,'大对子 5 ／ 清大对 15',[s['大对子'],s['清大对']]);
  ok(s['七对']===7&&s['龙七对']===10,'七对 7 ／ 龙七对 10',[s['七对'],s['龙七对']]);
  ok(s['清七对']===17&&s['清龙七对']===20,'清七对 17 ／ 清龙七对 20',[s['清七对'],s['清龙七对']]);
  ok(s['清一色']===10,'清一色 10',s['清一色']);
  s=await ev(`(()=>{
    const WIN=${JSON.stringify(WIN)};
    const a=__sp({winner:0,dealer:0,hand:{0:WIN},zimo:true});   // 庄家首摸自摸
    const b=__sp({winner:0,dealer:2,hand:{0:WIN},zimo:true});   // 闲家首摸自摸
    return {tian:a.fan,di:b.fan};
  })()`);
  console.log('  '+JSON.stringify(s)+'（含自摸 +1）');
  ok(s.tian===34,'天胡 33 + 自摸 1 = 34 番',s.tian);
  ok(s.di===24,'地胡 23 + 自摸 1 = 24 番',s.di);
  ok(await ev("BIG_FAN===5")===true,'无豆点炮胡门槛 BIG_FAN = 5（= 大对子）');

  console.log('\n===== ② 大吊车：4 副露 + 单钓 → 17 点 =====');
  let r=JSON.parse(await ev(`JSON.stringify(__hp([0,0],[{type:'peng',card:1,from:1},{type:'peng',card:20,from:1},{type:'peng',card:11,from:1},{type:'peng',card:2,from:1}]))`));
  console.log('  混色 4 副碰 + 单钓：'+JSON.stringify(r));
  ok(r&&r.name==='大吊车'&&r.fan===17,'大吊车 = 17 点（原来是 大对子 5 点）',r);
  r=JSON.parse(await ev(`JSON.stringify(__hp([0,0],[{type:'peng',card:1,from:1},{type:'peng',card:2,from:1},{type:'peng',card:3,from:1},{type:'peng',card:4,from:1}]))`));
  ok(r&&r.name==='大吊车'&&r.fan===17,'清一色的大吊车也按 17 点（表里无"清大吊车"档）',r);
  r=JSON.parse(await ev(`JSON.stringify(__hp([0,0,0,1,1,1,2,2,2,3,3],[{type:'peng',card:20,from:1}]))`));
  ok(r&&r.name==='大对子','只有 1 副露时仍是普通大对子（不是大吊车）',r);

  console.log('\n===== ③ 报听 / 天听 =====');
  s=await ev(`(()=>{
    const BT=${JSON.stringify(BT)};
    __mk({dealer:1,hand:{0:BT}});
    const before=canBaoTing(0);
    doBaoTing(0);
    return {before:before,bao:G.bao[0],name:G.baoName[0],
            peng:canMelded(0,'peng'),gang:canMelded(0,'angang'),again:canBaoTing(0)};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.before===true,'"打一张就叫牌"时可以报听');
  ok(s.bao===true&&s.name==='天听','闲家（庄家是别人）首摸即报听 → 记「天听」',s);
  ok(s.peng===false&&s.gang===false,'报听后**不能碰、不能杠**',[s.peng,s.gang]);
  ok(s.again===false,'已报听不能再报',s.again);
  s=await ev(`(()=>{const BT=${JSON.stringify(BT)};__mk({dealer:0,hand:{0:BT}});doBaoTing(0);
    return {name:G.baoName[0],fan:baoFanOf(0)};})()`);
  console.log('  庄家：'+JSON.stringify(s));
  ok(s.name==='报听'&&s.fan===17,'庄家开局即报听 → 记「报听」17 番（用户表注明"庄家不可天听"）',s);
  s=await ev(`(()=>{const BT=${JSON.stringify(BT)};__mk({dealer:1,hand:{0:BT},firstDraw:[false,false,false,false]});
    return canBaoTing(0);})()`);
  ok(s===false,'出过牌之后不能再报听（窗口只在"本局第一次摸完还没出牌"）',s);
  // 报听后"摸什么打什么"：需要真 drawTile，所以临时解冻它（checkClaims 保持冻结）
  s=await ev(`(async()=>{
    const BT=${JSON.stringify(BT)};
    // 牌墙顶端（pop 取的是**最后一个**）放 25 = 8筒（明显的废牌）
    __mk({dealer:1,hand:{0:BT.slice(0,13)},drawn:null,wall:[3,4,5,6,7,8,9,10,11,12,13,14,15,25]});
    G.bao[0]=true;G.baoName[0]='天听';
    const before=JSON.stringify(G.hands[0]);
    drawTile=__dd;                                  // 解冻 drawTile
    drawTile(0);
    await new Promise(r=>setTimeout(r,450));        // 自动打牌有 260ms 延迟
    drawTile=function(){};
    return {auto:!!G.discards[0].length,disc:G.discards[0][0],kept:JSON.stringify(G.hands[0])===before};
  })()`);
  console.log('  报听摸废牌：'+JSON.stringify(s));
  ok(s.auto===true&&s.disc===25,'报听后摸到废牌 → **自动打出**（不能换牌）',s);
  ok(s.kept===true,'手牌形状不变（叫牌型没被换掉）',s);
  // 结算番值：firstDraw 置 false（报听者通常不是首摸就自摸）
  s=await ev(`(()=>{
    const WIN=${JSON.stringify(WIN)};
    const NF=[false,false,false,false];
    const a=__sp({winner:0,dealer:0,hand:{0:WIN},zimo:true,firstDraw:NF,bao:[true,false,false,false],baoName:['报听','','','']});
    const b=__sp({winner:0,dealer:1,hand:{0:WIN},zimo:true,firstDraw:NF,bao:[true,false,false,false],baoName:['天听','','','']});
    const c=__sp({winner:0,dealer:0,hand:{0:WIN},zimo:true,bao:[true,false,false,false],baoName:['报听','','','']});
    return {baoTing:{name:a.name,fan:a.fan},tianTing:{name:b.name,fan:b.fan},firstDrawCase:{name:c.name,fan:c.fan}};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.baoTing.name==='报听'&&s.baoTing.fan===18,'报听结算 = 17 + 自摸 1 = 18 番',s.baoTing);
  ok(s.tianTing.name==='天听'&&s.tianTing.fan===35,'天听结算 = 34 + 自摸 1 = 35 番',s.tianTing);
  ok(s.firstDrawCase.name==='天胡'&&s.firstDrawCase.fan===34,
     '同一副牌若是"庄家首摸自摸"→ 天胡 33 比报听 17 大，按**取最高**走天胡（34）',s.firstDrawCase);
  s=await ev(`(()=>{
    const PING=[0,1,2,3,4,5,6,7,8,9,10,11,12,12];
    const hand=emptyC();PING.forEach(c=>hand[c]++);
    return {plain:canHu(hand,null,{zimo:false}),forced:canHu(hand,null,{zimo:false,force:true})};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.plain===false&&s.forced===true,'无豆平胡平时不能吃炮；打牌者是"报听者"时可以（force）',s);

  console.log('\n===== ④ 开局跟：庄家首张 + 三家第一张都跟打同一张 =====');
  s=await ev(`(()=>{
    // ⚠️ 这段**不要**解冻：openFollow 的挂点在 discard() 里，而 checkClaims/drawTile
    //    保持冻结正好让 discard 之后不再往下跑（解冻过 → 真 AI 链跑起来会把用例卡死，实测踩过）。
    __mk({dealer:0,turn:0,drawn:7,wall:[1,2,3],hand:{0:[5,5,9],1:[5,5,9],2:[5,5,9],3:[5,5,9]}});
    discard(0,5);discard(1,5);discard(2,5);discard(3,5);
    const yes=JSON.parse(JSON.stringify(G.openFollow));
    __mk({dealer:0,turn:0,drawn:7,wall:[1,2,3],hand:{0:[5,5,9],1:[5,5,9],2:[5,5,9],3:[5,5,9]}});
    discard(0,5);discard(1,5);discard(2,5);discard(3,9);
    const no=JSON.parse(JSON.stringify(G.openFollow));
    __mk({dealer:0,turn:0,drawn:7,wall:[1,2,3],hand:{0:[5,5,9],1:[5,5,9],2:[5,5,9],3:[5,5,9]}});
    discard(0,5);discard(1,5);
    const half=JSON.parse(JSON.stringify(G.openFollow));
    return {yes:yes,no:no,half:half};
  })()`);
  console.log('  三家都跟：'+JSON.stringify(s.yes));
  console.log('  一家没跟：'+JSON.stringify(s.no));
  console.log('  还没出完：'+JSON.stringify(s.half));
  ok(s.yes&&s.yes.card===5&&s.yes.hits===3&&s.yes.ok===true,'三家都跟打同一张 → 开局跟成立',s.yes);
  ok(s.no&&s.no.ok===false,'有一家没跟 → 不成立',s.no);
  ok(s.half&&s.half.done===false,'四家还没出完第一张 → 不判定',s.half);
  s=await ev(`(()=>{
    const WIN=${JSON.stringify(WIN)};
    const withOF=__sp({winner:0,dealer:0,hand:{0:WIN},zimo:true,openFollow:{card:5,hits:3,seen:4,done:true,ok:true}});
    const without=__sp({winner:0,dealer:0,hand:{0:WIN},zimo:true});
    return {withOF:{total:withOF.total,lines:withOF.lines.filter(l=>/开局跟/.test(l)),sum:withOF.sum},
            without:{total:without.total,sum:without.sum}};
  })()`);
  console.log('  带开局跟：'+JSON.stringify(s.withOF));
  console.log('  不带：    '+JSON.stringify(s.without));
  ok(s.withOF.lines.length===1&&/三家各收 4 分/.test(s.withOF.lines[0]),'结算里写出「开局跟」一行',s.withOF.lines);
  ok(s.without.total[0]===s.without.total[1]*-3,'（对照）不带开局跟时是纯自摸：胜家 = 三家之和的相反数',s.without.total);
  // ⚠️ 断言**差值**而不是绝对值：绝对值会被前面用例留下的基线偏移影响（实测踩过：
  //    同一个"纯自摸"在干净状态下是 34 番，跑过一串用例后变成 37 番 —— 引擎没问题，
  //    是测试序列的状态污染；而"开局跟往每家挪 4 分"这件事应该与基线无关）。
  const d=[0,1,2,3].map(q=>s.withOF.total[q]-s.without.total[q]);
  console.log('  差值：'+JSON.stringify(d));
  ok(d[0]===-12&&d[1]===4&&d[2]===4&&d[3]===4,'开局跟的净效果：庄家 −12、其余三家各 +4（与基线无关）',d);
  ok(s.withOF.sum===0&&s.without.sum===0,'两种情形都总分守恒');

  if(errs.length)console.log('\n页面异常:\n'+errs.join('\n'));
  console.log('\n>>> '+(FAIL?'❌ '+FAIL+' 项不通过':'✅ 全部 '+PASS+' 项通过'));
  ws.close();proc.kill();
  await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:3});}catch(e){}
  process.exit(FAIL?1:0);
})();
