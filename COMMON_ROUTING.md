# Share(옛 이름 공통)에서 프로젝트로 작업 전달

Share 워크스페이스 에이전트는 특정 프로젝트의 작업을 직접 처리하기 전에 해당 프로젝트 pane으로 전달한다.

```sh
python3 ~/work/projects/herdr-theme/scripts/route.py --enable
python3 ~/work/projects/herdr-theme/scripts/route.py "Project A" '사용자가 요청한 작업 원문과 범위'
python3 ~/work/projects/herdr-theme/scripts/route.py "Project B" '사용자가 요청한 작업 원문과 범위'
```

경로는 이 저장소를 받아 둔 위치로 바꾼다. 프로젝트 별칭(`project_aliases`)과 이름이 바뀌어도 Share로 인정할
공간 ID(`hub_space_ids`)는 저장소가 아니라 이 기기의 `~/.config/herdr-app/data/sixfold/site.local.json`에
둔다(예시: `config/site.example.json`).

- `--tier low|mid|high`(기본 high)로 작업 난이도를 준다. 그 tier 모델 세션을 먼저 고르고, 없으면 더 높은 모델 세션을 고른다. 낮은 모델에는 보내지 않는다. 모델을 모르는 세션은 high로 본다. 세션 모델은 칸 머리줄과 같은 `agent-usage.shares`에서 읽고, tier→모델 표는 이 기기의 `site.local.json` `model_tiers`에 둔다(ADR-0008, `scripts/model_tier.py`).
- 실제 발신 pane은 `HC_TERMINAL_ID`, 기존 TUI는 `HERDR_PANE_ID`와 로컬 연결표에서 읽는다. 위치를 추측하거나 다른 발신자로 가장하지 않는다.
- 프로젝트의 활성 탭에서 같은 위치를 먼저 선택한다. 작업 중·승인 대기·done·초안·REC·응답 끝의 질문이 있는 pane은 건드리지 않고, 같은 종류의 빈 에이전트, 다른 빈 에이전트 순으로 대체한다.
- 모두 바쁘면 로컬 대기열에 넣는다. Herdr Theme가 실행 중이면 빈 pane이 생겼을 때 전달한다. 작업을 끊거나 새 pane을 만들지 않는다.
- `sent`는 전송 결과다. 실제 대상 주소와 `fallback`을 사용자에게 짧게 알린다. `--reply`를 지정한 작업은 결과 회신을 읽고 판단한다.
- 전달 결과가 불명확한 오류는 자동 재전송하지 않는다. 중복 실행을 피하도록 확인 대기로 보존한다.
- 대기열은 작업 원문을 포함하므로 이 기기의 `data/sixfold/routing-queue.json`에 권한 0600으로 보관하고 Git에 넣지 않는다. 전달된 항목은 제거한다. 메시지 흐름 로그는 원문을 기록하지 않는다.
- 프로젝트 pane이 받는 전달에는 발신 주소가 포함된다. 여러 갈래 작업은 해당 세션의 서브에이전트로 처리한다. Share에는 사용자 결정이 필요할 때만 알리고 진행·완료 보고는 보내지 않는다. Share 발신자가 결과를 받아야 하면 `--reply`를 명시해 한 번만 회신을 요구한다.

이 규칙은 Share 워크스페이스에 있는 경우에만 적용한다. 프로젝트 자체의 pane에서는 그 프로젝트 작업을 수행한다.
