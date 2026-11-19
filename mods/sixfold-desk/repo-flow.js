// Generic display only: no Git, credentials, filesystem lookup or transport.
// The producer selects a bounded, ordered catalog and supplies evidence.
export const REPO_LIMITS=Object.freeze({accounts:64,repos:256,bindings:128,events:128,active:8,seen:2048});
export const REPO_TIMING=Object.freeze({start:40,travel:2400,end:2840});
export const GIT_OPERATIONS=Object.freeze(['commit','push','pull','merge','fetch','rebase','reset','checkout','switch','cherry-pick','revert','tag','branch','clone','add','rm','mv','stash','restore','clean','worktree','other']);
export const REPO_RESULTS=Object.freeze(['started','success','failure','unknown']);
const RESULTS={started:'진행',success:'명령 성공',failure:'명령 실패',unknown:'결과 미확인'};
const SOURCE_LABELS={private_catalog:'명시 목록',explicit_probe:'연결 확인',pre_tool:'실행 전 관측',post_tool:'실행 후 관측(결과 미확인)',approval:'승인만 확인',process_exit:'종료코드 관측',head_verified:'로컬 HEAD 확인',timeout:'시간 초과',sensor_error:'관측 오류',unknown:'출처 미확인'};
// Producer values select only an exact own string key: inherited names such as
// __proto__/toString and arrays that coerce to a key never reach a table entry.
const own=(table,value)=>typeof value==='string'&&Object.hasOwn(table,value)?table[value]:null;
export const repositoryResult=value=>own(RESULTS,value)||RESULTS.unknown;
export const repositorySource=value=>own(SOURCE_LABELS,value)||SOURCE_LABELS.unknown;
// Evidence kind -> [required phase, allowed results]. post_tool is a provider
// after-execution observation: it proves the call was seen afterwards, never its
// outcome, so it stays unknown until a separately versioned exit contract exists.
const rule=(phase,results)=>Object.freeze([phase,Object.freeze(results)]);
export const REPO_EVIDENCE=Object.freeze({pre_tool:rule('attempt',['unknown']),post_tool:rule('result',['unknown']),
  approval:rule('authorization',['unknown']),process_exit:rule('result',['succeeded','failed']),
  head_verified:rule('result',['succeeded']),timeout:rule('result',['unknown']),sensor_error:rule('result',['unknown'])});
const EVIDENCE=REPO_EVIDENCE;

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const credential=/gh[pousr]_|github_pat_|(?:^|[ ._-])(?:bearer|token|password|secret)(?:$|[ ._-])/i;
const key=value=>typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value)&&!/[\s\u0000-\u001f\u007f]/.test(value)&&!credential.test(value)?value:null;
const display=value=>typeof value==='string'&&value.length>0&&value.length<=100&&value===value.trim()
  &&!/[\u0000-\u001f\u007f]|:\/\/|[A-Za-z]:[\\/]|(?:^|\s)[~\\/]|(?:token|password|authorization|secret)\s*[:=]/i.test(value)&&!credential.test(value)?value:null;
