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
초기 설치 이후 **설치는 `scripts/update_install.py`로만** 합니다. 실행 중 앱의 설치본에 직접 `cp`·`rsync`하지 않습니다. Git diff를 검토하고 반영할 파일을 명시합니다.

```sh
python3 scripts/update_install.py mods/sixfold-desk/main.js mods/sixfold-desk/model.js
```

이 스크립트는 설치 잠금(`data/sixfold/install.lock`)을 잡고, `mods/` 바깥 임시 폴더에 완성된 모드 트리를 만들어 네이티브 검사합니다. 원본 전체를 `backups/sixfold-update-*/`에 저장한 다음 macOS/Linux의 원자적 디렉터리 교환으로 교체합니다. `scripts/<파일>`은 초기 설치와 같은 `scripts/sixfold/<파일>`에 반영합니다. 미지정 설치 파일은 보존하고, 해시·권한이 같은 파일은 건너뛰어 불필요한 reload를 막습니다. 설치 후 오류 0건이 1초간 유지되고 워크스페이스·탭·포커스가 같아야 통과합니다. 검증 실패 시 자동 되돌리되 다른 작성자의 후속 변경은 덮어쓰지 않고 충돌로 보고합니다. 결과는 백업의 `receipt.json`에서 확인합니다. `status` 성공과 별도로 실제 shot도 확인합니다.

편집 세션마다 별도 git worktree·브랜치를 쓰고, 지정한 세션 하나만 검토된 결과를 설치합니다. **모드 디렉터리를 `mods/*-recovery`로 복사하거나 레이아웃을 복구용 복제 모드로 연결하는 방식은 금지합니다.** 백업은 반드시 `mods/` 밖에 둡니다. 이미 깨진 앱의 승인된 복구에서는 `--allow-unhealthy-before`로 시작 오류만 허용할 수 있고, 최종 오류는 여전히 0이어야 합니다. `--verify-timeout 30`은 확인 시간을 늘립니다. 이 스크립트는 테마 설정·탭·실행 터미널을 바꾸거나 앱/core를 종료·재시작하지 않습니다. 자기 설치는 `scripts/update_install.py`를 지정하면 `scripts/sixfold/update_install.py`로 복사됩니다. 설치된 사본을 실행할 때에는 `--repo /검토한/worktree`를 명시합니다. 이 방침은 기존 UI 모드·레이아웃 코드 갱신에 적용합니다. 기존 `install_doc_tabs.py`·`install_preview.py`를 별도 실시간 갱신 수단으로 사용하지 말고, 설치 담당자가 배포하는 동안 실제 앱 대상으로 실행하지 않습니다. 해당 도구의 산출물도 별도 준비·검토 후 코드 갱신은 updater로 반영합니다.

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

음성 기능은 `voice/`에 있습니다. `bash voice/install.sh`(처음) 또는 `python3 scripts/update_install.py voice`(업데이트)로 설치하면 선택한 pane만 마이크를 받습니다. 마이크·보정값 같은 개인 값은 각자의 `~/.config/herdr-app/data/sixfold/voice.local.json`에 둡니다. 자세한 내용은 [voice/README.md](voice/README.md)에 있습니다. 음성 연결 종료와 마이크 음소거를 구분하며, 앱이 비활성 상태이면 TUI 포커스를 덮어쓰지 않습니다. 문장 종료 뒤 자동 전송은 음성 플러그인의 기존 규칙을 사용합니다.

메시지 개수는 워크스페이스를 누르지 않아도 0.25초마다 갱신합니다. 저장 내용이 같으면 다시 그리지 않습니다. 에이전트가 작업을 마치거나 해당 pane을 포커스하면 개수가 사라지고, 읽은 위치는 `data/sixfold/messages-read.json`에 저장되어 재시작해도 다시 쌓이지 않습니다. Share→프로젝트 같은 위치 전달과 빈 pane 대체는 [COMMON_ROUTING.md](COMMON_ROUTING.md)를 따르며, `python3 scripts/route.py --enable`로 현재 checkout의 대기열 처리를 연결합니다. Share 알림은 `data/sixfold/alerts.json`을 읽으며 수집기는 별도입니다.

채널 새 메시지는 워크스페이스 제목 아래 별도의 ‘채널 알림’ 줄에 Slack 아이콘으로 표시합니다. 제목 줄의 기존 세션 수·고정핀과 분리합니다. `data/sixfold/project-alerts.json`의 `projects`는 추적할 워크스페이스 이름 배열, `items`는 채널 수집기가 확인한 새 메시지(`id`, `project`, `author`, `text`, `at`, `link`) 배열입니다. 기존 미완료 업무 수와 혼합하지 않으며, 읽음은 `slack-alerts-read.json`에 메시지 ID로 보존합니다. 아이콘을 누르면 해당 워크스페이스의 새 메시지를 확인할 수 있습니다. 멘션 팝업은 `sixfold-slack-inbox` mod이며 `data/sixfold/slack-mentions.json`의 `items`에서 워크스페이스·채널·작성자·내용·원문 링크를 표시합니다. `herdr-app do mod.open '{"name":"sixfold-slack-inbox"}'`으로 열거나 닫습니다. 채널 조회와 집계 시작 시각 관리는 별도 수집기에서 처리합니다.

