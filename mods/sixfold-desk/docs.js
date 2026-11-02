import {div} from 'gpui-kit';
import {h_flex,v_flex} from 'gpui-base';
import {appHome,readTextFile,spaces,exec} from 'herdr';

export function currentDocs(index){const space=spaces().find(s=>s.active);return index?.spaces?.[space?.id]||index?.spaces?.[space?.name]||null;}
export function watchDocs(view,cx){
  let busy=false,previous;
  const refresh=cx=>{
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
export function docsSection(view,t){
  const group=currentDocs(view.projectDocs);
  if(!group)return div();
  const open=(file,cx)=>{
    const target=spaces().find(s=>s.active)?.id;
    const current=()=>spaces().find(s=>s.active)?.id===target&&currentDocs(view.projectDocs)===group;
    if(!current())return;
    cx.spawn(async cx=>{
      let error=null;
      try{
        const result=await exec('code',['--reuse-window',group.folder,...(file?[file]:[])]);
        if(result.code!==0)throw new Error('code failed');
      }catch{error='VS Code에서 문서 또는 폴더를 열지 못했습니다.';}
      if(!current())return;
      view.projectDocsError=error;
      view.projectDocsErrorSpace=target;
      cx.notify();
    });
  };
  return v_flex().id('sf-project-docs').flex_none().px(10).py(8).gap(4).border_t(1).border_color(t.border)
    .child(h_flex().gap(4).items_center()
      .child(div().flex_1().font_semibold().text_size(11).text_color(t.muted).child('최신 문서'))
      .child(div().id('sf-docs-folder').text_size(10).text_color(t.accent).on_click((_e,cx)=>open(null,cx)).child('폴더 열기')))
    .children(group.files.slice(0,5).map((file,i)=>h_flex().gap(3).items_center()
      .child(v_flex().id(`sf-doc-${i}`).flex_1().min_w(0).gap(2).px(4).py(3).rounded(3).hover(el=>el.bg(t.hover)).tooltip(file.path)
        .on_click((_e,cx)=>open(file.path,cx))
        .child(div().truncate().text_size(10).text_color(t.foreground).child(file.name))
        .child(div().text_size(9).text_color(t.dim).child(new Date(file.mtime).toLocaleString())))
      .child(div().id(`sf-doc-code-${i}`).text_size(9).text_color(t.dim).tooltip('VS Code에서 열기')
        .on_click((_e,cx)=>open(file.path,cx)).child('↗'))))
    .when(Boolean(group.warning),el=>el.child(div().text_size(10).text_color(t.blocked).tooltip(group.warning).child('문서 폴더 연결·조회 확인 필요')))
    .when(group.files.length===0,el=>el.child(div().text_size(10).text_color(t.dim).child('설정된 폴더에 문서가 없습니다.')))
    .when(Boolean(view.projectDocsError)&&view.projectDocsErrorSpace===spaces().find(s=>s.active)?.id,el=>el.child(div().text_size(10).text_color(t.blocked).child(view.projectDocsError)));
}
