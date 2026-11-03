import { View, div, image } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { theme, props, appHome, readTextFile, writeTextFile, shared, setShared, closeOverlay, exec } from 'herdr';

export default class MentionInbox extends View {
  init(_props,cx) {
    this.items=[];
    let busy=false,previous;
    const refresh=cx=>{
      if(busy)return;
      busy=true;
      cx.spawn(async cx=>{
        try{
          const file=props()?.newMessages ? 'project-alerts.json' : 'slack-mentions.json';
          const text=await readTextFile(`${appHome()}/data/sixfold/${file}`);
          if(text===previous)return;
          const data=JSON.parse(text);
          this.items=(data.items ?? []).filter(i=>!props()?.project || i.project.toLowerCase()===props()?.project.toLowerCase());this.scope=data.scope;
          previous=text;cx.notify();
        }catch{/* Preserve the last valid snapshot through collector writes. */}
        finally{busy=false;}
      });
    };
    refresh(cx);cx.timer.every(2000,refresh);
  }
  render(){
    const t=theme();
    return v_flex().id('sf-mentions').size_full().p(16).gap(10).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().gap(8).items_center()
        .child(image('mods/sixfold-desk/icons/slack.svg').size(20))
        .child(div().flex_1().font_bold().text_size(16).child(`${props()?.newMessages ? props()?.project+' · 새 메시지' : '나를 태그한 메시지'} · ${this.items.length}`))
        .child(div().id('sf-mentions-close').px(8).py(4).text_size(12).text_color(t.accent).on_click(()=>closeOverlay(props()?.overlay)).child('닫기')))
      .child(div().text_size(10).text_color(t.muted).child(this.scope || (props()?.newMessages ? '연결된 채널에서 새로 도착한 메시지입니다.' : '직접 확인한 멘션 · 처리 여부는 원문을 확인하세요.')))
      .child(v_flex().id('sf-mentions-scroll').flex_1().min_h(0).overflow_y_scroll().gap(8)
        .when(this.items.length===0,e=>e.child(div().text_size(12).text_color(t.muted).child('새로 도착한 메시지가 없습니다.')))
        .children(this.items.map(item=>v_flex().id(`sf-mention-${item.id}`).p(10).gap(5).rounded(5).bg(t.surface)
          .child(div().text_size(13).font_bold().child(`${item.project} · ${item.channel_name || item.channel}`))
          .child(div().text_size(10).text_color(t.muted).child(`${item.author || ''} · ${item.at || ''}`))
          .child(div().text_size(12).child((item.text || '').replace(/<@[^>|]+\|([^>]+)>/g,'@$1').replace(/<@U0C65183V1U>/g,'@이찬양').replace(/<(https?:[^>|]+)\|([^>]+)>/g,'$2')))
          .when(props()?.newMessages,e=>e.child(div().id(`sf-read-${item.id}`).py(4).text_size(11).text_color(t.accent)
            .on_click((_event,cx)=>cx.spawn(async()=>{
              const path=`${appHome()}/data/sixfold/slack-alerts-read.json`;
              const old=await readTextFile(path).catch(()=>null);const read=old?JSON.parse(old):{};
              read[item.id]=item.id;await writeTextFile(path,JSON.stringify(read),old);setShared('sixfold.alertRead',read);
            })).child((shared('sixfold.alertRead') ?? {})[item.id]===item.id?'확인함':'확인했어요')))
          .when(/^https:\/\/lukukuworkspace\.slack\.com\/archives\//.test(item.link || ''),e=>e.child(div().id(`sf-mention-source-${item.id}`).py(4).text_size(11).text_color(t.accent)
            .on_click((_event,cx)=>cx.spawn(async()=>{await exec('open',[item.link]);})).child('원문 보기'))))));
  }
}
