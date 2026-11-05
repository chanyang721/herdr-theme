import { View, div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { appHome, home, props, closeOverlay, exec, theme, pickFolder, knownAgents, run, window } from 'herdr';

export default class NewWorkspace extends View {
  init(_props, cx) {
    this.machine = props()?.machine ?? null;
    this.machineName = props()?.machineLabel || this.machine || '이 컴퓨터';
    this.name = InputState.new({placeholder:'워크스페이스 이름'});
    this.folder = InputState.new({value:props()?.folder || (this.machine === null ? home() : ''), placeholder:this.machine === null ? '프로젝트 폴더' : '원격 폴더 (비워두면 해당 컴퓨터의 홈)'});
    // Tier of the single starting session (ADR-0008): low|mid|high|max, empty = high.
    this.tiers = InputState.new({value:props()?.tiers || '', placeholder:'첫 세션 tier 하나 (low|mid|high|max · 비우면 high)'});
    this.busy = false;
    this.error = '';
    this.name.on('submit', (_e,cx)=>this.create(cx));
    this.name.focus();
  }

  create(cx) {
    if (this.busy) return;
    const name=this.name.value().trim(), folder=this.folder.value().trim(), tiers=this.tiers.value().replace(/\s+/g,'');
    if (!name || (this.machine === null && !folder)) { this.error='이름과 프로젝트 폴더를 입력하세요.'; cx.notify(); return; }
    this.busy=true; this.error=''; cx.notify();
    cx.spawn(async cx=>{
      try {
        if (this.machine !== null) {
          // Pin the target even if the user switches computers while this dialog is open.
          run('space.new', {name, ...(folder ? {folder} : {}), machine:this.machine, tab:'터미널'});
          closeOverlay(props().overlay);
          return;
        }
        const agents=await knownAgents();
        // The workspace opens one Claude session; Codex is only needed later, when dispatch adds a pane.
        if (!agents.some(a=>a.key==='claude' && a.installed)) throw new Error('claude 실행 파일을 먼저 설치해 주세요.');
        const windows=(typeof window==='function' && window()?.platform==='windows') || /^(?:[A-Za-z]:[\\/]|\\\\)/.test(home());
        const result=await exec(`${appHome()}/scripts/sixfold/herdr-theme${windows?'.exe':''}`,[
          'workspace',name,folder,
          ...(tiers?['--tiers',tiers]:[]),
        ]);
        if (result.code!==0) throw new Error(result.stderr || result.stdout || '워크스페이스 생성 실패');
        closeOverlay(props().overlay);
      } catch(error) {
        this.error=String(error.message || error);
      } finally { this.busy=false; cx.notify(); }
    });
  }

  render() {
    const t=theme();
    const button=(id,label,fn)=>div().id(id).px(12).py(7).rounded(5).bg(t.raised).cursor_pointer().on_click(fn).child(label);
    return v_flex().p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(16).font_bold().child('새 워크스페이스'))
      .child(div().text_size(12).text_color(t.accent).child(this.machineName))
      .child(Input.new(this.name).h(36).px(8).bg(t.background).rounded(5))
      .child(Input.new(this.folder).h(36).px(8).bg(t.background).rounded(5))
      .when(this.machine === null, e=>e.child(button('sf-pick-folder','폴더 선택',(_e,cx)=>{
        if(this.busy)return;
        cx.spawn(async cx=>{const path=await pickFolder();if(path)this.folder.set_value(path);cx.notify();});
      })))
      .when(this.machine === null, e=>e.child(Input.new(this.tiers).h(36).px(8).bg(t.background).rounded(5)))
      .child(div().text_size(12).text_color(t.muted).child(this.machine === null ? '조정 세션 1개로 시작 · 칸은 작업에 따라 늘고 줄어듭니다 · tier: low|mid|high|max' : '이 컴퓨터의 폴더 경로를 입력하세요. 터미널 탭으로 시작합니다.'))
      .when(Boolean(this.error),e=>e.child(div().text_size(11).text_color(t.blocked).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(button('sf-new-cancel','닫기',()=>{if(!this.busy)closeOverlay(props().overlay);}))
        .child(button('sf-new-create',this.busy?'생성 중…':'만들기',(_e,cx)=>this.create(cx))));
  }
}
