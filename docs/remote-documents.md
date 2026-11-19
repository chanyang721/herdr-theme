# Remote documents in the 문서 tab

The 문서 tab can show a text document that lives on another machine connected to this
core, without copying it to this computer. The code is
`mods/project-docs-tabs/remote.js` (pure checks, reader and blocks) and the remote branch of
`mods/project-docs-tabs/main.js`.

## How a document is read

`hc file read --json --on <machine> --offset <line> --limit <lines> -- <path>`, called through
the app's `hc(args)` with an argument array. The other machine's core opens the file itself: it
must be a regular file of UTF-8 text, and no shell runs there. The reply comes back on hc's
standard output into the app's memory and from there into the view's blocks.

The file is read in pages of 4,000 lines until the shown length (400,000 characters) or its end.
The core answers whole lines up to 8 MiB of JSON text, but the app keeps only the first 8 MiB of
hc's output with the reply's envelope, so a reply near that size arrives cut and is not JSON.
A cut reply is asked again with an eighth of the lines, down to one; a single line too long for
one reply makes the document too large (or, after earlier lines, ends what is shown). One
document takes at most 24 hc calls. Pages can come from different versions if the file changes
while it is read; a file that shrinks meanwhile ends what is shown.

The app's `readTextFile(path, { on })` is not used for this. On another machine it runs `cat`,
and where there is no `cat` it falls back to `cmd /c type <path>`, which reads the path through
a command interpreter.

## Supported formats

| Extension | Shown as |
| --- | --- |
| `.md`, `.markdown` | Native Markdown text. Pictures are not loaded (the tab says some pictures cannot be read); Mermaid fences stay as code with a notice. |
| `.txt` | One code block. |
| `.html`, `.htm` | Its source in one code block, with a notice. It is never run, rendered or loaded in a browser engine. |

Anything else (PDF, Office, pictures, scripts, files without an extension) is refused before
hc is asked. The fence around code is one backtick longer than the longest backtick run in the
text, so the text cannot close it (counted in one pass, so long text cannot overflow the stack).
At most 400,000 characters are shown; a longer file, or one that ended early as above, is marked
as shortened.

## What is not stored

Nothing in this path writes the document text anywhere:

- no file, temporary file or cache: remote documents skip the local picture staging
  (`vendor/media.js` writes PNGs under `mods/project-docs-tabs/.cache/`), the Mermaid renderer
  and the HTML renderer, which all write files;
- no `shared()` value: `shared()` is saved to `shared.json`, so the tab does not save a remote
  document as its selection or as the Finder's place. Its machine and path stay in memory; its
  document id is a number (`remote-1`) mapped to them only in memory. A Finder place saved by
  an earlier build that names a remote document is cleared when the tab opens;
- no log or console output, and error messages carry only a short single-line hint from hc
  (hc's messages name the path, not the text);
- no body cache: a finished read is not kept by the reader. The view keeps the blocks it is
  showing in memory, and asks the machine again only on a click (opening it, 새로 고침, a link).
  List refreshes and folder events do not ask again, including after a failed read.

`tests/remote-documents.test.mjs` checks this with host stubs that record every write, run,
log and shared value. On 2026-11-19 a probe on Windows read a local marker file and a file on
another machine through `hc file read --json`, then searched the files changed afterwards in
the core's and app's data folders and the temporary folder: none contained either text.

Not covered: what the operating system does with process pipes and paged memory, the other
machine's own logs, and screenshots or clipboard copies a person makes. The text is visible
on screen and selectable, as for local documents.

## Requests from another mod

Another mod asks a space's 문서 tab to show a remote document by setting a shared value:

```js
setShared('sixfold.docs.remote-open.v1', {
  ...(shared('sixfold.docs.remote-open.v1') || {}),
  [spaceId]: { on: 'machine-name', path: '/absolute/path/doc.md', at: Date.now() },
});
```

- `on`: a machine name as `machines()` lists it (letters, digits, `.`, `_`, `-`, at most 64).
  This computer cannot be named; a local document uses the existing open request.
- `path`: absolute on that machine, `/…` or `C:/…` (backslashes allowed). No UNC or device
  paths, no `..`, no control characters, at most 1,024 characters.
- `roots` is refused (see below): a request that names it is not read.
- `at`: milliseconds. A request older than five minutes, or dated in the future, is removed
  unread, so a restart never reads a remote file by itself.

The tab takes its own entry when it draws while in front, removes it from the shared value
and leaves the other spaces' entries alone. Only metadata passes through `shared.json`, and
only until the tab takes it. A request that fails a check is reported in the tab and never
reaches hc. Sending a request is the caller's response to a person's click; the tab does not
list or browse remote folders.

### No folder limit

A request cannot be limited to folders on the other machine. The tab could compare the path's
text with a folder, but the other core's `file.read` opens the path as the file system resolves
it: a symbolic link, junction or linked folder inside the path leads to a file outside that
folder (the 2026-11-19 review reproduced this with a Windows junction and the installed hc). So a request
that names `roots` is refused before hc with "허용 폴더 제한은 … 보장할 수 없어 열지 않습니다",
and links in a remote document are not limited either: a click on one opens that path on the
same machine, as the person could by asking for the path.

Keeping such a limit needs the other core to check it where the file is opened, for example a
`file.read` option naming the folder that resolves the folder and the opened file's final path
(after links) and refuses a file outside it. That belongs to herdr-core and its maintainers;
this mod does not change the core and does not claim the limit until the core offers it.

## Errors

| Shown | When |
| --- | --- |
| 컴퓨터 이름이 올바르지 않습니다 / 목록에 없는 이름 | malformed or unknown machine |
| 원격 문서 경로가 올바르지 않습니다 / 지원 형식 아님 / 허용 폴더 제한은 … 열지 않습니다 | checks above |
| 연결할 수 없습니다 | hc `unreachable`, `unavailable`, `needs_login`, `busy` |
| 파일이 없습니다 / 일반 파일이 아닙니다 / 권한이 없습니다 / UTF-8 텍스트 아님 | the other core's answer |
| 너무 큽니다 | over 64 MB, or a first line too long for one reply |
| 시간이 초과되었습니다 | the app stops hc after 30 s |

A failed read keeps the last body shown for that document, as local documents do.

## Links in a remote document

`http(s)` links open in the browser. `#` links do nothing. A relative or `file:///` link is a
document on the same machine and goes through the same checks (machine, path form, format).
Other schemes are refused. A link never opens a file on this computer, and the local actions (기본
앱, VS Code, 파일 복사, 본문 복사, 고정) are not shown for remote documents.

## Limits

- A superseded or closed read is dropped when it arrives; its pages still run to the end (each
  hc call at most 30 s, at most 24 calls). Two opens of the same file while one read runs share it.
- The other machine's core reads the whole file (up to 64 MB) for each page; only the reply
  size and the number of calls are bounded here.
- Requires an app with `hc(args)` and `machines()` (Herdr app 0.1.16 has both) and a core
  that answers `file.read` for `--on` (0.1.21 does).
- No panel or other mod sends these requests yet.
