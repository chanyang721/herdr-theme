# Herdr Theme

여러 프로젝트와 여러 컴퓨터의 코딩 에이전트를 왼쪽 패널 하나에서 살펴보는 Herdr 테마입니다. 모든 워크스페이스와 에이전트, 동시에 오가는 메시지(컴퓨터 사이 전송 포함), 두 대 이상의 컴퓨터에서 함께 작업 중인 프로젝트를 보고, CPU·RAM, MCP 연결, 계정 CLI, 요금제 한도, 세션별 토큰 사용량을 현재 터미널을 떠나지 않고 확인합니다.

![Windows의 Herdr Theme: 컴퓨터 두 대, Storefront 공동 작업, 모니터 줄](preview.gif)

[English](README.md)

반복 GIF와 스크린샷은 Windows 11 실제 앱의 데모 워크스페이스를 담았습니다. 두 번째 컴퓨터 "worker"와 그 사이드바 데이터(전송 이벤트 포함)만 합성이고, 모니터 줄은 이 기기의 실제 값입니다. 12초 반복 영상에서 전송이 협업 테두리 혜성으로 이어졌다가 숨쉬기로 돌아옵니다. [정지 이미지](preview.png).

## 구성

Herdr Theme은 레이아웃과 사이드바입니다. 설치기는 [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)를 고정된 버전으로 함께 설치하므로 모니터 줄이 바로 동작합니다. 저장소는 둘이지만 설명은 이 README 하나에 모았습니다.

