// Source scan behind cpu-guards.test.mjs. GPUI redraws the whole window on every cx.notify and
// every setShared, so a timer that runs fast, runs while hidden or writes shared state on each
// tick costs CPU all day. Each finding names the helper to use instead.
import {readFile,readdir} from 'node:fs/promises';
import {join,relative} from 'node:path';

export const MIN_EVERY_MS=1000;
const WORK=/\b(?:exec|sixfoldNativeHelper|runHelper|invokeHelper|invoke|spawnOrRelease)\s*\(|\.spawn\s*\(/;
const GATE=/\bvisible\b|\bhidden\s*\(|windowHidden|sidebarVisible|hostVisible/;
const DEEP_COMPARE=/JSON\.stringify\([^;]*\)\s*[!=]==?\s*JSON\.stringify\(/;
const KEYWORDS=new Set(['if','for','while','switch','catch','function','return','typeof','await','new','async']);

export const ADVICE={
  interval:`periodic work runs at ${MIN_EVERY_MS} ms or slower: react to subscribeJsonFile / watchFolder events, or use createPoll (mods/sixfold-desk/poll.js) with a cheap 'due' check`,
  hidden:"periodic work that spawns a process or task skips while the window is hidden: use createPoll({visible}) (mods/sixfold-desk/poll.js) or check window()?.visible === false / hostVisible() first",
  shared:'shared state written from a timer or file subscription goes through createSharedPublisher (mods/sixfold-desk/shared-publish.js): every setShared rewrites shared.json and re-renders every mod',
  compare:'a sub-second loop compares a cheap stamp (changeGate in poll.js, eventStamp in live-events.js), never JSON.stringify of two whole values',
};

// Skips strings, comments and regex literals well enough for these sources.
function skip(src,i){
  const c=src[i],n=src[i+1];
  if(c==='/'&&n==='/'){const end=src.indexOf('\n',i);return end<0?src.length:end;}
  if(c==='/'&&n==='*'){const end=src.indexOf('*/',i+2);return end<0?src.length:end+2;}
  if(c==='"'||c==="'"||c==='`'){
    for(let j=i+1;j<src.length;j++){if(src[j]==='\\'){j++;continue;}if(src[j]===c)return j+1;}
    return src.length;
  }
  if(c==='/'){
    let k=i-1;while(k>=0&&/\s/.test(src[k]))k--;
    if(k<0||/[(,=:[!&|?{};+\-*%<>~^]/.test(src[k])){
      let inClass=false;
      for(let j=i+1;j<src.length&&src[j]!=='\n';j++){
        if(src[j]==='\\'){j++;continue;}
        if(src[j]==='[')inClass=true;else if(src[j]===']')inClass=false;
        else if(src[j]==='/'&&!inClass)return j+1;
      }
    }
  }
  return i;
}
// Index just past the bracket closing the one at `open`.
export function closing(src,open){
  const pairs={'(':')','{':'}','[':']'},stack=[];
  for(let i=open;i<src.length;){
    const next=skip(src,i);
    if(next!==i){i=next;continue;}
    const c=src[i];
    if(pairs[c])stack.push(pairs[c]);
    else if(c===stack.at(-1)){stack.pop();if(!stack.length)return i+1;}
    i++;
  }
  return src.length;
}
// Top-level arguments of the call whose '(' is at `open`.
export function callArgs(src,open){
  const end=closing(src,open)-1,args=[];let depth=0,start=open+1;
  for(let i=open+1;i<end;){
    const next=skip(src,i);
    if(next!==i){i=next;continue;}
    const c=src[i];
    if('([{'.includes(c))depth++;else if(')]}'.includes(c))depth--;
    else if(c===','&&!depth){args.push(src.slice(start,i).trim());start=i+1;}
    i++;
  }
  const last=src.slice(start,end).trim();if(last)args.push(last);
  return args;
}
const lineAt=(src,index)=>src.slice(0,index).split('\n').length;

// A number, or a same-file constant made of numbers and arithmetic. Anything else is null.
export function resolveMs(src,text){
  const arithmetic=value=>/^[\d_\s*+\-/().]+$/.test(value)?Function(`return (${value.replace(/_/g,'')})`)():null;
  if(/^[\d_\s*+\-/().]+$/.test(text))return arithmetic(text);
  if(!/^[A-Za-z_$][\w$]*$/.test(text))return null;
  const match=src.match(new RegExp(`(?:^|[\\s,(])${text}\\s*=\\s*([\\d_\\s*+\\-/().]+?)\\s*(?:[,;\\n]|//)`));
  return match?arithmetic(match[1]):null;
}

// Bodies of same-file functions, arrow constants and methods named `name`.
function definitions(src,name){
  const found=[];
  const heads=[
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`,'g'),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^()]*\\)|[\\w$]+)\\s*=>\\s*\\{`,'g'),
    new RegExp(`^[ \\t]*(?:async\\s+)?${name}\\s*\\([^()]*\\)\\s*\\{`,'gm'),
  ];
  for(const head of heads)for(const match of src.matchAll(head)){
    const brace=src.indexOf('{',match.index+match[0].length-1);
    if(brace>=0)found.push(src.slice(brace,closing(src,brace)));
  }
  return found;
}
// The callback plus, `depth` levels down, the bodies of same-file functions it calls.
export function expand(src,text,depth=2){
  const seen=new Set(),parts=[text];let frontier=[text];
  for(let level=0;level<depth;level++){
    const next=[];
    for(const part of frontier){
      const names=new Set([...part.matchAll(/(?:^|[^.\w$]|this\.)([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]));
      if(/^[A-Za-z_$][\w$]*$/.test(part.trim()))names.add(part.trim());
      for(const name of names){
        if(KEYWORDS.has(name)||seen.has(name))continue;
        seen.add(name);
        for(const body of definitions(src,name)){parts.push(body);next.push(body);}
      }
    }
    frontier=next;
  }
  return parts.join('\n');
}

// Every periodic timer, poll and file subscription in one source.
export function scanSource(src,file){
  const timers=[],polls=[],subscriptions=[],shared=[],publishers=new Set();
  if(/\bcreateSharedPublisher\s*\(\s*setShared\s*\)/.test(src)&&!/export function createSharedPublisher/.test(src))publishers.add(file);
  for(const match of src.matchAll(/\btimer\.every\s*\(/g)){
    const open=match.index+match[0].length-1,[interval='',callback='']=callArgs(src,open);
    timers.push({file,line:lineAt(src,match.index),interval,ms:resolveMs(src,interval),callback,body:expand(src,callback)});
  }
  for(const match of src.matchAll(/\b(createPoll|subscribeLiveEvents)\s*\(/g)){
    if(/function\s*$/.test(src.slice(Math.max(0,match.index-10),match.index)))continue;
    const open=match.index+match[0].length-1,text=src.slice(open,closing(src,open));
    const key=match[1]==='createPoll'?'every':'intervalMs',value=text.match(new RegExp(`\\b${key}\\s*:\\s*([^,}]+)`))?.[1]?.trim()??null;
    polls.push({file,line:lineAt(src,match.index),kind:match[1],interval:value,ms:value===null?null:resolveMs(src,value),visible:/\bvisible\s*:/.test(text),body:expand(src,text)});
  }
  for(const match of src.matchAll(/\bsubscribeJsonFile\s*\(/g)){
    if(/function\s*$/.test(src.slice(Math.max(0,match.index-10),match.index)))continue;
    const open=match.index+match[0].length-1,args=callArgs(src,open);
    subscriptions.push({file,line:lineAt(src,match.index),callback:args[2]??'',body:expand(src,args[2]??'')});
  }
  for(const match of src.matchAll(/(?<![\w$.])setShared\s*\(/g)){
    const open=match.index+match[0].length-1;
    shared.push({file,line:lineAt(src,match.index),text:src.slice(match.index,closing(src,open))});
  }
  return {timers,polls,subscriptions,shared,publishers};
}

async function jsFiles(dir){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())out.push(...await jsFiles(path));
    else if(/\.m?js$/.test(entry.name))out.push(path);
  }
  return out;
}
export async function scanTree(root){
  const all={timers:[],polls:[],subscriptions:[],shared:[],publishers:new Set()};
  for(const path of (await jsFiles(root)).sort()){
    const found=scanSource(await readFile(path,'utf8'),relative(root,path).split('\\').join('/'));
    for(const key of ['timers','polls','subscriptions','shared'])all[key].push(...found[key]);
    for(const file of found.publishers)all.publishers.add(file);
  }
  return all;
}

// setShared calls in `body` with no same-value check just before them: a publisher call does
// not match (it passes setShared uncalled), and `if (!same(shared(K), v)) setShared(K, v)` or
// `shared(K) !== v` within the preceding statement counts as a check.
export function uncheckedShared(body){
  const out=[];
  for(const match of body.matchAll(/(?<![\w$.])setShared\s*\(/g)){
    const open=match.index+match[0].length-1,[key='']=callArgs(body,open);
    const before=body.slice(Math.max(0,match.index-240),match.index);
    const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(/\bsame\s*\(/.test(before)||new RegExp(`(?<![\\w$.])shared\\(\\s*${escaped}\\s*\\)`).test(before))continue;
    out.push(key);
  }
  return out;
}

// Findings as {rule, file, line, text, body}. An `allow` entry {rule, file, match, reason} excuses
// the findings of that rule and file whose text or expanded callback `match` tests true.
export function findings(scan){
  const out=[];
  const add=(rule,site,text)=>out.push({rule,file:site.file,line:site.line,text,body:site.body??''});
  for(const t of scan.timers){
    const call=`timer.every(${t.interval}, …)`;
    if(t.ms===null||t.ms<MIN_EVERY_MS)add('interval',t,`${call}${t.ms===null?' (interval not a same-file constant)':` = ${t.ms} ms`}`);
    if(WORK.test(t.body)&&!GATE.test(t.body))add('hidden',t,`${call} spawns work without a visibility check`);
    for(const key of uncheckedShared(t.body))add('shared',t,`${call} calls setShared(${key}) without a same-value check`);
    if((t.ms===null||t.ms<MIN_EVERY_MS)&&DEEP_COMPARE.test(t.body))add('compare',t,`${call} compares JSON.stringify values`);
  }
  for(const p of scan.polls){
    if(p.interval===null){if(p.kind==='subscribeLiveEvents')add('interval',p,`${p.kind} without intervalMs (default is sub-second)`);}
    else if(p.ms===null||p.ms<MIN_EVERY_MS)add('interval',p,`${p.kind} interval ${p.interval}${p.ms===null?'':` = ${p.ms} ms`}`);
    if(p.kind==='createPoll'&&!p.visible&&!GATE.test(p.body))add('hidden',p,'createPoll without a visible option');
  }
  for(const s of scan.subscriptions)
    for(const key of uncheckedShared(s.body))add('shared',s,`subscribeJsonFile callback calls setShared(${key}) without a same-value check`);
  // A file that has a publisher must not also write around it.
  for(const s of scan.shared)if(scan.publishers.has(s.file))add('shared',s,`setShared called directly in a file that uses createSharedPublisher`);
  return out;
}

// Problems left once the allowlist is applied, plus entries that no longer excuse anything.
export function unexcused(found,allow){
  const used=new Set();
  const left=found.filter(f=>{
    const index=allow.findIndex(a=>a.rule===f.rule&&a.file===f.file&&a.match.test(`${f.text}\n${f.body}`));
    if(index<0)return true;
    used.add(index);return false;
  });
  const stale=allow.filter((_,index)=>!used.has(index));
  return {left,stale};
}
export function report({left,stale}){
  const lines=left.map(f=>`${f.file}:${f.line} ${f.text}\n    -> ${ADVICE[f.rule]}`);
  for(const a of stale)lines.push(`allowlist entry no longer matches anything, remove it: ${a.rule} ${a.file} ${a.match}`);
  return lines.join('\n');
}
