import {View,div,svg} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {exec,appHome,theme} from 'herdr';
export default class SystemMetrics extends View {
  init(_props,cx) {
    this.history=[];this.data=null;this.busy=false;this.error=null;
    this.refresh(cx);cx.timer.every(5000,cx=>this.refresh(cx));
  }
  refresh(cx) {
    if(this.busy)return;
    this.busy=true;
    cx.spawn(async cx=>{
      try {
        const result=await exec('python3',[`${appHome()}/mods/system-metrics/sample.py`]);
        const data=JSON.parse(result.stdout);
        if(data.error||result.code!==0||![data.cpu,data.memory,data.total].every(Number.isFinite)||data.cpu<0||data.cpu>100||data.memory<0||data.total<=0)throw new Error(data.error||'Metrics unavailable');
        this.data=data;this.history=[...this.history,{cpu:data.cpu,memory:100*data.memory/data.total}].slice(-16);this.error=null;
      } catch(error){this.error=String(error.message||error);}
      finally{this.busy=false;cx.notify();}
    });
  }
  render() {
    const t=theme(),d=this.data,stale=Boolean(this.error);
    const chart=key=>h_flex().h(16).gap(2).items_end().children(this.history.map((point,i)=>div().w(3).h(Math.max(1,Math.min(100,point[key])*0.16)).bg(stale?t.dim:key==='cpu'?t.accent:t.done)));
    const cell=(name,value)=>h_flex().gap(5).items_center().child(svg(`mods/system-metrics/${name==='CPU'?'cpu':'memory'}.svg`).size(13).text_color(t.muted)).child(div().text_color(t.dim).child(name)).child(div().text_color(stale?t.blocked:t.foreground).child(value));
    return h_flex().size_full().items_center().px(10).gap(14).justify_center().bg(t.chrome).text_size(11)
      .child(cell('CPU',d?`${d.cpu.toFixed(1)}%${stale?' *':''}`:'—'))
      .child(chart('cpu'))
      .child(cell('MEM',d?`${(d.memory/1073741824).toFixed(1)} / ${(d.total/1073741824).toFixed(0)} GB${stale?' *':''}`:'—'))
      .child(chart('memory'))
      .when(stale,el=>el.child(div().text_color(t.blocked).child('갱신 오류')));
  }
}
