/* 安全改文件的小工具 —— 专门针对"用脚本批量改单文件 HTML/JS"。
 *
 * 为什么需要它：本项目在同一个会话里**三次**因为补丁脚本的索引问题改坏文件：
 *   ① forEach 里对自己的数组 splice → 同一段注释被复制 1064 遍；
 *   ② findIndex 返回 -1 仍拿去 splice(i+1,...) → 插到文件第 0 行，CSS 跑到 <!DOCTYPE> 之前；
 *   ③ findIndex 返回 -1 仍拿去 splice(i-4,5,...) → **负索引 = 从尾部数**，
 *      结果文件头 5 行、尾 5 行各被替换掉（`<!DOCTYPE>`、`</script></body></html>` 全丢）。
 *
 * 用法：
 *   const P=require('./patch.js');
 *   const p=P.open('index.html');           // 自动备份 index.html.bak
 *   p.replace('  return bonus;', '  return bonus*2;');       // 整行替换（必须先找到）
 *   p.insertAfter('function foo(){', ['  // 注释','  bar();']);
 *   p.replaceBlock('// 起点', '// 终点', ['新内容']);
 *   p.save();                                // 写盘前再做一次体检
 * 任何一个锚点找不到都会**立刻抛错并放弃写盘**，不会留下改了一半的文件。
 */
const fs=require('fs');

