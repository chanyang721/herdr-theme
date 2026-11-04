# Herdr Theme

여러 프로젝트와 여러 컴퓨터의 코딩 에이전트를 왼쪽 패널 하나에서 살펴보는 Herdr 테마입니다. 모든 워크스페이스와 에이전트의 상태, 동시에 오가는 메시지(컴퓨터 사이 전송 포함), 두 대 이상의 컴퓨터에서 함께 작업 중인 프로젝트, 서브에이전트 관계를 현재 터미널을 유지한 채 확인합니다.

![Herdr Theme](preview.png)

[English](README.md)

## 주요 기능

| 기능 | 쓰임 |
| --- | --- |
| 컴퓨터 목록과 컴퓨터별 워크스페이스 | 컴퓨터를 고르면 그 컴퓨터의 프로젝트와 에이전트만 봅니다. 다른 컴퓨터의 세션으로 포커스를 옮기면 목록도 그 컴퓨터로 바뀝니다. |
| 컴퓨터별 상태 | 컴퓨터 행마다 작업 중·완료·승인 대기 에이전트 수와 최근 10분간 다른 컴퓨터로 보낸·받은 전송 수(↑/↓)를 표시합니다. |
| 컴퓨터 간 협업 | 한 프로젝트에 두 대 이상의 컴퓨터에서 작업 중인 에이전트가 있으면 차분한 직각 점선 파이프로 잇고 워크스페이스 테두리에 ⇄를 표시합니다. 함께 하던 작업이 끝나면 사라집니다. |
| 동시 메시지 경로 애니메이션 | 실제로 성공한 전송을 따라갑니다. 여러 에이전트, 같은 경로의 반복 전송, 다른 컴퓨터와의 전송을 구분합니다. |
| 실시간 상태와 에이전트별 미확인 메시지 | 어느 에이전트가 작업 중인지, 기다리는지, 결정이 필요한지 봅니다. |
| 서브에이전트 트리 | 위임 관계와 상태 출처를 펼쳐 봅니다. 추정 활동은 따로 표시합니다. |
| 워크스페이스 배지 | 다른 mod·도구가 워크스페이스 이름 옆에 누를 수 있는 작은 배지를 표시할 수 있습니다. |
| 프로젝트 아이콘·색·그룹 테두리 | 프로젝트별 에이전트를 한눈에 구분합니다. |
| 포커스 유지 | 메시지나 상태 변화가 현재 입력 위치를 옮기지 않습니다. |

한국어/영어 표시, 밝은/어두운 팔레트, 키보드 이동, 드래그 정렬도 제공합니다. 현재 탭의 분할 구조를 그대로 쓰며, 기본 6분할은 그중 한 가지 배치입니다.

공개 미리보기는 데모 프로그램으로 촬영했습니다. 실제 프로젝트·대화·사용량은 담기지 않습니다.

## 요구 사항

