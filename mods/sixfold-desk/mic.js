import {div} from 'gpui-kit';
import {h_flex} from 'gpui-base';
import {subscribeJsonFile} from './panel-io.js';

// Microphone state per pane, as the voice plugin (rust/src/voice/queue/mic.rs) writes it
// to <app home>/data/sixfold/voice-mic.json only when it changes. The sidebar watches the
// file and shares it; each pane header draws its own badge from the shared copy.
export const MIC_KEY='sixfold.voice.mic';
export const MIC_FILE='voice-mic.json';

export function watchMic(view,cx,folder,share){
  let last=null;
  const stop=subscribeJsonFile(cx,`${folder}/${MIC_FILE}`,snapshot=>{
    const value=snapshot.status==='ready'&&snapshot.value&&typeof snapshot.value==='object'?snapshot.value:null;
    if(snapshot.status!=='ready'&&snapshot.status!=='missing')return;
    const text=JSON.stringify(value);
    if(text===last)return;
    last=text;share(MIC_KEY,value);
  });
  (view.fileSubscriptions??=[]).push(stop);return stop;
}

// The voice plugin names Herdr App panes `app:<terminal>`; a terminal bridged from the
// herdr TUI carries the TUI pane id in its `sixfold.source-pane` label.
export function micKeys(p,facts){
  const keys=[];
  if(p.terminal)keys.push(`app:${p.terminal}`);
  const source=(facts||[]).find(x=>x.address===p.terminal)?.labels?.['sixfold.source-pane'];
  if(source)keys.push(source);
  return keys;
}

// What this pane's header shows, or null. A recording shows on any pane (two at once
// is the fault to notice); paused and off only on the focused pane, where the person
// expects to talk. A dropped dictation shows on its pane until the plugin clears it.
export function paneMic(p,facts,record){
  if(!record||typeof record!=='object')return null;
  const keys=micKeys(p,facts);
  const key=keys.find(k=>record.panes?.[k]);
  const entry=key?record.panes[key]:null;
  const dropped=record.dropped&&keys.includes(record.dropped.pane)?record.dropped:null;
  const state=entry?.state==='recording'||(p.focused&&['paused','off'].includes(entry?.state))?entry.state:null;
  if(!state&&!dropped)return null;
  return {state,reason:state?entry.reason??null:null,agent:entry?.agent??null,dropped};
}

const REASONS={headset:'헤드셋 아님',front:'다른 앱 사용 중',muted:'음소거',not_ready:'입력 대기 아님',key_ignored:'F8 무시됨'};
const DROPS={other:'다른 목소리',unknown:'목소리 확인 안 됨',headset:'헤드셋 아님',refused:'전송 막힘'};

export function micParts(mic,width){
  const wide=width==null||width>=560;
  const parts=[];
  if(mic.state==='recording')parts.push({kind:'recording',text:wide?'마이크 듣는 중':'듣는 중'});
  else if(mic.state==='paused')parts.push({kind:'paused',text:wide&&REASONS[mic.reason]?`마이크 멈춤 · ${REASONS[mic.reason]}`:'마이크 멈춤'});
  else if(mic.state==='off')parts.push({kind:'off',text:wide&&mic.reason==='key_ignored'?`마이크 꺼짐 · ${REASONS.key_ignored}`:'마이크 꺼짐'});
  if(mic.dropped)parts.push({kind:'dropped',text:wide?`${DROPS[mic.dropped.cause]||'받아쓰기'} · 버림`:'버림'});
  return parts;
}

export function micTip(mic){
  const lines=[];
  const who=mic.agent==='codex'?'Codex':'Claude';
  if(mic.state==='recording')lines.push(`${who} 받아쓰기가 이 칸에서 듣고 있습니다.`);
  else if(mic.state==='paused')lines.push(`마이크가 멈췄습니다: ${REASONS[mic.reason]||mic.reason||'이유 모름'}.`);
  else if(mic.state==='off')lines.push(mic.reason==='key_ignored'?'F8을 두 번 눌러도 녹음이 켜지지 않아 60초 뒤 다시 시도합니다.':'Claude가 입력을 기다리는 화면이 아니라 마이크를 켜지 않았습니다.');
  if(mic.dropped){
    const d=mic.dropped;
    const why={other:'다른 사람 목소리로 판단해',unknown:'누구 목소리인지 확인하지 못해',headset:'헤드셋이 아닌 마이크라',refused:'전송 확인에서 막혀'}[d.cause]||'';
    lines.push(`${d.chars}자 받아쓰기를 ${why} 보내지 않고 지웠습니다.`);
  }
  lines.push('음성 플러그인 기준, 상태가 바뀔 때만 갱신');
  return lines.join('\n');
}

export function paneMicChip(p,t,mic,width){
  const tip=micTip(mic);
  // Recording is the terminal palette's red (ansi1), like a recorder's light; paused uses the working colour.
  const red=t.ansi1||t.blocked||t.accent, amber=t.working||t.accent;
  const chip=h_flex().id(`pane-mic-${p.pane}`).flex_none().h(18).items_center().gap(6).px(7).rounded(9)
    .bg(mic.state==='recording'?`${red.slice(0,7)}22`:t.surface).border(1)
    .border_color(mic.state==='recording'?red:t.border).text_size(11).tooltip(tip).accessibility_label(tip);
  for(const part of micParts(mic,width)){
    if(part.kind==='recording')chip.child(h_flex().items_center().gap(4)
      .child(div().size(7).rounded(4).flex_none().bg(red))
      .child(div().font_semibold().text_color(t.foreground).child(part.text)));
    else if(part.kind==='paused')chip.child(h_flex().items_center().gap(4)
      .child(div().size(7).rounded(4).flex_none().border(1).border_color(amber))
      .child(div().text_color(t.foreground).child(part.text)));
    else if(part.kind==='off')chip.child(h_flex().items_center().gap(4)
      .child(div().size(7).rounded(4).flex_none().border(1).border_color(t.dim))
      .child(div().text_color(t.muted).child(part.text)));
    else chip.child(div().text_color(red).child(part.text));
  }
  return chip;
}
