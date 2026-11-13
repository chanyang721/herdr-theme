# Herdr Theme

Herdr용 워크스페이스 사이드바와 터미널 레이아웃입니다. 여러 컴퓨터의 코딩 에이전트, 공동 프로젝트와 메시지를 보고, 터미널 옆에서 도구 상태와 사용량을 확인합니다.

[English](README.md)

![Herdr Theme: 이슈 확인부터 분담·검수·보관·정리까지 9단계 화면 안내](preview.gif)

네이티브 데모 캡처로 구성한 9단계 워크플로우 안내입니다. 합성 데이터이며 실제 업무의 종단 검증 녹화가 아닙니다. [움직임 없는 첫 장면](docs/media/workflow-poster.png).

## 주요 기능

- **컴퓨터와 워크스페이스:** 컴퓨터별 에이전트 수, 공동 프로젝트 표시, 읽지 않은 메시지와 메시지 경로 애니메이션.
- **작업 표시:** 선택적 로컬 피드의 작업 트리, 진행 단계, 이슈 그룹, 검토 이벤트와 7가지 픽셀 상태 애니메이션. 작업 관리는 피드 제공 도구가 맡고 테마는 이를 표시합니다.
- **터미널 헤더:** 에이전트 상태·모델·추론 강도·세션 사용량과 움직이는 고양이. 모션을 끌 수 있습니다. Claude 칸에는 할 일 진행률(`할 일 2/5`)과 실행 중인 서브에이전트 수도 나오며, Agent Usage가 Claude 자체 기록에서 읽습니다(2분마다 갱신, 6분 넘게 갱신이 없으면 숨김).
- **모니터 스트립:** 고정 버전의 [Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)가 제공하는 CPU/RAM, MCP 연결, CLI 로그인 상태, Claude/Codex 한도와 세션별 토큰.
- **프로젝트 문서:** 워크스페이스 문서 검색, 고정과 문서 전용 탭. 선택적 파일 뷰어에서 터미널 옆에 Markdown을 띄웁니다.

## 화면으로 따라가는 워크플로우

메인 GIF는 짧은 실제 데모 화면 애니메이션에 이어 **이슈 확인 → 배정 → 병렬 작업 → 메시지 → 검수 요청 → 판정 → 수락 → 보관 → 정리**의 9개 장면을 약 46초 동안 보여줍니다. 각 장면의 설명은 캡처 옆에 붙였으며 앱 UI를 새로 그린 것이 아닙니다.

기존 네이티브 앱의 **가상 데이터 캡처를 순서대로 구성한 설명용 GIF**입니다. 하나의 실제 작업이 자동으로 끝까지 실행된 녹화나 실업무 검증 결과가 아닙니다. [원래 화면 동작 GIF](docs/images/overview-native.gif) · [장면별 출처와 재생 시간](docs/media/workflow-manifest.json) · [전체 화면 정지 이미지](preview.png).

| 1. 이슈와 작업 선택 | 2. 분담과 협업 |
| --- | --- |
| ![마일스톤과 프로젝트 이슈를 확인하는 패널](docs/images/panel-feed/issues-milestone.png) | ![부모 작업 아래 펼쳐진 다섯 자식 작업](docs/images/panel-feed/tree-expanded.png) |
| 주간·마일스톤·전체 범위에서 이슈를 확인합니다. 캐시가 없거나 오래된 경우도 구분합니다. | 부모 아래 자식 작업과 실제 작업 제목을 표시합니다. 분담 실행과 소유 영역 관리는 외부 하네스가 담당합니다. |

| 3. 메시지와 검수 | 4. 결과 보관과 정리 |
| --- | --- |
| ![검수 요청이 다른 에이전트로 이동하는 화면](docs/images/panel-feed/event-review_request.png) | ![결과 보관 단계가 표시된 작업 패널](docs/images/panel-feed/closing-memory-2.png) |
| 배정·메시지·검수 요청·판정·수락을 별도 이벤트로 표시합니다. 메시지 전송은 읽음이나 작업 성공을 뜻하지 않습니다. | 보관 상태와 닫힘 단계를 표시합니다. 실제 보관·종료는 피드 제공자의 정책에 따르며 테마가 직접 수행하지 않습니다. |

[자식 작업 완료 후 목록 변화](docs/images/panel-feed/children-completed-removed.png) · [닫힌 행이 제거된 모습](docs/images/panel-feed/closing-memory-4-hidden.png) · [전체 이벤트·상태 갤러리](docs/panel-validation.md).

