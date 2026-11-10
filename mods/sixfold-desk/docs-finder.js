import {div,svg} from 'gpui-kit';
import {h_flex,v_flex,Popover,InputState,Input,v_virtual_list,VirtualListScrollHandle} from 'gpui-base';
import {appHome,exec,window,readTextFile,writeTextFile} from 'herdr';
import {DOC_TABS,DOC_KINDS,DOC_PERIODS,DOC_SORTS,prepareDocs,docsView,docReadable,nextSort,moveSelection,
  recordOpened,openedFromJson,openedToJson,kstClock,kstDate} from './docs-finder-model.js';

// A space's document finder: the issue search's popover shape, opened from the docs
// button on the space header (or the find-docs command). It reads the shared document
// index (watchDocs) and keeps only its own UI state and the opened-documents record.

const ROW=40,LIST_MAX=400;
const windows=()=>(typeof window==='function'&&window()?.platform==='windows')||/^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome());
const native=()=>`${appHome()}/scripts/sixfold/herdr-theme${windows()?'.exe':''}`;
const openedPath=()=>`${appHome()}/data/sixfold/docs-opened.json`;
const text=(value,color,size=11)=>div().min_w(0).truncate().text_size(size).text_color(color).child(value);

export const docsGroup=(view,space)=>view.projectDocs?.spaces?.[space?.id]||view.projectDocs?.spaces?.[space?.name]||null;

// The record of opened documents, shared by every space's finder on this view.
function loadOpened(view,cx){
  if(view.docsOpenedLoad)return;
  view.docsOpened??=new Map();view.docsOpenedRev??=0;
  view.docsOpenedLoad=Promise.resolve().then(()=>readTextFile(openedPath())).then(raw=>{
    if(!raw)return;
    let parsed=null;try{parsed=JSON.parse(raw);}catch{return;}
    const saved=openedFromJson(parsed);
    // Opens made before the file arrived win over the saved times.
    for(const [path,at] of view.docsOpened)if(!saved.has(path)||saved.get(path)<at)saved.set(path,at);
    view.docsOpened=openedFromJson({version:1,opened:Object.fromEntries(saved)});view.docsOpenedRev++;
    view.docsFinderNotify?.(cx);
  }).catch(()=>{});
}
async function saveOpened(path,at){
  // Compare-and-swap with one retry: another window may have written in between.
  for(let attempt=0;attempt<2;attempt++){
    const old=await readTextFile(openedPath()).catch(()=>null);
    let parsed=null;try{parsed=old?JSON.parse(old):null;}catch{parsed=null;}
    const next=openedToJson(recordOpened(openedFromJson(parsed),path,at));
    try{await writeTextFile(openedPath(),next,old);return true;}catch{}
  }
  return false;
}

// Native retained state (input, scroll handle) is created only from events, never in render.
export function docsFinderState(view,space){
  view.docsFinders??=new Map();
  let state=view.docsFinders.get(space.id);
  if(state)return state;
  const input=InputState.new({placeholder:'이름·폴더 검색'});
  state={open:false,tab:'all',kind:'all',period:'all',archive:false,sort:'modified',folder:null,selected:0,rev:0,
    input,query:'',scroll:VirtualListScrollHandle.new(),memo:null,error:null,busy:false};
  input.on('change',(_event,cx)=>{state.query=input.value();state.selected=0;state.error=null;touch(view,state,cx);state.scroll.scroll_to_item(0);});
  input.on('submit',(_event,cx)=>openSelected(view,space,state,cx));
  view.docsFinders.set(space.id,state);
  return state;
}
function touch(view,state,cx){state.rev++;view.docsFinderNotify?.(cx);}
export function docsFinderSignature(view,id){
  const state=view.docsFinders?.get(id);
  return state?[state.open,state.rev,state.open?view.docsOpenedRev||0:0]:null;
}
export function setDocsFinderOpen(view,space,open,cx){
  const state=docsFinderState(view,space);
  if(open){
    // One finder at a time.
    for(const [id,other] of view.docsFinders)if(id!==space.id&&other.open){other.open=false;other.rev++;}
    loadOpened(view,cx);
    state.error=null;
  }
  if(state.open===open)return state;
  state.open=open;
  touch(view,state,cx);
  if(open)cx?.timer?.after?.(30,()=>state.input.focus());
  return state;
}

