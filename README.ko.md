# Herdr Theme

컴퓨터를 선택하면 그 컴퓨터의 워크스페이스와 에이전트만 왼쪽 패널에 표시하는 Herdr 테마입니다. 각 에이전트의 상태·미확인 메시지, 동시에 오가는 메시지 경로, 서브에이전트 관계를 현재 터미널을 유지한 채 확인합니다.

핵심은 화면 분할 수가 아니라 **프로젝트 간 작업 파악과 메시지 흐름 추적**입니다. 기본 6분할 외에도 현재 탭의 분할 구조를 그대로 사용할 수 있습니다.

![Herdr Theme](preview.png)

- 선택 여부와 관계없이 모든 워크스페이스 아래 에이전트를 표시합니다.
- 워크스페이스 안에서는 승인 대기 → 완료 → 작업 중 → 대기 순으로 정렬합니다. 테마 전용 Claude·Codex 아이콘은 활동 중에 컬러와 가벼운 움직임으로 상태를 표시합니다. 왼쪽 행에는 순번을 붙이지 않고 미확인 메시지 개수만 표시합니다.
- 워크스페이스 제목을 드래그하면 순서가 저장됩니다.
- 상태는 각 에이전트 행에 표시하며, Ping 버튼이나 별도의 확인 대기 목록은 표시하지 않습니다.
- 메시지는 설치된 코어의 `hc send 대상 "메시지"`를 직접 호출합니다. Python 추적 래퍼와 설치기는 제거했습니다.
  메시지 애니메이션은 `messageEvents()`를 제공하는 앱과 `message_sent`를 내보내는 코어를 함께 설치해야 동작합니다. 본문은 이벤트에 기록하지 않습니다. 구버전 앱은 기존 로컬 기록을 표시할 수 있지만 직접 전송한 새 메시지는 그 기록에 추가되지 않습니다. 애니메이션은 전송 이벤트이며 수신자의 읽음이나 실제 작업 시작을 보장하지 않습니다.
  이전 래퍼를 설치했다면 PATH와 셸 시작 파일에서 `~/.local/share/herdr-sixfold/bin`을 제거하고 `hc_trace.py` 직접 호출도 중단하세요. PowerShell의 `Get-Command hc -All` 또는 POSIX 셸의 `command -v hc`로 코어 CLI를 가리키는지 확인하세요. 래퍼를 가리키는 `~/.local/bin/hc` 심볼릭 링크만 이전 코어 대상으로 복원하고, 다른 실행기는 그대로 두세요. 내용을 확인한 뒤 해당 폴더의 `hc_trace.py`, `bin/hc`, `bin/hc.cmd`를 제거할 수 있습니다. 설치된 `route.py`와 `collect_workflow.py`도 최신 파일로 갱신하세요. 기존 메시지 기록과 읽음 위치는 유지할 수 있으며, 이미 실행 중인 셸의 PATH는 별도로 갱신해야 할 수 있습니다.

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
사이드바의 `+ Space` 또는 `Ctrl+Shift+N`은 선택한 컴퓨터에 워크스페이스를 만듭니다. 이 컴퓨터에서는 한 탭 안에 Claude 4개·Codex 2개를 3×2 스플릿으로 생성합니다. 원격 컴퓨터에서는 터미널 하나로 시작하며 폴더를 비워두면 해당 컴퓨터의 홈을 사용합니다.
`scripts/workspace.py`도 같은 구성을 기본으로 사용합니다. 에이전트 없이 셸만 열려면 `--shells`를 지정하세요.

기존 TUI 세션은 선택 기능인 `scripts/tui_bridge.py`로 연결할 수 있습니다.
이는 새 런타임으로의 이력 변환이 아니라 기존 프로세스에 대한 실시간 연결입니다.
원래 TUI 서버를 유지해야 하며, 음성 라우팅·자동 전송은 별도 연동 대상입니다.

공개 미리보기는 데모 프로그램으로 촬영합니다. 실제 프로젝트나 대화 내용을 포함하지 않습니다.
상세 설명은 [English README](README.md), 재현 명세는 [RECIPE.md](RECIPE.md)를 참고하세요.

## 고정 워크스페이스 표시

`~/.config/herdr-app/data/sixfold/workspace-pins.local.json`에서 고정할 워크스페이스를 지정합니다. 예: `{"spaces":[{"id":"실제-workspace-id","machine":null}]}`. ID는 `herdr-app ls`로 확인하며 원격은 앱에 표시되는 ID와 machine을 함께 지정합니다. 이름을 바꿔도 고정 표시는 유지되고, 같은 이름의 다른 워크스페이스에는 적용되지 않습니다. 설정된 항목만 핀 아이콘과 강조 테두리로 표시하며, 기본 목록·순서·삭제 동작은 바꾸지 않습니다. `{"spaces":[]}`는 모두 해제합니다. 설정 변경은 실행 중 자동 반영되며 잘못된 JSON은 마지막 정상 설정을 유지합니다. 이 설정은 문서 고정 목록이나 `terminal.pin`과 별개입니다.

