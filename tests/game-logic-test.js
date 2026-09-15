#!/usr/bin/env node
/* 贵阳捉鸡麻将 · 逻辑自测（布局测试查不出的那些事）
 *
 * 用法：node tests/game-logic-test.js "file:///D:/MyProjects/gymj/贵阳麻将.html"
 *      （URL 里中文要转义：%E8%B4%B5%E9%98%B3%E9%BA%BB%E5%B0%86.html）
 *
 * 它用 headless Edge + CDP 真机式地跑一遍完整链路，断言：
 *   ① 首次进入弹取名层、自动名字是四个字、且没名字不开局
 *   ② 确认名字 → 自动开局并弹出摇色子层
 *   ③ 色子走完自动发牌：总 53 张、牌墙余 55、庄家 14 张、其余各 13
 *   ④ 掷色子规则自洽（数家 / 留墩 / 起点范围，跑 200 次）
 *   ⑤ 胜家接庄 + 分数/局数写进 localStorage
 *   ⑥ 刷新后名字/分数/庄位/局数全部恢复，且由新庄家先摸先打
 *   ⑦ 改名 = 另开一份记录（从 0 开始），旧名字成绩还在
 *   ⑧ 点积分板上自己的名字能打开改名层
 *   ⑨ 荒庄连庄
 *
 * ⚠️ 时序坑：想验"谁先拿牌"，必须在**发牌刚结束、AI 还没动手**的窗口内看
 *    （开局 0s 摇色子 → 1.62s 发牌 → 2.27s 庄家摸打 → 2.92s 下一家…）。
 *    测晚了看到的是"轮到玩家时手里那 14 张"，会误判成庄家没先拿。
 */
