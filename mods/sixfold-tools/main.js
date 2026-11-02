import {View,div} from 'gpui-kit';
import {v_flex} from 'gpui-base';
import {layout,run,theme,shared,setShared,props} from 'herdr';
function find(node,id){if(node?.id===id)return node;for(const child of node?.children||[]){const found=find(child,id);if(found)return found;}return null;}
export default class Tools extends View {
  init(){if(shared('usage-bar.providers')===undefined||shared('usage-bar.providers')===null)setShared('usage-bar.providers',['codex','claude']);}
  render() {
    if(props()?.spacer)return div().size_full().bg(theme().chrome);
    const t=theme(),tree=layout(),panel=find(tree,'panel'),stack=find(tree,'panel-body');
    const button=(id,label,child)=>div().id(id).w(40).h(50).flex_none().items_center().justify_center().text_size(12).font_semibold()
      .bg(!panel?.hidden&&stack?.active===child?t.selected:t.chrome).text_color(!panel?.hidden&&stack?.active===child?t.accent:t.muted)
      .on_click(()=>{
        if(!panel?.hidden&&stack?.active===child){run('layout.hide',{id:'panel'});return;}
        run('layout.select',{stack:'panel-body',child});run('layout.show',{id:'panel'});
      }).child(label);
    return v_flex().size_full().items_center().bg(t.chrome).border_l(1).border_color(t.border)
      .child(button('tools-docs','문서','files')).child(button('tools-changes','변경','changes'))
      .when(Boolean(find(tree,'usage')),el=>el.child(button('tools-usage','사용량','usage')));
  }
}