## 컴퓨터별 워크스페이스

컴퓨팅 목록에는 이 컴퓨터와 `hc machine`으로 등록한 컴퓨터가 표시됩니다. 선택한 컴퓨터의 워크스페이스·에이전트·상태 개수만 보이며, 승인 대기·완료 이동도 그 컴퓨터 안에서 동작합니다. 다른 컴퓨터로 갔다 돌아오면 마지막으로 선택한 워크스페이스를 엽니다. 워크스페이스가 없는 컴퓨터는 생성 창을, 연결이 끊긴 컴퓨터는 연결 설정을 엽니다. 실행 중인 작업은 유지합니다.

이 컴퓨터와 연결됨·연결 중인 Herdr 원격만 기본 목록의 행으로 표시하며, 행을 누르면 해당 컴퓨터의 워크스페이스 목록으로 전환합니다. 미연결 원격과 미등록 Tailscale 기기는 접힌 상태에서 행·아이콘·개수 모두 숨깁니다. 컴퓨팅 제목 옆 작은 화살표를 누르면 최대 높이 180의 목록으로 다시 볼 수 있습니다. Tailscale 온라인만으로 Herdr 접속 가능 여부가 확인되지는 않으므로 미등록 기기는 숨김 대상에 포함합니다. 컴퓨터 선택·펼치기는 터미널 포커스를 옮기거나 연결을 시작하지 않습니다.

메인에서 `hc ls`로 확인한 주소를 사용해 `hc send worker/t7 "메시지"`로 원격 에이전트에게 메시지를 보내거나, 해당 컴퓨터의 에이전트 행을 선택해 직접 입력할 수 있습니다. 성공한 전송 자체가 읽음 확인은 아닙니다. `hc send --wait`는 수신 프로그램이 보고하는 다음 처리 상태를 기다립니다. 해당 컴퓨터에 에이전트 CLI가 실행·로그인돼 있어야 합니다. SSH·Tailscale·방화벽·인증 설정은 테마와 별도입니다.

