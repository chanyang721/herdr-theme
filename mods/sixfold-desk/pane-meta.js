import {div, svg} from 'gpui-kit';
import {h_flex} from 'gpui-base';

// Session settings Plan Usage publishes per terminal (agent-usage.shares → terminals[t].meta),
// read by Agent Usage from the session's own log. A pane without a confirmed session shows nothing.
export const SHARES_KEY='agent-usage.shares';
const NAMES={claude:'Claude',codex:'Codex'};
const LEVELS={full:'전체 권한 · 묻지 않음',auto:'자동 진행',ask:'승인 필요'};
// The agent's own product name as a title adds nothing next to its icon.
const DEFAULT_TITLE=/^(claude( code)?|codex( cli)?)$/i;

export function paneMeta(terminal,shared){
  const meta=shared(SHARES_KEY)?.terminals?.[terminal]?.meta;
  return meta&&NAMES[meta.agent]&&meta.model?meta:null;
}

export function metaTip(meta){
  return [`${NAMES[meta.agent]} · ${meta.modelId||meta.model}`,
    meta.speed&&`속도 ${meta.speed}`,meta.effort&&`effort ${meta.effort}`,
    meta.permission&&`권한 ${meta.permission}${meta.level?` (${LEVELS[meta.level]})`:''}`,
    '세션 기록 기준'].filter(Boolean).join('\n');
}

// Which parts fit the header: everything when wide, model and permission when medium, icon and dot when narrow.
export function metaParts(meta,width){
  const wide=width==null||width>=560, medium=width>=400;
  const parts=[meta.model];
  if(wide&&meta.speed)parts.push(meta.speed);
  if(wide&&meta.effort)parts.push(meta.effort);
  return {text:wide||medium?parts.join(' · '):'',permission:wide||medium?meta.permission:null};
}

export function showTitle(text,meta){
  return !(meta&&DEFAULT_TITLE.test((text||'').trim()));
}

// Permission risk as colour: full access warns, auto reads normally, asking ones stay dim.
export function levelColor(level,t){
  return level==='full'?(t.working||t.blocked):level==='auto'?t.muted:t.dim;
}

export function paneMetaChip(p,t,meta,width){
  const {text,permission}=metaParts(meta,width);
  const tip=metaTip(meta), color=levelColor(meta.level,t);
  const chip=h_flex().id(`pane-meta-${p.pane}`).flex_none().items_center().gap(5).text_size(11).tooltip(tip).accessibility_label(tip)
    .child(svg(`mods/plan-usage/${meta.agent}.svg`).size(12).flex_none().text_color(meta.agent==='codex'?'#10A37F':'#D97757'));
  if(text)chip.child(div().text_color(t.muted).child(text));
  if(meta.level)chip.child(div().size(6).rounded(3).flex_none().bg(color));
  if(permission)chip.child(div().text_color(meta.level==='full'?color:t.muted).when(meta.level==='full',el=>el.font_semibold()).child(permission));
  return chip;
}
