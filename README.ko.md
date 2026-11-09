# Herdr Theme

여러 프로젝트와 여러 컴퓨터의 코딩 에이전트를 왼쪽 패널 하나에서 살펴보는 Herdr 테마입니다. 워크스페이스·에이전트 상태·컴퓨터 간 공동 작업과 프로젝트 문서를 보고, CPU·RAM, MCP 연결, 계정 CLI, 요금제 한도, 세션별 토큰 사용량을 터미널 옆에서 확인합니다. 메시지 애니메이션은 앱과 코어가 메시지 이벤트를 제공할 때 동작합니다.

![Windows의 Herdr Theme: 컴퓨터 두 대, Storefront 공동 작업, 모니터 줄](preview.gif)

[English](README.md)

반복 GIF와 스크린샷은 Windows 11 실제 앱의 데모 워크스페이스로 협업 표시를 설명합니다. 두 번째 컴퓨터 "worker"와 그 사이드바 데이터(전송 이벤트 포함)만 합성이고, 모니터 줄은 촬영 기기의 실제 값입니다. 12초 반복 영상에서 전송이 협업 테두리 혜성으로 이어졌다가 숨쉬기로 돌아옵니다. 현재 기능과 이벤트 지원 조건은 아래 기능 목록과 요구 사항을 참고하세요. [정지 이미지](preview.png).

## 구성

Herdr Theme은 레이아웃과 사이드바입니다. 설치기는 [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)를 고정된 버전으로 함께 설치하므로 모니터 줄이 바로 동작합니다. 저장소는 둘이지만 설명은 이 README 하나에 모았습니다.

