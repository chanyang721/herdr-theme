# Project document tracking

Existing project settings are read from `~/.config/herdr-app/data/sixfold/project-docs.json`; this feature does not change them. Keys are actual workspace IDs or exact workspace names. Each workspace configures `folders` (source paths, optionally filename `match` OR terms) and a `target` for collector-owned links.

The sidebar runs the installed collector (`doc-tabs/collect_docs.py`) on start and then at most every 30 seconds, and rereads the index every two seconds. Workspaces that have only 문서 tab rules (`project-docs-pins.json`) are indexed by space id from those folders, without links. No new daemon or LaunchAgent is installed. Collection indexes Markdown/PDF/Word/Excel files by modification time. Original files and project settings are preserved. Only explicitly owned links and the generated index are managed. Existing files and unowned links are never replaced; existing archive links are preserved.

In the **left panel**, click the arrow beside a workspace name to expand that project's documents. Open a folder to see its newest documents first; “더 보기” adds twenty more. The input inside the expanded workspace filters filenames, automatically expands matching folders, and Enter opens the first result. **⌘⌥F** expands the active workspace and focuses this same input. NFC and NFD Korean filenames and search terms work. A workspace without configured document folders shows that status; no project settings are created automatically.

Paths containing `archive`, `아카이브`, `보관`, or `.before-` are archived (case-insensitive, NFC-normalized), and hidden by default. “아카이브 포함” reveals them; this filter applies across the sidebar. `latest.md`, hidden directories and original symlinks remain excluded. Files retain original paths and folder metadata; grouping uses original folders, not the flattened link directory.

Click a Markdown or HTML document to show it in that workspace's **문서** tab (`open_doc_tab.py`); PDF, DOCX and XLSX run macOS `open` with the original absolute path and use the registered default application. The `.md` default application is VS Code on this machine, which is why plain `open` is not used for Markdown. The small **↗** control explicitly retries in VS Code with `code --reuse-window`. Process launch failures appear below that workspace and a successful retry clears the error. Background indexing and rendering never open an editor or change focus. Opening documents does not select another Herdr workspace.

The separate document dialog and its preview/search modules were removed in favor of this single sidebar flow. Files/Preview Plus already provide file exploration and native Markdown rendering, but their richer preview requires a separate view. This implementation uses external default apps to keep the requested sidebar flow simple. Content search and cross-project search are omitted; the input searches the expanded workspace's configured index without reading every original file.

The installed Sixfold layout declares a **224px** sidebar, minimum **180px**, maximum **380px**. Workspace cards also reserve horizontal space for message-flow paths, so document rows have less usable width. Folder labels show the last two path components; long filenames are truncated and tooltips show complete original paths. Short dates keep rows compact. The document sections live inside the existing vertical workspace scroll area, rather than a fixed footer that could displace the terminal list. Header, counters, alerts/message flow and footer share the window height; the scroll area takes the remaining height. No fixed document viewport height or layout-setting change is introduced. Expanded document heights are measured to keep later workspace message-flow paths aligned.

For an existing installation, copy this repository's `mods/sixfold-desk/docs.js` and `main.js`, then merge only `cmd-alt-f: sixfold-desk.find-docs` into `layout:sixfold` in the existing keys file. Use the updated collector in this checkout. Do not replace personal layouts, other bindings or project settings.

Automated verification uses temporary documents, native mod checks and stubbed input/read/launch handlers. It checks archive inclusion, folder pagination, Unicode search, Enter after index replacement, workspace-specific queries and launch error recovery. Real pointer/keyboard automation and external app launches are excluded. Native checks establish module/API compatibility, not actual visual quality. Actual shortcut delivery, click/scroll appearance, OS default-app associations and editor windows remain unverified.

The search input's native retained state is prepared in the workspace arrow click handler or the `find-docs` command handler, before rendering. Creating `InputState.new()` inside `docsSection` freezes the sidebar on its previous successful frame; the warning appears in the rendered frame even when `status.errors` is empty and the initial native check passes. Regression tests reject input creation during render. An isolated app reproduced that warning with the old implementation and rendered both expanded workspaces with the fix, including an empty index. No pointer or keyboard automation was used on the user's display.

