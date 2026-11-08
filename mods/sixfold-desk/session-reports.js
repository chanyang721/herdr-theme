import { div } from 'gpui-kit';
import { v_flex } from 'gpui-base';
import { appHome, run } from 'herdr';
import {subscribeJsonFile,readJsonSnapshot} from './panel-io.js';

export function parseReports(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text || 'null') : text; } catch { return []; }
  if (data?.schema !== 1 || !Array.isArray(data.reports)) return [];
  const seen = new Set();
  return data.reports.filter(row => {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)
      || typeof row.title !== 'string' || !row.title || typeof row.summary !== 'string') return false;
    seen.add(row.id); return true;
  }).slice(0, 20).map(row => ({id: row.id, title: row.title, summary: row.summary,
    state: typeof row.state === 'string' ? row.state : '',
    terminal: typeof row.terminal === 'string' ? row.terminal : null}));
}
export function watchReports(view, cx) {
  view.stopReports?.();view.sessionReports=[];
  const path=`${appHome()}/data/sixfold/session-reports.json`;
  let stopped=false,active=true,previous=JSON.stringify([]),pendingNotify=false,loading=null,version=0;
  const notify=()=>{if(!stopped&&pendingNotify&&active&&view.sidebarVisible!==false){pendingNotify=false;cx.notify();}};
  const accept=snapshot=>{
    if(stopped)return;version++;
    let reports;
    if(snapshot.status==='missing')reports=[];
    else if(snapshot.status==='ready'&&Object.hasOwn(snapshot,'value')){
      const value=snapshot.value;
      if(value?.schema!==1||!Array.isArray(value.reports))return;
      reports=parseReports(value);
    }else return;
    const signature=JSON.stringify(reports);
    if(signature!==previous){previous=signature;view.sessionReports=reports;pendingNotify=true;}
    notify();
  };
  const release=subscribeJsonFile(cx,path,accept);
  const stop=()=>{if(stopped)return;stopped=true;release();};
  view.stopReports=stop;
  view.refreshReports=(context=cx)=>{
    notify();if(stopped||loading)return loading;
    const observed=version;
    loading=(context??cx).spawn(async()=>{
      try{const snapshot=await readJsonSnapshot(path).catch(()=>({status:'invalid'}));if(!stopped&&version===observed)accept(snapshot);}
      finally{loading=null;}
    });return loading;
  };
  view.setReportsActive=value=>{active=value!==false;notify();};
  return stop;
}
export function reportsSection(view, t) {
  return v_flex().id('sf-session-reports').flex_none().px(10).py(8).gap(4).border_t(1).border_color(t.border)
    .children((view.sessionReports ?? []).slice(0, 4).map((row, index) =>
      v_flex().id(`sf-report-${index}`).gap(2).tooltip(`${row.title}\n${row.summary}`)
        .when(Boolean(row.terminal), e => e.cursor_pointer().on_click(() => run('agent.focus', {terminal: row.terminal})))
        .child(div().text_size(10).text_color(t.muted).child(row.title))
        .child(div().text_size(10).text_color(t.dim).truncate().child(row.summary))));
}
