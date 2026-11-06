# 음성 (voice/)

Herdr Theme 의 음성 기능이다. herdr 플러그인(id `local.focus-queue`)으로 동작한다. 여러 AI 에이전트(Claude Code, Codex)를 herdr pane 으로 띄워 놓고 **헤드셋으로 말로 지시하는** 사람을 위한 herdr 플러그인이다.

- **포커스 대기열**: 일이 끝났거나 승인을 기다리는 pane 으로 포커스를 옮겨 준다. 지금 보고 있는 pane 에 말하거나 입력하는 중이면, 끝날 때까지 기다렸다가 넘긴다.
- **음성이 포커스를 따라감**: 포커스된 pane 만 마이크를 받고, 나머지 pane 은 녹음을 끄거나 음소거한다.
- **말이 끝나면 전송**: 포커스된 Claude pane 에 말하면 입력창에 받아써지고, 문장을 끝맺고(마침표 등) 말을 2초 멈추면 전송된다. 따로 전송 단어를 말하거나 Enter 를 칠 필요가 없다.
- **목소리 확인**: 마이크마다 한 번 등록한 그 기기 주인의 목소리로, 본인 목소리로 판정된 받아쓰기만 자동 전송한다. macOS 기본 입력이 헤드셋이 아니면 받아쓰기를 켜지 않는다. 목소리 데이터는 기기마다, 마이크마다 따로 두고 공유하지 않는다.

## 목차

