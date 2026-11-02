import PreviewPlus from './upstream/main.js';
import {div,image} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import {exec,appHome} from 'herdr';

const html=selected=>Boolean(selected&&!selected.on&&/\.html?$/i.test(selected.file));
const parent=path=>path.slice(0,path.lastIndexOf('/'))||'/';
export default class SixfoldDocs extends PreviewPlus {
  load(cx,notify=true) {
    this.htmlMedia=null;this.htmlError=null;this.htmlLoading=html(this.selected);this.htmlReloadPending=false;
    super.load(cx,notify);
    if(!this.htmlLoading)return;
    const request=this.request,selected=this.selected;
    const width=Math.round(Math.max(320,Math.min(1600,this.viewport.width-32)));
    const relative=`data/sixfold/html-preview/page-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const output=`${appHome()}/${relative}`;
    this.htmlWidth=width;
    cx.spawn(async cx=>{
      try {
        const result=await exec(`${appHome()}/data/sixfold/html-preview/render-html`,[selected.file,output,String(width),selected.root||parent(selected.file)]);
        const info=JSON.parse(result.stdout.trim()||'{}');
        if(result.code!==0||info.error)throw new Error(info.error||result.stderr||'HTML renderer failed');
        if(!this.current(request))return;
        this.htmlMedia={...info,path:relative};
        this.watchTargets([selected.file,...(info.assets||[])],cx);
      }catch(error){if(this.current(request))this.htmlError=String(error.message||error);}
      finally {
        if(this.current(request)){
          this.htmlLoading=false;
          if(this.htmlReloadPending){this.load(cx);return;}
          cx.notify();
        }
      }
    });
  }
  reload(cx) {
    if(this.htmlLoading){this.htmlReloadPending=true;return;}
    super.reload(cx);
  }
  body(type,colors) {
    if(!html(this.selected))return super.body(type,colors);
    const button=(id,label,source)=>div().id(id).px(8).py(5).rounded(4).text_size(11)
      .bg(this.source===source?colors.selected:colors.background).text_color(colors.foreground)
      .on_click((_event,cx)=>{this.source=source;cx.notify();}).child(label);
    const media=this.htmlMedia;
    const width=media?Math.min(media.width,Math.max(280,this.viewport.width-32)):320;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(8).py(4).gap(4).items_center().border_b(0.5).border_color(colors.border)
        .child(button('html-render','HTML 미리보기',false)).child(button('html-source','소스',true))
        .child(div().flex_1().truncate().text_size(10).text_color(colors.muted).child('저장 시 갱신 · 읽기 전용')))
      .when(this.source,el=>el.child(super.body(type,colors)))
      .when(!this.source,el=>el.child(div().id('html-native-preview').flex_1().min_h(0).overflow_y_scrollbar().p(16)
        .on_size_change((size,cx)=>this.measure(size,cx))
        .when(this.htmlLoading||Boolean(this.htmlError),el=>el.child(div().text_size(12).text_color(colors.muted).child(this.htmlError||'HTML 렌더링 중…')))
        .when(Boolean(media),el=>el.child(v_flex().gap(8)
          .when(Boolean(media?.truncated),el=>el.child(div().text_size(11).text_color(colors.muted).child('긴 문서의 상단 12,000px을 표시합니다. 전체 문서는 Open으로 확인하세요.')))
          .child(image(media?.path||'').w(width).h(media?width*media.height/media.width:1).flex_none())))));
  }
}
