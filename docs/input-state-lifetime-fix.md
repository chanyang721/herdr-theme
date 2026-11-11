# 사이드바 이슈 검색 입력 상태 수명 수정 (2026-11-11)

## 증상

사이드바 Demo 카드 상단(Share 카드 아래)에 `this input state has been released and can no longer be rendered`가 표시되고, 카드가 그려지지 않았다.

## 확인된 결함 (1차 소스)

1. **오류 문구의 출처**: `vendor/gpui-kit/crates/shell/src/engine/quickjs/entity_api.rs`의 `__input_element`. `store.entities().input(handle).is_none()`이면 이 문구로 TypeError를 던진다. 다시 말해, 해제된 InputState로 `Input.new(...)`를 호출하면 던진다.
2. **InputState의 소유자**: `entities.rs`의 `push()`가 레코드마다 `owner: scope::current_view()`를 기록한다. `release_view()`는 view를 해제할 때 그 view가 init·이벤트·task에서 만든 레코드를 모두 함께 해제한다. 이벤트에서 만든 InputState는 그 이벤트를 실행한 view에 귀속된다. 그 view가 해제되면 InputState도 함께 해제된다. (`release_application`, 자식 init/update 실패 시의 `rollback`도 해제 경로다.)
3. **사이드바 코드**(`mods/sixfold-desk/panel-retained.js`, 설치본 기준):
   - 이슈 검색 InputState를 opener(popover `on_open_change`, peek 제목 `on_click` → `c.openIssues` → 저장된 opener)에서 만들었다. 댓글 InputState도 `onMenu` 클릭 이벤트에서 만들었다.
   - `search: state?.input ? Input.new(state.input) : null`가 popover가 **닫혀 있어도** 카드를 그릴 때마다 실행됐다. input 하나가 해제되면 그 카드 render 전체가 매번 실패했다.
   - `c.issueStates`는 space가 사라질 때만(`:454`) 지워지므로, 카드가 살아 있는 동안에는 해제된 핸들이 그대로 남았다.
4. **수정 전 코드로 재현**(임시 테스트, mock runtime): peek 제목 클릭 이벤트가 InputState를 1개 만들었다. 그 input을 해제하고 닫힌 카드를 render하자 `this input state has been released and can no longer be rendered`가 발생했다.

## 추정 계기 (확인 안 됨, 결함과 분리)

- 과거 트리거 로그가 없다. 앱 로그·telemetry에서도 이 문구를 찾지 못했다.
- 가설: peek(arrival layer)나 다른 view의 이벤트에서 만든 input의 owner view가 해제됐다. 또는 mod 사본·세대 교체 시 해제됐다. 설치본 코드에서 peek는 사이드바 main view render에서 그려지므로, 이 경로의 owner는 sidebar view일 가능성이 높다. 어떤 view가 언제 해제됐는지는 확인하지 못했다.

## 수정

- `PanelSpace.init()`/`update()`가 `c.adoptInputs(id)`로 검색·댓글 InputState를 만든다. owner는 그 카드 view이고, 수명은 `c.cards`의 카드 entity와 같다.
- opener와 댓글 메뉴 이벤트는 InputState를 만들지 않는다. 대신 `c.ensureInputs(id)`로 해제된 입력이 있으면 카드 `set_props`를 호출하고, 카드 `update()`가 입력을 교체한다.
- render는 `c.inputElement()`로 살아 있는 입력만 그린다. 해제됐으면 빼고 `c.staleInputs`에 표시만 한다(render 안에서 native state를 만들지 않음). 다음 `apply()`나 열기·메뉴 이벤트에서 복구한다.
- 닫힌 검색은 입력을 그리지 않는다.
- 카드가 제거되거나 `dispose()`되면 `issueInputs`를 정리하고 명시적으로 release한다. 교체할 때는 검색어(`state.query`)와 읽을 수 있는 댓글 내용을 보존한다.

## 검증

- `node --test tests/panel-retained.test.mjs`: 23/23 통과(신규 3개 포함).
  - 카드 init이 입력을 만들고, 열기 이벤트와 peek 경로는 InputState를 만들지 않는다.
  - init 당시 query 없음 → change → close/reopen 시 같은 입력과 query가 유지된다.
  - 해제된 search·comment 각각: 카드 render가 throw하지 않고 입력을 빼고 그린다. apply/열기/메뉴 이벤트에서 update로 교체되고 query가 보존된다.
  - 카드 제거 → 입력 release, 재등장 → 새 카드 init이 새 입력을 만든다.
  - dispose → 카드 release, `issueInputs` 비움.
- 전체 `npm test`: 551개 중 545개 통과. 실패 6개(`voice/tests/native-install.test.mjs`)는 새 worktree에 `rust/target/debug/herdr-theme`가 없어서 나는 `spawnSync ENOENT`다. 수정 전 기준(stash)에서도 같은 6개가 실패했으므로 이번 범위 밖이다.
- `HERDR_APP_HOME=<격리> herdr-app check mods/sixfold-desk`: 통과. `scripts/check-native.mjs`(release inventory)도 통과.

## 설치

- 기준: 설치본 `sixfold-desk` = `a64d040`(scrub/timeline-names) + `aaf9504`(이슈 패널 overflow)의 `task-issues-view.js`. `diff -rq`로 일치를 확인했다.
- 설치 전 `panel-retained.js` sha256 `24184035…7538` = `a64d040` 원본과 같음을 확인했다. 백업은 `~/Documents/Reports/input-state-lifetime-20261111/panel-retained.js.before-20261111T152024`이다.
- `panel-retained.js` 1파일만 교체했다(설치 후 sha256 `b2c0efd8…0052`, worktree와 같음).
- 설치 후 `herdr-app status`: `errors: []`, space·focused_pane 변화 없음. 마지막 프레임에서 Demo 카드가 정상으로 그려졌다. UI 조작·포커스 이동은 하지 않았다.

## 남은 것

- `docs-finder.js`도 이벤트에서 InputState를 만들어 main view에 둔다. 이 입력은 열렸을 때만 그려지므로 영향 범위가 작다. 같은 위험이 있는지는 따로 확인해야 한다.
- 카드 entity 자체가 다른 view의 소유 트리로 연쇄 해제되는 경우는 이번 수정 범위 밖이다.
