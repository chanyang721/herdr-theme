# Sixfold

여러 코딩 에이전트를 3열 × 2행으로 보며 작업하는 Herdr 테마입니다.
좁은 왼쪽 패널, 번호가 붙은 pane, 승인 대기와 완료 표시, 현재 입력 대상 표시를 제공합니다.

![Sixfold](preview.png)

## 설치

```sh
git clone https://github.com/chanyang721/herdr-sixfold.git
cd herdr-sixfold
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