If a configured workspace has no folder rows, inspect `files` and `warning` in its generated index. The group's `folder` and `files` properties are not two documents. An empty or partial index with `source_unavailable` requires checking the configured source paths and current read access separately from the arrow. Refreshing only the generated index can preserve project settings, source documents and existing links; do not remove ownership warnings without verifying the link manifest.

## 공간별 고정 문서 탭

`python3 scripts/install_doc_tabs.py`는 읽기 전용 설치 계획을 출력한다. `--install`은 native mod check 후 개인 `project-docs-tabs` mod와 Sixfold 탭바, 전용 Python 도구만 설치하고, 각 로컬 공간에 터미널 없는 **문서** 탭 하나를 추가한다. 기존 개발 탭·pane·선택은 보존한다. `project-docs.json`, 기존 인덱스·소유 링크·원본 문서를 변경하지 않는다. 원격 공간은 이번 대상이 아니다. 새 공간을 만든 뒤에는 `--install`을 다시 실행하면 기존 규칙을 보존하며 해당 공간의 규칙을 추가한다.

### 목록 보기(2026-11-04 개편 · macOS Finder 형식)

문서 탭은 Finder 창과 같은 모양이다.

- **도구 막대**: 사이드바 ◧, 보기 전환(**▥ 열** 기본 · **☰ 목록**), **종류: 전체 ▾**(종류 칩), 검색창, 새로 고침, 분류 규칙.
- **경로 막대**: `위치 › 폴더 › 문서`. 앞 단계를 누르면 그 폴더로 돌아간다.
- **사이드바**(칸 폭 1100px 이상이면 처음부터 보임): **즐겨찾기** = 고정 문서, **위치** = 공간 문서 · 하네스 · 열람 · 보관(개수 표시).
- **열 보기**: 공간 문서는 종류 폴더 → 문서(최신 먼저), 하네스는 현황/기록(월)/결정/주제 문서(그룹)/기억 폴더. 폴더를 누르면 오른쪽에 다음 열이 열리고, 문서를 누르면 오른쪽 본문에 보인다. 열이 넘치면 앞 열을 접고 ‹ 버튼을 보인다. 열 보기 부품 `mods/project-docs-tabs/column-view.js`는 하네스 기억 패널과 바이트 그대로 같은 파일이다(원본은 하네스 레포, 첫 줄 `COLUMN_VIEW_VERSION`). 고치지 말고 원본을 바꾼 뒤 복사한다.
- **목록 보기**: 이름·수정일·종류·크기 열. 머리글을 누르면 정렬(다시 누르면 반대), 폴더와 판이 여럿인 문서는 ▸로 펼친다. 폴더는 늘 위.
- **아이콘**: 📁 폴더, 📝 Markdown·텍스트, 🌐 HTML, 📕 PDF, 📘 Word, 📗 Excel, 📄 기타.
- **선택 강조**: 테마 `selected` 배경과 왼쪽 2px `accent` 막대. 색은 테마 토큰만 써서 밤·낮 테마를 따른다.
- **검색**: 입력하면 모든 위치(이전 버전·보관 포함)에서 찾은 문서를 목록 보기로 보여 준다. Enter는 첫 결과를 연다.
- **버전**: 같은 문서의 이전 판은 별도 줄로 늘어놓지 않는다. 문서를 열면 본문 위 **최신 / 이전** 칩으로 바꿔 보고, 목록 보기에서는 ▸로 펼친다. 열 보기에서는 `n판` 배지를 붙인다. 고정 문서는 ◆, 최근 7일 문서는 이름 앞 ●.
- 보기·위치·열린 폴더는 공간별로 `sixfold.docs.finder.v1`에 남는다. 열람 문서는 본문 위 **닫기**로 닫는다.

