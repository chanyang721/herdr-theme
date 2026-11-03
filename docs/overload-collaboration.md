# 프로젝트 과부하 협업

기본은 같은 세션의 서브에이전트다. 세션이 독립 작업을 명시적으로 원장에 등록하면, 같은 프로젝트 공간에서 과부하일 때 빈 세션에 배분한다. 기존 Share 전달 `route.py`, LukukuWatch 작업 파일을 재전송하거나 소비하지 않는다. 각자 독립 원장과 잠금을 사용한다.

## 등록과 실행

설치 경로의 도구를 사용한다. `HC_TERMINAL_ID`가 발신 주소를 확인한다. 자동 환경 변수가 없는 수동 도구에서만 `--from 실제주소`를 지정한다. 환경 변수와 `--from`이 다르면 거부한다.

```sh
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py enqueue \
  --id feature-a-20261103 --batch feature-20261103 \
  --mode worktree --owns 'src/feature/**,tests/feature/**' \
  --text '독립적으로 끝낼 수 있는 작업과 검증 방법'
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py enqueue \
  --id readme-count-20261103 --batch feature-20261103 \
  --mode read-only --text 'README.md 줄 수를 읽기 전용으로 확인'
```

등록 후 원 세션에서 직접 할 일은 실행 전에 `start ID`로 선점한다. 임대가 먼저 생기면 `start`가 실패하므로 그 작업을 직접 수행하지 않는다. 수신 세션은 지시문에 포함된 `accept ID --lease TOKEN`이 성공한 뒤에만 실행한다. 다른 세션의 작업 폴더에 쓰지 않으며, 쓰기 작업은 별도 worktree를 쓴다. `--owns`는 저장소 상대 경로를 쉼표로 나눈다. `..`와 절대 경로는 거부한다. 진행 중인 쓰기 작업과 소유 범위가 겹치면 분배를 보류한다. glob이 애매하면 상위 디렉터리를 통째로 예약한다. 이는 이 원장에 참여한 작업 사이의 보호이며, 다른 도구의 파일 쓰기를 OS에서 막지는 않는다.

```sh
# 원 세션이 직접 실행할 때만
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py start feature-a-20261103
# 임대 받은 세션: 메시지의 토큰 사용
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py accept TASK_ID --lease TOKEN
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py complete TASK_ID --lease TOKEN --result '직접 검증한 결과'
# 원 세션의 local_active 작업 완료에는 --lease가 필요 없다.
```

원 세션이 `status`로 완료를 확인하고, 같은 `--batch`의 모든 작업이 완료되면 `report --batch BATCH`로 결과를 한 번 수집해 사용자에게 보고한다. 동일 batch의 두 번째 report는 `already_reported`이며 본문을 다시 내보내지 않는다. 이미 보고한 batch에 새 작업을 추가할 수 없다. 수신 세션은 개별 `hc` 완료 회신을 보내지 않는다. Share에는 진행·완료 알림을 보내지 않는다.

```sh
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py status
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py report --batch feature-20261103
```

## 자동 분배와 설정

`enable`은 `data/sixfold/collaboration.json`에 설치된 스크립트 주소와 설정을 기록한다. sidebar가 켜진 설정의 스크립트를 `drain`으로 주기 실행한다. 수동 `drain`과 `--drain`도 지원한다. 기존 route 대기열이 비어 있어도 독립적으로 작동한다. 새 세션·공간·탭을 만들지 않으며 포커스를 옮기지 않는다.

```sh
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py enable
python3 ~/.config/herdr-app/scripts/sixfold/collaborate.py drain
```

기본 조건은 원장에 등록된 해당 발신 세션의 pending 2건 이상, 가장 오래된 pending 600초 이상, local_active 3건 이상 중 하나다. 설정 키는 `pending_count`, `oldest_seconds`, `active_count`이며 양의 정수다. `enabled:false`로 자동 분배를 끈다. `exclude_spaces`에 추가 공간 이름·ID를 넣을 수 있지만 Share/공통/common 및 기존 Share ID 제외는 해제할 수 없다. 이후 추가 프로젝트도 같은 규칙을 적용한다.

목록에서 idle/done인 같은 프로젝트 세션만 후보가 된다. 전송 직전 `hc get`에서 원시 idle을 재확인하고, `hc read`로 빈 입력창·음성 비수신·확인 질문 부재를 검사한 뒤 `hc send --if idle`을 쓴다. 목록의 done은 core/app의 완료 미확인 합성 상태일 수 있으며 원시 get이 idle이면 전달된다. 원시 상태 자체가 done이면 현재 CLI에 `--if done`이 없어 대기한다. 입력창 검사와 native 상태 guard는 하나의 트랜잭션이 아니므로 그 사이 사용자 타이핑을 OS 수준에서 잠그지는 않는다.

수신자가 없으면 pending을 유지한다. 보내기 전에 작업별 lease 파일과 sending 상태를 저장한다. 토큰·수신자 확인 없이 수락·완료를 변경할 수 없다. timeout/불명확 실패·프로세스 중단·고아 lease는 자동 재전송하지 않는다. lease 만료나 재배정도 없다. native가 입력 미전송을 보장하는 `status_mismatch`/`blocked`/`finished`/`not_found`만 pending으로 되돌린다. 파일은 `data/sixfold/collaboration-tasks.json`, `collaboration-leases/`, `collaboration.lock`이다. 손상된 원장은 초기화하지 않고 중단한다.

## 검증 범위와 남은 한계

`tests/test_collaborate.py`는 과부하 세 조건, 두 수신자 배분, 수락/완료 권한, 원 세션 단독 수집 1회, 파일 소유 충돌, 재전송 차단, Share 제외, done 목록/idle 원시 상태, 입력·음성·질문 보호를 검사한다. subprocess E2E는 격리된 가짜 `hc`/`herdr-app` 실행 파일과 실제 CLI·잠금·lease·원장 파일을 사용한다. `COLLABORATION_E2E_EVIDENCE=/path/result.json`을 설정하면 명령·전송·결과 증거를 보관한다. 이것만으로 실제 사용자 세션 전송을 검증했다고 말하지 않는다.

**모든 raw `hc` 메시지의 미처리 여부나 임의 에이전트의 독립 작업 수를 자동 관측하지 않는다.** 현재 `hc schema`에는 이 의미를 판정할 처리 원장이 없다. 메시지 send/working 상태만 보고 실행 중인 지시를 다시 넘기면 원 세션과 중복 실행할 위험이 있으므로 등록된 작업만 사용한다. 기존 route로 받은 지시도 원 세션이 독립 작업으로 나누어 enqueue/start해야 한다. 현재 완료 기록은 파일로 수집되며 원 세션 자동 깨우기·자동 사용자 발화는 구현하지 않는다. 원 세션이 status/report를 실행해야 한다. at-most-once는 중복을 막는 대신 결과 불명확 시 자동 복구를 포기한다. 실제 실행이 중단된 작업의 취소·재배정은 별도 확인이 필요하다.

실제 core 전달 시험은 `python3 tests/native_collaboration.py /tmp/native-collaboration.json`으로 실행한다. 별도 HC_SESSION과 scratch XDG 경로에서만 core와 deterministic 읽기 전용 수신 프로세스 둘을 사용하고 종료한다. workspace 목록만 fixture이며 전송·PTY 수신·수락·실제 README 줄 수 계산·완료·원 세션 통합 출력은 실제 프로세스와 원장으로 확인한다. 사용자 LLM 세션의 자율 수행 검증은 아니다.