| 부분 | 보여 주는 것 |
| --- | --- |
| 사이드바(이 저장소) | 컴퓨터별 상태, 워크스페이스와 에이전트, 미확인 메시지, 전송 애니메이션, 컴퓨터 간 공동 작업, 서브에이전트 트리 |
| [System Metrics](#system-metrics) | CPU·RAM과 최근 표본 막대 |
| [MCP Status](#mcp-status) | MCP 서버별 연결 상태(Claude·Codex 합침) |
| [CLI Status](#cli-status) | AWS 프로필·GitHub·kubectl·Docker 로그인 상태 |
| [Plan Usage](#plan-usage) | Codex·Claude 5시간/7일 한도, Codex 한도 초기화 |
| [Agent Usage](#agent-usage) | 실행 중인 Claude·Codex 세션별 토큰 사용량, 칸 머리줄의 모델·이번 주 비중 |
| [Document Viewer](#document-viewer)(선택) | 터미널 옆 프로젝트 파일과 Markdown |

## 운영체제별 지원

2026-11-04 Windows 11에서 각 부분을 직접 실행해 확인했습니다. 테마는 macOS에서 만들어졌습니다.

| 부분 | macOS | Windows |
| --- | --- | --- |
| 사이드바·컴퓨터 목록·메시지 흐름·공동 작업 표시 | 됨 | 됨 |
| System Metrics·MCP Status·CLI Status·Plan Usage·Agent Usage | 됨 | 됨 |
| 워크플로 수집기(서브에이전트 트리) | 됨 | 됨(아래 작업 스케줄러 예시) |
| Document Viewer: Markdown | 됨 | 됨 |
| Document Viewer: HTML 미리보기 | 됨(WebKit 스냅숏) | 안 됨 — 소스로 열리고, HTML 탭에 macOS가 필요하다는 안내 |
| Document Viewer: 저장하면 자동 새로고침 | 됨 | 됨 |
| 음성 | 됨 | 안 됨(설치기가 건너뜀) |
| 실시간 TUI 연결 | 됨(Linux도) | 안 됨(`termios` 필요) |
| 대기 세션 절전·끝난 워크스페이스 정리 | 됨(LaunchAgent) | 안 됨 |

Linux는 따로 적은 곳 외에는 macOS와 같지만 이번 버전에서 확인하지는 않았습니다.

## 요구 사항

- Herdr 앱 0.1.11 이상, Python 3, Git. 컴퓨터 목록과 원격 워크스페이스는 머신 레이아웃을 지원하는 앱·코어가 필요합니다(0.1.17에서 확인).
- 메시지 애니메이션에는 네이티브 메시지 이벤트가 필요합니다: `messageEvents()`를 제공하는 앱과 `message_sent`를 내보내는 코어. 정식 릴리스에 들어가기 전까지는 둘 다 소스에서 빌드합니다. 앱은 [`feat/message-sent-events`](https://github.com/chanyang721/herdr-app/tree/feat/message-sent-events) 브랜치, 코어는 [herdrdev/herdr-core#90](https://github.com/herdrdev/herdr-core/pull/90)입니다. 앱과 코어를 함께 설치하고, 전송을 보고 싶은 모든 컴퓨터의 코어를 교체하세요(메시지를 전달하는 쪽 코어가 이벤트를 냅니다). 없어도 나머지는 동작하고 전송 애니메이션만 나오지 않습니다.
- Agent Usage는 [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights) mod의 로컬 저장소를 읽습니다(따로 설치, Node.js 필요).

## 설치

macOS / Linux:

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
python3 scripts/install.py
herdr-app do layout.switch --name sixfold
```

Windows(PowerShell, Python 실행기):

```powershell
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
py -3 scripts/install.py
herdr-app do layout.switch --name sixfold
```

설치기가 하는 일:

- 테마의 mod·레이아웃·팔레트·도우미 스크립트를 앱 홈에 설치합니다(모든 운영체제에서 `~/.config/herdr-app`, `HERDR_APP_HOME`으로 변경 가능).
- [`workspace-mods.lock.json`](workspace-mods.lock.json)에 고정된 커밋의 Herdr Workspace Mods를 `~/.local/share/herdr-sixfold/vendor/herdr-workspace-mods/<커밋 앞 12자>`(커밋마다 폴더 하나, 받기에 성공했을 때만 생김)으로 받아 정확히 그 커밋이고 로컬 변경이 없는지 확인한 뒤 그 커밋이 추적하는 파일로 `system-metrics`, `mcp-status`, `cli-status`, `plan-usage`, `agent-usage`를 테마와 함께 설치합니다. 설치한 버전은 `data/sixfold/workspace-mods.json`에 기록합니다.
- Files 패널이 있는 레이아웃이 있으면(Herdr를 처음 켜면 `main`이 생김) Document Viewer 자체 설치기를 실행하고, 없으면 나중에 실행할 명령을 출력합니다. macOS가 아니면 Markdown만 설치합니다.
- 이미 있는 파일이나 `layout:sixfold` 키 섹션은 덮어쓰지 않고 다른 레이아웃·설정·단축키는 보존합니다. `--update`는 전에 설치한 것을 갱신하되 직접 바꾼 레이아웃·팔레트는 그대로 둡니다.

옵션: `--without-workspace-mods`는 테마만 설치합니다(이때 `sixfold` 레이아웃의 모니터 줄 mod는 따로 설치해야 함). `--workspace-mods-source 경로`는 받지 않고 이미 고정 커밋에 있는 로컬 checkout에서 설치합니다. 넓은 화면에서는 `sixfold` 레이아웃이 모니터 줄을 한 줄로 두고, 작은 Windows 창에서는 스크린샷처럼 [`extras/windows-layout`](extras/windows-layout/README.md)의 두 줄 배치를 씁니다.

### 설치본 갱신

첫 설치 이후에는 **`scripts/update_install.py`만 씁니다. 실행 중인 앱에 파일을 직접 복사하지 않습니다.** 검토한 테마 파일을 지정하면 같은 실행에서 Workspace Mods도 고정 버전으로 맞춥니다(내용이 같은 파일은 건너뛰어 불필요한 재로드가 없음).

```sh
python3 scripts/update_install.py mods/sixfold-desk/main.js mods/sixfold-desk/model.js
python3 scripts/update_install.py            # Workspace Mods만 고정 버전으로 맞춤
```

(Windows는 `py -3`.) `--without-workspace-mods`는 Workspace Mods를 그대로 두며, `voice`만 지정한 실행은 건드리지 않습니다.

updater는 `data/sixfold/install.lock`을 잡고, 바뀌는 mod 전체를 `mods/` 밖에 만들어 각각 `herdr-app check`로 검사하고, `backups/sixfold-update-*/`에 전체 백업을 둔 뒤 mod 폴더를 교체합니다. macOS·Linux는 원자적으로 교환하고, Windows는 디렉터리 교환이 없어 그 순간 mod 경로가 잠깐 비며 실패하면 설치본을 되돌립니다. 이후 `status.errors`가 1초간 비어 있고 워크스페이스·탭·포커스가 그대로여야 통과하고, 아니면 되돌립니다(그 사이 다른 작성자의 변경은 보존하고 보고). 결과는 백업의 영수증에 남습니다. `status` 통과는 화면 확인이 아니므로 `herdr-app shot`도 보세요.

파일은 하나씩이 아니라 한 번에 묶어 설치하세요. 교체마다 mod가 다시 로드되고 잦은 재로드는 앱을 지치게 할 수 있습니다. 편집 세션마다 별도 git worktree를 쓰고 한 세션만 검토된 결과를 설치합니다. **설치된 mod를 `mods/*-recovery`로 복사하지 마세요.** `--allow-unhealthy-before`는 승인된 복구에서 시작 오류만 허용하고(최종 오류는 0이어야 함), `--verify-timeout 30`은 확인 시간을 늘립니다. updater는 Herdr나 herdr-core를 종료·재시작하지 않습니다. `scripts/sixfold/`에 설치된 사본을 실행할 때는 `--repo /검토한/worktree`를 줍니다.

## 단축키

`sixfold` 레이아웃을 쓸 때만 적용되며 다른 Herdr 단축키는 그대로입니다.

| 키(macOS) | 동작 |
| --- | --- |
| Cmd+[ / Cmd+] | 같은 탭의 이전·다음 pane |
| Cmd+Option+1…6 | 번호로 pane 선택 |
| Ctrl+Shift+방향키 | 이웃 pane으로 이동 |
| Cmd+Shift+↑ / ↓ | 이전·다음 워크스페이스 |
| Cmd+Shift+J / U | 다음 승인 대기·완료 에이전트 |
| Ctrl+Shift+N | 선택한 컴퓨터에 새 워크스페이스 |
| Cmd+R | 탭 이름 바꾸기 |
| Cmd+X | 앱 pane 닫기 |
| Cmd+W / Cmd+Shift+W | 실수로 닫지 않도록 아무 동작 안 함 |

Windows·Linux에서는 `keys.json`의 레이아웃 전용 조각을 키보드에 맞게 고쳐 쓰세요.

## 컴퓨터와 원격 에이전트

사이드바에는 이 컴퓨터와 `hc machine`으로 등록한 컴퓨터가 나옵니다. 컴퓨터를 고르면 그 컴퓨터의 워크스페이스·에이전트와 승인 대기·완료 이동만 보이고, 돌아오면 마지막 워크스페이스를 엽니다. 목록은 포커스를 따라갑니다. 다른 컴퓨터의 세션으로 포커스를 옮기면 목록이 그 컴퓨터로 바뀌고, 직접 고른 것은 포커스가 다시 움직일 때까지 유지합니다. 컴퓨터 선택은 터미널 포커스를 옮기거나 연결을 시작하지 않습니다.

컴퓨터 행에는 작업 중·완료·승인 대기 수(0이 아닌 것만, 툴팁에 전체)와 **최근 10분**간 다른 컴퓨터로 보낸·받은 전송 수 ↑N ↓N이 나옵니다.

이 컴퓨터와 연결됨·연결 중인 컴퓨터만 기본으로 보이고, 끊긴 원격과 등록되지 않은 Tailscale 기기는 **COMPUTERS** 옆 화살표로 펼쳐야 보입니다. **+ Space**와 **Ctrl+Shift+N**은 선택한 컴퓨터에 워크스페이스를 만듭니다. 이 컴퓨터에서는 조정용 Claude 세션 1개, 원격에서는 그 컴퓨터 홈(또는 설정한 폴더)의 터미널 하나입니다.

메인에서 `hc ls`의 주소로 `hc send worker/t7 "메시지"`를 보냅니다. 전송 성공이 읽음 확인은 아닙니다. SSH·Tailscale·방화벽·에이전트 인증은 테마가 설정하지 않습니다.

### 컴퓨터 간 공동 작업

워크스페이스 이름이 같으면 같은 프로젝트로 봅니다. 이름 끝 `(컴퓨터명)`이 그 워크스페이스가 있는 컴퓨터를 가리키면 무시합니다(`worker`의 `Docs (worker)` = 이 컴퓨터의 `Docs`). 이름 없는 워크스페이스(`~`)는 제외합니다.

- **상대 컴퓨터는 항상 표시:** 다른 컴퓨터에도 같은 프로젝트의 워크스페이스가 있으면 작업 중이 아니어도 머리줄에 14px 컴퓨터 아이콘과 12px 상대 이름이 나옵니다. 상대가 여럿이면 `worker +1`처럼 표시하고, 툴팁에는 모든 상대와 각각의 작업 중 에이전트 수가 나옵니다. 기본 협업색은 다크 테마 `#A9B8FF`, 라이트 테마 `#3346B8`의 연보라색이며, 머리줄 위 글자 대비가 최소 4.5:1이 되도록 보정합니다(win98은 `#3043AF`).
- **지금 함께 작업 중:** 이 컴퓨터와 상대 한 대 이상에서 같은 프로젝트의 에이전트가 모두 작업 중이면 워크스페이스에 **2px 실선 외곽선·10% 틴트·윗변의 채운 ⇄ 배지**가 나옵니다. `⇄2`, `⇄3` …은 함께 작업 중인 다른 컴퓨터 수입니다. 기존 상자 위에 그려 배치는 밀리지 않습니다. 공동 작업이 끝나면 평소 표시로 돌아가며 상대 이름은 남고, motion on에서는 배지가 서서히 사라집니다.
- **테두리 흐름:** 공동 작업 중에는 외곽선이 천천히 숨쉬듯 밝아졌다 어두워집니다. 그 묶음의 컴퓨터 사이에 전송이 생기면 패킷 이동 1.6초 뒤 워크스페이스 테두리를 도는 혜성으로 이어집니다. 한 바퀴 3.6초로 두 바퀴 돈 뒤 다시 숨쉬기로 돌아옵니다. 활성 묶음의 외곽선·배지·컴퓨터 행 파이프는 테마에 맞춘 네 가지 색 중 하나를 쓰며, 숨쉬기 주기도 서로 다릅니다. 네 묶음을 넘으면 색을 다시 쓰고, 혜성은 한 번에 최대 세 묶음에 표시합니다. **Motion off**면 테두리는 정지하고, 공동 작업이 끝나면 애니메이션도 사라집니다.
- **짝 찾기:** 워크스페이스에 마우스를 올리면 상대 컴퓨터 행에 외곽선과 틴트가 생기고, 컴퓨터 행에 올리면 그 컴퓨터와 짝인 워크스페이스가 강조됩니다. 머리줄의 상대 이름과 공동 작업 표시는 컴퓨터 목록 파이프의 최대 4개 제한과 무관합니다. 주황색 needs-you·승인 대기 표시는 그대로 보입니다.

컴퓨터 목록에는 별도로 오른쪽 고정 여백에 직각 점선 파이프가 최대 4개 그려집니다. 함께 작업 중인 컴퓨터를 잇거나, 전송을 주고받은 컴퓨터 쌍을 **마지막 전송 뒤 5분** 동안 잇습니다. ↑/↓ 수는 계속 **최근 10분** 기준입니다. 공동 작업 표시는 같은 프로젝트의 동시 활동, 전송 연결은 전송 이벤트를 나타내며, 어느 쪽도 특정 메시지가 전달되거나 읽혔다는 증거는 아닙니다.

| 공동 프로젝트 1개 · 다크 | 공동 프로젝트 1개 · 라이트 |
| --- | --- |
| ![다크 테마의 Storefront 공동 프로젝트 1개](docs/images/collab-single-dark.png) | ![라이트 테마의 Storefront 공동 프로젝트 1개](docs/images/collab-single-light.png) |

| 여러 프로젝트 묶음 · 다크 | 여러 프로젝트 묶음 · 라이트 |
| --- | --- |
| ![다크 테마의 여러 공동 프로젝트와 유휴 Notes 상대 표시](docs/images/collab-multi-dark.png) | ![라이트 테마의 여러 공동 프로젝트와 유휴 Notes 상대 표시](docs/images/collab-multi-light.png) |

Windows 11 실제 앱에서 `sixfold-night`·`sixfold-day`와 데모 워크스페이스로 테두리 흐름 도중 촬영했습니다. `worker` 컴퓨터와 그 사이드바 데이터(전송 이벤트 포함)만 합성입니다. 여러 묶음 화면에서 Notes는 상대 워크스페이스가 있지만 공동 작업 중은 아니므로, 머리줄의 상대 이름만 남고 활성 테두리·배지는 없습니다.

### 컴퓨터 사이 전송

양 끝이 다른 컴퓨터인 전송은 보이는 행에서 워크스페이스 목록 맨 위까지 파이프를 그립니다. 상대 컴퓨터 행은 경로 색으로 빛나며 ⇡(보냄)·⇣(받음)을 표시하고, 하단 줄에 상대 컴퓨터 이름의 ⇄ 칩이 붙습니다. 끝점의 컴퓨터는 터미널 주소(`machine/` 앞부분)로 정하므로 화면에 없는 원격 터미널도 포함됩니다.

### 이름·폴더·탐색

표시 이름과 기본 폴더는 이 컴퓨터의 `~/.config/herdr-app/data/sixfold/computers.local.json`에만 둡니다.

```json
{
  "local": { "label": "집" },
  "machines": {
    "worker": { "label": "빌드 컴퓨터", "folder": "/home/user/projects" }
  }
}
```

키는 `hc machine ls`의 이름입니다. 파일이 없으면 기본 이름(이 컴퓨터는 "This computer", macOS는 "This Mac")을 씁니다. 같은 파일의 `"tailscale": true`는 15초마다 이 컴퓨터의 `tailscale status --json`으로 Tailscale 기기를 보여 주며, 이 행으로는 아무것도 열 수 없고 "온라인"이 SSH·Herdr 접속 가능을 뜻하지 않습니다. 원격 등록에는 비대화형 SSH(또는 바이트를 보존하는 `--via` 명령)와 대상의 호환 `hc`가 필요합니다. Windows 대상은 OpenSSH Server·키 인증·Tailscale 주소로 좁힌 TCP 22 규칙을 켠 뒤 `hc machine add user@TAILSCALE_IP --name HOST`로 등록합니다.

## 메시지 흐름

상시 메시지 패널은 없습니다. 새 전송은 `보낸 쪽 → 받는 쪽` 알림을 약 4초 표시하고, 경로별 색·차선으로 동시 전송을 구분하며, 같은 경로의 반복 전송은 패킷을 따로 두고 묶음 개수를 표시합니다. 대기·오류·보류는 해결될 때까지 하단 줄에 남습니다. motion off에서는 이동 효과가 없습니다.

전송은 앱 메모리의 `messageEvents()`에서 읽습니다([요구 사항](#요구-사항) 참고). 이벤트에는 보낸 쪽·받는 쪽·시각·관측된 `started` 결과만 있고 본문은 없습니다. 코어 CLI로 직접 보냅니다: `hc send 대상 "메시지"`.

**이전 추적 실행기 제거.** 예전의 Python 실행기는 제거했습니다. 설치했었다면 PATH에서 `~/.local/share/herdr-sixfold/bin`을 빼고 `hc_trace.py` 호출을 멈추고, `hc`가 코어 CLI를 가리키는지 확인하고(`Get-Command hc -All` / `command -v hc`), 실행기를 가리키는 `~/.local/bin/hc` 심볼릭 링크를 되돌리고, `~/.local/share/herdr-sixfold/` 아래의 `hc_trace.py`, `bin/hc`, `bin/hc.cmd`를 지우고, 설치된 `route.py`와 `collect_workflow.py`를 갱신하세요.

## 서브에이전트 트리와 워크플로 수집기

서브에이전트는 부모 행의 `▸ N`으로 펼치고, 새 위임이 생기면 트리를 펼치며 흐름을 보여 줍니다. `scripts/collect_workflow.py`는 Claude 메타데이터·읽기 전용 Codex DB·hc 부모 관계로 `data/sixfold/workflow.json`을 만듭니다(`--once`, 또는 3초마다 바뀐 것만 기록). macOS·Linux·Windows에서 동작하며 Windows에서는 콘솔 창을 띄우지 않습니다.

첫 설치에는 수집기가 없고 백그라운드 등록도 하지 않습니다. updater로 설치합니다(`python3 scripts/update_install.py scripts/collect_workflow.py`, Windows는 `py -3`). Windows에서는 로그온 때 창 없이, 한 번에 하나만 실행할 수 있습니다.

```powershell
$pyw = Join-Path (Split-Path (py -3 -c "import sys; print(sys.executable)")) 'pythonw.exe'
$home_ = "$HOME\.config\herdr-app"
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$home_\scripts\sixfold\collect_workflow.py`"" -WorkingDirectory $home_
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Herdr Theme workflow collector'
```

해제는 `Stop-ScheduledTask` 후 `Unregister-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Confirm:$false`입니다.

## Workspace Mods

[Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)에서 오며 테마와 함께 설치됩니다. 각각 단독으로도 쓸 수 있습니다(그 저장소 참고). 모니터 줄의 도우미는 mod가 실행하는 Python 스크립트이며 Windows에서는 콘솔 창 없이 돌고, 눌러서 복사는 `Set-Clipboard`(macOS `pbcopy`, Linux `wl-copy`/`xclip`)를 씁니다.

### System Metrics

![System Metrics](docs/images/system-metrics.png)

사이드바가 보여 주는 컴퓨터의 CPU·RAM과 최근 표본 막대를 몇 초마다 갱신합니다. 원격 컴퓨터는 그 컴퓨터의 `hc`로 읽습니다. 읽지 못한 값은 0이 아니라 없음으로 표시합니다.

### MCP Status

![MCP Status](docs/images/mcp-status.png)

`claude mcp list`(와 `codex mcp list`, 이름으로 합침)의 MCP 서버마다 상태 점·서비스 색 배지·짧은 이름의 칩 하나. 초록=연결됨, 주황 고리=로그인·승인 필요, 빨강=실패, 회색=미확인. 3분마다 확인하고 서버가 끊기면 30초·1·2·5분 뒤 다시 확인하며, 툴팁에 끊긴·회복 시각과 `/mcp`가 필요할 수 있는 실행 중 Claude 세션 수가 나옵니다. 칩을 누르면 인증 절차(`/mcp` 또는 `codex mcp login <이름>`)를 복사할 뿐 스스로 로그인하지 않습니다. 이름·아이콘·숨김은 `data/sixfold/mcp-status.local.json`에서 정합니다. 블록이 좁아 서버가 다 들어가지 않으면 확인이 필요한 서버부터 들어가는 만큼 보여 주고, 나머지는 `+N` 칩으로 세며 툴팁에 이름이 나옵니다.

### CLI Status

![CLI Status](docs/images/cli-status.png)

AWS 프로필(AWS CLI가 있을 때 프로필마다), GitHub(`gh auth status`, 호스트별 계정 수), kubectl 컨텍스트(클러스터에 접속하지 않음), Docker 데몬을 각진 칩으로 보여 줍니다. 로그인·실행 중이면 컬러, 만료·없음·꺼짐이면 흑백입니다. 4분마다 확인하고 끊기면 같은 방식으로 다시 확인하며, 누르면 로그인 명령을 복사합니다. 토큰·사용자 이름·전체 계정 ID는 남기지 않습니다. 보여 줄 항목은 `data/sixfold/cli-status.local.json`에서 고릅니다.

### Plan Usage

![Plan Usage](docs/images/plan-usage.png)

Codex·Claude 한도를 브랜드 아이콘·막대·백분율로: 5시간·7일 창, 제공자가 알려 주면 모델별 주간 창(`Fable 7d`), Codex 한도 초기화 남은 횟수 `↺ N`과 확인 후 사용하는 버튼. Codex 워크스페이스의 크레딧 소진·지출 한도 도달은 개인 한도가 낮아 보여도 표시합니다. 2분마다 갱신하고, 제공자가 확인 요청을 제한하면 다음에 읽힐 때까지 오류를 표시합니다.

### Agent Usage

![Agent Usage](docs/images/agent-usage.png)

코어가 알려 주는 실행 중 Claude·Codex 세션마다 토큰 사용량을 워크스페이스별로: 세션 합계, 비캐시 입력·출력·캐시, 이번 주 비중, 모델. Windows에서는 Claude는 `~/.claude/sessions/<pid>.json`, Codex는 그 프로세스가 열어 둔 rollout 파일로 터미널과 세션을 맞추며, 맞추지 못한 세션은 0이 아니라 `—`입니다. Insights 저장소(최대 5분마다 갱신)가 필요하고, 오버레이가 아니라 레이아웃의 칸으로 둡니다. 테마의 칸 머리줄에는 같은 세션의 모델·속도·effort·권한 모드·이번 주 비중이 나옵니다.

![칸 머리줄](docs/images/pane-header.png)

### Document Viewer

![Document Viewer](docs/images/document-viewer.png)

프로젝트 파일 트리와 미리보기 패널. Markdown(macOS에서는 이미지·PDF·로컬 HTML을 읽기 전용 WebKit 스냅숏으로도)을 Source·Open과 함께 보여 줍니다. Files 패널이 있는 레이아웃에 설치되고 검토한 원본(Preview Plus / Files Plus)을 고정 커밋으로 받습니다. Windows에서는 HTML이 소스로 열리고 HTML 탭에 macOS 렌더러가 필요하다는 안내가 나오며, Markdown 미리보기와 저장 시 새로고침은 됩니다.

## 사이드바의 다른 기능

**워크스페이스 배지.** 다른 mod·도구가 공유 상태 `sixfold.workspace.badges`나 `data/sixfold/workspace-badges.json`으로 워크스페이스 이름 옆에 작은 배지를 4개까지 올릴 수 있습니다.

```json
{ "<machine>|<space id>": [ { "id": "open", "text": "! 2", "tone": "blocked", "tooltip": "열린 항목 2개",
  "open": { "mod": "my-mod", "props": { "x": 1 }, "kind": "window", "key": "my-mod-x", "width": 800, "height": 600 } } ] }
```

이 컴퓨터의 `<machine>`은 빈 문자열입니다. 색조: `blocked`, `working`, `done`, `accent`, `dim`. 누르면 `open`을 그 mod의 오버레이로 열거나 `command`를 실행합니다. 글자는 12자까지, 잘못된 항목은 무시하며 공유 상태가 파일보다 우선합니다. 테마 자체는 배지를 올리지 않습니다.

**질문·권한 카드.** 선택 설치하는 로컬 브리지가 있으면(`data/sixfold/harness-local/config.json`의 `repo_path`) 에이전트가 기다리는 프롬프트(권한 요청·질문·계획)가 알림 위에 카드로 나오고, 그 세션 줄에 `?`가 붙습니다. **허용**·**거부**·선택지는 그 카드의 1회용 토큰(`<token_dir>/<id>.token`, 답할 때만 읽음)으로 `harness.py asks answer <id> --allow|--deny --token T [--choice "질문=선택"]`을 실행하고, 목록과 `token_dir`는 `harness.py asks --json`에서 읽습니다. 터미널 프롬프트도 동시에 쓸 수 있습니다. 브리지가 없으면 카드는 나오지 않습니다.

**채널 알림.** `data/sixfold/project-alerts.json`의 새 채널 메시지는 워크스페이스 제목 아래 줄에 나오고, `sixfold-slack-inbox` mod는 `data/sixfold/slack-mentions.json`의 멘션을 스레드별로 보여 줍니다. Slack에서 모으는 일은 별도 도구가 합니다.

**분할과 새 워크스페이스.** `scripts/balance_grid.py`는 아무것도 재시작하지 않고 6개 터미널 탭을 같은 크기로 맞추고, `scripts/workspace.py "Example" /path`는 **+ Space**처럼 워크스페이스를 만듭니다(`--shells`는 셸만, `--tiers high`는 그 한 칸을 해당 난이도의 모델로 엽니다. `scripts/model_tier.py` 참고).

**고정 표시·아이콘·로컬 설정.** `data/sixfold/workspace-pins.local.json`(`{"spaces":[{"id":"…","machine":null}]}`)은 정확히 그 워크스페이스에 핀과 강조 테두리를 붙입니다. `scripts/set_workspace_icon.py 'ID 또는 이름' icon.png`는 프로젝트 아이콘(SVG/PNG/JPEG/WebP)을 지정합니다. 사람마다 다른 이름·색·폴더·Slack 주소는 `data/sixfold/site.local.json`(`config/site.example.json`에서 시작)에 두며, `"pane_header_index": true`는 칸 번호를 다시 보여 줍니다. `*.local.json`은 git이 무시합니다.

**macOS 전용.** 대기 세션 절전과 끝난 워크스페이스 목록은 두 LaunchAgent 관찰기(`install_session_sleep.py`, `install_space_cleanup.py`)가 하며, apply를 켜기 전까지는 기록만 합니다. 워크스페이스는 `space_close_enabled: true`를 직접 넣기 전에는 닫지 않습니다. 하네스로 끝난 세션(최종 보고 확인)의 칸은 같은 탭에 다른 칸이 남을 때 닫고(`close_finished_panes`, 기본 켜짐), 공간마다·탭마다 최소 1칸은 남깁니다. Share(`user_controlled_names`, 기본 Share)는 사용자가 직접 다루는 곳이라 절전·정리 보고 요청·칸 정리·닫기를 하지 않습니다. `trim_fixed`에 적은 고정 워크스페이스(ProjectA·ProjectB)는 1칸만 남기고(`keep_addresses`에 적은 칸, 없으면 작업 중인 에이전트 칸, 없으면 살아 있는 에이전트 칸 중 가장 최근에 쓴 칸, 그것도 없으면 잠든 에이전트 칸) 나머지를 정리합니다. 남길 칸은 에이전트 칸만 될 수 있어, 셸 칸만 있는 공간은 남길 칸이 없다고 기록하고 정리하지 않습니다. 남길 칸은 바로 지시를 받을 수 있게 재우지 않고, 잠들어 있으면 같은 세션으로 깨웁니다(절전 화면에 Enter. 입력·포커스 등 보호 조건이 있거나 절전 티켓이 새 세션을 여는 것이면 깨우지 않음. 깨운 뒤 세션 id가 절전 전과 다르면 wake_mismatch로 기록하고 깨운 것으로 치지 않음). 에이전트 칸은 정리 보고 요청→수락→보관 뒤 닫고, 제한 시간 안에 보고가 없으면 lifecycle 기록과 세션 id만 남기고 닫습니다. 잠든 칸은 대기 화면에 입력이 없을 때 기록과 함께 닫습니다. 에이전트 없는 셸 칸은 보내지 않은 입력을 확실히 가를 수 없어 닫지 않습니다(판정할 수 없으면 닫지 않음). Herdr TUI에 붙은 연결 칸(`tui_bridge.py`)은 Share에만 있어 항상 유지합니다(재우지도, 닫지도 않음). 조회가 실패하거나 시간을 넘긴 칸·공간과 시작 목록 조회에 실패해 건너뛴 주기는 판단을 보류합니다: 그 칸은 유지하되 대기 시간 계산(`since`)은 그대로 두고, 실제 화면·상태가 바뀌었을 때만 처음부터 셉니다(두 관찰기 공통). 작업 중·입력 있음·음성·결정 대기·포커스·백그라운드 작업 칸은 그대로 유지하고, 다른 컴퓨터의 칸은 건드리지 않습니다. 관찰기 사본을 바꾸는 설치(`update_install.py`, `install_*.py --refresh`)는 그 소스 커밋의 하네스 교차 검수가 PASS이거나 설치·실동작 확인만 남은 CONDITIONAL이면 새 사본 해시를 승인(actor auto-policy, 근거는 설정의 `reviewed_by_policy`)하고, 그 밖에는 승인 없이 기다립니다. 이전 사본의 승인은 새 사본으로 이어지지 않습니다. 실시간 TUI 연결(`scripts/tui_bridge.py`, Linux도)은 기존 Herdr TUI 칸을 가져오지 않고 연결합니다. [`voice/`](voice/README.md)의 음성 플러그인은 포커스된 칸만 녹음합니다.

공용 워크스페이스와 프로젝트 칸 사이 메시지 전달: [COMMON_ROUTING.md](COMMON_ROUTING.md). 과부하 때의 협업: [docs/overload-collaboration.md](docs/overload-collaboration.md). 프로젝트 문서 추적: [docs/project-documents.md](docs/project-documents.md).

## 실행하는 것

UI는 Herdr의 워크스페이스·에이전트 API만 쓰고 자체 네트워크 요청을 하지 않습니다. 도우미는 이 컴퓨터의 `hc`, `herdr-app`, Python, 계정 CLI를 실행하고, 설치기는 고정 버전을 받기 위해 Git을 실행합니다. 개인 설정·계정 정보·세션 대응표는 이 저장소에 두지 않습니다.

## 개발

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
```

클론마다 한 번 `sh scripts/install-git-hooks.sh`를 실행하면 `git push` 전에 `npm test`와 `node --check`가 먼저 돌고, 실패하면 push가 멈춥니다(일부러 건너뛸 때는 `git push --no-verify`). macOS 음성 테스트는 push마다가 아니라 수동 또는 주 1회(`Voice (macOS)` 워크플로) 돕니다.

`herdr-app check`는 mod 옆에 `gpui-kit.d.ts`와 `jsconfig.json`을 만듭니다. 커밋하지 마세요. 레이아웃 변경은 테스트만이 아니라 실제 화면으로 확인합니다. 더 새 Workspace Mods로 옮기려면 `workspace-mods.lock.json`의 `commit`(과 `tag`)을 바꾸고 updater를 실행합니다. 작업은 `main`에서 짧은 브랜치로 하며 설치본은 `main`을 따릅니다. 디자인 명세는 [RECIPE.md](RECIPE.md). Apache-2.0.