function result(view,group,state){
  const opened=view.docsOpened||new Map();
  const now=Date.now(),day=Math.floor(now/60000);
  const memo=state.memo;
  const same=memo&&memo.group===group&&memo.query===state.query&&memo.tab===state.tab&&memo.kind===state.kind&&memo.period===state.period
    &&memo.archive===state.archive&&memo.sort===state.sort&&memo.folder===state.folder&&memo.openedRev===(view.docsOpenedRev||0)&&memo.minute===day;
  if(same)return memo.view;
  const items=prepareDocs(group);
  const data=docsView(items,{query:state.query,tab:state.tab==='folders'?'all':state.tab,kind:state.kind,period:state.period,
    archive:state.archive,sort:state.sort,folder:state.folder,opened,now});
  state.memo={group,query:state.query,tab:state.tab,kind:state.kind,period:state.period,archive:state.archive,sort:state.sort,
    folder:state.folder,openedRev:view.docsOpenedRev||0,minute:day,view:data};
  return data;
}

export function openDoc(view,space,state,item,cx){
  if(!item||state.busy)return;
  const tab=docReadable(item.path);
  state.busy=true;state.error=null;touch(view,state,cx);
  cx.spawn(async cx=>{
    let failed=false;
    try{
      const r=await (tab?exec(native(),['open_doc_tab',item.path,'--space',space.id]):exec(native(),['desktop','open',item.path]));
      if(r?.code!==0)failed=true;
    }catch{failed=true;}
    state.busy=false;
    if(failed){state.error=tab?'문서 탭에서 열지 못했습니다.':'기본 앱에서 열지 못했습니다.';touch(view,state,cx);return;}
    const at=Date.now();
    view.docsOpened=recordOpened(view.docsOpened||new Map(),item.path,at);view.docsOpenedRev=(view.docsOpenedRev||0)+1;
    state.open=false;touch(view,state,cx);
    saveOpened(item.path,at).catch(()=>false);
  });
}
function openSelected(view,space,state,cx){
  const group=docsGroup(view,space);if(!group||state.tab==='folders')return;
  const rows=result(view,group,state).rows;
  openDoc(view,space,state,rows[state.selected]||rows[0],cx);
}
export function revealDoc(state,item,cx,view){
  if(!item)return;
  cx.spawn(async cx=>{
    let failed=false;
    try{const r=await (windows()?exec('explorer.exe',[`/select,${item.path}`]):exec('open',['-R',item.path]));if(r?.code!==0&&!windows())failed=true;}
    catch{failed=true;}
    if(failed){state.error='폴더를 열지 못했습니다.';touch(view,state,cx);}
  });
}

const chip=(id,label,count,active,t,onClick)=>h_flex().id(id).h(22).px(8).gap(4).rounded(11).items_center().cursor_pointer().flex_none()
  .border(1).border_color(active?t.accent:t.border).bg(active?t.selected:t.popover||t.surface)
  .on_click(onClick).child(text(label,active?t.foreground:t.muted,10))
  .when(count!==null&&count!==undefined,el=>el.child(text(String(count),t.dim,9)));