멘션은 채널과 부모 `thread_ts`(또는 원문 링크의 `thread_ts`)가 같은 스레드끼리 묶고, 워크스페이스별 색상·필터와 미확인 스레드 수를 표시합니다. 기본은 미확인만 보기이며, ‘이 스레드 확인’을 눌러야 팝업의 확인 상태가 저장됩니다. 원문 열기만으로 확인 처리하지 않으며, 새 멘션 답글이 오면 다시 미확인으로 표시합니다. 이 상태는 Slack 앱의 실제 읽음 상태와 별도입니다.

상시 메시지 흐름 목록은 표시하지 않습니다. 파이프 표현·이동 속도·최근 경로는 기존 방식으로 복구했습니다. `보내는 세션 → 받는 세션` 알림은 새 전송 때 약 4초 표시한 뒤 없앱니다. 경로별 색·차선과 같은 경로의 묶음 개수로 동시 전송을 구분합니다. 전달 대기·오류/보류만 하단 상태줄에 해결될 때까지 남기고, 툴팁에 전체 상세를 표시합니다. Motion off에서는 이동 없이 이름 알림만 잠깐 표시합니다. 메시지 패널·일시 표시 방식의 추가 변경은 사용자 확인 대기 상태입니다.

서브에이전트는 부모 에이전트 행의 `▸ N`으로 펼칩니다. 자식이 없어도 부모 행은 유지하며, 실제 위임이 새로 관측되면 자식 목록과 곡선 흐름을 함께 표시합니다. 워크스페이스 제목에는 메시지 합계를 표시하지 않고 에이전트 행에만 개수를 표시합니다.

`scripts/collect_workflow.py`는 Claude 메타데이터, 읽기 전용 Codex DB, hc의 부모 관계로 `data/sixfold/workflow.json`을 만듭니다. `--once`는 한 번 수집하고, 기본 실행은 3초마다 바뀐 내용만 기록합니다. 실행 상태가 명시되지 않은 기록에는 추정 표시가 붙습니다. 첫 시작의 기존 위임은 애니메이션으로 재생하지 않습니다. 이 수집기의 상시 실행 등록은 별도이며, 테마 설치만으로 자동 등록하지 않습니다.

프로젝트 아이콘은 `python3 scripts/set_workspace_icon.py '워크스페이스 ID 또는 정확한 이름' /path/to/icon.png`로 지정합니다. SVG·PNG·JPEG·WebP를 지원하며 `--background '#ffffff'`, 단색 SVG의 `--tint`를 선택할 수 있습니다. 파일은 이 기기의 `data/sixfold/icons/`에 복사하고 설정은 `workspace-icons.json`에 저장합니다. 변경은 테마를 재시작하지 않아도 반영되며 고객 로고 파일은 공개 저장소에 포함하지 않습니다.

## Optional document and usage tools