const limited=(values,limit,clean)=>{
  const seen=new Set();
  return (Array.isArray(values)?values.slice(0,limit):[]).flatMap(value=>{
    const item=object(value)?clean(value):null;
    if(!item||seen.has(item.id))return [];
    seen.add(item.id);return [item];
  });
};
// Explicit field-by-field projection: unknown/private properties never survive
// into retained display data or diagnostics. No inferred account or identity.
export function cleanRepositoryGraph(raw,knownAgents=new Set()){
  if(!object(raw)||raw.schema!=='repo_activity_v1'||!Array.isArray(raw.accounts)||!Array.isArray(raw.repositories))return null;
  const accounts=limited(raw.accounts,REPO_LIMITS.accounts,value=>key(value.id)&&display(value.name)&&['personal','company'].includes(value.kind)&&['private_catalog','explicit_probe'].includes(value.source)?{
    id:value.id,name:value.name,kind:value.kind,
    connection:value.source==='explicit_probe'&&['connected','disconnected'].includes(value.connection)?value.connection:'unknown',
    source:value.source,
  }:null);
  const accountIds=new Set(accounts.map(account=>account.id));
  const slugs=new Set();
  const repos=limited(raw.repositories,REPO_LIMITS.repos,value=>{
    if(!key(value.id)||!display(value.name)||!display(value.namespace)||!accountIds.has(value.account_id)
      ||!(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/).test(value.namespace)||!(/^[A-Za-z0-9_.-]{1,100}$/).test(value.name)||/^\.+$/.test(value.name))return null;
    const slug=`${value.namespace}/${value.name}`.toLowerCase();
    if(slugs.has(slug))return null;slugs.add(slug);
    return {id:value.id,account_id:value.account_id,namespace:value.namespace,name:value.name};
  });
  const repoIds=new Set(repos.map(repo=>repo.id));
  const bindingPairs=new Set();
  const bindings=(Array.isArray(raw.bindings)?raw.bindings.slice(0,REPO_LIMITS.bindings):[]).flatMap(value=>{
    if(!object(value)||!key(value.agent_id)||!knownAgents.has(value.agent_id))return [];
    const repo=repoIds.has(value.repository_id)?value.repository_id:null,pair=JSON.stringify([value.agent_id,repo]);
    if(bindingPairs.has(pair))return [];bindingPairs.add(pair);
    const state=repo&&value.state==='cwd'?'cwd':value.repository_id===null&&['local','unlinked'].includes(value.state)?value.state:'unknown';
    return [{agent_id:value.agent_id,repository_id:state==='cwd'?repo:null,state}];
  });
  const events=limited(raw.events,REPO_LIMITS.events,input=>{
    // Own enumerable fields only, copied onto a null prototype: neither a caller's
    // prototype nor a polluted Object.prototype can supply any event field, and
    // spread defines a JSON "__proto__" key as own data, never as the prototype.
    const value={__proto__:null,...input},evidence=own(EVIDENCE,value.evidence);
    if(!key(value.id)||!key(value.operation_id)||!key(value.machine_id)||!repoIds.has(value.repository_id)
      ||!Number.isSafeInteger(value.observed_at)||value.observed_at<0||value.observed_at>8640000000000||!GIT_OPERATIONS.includes(value.operation)
      ||!evidence||value.phase!==evidence[0]||!evidence[1].includes(value.result)
      ||value.evidence==='head_verified'&&value.operation!=='merge')return null;
    return {id:value.id,operation_id:value.operation_id,machine_id:value.machine_id,
      agent_id:key(value.agent_id)&&knownAgents.has(value.agent_id)?value.agent_id:null,repository_id:value.repository_id,
      operation:value.operation,phase:value.phase,result:value.result,evidence:value.evidence,observed_at:value.observed_at};
  });
  const coverage={state:raw.coverage?.state==='gap'?'gap':'unknown',sensor:raw.coverage?.sensor==='opt_in_callback'?'opt_in_callback':'unknown',
    live_connected:raw.coverage?.live_connected===true,
    gaps:(Array.isArray(raw.coverage?.gaps)?raw.coverage.gaps:[]).filter(value=>['unwrapped_commands','uninstalled_peers','remote_effects'].includes(value)).slice(0,3)};
  return {schema:'repo_activity_v1',accounts,repositories:repos,bindings,events,coverage};
}

