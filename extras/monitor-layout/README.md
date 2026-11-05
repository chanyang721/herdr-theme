# 선택 설치 모니터 레이아웃

실제 설치본의 `sixfold` 레이아웃에서 모니터 줄을 보관한 파일입니다. 2026-11-03 설치본 동기화로 기본 `layouts/sixfold.json`도 현재 설치된 모니터 줄을 포함합니다.

이 레이아웃에는 `system-metrics`, `mcp-status`, `cli-status`, `agent-usage`, `plan-usage`가 별도로 설치되어 있어야 합니다. 다섯 모드 모두 [Herdr Workspace Mods](https://github.com/chanyang721/herdr-workspace-mods)의 설치 지침을 따릅니다. `plan-usage`는 Codex·Claude 구독 한도와 Codex 초기화권을 보여주며, 이전의 Usage Bar 자리를 대신합니다. 각 pane 머리줄 가운데의 `이번 주 ▬ N%`는 그 세션이 현재 주간 한도 기간에 쓴 비중으로, `plan-usage`가 `agent-usage` 수집기로 계산해 공유 상태(`agent-usage.shares`)에 올린 값을 `sixfold-desk`가 읽어 그립니다. 값이 없으면 아무것도 그리지 않습니다. 계정 할당량과 세션 토큰 사용량은 서로 다른 값입니다.

필요한 모드를 설치한 다음 이 파일을 앱의 `layouts/sixfold-monitor.json`으로 복사하면 선택 가능한 별도 레이아웃이 됩니다. 기본 설치기는 extras의 파일과 외부 모드 자체를 설치하지 않습니다. 기존 사용자의 테마·레이아웃 선택은 변경하지 않습니다.

설치본의 문서 어댑터 `sixfold-files`, `sixfold-docs`는 이미 `extras/preview/mods`와 일치합니다. 다운로드한 upstream, 라이선스, 캐시, 레이아웃의 `.state`와 백업 파일은 이 스냅샷에 포함하지 않습니다.

테마 비교: `sixfold-day`·`sixfold-night`는 최초 비교에서 저장소와 설치본이 일치했습니다. `themes/atom-one-dark.json`·`themes/win98.json`은 Herdr 설치본에서 가져온 팔레트입니다. 기본 설치기는 동일 이름의 기존 팔레트가 있으면 보존합니다. JSON-RPC의 타임아웃과 자식 프로세스 정리는 `rust/src/automation/mod.rs`의 네이티브 구현을 사용합니다.

격리 화면 검증 뒤 Day의 오프라인 아이콘용 `dim`, Win98의 `dim` 및 어두운 ANSI 색을 보정했습니다. Win98은 실제 터미널에 `colors.background`의 검정 배경이 적용되므로 ANSI 대비는 검정 배경에서 확인합니다. 테마 선택 설정은 바꾸지 않습니다.

Atom One Dark와 Night에서도 실제 터미널 검사에서 어둡던 ANSI black·bright black을 텍스트로 읽을 수 있는 회색으로 보정했습니다. ANSI 색을 명시한 프로그램의 검정 배경에도 이 팔레트 값이 사용될 수 있습니다.