Separate mod recipes let you place document and usage tools in a personal layout. [Project Document Viewer](extras/preview/README.md) adds saved-file Markdown preview and local HTML snapshots. [System Metrics](extras/system-metrics/RECIPE.md) adds a separate CPU/memory strip. Token history is available from [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights); subscription quotas come from [Usage Bar](https://github.com/berkeatac/herdr-usage-bar). These are optional, separate installs; account quotas are not per-agent token totals.

Independent mod releases: [System Metrics](https://github.com/chanyang721/herdr-workspace-mods/tree/main/system-metrics) · [Project Document Viewer](https://github.com/chanyang721/herdr-workspace-mods/tree/main/document-viewer).

Project document tracking: see [configuration and collector](docs/project-documents.md). The base theme uses full-width terminals; configured latest documents live in the left sidebar.

## 반복 설치와 기기별 고정 설정

`python3 scripts/install.py --home ~/.config/herdr-app --update`는 관리 mod와 helper를 갱신합니다. 개인 `settings.json`·기존 키 섹션·데이터는 보존하며, 직접 수정한 layout/theme도 보존합니다. 이전 설치 manifest가 없는 기존 layout/theme은 사용자 설정으로 취급합니다. mod는 전체 디렉터리를 staging한 뒤 교체합니다. `--update` 없는 첫 설치의 덮어쓰기 거부 동작은 유지합니다.

`python3 scripts/seed_workspace_pins.py --home ~/.config/herdr-app --ensure-spaces`는 고정 설정 파일이 없을 때만 현재 컴퓨터의 Share·PeaceMinusOne·Medihomes를 찾아 실제 ID로 시드합니다. 없는 로컬 워크스페이스는 만들고 원래 선택 화면을 복원합니다. Herdr 앱이 실행 중이어야 하며 기존 `workspace-pins.local.json`은 내용에 관계없이 보존합니다. `--ensure-spaces`를 빼면 없는 워크스페이스를 만들지 않고 오류를 보고합니다. 테스트 시 `HERDR_APP_BIN`으로 앱 실행 파일을 대체할 수 있습니다.

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

세션 연결은 설정 없이도 찾습니다(Claude는 `~/.claude/sessions/<pid>.json`, Codex는 `resume <id>` 인자나
프로세스가 열어 둔 최상위 rollout). 닫기 전에 공간의 에이전트 세션마다 하네스에
`harness.py park --event close_requested`로 맥락(제목·다시 열기 명령·git 브랜치/미커밋/worktree 수)을
기록하고, 기록이 거부되면 닫지 않습니다. 닫은 뒤에는 `closed`를 남깁니다. 하네스 위치는 하네스의
로컬 설정(`harness-local/config.json`의 `repo_path`)에서 찾습니다. 사용자가 apply를 승인한 경우
`--install --enable-apply --user-approved`는 현재 코드의 dry-run 기록 1회만 있으면 전환합니다.

## 대기 세션 절전

`scripts/sleep_idle_sessions.py`는 고정 워크스페이스를 포함해 세션 단위로 봅니다. idle/done이고,
입력창이 비었고, 승인·확인 대기 문구와 음성 수신 표시가 없고, 서브에이전트·명령 프로세스·백그라운드
작업이 없고, 현재 보는 공간·포커스 칸·`exclude_addresses`(기본 `t3`)가 아니며, 그 증거가 20분
(`idle_seconds`) 동안 변하지 않은 세션만 후보입니다. Claude의 회색 입력 제안은 화면 글자만으로 실제
입력과 구분되지 않아 입력이 있는 것으로 보고 유지합니다.

apply에서는 직전 재확인 → 하네스 `park --event suspended` 기록(실패하면 중단) → `/exit` 입력 → 셸 복귀
확인 → 칸에서 `session_sleep_stub.py` 실행 → 라벨 `sixfold.sleep`, 머리줄 `sixfold.title=절전 · …`
순서입니다. 칸은 남습니다. 그 칸에서 Enter를 누르면 같은 세션을 원래 옵션 그대로 이어 열고
(`claude --resume <id>` / `codex … resume <id>`), `hc send`로 메시지가 오면 이어 열면서 그 메시지를
첫 입력으로 넘깁니다. 셸이 메시지를 명령으로 실행하는 일은 없습니다. 자세한 화면·폴더 기록은
`LukukuWatch/session-sleep/notes/`에만 둡니다(하네스에는 허용 목록의 요약만).

`python3 scripts/install_session_sleep.py --install`은 `co.lukuku.sleep-idle-sessions`를 5분 주기
dry-run으로 등록하고, `--install --enable-apply --user-approved`가 apply로 바꿉니다.

## 2026-11-03 설치본 동기화

현재 `layouts/sixfold.json`은 실제 설치된 모니터 줄을 포함합니다. 사용 전 외부 모드 `system-metrics`, `mcp-status`, `agent-usage`, `plan-usage`를 별도 설치해야 합니다([의존성 안내](extras/monitor-layout/README.md)). 이 저장소는 외부 모드의 버전을 고정하거나 자동 설치하지 않습니다.

## 2026-11-04 회사 Mac 설치 동결

`sixfold` 배치는 `system-metrics` 480px, MCP 연결 상태 `mcp-status` 440px, `plan-usage` 450px 순으로 둡니다(서버마다 상태 점·아이콘·짧은 이름 칩, 연결=컬러, 인증 필요·실패·미확인=회색, 툴팁에 이유). System Metrics는 `herdr-workspace-mods`의 `7b81a76` 기준이며, sidebar의 `sixfold.computing.shown`을 따라 현재 컴퓨터만 측정합니다. 원격 컴퓨터 미등록 상태의 로컬 측정과 실제 CPU/RAM 표시를 확인했습니다.

Usage Bar의 초기화권 UI는 이 배치에 추가하지 않습니다. 초기화권은 기존 Plan Usage의 `↺` 한 곳에서 표시합니다. 이번 동결은 System Metrics 설치와 현재 배치의 조합이며, 다른 mod 전체가 원격 main과 일치한다는 뜻은 아닙니다. 설치는 `scripts/update_install.py`의 lock·전체 mod 백업·디렉터리 교체·errors/focus 검증 경로를 사용했습니다. 개인별 영수증과 화면은 로컬 워크스페이스 기록에 보관합니다.
