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

// Source text without its comments, so a comment saying "visible" is not a check.
export function stripComments(src){
  let out='';
  for(let i=0;i<src.length;){
    const next=skip(src,i);
    if(next===i){out+=src[i++];continue;}
    if(src[i]==='/'&&(src[i+1]==='/'||src[i+1]==='*'))out+=' ';else out+=src.slice(i,next);
    i=next;
  }
  return out;
}

const ARITHMETIC=/^[\d_\s*+\-/().]+$/;
const arithmetic=value=>ARITHMETIC.test(value)?Function(`return (${value.replace(/_/g,'')})`)():null;
// UPPER_CASE number constants declared in `src`; `into` collects them across files.
export function constants(src,into=new Map()){
  for(const match of src.matchAll(/(?:^|[\s,(])([A-Z][A-Z0-9_]*)\s*=\s*([\d_\s*+\-/().]+?)\s*(?=[,;\n]|\/\/)/g)){
    const value=arithmetic(match[2]);
    if(value===null)continue;
    into.set(match[1],into.has(match[1])&&into.get(match[1])!==value?null:value);   // two different values: unknown
  }
  return into;
}
// A number, or a constant made of numbers and arithmetic (this file first, then `known`
// from the other scanned files). Anything else is null.
export function resolveMs(src,text,known=new Map()){
  if(ARITHMETIC.test(text))return arithmetic(text);
  if(!/^[A-Za-z_$][\w$]*$/.test(text))return null;
  const match=src.match(new RegExp(`(?:^|[\\s,(])${text}\\s*=\\s*([\\d_\\s*+\\-/().]+?)\\s*(?:[,;\\n]|//)`));
  return match?arithmetic(match[1]):known.get(text)??null;
}
// A delay computed from a time (`Math.max(1, at - Date.now())`) wakes once at a deadline.
const DEADLINE=/Math\.max\(|\bnow\b|Date\.now\(\)/;

const ARROW='\\s*=\\s*(?:async\\s*)?(?:\\([^()]*\\)|[\\w$]+)\\s*=>\\s*\\{';
const heads=name=>[
  new RegExp(`\\bfunction\\s+(${name})\\s*\\(`,'g'),
  new RegExp(`\\b(?:const|let|var)\\s+(${name})${ARROW}`,'g'),
  new RegExp(`\\.(${name})${ARROW}`,'g'),
  new RegExp(`^[ \\t]*(?:async\\s+)?(${name})\\s*\\([^()]*\\)\\s*\\{`,'gm'),
];
// Same-file functions, arrow constants, `x.name = () => {}` and methods: [{name, start, end, body}].
function functions(src,name='[A-Za-z_$][\\w$]*'){
  const found=[];
  for(const head of heads(name))for(const match of src.matchAll(head)){
    if(KEYWORDS.has(match[1]))continue;
    const brace=src.indexOf('{',match.index+match[0].length-1);
    if(brace<0)continue;
    const end=closing(src,brace);
    found.push({name:match[1],start:brace,end,body:src.slice(brace,end)});
  }
  // `const name = () => expression`, up to the end of its statement.
  for(const match of src.matchAll(new RegExp(`(?:\\b(?:const|let|var)\\s+|[,.]\\s*)(${name})\\s*=\\s*(?:async\\s*)?(?:\\([^()]*\\)|[\\w$]+)\\s*=>\\s*(?!\\s|\\{)`,'g'))){
    const start=match.index+match[0].length;let end=start,depth=0;
    while(end<src.length){
      const next=skip(src,end);
      if(next!==end){end=next;continue;}
      const c=src[end];
      if('([{'.includes(c))depth++;else if(')]}'.includes(c)){if(!depth)break;depth--;}
      else if(!depth&&(c===';'||c===','||c==='\n'))break;
      end++;
    }
    found.push({name:match[1],start,end,body:src.slice(start,end)});
  }
  return found;
}
// The callback plus, `depth` levels down, the bodies of same-file functions it calls.
export function expand(src,text,depth=2){
  const seen=new Set(),parts=[text];let frontier=[text];
  for(let level=0;level<depth;level++){
    const next=[];
    for(const part of frontier){
      const names=new Set([...part.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]));
      if(/^[A-Za-z_$][\w$]*$/.test(part.trim()))names.add(part.trim());
      for(const m of part.matchAll(/\btimer\.(?:after|every)\s*\([^,]*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g))names.add(m[1]);   // a callback passed by name
      for(const name of names){
        if(KEYWORDS.has(name)||seen.has(name))continue;
        seen.add(name);
        for(const {body} of functions(src,name)){parts.push(body);next.push(body);}
      }
    }
    frontier=next;
  }
  return parts.join('\n');
}
const head=text=>text.replace(/\s+/g,' ').trim().slice(0,72);

// Every periodic timer, poll and file subscription in one source. A `timer.after` counts as
// periodic when its callback calls the function that scheduled it again.
export function scanSource(raw,file,known=constants(raw)){
  const src=stripComments(raw);
  const timers=[],polls=[],subscriptions=[],shared=[],publishers=new Set();
  if(/\bcreateSharedPublisher\s*\(\s*setShared\s*\)/.test(src)&&!/export function createSharedPublisher/.test(src))publishers.add(file);
  for(const match of src.matchAll(/\btimer\.every\s*\(/g)){
    const open=match.index+match[0].length-1,[interval='',callback='']=callArgs(src,open);
    timers.push({file,line:lineAt(src,match.index),call:'every',interval,ms:resolveMs(src,interval,known),
      site:`timer.every(${interval}, ${head(callback)}`,body:expand(src,callback)});
  }
  const scopes=functions(src);
  for(const match of src.matchAll(/\btimer\.after\s*\(/g)){
    const open=match.index+match[0].length-1,[interval='',callback='']=callArgs(src,open);
    const owner=scopes.filter(f=>f.start<match.index&&match.index<f.end).sort((x,y)=>y.start-x.start)[0];
    if(!owner)continue;
    const body=expand(src,callback);
    if(callback.trim()!==owner.name&&!new RegExp(`\\b${owner.name.replace(/\$/g,'\\$')}\\s*\\(`).test(body))continue;
    timers.push({file,line:lineAt(src,match.index),call:'after',interval,ms:DEADLINE.test(interval)?Infinity:resolveMs(src,interval,known),
      site:`timer.after(${interval}, ${head(callback)}`,body:expand(src,owner.body)});
  }
  for(const match of src.matchAll(/\b(createPoll|subscribeLiveEvents)\s*\(/g)){
    if(/function\s*$/.test(src.slice(Math.max(0,match.index-10),match.index)))continue;
    const open=match.index+match[0].length-1,text=src.slice(open,closing(src,open));
    const key=match[1]==='createPoll'?'every':'intervalMs',value=text.match(new RegExp(`\\b${key}\\s*:\\s*([^,}]+)`))?.[1]?.trim()??null;
    polls.push({file,line:lineAt(src,match.index),kind:match[1],interval:value,ms:value===null?null:resolveMs(src,value,known),
      visible:/\bvisible\s*:/.test(text),site:`${match[1]}${head(text)}`,body:expand(src,text)});
  }
  for(const match of src.matchAll(/\bsubscribeJsonFile\s*\(/g)){
    if(/function\s*$/.test(src.slice(Math.max(0,match.index-10),match.index)))continue;
    const open=match.index+match[0].length-1,args=callArgs(src,open);
    subscriptions.push({file,line:lineAt(src,match.index),site:`subscribeJsonFile(${head(args.join(', '))}`,body:expand(src,args[2]??'')});
  }
  for(const match of src.matchAll(/(?<![\w$.])setShared\s*\(/g)){
    const open=match.index+match[0].length-1,text=src.slice(match.index,closing(src,open));
    shared.push({file,line:lineAt(src,match.index),site:text,text});
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
// Reported paths are `prefix` + the path under `root`.
export async function scanTree(root,prefix=''){
  const all={timers:[],polls:[],subscriptions:[],shared:[],publishers:new Set()};
  const sources=[];
  for(const path of (await jsFiles(root)).sort())sources.push([prefix+relative(root,path).split('\\').join('/'),await readFile(path,'utf8')]);
  const known=new Map();for(const [,src] of sources)constants(src,known);
  for(const [file,src] of sources){
    const found=scanSource(src,file,known);
    for(const key of ['timers','polls','subscriptions','shared'])all[key].push(...found[key]);
    for(const name of found.publishers)all.publishers.add(name);
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

// Findings as {rule, file, line, text, site}. `site` is the call with its callback's first
// words; an `allow` entry {rule, file, match, reason} excuses the findings of that rule and file
// whose site `match` tests true.
export function findings(scan){
  const out=[];
  const add=(rule,site,text)=>out.push({rule,file:site.file,line:site.line,text,site:site.site??''});
  for(const t of scan.timers){
    const call=`timer.${t.call}(${t.interval}, …)${t.call==='after'?' rescheduling itself':''}`;
    if(t.ms===null||t.ms<MIN_EVERY_MS)add('interval',t,`${call}${t.ms===null?' (interval not a number constant)':` = ${t.ms} ms`}`);
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
    const index=allow.findIndex(a=>a.rule===f.rule&&a.file===f.file&&a.match.test(f.site));
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
