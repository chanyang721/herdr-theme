# Codex 마이크 포커스 기본값

`focusq install`은 `<label_prefix>.herdr-codex-focus` 사용자 LaunchAgent를 기본 설치한다(`label_prefix`는 `~/.config/herdr-app/data/sixfold/site.local.json`, 기본 `local.herdr-sixfold`).
이미 플러그인이 설치되어 있으면 다음 명령으로 이 제어기만 적용한다.

```sh
herdr-theme install_codex_focus
```

테마·레이아웃·키·settings와 Codex 설정 파일은 수정하지 않는다.
Herdr App 창의 `status.agent`를 조회하고 core labels의 `sixfold.source-pane`으로 TUI bridge를 매핑한다.
사이드바 heartbeat가 멈춰도 별도 프로세스가 기존 연결의 마이크만 F9로 제어한다.
F9는 해당 화면 footer에 `f9 mute` 또는 `f9 unmute`가 확인될 때만 보낸다.

- 비포커스의 listening 세션을 먼저 음소거하고 확인한 후 포커스 세션을 재개한다.
- 제어기가 직접 음소거한 동일 프로세스만 자동 재개한다. 처음부터/사용자가 활성 상태에서 음소거한 세션은 유지한다.
- 포커스나 프로세스 식별이 불명확하면 자동 재개하지 않는다. iTerm 전면 여부만으로 실제 창/탭을 알 수 없어 Herdr App 이외에서는 자동 재개하지 않는다.
- 이벤트 처리와 감시 프로세스는 같은 파일 잠금으로 직렬화한다. sidebar `--app-focus`는 새 `/voice` 연결을 시작하지 않는다.
개인 음성 입력 설정은 사용자 로컬 설정에 두고, 이 저장소에는 일반 설정 예시만 유지한다.

감시는 한 번의 처리 완료 후 0.5초를 기다린다. 실제 주기는 CLI 응답·화면 조회·키 확인 시간에 따라 더 길다.
Codex가 음소거 상태를 표시하기 전 전송된 음성이나 이미 전달된 발화를 취소하지 않는다.
footer를 읽지 못하거나 core가 응답하지 않으면 음소거 성공을 보장할 수 없다.
같은 프로세스에서 관찰 사이에 음성 연결을 종료/재시작하면 호출 세대까지 구분하지 못한다.

검증은 `CARGO_BUILD_JOBS=1 cargo test --manifest-path rust/Cargo.toml voice::queue`로 실행한다.
전체 기존 테스트 중 중첩 블록이 많은 파일은 Python 3.14에서 실행한다.
실제 마이크 수신, 채팅 반영, 재생, 녹음 저장은 각각 별도 검증이 필요하다.

감시기만 제거하려면 `herdr-theme install_codex_focus --uninstall`을 실행한다.
이 명령은 음성 연결을 종료하거나 마이크를 다시 켜지 않는다. 플러그인 전체 제거는 `focusq uninstall`이다.