export function projectRepositoryGraph(dto){
  if(!dto)return null;
  return {source:'private_catalog',coverage:dto.coverage.state,accounts:dto.accounts,
    repos:dto.repositories.map(repo=>({id:repo.id,account:repo.account_id,name:`${repo.namespace}/${repo.name}`,state:'ready',source:'private_catalog',branch:null})),
    bindings:dto.bindings.map(binding=>({agent:binding.agent_id,repo:binding.repository_id,state:binding.state==='cwd'?'connected':binding.state==='local'?'local_only':binding.state})),
    events:dto.events.map(event=>({id:event.id,agent:event.agent_id,repo:event.repository_id,at:event.observed_at*1000,operation:event.operation,
      phase:event.phase,source:event.evidence,result:event.result==='succeeded'?'success':event.result==='failed'?'failure':'unknown'}))};
}

// The view consumes this sanitized projection, never the raw producer envelope.
export function repositoryLayout(graph,top=0){
  if(!graph)return {height:0,rows:[],anchors:new Map()};
  let y=top+26;
  const rows=[],anchors=new Map();
  for(const account of graph.accounts){
    rows.push({kind:'account',value:account,y,height:24});y+=24;
    for(const repo of graph.repos.filter(repo=>repo.account===account.id)){
      rows.push({kind:'repo',value:repo,y,height:40});anchors.set(repo.id,{y:y+13});y+=40;
    }
  }
  const assigned=new Set(graph.accounts.map(account=>account.id));
  const unassigned=graph.repos.filter(repo=>!assigned.has(repo.account));
  if(unassigned.length){rows.push({kind:'unassigned',y,height:24});y+=24;}
  for(const repo of unassigned){rows.push({kind:'repo',value:repo,y,height:40});anchors.set(repo.id,{y:y+13});y+=40;}
  if(!graph.accounts.length&&!graph.repos.length){rows.push({kind:'empty',y,height:24});y+=24;}
  for(const state of ['local_only','unlinked','unknown']){
    const count=graph.bindings.filter(binding=>binding.state===state).length;
    if(count){rows.push({kind:'binding-state',value:{state,count},y,height:18});y+=18;}
  }
  rows.push({kind:'coverage',y,height:24});y+=24;
  return {height:y-top+6,rows,anchors};
}

// Initial snapshots and hidden/reduced-motion updates advance a watermark.
// Turning motion back on never replays consumed history. No recurring timer.
export function repositoryEventState(graph,now,{previous=null,motion=false}={}){
  const events=graph?.events||[],seen=new Set(previous?.seen||[]);
  const active=motion&&previous?.motion?(previous?.active||[]).filter(event=>now<event.start+REPO_TIMING.end):[];
  const current=new Map(events.map(event=>[event.id,event]));
  // A corrected/removed event must stop its old effect immediately.
  const retained=active.filter(event=>{
    const latest=current.get(event.id);
    return latest&&latest.animate!==false&&latest.result!=='unknown'&&latest.agent===event.agent&&latest.repo===event.repo&&latest.operation===event.operation&&latest.result===event.result&&latest.source===event.source&&latest.phase===event.phase;
  });
  for(const event of events){
    const fresh=!seen.has(event.id);seen.add(event.id);
    if(previous&&previous.motion&&motion&&fresh&&event.animate!==false&&event.result!=='unknown'&&event.agent&&event.repo&&now-event.at>=0&&now-event.at<10000&&retained.length<REPO_LIMITS.active)
      retained.push({...event,start:now});
  }
  let nextAt=null;
  const packets=retained.map(event=>{
    const elapsed=now-event.start;
    const phase=elapsed<REPO_TIMING.start?'start':elapsed<REPO_TIMING.travel?'travel':'arrival';
    const at=event.start+(phase==='start'?REPO_TIMING.start:phase==='travel'?REPO_TIMING.travel:REPO_TIMING.end);
    if(nextAt===null||at<nextAt)nextAt=at;
    return {...event,phase};
  });
  return {seen:[...seen].slice(-REPO_LIMITS.seen),active:retained,packets,nextAt,motion};
}

