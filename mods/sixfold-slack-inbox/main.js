import { View, div, image } from 'gpui-kit';
import { h_flex, v_flex, Popover } from 'gpui-base';
import { theme, props, appHome, home, readTextFile, writeTextFile, shared, setShared, openOverlay, closeOverlay, exec } from 'herdr';
import { readable, threadGroups, freshness, collectLine, feedNames, namesFor, alertTitle, attachments, fileTextPath, fileTextShown, fileRequestText, FILE_REQUESTS, FILE_LATE, nextFileWait } from './model.js';

export default class MentionInbox extends View {
  init(_props,cx) {
    this.items=[];this.feed={};this.fileOpen=null;this.fileTexts=new Map();this.site={};this.project=null;this.onlyUnread=!props()?.review;this.expanded=new Set();this.error='';
    if(props()?.overlay && !props()?.window && !props()?.newMessages){
      openOverlay({mod:'sixfold-slack-inbox',kind:'window',key:'slack-mentions',keep:true,width:1040,height:800,props:{window:true}});
      closeOverlay(props().overlay);
    }
    let busy=false,previous;
    const refresh=cx=>{
      if(busy)return;
      busy=true;
      cx.spawn(async cx=>{
        try{
          const file=props()?.newMessages?'project-alerts.json':'slack-mentions.json';
          const text=await readTextFile(`${appHome()}/data/sixfold/${file}`);
          const readText=await readTextFile(`${appHome()}/data/sixfold/slack-alerts-read.json`).catch(()=>'{}');
          const siteText=await readTextFile(`${appHome()}/data/sixfold/site.local.json`).catch(()=>null) || '{}';
          const snapshot=JSON.stringify([text,readText,siteText]);
          try{const site=JSON.parse(siteText);if(site && typeof site==='object' && !Array.isArray(site))this.site=site;}catch{/* Keep the last local names. */}
          if(snapshot===previous)return;
          const data=JSON.parse(text);const read=JSON.parse(readText || '{}');
          this.feed=feedNames(data.items ?? []);
          this.items=(data.items ?? []).filter(i=>!props()?.project || i.project.toLowerCase()===props().project.toLowerCase());
          this.scope=data.scope;setShared('sixfold.alertRead',read);
          previous=snapshot;cx.notify();
        }catch{/* Preserve the last valid snapshot through collector writes. */}
        finally{busy=false;}
      });
    };
    refresh(cx);cx.timer.every(2000,refresh);
  }
  async mark(group) {
    const path=`${appHome()}/data/sixfold/slack-alerts-read.json`;
    // Re-read immediately so a second window's acknowledgements are retained.
    const old=await readTextFile(path).catch(()=>null);const read=old?JSON.parse(old):{};
    for(const item of group.items)read[item.id]=item.id;
    await writeTextFile(path,JSON.stringify(read),old);setShared('sixfold.alertRead',read);
  }
  // 본문 보기: the collector's local text copy of the file, read when its popover opens. With no copy
  // yet the collector is asked for it (slack-file-requests.json) and the copy is looked for again on the
  // FILE_WAIT schedule while the popover stays open; past the collector's retry window it says so.
  viewFile(key,file,cx){
    this.fileOpen=key;cx.notify();
    if(!key)return;
    const load=async cx=>{
      const path=fileTextPath(appHome(),file.id),text=path?await readTextFile(path).catch(()=>null):null;
      const ready=typeof text==='string' && text.trim();
      this.fileTexts.set(file.id,ready?fileTextShown(text):null);cx.notify();
      return Boolean(ready);
    };
    const ask=async()=>{
      const path=`${appHome()}/data/sixfold/${FILE_REQUESTS}`,old=await readTextFile(path).catch(()=>null);
      const next=fileRequestText(old,file.id);
      if(next!==null)await writeTextFile(path,next,old);
    };
    let elapsed=0;this.fileLate?.delete(file.id);
    const later=c=>{const ms=nextFileWait(elapsed);
      if(ms===null){(this.fileLate??=new Set()).add(file.id);c.notify?.();return;}
      elapsed+=ms;c.timer.after(ms,look);};
    const look=next=>{const c=next||cx;if(this.fileOpen!==key)return;
      c.spawn(async c2=>{try{await ask();}catch{/* asked already */}if(this.fileOpen===key && !(await load(c2||c)))later(c);});};
    cx.spawn(async c2=>{if(await load(c2||cx))return;try{await ask();}catch{/* the next look asks again */}if(cx.timer?.after)later(cx);});
  }
  // Attachment chips under a message: kind, name, size; 본문 보기 opens a popover with the text,
  // 다운로드 hands the Slack link to the default browser. Both only on a press.
  files(item,id,t){
    const list=attachments(item);
    if(!list.length)return null;
    const small=(key,label)=>div().id(key).flex_none().px(8).py(3).rounded(4).text_size(11).font_semibold().bg(t.chrome).text_color(t.accent).hover(s=>s.bg(t.hover)).cursor_pointer().child(label);
    return v_flex().id(`${id}-files`).gap(5).children(list.map((file,i)=>{
      const key=`${item.id}|${file.id}`,open=this.fileOpen===key,text=this.fileTexts.get(file.id);
      const tone={PDF:t.blocked,이미지:t.ansi5,동영상:t.ansi5,표:t.ansi2,슬라이드:t.ansi3,문서:t.ansi4,압축:t.dim,코드:t.ansi6}[file.kind] || t.muted;
      const view=Popover.new(`${id}-file-pop-${i}`).anchor('top_left').open(open)
        .on_open_change((value,cx)=>this.viewFile(value?key:null,file,cx))
        .trigger(small(`${id}-file-view-${i}`,open?'본문 닫기':'본문 보기'));
      return h_flex().id(`${id}-file-${i}`).h(32).px(8).gap(8).items_center().rounded(6).border(1).border_color(open?t.accent:t.border).bg(t.chrome)
        .child(div().flex_none().w(36).h(20).rounded(4).bg(tone).text_color(t.accent_foreground || t.background).text_size(10).font_bold().flex().items_center().justify_center().child(file.ext))
        .child(div().id(`${id}-file-name-${i}`).min_w(0).flex_1().truncate().text_size(13).tooltip(file.name).child(file.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child([file.kind,file.size].filter(Boolean).join(' · ')))
        .child(open?view.content(v_flex().id(`${id}-file-text-${i}`).w(560).max_h(420).overflow_y_scroll().p(12).gap(6).rounded(8)
          .border(1).border_color(t.border).bg(t.popover || t.surface).text_color(t.foreground)
          .child(div().min_w(0).truncate().text_size(12).font_bold().child(`${file.name} · 본문`))
          .child(div().text_size(13).text_color(text?t.foreground:t.muted).child(this.fileTexts.has(file.id)?(text || (this.fileLate?.has(file.id)?FILE_LATE:'본문 준비 중')):'본문 읽는 중'))):view)
        .when(Boolean(file.link),e=>e.child(small(`${id}-file-download-${i}`,'다운로드').on_click((_e,cx)=>cx.open_url(file.link))));
    }));
  }
  render(){
    const t=theme(),read=shared('sixfold.alertRead') ?? {};
    const groups=threadGroups(this.items,read),unread=groups.filter(g=>g.unread>0).length;
    const health=shared('sixfold.slackHealth') ?? {},workflows=shared('sixfold.slackWorkflows') ?? {};
    const stateLabels={queued:'처리 대기',dispatching:'세션 전달 중',working:'수정안 준비 중',ready:'검토 준비 완료',needs_decision:'사용자 결정 필요',blocked:'처리 막힘',delivery_unknown:'전달 확인 필요'};
    const projects=[...new Set(groups.map(g=>g.project))];
    // Project colours, the Slack workspace and the reports folder are machine-local (site.local.json).
    const site=this.site || {};
    const color=name=>t[site.workspaces?.[name.toLowerCase()]?.alert_color] || t.muted;
    const expand=path=>typeof path==='string' && path.startsWith('~/')?`${home()}/${path.slice(2)}`:path;
    const reports=`${String(expand(site.reports_dir) || `${home()}/Documents/HerdrReports`).replace(/\/+$/,'')}/`;
    const slackUrl=typeof site.slack?.workspace_url==='string'?site.slack.workspace_url.replace(/\/+$/,''):null;
    const slackLink=link=>slackUrl?String(link).startsWith(`${slackUrl}/archives/`):/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\//.test(link);
    const names=site.slack?.user_names || {};
    const shown=groups.filter(g=>(!this.project || g.project===this.project) && (!this.onlyUnread || g.unread>0));
    const button=(id,label,selected,action)=>div().id(id).px(12).py(7).rounded(5).text_size(13).font_semibold()
      .bg(selected?t.selected:t.surface).text_color(selected?t.accent:t.muted).hover(s=>s.bg(t.hover)).on_click(action).child(label);
    return v_flex().id('sf-mentions').size_full().p(20).gap(12).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().gap(10).items_center()
        .child(image('mods/sixfold-desk/icons/slack.svg').size(26))
        .child(div().flex_1().font_bold().text_size(21).child(props()?.newMessages?`${props()?.project} · 새 메시지`:'나를 태그한 스레드'))
        .child(div().px(10).py(5).rounded(5).bg(t.selected).text_color(t.accent).font_bold().text_size(15).child(`미확인 ${unread}`))
        .child(button('sf-mentions-close','닫기',false,()=>closeOverlay(props()?.overlay))))
      .child(div().text_size(12).text_color(t.muted).child('미확인은 이 팝업에서 확인하지 않은 스레드입니다. Slack 앱의 읽음 상태와 별도로 관리합니다.'))
      .child(div().text_size(12).text_color(health.state==='error'?t.blocked:t.muted).child(collectLine(health)))
      .when(health.slack_freshness==='unknown',e=>e.child(div().text_size(12).text_color(t.muted).child('MCP 미러 기준 · Slack 최신성·인덱싱 지연 미확인')))
      .when(Boolean(freshness(health,Date.now())),e=>e.child(div().text_size(12).text_color(t.blocked).child(freshness(health,Date.now()))))
      .child(h_flex().gap(7).items_center()
        .child(button('sf-filter-all-projects',`전체 ${groups.length}`,!this.project,(_e,cx)=>{this.project=null;cx.notify();}))
        .children(projects.map(project=>button(`sf-filter-${project}`,`${project} · ${groups.filter(g=>g.project===project && g.unread>0).length} 미확인`,this.project===project,(_e,cx)=>{this.project=project;cx.notify();}).text_color(color(project)))))
      .child(h_flex().gap(7).items_center()
        .child(button('sf-filter-unread','미확인만',this.onlyUnread,(_e,cx)=>{this.onlyUnread=!props()?.review;cx.notify();}))
        .child(button('sf-filter-all','확인한 스레드 포함',!this.onlyUnread,(_e,cx)=>{this.onlyUnread=false;cx.notify();}))
        .child(div().flex_1())
        .child(div().text_size(12).text_color(t.muted).child(`${groups.length}개 스레드 · ${this.items.length}개 멘션`)))
      .when(Boolean(this.error),e=>e.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(v_flex().id('sf-mentions-scroll').flex_1().min_h(0).overflow_y_scroll().gap(15)
        .when(shown.length===0,e=>e.child(div().p(20).text_size(15).text_color(t.muted).child('이 조건에 해당하는 미확인 스레드가 없습니다.')))
        .children(projects.filter(p=>shown.some(g=>g.project===p)).map(project=>v_flex().id(`sf-group-${project}`).gap(9)
          .child(h_flex().gap(8).items_center().py(5)
            .child(div().w(5).h(22).rounded(2).bg(color(project)))
            .child(div().font_bold().text_size(18).text_color(color(project)).child(project==='미연결'?'연결된 워크스페이스 없음':project))
            .child(div().text_size(12).text_color(t.muted).child(`${shown.filter(g=>g.project===project).length}개 스레드`)))
          .children(shown.filter(g=>g.project===project).map(group=>{
            const expanded=this.expanded.has(group.key),latest=group.latest;
            const workflow=workflows[group.key];
            const body=readable(latest.text,namesFor(latest,this.feed,names),latest.mentions),preview=body.length>260?body.slice(0,260)+'…':body;
            const title=alertTitle(latest,this.feed,names),files=this.files(latest,`sf-thread-${group.key}`,t);
            return v_flex().id(`sf-thread-${group.key}`).p(14).gap(9).rounded(7).bg(t.surface).border(1).border_color(group.unread?color(project):t.border)
              .child(h_flex().gap(8).items_center()
                .child(div().px(8).py(3).rounded(4).bg(group.unread?t.selected:t.chrome).text_color(group.unread?t.accent:t.muted).text_size(12).font_bold().child(group.unread?`● 미확인 ${group.unread}건`:'✓ 확인함'))
                .child(div().font_bold().text_size(14).child(group.channel))
                .child(div().flex_1())
                .child(div().text_size(11).text_color(t.muted).child(`${latest.at || ''} · 멘션 ${group.items.length}건`)))
              .child(div().text_size(16).font_bold().child(title.length>105?title.slice(0,105)+'…':title))
              .child(div().text_size(14).child(preview))
              .when(Boolean(files),e=>e.child(files))
              .when(Boolean(workflow),e=>e.child(v_flex().p(10).gap(5).rounded(4).bg(t.chrome)
                .child(div().text_size(13).font_bold().text_color(t.accent).child(`자동 처리 · ${stateLabels[workflow?.state] || workflow?.state} · ${workflow?.workspace || group.project} 기존 세션`))
                .when(Boolean(workflow?.summary),e=>e.child(div().text_size(13).child(workflow.summary)))
                .children((workflow?.artifacts ?? []).filter(path=>path.startsWith(reports)).map((path,index)=>button(`sf-artifact-${group.key}-${index}`,'수정안 문서 열기',false,(_e,cx)=>cx.spawn(async()=>{await exec('herdr-doc',[path,'--space',workflow.workspace]);}))))))
              .when(expanded,e=>e.child(v_flex().gap(10).pt(8).border_t(1).border_color(t.border)
                .children(group.items.map(item=>{
                  const files=item===latest?null:this.files(item,`sf-detail-${item.id}`,t);
                  return v_flex().id(`sf-detail-${item.id}`).gap(4)
                    .child(div().text_size(11).text_color(t.muted).child(`${item.at || ''} · ${alertTitle(item,this.feed,names)}`))
                    .child(div().text_size(14).child(readable(item.text,namesFor(item,this.feed,names),item.mentions)))
                    .when(Boolean(files),e=>e.child(files));
                }))))
              .child(h_flex().gap(7)
                .child(button(`sf-expand-${group.key}`,expanded?'본문 접기':`스레드 멘션 ${group.items.length}건 보기`,expanded,(_e,cx)=>{expanded?this.expanded.delete(group.key):this.expanded.add(group.key);cx.notify();}))
                .when(slackLink(latest.link || ''),e=>e.child(button(`sf-source-${group.key}`,'원문 열기',false,(_e,cx)=>cx.spawn(async()=>{await exec('open',[latest.link]);}))))
                .when(group.unread>0,e=>e.child(button(`sf-read-${group.key}`,'이 스레드 확인',true,(_e,cx)=>cx.spawn(async()=>{try{await this.mark(group);this.error='';}catch{this.error='확인 상태를 저장하지 못했습니다. 다시 눌러 주세요.';}cx.notify();})))));
          })))))
      .child(div().text_size(11).text_color(t.dim).child(this.scope || '원문을 직접 확인한 메시지만 표시합니다.'));
  }
}
