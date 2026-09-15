#!/usr/bin/env node
/* 贵阳捉鸡麻将 · 番型（胡牌类型）核查自测
 *
 * 用法：node tests/hu-type-test.js "file:///D:/MyProjects/gymj/index.html"
 *
 * 目的：把"每种胡牌类型到底判成什么"钉成断言。这类 bug 在界面上极难发现 ——
 * 用户实测报的"大对子被写成清大对"，根因就是**判清一色时只用暗牌、漏了副露**，
 * 而截图看起来只是"名字多了一个字"。
 * 每条断言都同时打印实际番值，方便和规则表逐条对照。
 */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9366;
const url=process.argv[2];
if(!url){console.log('用法: node tests/hu-type-test.js "file:///.../index.html"');process.exit(1);}
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_edge_hu_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,method,params){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method,params}));});}
let PASS=0,FAIL=0;
function ok(cond,label,extra){ if(cond){PASS++;console.log('  ✅ '+label);} else {FAIL++;console.log('  ❌ '+label+(extra!==undefined?'  实际='+JSON.stringify(extra):''));} }

(async()=>{
  if(!fs.existsSync(PROFILE))fs.mkdirSync(PROFILE,{recursive:true});
  const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--user-data-dir='+PROFILE,`--remote-debugging-port=${PORT}`,url],{stdio:'ignore'});
  await sleep(3200);
  let list;try{list=await httpGet(`http://127.0.0.1:${PORT}/json/list`);}catch(e){console.log('CDP 失败 '+e.message);proc.kill();return;}
  const page=list.find(t=>t.type==='page')||{};
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  const errs=[];
  await new Promise(r=>ws.onopen=r);
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails.exception&&m.params.exceptionDetails.exception.description||m.params.exceptionDetails.text).slice(0,200));
  };
  const ev=async expr=>{
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return {__err:String((ed.exception&&ed.exception.description)||ed.text).slice(0,300)};
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  await send(ws,'Runtime.enable',{});await send(ws,'Page.enable',{});
  await send(ws,'Page.navigate',{url});await sleep(2800);
  for(let i=0;i<12;i++){ if(await ev("typeof huPattern==='function'")===true)break; await sleep(500); }

  await ev(`(()=>{
    window.__hp=(handArr,melds)=>{
      const hand=emptyC();(handArr||[]).forEach(c=>hand[c]++);
      const m=melds||[];
      const c=fullCount(hand,m);
      const r=huPattern(c,m.map(x=>x.card));
      return r?{name:r.name,fan:r.fan}:null;
    };
    window.__sp=(o)=>{                                    // 真跑一遍 settle，查看牌型名与番数
      G.hands=[[],[],[],[]].map(()=>emptyC());G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];
      G.scores=[0,0,0,0];G.roundScore=[0,0,0,0];G.qiangGang=false;G.hotCannon=false;
      G.gangFlower=false;G.chargeChicken=null;G.respChickens=[];G.winTile=null;
      G.hands[o.winner]=emptyC();o.hand.forEach(c=>G.hands[o.winner][c]++);
      [0,1,2,3].forEach(p=>{if(p!==o.winner)G.hands[p]=emptyC();});
      G.dealer=o.dealer;G.firstDraw=[false,false,false,false];G.firstDraw[o.winner]=!!o.first;
      G.wall=[];for(let i=0;i<20;i++)G.wall.push(i%27);
      const res=settle(o.winner,-1,!!o.zimo,false);
      return {name:res.pat.name,fan:res.pat.fan,line:res.lines[0]};
    };
    return 'ok';
  })()`);

  const hp=async(hand,melds)=>await ev(`JSON.stringify(__hp(${JSON.stringify(hand)},${JSON.stringify(melds||null)}))`).then(JSON.parse);
  const PENG=(card)=>({type:'peng',card:card,from:1});

  console.log('\n===== ① 「清」= 整副牌（暗牌 + 副露）同花色 ← 用户报的 bug =====');
  // 手里：1万刻 2万刻 3万刻 + 4万对；副露：3筒碰  → 整副牌有两门 → 只能是大对子
  let r=await hp([0,0,0,1,1,1,2,2,2,3,3],[PENG(20)]);
  console.log('  手里全万 + 副露 3筒碰 → '+JSON.stringify(r));
  ok(r&&r.name==='大对子','手里全万但**副露是筒** → 判「大对子」，不是清大对（旧实现这里判错）',r);
  r=await hp([0,0,0,1,1,1,2,2,2,3,3],[PENG(5)]);      // 副露也是万
  console.log('  手里全万 + 副露 6万碰 → '+JSON.stringify(r));
  ok(r&&r.name==='清大对','副露也是万 → 才是「清大对」',r);
  r=await hp([0,0,0,1,1,1,2,2,2,3,3,3,4,4],[]);        // 无副露，全万
  ok(r&&r.name==='清大对','无副露、14 张全万 → 「清大对」',r);
  r=await hp([0,1,2,3,4,5,6,7,8,0,0],[PENG(20)]);
  ok(r&&r.name==='平胡','顺子牌型 + 副露是筒 → 「平胡」，不是清一色（旧实现判错）',r);
  r=await hp([0,1,2,3,4,5,6,7,8,0,0],[PENG(8)]);
  console.log('  123/456/789万 + 11万对 + 副露 9万碰 → '+JSON.stringify(r));
  ok(r&&r.name==='清一色','顺子牌型且副露同花色 → 「清一色」',r);

  console.log('\n===== ② 七对类：四个相同算两个对子 / 龙七对 =====');
  const QM=[0,0,1,1,2,2,9,9,10,10,18,18,19,19];        // 万/条/筒 混色的 7 对（非清一色）
  r=await hp(QM,[]);
  console.log('  7 个对子（混色、无四归一）→ '+JSON.stringify(r));
  ok(r&&r.name==='七对','七对（无四归一）',r);
  r=await hp([0,0,0,0,1,1,9,9,18,18,19,19,20,20],[]);
  console.log('  混色七对 + 一个四归一 → '+JSON.stringify(r));
  ok(r&&r.name==='龙七对','含 1 组四归一（4 张相同）= 龙七对',r);
  const spInfo=await ev(`(()=>{const c=emptyC();[0,0,0,0,1,1,2,2,3,3,4,4,5,5].forEach(x=>c[x]++);return JSON.stringify(sevenPairsInfo(c));})()`);
  console.log('  sevenPairsInfo(含四归一的七对) = '+spInfo);
  ok(/"quads":1/.test(String(spInfo)),'四个相同被识别为「1 组四归一」（即作 2 个对子用）',spInfo);
  r=await hp([0,0,1,1,2,2,3,3,4,4,5,5,6,6],[]);
  ok(r&&r.name==='清七对','同花色 7 对且无四归一 → 「清七对」',r);
  r=await hp([0,0,0,0,1,1,2,2,3,3,4,4,5,5],[]);
  ok(r&&r.name==='清龙七对','同花色 7 对且含四归一 → 「清龙七对」（即规则表的"清龙背"）',r);
  r=await hp(QM,[PENG(20)]);
  ok(!r||r.name.indexOf('七对')<0,'有副露时**不可能**是七对',r);

  console.log('\n===== ③ 大对子 / 大吊车（4 副露 + 单钓） =====');
  // 本作**没有吃**，4 副露必然都是碰/杠（刻子）→ 大吊车 = 4 刻 + 单钓
  r=await hp([0,0],[PENG(1),PENG(20),PENG(11),PENG(2)]);
  console.log('  4 副碰（混色）+ 单钓 11万对 → '+JSON.stringify(r));
  ok(r&&r.name==='大吊车'&&r.fan===17,'大吊车（4 副露 + 单钓）= 17 番独立番型',r);
  r=await hp([0,0],[PENG(1),PENG(2),PENG(3),PENG(4)]);
  console.log('  4 副碰（全万）+ 单钓 11万对 → '+JSON.stringify(r));
  ok(r&&r.name==='大吊车'&&r.fan===17,'4 副露同花色也算大吊车 17 番（表里没有"清大吊车"档，取最高 17 > 清大对 15）',r);

  console.log('\n===== ④ 天胡 / 地胡（自摸 + 是否首次摸牌） =====');
  const WIN=[0,0,0,1,1,1,2,2,2,3,3,3,4,4];
  let s=await ev(`JSON.stringify(__sp({winner:0,hand:${JSON.stringify(WIN)},dealer:0,first:true,zimo:true}))`).then(JSON.parse);
  console.log('  庄家 + 首摸 + 自摸 → '+JSON.stringify(s));
  ok(s.name==='天胡','庄家第一次摸牌就自摸 → 天胡（'+s.fan+' 番）',s);
  s=await ev(`JSON.stringify(__sp({winner:1,hand:${JSON.stringify(WIN)},dealer:0,first:true,zimo:true}))`).then(JSON.parse);
  console.log('  闲家 + 首摸 + 自摸 → '+JSON.stringify(s));
  ok(s.name==='地胡','**非庄家**第一次摸牌就自摸 → 地胡（'+s.fan+' 番）',s);
  s=await ev(`JSON.stringify(__sp({winner:1,hand:${JSON.stringify(WIN)},dealer:0,first:false,zimo:true}))`).then(JSON.parse);
  ok(s.name!=='地胡','闲家**第二次**摸牌自摸 → 不是地胡（实际 '+s.name+'）',s);
  s=await ev(`JSON.stringify(__sp({winner:1,hand:${JSON.stringify(WIN)},dealer:0,first:true,zimo:false}))`).then(JSON.parse);
  ok(s.name!=='地胡','闲家首巡**点炮**胡 → 不是地胡（实际 '+s.name+'）',s);
  s=await ev(`JSON.stringify(__sp({winner:0,hand:${JSON.stringify(WIN)},dealer:0,first:false,zimo:true}))`).then(JSON.parse);
  ok(s.name!=='天胡','庄家第二次摸牌自摸 → 不是天胡（实际 '+s.name+'）',s);

  console.log('\n===== ⑤ 各番型番值现状（供与规则表逐条对照） =====');
  s=await ev(`(()=>{
    const L=[];
    const t=(n,h,m)=>{const r=__hp(h,m);L.push(n+' = '+(r?r.name+' '+r.fan+' 番':'—'));};
    t('平胡',[0,1,2,3,4,5,6,7,8,0,0],[{type:'peng',card:20,from:1}]);
    t('清一色',[0,1,2,3,4,5,6,7,8,0,0],[{type:'peng',card:8,from:1}]);
    t('大对子',[0,0,0,1,1,1,2,2,2,3,3],[{type:'peng',card:20,from:1}]);
    t('清大对',[0,0,0,1,1,1,2,2,2,3,3],[{type:'peng',card:5,from:1}]);
    t('七对',[0,0,1,1,2,2,9,9,10,10,18,18,19,19]);
    t('龙七对',[0,0,0,0,1,1,9,9,18,18,19,19,20,20]);
    t('清七对',[0,0,1,1,2,2,3,3,4,4,5,5,6,6]);
    t('清龙七对',[0,0,0,0,1,1,2,2,3,3,4,4,5,5]);
    return {rows:L,BIG_FAN:BIG_FAN};
  })()`);
  console.log('  '+s.rows.join('\n  '));
  console.log('  （无豆点炮胡的门槛 BIG_FAN = '+s.BIG_FAN+' → 等于"大对子及以上"）');
  ok(s.BIG_FAN===5,'无豆吃胡门槛 = 大对子（BIG_FAN='+s.BIG_FAN+'）—— 若按规则表把大对改成 12 点，这个数要同步改成 12');
  ok(s.rows.length===8,'番值现状已逐条打印（见上）');

  if(errs.length)console.log('\n页面异常:\n'+errs.join('\n'));
  console.log('\n>>> '+(FAIL?'❌ '+FAIL+' 项不通过':'✅ 全部 '+PASS+' 项通过'));
  ws.close();proc.kill();
  await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:3});}catch(e){}
  process.exit(FAIL?1:0);
})();