- 공간 규칙의 `folders` 아래 문서를 **모두** 나열한다. 키워드 일치 최근 6개만 보여 주던 방식은 없앴다. 문서를 옮기거나 이름을 바꾸지 않고, 보는 방식만 바꾼다.
- **버전 묶음**: 날짜 접두사, `.before-…`·`.v1-before-…`, `_공유본`·`_최종`·`_초안`·`draft`·`final`, `(1)`을 뺀 이름이 같으면 같은 문서로 본다. 날짜가 붙은 복사본은 다른 폴더(`…_공유본/`)에 있어도 같은 문서로 묶는다. 날짜가 없는 같은 이름(`README.md`)은 폴더가 다르면 다른 문서다. 같은 문서의 `.md`·`.html`·`.pdf`도 하나로 묶고 `.md`를 위에 둔다. 최신판 하나만 목록에 나온다. 고정 문서가 있으면 그 문서가 묶음의 맨 위다.
- **종류 분류**: 폴더 이름(`adr/` 등)을 먼저 보고, 그다음 파일 이름에 든 낱말로 정한다. 기본 낱말은 `scripts/doc_catalog.py`의 `DEFAULT_KINDS`에 있다. 바꾸려면 규칙 파일 맨 위나 공간마다 `classify.kinds`를 둔다(예시 `config/project-docs-pins.example.json`). 회사·프로젝트 낱말은 저장소가 아니라 로컬 규칙 파일에 둔다.
- **이름 정리**: 날짜 접두사와 확장자를 빼고, 문서 60% 이상이 같은 첫 낱말(프로젝트 이름 등)로 시작하면 그 낱말도 뺀다. 긴 해시는 `#a1b2c3`처럼 줄인다. 줄 끝에는 날짜(`11-04`)를 표시한다. 잘린 이름은 툴팁으로 원래 파일명·폴더·경로를 보여 준다.
- **최근 기간**: 공간 규칙 `recent.highlightDays`(기본 7일).
- **정렬**: 종류 폴더 안과 목록 보기의 **수정일**은 파일을 마지막으로 고친 시각 순이다(최신이 위). 이름에 붙은 날짜와 다를 수 있으며, 수정일 칸도 고친 날을 보여 준다.
- **자동 배정**(`scripts/doc_routing.py`): 여러 프로젝트 문서가 섞이는 공유 폴더(보고서 폴더, Downloads)는 공간마다 `match`를 손으로 적지 않아도 된다. 규칙 파일 옆 `project-docs-routing.local.json`에 공유 폴더와 공간 이름별 낱말을 두면, 각 문서를 경로·제목·본문 앞부분(약 4KB)에 낱말이 가장 많이 든 공간 한 곳에 넣는다. 가중치는 경로 3, 제목 2, 본문 1이다. 동점이거나 낱말이 없으면 `fallback` 공간(예: Share)으로 간다. `requireMatch`인 폴더(Downloads)는 낱말이 맞는 문서만 넣고 나머지는 어디에도 보이지 않는다. `depth: 1`이면 하위 폴더는 보지 않는다. 문서를 옮기거나 링크를 만들지 않고 탭에서만 보인다. 기존 `folders`·고정 문서는 그대로이며, 같은 파일은 한 번만 나온다. 이름으로 종류가 안 정해지면 제목으로 정한다. 회사·프로젝트 낱말은 이 로컬 파일에만 둔다(예시 `config/project-docs-routing.example.json`). `python3 scripts/doc_routing.py`는 문서마다 배정될 공간을 출력한다.
- **검색 규칙**: 이름·파일명·폴더·종류에 띄어쓰기로 나눈 낱말이 모두 들어 있는지 본다(NFC). 종류 칩은 한 종류만 남긴다.
- 예전 규칙의 `recent.limit`·`recent.keywords`·`excluded`는 고정/고정 해제 확인에만 쓰고 트리에는 영향이 없다.

### 하네스 폴더

하네스 폴더 계약 v1을 따른다. `~/.config/herdr-app/data/sixfold/harness-local/views/workspaces/index.json`에서 `space_id`가 이 공간이고 `machine_name`이 `null`(이 Mac)인 항목의 `workspace_id` 폴더를 연다. 항목이나 폴더가 없으면 사이드바에 하네스 위치를 보이지 않는다. 공간 규칙에 `"harness": {"root": "/경로"}`를 두면 그 폴더를 대신 쓴다(수동 지정).