- [빠른 시작](#빠른-시작)
- [요구 사항](#요구-사항)
- [설치](#설치)
- [사용 방법](#사용-방법)
- [목소리 확인](#목소리-확인)
- [명령어](#명령어)
- [파일과 경로](#파일과-경로)
- [설정 바꾸기](#설정-바꾸기)
- [문제 해결](#문제-해결)
- [업데이트와 삭제](#업데이트와-삭제)
- [이전 설치에서 옮기기](#이전-설치에서-옮기기)
- [지원 환경](#지원-환경)
- [한계](#한계)

## 빠른 시작

아무것도 없는 Mac 기준이다. 이미 있는 단계는 건너뛴다.

1. Homebrew 설치 (Xcode Command Line Tools 도 같이 깔린다): <https://brew.sh>
2. Claude Code 설치·로그인 (<https://code.claude.com>). Codex 는 선택
3. Herdr Theme 저장소를 받고 `cargo build --manifest-path rust/Cargo.toml --locked --release --bin herdr-theme --jobs 1`로 실행 파일을 만든 뒤 저장소 폴더에서 음성 설치를 실행한다. herdr·PortAudio가 없으면 같이 깔고, herdr를 아직 띄우지 않았어도 된다
   ```sh
   bash voice/install.sh
   ```
4. 터미널에서 `herdr` 를 실행하고(또는 Herdr 앱), pane 안에서 `claude` 를 띄운다. 이미 떠 있던 Claude Code 세션은 다시 시작한다
5. 에이전트가 없는 셸 pane 에서 목소리를 등록한다. 주변에 말하는 사람이 없을 때 45초 동안 말한다. 헤드셋이면 이때 자동 전송이 허용된다
   ```sh
   ~/.local/share/herdr-focus-queue/plugin/focusq voice-enroll
   ```
6. Claude pane 에 포커스를 두고 말한다. 처음 녹음할 때 macOS 가 마이크 권한을 물으면 허용한다. 문장을 끝내고 말을 멈추면 바로 전송된다

## 요구 사항

| 항목 | 내용 |
|---|---|
| OS | macOS (네이티브 Rust 실행 파일) |
| Homebrew | 없는 도구(herdr, PortAudio)를 설치하는 데 쓴다. <https://brew.sh> |
| herdr | 0.9.0 이상. 없으면 설치 중에 Homebrew 로 깐다. 설치할 때 herdr 가 떠 있지 않아도 된다 |
| Claude Code | 직접 설치·로그인. 음성 받아쓰기(`voice`)를 쓸 수 있는 버전 |
| Codex CLI | 선택. 쓰면 F9 로 마이크를 켜고 끈다 |
| 마이크 | macOS 입력 장치로 선택된 헤드셋 권장 |

## 설치

### 설치가 하는 일

`herdr-theme voice-install` 가 아래를 한다. `install.sh` 는 없는 도구(herdr, PortAudio)를 Homebrew 로 깐 뒤 이것을 부른다. 테마를 `herdr-theme update-install voice` 로 설치·업데이트해도 같은 일을 한다. 여러 번 실행해도 안전하다.

1. `voice/` 를 `~/.local/share/herdr-focus-queue/plugin` 에 복사한다. 저장소 폴더를 직접 실행하지 않으므로, 작업 중인 worktree 를 바꾸거나 고쳐도 실행 중인 음성 기능은 바뀌지 않는다. 업데이트는 폴더를 한 번에 맞바꾸므로, 그 사이에 뜬 herdr 이벤트는 옛 복사본이나 새 복사본 중 하나를 온전히 실행한다
2. 그 복사본의 `focusq install` 로:
   - herdr 에 플러그인 연결·활성화 (`herdr plugin link`, `herdr plugin enable`). 다른 폴더에 연결돼 있으면 옮긴다
   - Claude Code 음성 설정과 전송 직전 검사 hook (아래 "바꾸는 파일"). 다른 폴더의 hook 은 같은 쓰기에서 바꾼다
   - Codex 마이크 관리 LaunchAgent (`<label_prefix>.herdr-codex-focus`, 기본 `local.herdr-sixfold.herdr-codex-focus`)
   - Herdr 앱 포커스 연동 (`~/.config/herdr-app/data/sixfold/voice-integration.json`)
   - 목소리 확인 환경: PortAudio와 sherpa-onnx 2.0.1 네이티브 공유 라이브러리, 모델 2개(3D-Speaker ERes2Net 화자 인식, Silero VAD)를 `~/.local/share/herdr-focus-queue`에 받는다
3. `focusq check` 로 위 진입점이 모두 설치된 복사본을 가리키는지 확인한다. 하나라도 아니면 종료 코드 1

목소리 등록은 기본으로 하지 않는다. 등록하기 전까지 받아쓰기는 자동 전송되지 않는다(`--enroll` 또는 `focusq voice-enroll`).

### 옵션

```sh
./rust/target/release/herdr-theme voice-install --enroll    # 설치하면서 45초 동안 말해 목소리 등록
./rust/target/release/herdr-theme voice-install --check     # 설치 상태만 확인
./rust/target/release/herdr-theme voice-install --home /tmp/h   # 다른 홈에 파일만 쓴다(아무것도 띄우지 않음, 시험용)
```

- `--enroll` 은 반드시 에이전트가 없는 셸 pane 에서 한다. Claude pane 에서 하면 학습하는 말이 그 pane 에 받아써진다.

### 바꾸는 파일

| 파일 | 바꾸는 값 |
|---|---|
| `~/.claude/settings.json` | `voiceEnabled: true`, `voice.enabled: true`, `voice.mode: "tap"`, `language` 가 없으면 `"korean"` |
| `~/.claude/settings.json` | `hooks.UserPromptSubmit` 에 `herdr-theme voice-submit-hook` 추가 |
| `~/.claude/keybindings.json` | `Chat` 의 `f8 → voice:pushToTalk` |
| `~/Library/LaunchAgents/<label_prefix>.herdr-codex-focus.plist` | Codex 마이크 관리 |
| `~/.config/herdr-app/data/sixfold/voice-integration.json` | 네이티브 실행 파일의 `command`·`args`, 호환용 `script` (Herdr 앱 포커스 연동) |

값이 실제로 바뀔 때만 `*.focusq-<시각>.bak` 백업을 남긴다. 다른 키·훅·계정 설정은 건드리지 않는다. 받아쓰기를 스페이스가 아닌 F8 토글(tap 모드)로 두는 이유는, 스페이스로 토글하면 띄어쓰기가 녹음을 끝내기 때문이다.

### 설치 후 직접 할 것

- **시스템 설정 → 개인정보 보호 및 보안 → 마이크** 에서 터미널 앱(Herdr 앱, iTerm 등) 허용. 처음 녹음할 때 macOS 가 묻는다
- **시스템 설정 → 사운드 → 입력** 에서 쓸 마이크 선택
- 이미 떠 있는 Claude Code 세션 재시작 (F8 설정을 새로 읽게)
- Codex 는 각 세션에서 `/voice` 로 음성 연결을 직접 시작

## 사용 방법

### 포커스 대기열

- 다른 pane 이 일을 끝내거나(`done`·`idle`) 승인을 기다리면(`blocked`) 대기열에 들어간다.
- 지금 보고 있는 pane 이 `working` 이 되면(지시를 보냈으면) 대기열 첫 pane 으로 넘어간다.
- 입력창에 글이 있거나, 말하는 중이거나, 5초 안에 말한 적이 있으면 기다렸다가 끝나는 즉시 넘어간다.
- 보고 있는 pane 이 입력을 기다리는 중이거나 에이전트가 없는 셸이면 포커스를 그대로 둔다.
- 잠깐 지나가는 pane(0.15초 안에 떠나는 pane)에서는 녹음을 켜지 않는다.

### Claude Code 에 말로 지시하기

1. Claude pane 에 포커스가 오면 플러그인이 F8 로 받아쓰기를 켠다(화면 아래 `REC` 표시). 작업 중에도 켜 두므로, 그동안 한 말은 Claude Code 가 다음 메시지로 대기열에 넣는다.
2. 말한다. 말이 끝났는지는 두 가지로 판단한다.
   - 받아쓴 글이 문장 부호(`.` `?` `!`)로 끝났다
   - 목소리 판정기가 말소리가 멈춘 것을 감지했고, 입력창 글도 더 바뀌지 않는다
   두 조건이 맞고 2초가 지나면 Enter 로 전송한다. 생각하느라 쉬는 시간이 4초 가까이 되기도 해서, 문장 부호 없이 끝난 받아쓰기는 자동으로 보내지 않는다(직접 Enter).
   - 길게 이어 말하는 동안에는 목소리 판정기가 "말하는 중" 신호(`voice-speaking`)를 계속 갱신하므로 전송되지 않는다.
   - 입력 레벨 미터는 키보드 소리나 주변 소음에도 올라가므로 2초 계산에 쓰지 않는다.
3. 본인 목소리로 판정된 받아쓰기만 자동 전송한다. 본인 판정이 아니면(다른 사람 목소리가 대부분이거나, 판정기가 말소리를 듣지 못했거나, 그 마이크의 목소리 등록이 없거나, 헤드셋이 아닌 마이크인 경우) 말이 멈추고 3초 뒤 지운다. Claude Code 는 세 단어 이상 받아쓴 녹음을 무음 시간 초과(약 15초)로 끝낼 때 스스로 전송하므로, 그 전에 지워야 한다.
   - 말한 뒤 다른 pane 으로 옮기면 그 pane 의 받아쓰기는 F8 로 마쳐 전송한다(tap 모드의 F8 은 "멈추고 전송"). 세 단어 미만이면 Claude Code 가 전송하지 않고 입력창에 남긴다. 말하자마자 옮겨 판정이 아직 없으면 옮긴 순간까지 들린 말의 판정을 최대 3초 기다린다. 다른 사람 목소리면 Esc 로 버린다. 끝내 판정이 없으면 Esc 로 녹음을 끈 뒤 입력창 글을 다시 넣어 두고(보내지 않음), 기다리는 동안 다음 pane 에 한 말이 섞였으면 F8 대신 이렇게 남긴다. Esc 는 진행 중인 받아쓰기를 버리므로 전송할 말에는 쓰지 않는다. 다시 넣기는 herdr pane 만 된다(Herdr 앱 pane 은 붙여 넣기 명령이 없어 기록만 남는다).
   - Herdr 앱이나 iTerm 이 맨 앞이 아니면 녹음을 멈추고, 돌아오면 다시 켠다. 다른 앱을 쓰며 한 말은 세션에 들어가지 않는다. 멈출 때 받아쓰기는 pane 을 옮길 때와 같게 처리한다.
4. 전송 전에 포커스를 옮겨도 그 pane 에서 같은 조건으로 전송한다. 문장을 끝맺지 않은 글은 입력창에 둔다. 옮긴 뒤의 말은 새 pane 몫이라 세지 않는다.
5. 키보드로 친 글은 지우지 않고, 그것만으로는 자동 전송하지 않는다. 입력창에 글이 있을 때 실제 키를 누르면(1.5초 안) 그때까지의 글은 받아쓴 글이라도 입력창이 빌 때까지 손으로 고친 글로 본다. 그 뒤에 이어 말한 부분은 보통 받아쓰기처럼 판정한다: 본인 목소리로 문장을 끝내면 고친 글과 함께 보내고, 다른 목소리면 이어 붙은 부분만 지운다. 받아쓴 뒤 고친 글이 남은 채 녹음이 끝났으면 키 입력이 멈춘 뒤 다시 F8 로 녹음을 켜서 이어 말할 수 있다. 처음부터 손으로 친 초안에서는 녹음을 켜지 않는다. 직접 Enter 를 쳐서 보내면 판정과 관계없이 전송된다. 그 받아쓰기 중 이미 본인 점수 0.5 이상인 구간만 목소리 갱신에 쓰인다.
6. 마지막 관문은 `herdr-theme voice-submit-hook`(Claude Code `UserPromptSubmit` hook)다. Claude Code 가 무음 시간 초과로 스스로 보내는 받아쓰기도 여기서 막는다. 최근 녹음한 pane 의 전송은 녹음 안에서 들린 본인 말이 글자 수를 설명하고 평균 점수가 0.5 이상일 때만 통과한다. 판정기가 꺼졌거나 아무 말도 듣지 못했으면 막는다. 직접 친 키(1초 안), `hc send` 메시지, `/` 명령은 통과한다. 막힌 글은 `voice-blocked.jsonl` 에만 남고 입력창에서 지운다.

녹음 관리는 자동이다.
- 전송했거나 2분 상한에 걸려 녹음이 끝나면, 입력창이 비는 대로 F8 로 다시 켠다.
- 아무 말 없이 100초가 지나면 Esc 로 조용히 취소하고 다시 켠다. 2분을 넘기면 "No audio detected" 오류가 뜨기 때문이다.
- 포커스가 떠나면 F8 로 녹음을 끈다. 쉬는 pane 이고 입력창이 비어 있으면 Esc 로 취소한다.

키를 보내기 전에 pane 화면을 읽어 현재 상태를 확인하므로 토글이 거꾸로 가지 않는다.

### Codex

- 음성 연결의 시작·종료는 사용자가 한다(`/voice`). 플러그인이 Esc 나 `/voice` 를 보내지 않는다.
- 포커스된 Codex pane 만 F9 로 마이크를 열고, 나머지는 F9 로 음소거한다. 연결은 유지된다.
- 보고 있는 Codex pane 에 음성 대화 표시가 있으면, 작업 중이거나 잠시 말이 없어도 포커스를 옮기지 않는다.
- 자동 전송과 목소리 확인은 Claude Code 받아쓰기에만 적용된다.

## 목소리 확인

마이크에는 주변 사람 말도 들어온다. Claude Code 는 마이크를 직접 읽어서 소리를 걸러낼 수 없다. 그래서 `herdr-theme voicegate` 가 같은 마이크를 함께 듣고, 말 덩어리마다 이 기기 주인의 목소리인지 판정해 둔다. 녹음·받아쓰기·`REC` 표시는 지연되지 않는다.

### 학습되는 과정

1. 마이크마다 한 번, 주변에 말하는 사람이 없을 때 에이전트가 없는 셸 pane 에서 `focusq voice-enroll` 을 실행해 45초 동안 말한다(화면의 예시 문장을 읽어도 된다). 15초 이상 말소리가 잡혀야 저장된다.
2. 등록 전에는 받아쓰기를 자동 전송하지 않는다. 판정기가 스스로 목소리를 새로 배우지도 않는다. 보낸 받아쓰기로 처음부터 배우면, 노트북 마이크가 옆 대화를 배운 뒤 그 대화를 본인 말로 통과시킬 수 있다.
3. 등록 뒤에는 실제로 전송된 받아쓰기 가운데 이미 본인 점수 0.5 이상인 구간으로 계속 갱신한다(최근 10분 분량). 다시 계산할 때마다 본인 목소리와 거리가 먼 구간은 빠진다.

마이크가 바뀌면 같은 사람도 점수가 크게 달라진다(헤드셋 0.7, 노트북 내장 0.1). 그래서 마이크마다 `voiceprint-<장치>.json` 을 따로 둔다. 받아쓰기는 macOS 기본 입력 이름에 [사용자 설정](#설정-바꾸기)의 `auto_send_devices` 중 하나가 들어 있을 때만 켠다. 아니면 녹음 중이던 것도 멈춘다(기록에 `input is not a headset`). 노트북 내장 마이크는 방 안의 말을 다 듣기 때문이다.

등록하면 그 마이크를 사용자 설정에 적는다.
- 말소리 크기와 그에 맞춘 감지 증폭(`devices.<마이크>.vad_gain`). 말소리가 약 -19 dBFS 로 들리도록 1~30배 사이에서 정한다
- 내장 마이크가 아니면 `auto_send_devices` 에 이름을 넣어 자동 전송을 허용한다. 내장 마이크는 넣지 않는다

### 판정 결과별 동작

| 판정 | 동작 |
|---|---|
| 본인 목소리가 대부분 | 말이 끝나면 전송 |
| 다른 목소리가 대부분 | 전송하지 않고 포커스도 붙잡지 않는다. 말이 멈추고 3초 뒤 지운다(본인이면 그 전에 직접 Enter) |
| 판단 보류(1초 미만 말뿐)·말을 못 들음·등록 전·헤드셋 아님 | 전송하지 않고 지운다(직접 Enter 는 통과) |

- 판정은 말이 끝나고 약 0.3초(말 끝 감지) + 0.03초(판정) 뒤에 나온다.
- 1초 미만의 짧은 말은 판단하지 않는다. 시험에서 0.8초 구간은 본인과 다른 사람 점수가 겹쳤다.
- 겹쳐 말하면 Claude 가 둘을 섞어 받아쓰므로 남의 말만 빼낼 수는 없다.

### 판정 기준

- 점수는 말 덩어리와 목소리 특징값의 유사도(-1~1)다. 기준값 이상이면 본인이다.
- 기본 기준값은 0.4 다. 공개 음성 시험에서 다른 목소리는 대체로 이보다 낮았지만, 실제 사용에서는 본인 말 일부도 이보다 낮게 나온다.
- 기준값은 조금만 자동으로 오른다. 전송된 말 30구간 이상을 그 말을 배우기 전의 특징값으로 매긴 점수가 꾸준히 높을 때만, 하위 5% 바로 아래까지 올린다. 그래도 0.5 를 넘기지 않는다. 낮은 점수가 5% 넘게 섞이면 0.4 에 머문다.
- 학습 묶음에 넣는 조건은 판정 기준과 따로 0.5 로 고정이다(`POOL_SCORE`). 그래서 기준이 저절로 계속 오르지 않는다.
- 다른 사람 목소리가 기준값 가까이 나오는 마이크는 사용자 설정의 `devices.<마이크>.threshold` 로 그 마이크만 기준값을 고정할 수 있다.

### 내 목소리가 다른 사람 기기에서 막히는지 확인

```sh
focusq voice-crosscheck
```

- 공개 화자 인식 음성(csukuangfj/sr-data, 실제 사람 5명)으로 빈 기기 5대를 만든다.
- 각 기기에서 그 사람 목소리를 학습한 뒤, 이 Mac 이 배운 내 목소리 구간을 그 기기들에서 판정한다.
- 내 목소리가 한 구간이라도 통과하면 종료 코드 1 로 끝난다.
- 음성 파일은 `~/.local/share/herdr-focus-queue/crosscheck` 에 캐시한다. 내 목소리 데이터는 읽기만 하고 바꾸지 않는다.

- 공개 음성이 짧아서 그 사람 학습이 5~11초뿐이다. 그래서 그 사람 목소리도 일부 통과하지 못할 수 있다. 실제 사용에서는 30초 이상 학습한다.
- 공개 음성은 중국어·영어다. 한국어 화자로 확인하려면 다른 사람이 설치해서 써 본 뒤, 그 Mac 에서 `focusq voice-test` 를 켜고 내가 말해 본다. 점수가 기준값 아래로 나오면 외부인으로 판정되는 것이다.

### 목소리 데이터와 개인정보

- 목소리 데이터는 `~/.local/state/herdr/plugins/local.focus-queue/` 에만 저장된다.
  - `voiceprint.json`: 목소리 특징값(숫자 512개)과 기준값
  - `voice-pool.jsonl`: 학습에 쓴 말 덩어리의 특징값(최근 10분 분량)
  - `voice-segments.jsonl`: 최근 판정 기록(200줄)
  - `voice-confirmed.jsonl`: 전송된 받아쓰기의 시간 구간
- 마이크 이름과 보정값은 `~/.config/herdr-app/data/sixfold/voice.local.json` 에 둔다.
- 원본 음성은 저장하지 않는다.
- 저장소에는 들어가지 않는다. 사람(기기·macOS 계정)마다 처음부터 새로 학습하므로, 다른 사람 기기에서 내 목소리는 외부인으로 판정된다.
- 모든 판정은 기기 안에서 한다. 음성을 외부로 보내지 않는다.

## 명령어

`focusq` 는 설치된 복사본(`~/.local/share/herdr-focus-queue/plugin/focusq`)을 쓴다. 아래 표는 `./focusq` 로 적었다.

| 명령 | 하는 일 |
|---|---|
| `bash voice/install.sh [--enroll]` | 저장소에서. 없는 도구 설치 후 `herdr-theme voice-install` |
| `./rust/target/release/herdr-theme voice-install [--enroll\|--check]` | 저장소에서. 복사·연결·확인 ([설치가 하는 일](#설치가-하는-일)) |
| `./focusq check` | herdr·hook·앱 연동·Codex LaunchAgent 가 모두 이 복사본을 가리키는지 |
| `./focusq setup [--enroll]` | 없는 도구 설치 + `install` (목소리 확인 환경 포함). `--enroll` 이면 이어서 45초 학습 |
| `./focusq install` | 플러그인 연결·활성화 + Claude Code 음성 설정과 네이티브 목소리 확인 환경 설치 |
| `./focusq status` | 연결·활성 상태 (인자 없이 실행해도 같다) |
| `./focusq enable` / `disable` | 플러그인 켜기·끄기 (끌 때 pane 의 음성 상태는 그대로 둔다) |
| `./focusq uninstall` | 플러그인 해제 + F8 바인딩·전송 hook 제거 (Claude 음성 설정은 유지) |
| `./focusq voice-setup` | 모델과 네이티브 라이브러리 설치·복구 |
| `./focusq voice-enroll [초]` | 지금 쓰는 마이크에 목소리 등록 (기본 45초). 등록해야 자동 전송된다 |
| `./focusq voice-test` | 말할 때마다 점수·판정·판정 시간 표시. 학습된 뒤에만 쓸 수 있다 |
| `./focusq voice-off` | 목소리 데이터 전부 삭제. 다시 등록할 때까지 자동 전송하지 않는다 |
| `./focusq voice-hook` | 전송 직전 검사 hook 만 `~/.claude/settings.json` 에 추가 (install 도 한다) |
| `./focusq voice-crosscheck` | 내 목소리가 다른 사람 기기에서 막히는지 확인 |

`voice-enroll`·`voice-test`·`voice-off` 는 실행 중인 판정 프로세스를 끈다. 다음 포커스 이벤트에 새 데이터로 다시 뜬다.

## 파일과 경로

| 경로 | 내용 |
|---|---|
| `herdr-plugin.toml` | 플러그인 정의. `pane.agent_status_changed`, `pane.focused` 이벤트에 `herdr-theme focus-queue` 실행 |
| `herdr-theme focus-queue` | 대기열·포커스·음성 제어, 말이 끝나면 전송, pane 별 받아쓰기 리스너 |
| `herdr-theme voicegate` | 목소리 판정·등록·갱신 (`serve`, `enroll`, `tail`) |
| `herdr-theme voice-submit-hook`, `rust/src/voice/policy.rs` | 전송 직전 검사(`UserPromptSubmit` hook)와 그 기준 |
| `focusq` | 설치·관리 명령 |
| `herdr-theme voice-install`, `install.sh` | 설치 |
| `rust/src/voice/settings.rs` | 사용자 설정 읽기·쓰기와 일반 기본값 |
| `herdr-theme voice-check-other-device` | `voice-crosscheck` 본체 |
| `~/.local/share/herdr-focus-queue/` | 설치된 플러그인(`plugin`), 네이티브 라이브러리(`native`), 모델(`models`), crosscheck 음성 캐시 |
| `~/.config/herdr-app/data/sixfold/voice.local.json` | 사용자 설정 (마이크·보정값). `HERDR_VOICE_SETTINGS` 로 바꿀 수 있다 |
| `~/.local/state/herdr/plugins/local.focus-queue/` | 기록(`focus-queue.log`), 대기열 상태(`state.json`), 목소리 데이터 |

## 설정 바꾸기

사람마다 다른 값은 저장소가 아니라 `~/.config/herdr-app/data/sixfold/voice.local.json` 에 둔다. 저장소에는 일반 기본값만 있다(`rust/src/voice/settings.rs` 의 `DEFAULTS`). 없는 키는 기본값을 쓰고, 읽을 수 없는 파일은 빈 파일로 본다.

```json
{
  "auto_send_devices": ["<macOS 입력 이름의 일부>"],
  "devices": {"<마이크 키>": {"threshold": 0.45, "vad_gain": 10.0}},
  "dictation_score": 0.5
}
```

| 키 | 기본 | 뜻 |
|---|---|---|
| `auto_send_devices` | `[]` | 자동 전송을 허용할 마이크(입력 이름의 일부, 대소문자 무시). 등록이 헤드셋을 넣는다 |
| `devices.<마이크>.threshold` | 없음 | 그 마이크의 판정 기준값 고정. 없으면 목소리 특징값 파일의 기준값 |
| `devices.<마이크>.vad_gain` | 없음 | 그 마이크의 감지 증폭. 등록이 정한다. 없으면 `vad_gain` |
| `vad_gain`, `vad_threshold` | 10, 0.35 | 말소리 감지 증폭과 감도 |
| `dictation_score`, `short_score` | 0.5, 0.5 | 받아쓰기 전체 평균 점수, 1초 미만 구간의 본인 기준 |
| `max_chars_per_second` | 25 | 들린 본인 말 1초가 설명할 수 있는 글자 수 |
| `default_threshold`, `max_threshold`, `pool_score` | 0.4, 0.5, 0.5 | 기준값 시작·상한, 학습 묶음에 넣는 점수 |

`<마이크 키>` 는 `voiceprint-<마이크 키>.json` 의 그 부분이다. 판정기 설정을 바꾼 뒤에는 `focusq voice-restart` 로 판정기를 다시 띄운다(다음 포커스 이벤트에 뜬다). 전송 판단(hook·리스너)은 다음 전송부터 읽는다.

| 하고 싶은 것 | 방법 |
|---|---|
| 목소리 학습을 처음부터 | `./focusq voice-off` 후 `./focusq voice-enroll`. 헤드셋을 바꿨을 때도 권장 |
| 목소리 확인 끄기 | `~/.claude/settings.json` 의 `UserPromptSubmit` 에서 `herdr-theme voice-submit-hook` 를 빼고 `~/.local/share/herdr-focus-queue/native` 를 지운다. 그래도 플러그인은 본인 판정이 없는 받아쓰기를 자동 전송하지 않으므로 직접 Enter 로 보낸다 |
| 다른 헤드셋에서도 자동 전송 | 그 헤드셋으로 `voice-enroll` 하거나, `auto_send_devices` 에 이름 일부를 넣는다 |
| 잠시 플러그인 끄기 | `./focusq disable` (다시 켤 때 `./focusq enable`) |
| 시간 값 조정 | `herdr-theme focus-queue` 상단 상수. `END_PAUSE_SECONDS`(2.0, 문장이 끝나고 말을 멈춘 뒤 전송까지. 줄이면 빨라지지만 쉬는 사이 끊길 수 있다), `RECYCLE_SECONDS`(100, 말 없는 녹음 재시작), `ACTIVE_SECONDS`(5, 말한 뒤 포커스 유지) |
| 학습 분량 조정 | `herdr-theme voicegate` 의 `LEARN_SECONDS`(30, 다시 계산하는 데 필요한 말), `POOL_SECONDS`(600, 학습에 쓰는 최근 말). 600 보다 크게 하면 다시 계산할 때마다 판정이 늦어진다 |

## 문제 해결

먼저 기록을 본다.

```sh
tail -f ~/.local/state/herdr/plugins/local.focus-queue/focus-queue.log
./focusq status
herdr plugin log local.focus-queue
```

| 증상 | 확인할 것 |
|---|---|
| 설치 중 `herdr plugin ... failed` | 오류 문구를 본다. `server_not_running` 이면 터미널에서 `herdr` 를 한 번 띄운 뒤 다시 실행 |
| 포커스를 줘도 녹음이 안 켜짐 | 기록에 `voice key ignored` 가 있는지 본다. F8 무시가 두 번 쌓인 세션은 60초 동안 키를 보내지 않는다. `/voice` 를 다시 켜 안내문이 보이거나 F8 로 직접 켜면 바로 풀린다. `voice.mode` 가 `hold` 면 F8 한 번으로 켜지지 않으므로 `tap` 으로 둔다 |
| F8 을 눌러도 녹음이 안 켜짐 | Claude Code 세션을 다시 시작했는지. `~/.claude/keybindings.json` 에 `f8 → voice:pushToTalk` 가 있는지 |
| "No audio detected" | 마이크가 소리를 보내는지(시스템 설정 → 사운드 → 입력에서 레벨이 움직이는지), 터미널 앱 마이크 권한. 블루투스 헤드셋은 다시 연결해 본다 |
| 말이 끝났는데 전송되지 않음 | 기록의 `claude dictation sent ... (… voice, N s after speech)` 줄로 전송 여부와 걸린 시간을 본다. 안 찍히면 판정이 "다른 목소리" 였는지 `./focusq voice-test` 로 내 점수를 본다. 마이크 잡음으로 입력창 레벨 표시가 계속 움직이면 말이 안 끝난 것으로 본다 |
| 내 말이 "다른 사람" 으로 판정됨 | `voice-test` 점수를 본다. 헤드셋을 바꿨으면 `voice-off`. 기준값이 올라 있으면 `devices.<마이크>.threshold` 로 낮춰 고정 |
| 옆 사람 말이 전송됨 | `voice-blocked.jsonl` 에 없으면 hook 을 거치지 않은 것이다. `settings.json` 에 hook 이 있는지, 그 세션이 hook 을 읽었는지(`/hooks`) 본다. 내 말과 섞여 내 말이 더 많았으면 통과할 수 있다 |
| 내 받아쓰기가 전송되지 않음 | 입력창에 "전송하지 않았습니다" 이유가 뜬다. 판정기가 꺼졌거나, 헤드셋이 아니거나, 등록 전이거나, 본인 말이 충분히 들리지 않은 경우다. 바로 직접 Enter 를 치면 보내진다. 막힌 글은 `voice-blocked.jsonl` 에 있다 |
| `voice-test` 가 바로 끝남 | 아직 등록 전이다. `voice-enroll` |
| 설치 뒤에도 옛 폴더 코드가 돈다 | `./focusq check`. 실행 중인 리스너는 시작할 때의 코드로 끝까지 돈다. 새로 뜨는 리스너부터 새 복사본이다 |
| 포커스가 원치 않게 넘어감 | 보고 있는 pane 이 `working` 이 되면 넘어간다. 잠시 끄려면 `./focusq disable` |

## 업데이트와 삭제

### 업데이트

테마 저장소를 갱신한 뒤 저장소 폴더에서:

```sh
./rust/target/release/herdr-theme update-install voice    # 또는 ./rust/target/release/herdr-theme voice-install
```

설치된 복사본을 맞바꾸고 모든 진입점을 다시 확인한다. 받아쓰기 리스너와 판정기는 다음에 뜰 때 새 코드를 쓴다. 판정기를 바로 바꾸려면 `focusq voice-restart`.

### 삭제

```sh
./focusq voice-off                       # 목소리 데이터 삭제
./focusq uninstall                       # 플러그인 해제, F8 바인딩·hook·Codex LaunchAgent 제거
rm -rf ~/.local/share/herdr-focus-queue  # 설치본·Python 환경·모델·캐시
```

Claude Code 의 음성 설정(`voice`, `language`)은 남긴다. 되돌리려면 `~/.claude/settings.json.focusq-*.bak` 을 참고한다.

## 이전 설치에서 옮기기

예전에 따로 받은 `herdr-focus-queue` 폴더를 플러그인으로 연결해 쓰던 Mac 은 `./rust/target/release/herdr-theme voice-install` 한 번으로 옮겨진다.

- herdr 플러그인 연결, Claude hook, Codex LaunchAgent, 앱 연동이 새 복사본으로 바뀐다. hook 은 한 번의 쓰기로 바뀌므로 검사가 빠지거나 두 번 도는 전송이 없다. 원래 hook 을 넣지 않았던 설치는 옮긴 뒤에도 넣지 않는다(`./focusq voice-hook` 으로 추가).
- 목소리 데이터(`~/.local/state/herdr/plugins/local.focus-queue`)는 그대로 쓴다.
- 이미 떠 있는 음성 연결은 끊지 않는다. Codex LaunchAgent 만 새 경로로 다시 뜬다(음소거 상태는 유지).
- 예전 버전은 자동 전송 마이크 목록이 코드에 있었다. 옮긴 뒤에는 사용자 설정이 비어 있으면 자동 전송하지 않으므로, 쓰던 헤드셋으로 `voice-enroll` 을 다시 하거나 `auto_send_devices` 에 이름을 넣는다. 손으로 고정했던 기준값은 `devices.<마이크>.threshold` 로 옮긴다.
- 옛 폴더는 `focusq check` 가 통과한 뒤 지워도 된다.

## 지원 환경

지금은 아래 조합에서만 확인했다.

| 항목 | 버전 |
|---|---|
| 터미널 | iTerm2 3.7 (그 안에서 herdr 실행) |
| herdr | 0.9.3 (플러그인 API 사용) |
| Claude Code | 2.1.3xx |
| Codex CLI | 0.165.0 |
| 마이크 | 블루투스 헤드셋 (macOS 입력 장치로 선택) |

pane 을 관리하는 쪽이 herdr 라서, herdr 를 쓰는 한 바깥 터미널(iTerm2, Ghostty 등)은 상관없다. herdr 없이 다른 환경(tmux, Ghostty 분할 창 등)으로 옮길 때 확장한다.

- 구조: 공통 엔진(대기열·음성 정책) + 환경별 어댑터(pane 목록·포커스 이동·화면 읽기·키 보내기). 에이전트 상태를 알려 주지 않는 환경은 Claude Code·Codex hook 이 상태를 기록하게 한다.
- tmux: `select-pane`·`capture-pane`·`send-keys`·`pane-focus-in` hook 으로 같은 수준 구현 가능.
- Ghostty 단독: AppleScript 로 포커스·키 보내기는 되지만 화면 읽기·포커스 이벤트가 없어, 토글 상태를 직접 기록하고 포커스를 폴링해야 한다.

## 한계

- 키 입력 자체는 herdr 이벤트로 오지 않는다. "입력 중"은 보고 있는 pane 이 입력 대기 상태인지로 판단한다.
- 마이크가 열려 있는 동안 주변 소리도 받아쓴다. 목소리 확인은 자동 전송 여부만 정하고, 받아쓰기 자체를 막지는 않는다.
- 화면 문구(`⏺ REC`, `voice ●`, `voice ◌`, `Ask Codex to do anything`)에 기대므로 Claude Code·Codex UI 가 바뀌면 고쳐야 한다.
- 목소리가 비슷한 사람(가족 등)은 구분하지 못할 수 있다. 화자 인식 모델의 한계다.

## Herdr app integration

The optional app backend reads the active sidebar heartbeat at `~/.config/herdr-app/data/sixfold/voice-focus.json`. Only focus newer than 2.5 seconds is used. Existing TUI source panes and native core sessions share the voice routing rules; a background app never overrides TUI focus. App attention sorting never moves keyboard focus.

`herdr-theme voice-install` (or `herdr-theme update-install voice`) points the sidebar at the installed copy. Native Claude retains the existing sentence ending plus two seconds of silence before submission. Native Codex starts voice only from an observed empty CLI without a current connection. Existing Codex voice conversations use only F9 mute/unmute. Microphone permission, actual transcription and speaker identification remain separate observations.

## Confirmed Codex voice-loss recovery

`herdr-theme voice-recovery` starts as a single observer from the focus actor. It keeps healthy calls connected and reads only helper-failure metadata from `~/.codex/logs_2.sqlite`, never audio deltas or recordings.

Recovery requires all of: a previously observed connection in the same CLI process, a new `InspectAudio`/exit 28 or `Device`/exit 37 closure, an observed unexpected-failure message or matching audio-session-closed metadata, an absent live footer for at least three seconds, and an empty composer in the still-focused Codex pane. A manual stop, permission prompt, draft, unknown state or another focused pane prevents action. Focus, process identity and the screen are checked again immediately before starting voice in that same pane. The coding agent and its task are not restarted.

A live footer proves reconnection; sending the command alone does not. The normal focus actor then restores microphone routing under its existing lock. Recovery tries each observed closure once, with a 60-second cooldown and at most three attempts per 15 minutes. A missing footer by itself never starts or stops voice.

Two kinds of closure are handled: a call whose transport closed after the documented two-hour Live call limit (exit 28, inspection after the transport closed) and a failed local audio stream (`Device`/exit 37). Recovery behavior is verified with isolated log/UI fixtures and healthy-call observation, not by interrupting live calls. Device recovery additionally requires configured/default input and output devices with valid channels/sample rates, an unchanged signature across observations at least three seconds apart, and a matching preflight immediately before action. Device enumeration never opens a stream, changes the selected device or grants permission. The error class remains distinct in saved metadata.

If the UI error scrolls away, the monitor can retain the error event id or correlate the same process's independent `AudioSession kind="closed"` result. It still never treats a missing footer alone as a disconnect. Upgrade catches up recent Device failures once so an already observed loss is not silently skipped. Only the currently focused Codex is eligible for reconnection; an active Claude pane is left alone.

## Rust 이전 검증 상태

정규화·점수 계산은 기존 NumPy와 같은 OpenBLAS 0.3.29 ILP64의 네이티브 연산을 사용한다. 설치기는 체크섬으로 고정한 배포 아카이브에서 공유 라이브러리와 라이선스만 꺼내며 Python 모듈이나 가상환경은 설치하지 않는다. 정확한 경계 판정을 유지하는 이유와 파일 검증 방식은 [native-blas.md](docs/native-blas.md), 모델 비교 절차는 [offline-model-validation.md](docs/offline-model-validation.md)에 있다.

실행 경로는 Rust 바이너리를 사용하며 가상환경·pip·Python 실행이 필요하지 않다. sherpa-onnx 공유 라이브러리는 2.0.1 ABI로 고정하며 다운로드 SHA-256을 확인한다. ONNX 모델 이름과 16 kHz/512 샘플 입력, VAD 감도·이득·판정 규칙·목소리 학습 형식을 유지한다. 순수 로직은 baseline `8c5b71d`의 고정 입력/출력 사례와 NumPy 난수 표본을 Rust 테스트에 남겼다. macOS 마이크·CoreGraphics 실제 키 관측·LaunchAgent·앱 포커스·모델 출력 동등성은 실제 macOS 검증 전까지 미검증이다.
