# Herdr Theme

여러 코딩 에이전트를 3열 × 2행으로 보며 작업하는 Herdr 테마입니다.
좁은 왼쪽 패널, 번호가 붙은 pane, 승인 대기와 완료 표시, 현재 입력 대상 표시를 제공합니다.

![Herdr Theme](preview.png)

- 선택 여부와 관계없이 모든 워크스페이스 아래 에이전트를 표시합니다.
- 워크스페이스 안에서는 승인 대기 → 완료 → 작업 중 → 대기 순으로 정렬합니다. 테마 전용 Claude·Codex 아이콘은 활동 중에 컬러와 가벼운 움직임으로 상태를 표시합니다. 왼쪽 행에는 숫자를 붙이지 않습니다.
- 워크스페이스 제목을 드래그하면 순서가 저장됩니다.
- 각 행의 Ping은 해당 에이전트에 연결 확인 메시지를 보냅니다. ↑는 전송됨, !는 실패이며 응답 확인과 구분합니다.
- 선택 설치하는 `scripts/install_trace.py`는 `hc send`의 발신·수신·시간만 로컬에 최대 32개 기록합니다.
  본문은 기록하지 않습니다. 발신·수신 행을 직접 잇는 파이프와 이동하는 점, 양 끝 강조·미확인 수 표시를 제공하며 Motion으로 끌 수 있습니다.
  이 실행기를 통하지 않은 RPC 메시지는 감지하지 못합니다. 음성 라우팅과도 별개입니다.

## 설치

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
herdr-app do layout.switch --name sixfold
```

기존 레이아웃과 다른 단축키는 보존합니다. 같은 이름의 테마가 이미 설치돼 있으면 덮어쓰지 않습니다.
업데이트는 Git diff를 검토한 뒤 이 저장소의 파일만 적용합니다.

- Cmd+[ / Cmd+]: 같은 탭의 이전·다음 pane
- Cmd+Option+1~6: 번호로 pane 선택
- Ctrl+Shift+방향키: 이웃 pane으로 이동
- Cmd+Shift+Enter: 현재 pane 확대
- Cmd+Shift+J / U: 승인 대기·완료 에이전트로 이동
- Cmd+W / Cmd+Shift+W: 실수로 닫지 않도록 비활성

`scripts/balance_grid.py`는 실행 중인 프로세스를 유지하고 6개 pane을 같은 크기로 맞춥니다.
`scripts/workspace.py`는 프로젝트별 6분할을 생성합니다. `--agents`를 주면 Claude 4개·Codex 2개를 시작합니다.

기존 TUI 세션은 선택 기능인 `scripts/tui_bridge.py`로 연결할 수 있습니다.
이는 새 런타임으로의 이력 변환이 아니라 기존 프로세스에 대한 실시간 연결입니다.
원래 TUI 서버를 유지해야 하며, 음성 라우팅·자동 전송은 별도 연동 대상입니다.

공개 미리보기는 데모 프로그램으로 촬영합니다. 실제 프로젝트나 대화 내용을 포함하지 않습니다.
상세 설명은 [English README](README.md), 재현 명세는 [RECIPE.md](RECIPE.md)를 참고하세요.

앱 대응 버전의 `herdr-focus-queue`가 설치돼 있다면 `python3 scripts/install_voice.py /path/to/herdr-focus-queue`로 선택한 pane의 음성을 연동할 수 있습니다. 음성 연결 종료와 마이크 음소거를 구분하며, 앱이 비활성 상태이면 TUI 포커스를 덮어쓰지 않습니다. 문장 종료 뒤 자동 전송은 음성 플러그인의 기존 규칙을 사용합니다.