| 하네스 폴더 | 원본 |
|---|---|
| 현황 | `README.md`, `context.md`, `context/goal·constraints·environment·decisions.md`, `next.md`, `escalation.md` |
| 기록 | `history/YYYY-MM/YYYY-MM-DD/*.md` — 월별로 나누고 최신부터 |
| 결정 | `decisions/YYYY-MM-DD-*.md` — 최신부터 |
| 주제 문서 | `docs/<그룹>/*` — 원본으로 가는 링크라서 링크를 따라가 원본을 연다. 이미 목록에 있는 원본이면 그 줄을 선택한다. 깨진 링크는 숨긴다 |
| 기억 | `brain/brain.md`(승인됨), `brain/pending.md`(승인 대기) |

모두 생성물이라 고정 버튼이 없고 읽기 전용이다. `.`으로 시작하는 이름은 숨긴다.

초기 고정 목록은 실제 읽을 수 있는 원문으로 선정했다.

| 공간 | 항상 유지하는 문서 |
|---|---|
| 프로젝트 공간 | 이 기기의 `site.local.json` → `doc_tabs.<공간 이름>`에 적은 문서(`sources`: 고정 경로, `topics`: 날짜 접두사의 최신판, `folders`: 문서 폴더). 예시는 `config/site.example.json` |
| Share | `COMMON_ROUTING.md`, `README.ko.md` |
| Voice | 해당 공간 프로젝트의 `README.md` |
| Herdr | `README.ko.md`, `docs/project-documents.md` |

표의 한글 경로는 읽기 편한 NFC 표기다. 설정에는 디스크의 실제 Unicode 경로를 보존한다. ADR 목록 같은 문서의 Markdown 링크를 누르면 ADR 본문도 앱 안에 임시 **열람** 탭으로 표시한다. 계속 유지하려면 **고정**을 누른다. 임시 열람 탭은 재시작 복원을 보장하지 않으며, 고정한 문서와 마지막 고정 선택은 복원한다.

**고정/고정 해제**로 즐겨찾기를 바꾼다. 고정을 해제해도 문서는 종류 폴더에 남는다. 다시 추가하려면 **분류 규칙**에서 규칙을 고치거나 다음 CLI를 사용한다. 버튼을 누른 때만 외부 앱이 열린다. PDF·DOCX·XLSX는 **기본 앱**, 원문 편집은 **VS Code**로 연다. Markdown 본문은 읽기 전용이다. 기본 앱 연결 및 실제 외부 편집 창 실행은 자동 검증 범위에 포함하지 않았다.

규칙 파일은 `~/.config/herdr-app/data/sixfold/project-docs-pins.json`이다. 키는 이름이 아닌 실제 공간 ID다. 기존 `project-docs.json`을 고칠 필요가 없다.

```json
{
  "version": 1,
  "spaces": {
    "실제-space-id": {
      "name": "프로젝트",
      "folders": [{"path": "/절대/보고서폴더", "match": ["프로젝트명"]}],
      "pins": [
        {"id": "architecture", "label": "아키텍처", "kind": "file", "path": "/절대/ARCHITECTURE.md"},
        {"id": "decisions", "label": "결정 요청", "kind": "latest", "root": "/절대/보고서폴더", "topic": "프로젝트_결정요청.md", "recursive": false}
      ],
      "recent": {"days": 14, "limit": 6, "keywords": ["결정", "확인요청", "회신", "질의", "검토결과"]},
      "excluded": []
    }
  }
}
```

`latest`는 `YYYYMMDD_` 또는 `YYYY-MM-DD-` 날짜 접두사를 뺀 파일명 전체(확장자 포함)로 같은 주제를 묶는다. Unicode 정규화 후 비교하며 가장 최신인 유효 날짜를 선택한다. 미래 날짜는 제외한다. `recursive:false`는 하위 공유본·복사본을 후보에서 제외한다. 같은 날짜의 후보가 둘이면 자동 선택하지 않고 충돌을 표시한다. 최신판이 바뀌어도 주제 탭 ID는 유지하며 본문은 위에서부터 표시한다.