## 기능별 화면

### 컴퓨터·공동 프로젝트·이슈 연결

| 다크 | 라이트 |
| --- | --- |
| ![다른 컴퓨터와 연결된 프로젝트 및 에이전트 관계 — 다크](docs/images/collab-multi-dark.png) | ![동일한 공동 프로젝트 표시 — 라이트](docs/images/collab-multi-light.png) |

컴퓨터 선택, 공동 프로젝트 연결, Slack·Linear/Jira 공급 데이터, 이슈별 에이전트를 한 패널에서 봅니다. 실제 계정 연결은 별도 설정입니다. [공유·도구·Slack 조합별 48개 화면](docs/panel-validation.md).

### 작업 상태와 터미널 헤더

![일곱 가지 에이전트 상태의 네이티브 렌더링 데모](docs/images/session-states.gif)

작업 중·대기·사용자 확인·미확인 결과·정리 대기·닫는 중·닫힘을 구분합니다. 색과 아이콘만으로 작업 성공을 추정하지 않고 피드 상태를 따릅니다.

탭의 마지막 패인이 열려 있어도 작업 수락과 결과 저장은 진행할 수 있습니다. 실제 정리는 제공자가 결과를 기록·보관한 뒤 수행하며, 가득 찬 진행률만으로 정리 완료를 뜻하지 않습니다. [수명주기 계약과 검증 기준](docs/workflow-lifecycle.md).

![모델·추론 강도·사용량·고양이 상태가 있는 터미널 헤더](docs/images/pane-header.png)

![세션별 사용량 상세](docs/images/agent-usage.png)

헤더는 에이전트 모델·상태와 세션 사용량을 표시합니다. 현재 Claude 할 일 수·서브에이전트 수는 연결된 Agent Usage 기록을 따르며 최대 2분 늦을 수 있습니다. 정지 캡처에 모든 동적 필드가 동시에 나오지는 않습니다.

### 도구 연결·리소스·플랜 한도

| 표시 | 화면 | 의미 |
| --- | --- | --- |
| CPU/RAM | ![CPU와 RAM 스트립](docs/images/system-metrics.png) | 기기의 자원 사용량 |
| MCP | ![MCP 도구 연결 표시](docs/images/mcp-status.png) | 공급자가 보고한 도구 연결 상태 |
| CLI | ![CLI 로그인 상태](docs/images/cli-status.png) | CLI별 인증 상태 |
| 플랜 한도 | ![Claude와 Codex 플랜 사용량](docs/images/plan-usage.png) | 계정 한도이며 개별 에이전트 토큰 합계와 다름 |

Workspace Mods의 선택적 연동입니다. 이미지에 보이는 연결 서비스가 테마 설치만으로 자동 인증되는 것은 아닙니다.

### 프로젝트 문서

<img src="docs/images/document-viewer.png" width="375" alt="터미널 옆에서 여는 데모 Markdown 문서" />

문서를 검색·고정하고 문서 탭 또는 선택적 파일 뷰어에서 확인합니다. 이미지에는 별도 파일 뷰어가 보입니다. [문서 검색·고정·탭 설정](docs/project-documents.md) · [파일 뷰어 설치](extras/preview/README.md).

### 주간 칩·타임라인·이슈 상세

최신 `week-timeline`은 상시 큰 띠 대신 헤더 칩에서 열립니다. 아래는 **동작 경로 설명도**이며 실제 화면 캡처가 아닙니다.

```mermaid
flowchart LR
  A[헤더의 이번 주 칩] --> B[프로젝트별 주간 작업]
  B --> C[프로젝트 전체 타임라인]
  B --> D[이슈 상세]
  D --> E[변경 검토와 명시적 Linear 반영]
```

팝업은 터미널 위에 뜨며 상시 터미널 공간을 차지하지 않습니다. 이슈 변경은 설정된 명령과 명시적 반영 절차를 사용합니다. [최신 동작과 설정](docs/week-timeline.md). 이 기능의 새 네이티브 캡처는 아직 이 갤러리에 포함하지 않았습니다.

## 메시지 이펙트의 지원 범위