// The popover around `trigger`. `notify(cx)` repaints the card that holds it.
export function docsFinder(view,space,trigger,t,options={}){
  view.docsFinderNotify??=options.notify;
  const state=view.docsFinders?.get(space.id)||null;
  const open=state?.open===true;
  const popover=Popover.new(`sf-docs-finder-${space.id}`).anchor('left_center').open(open)
    .on_open_change((value,cx)=>setDocsFinderOpen(view,space,value,cx)).trigger(trigger);
  if(!open)return popover;
  const group=docsGroup(view,space);
  const set=patch=>(_event,cx)=>{cx.stop_propagation();Object.assign(state,patch,{selected:0,error:null});touch(view,state,cx);state.scroll.scroll_to_item(0);};
  const data=group?result(view,group,state):null;
  const rows=data?.rows||[];
  if(state.selected>=rows.length)state.selected=rows.length?rows.length-1:0;
  const selected=rows[state.selected]||null;
  const body=v_flex().id(`sf-docs-finder-body-${space.id}`).relative().w(440).ml(options.leadingGap||0).max_h(700).gap(8).p(12)
    .rounded(10).border(1).border_color(t.border).bg(t.popover||t.surface).text_color(t.foreground)
    .on_key_down((event,cx)=>{
      const key=event.key;
      if(key==='escape'){cx.stop_propagation();setDocsFinderOpen(view,space,false,cx);return;}
      if((key!=='down'&&key!=='up')||state.tab==='folders')return;
      cx.stop_propagation();
      state.selected=moveSelection(state.selected,key==='down'?1:-1,rows.length);
      if(state.selected>=0)state.scroll.scroll_to_item(state.selected);
      touch(view,state,cx);
    });
  body.child(svg('mods/sixfold-desk/icons/popover-tail.svg').absolute().left(-9).top(22).size(10).text_color(t.popover||t.surface));
  const indexed=group?.files?.length??0;
  const updated=group?.files?.reduce((max,file)=>Math.max(max,Number.isFinite(file.mtime)?file.mtime:0),0)||0;
  body.child(h_flex().gap(8).items_center()
    .child(h_flex().size(24).flex_none().rounded(6).items_center().justify_center().bg(t.selected)
      .child(svg('mods/sixfold-desk/icons/doc.svg').size(14).text_color(t.accent)))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(text(space.name,t.foreground,13).font_bold())
      .child(text(group?`문서 ${indexed}건${updated?` · 최근 수정 ${kstDate(updated)} ${kstClock(updated)}`:''}${view.docsIndexAt?` · 갱신 ${kstClock(view.docsIndexAt)}`:''}`:'문서 폴더 없음',t.dim,10)))
    .child(div().id(`sf-docs-finder-close-${space.id}`).size(28).rounded(6).flex().items_center().justify_center().text_size(14).text_color(t.muted)
      .cursor_pointer().tooltip('닫기 (Esc)').on_click((_event,cx)=>{cx.stop_propagation();setDocsFinderOpen(view,space,false,cx);}).child('✕')));
  if(!group){
    body.child(text('이 공간에 설정된 문서 폴더가 없습니다. 문서 탭 규칙(project-docs-pins.json)에 폴더를 더하면 여기에 나옵니다.',t.dim,11).whitespace_normal().py(8));
    return popover.content(body);
  }
  body.child(Input.new(state.input).w_full().h(30).text_size(12).text_color(t.foreground));
  body.child(h_flex().gap(4).pb(6).border_b(1).border_color(t.border)
    .children(DOC_TABS.map(item=>h_flex().id(`sf-docs-tab-${space.id}-${item.id}`).h(28).px(12).gap(4).rounded(6).items_center().cursor_pointer()
      .bg(state.tab===item.id?t.selected:t.popover||t.surface)
      .on_click(set({tab:item.id}))
      .child(text(item.label,state.tab===item.id?t.foreground:t.muted,12))
      .child(text(String(data.tabs[item.id]),t.dim,10)))));
  const kinds=DOC_KINDS.filter(item=>item.id==='all'||data.kinds[item.id]>0||state.kind===item.id);
  body.child(h_flex().id(`sf-docs-chips-${space.id}`).flex_wrap().gap(4)
    .children(kinds.map(item=>chip(`sf-docs-kind-${space.id}-${item.id}`,item.label,data.kinds[item.id],state.kind===item.id,t,set({kind:item.id}))))
    .child(div().w(1).h(14).bg(t.border).flex_none())
    .children(DOC_PERIODS.map(item=>chip(`sf-docs-period-${space.id}-${item.id}`,item.label,item.id==='all'?null:data.periods[item.id],state.period===item.id,t,set({period:item.id})))));
  const sortLabel=DOC_SORTS.find(item=>item.id===state.sort)?.label||'최근 수정';
  const folderName=state.folder?(data.folders.find(item=>item.key===state.folder)?.label||state.folder.split(/[\\/]/).filter(Boolean).at(-1)):null;
  body.child(h_flex().gap(4).items_center().flex_wrap()
    .child(chip(`sf-docs-sort-${space.id}`,`정렬: ${data.searching&&state.sort==='modified'?'일치도':sortLabel}`,null,false,t,set({sort:nextSort(state.sort)})).tooltip('누를 때마다 최근 수정 → 이름 → 최근 연'))
    .child(chip(`sf-docs-archive-${space.id}`,state.archive?'아카이브 포함':'아카이브 제외',state.archive?null:data.archivedHidden||null,state.archive,t,set({archive:!state.archive})))
    .when(Boolean(folderName),el=>el.child(chip(`sf-docs-folder-clear-${space.id}`,`폴더: ${folderName} ✕`,null,true,t,set({folder:null})).max_w(220).tooltip(state.folder))));
  if(state.tab==='folders'){
    const list=v_flex().id(`sf-docs-folders-${space.id}`).min_h(42).max_h(LIST_MAX).overflow_y_scroll().gap(2);
    list.children(data.folders.map((folder,i)=>h_flex().id(`sf-docs-folder-${space.id}-${i}`).h(32).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(folder.key===state.folder,el=>el.bg(t.selected)).hover(el=>el.bg(t.hover||t.selected)).tooltip(folder.key)
      .on_click(set({folder:folder.key,tab:'all'}))
      .child(text('▸',t.dim,10).flex_none())
      .child(text(folder.label,t.foreground,12).flex_1())
      .child(text(`${folder.count}건 · ${kstDate(folder.newest)}`,t.dim,10).flex_none())));
    if(!data.folders.length)list.child(text('조건에 맞는 폴더가 없습니다',t.dim,11).py(12));
    body.child(list);
  }else if(rows.length){
    const height=Math.min(LIST_MAX,rows.length*ROW);
    body.child(v_flex().relative().h(height).flex_none().child(v_virtual_list(`sf-docs-list-${space.id}`,rows.length,ROW,i=>rows[i].key,range=>{
      const out=[];
      for(let i=range.start;i<range.end&&i<rows.length;i++){
        const item=rows[i],active=i===state.selected;
        out.push(v_flex().h(ROW).px(8).py(4).gap(2).rounded(6).justify_center().when(active,el=>el.bg(t.selected))
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(text(item.kind==='other'?(/\.([A-Za-z0-9]+)$/.exec(item.name)?.[1]||'파일'):item.kind,t.dim,9).flex_none().w(28))
            .child(text(item.name,active?t.foreground:t.muted,12).flex_1()))
          .child(text(`${item.folderLabel} · ${kstDate(item.mtime)}`,t.dim,10).pl(34)));
      }
      return out;
    }).h(height).track_scroll(state.scroll).on_item_click((key,cx)=>{
      const index=rows.findIndex(row=>row.key===key);if(index<0)return;
      state.selected=index;openDoc(view,space,state,rows[index],cx);
    })));
  }else{
    const why=data.searching?'검색과 맞는 문서가 없습니다':state.tab==='opened'?'아직 여기서 연 문서가 없습니다':'조건에 맞는 문서가 없습니다';
    body.child(text(why+(data.archivedHidden&&!state.archive?` · 아카이브 ${data.archivedHidden}건 제외됨`:''),t.dim,11).py(12));
  }
  if(group.warning)body.child(text('문서 폴더 조회 확인 필요',t.blocked,10).tooltip(group.warning));
  if(state.error)body.child(text(state.error,t.blocked,10));
  body.child(h_flex().pt(8).gap(8).border_t(1).border_color(t.border).items_center()
    .child(text(state.tab==='folders'?`폴더 ${data.folders.length}개 · 누르면 그 폴더만 봅니다`:selected?selected.path:`${rows.length}건`,t.dim,10).flex_1().tooltip(selected?.path||''))
    .child(text(state.busy?'여는 중':'↑↓ · Enter · Esc',t.dim,9).flex_none())
    .when(Boolean(selected)&&state.tab!=='folders',el=>el.child(div().id(`sf-docs-reveal-${space.id}`).h(22).px(8).flex_none().rounded(11).border(1).border_color(t.border)
      .flex().items_center().text_size(10).text_color(t.accent).cursor_pointer().tooltip('이 문서가 있는 폴더를 Finder에서 엽니다')
      .on_click((_event,cx)=>{cx.stop_propagation();revealDoc(state,selected,cx,view);}).child('폴더 열기 ↗'))));
  return popover.content(body);
}