컴퓨터별 화면과 원격 생성은 머신 레이아웃을 지원하는 앱·코어가 필요하며 0.1.17에서 검증했습니다. 사용자별 표시 이름과 기본 폴더는 로컬의 `~/.config/herdr-app/data/sixfold/computers.local.json`에 둡니다. 형식은 [English README의 Computers and remote agents](README.md#computers-and-remote-agents)를 참고하세요. 개인 IP·경로·인증 정보는 저장소에 넣지 않습니다. 기존 설치를 업데이트할 때는 `mods/sixfold-desk/main.js`와 `mods/sixfold-new-space/main.js`를 함께 적용하고 두 mod를 검사하세요.

앱 대응 버전의 `herdr-focus-queue`가 설치돼 있다면 `python3 scripts/install_voice.py /path/to/herdr-focus-queue`로 선택한 pane의 음성을 연동할 수 있습니다. 음성 연결 종료와 마이크 음소거를 구분하며, 앱이 비활성 상태이면 TUI 포커스를 덮어쓰지 않습니다. 문장 종료 뒤 자동 전송은 음성 플러그인의 기존 규칙을 사용합니다.

메시지 개수는 워크스페이스를 누르지 않아도 0.25초마다 갱신합니다. 저장 내용이 같으면 다시 그리지 않습니다. 에이전트가 작업을 마치거나 해당 pane을 포커스하면 개수가 사라지고, 읽은 위치는 `data/sixfold/messages-read.json`에 저장되어 재시작해도 다시 쌓이지 않습니다. Share→프로젝트 같은 위치 전달과 빈 pane 대체는 [COMMON_ROUTING.md](COMMON_ROUTING.md)를 따르며, `python3 scripts/route.py --enable`로 현재 checkout의 대기열 처리를 연결합니다. Share 알림은 `data/sixfold/alerts.json`을 읽으며 수집기는 별도입니다.

상시 메시지 흐름 목록은 표시하지 않습니다. 파이프 표현·이동 속도·최근 경로는 기존 방식으로 복구했습니다. `보내는 세션 → 받는 세션` 알림은 새 전송 때 약 4초 표시한 뒤 없앱니다. 경로별 색·차선과 같은 경로의 묶음 개수로 동시 전송을 구분합니다. 전달 대기·오류/보류만 하단 상태줄에 해결될 때까지 남기고, 툴팁에 전체 상세를 표시합니다. Motion off에서는 이동 없이 이름 알림만 잠깐 표시합니다. 메시지 패널·일시 표시 방식의 추가 변경은 사용자 확인 대기 상태입니다.

서브에이전트는 부모 에이전트 행의 `▸ N`으로 펼칩니다. 자식이 없어도 부모 행은 유지하며, 실제 위임이 새로 관측되면 자식 목록과 곡선 흐름을 함께 표시합니다. 워크스페이스 제목에는 메시지 합계를 표시하지 않고 에이전트 행에만 개수를 표시합니다.

`scripts/collect_workflow.py`는 Claude 메타데이터, 읽기 전용 Codex DB, hc의 부모 관계로 `data/sixfold/workflow.json`을 만듭니다. `--once`는 한 번 수집하고, 기본 실행은 3초마다 바뀐 내용만 기록합니다. 실행 상태가 명시되지 않은 기록에는 추정 표시가 붙습니다. 첫 시작의 기존 위임은 애니메이션으로 재생하지 않습니다. 이 수집기의 상시 실행 등록은 별도이며, 테마 설치만으로 자동 등록하지 않습니다.

프로젝트 아이콘은 `python3 scripts/set_workspace_icon.py '워크스페이스 ID 또는 정확한 이름' /path/to/icon.png`로 지정합니다. SVG·PNG·JPEG·WebP를 지원하며 `--background '#ffffff'`, 단색 SVG의 `--tint`를 선택할 수 있습니다. 파일은 이 기기의 `data/sixfold/icons/`에 복사하고 설정은 `workspace-icons.json`에 저장합니다. 변경은 테마를 재시작하지 않아도 반영되며 고객 로고 파일은 공개 저장소에 포함하지 않습니다.

## Optional document and usage tools

Separate mod recipes let you place document and usage tools in a personal layout. [Project Document Viewer](extras/preview/README.md) adds saved-file Markdown preview and local HTML snapshots. [System Metrics](extras/system-metrics/RECIPE.md) adds a separate CPU/memory strip. Token history is available from [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights); subscription quotas come from [Usage Bar](https://github.com/berkeatac/herdr-usage-bar). These are optional, separate installs; account quotas are not per-agent token totals.

Independent mod releases: [System Metrics](https://github.com/chanyang721/herdr-workspace-mods/tree/main/system-metrics) · [Project Document Viewer](https://github.com/chanyang721/herdr-workspace-mods/tree/main/document-viewer).

Project document tracking: see [configuration and collector](docs/project-documents.md). The base theme uses full-width terminals; configured latest documents live in the left sidebar.

## 끝난 임시 워크스페이스 자동 정리

`scripts/close_finished_spaces.py`는 기본 dry-run입니다. 고정 목록은 LukukuWatch의
`close-finished-spaces.json`에서 이름 및 기기/ID로 지정하며, 현재 보고 있는 공간은 제외합니다.
모든 에이전트가 idle/done이고, 입력이 비었으며, 프로세스·백엔드 실행 세션·서브에이전트·확인 대기가
없다는 증거와 출력 불변이 10분간 관찰돼야 후보가 됩니다. 원격이나 확인할 수 없는 상태는 유지합니다.
백엔드 세션 연결이 없거나 오래된 경우에도 일을 끝냈다고 추정하지 않습니다.

`python3 scripts/install_space_cleanup.py --install`은 5분 주기의
`co.lukuku.close-finished-spaces`를 dry-run으로 등록합니다. 30분 이상·7회 이상의 관찰 로그를
직접 검토한 뒤 `--install --enable-apply`로 전환해야 실제 종료됩니다. 관찰 코드가 바뀌면
관찰 기간과 검토가 초기화됩니다. 실행 로그·잠금·상태는
`~/Library/Application Support/LukukuWatch/`에 저장하고 Herdr mod/layout에는 쓰지 않습니다.

종료 직전 조건을 다시 검사하고 기록을 남긴 다음, 종료 여부와 포커스 불변을 확인합니다.
미커밋 파일은 기록에 남기고 보존하며 git worktree도 삭제하지 않습니다. 기존 날짜/이름 기록은
덮어쓰지 않고 자동 정리 시각만 덧붙입니다. 승인·확인 대기는 공간을 유지하고 설정된 Share 세션에
하루 한 번까지 이유를 알립니다. `--only-space ID`로 한 공간만 관찰할 수 있으며 조건을 우회하지 않습니다.