const {spawn}=require('child_process');
const http=require('http');const fs=require('fs');const path=require('path');
const EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT=9351;
const url=process.argv[2];
if(!url){console.log('用法: node tests/game-logic-test.js "file:///.../贵阳麻将.html"');process.exit(1);}
// 调试 profile 建在项目内同盘目录：跑完 rename 走（沙箱删不掉 Edge profile，
// 跨盘 rename 又会 EXDEV，所以"同盘改名"是最稳的收尾方式）
const BASE=path.join(__dirname,'..','.workbuddy');
const PROFILE=path.join(BASE,'_edge_logic_profile');
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
  await sleep(3000);
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
    const r=await send(ws,'Runtime.evaluate',{expression:expr,returnByValue:true});
    const ed=r.result&&r.result.exceptionDetails;
    if(ed)return {__err:String((ed.exception&&ed.exception.description)||ed.text).slice(0,300)};
    return r.result&&r.result.result?r.result.result.value:undefined;
  };
  const nav=async()=>{await send(ws,'Page.navigate',{url});await sleep(2600);};
  await send(ws,'Runtime.enable',{});await send(ws,'Page.enable',{});
  await send(ws,'Emulation.setDeviceMetricsOverride',{width:400,height:871,deviceScaleFactor:1,mobile:true});
  await send(ws,'Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});

  console.log('\n===== ① 首次进入：应弹取名层，且游戏没开局 =====');
  await nav();
  await ev("localStorage.removeItem('gymj.v1')");
  await nav();
  let s=await ev(`(()=>({phase:G.phase,diceOn:document.getElementById('dice').classList.contains('on'),
    nameOn:document.getElementById('nameDlg').classList.contains('on'),
    suggest:document.getElementById('nameInput').value,storeOk:Store.ok}))()`);
  console.log('  '+JSON.stringify(s));
  ok(s.nameOn===true,'取名层已弹出');
  ok(s.diceOn===false,'还没进摇色子（要先有名字）');
  ok(/^.{4}$/.test(s.suggest||''),'自动生成的名字是四个字：'+(s.suggest||''));
  ok(s.storeOk===true,'浏览器允许本地保存');

  console.log('\n===== ② 确认名字 → 自动开第一局（摇色子） =====');
  s=await ev(`(()=>{confirmName();return {name:NAMES[0],phase:G.phase,diceOn:document.getElementById('dice').classList.contains('on'),
    hand:document.getElementById('dHand').textContent,dealer:document.getElementById('dDealer').textContent,
    recDealer:JSON.parse(localStorage.getItem('gymj.v1')).records[NAMES[0]].dealer,
    dealerExp:'庄家：'+NAMES[G.dealer],
    rec:JSON.parse(localStorage.getItem('gymj.v1')).records[NAMES[0]]};})()`);
  console.log('  '+JSON.stringify(s));
  ok(s.name===s.suggest||typeof s.name==='string','名字已应用：'+s.name);
  ok(s.diceOn===true,'摇色子层已弹出');
  // 首局庄家现在由**系统随机选**（贵阳捉鸡规则），所以断言"色子层显示的庄家 = 记录里的庄"，
  // 不再假定一定是玩家自己。
  ok(s.recDealer>=0&&s.recDealer<4&&s.dealer===s.dealerExp,
     '色子层显示的庄家与记录一致（'+s.dealer+'）');
  ok(!!s.rec,'localStorage 里已按这个名字建了记录');

  console.log('\n===== ③ 摇色子：等它自己走完 → 发牌 53 张、庄家先摸 =====');
  await sleep(2200);
  s=await ev(`(()=>({phase:G.phase,diceOn:document.getElementById('dice').classList.contains('on'),
    wall:G.wall.length,counts:[0,1,2,3].map(p=>G.hands[p].reduce((a,b)=>a+b,0)),
    turn:G.turn,dealer:G.dealer,total:[0,1,2,3].reduce((a,p)=>a+G.hands[p].reduce((x,y)=>x+y,0),0)}))()`);
  console.log('  '+JSON.stringify(s));
  ok(s.diceOn===false,'色子层已自动收起');
  ok(s.phase==='discard','已进入出牌阶段');
  ok(s.total===53,'总发牌 53 张（13×4 + 庄家第 14 张）');
  ok(s.wall===108-53,'牌墙余 '+(108-53)+' 张');
  ok(s.counts[s.dealer]===14,'庄家手上 14 张（先拿）');
  ok(s.counts.filter((c,i)=>i!==s.dealer).every(c=>c===13),'其余三家各 13 张');

  console.log('\n===== ④ 色子规则：点数→开牌位置 自洽性（跑 200 次） =====');
  s=await ev(`(()=>{const bad=[];for(let i=0;i<200;i++){G.dealer=i%4;const r=rollDice();
    if(r.taker!==(G.dealer+r.sum-1+4)%4)bad.push('taker');   // 庄家算第 1 家 → sum-1
    if(r.skip!==Math.min(r.d1,r.d2)||r.skip<1||r.skip>6)bad.push('skip');
    if(!(r.start>=0&&r.start<108))bad.push('start');
    if(r.sum!==r.d1+r.d2||r.d1<1||r.d1>6||r.d2<1||r.d2>6)bad.push('dice');
    if(r.taker<0||r.taker>3)bad.push('takerRange');}
    return {bad:[...new Set(bad)],sample:rollDice()};})()`);
  console.log('  '+JSON.stringify(s));
  ok(s.bad.length===0,'200 次掷色子全部满足规则（数家/留墩/起点范围）');

  console.log('\n===== ⑤ 对家自摸 → 对家接庄 + 积分写进 localStorage =====');
  s=await ev(`(()=>{
    const before=JSON.parse(localStorage.getItem('gymj.v1')).records[NAMES[0]];
    G.hands[2]=emptyC();[0,0,0,1,1,1,2,2,2,3,3,3,4,4].forEach(c=>G.hands[2][c]++);
    doHu(2,-1,true);
    const after=JSON.parse(localStorage.getItem('gymj.v1')).records[NAMES[0]];
    return {dealer:G.dealer,nextDealer:G.nextDealer,turn:G.turn,scores:G.scores,hands:after.hands,recScores:after.scores,recDealer:after.dealer,
      before:{hands:before.hands,scores:before.scores},resultWin:G.result.winner};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.resultWin===2,'对家胡了');
  // 胜家接庄**不立刻生效**：结算窗和积分板上还显示着本局的「庄」，当场换庄就会"庄和本局数据对不上"
  // （用户实测反馈）。所以结算时只暂存到 G.nextDealer，下一局开局（startHand）才真正生效。
  ok(s.nextDealer===2,'胜家（对家）已暂存为下一局庄家（结算时 G.dealer 仍为本局庄）');
  ok(s.recDealer===2,'庄位（下一局的庄）已存进 localStorage');
  ok(s.hands===1,'局数已记录 = 1');
  ok(s.recScores[2]>0&&s.recScores[0]<0,'分数已写入（对家 '+s.recScores[2]+' / 你 '+s.recScores[0]+'）');
  ok(JSON.stringify(s.recScores)===JSON.stringify(s.scores),'存档分数与内存分数一致');
  // 关键补验：暂存的庄位必须在**下一局开局那一刻**真的生效（否则"延后换庄"就变成了"永不换庄"）。
  s=await ev(`(()=>{const before=G.dealer;startHand();return {before:before,now:G.dealer,next:G.nextDealer,phase:G.phase};})()`);
  console.log('  '+JSON.stringify(s));
  ok(s.now===2,'下一局开局时庄位落到胜家（对家）身上（结算时还是 '+s.before+'）');
  ok(s.next===null,'暂存值用掉后已清空');

  console.log('\n===== ⑥ 刷新页面：名字/分数/庄位/局数 全部恢复 =====');
  // ⚠️ "谁先拿牌"必须在**发牌刚结束、AI 还没动手**的窗口内看：
  //    开局(1.62s) 发牌 → 庄家摸+打(2.27s) → 下家摸+打(2.92s) → … 测晚了看到的是
  //    轮到玩家时手里那 14 张，会误判成"庄家没先拿"。
  await send(ws,'Page.navigate',{url});await sleep(1750);
  let first=await ev(`(()=>({dealer:G.dealer,turn:G.turn,counts:[0,1,2,3].map(p=>G.hands[p].reduce((a,b)=>a+b,0)),wall:G.wall.length,diceOn:document.getElementById('dice').classList.contains('on')}))()`);
  console.log('  发牌刚结束时：'+JSON.stringify(first));
  ok(first.dealer===2,'刷新后庄家=对家');
  ok(first.turn===2,'由庄家（对家）先出牌');
  ok(first.counts[2]===14&&first.counts.filter((c,i)=>i!==2).every(c=>c===13),'庄家 14 张、其余各 13 张');
  ok(first.wall===55,'牌墙余 55 张');
  await sleep(1200);
  s=await ev(`(()=>({name:NAMES[0],dealer:G.dealer,hands:G.handNo,scores:G.scores,phase:G.phase,
    rec:JSON.parse(localStorage.getItem('gymj.v1')).records[NAMES[0]]}))()`);
  console.log('  '+JSON.stringify(s));
  ok(s.name&&s.name!=='你','名字已恢复：'+s.name);
  ok(s.dealer===2,'庄位已恢复（对家坐庄）');
  ok(s.hands===1,'局数已恢复');
  ok(JSON.stringify(s.scores)===JSON.stringify(s.rec.scores),'分数已恢复');
  await sleep(600);
  s=await ev(`(()=>({dealerText:document.getElementById('dDealer').textContent,dealer:G.dealer}))()`);
  console.log('  开局色子层：'+JSON.stringify(s));
  ok(/对家/.test(s.dealerText||''),'刷新后由对家摇色子');

  console.log('\n===== ⑦ 改名：换名字从 0 开始，旧记录还在 =====');
  s=await ev(`(()=>{
    const old=Store.data.name;
    openNameDlg(false);
    document.getElementById('nameInput').value='新玩家乙';
    confirmName();
    const d=JSON.parse(localStorage.getItem('gymj.v1'));
    return {old,now:NAMES[0],scores:G.scores,deal:G.dealer,
      oldRecStillThere:!!d.records[old],newRec:!!d.records['新玩家乙'],
      saveName:d.name,recNames:Object.keys(d.records)};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.now==='新玩家乙','名字已切换');
  ok(s.scores.every(v=>v===0),'新名字从 0 分开始');
  ok(s.oldRecStillThere===true,'旧名字的成绩还在：'+s.recNames.join('/'));

  console.log('\n===== ⑧ 点积分板自己的名字 → 能打开改名层 =====');
  await ev("render()");
  s=await ev(`(()=>{const row=document.querySelector('#scoreBoard .srow.mine');
    if(!row)return {row:false};
    row.click();
    return {row:true,open:document.getElementById('nameDlg').classList.contains('on')};})()`);
  console.log('  '+JSON.stringify(s));
  ok(s.row===true,'积分板上有「自己」那一行');
  ok(s.open===true,'点它打开了改名层');
  s=await ev(`(()=>{closeNameDlg();return document.getElementById('nameDlg').classList.contains('on')?'still':'closed';})()`);
  ok(s==='closed','点遮罩/关闭能收起');

  console.log('\n===== ⑨ 荒庄：庄家连庄 =====');
  s=await ev(`(()=>{G.dealer=1;G.wall=[];endGame();
    const d=JSON.parse(localStorage.getItem('gymj.v1')).records['新玩家乙'];
    return {dealer:G.dealer,recDealer:d.dealer,hands:d.hands};})()`);
  console.log('  '+JSON.stringify(s));
  ok(s.dealer===1,'荒庄后庄家不变（连庄）');
  ok(s.recDealer===1,'连庄也存进存档');


  console.log('\n===== ⑩ 结算关掉后「本局详情 / 再来一局」不会赖着不走 =====');
  s=await ev(`(()=>{
    G.phase='over';G.revealAll=true;G.result={winner:1,winTile:-1};render();
    hideResult();                       // 关掉结算窗 → 两个按钮出现（这是设计意图）
    const shown=document.getElementById('endBtns').classList.contains('on');
    closeResult();                      // 点「再来一局」→ 直接开新局
    return {shown:shown,afterStart:document.getElementById('endBtns').classList.contains('on'),phase:G.phase};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.shown===true,'结算窗关掉后按钮出现（能随时叫回详情 / 直接开下一局）');
  ok(s.afterStart===false,'新局一开始按钮就收起了（phase='+s.phase+'）');

  console.log('\n===== ⑪ AI：危险度模型 + 出牌合法性 =====');
  s=await ev(`(()=>{
    // 造一个「下一家打过 3 筒、别处没见过」的牌河：3 筒对那一家是现物
    G.melds=[[],[],[],[]];G.discards=[[],[20], [], []];G.wall=new Array(20).fill(0);
    const dGen=dangerScore(20,0), dFresh=dangerScore(13,0);
    G.wall=new Array(60).fill(0);const wEarly=dangerWeight(0);
    G.wall=new Array(16).fill(0);const wLate=dangerWeight(0);
    // 出牌合法性：必须是自己手里真的有的牌
    G.hands[0]=new Array(27).fill(0);[0,1,2,2,4,4,6,6,8,8,10,12,14].forEach(c=>G.hands[0][c]++);
    const pick=aiDiscardSmart(0);
    return {dGen:dGen,dFresh:dFresh,wEarly:wEarly,wLate:wLate,pick:pick,has:G.hands[0][pick]>0};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.dGen<s.dFresh,'现物比生张安全（'+s.dGen.toFixed(2)+' < '+s.dFresh.toFixed(2)+'）');
  ok(s.wLate>s.wEarly*2,'尾声的危险权重明显更高（'+s.wEarly.toFixed(2)+' → '+s.wLate.toFixed(2)+'）');
  ok(s.has===true,'AI 出的牌一定在自己手里');

  console.log('\n===== ⑫ 出牌两步确认：先预选、再点一次才打出 =====');
  // 用户明确要求：点一张牌 = 预选（弹起来），再点它才打出；但「建议打出的那张」仍然一点即出。
  // 这里逐个把三种情形跑一遍（手牌用固定牌型，保证 suggestCard 有明确结果）。
  s=await ev(`(()=>{
    const T=27;
    G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.pendingAction=null;G.phase='discard';G.turn=0;
    G.hands[0]=new Array(T).fill(0);
    [0,1,2,3,3,5,5,7,7,9,9,11,11,13].forEach(c=>G.hands[0][c]++);
    G.drawn=null;G.picked=null;
    const sug=suggestCard(0);
    const list=toList(G.hands[0]).sort((a,b)=>a-b);
    const other=list.filter(c=>c!==sug)[0];      // 挑一张"不是建议牌"的
    const before={hand:list.length,disc:G.discards[0].length};
    // ① 点非建议牌 → 只预选
    onTileClick(other);
    const afterPick={hand:G.hands[0].reduce((a,b)=>a+b,0),disc:G.discards[0].length,
                     picked:G.picked,domPick:document.querySelectorAll('#myHand .tile.picked').length};
    // ② 再点同一张 → 打出
    onTileClick(other);
    const afterDiscard={hand:G.hands[0].reduce((a,b)=>a+b,0),disc:G.discards[0].length,
                        picked:G.picked,last:G.lastDiscard,by:G.lastDiscardBy,
                        domPick:document.querySelectorAll('#myHand .tile.picked').length};
    // ③ 点"建议打出的那张"：也**必须先预选**，再点一次才出（不能留快捷路径）
    G.hands[0]=new Array(T).fill(0);
    [0,1,2,3,3,5,5,7,7,9,9,11,11,13].forEach(c=>G.hands[0][c]++);
    G.discards[0]=[];G.picked=null;G.turn=0;G.phase='discard';G.pendingAction=null;
    const sug2=suggestCard(0);
    onTileClick(sug2);
    const sugFirst={hand:G.hands[0].reduce((a,b)=>a+b,0),disc:G.discards[0].length,picked:G.picked};
    onTileClick(sug2);
    const sugSecond={hand:G.hands[0].reduce((a,b)=>a+b,0),disc:G.discards[0].length,picked:G.picked};
    // ④ 换来换去：点 A 预选 → 点 B（A 收回、B 预选、都没打出）→ 再点 A（A 重新上弹，不打出）
    G.hands[0]=new Array(T).fill(0);
    [0,1,2,3,3,5,5,7,7,9,9,11,11,13].forEach(c=>G.hands[0][c]++);
    G.discards[0]=[];G.picked=null;G.turn=0;G.phase='discard';G.pendingAction=null;
    const list2=toList(G.hands[0]).sort((a,b)=>a-b);
    const A=list2[2],B=list2[9];
    onTileClick(A);                                     // 预选 A
    const sw1={picked:G.picked,A:document.querySelectorAll('#myHand .tile.picked').length,disc:G.discards[0].length};
    onTileClick(B);                                     // 改点 B
    const sw2={picked:G.picked,A:document.querySelectorAll('#myHand .tile.picked').length,disc:G.discards[0].length};
    onTileClick(A);                                     // 再点回 A
    const sw3={picked:G.picked,dom:document.querySelectorAll('#myHand .tile.picked').length,disc:G.discards[0].length,
               hand:G.hands[0].reduce((a,b)=>a+b,0)};
    // ⑤ 不是自己的回合 → 什么都不该发生
    G.hands[0]=new Array(T).fill(0);
    [0,1,2,3,3,5,5,7,7,9,9,11,11,13].forEach(c=>G.hands[0][c]++);
    G.turn=1;G.picked=null;G.discards[0]=[];
    onTileClick(7);
    const notMyTurn={picked:G.picked,disc:G.discards[0].length,hand:G.hands[0].reduce((a,b)=>a+b,0)};
    return {sug:sug,other:other,before:before,afterPick:afterPick,afterDiscard:afterDiscard,
            sug2:sug2,sugFirst:sugFirst,sugSecond:sugSecond,
            A:A,B:B,sw1:sw1,sw2:sw2,sw3:sw3,notMyTurn:notMyTurn};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.other!==s.sug,'挑出的牌确实不是建议牌（建议='+s.sug+' 挑='+s.other+'）');
  ok(s.afterPick.hand===s.before.hand&&s.afterPick.disc===s.before.disc,
     '第一次点非建议牌**不出牌**（手牌 '+s.before.hand+'、弃牌 '+s.before.disc+' 都没变）');
  ok(s.afterPick.picked===s.other,'该牌被记为预选');
  ok(s.afterPick.domPick===1,'界面上真的有一张牌带 .picked（抬起高亮）');
  ok(s.afterDiscard.disc===s.before.disc+1&&s.afterDiscard.hand===s.before.hand-1,
     '第二次点同一张才打出（弃牌 +1、手牌 -1）');
  ok(s.afterDiscard.picked===null&&s.afterDiscard.domPick===0,'打出后预选态清掉');
  ok(s.afterDiscard.last===s.other&&s.afterDiscard.by===0,'打出的就是那张被预选的牌');
  // ③ 建议牌也走两步（用户否掉了"点建议牌一点即出"的快捷路径）
  ok(s.sugFirst.disc===0&&s.sugFirst.hand===14&&s.sugFirst.picked===s.sug2,
     '点「建议打出的那张」**不会**直接打出，只是先预选（弃牌 '+s.sugFirst.disc+'）');
  ok(s.sugSecond.disc===1&&s.sugSecond.hand===13&&s.sugSecond.picked===null,
     '建议牌也要再点一次才打出');
  // ④ 换来换去：旧牌收回、新牌预选、都不打出；点回旧牌是"重新上弹"而不是打出
  ok(s.sw1.picked===s.A&&s.sw1.A===1&&s.sw1.disc===0,'点 A：A 预选、没打出');
  ok(s.sw2.picked===s.B&&s.sw2.A===1&&s.sw2.disc===0,
     '再点 B：A 收回、B 预选（界面仍只有 1 张立着），**没有**把 A 打出去');
  ok(s.sw3.picked===s.A&&s.sw3.dom===1&&s.sw3.disc===0&&s.sw3.hand===14,
     '再点回 A：A 重新上弹（不是直接打出，手牌仍是 14 张）');
  ok(s.notMyTurn.picked===null&&s.notMyTurn.disc===0&&s.notMyTurn.hand===14,'不是自己回合时点牌没有任何反应');

  console.log('\n===== ⑬ 预选后其它牌收回手牌：同时只允许一张牌立起来 =====');
  // 用户要求：一张牌被预选弹起后，其它牌（"刚摸到"的那张、建议牌）都要收回手牌，
  // 同一时间只有一张牌处于"立起来/预选"的状态。
  s=await ev(`(()=>{
    const T=27;
    G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.pendingAction=null;G.phase='discard';G.turn=0;
    G.hands[0]=new Array(T).fill(0);
    [0,1,2,3,3,5,5,7,7,9,9,11,11,13].forEach(c=>G.hands[0][c]++);
    G.drawn=13;G.picked=null;render();                 // "刚摸到 九万"
    const q=sel=>document.querySelectorAll('#myHand '+sel).length;
    const mh=document.getElementById('myHand');
    const drawnEl=document.querySelector('#myHand .tile.drawn');
    const before={sug:q('.tile.sug'),drawn:q('.tile.drawn'),picked:q('.tile.picked'),
                  picking:mh.classList.contains('picking'),
                  drawnLift:drawnEl?getComputedStyle(drawnEl).marginTop:'(无)'};
    const sug=suggestCard(0);
    const list=toList(G.hands[0]).sort((a,b)=>a-b);
    const other=list.filter(c=>c!==sug&&c!==13)[0];
    onTileClick(other);                                // 预选一张别的牌
    const d2=document.querySelector('#myHand .tile.drawn');
    const after={sug:q('.tile.sug'),drawn:q('.tile.drawn'),picked:q('.tile.picked'),
                 picking:mh.classList.contains('picking'),
                 drawnLift:d2?getComputedStyle(d2).marginTop:'(无)',
                 raised:q('.tile.picked')+q('.tile.sug'),
                 log:document.getElementById('log').textContent};
    return {sug:sug,other:other,before:before,after:after};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.before.picked===0&&s.before.sug<=1,'预选前：没有预选牌（建议牌最多 1 张）');
  ok(s.after.picked===1,'预选后：恰好 1 张牌被预选（'+s.after.picked+'）');
  ok(s.after.sug===0,'预选后：建议牌的绿框/弹跳收回（.sug='+s.after.sug+'）');
  ok(s.after.picking===true&&s.after.drawnLift==='0px',
     '预选后："刚摸到"的那张收回手牌不再抬起（margin-top='+s.after.drawnLift+'）');
  ok(s.after.raised===1,'预选后：同一时间只有 1 张牌立着（'+s.after.raised+'）');
  ok(/再点一次出牌/.test(s.after.log||''),'日志提示"再点一次出牌"（'+String(s.after.log||'').slice(0,20)+'）');

  console.log('\n===== ⑭ 同时可选的动作要全部弹出来 =====');
  // 用户反馈：有胡牌、补杠等同时可选时应该弹出所有选项。
  // 根因：原来只存一个 G.pendingAction → 三个分支各 return，同时可选时只弹一个。
  s=await ev(`(()=>{
    const btn=()=>[...document.querySelectorAll('#actions button')].map(b=>b.textContent);
    const base=()=>{G.phase='discard';G.actions=[];G.pendingAction=null;G.picked=null;G.drawn=null;
      G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.wall=new Array(20).fill(0);G.gangFlower=false;
      G.hands=[emptyC(),emptyC(),emptyC(),emptyC()];G.turn=0;render();};
    const out={};
    // ① 别人打出一万：我既能胡（大对子）又能碰（手里两张一万）
    base();
    [0,0,1,1,1,2,2,2,3,3,3,4,4].forEach(c=>G.hands[0][c]++);
    G.turn=1;render();checkClaims(1,0);
    out.huPeng={acts:G.actions.map(a=>a.type),btns:btn()};
    // ② 别人打出六万：我手里三张六万 → 杠 + 碰 同时可选
    base();
    [5,5,5,0,3,9,12,15,18,21,24,1,2].forEach(c=>G.hands[0][c]++);
    G.turn=1;render();checkClaims(1,5);
    out.gangPeng={acts:G.actions.map(a=>a.type),btns:btn()};
    // ③ 自己回合：摸到一万（手里共 4 张）→ 自摸 + 暗杠 同时可选
    base();
    [0,0,0,0,1,2,3,3,3,4,4].forEach(c=>G.hands[0][c]++);
    G.drawn=0;G.turn=0;render();
    out.zimoAnGang={btns:btn()};
    // ④ 过：把所有待决动作清掉
    base();
    [0,0,1,1,1,2,2,2,3,3,3,4,4].forEach(c=>G.hands[0][c]++);
    G.turn=1;render();checkClaims(1,0);
    const n1=G.actions.length;
    const guo=[...document.querySelectorAll('#actions button')].find(b=>b.textContent==='过');
    if(guo)guo.click();
    out.pass={before:n1,after:G.actions.length,pending:G.pendingAction};
    return out;
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.huPeng.acts.length===2&&s.huPeng.acts[0]==='hu'&&s.huPeng.acts[1]==='peng',
     '能胡又能碰时两个动作都列出（'+s.huPeng.acts.join('+')+'）');
  ok(s.huPeng.btns.filter(t=>/胡|碰/.test(t)).length===2,'界面上真的有两个按钮：'+s.huPeng.btns.join('/'));
  ok(s.gangPeng.acts.length===2&&s.gangPeng.acts[0]==='gang'&&s.gangPeng.acts[1]==='peng',
     '能杠又能碰时两个动作都列出（'+s.gangPeng.acts.join('+')+'）');
  ok(s.zimoAnGang.btns.some(t=>/自摸/.test(t))&&s.zimoAnGang.btns.some(t=>/暗杠/.test(t)),
     '自己回合能自摸又能暗杠时两个按钮都在：'+s.zimoAnGang.btns.join('/'));
  ok(s.pass.before===2&&s.pass.after===0&&s.pass.pending===null,'点「过」会清掉全部待决动作');

  console.log('\n===== ⑮ 豆（杠）的结算：每个豆一律 3 个，方向看杠家叫没叫牌 =====');
  // 每个豆一律 3 个。杠家叫牌 → 对手付给他；杠家未叫牌 → 他**倒赔**给叫牌家。
  // 点豆（别人放的第 4 张）只跟**放杠那一家**算，另外两家不牵动。
  s=await ev(`(()=>{
    const tingHand=[0,0,0,1,1,1,2,2,2,3];
    const notTingHand=[0,2,3,6,9,12,15,18,21,24];
    const prep=(meld1,hand1)=>{
      G.phase='discard';G.actions=[];G.pendingAction=null;
      G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.wall=new Array(20).fill(0);
      G.hands=[emptyC(),emptyC(),emptyC(),emptyC()];
      hand1.forEach(c=>G.hands[1][c]++);
      G.melds[1]=[meld1];
      G.qiangGang=false;G.gangFlower=false;G.hotCannonGang=null;G.dealer=0;
      render();
    };
    const run=(meld1,hand1,win)=>{
      prep(meld1,hand1);
      const lines=[],total=[0,0,0,0];
      douSettle(win===undefined?0:win,-1,false,lines,total);
      return {total:total,lines:lines};
    };
    prep({type:'gang',card:5,from:-1},tingHand);   // 先摆好状态再判叫牌（否则判的是上一条用例的残留状态）
    const ting=isTing(1);
    const bu=run({type:'gang',card:5,from:0,paPo:true},tingHand);        // 补杠（自杠），1 号叫牌
    const an=run({type:'gang',card:5,from:-1},tingHand);                 // 暗杠（自杠），1 号叫牌
    const mg=run({type:'gang',card:5,from:3},tingHand);                  // 点豆，1 号叫牌，放杠者=3
    const offBu=run({type:'gang',card:5,from:0,paPo:true},notTingHand);  // 补杠，1 号**未**叫牌
    const offMgNoTing=run({type:'gang',card:5,from:3},notTingHand);      // 点豆，1 号未叫牌、放杠者 3 也没叫牌
    const offMgTing=run({type:'gang',card:5,from:0},notTingHand,0);      // 点豆，1 号未叫牌、放杠者 0 是"胡牌者"
    return {ting:ting,bu:bu,an:an,mg:mg,offBu:offBu,offMgNoTing:offMgNoTing,offMgTing:offMgTing};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.ting===true,'构造的手牌确实是叫牌（isTing=1）');
  ok(s.bu.total[1]===9&&s.bu.total[0]===-3&&s.bu.total[2]===-3&&s.bu.total[3]===-3,
     '补杠（自杠·叫牌）：其他三家各付 3 个 → 1 号 +9（实际 '+JSON.stringify(s.bu.total)+'）');
  ok(s.an.total[1]===9&&s.an.total[0]===-3&&s.an.total[2]===-3&&s.an.total[3]===-3,
     '暗杠（自杠·叫牌）：其他三家各付 3 个 → 1 号 +9（与补杠**同分**，不再分 2/3）',JSON.stringify(s.an.total));
  ok(s.mg.total[1]===3&&s.mg.total[3]===-3&&s.mg.total[0]===0&&s.mg.total[2]===0,
     '点豆（叫牌）：**只有放杠那家付 3 个**，另外两家一分不牵动（实际 '+JSON.stringify(s.mg.total)+'）');
  ok(s.offBu.total[1]===-3&&s.offBu.total[0]===3&&s.offBu.total[2]===0&&s.offBu.total[3]===0,
     '自杠但杠家**未叫牌** → 倒赔给叫牌家各 3 个（1 号 −3、胡家 0 号 +3）',JSON.stringify(s.offBu.total));
  ok(s.offBu.lines.some(l=>/未叫牌/.test(l)&&/倒赔/.test(l)),'明细写明"未叫牌 → 倒赔"',s.offBu.lines);
  ok(s.offMgNoTing.total.every(v=>v===0)&&s.offMgNoTing.lines.some(l=>/不叫牌不用给/.test(l)),
     '点豆 + 杠家未叫牌 + 放杠者也没叫牌 → 不结算（"不叫牌不用给"）',s.offMgNoTing);
  ok(s.offMgTing.total[1]===-3&&s.offMgTing.total[0]===3,
     '点豆 + 杠家未叫牌 + 放杠者是叫牌家 → 倒赔给放杠那家 3 个',JSON.stringify(s.offMgTing.total));
  // 文案体检：结算明细是**纯文本**（不是 Markdown），漏进 ** 或反引号玩家就会看到字面星号
  //（本项目实测抓到过 3 处：冲锋鸡责任转移 / 责任鸡 / 豆倒赔）。
  const douAll=[].concat(s.bu.lines,s.an.lines,s.mg.lines,s.offBu.lines,s.offMgNoTing.lines,s.offMgTing.lines);
  const douDirty=douAll.filter(l=>/\*\*|`/.test(l));
  ok(douDirty.length===0,'豆的明细里没有漏进 Markdown 记号（** 或反引号）',douDirty);

  console.log('\n===== ⑯ 荒庄查叫：未叫牌者赔给叫牌者 =====');
  s=await ev(`(()=>{
    G.phase='discard';G.actions=[];G.pendingAction=null;
    G.melds=[[],[],[],[]];G.discards=[[],[],[],[]];G.wall=[];
    G.hands=[emptyC(),emptyC(),emptyC(),emptyC()];
    [0,0,0,1,1,1,2,2,2,3,3,3,4].forEach(c=>G.hands[0][c]++);
    [0,2,3,6,9,12,15,18,21,24,1,4,7].forEach(c=>G.hands[1][c]++);
    [0,2,3,6,9,12,15,18,21,24,1,4,7].forEach(c=>G.hands[2][c]++);
    [0,2,3,6,9,12,15,18,21,24,1,4,7].forEach(c=>G.hands[3][c]++);
    G.scores=[0,0,0,0];G.roundScore=[0,0,0,0];G.handNo=0;G.dealer=0;
    const lines=[],total=[0,0,0,0];
    const info=chajiaoSettle(lines,total);
    const tf=tingFan(0);
    return {tingL:info.tingL,noL:info.noL,fan:tf,lines:lines,total:total};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.tingL.length===1&&s.tingL[0]===0&&s.noL.length===3,'只有 0 号叫牌（叫牌），其余三家未叫');
  ok(s.fan.fan>=1,'叫牌番值算出来了：'+s.fan.name+' '+s.fan.fan+' 番');
  ok(s.total[0]===s.fan.fan*3&&s.total[1]===-s.fan.fan,
     '未叫的三家各赔叫牌者的番值（0 号 +'+s.total[0]+'，其余各 '+s.total[1]+'）');
  ok(s.total.reduce((a,b)=>a+b,0)===0,'赔付总和为 0（只做转移，不凭空产生分）');

  console.log('\n===== ⑰ 结算窗：× 关掉之后「本局详情」要能再打开 =====');
  // 用户实测：点 × 关掉结算窗后，再点「本局详情」弹不出来。
  // 根因：reopenResult() 一度只调 expandResult()，而它只去掉 peekMode、不恢复 display:none → flex。
  s=await ev(`(()=>{
    G.phase='over';G.result={winner:0,winTile:-1};G.actions=[];G.pendingAction=null;
    showResult({winner:0,pat:{name:'平胡',fan:1},lines:['测试用结算行'],total:[8,-4,-2,-2]});
    const r=document.getElementById('result');
    const eb=document.getElementById('endBtns');
    const q=()=>({display:r.style.display,peek:!!(r.classList&&r.classList.contains('peekMode')),
                 endBtnsOn:!!(eb&&eb.classList&&eb.classList.contains('on'))});
    const afterShow=q();
    const x=document.querySelector('#result .xBtn');if(x)x.click();
    const afterClose=q();
    const rb=document.getElementById('reopen');if(rb)rb.click();
    const afterReopen=q();
    return {afterShow:afterShow,afterClose:afterClose,afterReopen:afterReopen,hasReopen:!!rb};
  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.afterShow.display==='flex'&&s.afterShow.peek===true,'结算窗出现时是收起态（四家手牌能看见）');
  ok(s.afterClose.display==='none','点「×」后结算窗关闭');
  ok(s.hasReopen===true,'关掉后「本局详情」按钮存在');
  ok(s.afterReopen.display==='flex','点「本局详情」结算窗重新出现（display='+s.afterReopen.display+'）');
  ok(s.afterReopen.peek===false,'「本局详情」是展开态，能看完整明细');

  console.log('\n===== ⑰b 展开后不会自己缩回去（用户实测反馈） =====');
  // 用户反馈："结算详情点击放大后，会自动缩回去"。
  // 根因：openResult/expandResult 里有一个 3.2 秒的 setTimeout(peekTable) —— 那是
  // "别一直挡着牌桌"的旧设计，但用户**主动**点开看明细时窗体自己跑掉，体验就是"点不开"。
  // 现在：展开态只由用户动作改变（点窗外空白处 / 点「×」），没有任何自动收起。
  s=await ev(`(()=>{
    G.phase='over';G.result={winner:0,winTile:-1};G.actions=[];G.pendingAction=null;
    showResult({winner:0,pat:{name:'平胡',fan:1},lines:['测试用结算行'],total:[8,-4,-2,-2]});
    const r=document.getElementById('result'),box=document.getElementById('resultBox');
    if(box)box.click();                                    // 点窗体 → 展开
    // ⚠️ 必须**冻住对局**再等：AI 的 setTimeout 链还在跑，牌摸完后 endGame() 会
    //    合法地重开结算窗（并收起），那是正常行为，会把这条断言污染成假红（实测踩过：
    //    探针打出的调用栈是 peekTable <- endGame <- drawTile）。
    window.__pk=[];const _pk=peekTable;
    window.peekTable=function(){try{__pk.push(new Error().stack.split('\\n').slice(1,3).join(' <- '));}catch(e){}return _pk.apply(this,arguments);};
    const _dt=drawTile;window.drawTile=function(){return;};
    window.__restore=()=>{window.drawTile=_dt;window.peekTable=_pk;};
    window.__q=()=>({display:r.style.display,peek:!!(r.classList&&r.classList.contains('peekMode')),
                     pk:__pk.length,why:__pk[__pk.length-1]||''});
    return __q();
  })()`);
  console.log('  点窗体展开后：'+JSON.stringify(s));
  ok(s.display==='flex'&&s.peek===false,'点窗体后进入展开态');
  await sleep(3800);                                        // 老版本 3.2 秒就会缩回去
  let s2=await ev('__q()');
  console.log('  等 3.8 秒后：'+JSON.stringify(s2));
  ok(s2.display==='flex'&&s2.peek===false,'展开后等 3.8 秒**仍是展开态**（不再自动缩回角落）');
  ok(s2.pk===0,'这 3.8 秒里没有任何人调用 peekTable（真·零自动收起）');
  s2=await ev(`(()=>{const r=document.getElementById('result');
    r.dispatchEvent(new MouseEvent('click',{bubbles:true}));    // 点窗外的空白处
    return __q();})()`);
  console.log('  点窗外空白处：'+JSON.stringify(s2));
  ok(s2.peek===true,'展开态点窗外的空白 → 收起到角落（这就是「看四家亮牌」按钮删除后补上的入口）');
  s2=await ev(`(()=>{const r=document.getElementById('result');
    r.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    return {display:r.style.display,peek:!!(r.classList&&r.classList.contains('peekMode'))};})()`);
  console.log('  收起态再点空白：'+JSON.stringify(s2));
  ok(s2.display==='flex'&&s2.peek===true,'收起态点窗外的空白**不会**关闭弹窗（防误触，用户要求）');
  await ev(`(()=>{window.__restore();const x=document.querySelector('#result .xBtn');if(x)x.click();return 'ok';})()`);

  console.log('\n===== ⑱ AI 该碰的牌要真的碰（向听比较不能漏算碰出来的那副） =====');
  // 用户反馈：电脑玩家好像很少碰牌。根因：shouldPeng 算"碰之后"的向听数时只写了 h2[card]-=2，
  // **忘了把碰出来的那 3 张算回去** → 等于凭空少 3 张牌 → 向听数永远变差 → 几乎从不碰。
  // 实测 300 副手牌：旧写法 1% 通过，正确写法 95%。
  s=await ev(`(()=>{
    const T=27;
    G.melds=[[],[],[],[]];G.hands=[emptyC(),emptyC(),emptyC(),emptyC()];
    // ① 明显该碰：手里一对三万 + 其余散张（无副露、对子只有 1 个）
    const h=new Array(T).fill(0);[1,1,4,7,10,13,16,19,22,25,3,6,9].forEach(c=>h[c]++);
    G.hands[1]=h;G.melds[1]=[];
    const clearPeng=shouldPeng(1,1);
    // ② 七对路线：对子≥4 且还没副露 → 该保留七对，不碰
    const h2=new Array(T).fill(0);[0,0,3,3,6,6,9,9,12,15,18,21,24].forEach(c=>h2[c]++);
    G.hands[1]=h2;G.melds[1]=[];
    G.aiBig[1]=true;                    // 明确按"做大牌风"断言（七对门槛只对他生效）
    const pairPeng=shouldPeng(1,0);
    G.aiBig[1]=false;                    // 同一副牌，"优先叫牌风"就应该碰（不再为七对让路）
    const pairPengFast=shouldPeng(1,0);
    G.aiBig[1]=true;
    // ③ 已有 4 副露 → 没位置了
    G.hands[1]=h;G.melds[1]=[{type:'peng',card:2,from:0},{type:'peng',card:5,from:0},{type:'peng',card:8,from:0},{type:'peng',card:11,from:0}];
    const fullPeng=shouldPeng(1,1);
    // ④ 直接核对向听口径：碰之后（手牌 -2、多一副面子）不应该比碰之前差
    G.hands[1]=h;G.melds[1]=[];
    const before=shanten(h,0);
    const after=shanten((()=>{const x=h.slice();x[1]+=1;return x;})(),1);
    return {clearPeng:clearPeng,pairPeng:pairPeng,pairPengFast:pairPengFast,fullPeng:fullPeng,before:before,after:after};

  })()`);
  console.log('  '+JSON.stringify(s));
  ok(s.clearPeng===true,'明显该碰的手牌，AI 会碰（旧写法这里返回 false）');
  ok(s.pairPeng===false,'手里 4 对且没副露 → 保留七对路线，不碰');
  ok(s.pairPengFast===true,'同一副牌换"优先叫牌风" → 该碰就碰（不为七对让路）');
  ok(s.fullPeng===false,'已有 4 副露 → 没位置碰');
  ok(s.after<=s.before,'碰之后的向听数不比碰之前差（'+s.before+' → '+s.after+'）');

  if(errs.length)console.log('\n页面异常:\n'+errs.join('\n'));
  console.log('\n>>> '+(FAIL?'❌ '+FAIL+' 项不通过':'✅ 全部 '+PASS+' 项通过'));
  ws.close();proc.kill();
  await sleep(500);
  // profile 同盘改名收尾（沙箱不允许 rmSync Edge profile 目录）
  try{fs.renameSync(PROFILE,path.join(BASE,'_trash_logic_'+Date.now()));}catch(e){}
  process.exit(FAIL?1:0);
})();