- Herdr 앱 0.1.11 이상과 Python 3. 컴퓨터 목록과 원격 워크스페이스는 머신 레이아웃을 지원하는 앱·코어가 필요합니다(0.1.17에서 확인).
- 메시지 애니메이션에는 네이티브 메시지 이벤트가 필요합니다: `messageEvents()`를 제공하는 앱과 `message_sent`를 내보내는 코어. 정식 릴리스에 들어가기 전까지는 둘 다 소스에서 빌드합니다. 앱은 [`feat/message-sent-events`](https://github.com/chanyang721/herdr-app/tree/feat/message-sent-events) 브랜치, 코어는 [herdrdev/herdr-core#90](https://github.com/herdrdev/herdr-core/pull/90)입니다. 앱과 코어를 함께 설치하고, 전송을 보고 싶은 모든 컴퓨터의 코어를 교체하세요(이벤트는 메시지를 전달하는 쪽 코어가 내보냅니다). 없어도 나머지 기능은 그대로 동작하고 전송 애니메이션만 나오지 않습니다.
- macOS·Linux·Windows. 음성과 HTML 문서 스냅숏은 macOS 전용, 실시간 TUI 연결은 macOS/Linux 전용입니다.

## 설치

macOS / Linux:

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
python3 scripts/install.py
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
herdr-app do layout.switch --name sixfold
```

Windows (PowerShell, Python 실행기 `py` 사용):

```powershell
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
py -3 scripts/install.py
herdr-app check "$HOME\.config\herdr-app\mods\sixfold-desk"
herdr-app do layout.switch --name sixfold
```

앱 홈은 모든 운영체제에서 `~/.config/herdr-app`입니다(`HERDR_APP_HOME`으로 바꿀 수 있음). 이미 설치된 Herdr Theme 파일이나 `layout:sixfold` 키 섹션은 덮어쓰지 않으며, 다른 레이아웃·설정·단축키는 보존합니다. 원래 레이아웃으로는 레이아웃 선택기로 돌아갑니다.

`sixfold` 레이아웃의 상단 모니터 줄은 외부 mod `system-metrics`, `mcp-status`, `cli-status`, `agent-usage`, `plan-usage`를 씁니다. 사용 전에 [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)에서 따로 설치하세요([모니터 줄 의존성](extras/monitor-layout/README.md)). 이 저장소는 외부 mod 버전을 고정하거나 자동 설치하지 않습니다.

### 설치본 갱신

`scripts/install.py`는 첫 설치용입니다. **이후 설치는 `scripts/update_install.py`로만 합니다. 실행 중인 앱에 파일을 직접 복사(`cp`·`rsync`)하지 않습니다.** diff를 검토하고 반영할 파일을 지정합니다.

```sh
python3 scripts/update_install.py mods/sixfold-desk/main.js mods/sixfold-desk/model.js
```

(Windows에서는 `python3` 대신 `py -3`.) 설치 잠금(`data/sixfold/install.lock`)을 잡고, `mods/` 바깥에 완성된 mod 트리를 만들어 네이티브 검사한 뒤, 원본 전체를 `backups/sixfold-update-*/`에 백업하고 mod 폴더를 교체합니다. macOS·Linux는 원자적 디렉터리 교환(디렉터리 swap / `renameat2`)을 씁니다. Windows에는 디렉터리 교환이 없어 설치본을 옆으로 옮기고 검사한 후보를 넣은 다음 이전 트리를 stage 폴더에 둡니다. 그 순간에는 mod 경로가 잠깐 비고, 이동에 실패하면 설치본을 되돌립니다. 지정하지 않은 설치 파일은 보존하고, 내용·권한이 같은 파일은 건너뛰어 불필요한 reload를 막습니다. 레이아웃·테마 파일과 스크립트는 하나씩 교체하며, `scripts/<파일>`은 `scripts/sixfold/<파일>`로 설치합니다.

설치 후 `status.errors`가 1초간 비어 있고 워크스페이스·탭·포커스가 그대로여야 통과합니다. 검사 실패 시 설치하지 않고, 검증 실패 시 자동으로 되돌리며, 그 사이 다른 작성자의 변경은 덮어쓰지 않고 충돌로 보고합니다. 결과는 백업 폴더의 영수증에 남습니다. `status` 통과는 화면 확인이 아니므로 `herdr-app shot`으로 실제 화면도 확인하세요.

파일은 하나씩 여러 번이 아니라 한 번에 묶어 설치하세요. 교체할 때마다 mod가 다시 로드되고, 짧은 시간의 잦은 재로드는 앱을 지치게 할 수 있습니다. 편집 세션마다 별도 git worktree·브랜치를 쓰고, 정해진 세션 하나만 검토된 결과를 설치합니다. **설치된 mod를 `mods/*-recovery`로 복사하거나 레이아웃을 복구용 복제본에 연결하지 마세요.** 복구는 updater로 하고 백업은 `mods/` 밖에 둡니다. 이미 깨진 앱의 승인된 복구에서는 `--allow-unhealthy-before`로 시작 오류만 허용할 수 있습니다(최종 오류는 0이어야 함). `--verify-timeout 30`은 확인 시간을 늘립니다. updater는 Herdr나 herdr-core를 종료·재시작하지 않습니다. updater 자체는 `scripts/update_install.py`를 지정해 설치하고, 설치된 사본을 실행할 때는 `--repo /검토한/worktree`를 줍니다.

기존 `install_doc_tabs.py`·`install_preview.py`는 기능 준비 도구이지 실시간 갱신 경로가 아닙니다. 기존 mod·레이아웃 코드 갱신은 updater로 합니다.

macOS 네이티브 회귀 검사는 별도 앱/코어 홈에서 돌립니다.

```sh
python3 tests/native_ui_reload.py --reloads 80 --install-smoke
```

## 단축키

Herdr Theme을 선택했을 때만 적용되며 다른 Herdr 기본 단축키는 그대로입니다.

| 키 (macOS) | 동작 |
| --- | --- |
| Cmd+[ / Cmd+] | 같은 탭의 이전·다음 pane |
| Cmd+Option+1…6 | 번호로 pane 선택 |
| Ctrl+Shift+방향키 | 이웃 pane으로 이동 |
| Cmd+Shift+↑ / ↓ | 이전·다음 워크스페이스 |
| Cmd+Shift+J / U | 다음 승인 대기·완료 에이전트 |
| Ctrl+Shift+N | 선택한 컴퓨터에 새 워크스페이스 |
| Cmd+R | 탭 이름 바꾸기 |
| Cmd+X | 앱 pane 닫기(연결된 TUI 에이전트는 원래 서버에 남음) |
| Cmd+W / Cmd+Shift+W | 실수로 닫지 않도록 아무 동작 안 함 |

Windows·Linux에서는 `keys.json`의 레이아웃 전용 조각을 키보드에 맞게 고쳐 쓰세요.

## 컴퓨터와 원격 에이전트

컴퓨터 목록에는 이 컴퓨터와 `hc machine`으로 등록한 컴퓨터가 표시됩니다. 컴퓨터를 선택하면 그 컴퓨터의 워크스페이스·에이전트·상태 개수만 보이며, 승인 대기·완료 이동도 그 안에서 동작합니다. 다른 컴퓨터로 갔다 돌아오면 마지막으로 보던 워크스페이스를 엽니다. 워크스페이스가 없는 컴퓨터는 생성 창을, 연결되지 않은 컴퓨터는 연결 설정을 엽니다. 실행 중인 작업은 유지합니다.

목록은 포커스를 따라갑니다. 다른 컴퓨터의 세션으로 포커스를 옮기면 목록이 그 컴퓨터로 바뀝니다. 직접 고른 컴퓨터는 포커스가 다시 움직일 때까지 유지합니다. 컴퓨터 선택·목록 펼치기는 터미널 포커스를 옮기거나 연결을 시작하지 않습니다.

컴퓨터 행에는 다음을 표시합니다.

- 작업 중·완료·승인 대기 에이전트 수(0이 아닌 것만, 대기를 포함한 전체는 툴팁);
- ↑N ↓N: 최근 10분간 다른 컴퓨터로 보낸·받은 전송 수. 화면에 변화가 없어도 시간이 지나면 저절로 줄어듭니다.

이 컴퓨터와 연결됨·연결 중인 Herdr 컴퓨터만 기본으로 보입니다. 연결이 끊긴 원격과 등록되지 않은 Tailscale 기기는 접힌 상태에서 행·아이콘·개수 모두 숨기며, **COMPUTERS** 옆 작은 화살표로 펼칩니다(최대 높이 180).

**+ Space**와 **Ctrl+Shift+N**은 선택한 컴퓨터에 워크스페이스를 만듭니다. 이 컴퓨터에서는 Claude 4개·Codex 2개의 6분할, 원격에서는 터미널 하나로 시작하며 폴더를 비워두면 그 컴퓨터의 홈을 씁니다. 폴더 선택기는 이 컴퓨터만 지원합니다.

메인에서 `hc ls`로 확인한 주소로 `hc send worker/t7 "메시지"`를 보내거나, 에이전트 행을 선택해 직접 입력할 수 있습니다. `hc send --wait`는 에이전트의 다음 턴을 지켜볼 수 있지만, 전송 성공 자체가 읽음 확인은 아닙니다. SSH·Tailscale·방화벽·에이전트 인증은 테마가 설정하지 않습니다.

### 컴퓨터 간 협업 표시

한 프로젝트에 두 대 이상의 컴퓨터에서 **작업 중**인 에이전트가 동시에 있으면 함께 작업 중으로 봅니다. 같은 프로젝트는 같은 워크스페이스 이름입니다. 이름 끝의 `(이름)`이 그 워크스페이스가 있는 컴퓨터를 가리키면 무시하므로, `worker`의 `문서 (worker)`는 이 컴퓨터의 `문서`와 같은 프로젝트입니다. 이름 없는 워크스페이스(`~`)는 제외합니다.

- **파이프:** 컴퓨터 목록 오른쪽의 고정 여백에 1px 직각 점선 파이프로 같은 프로젝트를 하는 컴퓨터를 잇습니다. 프로젝트마다 차선과 차분한 색이 따로 있고, motion이 켜져 있으면 작은 점이 파이프를 따라 흐릅니다. 미리 잡아 둔 여백에 그리므로 화면 배치가 밀리지 않습니다.
- **워크스페이스 표시:** 함께 작업 중인 워크스페이스는 테두리가 파이프 색 점선으로 바뀌고 위쪽 변에 ⇄를 표시합니다(컴퓨터가 더 많으면 ⇄2, ⇄3 …). 툴팁에 상대 컴퓨터 이름이 나옵니다.
- **끝남:** 작업 중인 컴퓨터가 두 대 미만이 되면 파이프와 표시가 서서히 사라집니다(0.6초, motion off면 즉시). 이름이 같다는 이유만으로 연결을 남기지 않습니다.

이 표시는 두 컴퓨터가 같은 프로젝트를 동시에 작업한다는 뜻이지, 둘 사이에 무언가가 전달됐다는 증거는 아닙니다.

### 컴퓨터 사이 전송

양 끝이 다른 컴퓨터인 전송은 보이는 행에서 워크스페이스 목록 맨 위(컴퓨터 행 바로 아래)까지 파이프를 그립니다. 상대 컴퓨터 행은 경로 색으로 빛나며 ⇡(보냄)·⇣(받음)을 표시하고, 하단 전송 줄에는 상대 컴퓨터 이름이 담긴 ⇄ 칩이 붙습니다. 끝점의 컴퓨터는 터미널 주소(`machine/` 앞부분)로 정하므로, 화면에 없는 원격 터미널도 포함됩니다.

### 이름·폴더·탐색

사용자별 표시 이름과 기본 폴더는 이 컴퓨터의 `~/.config/herdr-app/data/sixfold/computers.local.json`에만 둡니다.

```json
{
  "local": { "label": "집" },
  "machines": {
    "worker": { "label": "빌드 컴퓨터", "folder": "/home/user/projects" }
  }
}
```

키는 `hc machine ls`의 이름과 같습니다. 파일이 없으면 기본 이름을 표시합니다(이 컴퓨터는 "This computer", macOS에서는 "This Mac"). 이름은 바로 반영되고 폴더는 새 워크스페이스에 적용됩니다. 개인 주소·경로·인증 정보는 Git에 넣지 마세요.

원격 연결 없이 기기를 찾으려면 같은 파일에 `"tailscale": true`를 넣습니다(도우미 `scripts/collect_computers.py`는 첫 설치에 포함). 15초마다 **이 컴퓨터의** `tailscale status --json`을 읽어 Tailscale 이름과 온라인 여부를 표시합니다. 이 행으로는 셸이나 워크스페이스를 열 수 없고, "온라인"이 SSH나 Herdr 접속 가능을 뜻하지는 않습니다. ACL 변경·기기 탐침·원격 설치는 하지 않습니다.

원격 작업에는 비대화형 SSH 연결(또는 바이트를 보존하는 `--via` 명령)과 대상의 호환 `hc`가 필요합니다(`hc machine add --help`의 `--install` 참고). 기기 등록은 연결을 시작하므로 원격 접속이 허락된 뒤에만 하세요. Windows 대상은 OpenSSH Server를 켜고 `sshd`를 시작한 뒤 키 인증과, 메인 컴퓨터의 Tailscale IP(또는 정한 범위)로 좁힌 TCP 22 인바운드 방화벽 규칙을 설정하고, 호환되는 herdr-core를 PATH에 둔 다음 `hc machine add user@TAILSCALE_IP --name HOST`로 등록합니다.

## 메시지 흐름

상시 메시지 기록 패널은 없습니다. 새 전송은 `보낸 쪽 → 받는 쪽` 알림을 약 4초 표시합니다. 경로별 색·차선으로 동시 전송을 구분하고, 같은 경로의 반복 전송은 패킷을 따로 유지하며 묶음 개수를 표시합니다. 알림은 경로 두 개와 나머지 개수까지 보여 줍니다. 전달 대기·오류·보류는 해결될 때까지 하단 상태 줄에 남고 툴팁에 자세한 내용이 나옵니다. motion off에서는 이동 효과가 없습니다.

전송은 앱의 메모리 안 `messageEvents()` 목록에서 읽습니다([요구 사항](#요구-사항) 참고). `hc send`와 RPC 전송이 같은 경로를 쓰므로 별도 실행기나 메시지마다의 기록 쓰기가 필요 없습니다. 이벤트에는 보낸 쪽·받는 쪽·시각·관측된 `started` 결과만 담기고 메시지 본문은 담기지 않습니다. 애니메이션은 전송 이벤트일 뿐 읽음 확인이나 작업 시작의 증거가 아닙니다.

설치된 코어 CLI로 직접 보냅니다.

```sh
hc send 대상 "메시지"
```

이전 앱은 기존 `data/sixfold/messages.json` 기록을 표시할 수 있지만 직접 보낸 새 전송은 그 파일에 추가되지 않으며, 네이티브 API가 있으면 그 파일을 읽지 않습니다.

### 이전 추적 실행기 제거

예전 버전의 Python 추적 실행기는 제거했습니다. 설치했었다면 PATH와 셸 시작 파일에서 `~/.local/share/herdr-sixfold/bin`을 빼고 `hc_trace.py` 호출을 멈추세요. `hc`가 코어 CLI를 가리키는지 확인합니다(PowerShell `Get-Command hc -All`, POSIX 셸 `command -v hc`). `~/.local/bin/hc`가 실행기를 가리키는 심볼릭 링크라면 이전 코어 대상으로 되돌리고, 다른 실행기는 건드리지 마세요. 내용을 확인한 뒤 `~/.local/share/herdr-sixfold/` 아래의 `hc_trace.py`, `bin/hc`, `bin/hc.cmd`를 지웁니다. 설치된 `scripts/route.py`와 `scripts/collect_workflow.py`도 `hc`를 직접 부르는 최신 파일로 갱신하세요. 이미 열린 셸은 다시 열어야 PATH가 바뀝니다.

## 서브에이전트 트리와 워크플로 수집기

서브에이전트는 부모 에이전트 행의 `▸ N`으로 펼칩니다. 자식이 없어도 부모 행은 남고, 새 위임이 관측되면 트리를 펼치며 곡선 흐름을 보여 줍니다. 개수는 워크스페이스 제목이 아니라 에이전트 행에 표시합니다.

`scripts/collect_workflow.py`는 Claude 메타데이터, 읽기 전용 Codex DB, hc의 부모 관계로 `data/sixfold/workflow.json`을 만듭니다. `--once`는 한 번만 수집하고, 기본 실행은 3초마다 바뀐 내용만 씁니다. 추정 활동에는 표시가 붙고 시작 시점의 기존 위임은 애니메이션하지 않습니다. macOS·Linux·Windows에서 동작합니다(Windows는 `pgrep`·`lsof` 대신 Toolhelp 프로세스 스냅숏과 Restart Manager를 쓰고, 콘솔 창을 띄우지 않고 `hc`를 실행합니다).

첫 설치에는 수집기가 들어 있지 않고, 테마가 백그라운드 실행으로 등록하지도 않습니다. updater로 설치하면(`python3 scripts/update_install.py scripts/collect_workflow.py`, Windows는 `py -3`) `scripts/sixfold/`에 놓입니다. Windows에서는 그다음 작업 스케줄러로 로그온 때 창 없이, 한 번에 하나만 실행할 수 있습니다.

```powershell
$pyw = Join-Path (Split-Path (py -3 -c "import sys; print(sys.executable)")) 'pythonw.exe'
$home_ = "$HOME\.config\herdr-app"
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$home_\scripts\sixfold\collect_workflow.py`"" -WorkingDirectory $home_
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Herdr Theme workflow collector'
```

`pythonw.exe`는 콘솔 창이 없습니다. 해제는 `Stop-ScheduledTask`로 실행 중인 것을 멈춘 뒤 `Unregister-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Confirm:$false`입니다.

## 워크스페이스 배지 (확장 지점)

다른 mod나 도구가 테마를 고치지 않고 워크스페이스 이름 옆에 작은 배지를 표시할 수 있습니다. 공유 상태 `sixfold.workspace.badges`에 올리거나 `~/.config/herdr-app/data/sixfold/workspace-badges.json`에 씁니다(사이드바가 파일을 지켜봄).

```json
{ "<machine>|<space id>": [ { "id": "open", "text": "! 2", "tone": "blocked", "tooltip": "열린 항목 2개",
  "open": { "mod": "my-mod", "props": { "x": 1 }, "kind": "window", "key": "my-mod-x", "width": 800, "height": 600 } } ] }
```

`<machine>`은 원격 컴퓨터 이름이고 이 컴퓨터는 빈 문자열, `<space id>`에는 machine 앞부분이 없습니다. 색조는 `blocked`, `working`, `done`, `accent`, `dim`입니다. 누르면 `open`을 해당 mod의 오버레이로 열거나 `command`(`{"name": "my-mod.show", "args": {}}`)를 실행합니다. 워크스페이스당 4개, 글자는 12자까지이며 형식이 잘못된 항목은 무시합니다. 같은 워크스페이스는 공유 상태가 파일보다 우선합니다. 테마 자체는 배지를 올리지 않습니다.

## 채널 알림 (선택)

채널의 새 메시지는 워크스페이스 제목 아래 별도의 '채널 알림' 줄에 Slack 아이콘으로 표시하며, 세션 수·고정 핀과 섞지 않습니다. `data/sixfold/project-alerts.json`의 `projects`는 추적할 워크스페이스 이름, `items`는 새 메시지(`id`, `project`, `author`, `text`, `at`, `link`) 배열입니다. 읽음은 메시지 ID로 `slack-alerts-read.json`에 남습니다. 멘션 팝업은 `sixfold-slack-inbox` mod(`herdr-app do mod.open '{"name":"sixfold-slack-inbox"}'`)로, `data/sixfold/slack-mentions.json`을 읽어 스레드별로 묶고 자체 확인 상태를 둡니다(Slack의 읽음과 별개). Slack에서 모으는 일은 별도 도구가 합니다.

## 같은 크기 분할과 새 워크스페이스

```sh
python3 scripts/balance_grid.py
python3 scripts/workspace.py "Example" /path/to/your/project
```

`balance_grid.py`는 코어의 버전 확인 문서 API로 6개 터미널 탭을 같은 행·열로 맞추며, pane ID와 터미널 주소를 그대로 두고 프로그램을 재시작하지 않습니다. **+ Space**와 **Ctrl+Shift+N**은 이름·폴더 창을 열고, 이 컴퓨터에서는 한 탭 안에 Claude 4개·Codex 2개를 3×2로 만듭니다(두 CLI 설치 필요). `workspace.py`도 같은 구성을 쓰며 `--shells`는 셸 6개만 엽니다. 에이전트 인증과 폴더 신뢰는 각 에이전트 화면에서 합니다.

## 고정 표시·아이콘·로컬 설정

**고정 표시.** `~/.config/herdr-app/data/sixfold/workspace-pins.local.json`에 `{"spaces":[{"id":"실제-space-id","machine":null}]}`처럼 `herdr-app ls`의 ID를 넣습니다(원격은 앱에 보이는 ID와 machine을 함께). 정확히 일치하는 항목만 핀 아이콘과 강조 테두리를 받고, 이름을 바꿔도 유지되며 같은 이름의 다른 워크스페이스에는 적용되지 않습니다. 바로 반영되고 잘못된 JSON은 마지막 정상 값을 유지하며, `{"spaces":[]}`는 모두 해제합니다. 순서나 삭제 동작은 바꾸지 않습니다.

**아이콘.** `python3 scripts/set_workspace_icon.py '워크스페이스 ID 또는 정확한 이름' /path/to/icon.png`로 지정합니다(SVG·PNG·JPEG·WebP, 선택 `--background '#ffffff'`, 단색 SVG용 `--tint`). 파일은 `data/sixfold/icons/`에 복사되고 재시작 없이 반영됩니다.

**`site.local.json`.** 프로젝트 이름·별칭, 사이드바 표시·색, Slack 주소와 멘션 이름, 보고서·상태 폴더, LaunchAgent 이름 앞부분, 문서 탭 시드처럼 사람마다 다른 값은 저장소가 아니라 `~/.config/herdr-app/data/sixfold/site.local.json`에 둡니다. `config/site.example.json`을 복사해 시작하세요. `*.local.json`은 git이 무시합니다. 칸 머리줄의 위치 번호(`01`, `02`)는 기본으로 숨기며 `"pane_header_index": true`로 다시 보입니다.

## 대기 세션 절전과 끝난 워크스페이스 (선택, macOS)

`scripts/sleep_idle_sessions.py`는 20분 동안 입력이 비어 있고, 승인 대기·서브에이전트·백그라운드 작업이 없고, 화면에 보이거나 포커스된 칸이 아닌 에이전트를 재웁니다. 칸은 남으며, Enter나 들어온 `hc send`가 같은 세션을 원래 옵션으로 이어 엽니다. `scripts/close_finished_spaces.py`는 에이전트가 모두 끝난 임시 워크스페이스를 찾습니다. 둘 다 dry-run LaunchAgent(`install_session_sleep.py --install`, `install_space_cleanup.py --install`)로 시작하고, 기록을 검토해 apply를 켠 뒤에만 실제로 동작합니다. 워크스페이스는 `space_close_enabled: true`를 직접 넣기 전에는 닫지 않습니다. 실행 직전 모든 조건을 다시 확인하고, 미커밋 파일과 worktree를 보존하며, 상태를 확인할 수 없는 워크스페이스는 그대로 둡니다.

## 실시간 TUI 연결 (선택, macOS/Linux)

Herdr TUI와 Herdr 앱은 런타임이 다릅니다. 연결은 가져오기가 아니라 실시간 연결이라 원래 TUI 서버가 계속 실행돼야 하고, 에이전트·대화·권한·음성 연결은 원래 자리에 남습니다.

```sh
python3 /path/to/herdr-theme/scripts/tui_bridge.py --session default --pane 원본_PANE
```

1초마다 원본 상태를 알리고 입력·크기 변경을 전달하며 원본별 잠금을 씁니다. 에이전트에 프롬프트를 보내지 않고, 연결을 닫아도 원본 에이전트는 살아 있습니다.

## 음성 (선택, macOS)

`voice/`는 헤드셋으로 에이전트를 음성 지시하는 herdr 플러그인입니다. 포커스된 칸만 녹음하고(Claude Code 받아쓰기 F8, Codex 음소거·해제 F9), 문장이 끝나고 잠시 뒤 전송하며, 등록한 사람의 목소리가 아니면 받아쓰기를 거부합니다.

```sh
bash voice/install.sh                    # 처음: Homebrew로 herdr와 uv도 설치
python3 scripts/update_install.py voice  # 이후 갱신 (또는 python3 voice/install.py)
```

마이크·보정값 같은 개인 값은 각자의 `~/.config/herdr-app/data/sixfold/voice.local.json`에 둡니다. 음성 데이터는 Mac 밖으로 나가지 않습니다. 자세한 내용은 [voice/README.md](voice/README.md).

## 문서·사용량 도구 (선택)

[Project Document Viewer](extras/preview/README.md)는 저장된 Markdown 미리보기와 로컬 HTML 스냅숏을 추가합니다. 프로젝트 문서 추적은 [설정과 수집기](docs/project-documents.md)를 참고하세요. 시스템 사용량, MCP·CLI 상태, 에이전트·요금제 사용량, 문서 뷰어 같은 독립 mod는 [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)에 있습니다. 토큰 기록은 [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights)에서 볼 수 있습니다. 계정 한도는 에이전트별 토큰 합계가 아닙니다.

공용 워크스페이스와 프로젝트 칸 사이 메시지 전달은 [COMMON_ROUTING.md](COMMON_ROUTING.md)를 따르며, `python3 scripts/route.py --enable`로 이 checkout을 사이드바 대기열 처리에 연결합니다. 과부하 때의 협업은 [docs/overload-collaboration.md](docs/overload-collaboration.md)에 있습니다. 툴바 아래의 흐린 세션 펫 줄은 현재 워크스페이스 에이전트를 따라 움직이며, `sixfold.pets=false`로 숨기고 `sixfold.motion=false`로 움직임을 멈춥니다.

## 실행하는 것

UI는 Herdr의 워크스페이스·에이전트 API와 이동 명령만 쓰며 네트워크 요청을 하지 않습니다. 선택 기능인 연결은 설치된 `herdr` CLI를, 도우미는 이 컴퓨터의 `hc`·`herdr-app`을 실행합니다. 개인 설정·계정 정보·세션 대응표는 이 저장소에 두지 않습니다.

## 개발

```sh
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
node --check mods/sixfold-desk/main.js
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
```

`herdr-app check`는 mod 옆에 `gpui-kit.d.ts`와 `jsconfig.json`을 만듭니다. 커밋하지 마세요. 모델 테스트는 네이티브 UI 테스트가 아니므로 바뀐 레이아웃은 `herdr-app status`와 실제 스크린샷으로 확인합니다. 재현 명세는 [RECIPE.md](RECIPE.md)에 있습니다. 작업은 `main`에서 짧은 브랜치로 하며, 설치본은 `main`을 따릅니다. Apache-2.0.