// Exactly one finite deadline is armed at a time. Visibility is re-read at
// callback time, and disposal/corrections cancel the previous deadline.
export function createRepositoryController({after,notify,visible,motion,clock=Date.now}){
  let graph=null,state=null,wake=null,signature=null,disposed=false;
  const apply=input=>{
    if(disposed)return;
    graph=input;
    if(!graph&&!state)return;
    const shown=visible(),now=clock();
    state=repositoryEventState(graph,now,{previous:state,motion:shown&&motion()});
    const next=JSON.stringify([graph,state.packets]);
    wake?.cancel();wake=null;
    if(shown&&state.nextAt!==null)wake=after(Math.max(1,state.nextAt-now),()=>{wake=null;apply(graph);});
    if(next!==signature){signature=next;if(shown)notify();}
  };
  return {apply,get state(){return state;},dispose(){disposed=true;wake?.cancel();wake=null;}};
}

export function repositoryTone(result,t){
  return result==='failure'?t.blocked:result==='success'?(t.ansi2||t.ansi6||t.accent):result==='started'?(t.ansi4||t.accent):t.muted;
}

// Builders are injected by the host. Keeping this module pure also lets the
// exact production view run in fixtures without a live native application.
export function repositorySection(graph,t,{div,h_flex,v_flex},{gutter=48}={}){
  if(!graph)return null; // An older feed has precisely its old sidebar.
  const label=(value,tone,size=10)=>div().min_w(0).truncate().text_size(size).text_color(tone).child(value);
  const section=v_flex().id('sf-repositories').flex_none().mr(gutter).ml(7).pb(6)
    .accessibility_label('GitHub 계정 및 레포 목록. 연결선은 현재 작업폴더 관계이며 작업 성공 증명이 아닙니다.');
  section.child(h_flex().h(26).gap(5).items_center()
      .child(label('GITHUB',t.dim).font_bold())
    .child(label(repositorySource(graph.source),t.muted,9).flex_1())
    .child(label('폴더 관계',t.muted,9)));
  for(const row of repositoryLayout(graph).rows){
    if(row.kind==='account'){
      const a=row.value,state={connected:'연결됨',disconnected:'미연결',unknown:'미확인'}[a.connection]||'미확인';
      section.child(h_flex().id(`sf-repo-account-${a.id}`).h(24).gap(5).items_center()
        .tooltip(`${a.name} · ${a.kind==='company'?'회사':a.kind==='personal'?'개인':'구분 미확인'} · ${state}\n${repositorySource(a.source)} · namespace는 로그인 사용자나 pusher 증명이 아닙니다.`)
        .child(label(a.connection==='connected'?'●':a.connection==='disconnected'?'○':'?',t.muted,9).flex_none())
        .child(label(a.name,t.foreground,11).flex_1())
        .child(label(a.kind==='company'?'회사':a.kind==='personal'?'개인':'미확인',t.dim,9))
        .child(label(state,t.muted,9)));
    }else if(row.kind==='repo'){
      const r=row.value,bindings=graph.bindings.filter(binding=>binding.repo===r.id);
      const last=[...graph.events].reverse().find(event=>event.repo===r.id);
      const status=last?`${last.operation} · ${last.phase==='authorization'?'승인만':last.phase==='attempt'?'실행 전':last.source==='head_verified'?'로컬 반영':last.source==='post_tool'?'실행 후 · 결과 미확인':repositoryResult(last.result)}`:r.state==='local_only'?'로컬 폴더':r.state==='unknown'?'레포 미확인':'사건 없음';
      const evidence=last?repositorySource(last.source):repositorySource(r.source);
      section.child(v_flex().id(`sf-repo-${r.id}`).h(40).flex_none().pl(9).pr(4).gap(2)
        .tooltip(`${r.name}\n${evidence} · ${bindings.length} 세션의 폴더 관계\n${r.branch?`로컬 ${r.branch} 관측`:'로컬 main 미관측'} · 원격 상태 미확인\n${last?'마지막 관측 결과이며 현재 실행 상태가 아닙니다.\n':''}cwd는 수정 파일·현재 업무·push 대상 증명이 아닙니다. 명령 성공도 원격 반영·CI·배포·서비스 확인과 별개입니다.`)
        .child(h_flex().h(19).gap(4).items_center()
          .child(label('▣',t.muted).flex_none())
          .child(label(r.name,t.foreground,11).id(`sf-repo-name-${r.id}`).flex_1())
          .child(label(bindings.length?`${bindings.length} 연결`:'연결 없음',t.muted,9)))
        .child(h_flex().h(17).gap(4).items_center()
          .child(label(last?.result==='failure'?'!':last?.result==='success'?'✓':last?.result==='started'?'→':'?',last?repositoryTone(last.result,t):t.dim,9))
          .child(label(status,last?repositoryTone(last.result,t):t.muted,9).id(`sf-repo-result-${r.id}`).flex_1())
          .child(label(r.branch||'main ?',t.dim,8))));
    }else if(row.kind==='unassigned')section.child(label('계정 미확인',t.muted).h(24));
    else if(row.kind==='empty')section.child(label('고정 레포 없음',t.muted).h(24));
    else if(row.kind==='binding-state')section.child(label(`${{local_only:'로컬 폴더',unlinked:'목록 미연결',unknown:'폴더 미확인'}[row.value.state]} ${row.value.count}`,t.muted,9).h(18)
      .id(`sf-repo-bindings-${row.value.state}`));
    else if(row.kind==='coverage'){
      const counts={local_only:0,unlinked:0,unknown:0};
      for(const binding of graph.bindings)if(Object.hasOwn(counts,binding.state))counts[binding.state]++;
      section.child(label(graph.coverage==='gap'?'관측 공백 있음':'관측 범위 미확인',t.muted,9).id('sf-repo-coverage').h(24)
        .tooltip(`로컬 폴더 ${counts.local_only} · 목록 미연결 ${counts.unlinked} · 폴더 미확인 ${counts.unknown}\n명시된 관측 범위만 표시합니다. 미관측 Git 작업을 성공으로 추정하지 않습니다.`));
    }
  }
  return section;
}

