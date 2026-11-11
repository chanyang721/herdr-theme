# Herdr Theme

Herdr용 워크스페이스 사이드바와 터미널 레이아웃입니다. 여러 컴퓨터의 코딩 에이전트, 공동 프로젝트와 메시지를 보고, 터미널 옆에서 도구 상태와 사용량을 확인합니다.

[English](README.md)

![Herdr Theme: Windows 네이티브 앱의 워크스페이스, 에이전트 상태와 메시지](preview.gif)

가상 프로젝트·작업·메시지 이벤트를 넣고 Windows 네이티브 앱에서 촬영했습니다. [정지 이미지](preview.png).

## 주요 기능

- **컴퓨터와 워크스페이스:** 컴퓨터별 에이전트 수, 공동 프로젝트 표시, 읽지 않은 메시지와 메시지 경로 애니메이션.
- **작업 표시:** 선택적 로컬 피드의 작업 트리, 진행 단계, 이슈 그룹, 검토 이벤트와 7가지 픽셀 상태 애니메이션. 작업 관리는 피드 제공 도구가 맡고 테마는 이를 표시합니다.
- **터미널 헤더:** 에이전트 상태·모델·추론 강도·세션 사용량과 움직이는 고양이. 모션을 끌 수 있습니다. Claude 칸에는 할 일 진행률(`할 일 2/5`)과 실행 중인 서브에이전트 수도 나오며, Agent Usage가 Claude 자체 기록에서 읽습니다(2분마다 갱신, 6분 넘게 갱신이 없으면 숨김).
- **모니터 스트립:** 고정 버전의 [Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)가 제공하는 CPU/RAM, MCP 연결, CLI 로그인 상태, Claude/Codex 한도와 세션별 토큰.
- **프로젝트 문서:** 워크스페이스 문서 검색, 고정과 문서 전용 탭. 선택적 파일 뷰어에서 터미널 옆에 Markdown을 띄웁니다.

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