function open(file){
  const src=fs.readFileSync(file,'utf8');
  const L=src.split(/\r?\n/);
  const EOL=/\r\n/.test(src)?'\r\n':'\n';
  // 备份（每次 open 覆盖同一份 .bak，够用；要历史版本就自己再存）
  fs.writeFileSync(file+'.bak',src);
  let dirty=0;
  const fail=m=>{throw new Error(m);};
  const find=(needle)=>{
    if(typeof needle==='function')return needle;                 // 直接给正则/函数
    return l=>l.indexOf(needle)>=0;
  };
  const idxOf=(test,from)=>{
    for(let i=from||0;i<L.length;i++)if(test(L[i]))return i;
    return -1;
  };
  const api={
    lines:()=>L.slice(),
    // 整行替换：oldText 必须**唯一且存在**
    replace(oldText,newText,opts){
      const test=find(oldText);
      const hits=[];
      for(let i=0;i<L.length;i++)if(test(L[i]))hits.push(i);
      if(!hits.length)fail('replace: 找不到锚点「'+String(oldText).slice(0,60)+'」');
      if(hits.length>1&&!(opts&&opts.all))fail('replace: 锚点出现 '+hits.length+' 次，不唯一「'+String(oldText).slice(0,60)+'」');
      hits.forEach(i=>{ L[i]=L[i].split(oldText).join(newText||''); });
      dirty+=hits.length;
      return hits;
    },
    // 在锚点行**之后**插入若干行
    insertAfter(anchor,lines){
      const i=idxOf(find(anchor));
      if(i<0)fail('insertAfter: 找不到锚点「'+String(anchor).slice(0,60)+'」');
      L.splice(i+1,0,...lines);
      dirty+=lines.length;
      return i+1;
    },
    // 在锚点行**之前**插入若干行
    insertBefore(anchor,lines){
      const i=idxOf(find(anchor));
      if(i<0)fail('insertBefore: 找不到锚点「'+String(anchor).slice(0,60)+'」');
      L.splice(i,0,...lines);
      dirty+=lines.length;
      return i;
    },
    // 删掉锚点行之后的 n 行（含锚点行本身：del 传 1）
    removeBlock(anchor,del){
      const i=idxOf(find(anchor));
      if(i<0)fail('removeBlock: 找不到锚点');
      L.splice(i,del||1);
      dirty+=(del||1);
      return i;
    },
    // 用新内容**整段替换**「起点行 ~ 终点行」（含两端）。
    // 专门为"改写一大段函数"准备：起点/终点都找不到、或终点在起点之前 → 直接抛错不写盘，
    // 避免出现"只替换了半段"这种最难查的损坏。
    replaceBlock(startAnchor,endAnchor,lines,opts){
      const a=idxOf(find(startAnchor));
      if(a<0)fail('replaceBlock: 找不到起点「'+String(startAnchor).slice(0,50)+'」');
      const b=idxOf(find(endAnchor),a);
      if(b<0)fail('replaceBlock: 从起点之后找不到终点「'+String(endAnchor).slice(0,50)+'」');
      // ⚠️ 护栏：起点**不是** function 行，却在区间里跨过了另一个 function 定义。
      //    这是"起点锚点撞上了自己刚插入的代码"的典型症状 —— 会整段吃掉后面的函数还不报错。
      //    本项目真踩过：改 doPeng 时新插入的 `if(G.chargeChicken…)` 成了下一步改 doGang 的起点，
      //    结果 doPeng 尾部 + 整个 doGang 被删成了一个函数（语法检查还通过，只有行为悄悄坏掉）。
      const isFn=l=>/^\s*(async\s+)?function\s/.test(l);
      if(!isFn(L[a])&&!(opts&&opts.allowCrossFunction)){
        for(let i=a+1;i<=b;i++){
          if(isFn(L[i]))fail('replaceBlock: 区间跨越了函数定义「'+String(L[i]).trim().slice(0,46)
            +'」(原稿第'+(i+1)+'行) —— 会整段吃掉它。通常说明起点锚点撞到了刚插入的代码；'
            +'请换成更靠前的唯一锚点，确认无误再传 {allowCrossFunction:true}。');
        }
      }
      const del=b-a+1;
      L.splice(a,del,...lines);
      dirty+=lines.length;
      return {at:a+1,removed:del,inserted:lines.length};
    },
    // 与 open() 时的备份做行级 diff，返回差异块（用来核实"只改了我想改的地方"）。
    // 大改动后建议看一眼：任何"删了很多行"的块都要能对应到自己意图内的那次替换。
    diff(opts){
      const A=fs.readFileSync(file+'.bak','utf8').split(/\r?\n/),B=L;
      const max=opts&&opts.maxHunks||40, ctx=opts&&opts.context||2;
      let s=0;while(s<A.length&&s<B.length&&A[s]===B[s])s++;
      let e=0;while(e<A.length-s&&e<B.length-s&&A[A.length-1-e]===B[B.length-1-e])e++;
      const a=A.slice(s,A.length-e),b=B.slice(s,B.length-e);
      const n=a.length,m=b.length;
      const dp=[];for(let i=0;i<=n;i++)dp.push(new Int32Array(m+1));
      for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)
        dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
      const out=[];let i=0,j=0;
      while((i<n||j<m)&&out.length<max){
        const del=[],add=[];const i0=i,j0=j;
        while(i<n||j<m){
          if(i<n&&j<m&&a[i]===b[j])break;
          if(i<n&&(j>=m||dp[i+1][j]>=dp[i][j+1]))del.push(a[i++]);else add.push(b[j++]);
        }
        out.push({atA:s+i0+1,atB:s+j0+1,del:del,add:add});
      }
      return out;
    },
    save(){
      const s=L.join(EOL);
      // 体检：注释配对 + 头尾结构（HTML 文件才有）
      // ⚠️ 注释配对只对**代码文件**查：.md 里正文提到 `/*` `*/` 时会被误判（实测踩过）。
      if(/\.(html?|js|mjs|cjs|css)$/i.test(file)){
        const o=(s.match(/\/\*/g)||[]).length,c=(s.match(/\*\//g)||[]).length;
        if(o!==c)fail('save: 注释不配对 /* '+o+' vs */ '+c+'（拒绝写盘）');
      }
      // 结构体检只对 .html 生效：文档里引用 `<!DOCTYPE html>` / `<script>` 当例子时不该被拦（实测踩过）。
      if(/\.html?$/i.test(file)){
        if(/<!DOCTYPE/i.test(s)&&!/<\/html>\s*$/.test(s))fail('save: 以 </html> 结尾的结构被破坏（拒绝写盘）');
        if(/<script/i.test(s)&&!/<\/script>/.test(s))fail('save: 缺少 </script>（拒绝写盘）');
      }
      fs.writeFileSync(file,s);
      return {lines:L.length,bytes:s.length,changed:dirty};
    }
  };
  return api;
}
module.exports={open};
