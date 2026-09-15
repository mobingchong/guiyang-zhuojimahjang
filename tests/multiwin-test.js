/* 贵阳捉鸡麻将 · 一炮双响 / 一炮多响 自测
   规则（用户 2026-09-15）：
     · 一张牌被多家同时胡 → 放炮者**按每家各自的番数分别赔**
     · 定庄：自摸/单点炮 → 胡牌者接庄；**一炮双响** → 上局庄家逆时针第一个胡牌者；**一炮多响(≥3)** → 放炮者坐庄
     · 豆 / 鸡 / 开局跟 只结算**一次**（不能因为两家胡就算两遍）

   跑法：node tests/multiwin-test.js "file:///D:/MyProjects/gymj/index.html" */
const fs=require('fs');
const {spawn}=require('child_process');
const http=require('http');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9395;
const PROFILE=path.join('.workbuddy','_multi_profile');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function httpGet(u){return new Promise((res,rej)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
let _id=1;const pending=new Map();
function send(ws,m,p){const id=_id++;return new Promise(res=>{pending.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});}

// ⚠️ 页内 __mk 的 opts 是在 **Node 侧** JSON.stringify 的，所以手牌必须在 Node 侧也定义一份
//    （引用页面里的 window.WIN13 会 ReferenceError —— 这个坑在 chicken-test 里踩过一次）
const WIN13={10:3,12:1,14:3,19:3,23:3};  // 13 张、**单钓 4条**：补上 → 2条/6条/2筒/6筒 四刻 + 44 将 = 大对子 5 番
const WIN13G={12:1,14:3,19:3,23:3};      // 10 张 + 1 副暗杠（2条），同样单钓 4条

(async()=>{
  const url=process.argv[2]||'file:///D:/MyProjects/gymj/index.html';
  if(!fs.existsSync(PROFILE))fs.mkdirSync(PROFILE,{recursive:true});
  const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run','--user-data-dir='+PROFILE,'--remote-debugging-port='+PORT],{stdio:'ignore'});
  await sleep(3000);
  const list=await httpGet('http://127.0.0.1:'+PORT+'/json/list');
  const page=list.find(t=>t.type==='page')||{};
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  const errs=[];
  let PASS=0,FAIL=0;
  const ok=(c,m,extra)=>{if(c){PASS++;console.log('  ✅ '+m);}else{FAIL++;console.log('  ❌ '+m+(extra!==undefined?('  实际='+JSON.stringify(extra)):''));}};
  await new Promise(r=>ws.onopen=r);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown')errs.push(String((m.params.exceptionDetails.exception&&m.params.exceptionDetails.exception.description)||m.params.exceptionDetails.text).slice(0,220));
  };
  const ev=async expr=>{
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return {__err:String((ed.exception&&ed.exception.description)||ed.text).slice(0,300)};
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  await send(ws,'Runtime.enable',{});await send(ws,'Page.enable',{});
  await send(ws,'Emulation.setDeviceMetricsOverride',{width:400,height:871,deviceScaleFactor:1,mobile:true});
  await send(ws,'Page.navigate',{url});await sleep(2600);

  console.log('\n===== 准备：页内脚手架 =====');
  const setup=await ev(`(()=>{
    /* 13 张、听 5万(index 4) 的手牌：000 999 181818（万/条/筒三门）+ 33 + 44
       → 补 5万 后 000/999/181818/444 四刻 + 33 将 = **大对子 5 番**（三门，所以不是清大对）。 */
    window.WIN13={10:3,12:1,14:3,19:3,23:3};
    window.WIN13G={12:1,14:3,19:3,23:3};        // 10 张 + 1 副杠（2条），同样单钓 4条
    window.__mk=(o)=>{o=o||{};
      G.hands=[[],[],[],[]].map(()=>emptyC());G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];
      G.wall=[0,1,2,3,4,5,6,7,20];                 // 顶张 20 → 本局鸡牌=21(4筒)，四家都没有 → 鸡分恒 0，断言只反映番与豆
      G.winTile=null;G.chargeChicken=null;G.respChickens=[];G.huList=[];
      G.chickenCard=null;G.qiangGang=false;G.qiangGangPending=-1;
      G.hotCannon=false;G.gangFlower=false;G.openFollow=null;
      G.bao=[false,false,false,false];G.baoName=['','','',''];
      G.firstDraw=[false,false,false,false];
      G.dealer=(o.dealer===undefined?0:o.dealer);
      G.scores=[0,0,0,0];G.roundScore=[0,0,0,0];G.nextDealer=null;
      G.phase='discard';G.turn=0;G.actions=[];G.pendingAction=null;
      G.lastDiscardBy=(o.from===undefined?-1:o.from);G.lastDiscard=null;G.lastDiscardAt=0;
      // 默认四家都是孤张（保证不成胡、也不听牌）
      [0,1,2,3].forEach(p=>{const h=G.hands[p]=emptyC();[0,2,4,6,8,10,12,14,16,18,20,22,24].forEach(c=>h[c]++);});
      if(o.hand)for(const p in o.hand){G.hands[p]=emptyC();for(const c in o.hand[p])G.hands[p][c]=o.hand[p][c];}
      if(o.meld)for(const p in o.meld)G.melds[p]=o.meld[p];
      window.__last=null;
      return 'ok';};
    // 拦下 showResult 把结算结果存起来（其余行为不变）
    window.showResult=function(res){window.__last=res;};
    // 走**真实流程**：checkClaims 判定 → doHuMulti 结算
    window.__go=(from,card,o)=>{__mk(Object.assign({from:from},o||{}));checkClaims(from,card);
      const r=window.__last;
      return JSON.stringify({huList:G.huList.slice(),phase:G.phase,
        winners:r?r.winners:null,total:r?r.total:null,lines:r?r.lines:null,
        list:r?r.list:null,nextDealer:G.nextDealer,dealer:G.dealer});};
    return 'ok';
  })()`);
  ok(setup==='ok','页内脚手架就位（__mk / __go / 拦下 showResult）',setup);
  const go=async(from,card,o)=>JSON.parse(await ev(`__go(${from},${card},${JSON.stringify(o||{})})`));

  console.log('\n===== ① 一炮双响：两家同时胡同一张 =====');
  let s=await go(0,12,{hand:{1:WIN13,2:WIN13},dealer:0});
  console.log('  huList='+JSON.stringify(s.huList)+'  winners='+JSON.stringify(s.winners)+'  total='+JSON.stringify(s.total));
  console.log('  明细：\n    '+s.lines.join('\n    '));
  // ⚠️ G.huList 在结算完就被清空了（防止带到下一手），所以判定要断言 winners
  ok(s.winners&&s.winners.length===2,'结算的两家都在 winners 里',s.winners);
  ok(s.total[0]===-10&&s.total[1]===5&&s.total[2]===5,'放炮者分别各赔 5 番（大对子）：你 −10、两家各 +5',s.total);
  ok(s.total[3]===0,'没胡的第三家不受影响',s.total[3]);
  ok(s.total.reduce((a,b)=>a+b,0)===0,'四家收付合计 = 0');
  ok(s.lines.some(l=>/一炮双响/.test(l)),'明细里写明「一炮双响」',s.lines);
  ok(s.lines.filter(l=>/点炮胡/.test(l)).length===2,'明细逐家写出各自的点炮胡',s.lines.filter(l=>/点炮胡/.test(l)));
  ok(s.lines.some(l=>/分别赔，合计付 10 番/.test(l)),'写明放炮者合计付 10 番',s.lines);
  ok(s.nextDealer===1,'定庄（双响）：庄家=0 逆时针第一个胡牌者 = 下家(1) → nextDealer=1',s.nextDealer);

  console.log('\n===== ② 双响定庄：从庄家起逆时针第一个胡牌者 =====');
  s=await go(0,12,{hand:{1:WIN13,3:WIN13},dealer:2});
  console.log('  dealer=2 winners='+JSON.stringify(s.winners)+' → nextDealer='+s.nextDealer);
  ok(s.nextDealer===3,'庄家 2 起逆时针：对家(1)偏移 3、上家(3)偏移 1 → 取 3',s.nextDealer);
  // 庄家自己就是两个胡牌者之一（偏移 0 最小）→ 仍由他坐庄
  s=await go(1,12,{hand:{2:WIN13,3:WIN13},dealer:2});
  console.log('  dealer=2 winners='+JSON.stringify(s.winners)+' → nextDealer='+s.nextDealer);
  ok(s.nextDealer===2,'庄家自己就是胡牌者之一（偏移 0 最小）→ 仍是他坐庄（nextDealer=2）',s.nextDealer);

  console.log('\n===== ③ 一炮多响（三家同时胡）→ 放炮者坐庄 =====');
  s=await go(0,12,{hand:{1:WIN13,2:WIN13,3:WIN13},dealer:2});
  console.log('  huList='+JSON.stringify(s.huList)+'  nextDealer='+s.nextDealer+'  total='+JSON.stringify(s.total));
  ok(s.winners.length===3,'三家都能胡（winners 长度 3）',s.winners);
  ok(s.total[0]===-15&&s.total[1]===5&&s.total[2]===5&&s.total[3]===5,'放炮者分别各赔 5 番（共 15）',s.total);
  ok(s.nextDealer===0,'定庄（多响 ≥3）：**放炮者坐庄** → nextDealer=0',s.nextDealer);
  ok(s.lines.some(l=>/一炮多响/.test(l)),'明细里写明「一炮多响」',s.lines);

  console.log('\n===== ④ 玩家过牌，别家照样能胡 =====');
  s=await go(3,12,{hand:{0:WIN13,2:WIN13},dealer:0});
  ok(s.huList.length===2&&s.huList.indexOf(0)>=0,'（前置）你和对家都能胡这张，且弹出了可选动作',s.huList);
  const hasHuBtn=await ev(`!!(G.actions&&G.actions.some(a=>a.type==='hu'))`);
  ok(hasHuBtn===true,'（前置）操作条里有「胡」按钮',hasHuBtn);
  const afterPass=JSON.parse(await ev(`(()=>{passClaim();const r=window.__last;
    return JSON.stringify({winners:r?r.winners:null,total:r?r.total:null,huList:G.huList.slice()});})()`));
  console.log('  过牌后：'+JSON.stringify(afterPass));
  ok(afterPass.winners&&afterPass.winners.length===1&&afterPass.winners[0]===2,'你过牌 → 只剩对家胡',afterPass.winners);
  ok(afterPass.total[0]===0,'过牌的你一分不收',afterPass.total);
  ok(afterPass.total[2]===5&&afterPass.total[3]===-5,'对家收 5 番、放炮者（上家）付 5 番',afterPass.total);
  ok(afterPass.huList.length===0,'过牌后清空 huList（不会带到下一手）',afterPass.huList);

  console.log('\n===== ⑤ 豆 / 鸡 只结算一次（不能因两家胡就算两遍）=====');
  s=await go(0,12,{hand:{1:WIN13G,2:WIN13},meld:{1:[{type:'gang',card:10,from:-1}]},dealer:0});
  console.log('  winners='+JSON.stringify(s.winners)+'  total='+JSON.stringify(s.total));
  console.log('  明细：\n    '+s.lines.join('\n    '));
  ok(s.winners.length===2,'（前置）两家同时胡',s.winners);
  const douLines=(s.lines||[]).filter(l=>/闷豆/.test(l));
  ok(douLines.length===1,'暗杠的「闷豆」明细**只出现一次**（一炮双响没有把豆算两遍）',douLines);
  ok(s.total[1]===5+6,'胡家（带暗杠）拿到：自己 5 番 + 闷豆三家各付 2（共 6）= 11',s.total[1]);
  ok(s.total[0]===-5-5-2,'放炮者：赔两家各 5 番 + 付闷豆 2 = −12',s.total[0]);
  ok(s.total[2]===5-2&&s.total[3]===0-2,'另一家胡家：收 5、付豆 2；没胡那家只付豆 2',[s.total[2],s.total[3]]);
  ok(s.total.reduce((a,b)=>a+b,0)===0,'四家收付合计 = 0');

  console.log('\n===== ⑥ 回归：单家胡（没多响时行为和以前一致）=====');
  s=await go(0,12,{hand:{1:WIN13},dealer:0});
  ok(s.winners.length===1&&s.winners[0]===1,'只有一家能胡 → winners=[1]',s.winners);
  ok(s.total[0]===-5&&s.total[1]===5,'单家胡：放炮者付 5 番',s.total);
  ok(!s.lines.some(l=>/一炮/.test(l)),'明细里**没有**一炮双响/多响字样',s.lines);
  ok(s.nextDealer===1,'单家点炮：胡牌者接庄（nextDealer=1）',s.nextDealer);

  if(errs.length)console.log('\n页面异常:\n'+errs.join('\n'));
  console.log('\n>>> '+(FAIL?'❌ '+FAIL+' 项不通过':'✅ 全部 '+PASS+' 项通过'));
  ws.close();proc.kill();
  await sleep(500);
  try{fs.rmSync(PROFILE,{recursive:true,force:true,maxRetries:3});}catch(e){}
  process.exit(FAIL?1:0);
})();