2026-11-12 확인 기준, 코어 [#90](https://github.com/herdrdev/herdr-core/pull/90)은 머지 없이 닫혔고 후속 [#167](https://github.com/herdrdev/herdr-core/pull/167)은 아직 열려 있습니다. 따라서 **일반 배포판 설치만으로 네이티브 메시지 이벤트가 있다고 가정하면 안 됩니다.**

- 후속 이벤트의 발신자는 `data.from`, 수신자는 이벤트의 `terminal`입니다. 앱의 `messageEvents()` 연결도 같은 형식에 맞아야 합니다.
- 이 이벤트는 명시적 send 입력 시도의 관측입니다. 읽음·업무 수락·완료는 별도의 근거가 필요합니다.
- 자동 실행의 첫 작업·키 입력·자동 부모 알림은 이 이벤트 대상이 아닙니다. 작업 배정은 선택적 하네스 피드에서 별도로 표시합니다.
- 데모 화면은 합성 이벤트를 사용합니다. 실제 수집 경로, 원격 주소, 재연결과 발신자 미확인 처리는 설치 조합에서 따로 검증해야 합니다.

## 설치

Herdr 0.1.11 이상, 호환되는 herdr-core, Git, stable Rust와 C 컴파일러가 필요합니다. Windows 빌드는 MSVC C/C++ Build Tools 또는 완전한 GNU 호환 도구 체인이 필요합니다.

```sh
git clone https://github.com/chanyang721/herdr-theme.git
cd herdr-theme
cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1
```

macOS / Linux:

```sh
./rust/target/release/herdr-theme install
herdr-app do layout.switch --name sixfold
```

Windows PowerShell:

```powershell
.\rust\target\release\herdr-theme.exe install
herdr-app do layout.switch --name sixfold
```

설치기는 `~/.config/herdr-app`에 테마와 고정 버전 Workspace Mods를 설치합니다(`HERDR_APP_HOME`으로 변경 가능). 다른 레이아웃과 설정을 보존하며 기존 설치를 임의로 덮어쓰지 않습니다. 이전 설치 갱신에는 `--update`를 사용하며, 직접 수정한 레이아웃과 팔레트는 유지됩니다. 작은 창에는 [Windows용 간결한 레이아웃](extras/windows-layout/README.md)을 참고하세요.

이후 변경은 검토한 소스를 빌드하고, 설치할 파일을 지정해 갱신합니다.

```sh
herdr-theme update-install mods/sixfold-desk/main.js mods/sixfold-desk/model.js
```

PATH에 없다면 빌드한 실행 파일의 경로를 사용하세요. 갱신기는 해당 모드를 검사하고 설치 파일을 백업한 뒤 앱 상태를 확인합니다. 앱이나 코어를 재시작하지 않습니다. [네이티브 도구와 갱신 상세](docs/native-rust-migration.md).

## 지원과 설정

사이드바와 모니터 스트립은 macOS와 Windows를 지원합니다. Linux는 네이티브 도구 경로가 있지만 데스크톱 UI는 검증하지 않았습니다. 음성과 HTML 스냅샷은 macOS 전용입니다. 메시지 애니메이션은 호환되는 앱·코어의 메시지 이벤트가 필요합니다. Agent Usage는 별도 설치한 [Insights](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights) 모드와 로컬 저장소가 필요합니다.

원격 연결, 에이전트 인증과 선택적 작업 피드 도구는 별도로 설정합니다. 테마는 작업 관리 서비스를 설치하지 않습니다. 개인 설정은 Git에서 제외되는 `*.local.json`에 저장하며, [site.example.json](config/site.example.json)에서 시작할 수 있습니다.

| 자세한 내용 | 안내 |
| --- | --- |
| 작업 피드·단계·상태 이미지 | [피드 규격](docs/panel-feed.md) · [네이티브 UI 갤러리](docs/panel-validation.md) |
| 문서 검색과 고정 | [프로젝트 문서](docs/project-documents.md) · [파일 뷰어](extras/preview/README.md) |
| 배지·질문 카드·보고 | [로컬 연동](docs/local-integrations.md) |
| 배치와 플랫폼별 옵션 | [모니터 스트립](extras/monitor-layout/README.md) · [Windows](extras/windows-layout/README.md) · [음성](voice/README.md) |

## 개발

```sh
npm test
cargo test --manifest-path rust/Cargo.toml --locked --jobs 1 -- --test-threads=1
```

클론마다 `sh scripts/install-git-hooks.sh`를 한 번 실행해 push 전 검사를 켜세요. 모드를 수정하면 `herdr-app check <mod-folder>`로 검사하고 실제 앱 화면도 확인합니다. [설계 개요](RECIPE.md) · [Apache-2.0](LICENSE).
