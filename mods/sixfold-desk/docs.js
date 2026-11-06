import {div} from 'gpui-kit';
import {h_flex,v_flex,InputState,Input} from 'gpui-base';
import {appHome,readTextFile,spaces,exec,window} from 'herdr';

const readable=path=>/\.(md|html?)$/i.test(path);
const archived=file=>file.archived===true||/archive|아카이브|보관|\.before-/i.test(file.path.normalize('NFC'));
const foldersFor=files=>{const groups=new Map();for(const f of files){const key=f.folder;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(f);}return [...groups].map(([name,files])=>({name,files:files.sort((a,b)=>b.mtime-a.mtime)})).sort((a,b)=>b.files[0].mtime-a.files[0].mtime);};
export function currentDocs(index){const space=spaces().find(s=>s.active);return index?.spaces?.[space?.id]||index?.spaces?.[space?.name]||null;}
const COLLECT_MS=30000;
const native = () => `${appHome()}/scripts/sixfold/herdr-theme${(typeof window==='function' && window()?.platform==='windows') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome())?'.exe':''}`;
export function watchDocs(view,cx){
  let busy=false,previous,collected=0;
  const refresh=cx=>{
    // New and moved documents reach the index without anyone running the collector by hand.
    if(Date.now()-collected>=COLLECT_MS){collected=Date.now();exec(native(),['collect_docs']).catch(()=>{});}
    if(busy)return;busy=true;
    cx.spawn(async cx=>{
      try{
        const text=await readTextFile(`${appHome()}/data/sixfold/project-docs-index.json`);
        if(text===previous)return;
        const data=text?JSON.parse(text):{version:1,spaces:{}};
        if(data.version!==1||!data.spaces||typeof data.spaces!=='object')return;
        for(const item of Object.values(data.spaces))if(!Array.isArray(item.files)||typeof item.folder!=='string'||item.files.some(f=>typeof f.path!=='string'||typeof f.name!=='string'||!Number.isFinite(f.mtime)))return;
        view.projectDocs=data;previous=text;cx.notify();
      }catch{/* Retain the previous snapshot through partial writes. */}
      finally{busy=false;}
    });
  };
  refresh(cx);cx.timer.every(2000,refresh);
}
// Native retained input state must be created by init/event/command callbacks,
// never while GPUI is rendering the document section.
export function prepareDocsInput(view,space){
  view.docsSubmit??={};view.docsInputs??={};view.docsQueries??={};view.docsExpanded??=new Set();view.docsLimits??={};view.docsErrors??={};
  if(!view.docsInputs[space.id]){
    const input=InputState.new({placeholder:'파일명 검색'});
    input.on('change',(_e,cx)=>{view.docsQueries[space.id]=input.value();cx.notify();});
    input.on('submit',(_e,cx)=>view.docsSubmit[space.id]?.(cx));
    view.docsInputs[space.id]=input;
  }
}
export function docsSection(view,t,space=spaces().find(s=>s.active)){
  const group=view.projectDocs?.spaces?.[space?.id]||view.projectDocs?.spaces?.[space?.name];
  if(!view.docsSpaces?.has(space.id))return div();
  if(!group)return div().px(5).py(5).text_size(10).text_color(t.dim).child('설정된 문서 폴더가 없습니다.');
  if(!view.docsInputs?.[space.id])return div();
  const filtered=()=>group.files.filter(f=>(view.docsArchive||!archived(f))&&f.name.normalize('NFC').toLocaleLowerCase().includes((view.docsQueries[space.id]||'').normalize('NFC').toLocaleLowerCase()));
  const open=(file,cx,code=false)=>{
    if(!file)return;
    // Markdown and HTML open in this space's 문서 tab; other files and ↗ use external apps.
    const tab=!code&&readable(file.path);
    cx.spawn(async cx=>{
      let error=null;
      try{const r=await (tab?exec(native(),['open_doc_tab',file.path,'--space',space.id]):exec(native(),['desktop',code?'editor':'open',file.path]));if(r.code!==0)throw Error();}
      catch{error=tab?'문서 탭에서 열지 못했습니다. ↗로 재시도하세요.':code?'VS Code에서 열지 못했습니다.':'기본 앱에서 열지 못했습니다. ↗로 재시도하세요.';}
      view.docsErrors[space.id]=error;cx.notify();
    });
  };
  view.docsSubmit[space.id]=cx=>open(filtered()[0],cx);
  const files=filtered();
  return v_flex().id(`sf-project-docs-${space.id}`).flex_none().min_w(0).px(5).py(5).gap(4).border_t(1).border_color(t.border)
    .child(Input.new(view.docsInputs[space.id]).w_full().h(28).text_size(11).text_color(t.foreground))
    .child(div().id(`sf-docs-archive-${space.id}`).text_size(10).text_color(t.dim).on_click((_e,cx)=>{view.docsArchive=!view.docsArchive;cx.notify();}).child(view.docsArchive?'아카이브 포함 ✓':'아카이브 제외'))
    .children(foldersFor(files.map(f=>({...f,folder:f.folder||f.path.slice(0,f.path.lastIndexOf('/'))}))).map((folder,fi)=>{
      const key=`${space.id}:${folder.name}`;
      const label=folder.name.split('/').filter(Boolean).slice(-2).join('/');
      const expanded=Boolean(view.docsQueries[space.id])||view.docsExpanded.has(key);
      return v_flex().min_w(0).gap(3)
        .child(div().id(`sf-docs-folder-${space.id}-${fi}`).truncate().text_size(10).text_color(t.muted).tooltip(folder.name)
          .on_click((_e,cx)=>{view.docsExpanded.has(key)?view.docsExpanded.delete(key):view.docsExpanded.add(key);cx.notify();})
          .child(`${expanded?'▾':'▸'} ${label} (${folder.files.length})`))
        .when(expanded,el=>el.children(folder.files.slice(0,view.docsLimits[key]||20).map((file,i)=>h_flex().min_w(0).gap(3).items_center()
          .child(v_flex().id(`sf-doc-${space.id}-${fi}-${i}`).flex_1().min_w(0).gap(2).px(3).py(3).rounded(3).hover(el=>el.bg(t.hover)).tooltip(file.path)
            .on_click((_e,cx)=>open(file,cx)).child(div().truncate().text_size(10).text_color(t.foreground).child(file.name))
            .child(div().text_size(9).text_color(t.dim).child(new Date(file.mtime).toLocaleDateString())))
          .child(div().id(`sf-doc-code-${space.id}-${fi}-${i}`).text_size(10).text_color(t.dim).tooltip('VS Code에서 열기').on_click((_e,cx)=>open(file,cx,true)).child('↗'))))
          .when(folder.files.length>(view.docsLimits[key]||20),el=>el.child(div().id(`sf-docs-more-${space.id}-${fi}`).text_size(10).text_color(t.accent).on_click((_e,cx)=>{view.docsLimits[key]=(view.docsLimits[key]||20)+20;cx.notify();}).child('더 보기'))));
    }))
    .when(Boolean(group.warning),el=>el.child(div().text_size(10).text_color(t.blocked).tooltip(group.warning).child('문서 폴더 조회 확인 필요')))
    .when(files.length===0,el=>el.child(div().text_size(10).text_color(t.dim).child('문서가 없습니다.')))
    .when(Boolean(view.docsErrors[space.id]),el=>el.child(div().text_size(10).text_color(t.blocked).child(view.docsErrors[space.id])));
}