```sh
python3 ~/.config/herdr-app/data/sixfold/doc-tabs/resolve_doc_pins.py --space 실제-space-id
python3 ~/.config/herdr-app/data/sixfold/doc-tabs/resolve_doc_pins.py --space 실제-space-id --pin /절대/원본.md
python3 ~/.config/herdr-app/data/sixfold/doc-tabs/resolve_doc_pins.py --space 실제-space-id --unpin 문서-id
```

파일·규칙·주제 폴더 변경을 감지하고, 문서 탭 활성화 때 재읽으며 5초마다 재확인한다. 파일 저장은 원자 rename도 포함한다. 읽기 실패·삭제·최신 날짜 충돌 때는 탭과 마지막 성공 본문을 유지하고 실패 상태를 표시한다. 서로 다른 문서/날짜판의 늦은 읽기 응답은 버린다. 미저장 편집 내용은 반영하지 않는다. native 파일 읽기는 1 MiB 한도가 있으며, 읽기에 성공한 긴 본문은 400,000자까지 표시하고 잘림을 알린다. 매우 큰 파일은 VS Code로 연다.

앱 재시작·공간 전환은 core에 저장된 문서 mod와 공간별 선택 상태를 복원한다. Sixfold 탭바는 문서 탭의 닫기 버튼과 우클릭 닫기 메뉴를 제공하지 않는다. 명령/키로 닫으면 살아 있는 Sixfold 탭바가 5초 주기로 누락 탭을 같은 ID로 복구한다. 복구는 core 문서만 변경하며 공간·탭·pane을 선택하지 않는다. 앱이 멈추거나 다른 레이아웃이면 자동 복구 주기는 보장되지 않는다. 필요하면 `python3 ~/.config/herdr-app/data/sixfold/doc-tabs/install_doc_tabs.py --ensure-tabs`를 실행한다. 전체 문서 탭 기능을 끄려면 탭바의 복구 코드를 먼저 제거한 뒤 해당 mod 탭을 닫는다. 스크롤 위치의 재시작 복원은 지원하지 않는다.

검증(2026-11-02): 임시 `HERDR_APP_HOME`과 별도 core socket의 실제 앱에서 한글 표·로컬 SVG 이미지, 원자 저장, 삭제/복구, 새 날짜판, 동일 날짜 충돌, 긴 본문 제한, 앱 재시작 후 선택 복원을 확인하고 `shot`을 눈으로 검사했다. 별도 core 재시작 후 문서 탭과 선택 유지, 두 공간 전환, 중복 방지, 명령으로 닫은 탭의 자동 복구와 복구 후 개발 pane 유지도 확인했다. 임시 driver는 `tests/doc-tabs-native-driver.js`, 수용 시험은 `tests/native_doc_tabs.py`이며 사용자 앱에는 설치하지 않는다. 사용자 화면 포인터·키 자동화는 사용하지 않았다. OS/기기 재부팅·절전·원격 공간·외부 앱 창 동작·본문 스크롤 복원은 미검증이다. 프로젝트의 기존 자료 source가 없거나 접근 불가하면 경고를 계속 표시하며, 다른 정상 보고서의 표시와 구분한다.

## 세션에서 문서 열기

모든 세션은 `herdr-doc <파일>`(`~/.local/bin/herdr-doc` → 설치된 `doc-tabs/open_doc_tab.py`)로 문서를 그 문서가 속한 공간의 **문서** 탭에 연다. 공간은 지금 열려 있고 문서 탭이 있는 공간의 규칙 중에서만 고른다. 지워진 공간의 규칙은 건너뛴다. 가장 구체적인 폴더가 이기고, 같은 폴더면 키워드 규칙이 이긴다. 맞는 규칙이 없으면 현재 공간에 연다. `--space`로 지정할 수 있고, `--no-show`는 탭을 바꾸지 않고 불러만 둔다. 요청 파일 `project-docs-open.json`은 version 2부터 공간별로 하나씩 보관하므로, 두 공간에 연달아 열어도 앞의 요청이 사라지지 않는다. 문서 탭 목록은 위의 트리로 보여 준다. 이 사용 규칙은 Claude·Codex 공용 `~/dotfiles/agents/AGENTS.md`의 "문서 열기" 절에 있다.