이 README는 현재 `main` 브랜치 기준입니다. 함께 설치되는 도우미는 Rust 네이티브 실행 파일 `herdr-theme`입니다. 로컬 작업 배분·세션 절전·정리 같은 자동화 정책은 각 도구가 별도로 제공하며, 테마는 [선택적 로컬 연동](#선택적-로컬-연동)으로 받은 데이터를 표시합니다.

| 부분 | 보여 주는 것 |
| --- | --- |
| 사이드바(이 저장소) | 컴퓨터별 상태, 워크스페이스와 에이전트, 미확인 메시지, 전송 애니메이션, 컴퓨터 간 공동 작업, 서브에이전트 트리, [픽셀 아트 행 상태](#행-상태와-픽셀-이펙트) |
| [프로젝트 문서](#프로젝트-문서) | 공간별 문서 검색, 고정·미리보기를 제공하는 선택적 **문서** 탭 |
| [System Metrics](#system-metrics) | CPU·RAM과 최근 표본 막대 |
| [MCP Status](#mcp-status) | MCP 서버별 연결 상태(Claude·Codex 합침) |
| [CLI Status](#cli-status) | AWS 프로필·GitHub·kubectl·Docker 로그인 상태 |
| [Plan Usage](#plan-usage) | Codex·Claude 5시간/7일 한도, Codex 한도 초기화 |
| [Agent Usage](#agent-usage) | 세션별 토큰·모델·effort·권한 모드·이번 주 비중, 에이전트 상태를 나타내는 머리줄 고양이 |
| [로컬 연동](#선택적-로컬-연동)(선택) | 외부 도구가 제공한 배지·질문/권한 카드·문서 보기·세션 보고 |
| [Document Viewer](#document-viewer)(선택) | 터미널 옆 프로젝트 파일과 Markdown |

## 운영체제별 지원

표는 지원 동작과 이전 릴리스의 확인 결과입니다. 네이티브 이전의 검증 결과와 남은 플랫폼 확인은 [네이티브 이전 기록](docs/native-rust-migration.md)을 참고하세요.

| 부분 | macOS | Windows |
| --- | --- | --- |
| 사이드바·컴퓨터 목록·메시지 흐름·공동 작업 표시 | 됨 | 됨 |
| System Metrics·MCP Status·CLI Status·Plan Usage·Agent Usage | 됨 | 됨 |
| 워크플로 수집기(서브에이전트 트리) | 됨 | 됨(아래 작업 스케줄러 예시) |
| Document Viewer: Markdown | 됨 | 됨 |
| Document Viewer: HTML 미리보기 | 됨(WebKit 스냅숏) | 안 됨 — 소스로 열리고, HTML 탭에 macOS가 필요하다는 안내 |
| Document Viewer: 저장하면 자동 새로고침 | 됨 | 됨 |
| 음성 | 됨 | 안 됨(설치기가 건너뜀) |
| 선택적 실시간 TUI 연결 | 됨(POSIX 터미널 API, Linux도) | 안 됨 |
| 로컬 연동 표시 | 생산자를 설정하면 됨 | 생산자를 설정하면 됨 |

Linux에는 네이티브 도구와 POSIX 연결 경로가 있지만 이번 버전의 데스크톱 UI 확인은 하지 않았습니다. WebKit 렌더러와 음성 설치는 macOS 전용입니다. 세션 절전·정리 서비스는 이 테마 릴리스 밖에서 관리하며, 지원 운영체제는 별도로 설치한 서비스에 따라 다릅니다.

## 요구 사항

- Herdr 앱 0.1.11 이상, 호환되는 herdr-core와 Git. 컴퓨터 목록과 원격 워크스페이스에는 머신 레이아웃 지원이 필요합니다. 네이티브 도구를 빌드하려면 stable Rust와 C 컴파일러도 필요하며, Windows에서는 MSVC C/C++ Build Tools 또는 완전한 GNU 호환 도구 모음을 사용합니다. 테마에 포함된 도우미에는 Python이 필요하지 않습니다.
- 메시지 애니메이션은 앱이 호환되는 `messageEvents()` 메타데이터를 제공하고 관련 코어가 전송 이벤트를 내보낼 때 동작합니다. API가 없으면 실시간 전송 애니메이션이 나오지 않습니다. 테마 설치는 앱·코어를 설치하거나 교체하지 않으므로, 이 기능을 쓰려면 서로 호환되는 앱·코어 빌드를 준비하세요.
- Agent Usage는 [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights) mod의 로컬 저장소를 읽습니다(따로 설치, Node.js 필요).
- 로컬 **+ Space** 창은 Claude 세션 하나로 시작하며 Claude CLI 설치 여부를 확인합니다. 원격 공간은 터미널로 시작합니다. 기존 세션과 모니터 줄은 새 공간 생성과 별개로 사용할 수 있습니다.

## 설치

macOS / Linux:

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1
./rust/target/release/herdr-theme install
herdr-app do layout.switch --name sixfold
```

Windows(PowerShell, 네이티브 실행 파일):

```powershell
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1
.\rust\target\release\herdr-theme.exe install
herdr-app do layout.switch --name sixfold
```

설치기가 하는 일:

- 테마의 mod·레이아웃·팔레트·네이티브 도구를 앱 홈에 설치합니다(모든 운영체제에서 `~/.config/herdr-app`, `HERDR_APP_HOME`으로 변경 가능).
- [`workspace-mods.lock.json`](workspace-mods.lock.json)에 고정된 커밋의 Herdr Workspace Mods를 `~/.local/share/herdr-sixfold/vendor/herdr-workspace-mods/<커밋 앞 12자>`(커밋마다 폴더 하나, 받기에 성공했을 때만 생김)으로 받아 정확히 그 커밋이고 로컬 변경이 없는지 확인한 뒤 그 커밋이 추적하는 파일로 `system-metrics`, `mcp-status`, `cli-status`, `plan-usage`, `agent-usage`를 테마와 함께 설치합니다. 설치한 버전은 `data/sixfold/workspace-mods.json`에 기록합니다.
- Files 패널이 있는 레이아웃이 있으면(Herdr를 처음 켜면 `main`이 생김) 네이티브 설치기로 Document Viewer를 설치하고, 없으면 나중에 실행할 명령을 출력합니다. macOS가 아니면 Markdown만 설치합니다.
- 이미 있는 파일이나 `layout:sixfold` 키 섹션은 덮어쓰지 않고 다른 레이아웃·설정·단축키는 보존합니다. `--update`는 전에 설치한 것을 갱신하되 직접 바꾼 레이아웃·팔레트는 그대로 둡니다.

옵션: `--without-workspace-mods`는 테마만 설치합니다(이때 `sixfold` 레이아웃의 모니터 줄 mod는 따로 설치해야 함). `--workspace-mods-source 경로`는 받지 않고 이미 고정 커밋에 있는 로컬 checkout에서 설치합니다. 넓은 화면에서는 `sixfold` 레이아웃이 모니터 줄을 한 줄로 두고, 작은 Windows 창에서는 스크린샷처럼 [`extras/windows-layout`](extras/windows-layout/README.md)의 두 줄 배치를 씁니다.

### 설치본 갱신

첫 설치 이후에는 **`herdr-theme update-install`만 씁니다. 실행 중인 앱에 파일을 직접 복사하지 않습니다.** 검토한 테마 파일을 지정하면 같은 실행에서 Workspace Mods도 고정 버전으로 맞춥니다(내용이 같은 파일은 건너뛰어 불필요한 재로드가 없음).

```sh
herdr-theme update-install mods/sixfold-desk/main.js mods/sixfold-desk/model.js
herdr-theme update-install            # Workspace Mods만 고정 버전으로 맞춤
```

예시는 빌드한 실행 파일이 PATH에 있다고 가정합니다. 대신 `./rust/target/release/herdr-theme` 또는 `.\rust\target\release\herdr-theme.exe`로 실행해도 됩니다. `--without-workspace-mods`는 Workspace Mods를 그대로 두며, `voice`만 지정한 실행은 건드리지 않습니다. 네이티브 도구를 갱신할 때는 `scripts/herdr-theme`(Windows는 `scripts/herdr-theme.exe`)도 지정합니다.

updater는 `data/sixfold/install.lock`을 잡고, 바뀌는 mod 전체를 `mods/` 밖에 만들어 각각 `herdr-app check`로 검사하고, `backups/sixfold-update-*/`에 전체 백업을 둔 뒤 mod 폴더를 교체합니다. macOS·Linux는 원자적으로 교환하고, Windows는 디렉터리 교환이 없어 그 순간 mod 경로가 잠깐 비며 실패하면 설치본을 되돌립니다. 이후 `status.errors`가 1초간 비어 있고 워크스페이스·탭·포커스가 그대로여야 통과하고, 아니면 되돌립니다(그 사이 다른 작성자의 변경은 보존하고 보고). 결과는 백업의 영수증에 남습니다. `status` 통과는 화면 확인이 아니므로 `herdr-app shot`도 보세요.

검토한 파일 묶음을 한 번에 설치하세요. 교체할 때마다 mod가 다시 로드되므로 불필요한 재로드를 줄일 수 있습니다. 편집 세션마다 별도 git worktree를 쓰고 한 세션만 검토된 결과를 설치합니다. **설치된 mod를 `mods/*-recovery`로 복사하지 마세요.** `--allow-unhealthy-before`는 승인된 복구에서 시작 오류만 허용하고(최종 오류는 0이어야 함), `--verify-timeout 30`은 확인 시간을 늘립니다. updater는 Herdr나 herdr-core를 종료·재시작하지 않습니다. `scripts/sixfold/`에 설치된 사본을 실행할 때는 `--repo /검토한/worktree`를 줍니다.

## 단축키

`sixfold` 레이아웃을 쓸 때만 적용되며 다른 Herdr 단축키는 그대로입니다.

| 키(macOS) | 동작 |
| --- | --- |
| Cmd+[ / Cmd+] | 같은 탭의 이전·다음 pane |
| Cmd+Option+1…6 | 번호로 pane 선택 |
| Ctrl+Shift+방향키 | 이웃 pane으로 이동 |
| Cmd+Shift+↑ / ↓ | 이전·다음 워크스페이스 |
| Cmd+Shift+J / U | 다음 승인 대기·완료 에이전트 |
| Cmd+Ctrl+1…9 | 컴퓨터 선택 |
| Cmd+Option+F | 현재 공간의 문서 목록을 펼치고 검색 |
| Ctrl+Shift+N | 선택한 컴퓨터에 새 워크스페이스 |
| Cmd+R | 탭 이름 바꾸기 |
| Cmd+X | 앱 pane 닫기 |
| Cmd+W / Cmd+Shift+W | 실수로 닫지 않도록 아무 동작 안 함 |

Windows·Linux에서는 `keys.json`의 레이아웃 전용 조각을 키보드에 맞게 고쳐 쓰세요.

## 컴퓨터와 원격 에이전트

사이드바에는 이 컴퓨터와 `hc machine`으로 등록한 컴퓨터가 나옵니다. 컴퓨터를 고르면 그 컴퓨터의 워크스페이스·에이전트와 승인 대기·완료 이동만 보이고, 돌아오면 마지막 워크스페이스를 엽니다. 목록은 포커스를 따라갑니다. 다른 컴퓨터의 세션으로 포커스를 옮기면 목록이 그 컴퓨터로 바뀌고, 직접 고른 것은 포커스가 다시 움직일 때까지 유지합니다. 컴퓨터 선택은 터미널 포커스를 옮기거나 연결을 시작하지 않습니다.

컴퓨터 행에는 작업 중·완료·승인 대기 수(0이 아닌 것만, 툴팁에 전체)와 **최근 10분**간 다른 컴퓨터로 보낸·받은 전송 수 ↑N ↓N이 나옵니다.

이 컴퓨터와 연결됨·연결 중인 컴퓨터만 기본으로 보이고, 끊긴 원격과 등록되지 않은 Tailscale 기기는 **COMPUTERS** 옆 화살표로 펼쳐야 보입니다. **+ Space**와 **Ctrl+Shift+N**은 선택한 컴퓨터에 워크스페이스를 만듭니다. 이 컴퓨터에서는 조정용 Claude 세션 1개, 원격에서는 그 컴퓨터 홈(또는 설정한 폴더)의 터미널 하나입니다. 추가 칸과 그 수명은 수동으로 관리하거나 별도로 설정한 도구에 맡깁니다.

메인에서 `hc ls`의 주소로 `hc send worker/t7 "메시지"`를 보냅니다. 전송 성공이 읽음 확인은 아닙니다. SSH·Tailscale·방화벽·에이전트 인증은 테마가 설정하지 않습니다.

### 로컬 작업 추적

선택적으로 [로컬 작업 피드](docs/panel-feed.md)를 읽어 한 줄 작업, 4칸 단계 바, 부모·하위 작업 트리, 이슈별 묶음, 공유 연결, 메시지 패킷과 4단계 정리를 보여 줍니다. 이슈 묶음과 긴 하위 작업 목록은 **+N**으로 펼칩니다. 완료 작업에는 체크를 표시하고 막힌 작업, 보고 없음, 읽지 않은 메시지, 원격 작업과 사용량 한도를 구분합니다.

행에는 피드가 제공한 작업 제목을 표시합니다. 생산자는 현재 과업이나 하위 작업 이름을 제공해야 합니다. 완료된 하위 작업은 트리와 **+N** 수에서 제외하고, 독립된 루트 작업은 자신의 정리 단계를 유지합니다.

단계 바는 과업을, 상태 표시는 그 칸에서 실제로 관측된 상태를 따릅니다. 그래서 과업이 끝난 뒤에도 칸은 작업 중으로 보일 수 있습니다. 단계가 바뀌거나 새 이벤트(일 맡김·검수 요청·판정·수락·정리 단계)가 오면 제목은 그대로 두고 단계 바 자리에 약 2.5초 동안 그 이벤트 이름을 표시합니다. 일 하나를 맡기면 «일 맡김», 하나를 여러 개로 나누면 «일 나누기 · N개» 입니다. 막힌 과업은 막힌 단계 칸만 주황으로 칠합니다.

Linear·Jira 영역을 누르면 오른쪽 이슈 팝오버가 열립니다. **이번 주**·**마일스톤**·**전체**에서 검색하고 캐시된 이슈를 하나씩 공간으로 가져옵니다. 로컬 요청은 표시할 이슈 선택을 바꿉니다. 테마는 과업을 수락하거나 세션을 닫지 않습니다. 선택한 컴퓨터의 기존 워크스페이스 카드 안에 작업 행을 표시하며, 워크스페이스 배지·문서 조작·로컬 질문 카드도 함께 유지합니다. **작업**은 컴퓨터 탐색을 유지하면서 작업 행을 켜고 끕니다. 모션 끔과 전달받은 시스템 동작 줄이기에서는 움직임 없이 상태만 갱신합니다.

같은 컴퓨터의 공간 협업은 명시된 상대 공간 이름 칩과 양 끝이 사각형인 정지된 보라색 꺾쇠로 표시합니다. 같은 과업의 에이전트 꺾쇠는 정지된 회색 실선이며, 점선 공유 경로는 다른 컴퓨터를 구분합니다.

새 메시지는 양 끝을 잇는 기존 선을 따라 이동합니다. 다른 컴퓨터로 가면 그 컴퓨터의 점선 파이프, 협업 공간 사이면 협업 차선, 그 밖에는 안쪽 메시지 차선을 탑니다. 이 선들은 모두 사이드바 오른쪽의 고정된 72px 여백 안에 있고, 모서리가 둥근 얇은 직각 선으로 그립니다. 메시지는 1.5초, 일 맡김·검수·수락·새 에이전트·기억 같은 과업 이벤트는 2.4초에 걸쳐 이동해 눈으로 따라갈 수 있습니다. 흰 머리와 청록 꼬리 두 조각으로 된 패킷은 밖으로 나갔다가, 선을 따라 이동하고, 다시 안으로 들어오므로 그려진 선을 벗어나지 않습니다. 도착하면 사각 핑이 한 번 표시됩니다. 연달아 오는 전송은 두 차선에 시간차를 두고 나누며 예약 경로는 최대 8개입니다. 목적지를 확인할 수 없으면 건너뜁니다. 건수로 명시된 전달 수는 네트워크 속도가 아닙니다. 리로드 뒤 이전 기록은 다시 재생하지 않습니다.

공유 4종 × 도구 3종 × Slack 2종의 24가지 조합을 다크·라이트로 각각 촬영한 매트릭스 48장과 조작 사례·갱신 검증은 [네이티브 fixture 갤러리와 측정 결과](docs/panel-validation.md)에서 볼 수 있습니다.

![합성 로컬 데이터를 실제 앱에서 그린 작업 패널과 이슈 팝오버](docs/images/panel-feed/issues-milestone.png)

#### 행 상태와 픽셀 이펙트

![일곱 가지 행 상태 이미지를 5배로 키워 다크·라이트 팔레트로 보여 주는 GIF](docs/images/session-states.gif)

피드가 행에 선택 항목 `state`를 주면 그 행의 상태 표시가 작은 픽셀 아트 이미지 일곱 가지 중 하나로 바뀝니다. 상태마다 모양이 달라서 색만으로 구분하지 않습니다.

| `state` | 이름 | 모양 | 이펙트 |
| --- | --- | --- | --- |
| `working` | 작업 중 | 점 여덟 개로 된 고리 | 밝은 점이 고리를 돕니다(0.8초 반복) |
| `idle` | 쉬는 중 | 빈 고리 | 정지 |
| `needs_human` | 확인 필요 | `!`가 있는 주황 마름모 | 한 번 빛나며 커졌다가 멈춥니다(1.6초 반복) |
| `unseen_result` | 결과 안 봄 | 새 결과 점이 붙은 체크 | 빛이 체크를 따라 지나갑니다(2.4초 반복) |
| `cleanup_wait` | 정리 대기 | 달 | `z`가 떠오르며 사라집니다(3초 반복) |
| `closing` | 닫는 중 | 열린 상자 | 물방울이 상자에 떨어져 튑니다(1.2초 반복) |
| `closed` | 닫힘 | 닫힌 상자 | 정지, 행이 흐려집니다 |

재생 방식:

- 이미지는 [`mods/sixfold-desk/icons/status/`](mods/sixfold-desk/icons/status)에 들어 있는 파일입니다. 상태마다 정지 PNG와 무손실 애니메이션 WebP가 12px·16px, 다크·라이트 팔레트로 있습니다. `manifest.json`에 파일별 프레임 수·시간·해시가 있습니다. WebP는 앱의 네이티브 이미지 디코더가 재생하며, 테마는 이를 위한 렌더러나 스크립트 타이머를 돌리지 않습니다.
- **모션 끔**, 피드의 `reduced_motion`, 숨겨진 창에서는 정지 PNG를 보여 줍니다. 그 행에 이벤트 이름이 떠 있는 동안(위의 2.5초)에도 이미지가 멈춥니다.
- 오류(`!`)나 사용량 한도(`◷`) 표시가 있으면 그 자리를 먼저 차지합니다. 하위 작업 행은 작은 점을 유지합니다. 알 수 없는 `state`이거나 값이 없으면 기존 4가지 상태 표시를 그대로 써서, 이전 생산자의 피드도 전과 같이 보입니다.
- 제목 아래 둘째 줄에 사유를 표시합니다. 생산자의 `keep_reason`, 정리 단계(보고 작성 → 경험·결정 저장 → 기억함 제안 → 닫힘), 또는 `cleanup` 데이터가 있는 `cleanup_wait`·`unseen_result` 행의 `30분 쉬면 닫힘 (남은 12분)` 같은 카운트다운입니다. 남은 분은 생산자의 `due_at`을 기준으로 이 컴퓨터 시계로 세며, 1분에 한 번 그 행만 다시 그립니다. `due_at`이 지나면 `다음 정리 때 닫힘`으로 표시합니다.
- 모두 표시용입니다. 세션을 유지할지 닫을지는 테마가 정하지 않습니다. 필드 설명은 [피드 계약](docs/panel-feed.md)에 있습니다.

프레임은 [pixelfx](https://github.com/patch-gg/pixelfx)(MIT, 폴더의 [NOTICE](mods/sixfold-desk/icons/status/NOTICE.md) 참고)로 렌더링했습니다. 위 GIF는 함께 배포되는 16px 파일을 각 파일의 프레임 시간 그대로 5배 키워 만든 것입니다.

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

**이전 추적 실행기 제거.** 예전의 Python 실행기는 제거했습니다. 설치했었다면 PATH에서 `~/.local/share/herdr-sixfold/bin`을 빼고 `hc_trace.py` 호출을 멈추고, `hc`가 코어 CLI를 가리키는지 확인하고(`Get-Command hc -All` / `command -v hc`), 실행기를 가리키는 `~/.local/bin/hc` 심볼릭 링크를 되돌리고, `~/.local/share/herdr-sixfold/` 아래의 `hc_trace.py`, `bin/hc`, `bin/hc.cmd`를 지우고, 설치된 `herdr-theme route`와 `herdr-theme collect-workflow`를 갱신하세요.

## 서브에이전트 트리와 워크플로 수집기

서브에이전트는 부모 행의 `▸ N`으로 펼치고, 새 위임이 생기면 트리를 펼치며 흐름을 보여 줍니다. `herdr-theme collect-workflow`는 Claude 메타데이터·읽기 전용 Codex DB·hc 부모 관계로 `data/sixfold/workflow.json`을 만듭니다(`--once`, 또는 3초마다 바뀐 것만 기록). macOS·Linux·Windows에서 동작하며 Windows에서는 콘솔 창을 띄우지 않습니다.

설치된 네이티브 도구에는 수집기가 포함되지만 백그라운드로 등록하거나 시작하지는 않습니다. 한 번만 수집하려면 `herdr-theme collect-workflow --once`를 실행하세요. 상시 수집은 3초마다 로컬 세션 기록을 살펴보며 자원을 사용하므로, 서브에이전트 트리를 계속 갱신해야 할 때만 등록합니다. 멈추면 마지막 저장 결과가 남으며 실시간 상태는 아닙니다.

Windows에서는 로그온 때 창 없이, 한 번에 하나만 실행할 수 있습니다.

```powershell
$home_ = "$HOME\.config\herdr-app"
$collector = "$home_\scripts\sixfold\herdr-theme.exe"
$command = "Start-Process -WindowStyle Hidden -Wait -FilePath '$collector' -ArgumentList 'collect-workflow'"
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $home_
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Herdr Theme workflow collector'
```

`Stop-ScheduledTask`로 작업을 멈추고 그 자식인 `herdr-theme.exe collect-workflow`도 종료됐는지 확인한 뒤 `Unregister-ScheduledTask -TaskName 'Herdr Theme workflow collector' -Confirm:$false`로 등록을 해제합니다. 숨겨진 PowerShell 실행기만 멈추면 수집기가 남을 수 있으므로, 확인된 해당 수집기만 종료하고 다른 네이티브 도우미는 유지하세요.

## Workspace Mods

[Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)에서 오며 테마와 함께 설치됩니다. 각각 단독으로도 쓸 수 있습니다(그 저장소 참고). 모니터 줄의 도우미는 mod가 실행하는 네이티브 명령이며 Windows에서는 콘솔 창 없이 돌고, 눌러서 복사는 `Set-Clipboard`(macOS `pbcopy`, Linux `wl-copy`/`xclip`)를 씁니다.

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

Codex·Claude 한도를 브랜드 아이콘·막대·백분율로: 5시간·7일 창, 초기화 시각과 남은 시간, 제공자가 알려 주면 모델별 주간 창(`Fable 7d`), Codex 한도 초기화 남은 횟수 `↺ N`과 확인 후 사용하는 버튼. Codex 워크스페이스의 크레딧 소진·지출 한도 도달은 개인 한도가 낮아 보여도 표시합니다. 2분마다 갱신하고, 제공자가 확인 요청을 제한하면 다음에 읽힐 때까지 오류를 표시합니다.

### Agent Usage

![Agent Usage](docs/images/agent-usage.png)

코어가 알려 주는 실행 중 Claude·Codex 세션마다 토큰 사용량을 워크스페이스별로: 세션 합계, 비캐시 입력·출력·캐시, 이번 주 비중, 모델. Windows에서는 Claude는 `~/.claude/sessions/<pid>.json`, Codex는 그 프로세스가 열어 둔 rollout 파일로 터미널과 세션을 맞추며, 맞추지 못한 세션은 0이 아니라 `—`입니다. Insights 저장소(최대 5분마다 갱신)가 필요하고, 오버레이가 아니라 레이아웃의 칸으로 둡니다. 테마의 칸 머리줄에는 같은 세션의 모델·속도·effort·권한 모드·이번 주 비중이 나옵니다.

![칸 머리줄](docs/images/pane-header.png)

머리줄 고양이는 작업 중에는 달리고, 확인 필요·완료 상태에는 앉으며, 대기 중에는 잡니다. **Motion off**면 애니메이션이 멈춥니다. 모델·effort·권한·사용량은 대응이 확인된 세션의 값이며, 고양이 상태나 다른 칸의 값으로 사용량을 추정하지 않습니다.

머리줄의 이번 주 비중은 로컬 세션 기록을 가격 비율로 가중한 추정치입니다. 툴팁은 제공자가 알려 준 주간 사용량을 대략 나눠 보여 줄 수 있지만, 세션별로 따로 남아 있는 할당량은 아닙니다. 계정 전체 한도와 초기화 시각은 Plan Usage에 나옵니다.

### Document Viewer

![Document Viewer](docs/images/document-viewer.png)

프로젝트 파일 트리와 미리보기 패널. Markdown(macOS에서는 이미지·PDF·로컬 HTML을 읽기 전용 WebKit 스냅숏으로도)을 Source·Open과 함께 보여 줍니다. Files 패널이 있는 레이아웃에 설치되고 검토한 원본(Preview Plus / Files Plus)을 고정 커밋으로 받습니다. Windows에서는 HTML이 소스로 열리고 HTML 탭에 macOS 렌더러가 필요하다는 안내가 나오며, Markdown 미리보기와 저장 시 새로고침은 됩니다.

## 프로젝트 문서

워크스페이스 옆 화살표를 펼치면 설정한 문서 폴더가 나옵니다. 검색은 해당 공간의 파일명을 걸러 주고, Enter는 첫 결과를 열며, **Cmd+Option+F**는 같은 검색창에 포커스를 둡니다. 보관 경로는 요청할 때만 보여 주며 원본 문서는 보존합니다. 원본 위치는 `data/sixfold/project-docs.json` 또는 문서 탭 규칙 `data/sixfold/project-docs-pins.json`에 설정합니다.

선택적 **문서** 탭은 Files/Preview 패널과 별개인, 터미널 없는 프로젝트 문서 보기입니다. 고정·분류 목록·검색·읽기 전용 Markdown 미리보기를 제공하며, 설치하면 기존 개발 탭과 선택을 보존하면서 로컬 공간에 문서 탭을 추가합니다.

```sh
herdr-theme install-doc-tabs             # 읽기 전용 설치 계획
herdr-theme install-doc-tabs --install   # mod 검사·설치와 문서 탭 추가
```

로컬 공간을 더 만든 뒤에는 `--install`을 다시 실행하세요. 문서 규칙은 실제 공간 ID 기준이며 설정이 없으면 추측하지 않고 그 상태를 보여 줍니다. 선택적 로컬 문서 보기는 아래 생산자 계약으로 연결합니다. 원본 규칙·미리보기 지원·운영체제별 한계는 [프로젝트 문서 추적](docs/project-documents.md)을 참고하세요.

## 선택적 로컬 연동

이 표시는 앱 홈의 `data/sixfold/`에 별도로 설정한 로컬 생산자가 제공하는 파일을 읽습니다. 사용할 입력이 없으면 숨깁니다. 작업 정책과 동작 검증은 생산자가 맡으며, 테마 설치가 그 도구를 찾아내거나 설치하지는 않습니다. [연동 계약](docs/local-integrations.md)을 참고하세요.

**워크스페이스 배지.** 다른 mod·도구가 공유 상태 `sixfold.workspace.badges`나 `data/sixfold/workspace-badges.json`으로 워크스페이스 이름 옆에 작은 배지를 4개까지 올릴 수 있습니다.

```json
{ "<machine>|<space id>": [ { "id": "open", "text": "! 2", "tone": "blocked", "tooltip": "열린 항목 2개",
  "open": { "mod": "my-mod", "props": { "x": 1 }, "kind": "window", "key": "my-mod-x", "width": 800, "height": 600 } } ] }
```

이 컴퓨터의 `<machine>`은 빈 문자열입니다. 색조: `blocked`, `working`, `done`, `accent`, `dim`. 누르면 `open`을 그 mod의 오버레이로 열거나 `command`를 실행합니다. 글자는 12자까지, 잘못된 항목은 무시하며 공유 상태가 파일보다 우선합니다. 테마 자체는 배지를 올리지 않습니다.

**질문·권한 카드.** 선택한 외부 도구가 `data/sixfold/cards.json`에 일반 카드를, `data/sixfold/bridge.json`에 로컬 명령 prefix를 공급한다. 버튼은 JSON 요청 파일을 새로 만들고 그 경로만 설정된 명령에 넘긴다. 테마는 제목·선택지·버튼을 표시하며 검증과 처리는 외부 도구의 책임이다. 파일이 없으면 조용히 숨긴다. [일반 연동 계약](docs/local-integrations.md)을 따른다.

**채널 알림.** `data/sixfold/project-alerts.json`의 새 채널 메시지는 워크스페이스 제목 아래 줄에 나오고, `sixfold-slack-inbox` mod는 `data/sixfold/slack-mentions.json`의 멘션을 스레드별로 보여 줍니다. Slack에서 모으는 일은 별도 도구가 합니다.

**로컬 문서 보기·세션 보고.** 생산자는 `local-views/workspaces/index.json`에 공간별 문서 메타데이터를, `session-reports.json`에 표시용 요약을 제공합니다. 보고를 누르면 해당 터미널로 이동할 수 있지만, 보고가 세션을 닫거나 재개하지는 않습니다. 작업 추적과 세션 수명 관리 서비스는 테마에 포함되지 않는 외부 연동입니다.

## 워크스페이스 조작

**분할과 새 워크스페이스.** `herdr-theme balance-grid`는 아무것도 재시작하지 않고 6개 터미널 탭을 같은 크기로 맞추고, `herdr-theme workspace "Example" /path`는 **+ Space**처럼 워크스페이스를 만듭니다(`--shells`는 셸만, `--tiers high`는 그 한 칸을 해당 난이도의 모델로 엽니다. [모델 난이도 기본값](rust/src/automation/tiers.rs) 참고). 새 워크스페이스가 선택을 가져간 경우 이전 공간·탭·칸으로 되돌리며, 사용자가 다른 칸이나 탭을 직접 고른 경우에는 유지합니다. 알려진 한계: 생성이 중간에 실패하고 다른 프로세스가 동시에 만든 새 터미널을 사용자가 고르면, 그 선택 위로 이전 선택을 복원할 수 있습니다.

**고정 표시·아이콘·로컬 설정.** `data/sixfold/workspace-pins.local.json`(`{"spaces":[{"id":"…","machine":null}]}`)은 정확히 그 워크스페이스에 핀과 강조 테두리를 붙입니다. `herdr-theme set-workspace-icon 'ID 또는 이름' icon.png`는 프로젝트 아이콘(SVG/PNG/JPEG/WebP)을 지정합니다. 사람마다 다른 이름·색·폴더·Slack 주소는 `data/sixfold/site.local.json`(`config/site.example.json`에서 시작)에 두며, `"pane_header_index": true`는 칸 번호를 다시 보여 줍니다. `*.local.json`은 git이 무시합니다.


공용 워크스페이스와 프로젝트 칸 사이 메시지 전달: [COMMON_ROUTING.md](COMMON_ROUTING.md). 과부하 때의 협업: [docs/overload-collaboration.md](docs/overload-collaboration.md). 프로젝트 문서 추적: [docs/project-documents.md](docs/project-documents.md).

## 실행하는 것

UI는 Herdr의 워크스페이스·에이전트 API를 씁니다. 네이티브 도우미는 이 컴퓨터의 `hc`·`herdr-app`·계정 CLI를 실행하고, 설치기는 고정 버전을 받기 위해 Git을 실행합니다. 요금제 사용량 수집기의 기존 제공자 네트워크 요청은 네이티브 수집기에도 유지됩니다. 선택적 외부 어댑터는 소유자가 설정한 명령을 사용합니다. 개인 설정·계정 정보·세션 대응표는 이 저장소에 두지 않습니다.

## 개발

```sh
npm test
cargo test --manifest-path rust/Cargo.toml --locked --jobs 1 -- --test-threads=1
herdr-app check ~/.config/herdr-app/mods/sixfold-desk
```

클론마다 한 번 `sh scripts/install-git-hooks.sh`를 실행하면 `git push` 전에 `npm test`와 `node --check`가 먼저 돌고, 실패하면 push가 멈춥니다(일부러 건너뛸 때는 `git push --no-verify`). macOS 음성 테스트는 push마다가 아니라 수동 또는 주 1회(`Voice (macOS)` 워크플로) 돕니다.

`herdr-app check`는 mod 옆에 `gpui-kit.d.ts`와 `jsconfig.json`을 만듭니다. 커밋하지 마세요. 레이아웃 변경은 테스트만이 아니라 실제 화면으로 확인합니다. 더 새 Workspace Mods로 옮기려면 `workspace-mods.lock.json`의 `commit`(과 `tag`)을 바꾸고 updater를 실행합니다. 작업은 `main`에서 짧은 브랜치로 하며 설치본은 `main`을 따릅니다. 디자인 명세는 [RECIPE.md](RECIPE.md). Apache-2.0.
