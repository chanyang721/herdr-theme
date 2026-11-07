# 에이전트 칸을 열 때 부모 표식 지우기

Claude·Codex 안에서 `herdr-app do space.new|tab.new|pane.split --argv …`로 칸을 열면 새 칸이 부모 에이전트의 환경 변수를 그대로 받는다(2026-11-04 확인).

| 물려받는 값 | 결과 |
| --- | --- |
| `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` | 새 Claude가 자식 세션이 되어 전사 저장이 꺼진다(`Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION`). 사용량·세션 식별이 모두 그 세션을 못 찾는다. |
| `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID` | Herdr의 SessionStart 훅이 새 세션을 **부모의 원본 칸**에 보고해 그 칸의 `agent_session`을 덮어쓴다. |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_*` 등 | 부모 세션 값이 그대로 남는다. |

`env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDECODE claude`만으로는 전사 저장은 켜지지만 `HERDR_PANE_ID`는 남는다.

## 안전한 실행 형식

스크립트에서는 `rust/src/automation/mod.rs`의 `launch_argv()`를 쓴다(`herdr-theme workspace`가 쓰는 방식). 손으로 쓸 때는 아래 argv를 쓴다.

```sh
herdr-app do space.new '{"name":"<이름>","folder":"<폴더>","argv":["env","-u","CLAUDECODE","-u","CLAUDE_CODE_CHILD_SESSION","-u","CLAUDE_CODE_ENTRYPOINT","-u","CLAUDE_CODE_EXECPATH","-u","CLAUDE_CODE_SESSION_ID","-u","CLAUDE_CODE_SESSION_ATTENDED","-u","CLAUDE_CODE_MESSAGING_SOCKET","-u","CLAUDE_CODE_MESSAGING_TOKEN","-u","CLAUDE_PID","-u","CODEX_THREAD_ID","-u","HERDR_PANE_ID","-u","HERDR_TAB_ID","-u","HERDR_WORKSPACE_ID","claude"]}'
```

같은 argv 생성 함수는 `rust/src/automation/mod.rs`의 `launch_argv()`다. 이미 떠 있는 셸에서 바로 실행할 때는 `<앱 홈>/scripts/sixfold/herdr-theme agent_env claude …`를 쓴다(Windows는 `herdr-theme.exe`). 이 경우 hc 터미널(`HC_TERMINAL_ID`가 있음)에서만 `HERDR_*` 칸 표식을 지우고, Herdr 원본 칸에서는 그 칸 자신의 값을 남긴다.


`env -u`는 macOS·Linux의 `env(1)`에 있다. Windows에는 `env`가 없어서 `launch_argv()`가 argv를 그대로 돌려준다.

## Codex 칸의 머리줄 사용량

daemon에 붙은 Codex TUI는 rollout 파일을 열어 두지 않는다. 그래서 수집기는 터미널 제목(`thread-name | project`)으로 대화를 찾는다. 그런데 TUI가 thread 이름을 갖고 있지 않으면 Codex 0.166은 그 항목을 빼고 제목을 `project`만으로 쓰고, 그러면 그 칸은 `세션 미확인`이 된다. `~/.codex/config.toml`의 `[tui]`에 아래 설정을 넣으면, 이름이 없을 때 그 자리에 thread ID가 나와 정확히 대조할 수 있다. 새로 연 Codex 세션부터 적용된다.

```toml
[tui]
terminal_title = ["activity", "thread-title", "project-name"]
```