// Both ends must resolve to visible rows. Static cwd edges are deliberately
// quiet. Only independently evidenced events receive a finite 3px packet.
export function repositoryFlowLayer(graph,layout,state,t,{div},{gutter=48}={}){
  const layer=div().id('sf-repo-flows').absolute().left(0).top(0).w_full().h(layout?.height||0);
  if(!graph||!layout)return layer;
  const route=(key,agent,repo,color,packet=null,lane=8)=>{
    const from=layout.agents.get(agent),to=layout.repos.get(repo);
    if(!from||!to||!Number.isFinite(from.y)||!Number.isFinite(to.y))return;
    const a=from.y,b=to.y,top=Math.min(a,b),height=Math.abs(b-a);
    layer.child(div().id(`sf-repo-line-${key}`).absolute().right(lane).top(top).w(1).h(height).bg(color));
    for(const [end,y] of [['from',a],['to',b]])layer.child(div().id(`sf-repo-line-${key}-${end}`).absolute().right(lane).top(y).w(gutter-lane).h(1).bg(color));
    if(packet)layer.child(div().id(`sf-repo-packet-${packet.id}`).absolute().right(lane-1).top(packet.phase==='start'?a-1:b-1).size(3).bg(color)
      .when(packet.phase!=='arrival',e=>e.transition('top',{duration:REPO_TIMING.travel-REPO_TIMING.start,easing:'linear'})));
  };
  for(const [i,binding] of graph.bindings.entries())if(binding.state==='connected')route(`cwd-${i}`,binding.agent,binding.repo,t.dim,null,8+(i%4)*5);
  for(const [i,event] of (state?.packets||[]).entries())route(event.id,event.agent,event.repo,repositoryTone(event.result,t),event,8+(i%4)*5);
  return layer;
}
