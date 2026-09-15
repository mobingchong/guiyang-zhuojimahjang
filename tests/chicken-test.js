#!/usr/bin/env node
/* 贵阳捉鸡麻将 · 鸡牌规则自测（归属 / 翻牌 / 冲锋 / 责任 / 捉鸡 + 明细输出）
 *
 * 用法：node tests/chicken-test.js "file:///D:/MyProjects/gymj/index.html"
 *
 * 为什么单独一套：鸡分是**纯规则计算**，用界面截图完全看不出来对错；
 * 而且五条规则之间有交叉（比如"未叫家手里的鸡不算" vs "捉鸡无论在手都赔"），
 * 只有把每种组合都钉成断言，才能保证以后改规则不会把边界改坏。
 *
 * 每条用例都直接摆好牌局状态 → 调 chickenSettle() → 断言【逐家收付】+【明细文字】。
 * 另外每条用例都查一个守恒不变量：四家收付之和必须为 0（鸡分只是转移，不凭空产生）。
 */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9364;
const url=process.argv[2];
if(!url){console.log('用法: node tests/chicken-test.js "file:///.../index.html"');process.exit(1);}
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_edge_chicken_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,method,params){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method,params}));});}

let PASS=0,FAIL=0;
function ok(cond,label,extra){ if(cond){PASS++;console.log('  ✅ '+label);} else {FAIL++;console.log('  ❌ '+label+(extra!==undefined?'  实际='+JSON.stringify(extra):''));} }
const T=p=>JSON.stringify(p);

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
    if(m.method==='Runtime.exceptionThrown')errs.push(String(m.params.exceptionDetails.exception&&m.params.exceptionDetails.exception.description||m.params.exceptionDetails.text).slice(0,220));
  };
  const ev=async expr=>{
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return {__err:String((ed.exception&&ed.exception.description)||ed.text).slice(0,300)};
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  await send(ws,'Runtime.enable',{});await send(ws,'Page.enable',{});
  await send(ws,'Emulation.setDeviceMetricsOverride',{width:400,height:871,deviceScaleFactor:1,mobile:true});
  await send(ws,'Page.navigate',{url});await sleep(2800);
  for(let i=0;i<12;i++){ if(await ev("typeof chickenSettle==='function'")===true)break; await sleep(500); }
  if(await ev("typeof chickenSettle==='function'")!==true){console.log('❌ 页面里找不到 chickenSettle');proc.kill();process.exit(1);}

  // 页面内测试脚手架：__mk 摆好状态，__run 跑结算并回收结果
  await ev(`(()=>{
    window.__JUNK=[0,2,4,6,8,10,12,14,16,18,20,22,24];      // 13 张全孤张 → 一定不是叫牌
    window.__TING13=[0,0,0,1,1,1,2,2,2,3,3,4,4];            // 13 张，叫 4（叫牌家）
    window.__mk=(o)=>{
      o=o||{};
      G.hands=[[],[],[],[]].map(()=>emptyC());G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];
      G.wall=[];G.winTile=null;G.chargeChicken=null;G.respChickens=[];
      G.chickenCard=(o.fc===undefined?5:o.fc);               // 默认翻 5万 → 鸡牌 6万
      // 默认四家都是 13 张孤张（保证"未叫"）；o.hand 是在这基础上**加牌**，
      // o.setHand 才是整手替换（造"叫牌"才用它）。
      // ⚠️ 别拿"只给 1 张牌"当未叫家的手牌：1 张补 1 张就是一对，canHuShape 会判 true
      //    → isTing 变真 → 那家成了"叫牌家"，整条用例就反了（实测踩过一次）。
      [0,1,2,3].forEach(p=>__JUNK.forEach(c=>G.hands[p][c]++));
      if(o.hand)for(const p in o.hand){for(const c in o.hand[p])G.hands[p][c]=(G.hands[p][c]||0)+o.hand[p][c];}
      if(o.setHand)for(const p in o.setHand){G.hands[p]=emptyC();for(const c in o.setHand[p])G.hands[p][c]=o.setHand[p][c];}
      if(o.disc)for(const p in o.disc)G.discards[p]=o.disc[p].slice();
      if(o.meld)for(const p in o.meld)G.melds[p]=o.meld[p];
      if(o.charge)G.chargeChicken=o.charge;
      if(o.resp)G.respChickens=[o.resp];          // 单条（旧写法仍可用）
      if(o.resps)G.respChickens=o.resps.slice();  // 多条：同一家可能有多张鸡都被碰/杠走
      return 'ok';
    };
    window.__run=(winner,opts)=>{
      __mk(opts);
      const total=[0,0,0,0],lines=[];
      const res=chickenSettle(winner,lines,total);
      return {total:total,lines:lines,called:res.called,fc:res.fieldChicken,
              p0:[0,1,2,3].map(p=>isTing(p))};
    };
    return 'ok';
  })()`);

  const run=async(winner,opts)=>await ev(`JSON.parse(JSON.stringify(__run(${winner},${JSON.stringify(opts)})))`);
  // ⚠️ 传给 __run 的 opts 是在 **Node 侧** JSON.stringify 的，所以不能引用页面里的 window.__TING13
  //    （Node 里没有这个变量 → ReferenceError）。这里用 Node 侧字面量重写一遍。
  const TING13={0:3,1:3,2:3,3:2,4:2};   // 13 张，叫 5万（叫牌）
  const TING10={0:3,1:3,2:3,3:1};       // 10 张 + 1 副露（碰/杠），单钓 4万（叫牌）

  console.log('\n===== ① 归属：未叫家【打出的】鸡计入叫牌家；【手里保留的】不计 =====');
  let s=await run(0,{fc:5,hand:{0:{9:1}},disc:{1:[9]}});
  // 你(胡牌/叫牌)：自身 1 张幺鸡；下家(未叫)：打出 1 张幺鸡 → 计入你
  console.log('  你 应收/每个未叫家 = '+(-s.total[1])+'（自身 1 张 + 下家打出的 1 张）；下家保留的 2 张应**不计**');
  ok(-s.total[1]===2,'叫牌家每个未叫家收 2 分（自身幺鸡 1 + 未叫家打出的幺鸡 1）',-s.total[1]);
  ok(s.total[0]===6,'叫牌家总收 2 分 × 3 家 = 6',s.total[0]);
  ok(T(s.total.slice(1))===T([-2,-2,-2]),'三个未叫家各赔 2 分',s.total.slice(1));
  ok(s.p0.slice(1).every(v=>v===false),'（前置）三个未叫家确实没叫牌',s.p0);
  ok(s.total.reduce((a,b)=>a+b,0)===0,'收付守恒（合计 0）');
  s=await run(0,{fc:5,hand:{0:{9:1},1:{9:2}},disc:{1:[9]}});
  ok(-s.total[1]===2,'未叫家**手里保留**的 2 张幺鸡**不**计入（仍是 2 分/家，不是 5 分）',-s.total[1]);
  ok(/下家［未叫］留/.test(s.lines.join('|')),'明细里分别写清"留"与"打"');
  ok(s.lines.some(l=>/留 幺鸡\(1条\)×2/.test(l)),'下家明细含「留 幺鸡×2」（用桌上的叫法，不写 1条）',s.lines);

  console.log('\n===== ② 捉鸡牌（翻牌 +1 那张）→ **不赔给叫牌家**（用户 2026-09-15 明确） =====');
  // 鸡牌=6万：只有**叫牌家自己**的 6万 算；未叫家的（在手或打出）都不算
  s=await run(0,{fc:5,hand:{0:{5:1},1:{5:2}},disc:{1:[5]}});
  console.log('  你 应收/每个未叫家 = '+(-s.total[1]));
  ok(-s.total[1]===1,'未叫家**手里留的 2 张 + 打出的 1 张** 捉鸡牌都不赔（只剩叫牌家自己那 1 张 → 1 分/家）',-s.total[1]);
  ok(s.total[0]===3&&s.total.reduce((a,b)=>a+b,0)===0,'收付 3 / 守恒',[s.total[0]]);
  s=await run(0,{fc:5,disc:{1:[5]}});
  ok(-s.total[1]===0,'未叫家**打出的**捉鸡牌也不赔（叫牌家自己一张都没有 → 0 分）',-s.total[1]);
  ok(s.lines.some(l=>/捉鸡牌 6万 不赔给叫牌者/.test(l)),'明细写明"捉鸡牌不赔"（否则玩家以为漏算）',s.lines);
  s=await run(0,{fc:null,hand:{0:{5:1},1:{5:2}},disc:{1:[5]}});
  ok(-s.total[1]===0,'牌墙已空（没翻到鸡牌）时，6万 不再是鸡 → 0 分',-s.total[1]);

  console.log('\n===== ③ 金鸡：翻牌鸡恰为幺鸡/8筒 → 该牌种 2 分/张（且不重复计分） =====');
  s=await run(0,{fc:9,hand:{0:{9:1},1:{9:2}}});   // 翻牌鸡 = 幺鸡本身
  console.log('  你 应收/每个未叫家 = '+(-s.total[1]));
  ok(-s.total[1]===2,'金幺鸡 2 分/张：幺鸡本身就是常鸡 → 只有叫牌家自己那 1 张算（未叫家**留着的** 2 张不算）',-s.total[1]);
  ok(-s.total[1]!==9,'幺鸡**没有**被算两次（不是"常鸡 1 + 捉鸡 1"叠加）',-s.total[1]);
  s=await run(0,{fc:9,disc:{1:[9]}});             // 未叫家打出金幺鸡 → 常鸡通道，算
  ok(-s.total[1]===2,'金幺鸡被未叫家**打出** → 仍按常鸡赔给叫牌家（2 分/张）',-s.total[1]);
  s=await run(0,{fc:25,hand:{0:{25:1},1:{25:1}}});
  ok(-s.total[1]===2,'金乌骨鸡（翻牌鸡=8筒）2 分/张：只有叫牌家自己那张算',-s.total[1]);
  s=await run(0,{fc:5,hand:{0:{9:1,25:1}}});
  ok(-s.total[1]===2,'非金鸡时：幺鸡 1 分/张、8筒 1 分/张（不再是旧版的 2 分）',-s.total[1]);

  console.log('\n===== ④ 冲锋鸡：第一张打出的幺鸡，2 分；金鸡时 4 分；方向看主人是否叫牌 =====');
  s=await run(0,{fc:5,hand:{0:{9:1}},disc:{1:[9]},charge:{p:0,card:9}});
  // 主人=叫牌家(你) → 其他三家各付 2；同时你自己还有 1 张幺鸡的常鸡分 + 下家打出的 1 张
  const chickenOnly=(-s.total[1]);
  console.log('  下家合计应付 = '+chickenOnly+'（常鸡 2 + 冲锋 2）');
  ok(chickenOnly===4,'叫牌家的冲锋鸡：其他三家各付 2 分（与鸡分叠加）',chickenOnly);
  s=await run(0,{fc:5,charge:{p:1,card:9}});
  // 主人=未叫家(下家) → 他给每个叫牌家各付 2；本局只有你叫牌
  ok(s.total[1]===-2&&s.total[0]===2,'未叫家的冲锋鸡：给每个叫牌/胡牌玩家各付 2 分',[s.total[0],s.total[1]]);
  ok(s.total[2]===0&&s.total[3]===0,'其他未叫家不受冲锋鸡影响',[s.total[2],s.total[3]]);
  s=await run(0,{fc:9,hand:{0:{9:1}},charge:{p:0,card:9}});
  ok(-s.total[1]===6,'翻到**金幺鸡**时冲锋鸡按 4 分计（4 分 + 自身 1 张金幺鸡 2 分 = 6）',-s.total[1]);
  s=await run(0,{fc:25,hand:{0:{25:1}},charge:{p:0,card:25}});
  ok(-s.total[1]===6,'翻到**金乌骨鸡**时冲锋鸡同样 4 分（4 分 + 1 张金乌骨鸡 2 分 = 6）',-s.total[1]);
  s=await run(0,{fc:5,hand:{0:{25:1}},charge:{p:0,card:25}});
  ok(-s.total[1]===3,'非金鸡时：乌骨鸡冲锋鸡 2 分 + 自身 1 张乌骨鸡 1 分 = 3',-s.total[1]);
  s=await run(-1,{fc:5,charge:{p:1,card:9},hand:{}});   // 全场没人叫牌（手上都是孤张）
  ok(s.total[1]===0,'全场无人叫牌 → 冲锋鸡不结算',s.total[1]);
  ok(s.lines.some(l=>/全场无人叫牌/.test(l)),'明细里说明"不结算"',s.lines);

  console.log('\n===== ⑤ 责任鸡：鸡牌被【叫牌家】碰走 → 打出者多付 1 分（两个前提都要满足）=====');
  // 前提①：碰走者必须叫牌。对家(2) 叫牌 → 成立
  s=await run(0,{fc:5,setHand:{2:TING13},resp:{from:1,by:2,card:9,how:'碰'}});
  ok(s.p0[2]===true,'（前置）对家确实叫牌');
  ok(s.total[1]===-1&&s.total[2]===1,'责任鸡：打出者多付 1 分给碰走的人',[s.total[1],s.total[2]]);
  ok(s.total[0]===0&&s.total[3]===0,'与常鸡收付互不干扰',[s.total[0],s.total[3]]);
  ok(s.lines.some(l=>/责任鸡/.test(l)&&/多付 1 分/.test(l)),'明细写出责任鸡',s.lines);
  // 前提①不满足：碰走者是未叫家 → 那副露的鸡不算，本条不结算
  s=await run(0,{fc:5,resp:{from:1,by:2,card:9,how:'碰'}});
  ok(s.p0[2]===false,'（前置）对家未叫牌');
  ok(s.total[1]===0&&s.total[2]===0,'碰走者未叫牌 → 责任鸡不结算（未叫家保留的常鸡本来就不算）',[s.total[1],s.total[2]]);
  ok(s.lines.some(l=>/责任鸡/.test(l)&&/未叫牌/.test(l)&&/不结算/.test(l)),'明细说明为何不结算',s.lines);
  // 前提②：打出者必须未叫（叫牌家之间鸡分互不赔）
  s=await run(0,{fc:5,setHand:{1:TING13,2:TING13},resp:{from:1,by:2,card:9,how:'碰'}});
  ok(s.p0[1]===true&&s.p0[2]===true,'（前置）打出者与碰走者都叫牌');
  ok(s.total[1]===0&&s.total[2]===0,'打出者也叫牌 → 鸡分互不赔，本条不结算',[s.total[1],s.total[2]]);
  ok(s.lines.some(l=>/鸡分互不赔/.test(l)),'明细说明为何不结算',s.lines);
  // 牌种口径（用户 2026-09-15）：乌骨鸡**参与冲锋鸡、不算责任鸡**
  s=await run(0,{fc:5,setHand:{2:TING13},resp:{from:1,by:2,card:25,how:'碰'}});
  ok(s.total[1]===0&&s.total[2]===0,'乌骨鸡被碰走**不算**责任鸡（不产生那 1 分）',[s.total[1],s.total[2]]);
  const sw=JSON.parse(await ev(`JSON.stringify({charge:[9,25,5].map(isChargeTile),resp:[9,25,5].map(isRespTile)})`));
  console.log('  冲锋鸡牌种(幺鸡/乌骨鸡/普通)= '+JSON.stringify(sw.charge)+'；责任鸡牌种= '+JSON.stringify(sw.resp));
  ok(sw.charge[0]===true&&sw.charge[1]===true&&sw.charge[2]===false,'冲锋鸡认**幺鸡 + 乌骨鸡**',sw.charge);
  ok(sw.resp[0]===true&&sw.resp[1]===false,'责任鸡**只**认幺鸡',sw.resp);
  // 多条同时成立 → 累加
  // 两张**幺鸡**各被碰/杠走 → 累加（同一家可能打出多张幺鸡）
  s=await run(0,{fc:5,setHand:{2:TING13},resps:[{from:1,by:2,card:9,how:'碰'},{from:1,by:2,card:9,how:'杠'}]});
  ok(s.total[1]===-2&&s.total[2]===2,'同一家打出两张幺鸡各被碰/杠走 → 累加多付 2 分',[s.total[1],s.total[2]]);
  // 混着一条乌骨鸡 → 只算幺鸡那条
  s=await run(0,{fc:5,setHand:{2:TING13},resps:[{from:1,by:2,card:9,how:'碰'},{from:1,by:2,card:25,how:'碰'}]});
  ok(s.total[1]===-1&&s.total[2]===1,'混着一条乌骨鸡 → 只算幺鸡那条',[s.total[1],s.total[2]]);
  ok(s.lines.some(l=>/乌骨鸡不参与责任鸡/.test(l)),'明细写明乌骨鸡那条为何不结算',s.lines);
  // 冲锋鸡与责任鸡同时成立：下家(1,未叫) 常鸡赔 1 + 冲锋给 0/2 各 2（共 4）+ 责任 1 = 6
  s=await run(0,{fc:5,setHand:{2:TING13},hand:{0:{9:1}},charge:{p:1,card:9},resp:{from:1,by:2,card:9,how:'碰'}});
  ok(s.total[1]===-6,'冲锋鸡（未叫）与责任鸡同时成立 → 下家共付 6 分',s.total[1]);
  ok(s.total.reduce((a,b)=>a+b,0)===0,'收付守恒');

  console.log('\n===== ⑦ 冲锋鸡【责任转移】+「其它家给 3 鸡、打出的给 4 鸡」=====');
  // 转移成功：第一张幺鸡被【叫牌家】碰走 → 持有者换成碰走者
  s=await run(0,{fc:5,setHand:{2:TING13},charge:{p:2,card:9,via:'碰',from:1}});
  ok(s.p0[2]===true,'（前置）碰走者（对家）叫牌');
  ok(s.total[2]===6&&s.total[1]===-2&&s.total[3]===-2,
     '责任转移成功：碰走者向其他三家各收 2 分（含胡牌家）',[s.total[1],s.total[2],s.total[3]]);
  ok(s.total[0]===-2,'胡牌家也照付冲锋鸡的钱',s.total[0]);
  ok(s.lines.some(l=>/责任已转移/.test(l)),'明细写出"责任已转移"',s.lines);
  // 乌骨鸡作冲锋鸡时同样转移（乌骨鸡"参与冲锋鸡"）
  s=await run(0,{fc:5,setHand:{2:TING13},charge:{p:2,card:25,via:'碰',from:1}});
  ok(s.total[2]===6&&s.total[1]===-2&&s.total[3]===-2,'乌骨鸡作冲锋鸡时同样责任转移（参与冲锋鸡）',[s.total[2],s.total[1],s.total[3]]);
  // 转移失败：碰走者未叫牌 → 退回原打出者
  s=await run(0,{fc:5,charge:{p:2,card:9,via:'碰',from:1}});
  ok(s.p0[2]===false,'（前置）碰走者未叫牌');
  ok(s.total[0]===2&&s.total[1]===-2,'碰走者未叫 → 不转移，仍归原打出者（他未叫 → 给叫牌家付 2）',[s.total[0],s.total[1]]);
  ok(s.lines.some(l=>/不转移/.test(l)),'明细写出"不转移"',s.lines);
  // **胡牌家也照付**：持有者是叫牌家 → 其他三家（含胡牌家）各付 2
  s=await run(0,{fc:5,setHand:{1:TING13},charge:{p:1,card:9}});
  ok(s.p0[1]===true,'（前置）下家已叫牌（但没胡）');
  ok(s.total[0]===-2,'胡牌家也照付（不因为胡了牌就免付）',s.total[0]);
  ok(s.total[1]===6&&s.total[2]===-2&&s.total[3]===-2,'持有者叫牌 → 其他三家各付 2（共 6）',[s.total[1],s.total[2],s.total[3]]);
  // 「其它家给 3 鸡、打出的给 4 鸡」端到端：叫牌家的副露里有 3 张幺鸡（碰走的）
  s=await run(0,{fc:5,setHand:{2:TING10},meld:{2:[{type:'peng',card:9,from:1}]},
                resps:[{from:1,by:2,card:9,how:'碰'}]});
  ok(s.p0[2]===true,'（前置）对家（碰牌者）叫牌');
  ok(-s.total[3]===3,'其它未叫家各付 3 分（副露 3 张幺鸡 × 1 分）',-s.total[3]);
  ok(-s.total[1]===4,'打出的那家付 4 分（3 分 + 多开 1 分）',-s.total[1]);
  ok(s.total[2]===7,'碰走者共收 7 分（3+3 的鸡分 + 1 分的责任）',s.total[2]);
  ok(s.total.reduce((a,b)=>a+b,0)===0,'收付守恒');
  // 明杠：副露 4 张 → 其它家给 4、打出的给 5
  s=await run(0,{fc:5,setHand:{2:TING10},meld:{2:[{type:'gang',card:9,from:1}]},
                resps:[{from:1,by:2,card:9,how:'杠'}]});
  ok(-s.total[3]===4,'明杠：其它未叫家各付 4 分',-s.total[3]);
  ok(-s.total[1]===5,'明杠：打出者给 5 分（4 分 + 多开 1 分）',-s.total[1]);
  ok(s.lines.some(l=>/按 4 张算/.test(l)),'明细写出"按 4 张算"',s.lines);

  console.log('\n===== ⑥ 边界：四家都叫牌 / 无人叫牌 / 荒庄只统计不落分 =====');
  s=await run(0,{fc:5,hand:{0:{9:1},1:{}},disc:{1:[9]}});
  ok(s.total.reduce((a,b)=>a+b,0)===0,'任何情况下收付守恒');
  // 四家都叫牌（含胡牌者）→ 没有未叫家 → 鸡分不转移
  s=await ev(`(()=>{
    __mk({fc:5,hand:{0:{9:1}}});
    const TH=[0,0,0,1,1,1,2,2,2,3,3,4,4];
    [1,2,3].forEach(p=>{G.hands[p]=emptyC();TH.forEach(c=>G.hands[p][c]++);});
    const total=[0,0,0,0],lines=[];
    chickenSettle(0,lines,total);
    return {total:total,lines:lines,ting:[0,1,2,3].map(p=>isTing(p))};
  })()`);
  ok(s.ting.slice(1).every(v=>v===true),'（前置）三家都叫牌',s.ting);
  ok(s.total.every(v=>v===0),'四家都叫牌 → 鸡分不转移（互不赔，含自己手里的鸡也不算）',s.total);
  ok(s.lines.some(l=>/四家都叫牌/.test(l)),'明细写明原因',s.lines);
  // 荒庄：dry 模式
  s=await ev(`(()=>{
    const lines=[];const r=chickenSettle(-1,lines,null);
    return {lines:lines,n:lines.length,detail:r.detail.length};
  })()`);
  ok(s.n>0&&s.lines.some(l=>/荒庄/.test(l)&&/不落分|不算分/.test(l)),'荒庄：只统计不落分，并写明原因',s.lines);
  ok(s.lines.some(l=>/翻（捉）鸡牌/.test(l)),'荒庄也写翻（捉）鸡牌一行');
  ok(s.lines.filter(l=>/［叫牌］|［未叫］/.test(l)).length===4,'荒庄也逐家写清鸡的类型与数量（4 行）',s.lines);

  console.log('\n===== ⑦ 明细输出（用户要求：叫牌家/未叫家各自的鸡类型与数量） =====');
  s=await run(0,{fc:5,hand:{0:{9:2,25:1},1:{9:1,25:2}},disc:{1:[9],2:[5]},meld:{0:[{type:'peng',card:25,from:1}]}});
  console.log('  '+s.lines.join('\n  '));
  const txt=s.lines.join('|');
  ok(/翻（捉）鸡牌：6万/.test(txt),'第 1 行写明翻（捉）鸡牌是什么（6万）');
  ok(/你［叫牌］/.test(txt),'叫牌家标注为［叫牌］');
  ok(/下家［未叫］/.test(txt),'未叫家标注为［未叫］');
  ok(/留 幺鸡\(1条\)×2/.test(txt),'写清"留"的鸡类型与数量',txt);
  ok(/乌骨鸡\(8筒\)×4/.test(txt),'副露里的鸡也算进"留"（碰出来的 3 张 8筒 + 手里 1 张 = ×4）',txt);
  ok(/打 幺鸡\(1条\)×1/.test(txt),'写清"打"的鸡类型与数量',txt);
  ok(/鸡分：你 每个未叫家收/.test(txt),'写出收付方向与分数',txt);

  console.log('\n===== ⑧ 与真实胡牌流程集成（settle → lines → 总分守恒） =====');
  s=await ev(`(()=>{
    __mk({fc:5,hand:{0:{},1:{}},disc:{1:[9]}});
    G.hands[0]=emptyC();[0,0,0,1,1,1,2,2,2,3,3,3,4,4].forEach(c=>G.hands[0][c]++);   // 一副能胡的牌
    G.hands[1]=emptyC();__JUNK.forEach(c=>G.hands[1][c]++);
    G.discards[1]=[9];                                                               // 下家打出过幺鸡
    G.wall=[];for(let i=0;i<23;i++)G.wall.push(i%27);
    G.firstDraw=[false,false,false,false];G.scores=[0,0,0,0];G.roundScore=[0,0,0,0];
    G.chargeChicken={p:1,card:9};G.respChickens=[];
    const res=settle(0,-1,true,false);                    // 你自摸
    return {lines:res.lines,total:res.total,sum:res.total.reduce((a,b)=>a+b,0),
            hasChickenLine:res.lines.some(l=>/翻（捉）鸡牌/.test(l)),
            detailLines:res.lines.filter(l=>/［叫牌］|［未叫］/.test(l)).length,
            chickenLines:res.lines.filter(l=>/鸡分|冲锋鸡|责任鸡/.test(l)).length};
  })()`);
  if(s&&s.__err){console.log('  ❌ 集成用例报错：'+s.__err);FAIL++;}
  else{
    console.log('  结算行数='+s.lines.length+'  明细行='+s.detailLines+'  鸡相关行='+s.chickenLines);
    console.log('  '+s.lines.filter(l=>/鸡|冲锋|责任/.test(l)).join('\n  '));
    ok(s.hasChickenLine===true,'真实胡牌流程里出现「翻（捉）鸡牌」明细');
    ok(s.detailLines===4,'四个玩家各有一行鸡明细',s.detailLines);
    ok(Math.abs(s.sum)<1e-6,'整局结算**总分守恒**（番数+豆+鸡全部转移，合计 0）',s.sum);
  }

  console.log('\n===== ⑨ 弃牌含鸡：归谁（用户重点问的这条） =====');
  // 规则原文：弃牌里的鸡归弃牌者自家收；**若弃牌者未叫牌，这枚鸡改判给叫牌者收**。
  // 下面把四种组合逐一验掉。
  s=await run(0,{fc:5,disc:{0:[9]}});                 // 你(叫牌/胡牌) 自己牌河里 1 张幺鸡
  console.log('  叫牌家自己打出 1 张幺鸡 → 每个未叫家付 '+(-s.total[1]));
  ok(-s.total[1]===1,'① 弃牌者是**叫牌家** → 弃牌里的鸡归**自己**收（每未叫家赔 1 分）',-s.total[1]);
  s=await run(0,{fc:5,hand:{0:{9:1}},disc:{0:[9]}});
  ok(-s.total[1]===2,'② 叫牌家的"手里的 1 张 + 打出的 1 张"**都算自己**的（2 分/家）',-s.total[1]);
  s=await run(0,{fc:5,disc:{1:[9]}});                 // 下家(未叫牌) 牌河里 1 张幺鸡
  console.log('  未叫牌家打出 1 张幺鸡 → 每个未叫家付 '+(-s.total[1]));
  ok(-s.total[1]===1,'③ 弃牌者是**未叫牌家** → 这枚鸡**改判给叫牌家**（打出者自己也要赔）',-s.total[1]);
  s=await run(0,{fc:5,hand:{1:{9:1}},disc:{1:[9]}});
  ok(-s.total[1]===1,'④ 未叫牌家：手里留的那张**不算**、牌河里打出的那张算（1 分，不是 2）',-s.total[1]);
  ok(s.lines.some(l=>/下家［未叫］留 幺鸡\(1条\)×1 ｜ 打 幺鸡\(1条\)×1/.test(l)),
     '明细把「留」与「打」分开列，一眼能看出哪张作数',s.lines);
  // ⑤ 两家叫牌：未叫牌家打出的那张鸡，**每个叫牌家各收一份**
  s=await ev(`(()=>{
    __mk({fc:5,disc:{2:[9]}});
    const TH=[0,0,0,1,1,1,2,2,2,3,3,4,4];
    [0,1].forEach(p=>{G.hands[p]=emptyC();TH.forEach(c=>G.hands[p][c]++);});
    const total=[0,0,0,0],lines=[];
    chickenSettle(0,lines,total);
    return {total:total,lines:lines,ting:[0,1,2,3].map(p=>isTing(p))};
  })()`);
  ok(s.ting[0]===true&&s.ting[1]===true,'（前置）确实有两家叫牌',s.ting);
  ok(s.total[0]===2&&s.total[1]===2,'⑤ 未叫牌家打出的 1 张鸡 → **每个叫牌家各收一份**（各 2 分 = 1 分 × 2 家未叫）',[s.total[0],s.total[1]]);
  ok(s.total[2]===-2&&s.total[3]===-2,'⑥ 两个未叫牌家各赔 2 分（替对方那张鸡买单）',[s.total[2],s.total[3]]);
  ok(s.total.reduce((a,b)=>a+b,0)===0,'收付守恒');
  // ⑦ 这张鸡被碰走了：随牌转移到碰牌者名下（弃牌区里已经没有它）
  s=await ev(`(()=>{
    __mk({fc:5});
    const TH=[0,0,0,1,1,1,2,2,2,3,3,4,4];
    G.hands[1]=emptyC();TH.forEach(c=>G.hands[1][c]++);
    G.melds[1]=[{type:'peng',card:9,from:0}];        // 幺鸡被碰走 → 副露里 3 张
    const total=[0,0,0,0],lines=[];
    chickenSettle(0,lines,total);
    return {total:total,lines:lines,ting1:isTing(1),sum:total.reduce((a,b)=>a+b,0)};
  })()`);
  ok(s.ting1===true,'（前置）碰走幺鸡的那家是叫牌家',s.ting1);
  ok(s.lines.some(l=>/下家［叫牌］留 幺鸡\(1条\)×3/.test(l)),'⑦ 被碰走的鸡**随牌转移**：算碰牌者的保留（副露 3 张）',s.lines);
  ok(s.lines.some(l=>/下家 每个未叫家收 3 分/.test(l)),'收付按 3 张算（不是 1 张）',s.lines);

  console.log('\n===== ⑩ 集成：真实的碰/杠挂点是否真的写了对的状态 =====');
  // ⚠️ 前面几组都是直接调 chickenSettle；这里故意走**真函数** doPeng/doGang，
  //    因为"挂点忘了写状态"这类 bug 在结算测试里是看不出来的（状态是测试自己塞的）。
  const si=await ev(`(()=>{
    // 冻结对局：碰/杠之后会甩 setTimeout（discard / drawTile），别让它们跑起来污染状态
    const realDiscard=discard;   // 先存下真函数：下一行会把 window.discard 换成空函数（冻结 AI 后续）
    window.drawTile=function(){};window.discard=function(){};window.aiDiscardSmart=function(){return 0;};
    window.checkClaims=function(){};   // 出牌后别让别家来碰/胡
    const setup=()=>{__mk({fc:5,charge:{p:1,card:9}});G.hands[2][9]=3;G.discards[1]=[9];};
    const out={};
    setup(); doPeng(2,9,1);
    out.peng={resp:G.respChickens.slice(),ch:G.chargeChicken,melds:G.melds[2].length,disc:G.discards[1].length};
    setup(); G.chargeChicken={p:3,card:9}; doPeng(2,9,1);
    out.peng2={resp:G.respChickens.slice(),ch:G.chargeChicken};
    __mk({fc:5});G.hands[2][3]=3;G.discards[1]=[3];doPeng(2,3,1);
    out.peng3={resp:G.respChickens.slice()};
    setup(); doGang(2,9,1);
    out.gang={resp:G.respChickens.slice(),ch:G.chargeChicken};
    // 乌骨鸡被碰走：责任鸡只认幺鸡 → 不该记
    __mk({fc:5});G.hands[2][25]=3;G.discards[1]=[25];doPeng(2,25,1);
    out.peng4={resp:G.respChickens.slice(),ch:G.chargeChicken};
    // 冲锋鸡的牌种：第一张打出的**乌骨鸡**也算冲锋鸡（真 discard，其后续已被冻结）
    __mk({fc:5});G.hands[3][25]=1;G.discards[3]=[];realDiscard(3,25);
    out.disc25={ch:G.chargeChicken};
    return JSON.stringify(out);
  })()`);
  const itg=JSON.parse(si);
  console.log('  '+si);
  ok(itg.peng.resp.length===1&&itg.peng.resp[0].how==='碰'&&itg.peng.resp[0].from===1&&itg.peng.resp[0].by===2,
     '碰：真实挂点记下了责任鸡（打出者 1 → 碰走者 2）',itg.peng.resp);
  ok(itg.peng.ch&&itg.peng.ch.p===2&&itg.peng.ch.via==='碰'&&itg.peng.ch.from===1,
     '碰：冲锋鸡被碰走 → 责任转移（持有者 1 → 2）',itg.peng.ch);
  ok(itg.peng.melds===1&&itg.peng.disc===0,'碰：副露 +1、牌河 -1（碰的正常行为没被改坏）',itg.peng);
  ok(itg.peng2.resp.length===1&&itg.peng2.ch.p===3,
     '碰走的不是冲锋鸡 → 只记责任鸡，不动冲锋鸡持有者',itg.peng2);
  ok(itg.peng3.resp.length===0,'碰的不是鸡牌 → 不记责任鸡',itg.peng3.resp);
  ok(itg.gang.resp.length===1&&itg.gang.resp[0].how==='杠'&&itg.gang.ch&&itg.gang.ch.p===2&&itg.gang.ch.via==='杠',
     '明杠：同样记责任鸡（how=杠）并转移责任',itg.gang);
  ok(itg.peng4.resp.length===0,'乌骨鸡被碰走 → 真挂点**不**记责任鸡',itg.peng4.resp);
  ok(itg.disc25.ch&&itg.disc25.ch.p===3&&itg.disc25.ch.card===25,
     '真 discard：第一张打出的**乌骨鸡**被记为冲锋鸡',itg.disc25.ch);
  ok(s.sum===0,'收付守恒');

  if(errs.length)console.log('\n页面异常:\n'+errs.join('\n'));
  console.log('\n>>> '+(FAIL?'❌ '+FAIL+' 项不通过':'✅ 全部 '+PASS+' 项通过'));
  ws.close();proc.kill();
  await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:3});}catch(e){}
  process.exit(FAIL?1:0);
})();
