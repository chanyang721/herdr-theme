use super::*;
use std::collections::{BTreeMap, BTreeSet};
pub const AGENTS: &[&str] = &["codex", "claude", "claude-code"];
pub const SHELLS: &[&str] = &["zsh", "-zsh", "bash", "-bash", "sh", "fish", "-fish"];
pub const REPORT_MARK: &str = "[세션 정리 보고 요청]";
pub fn provider(app: &str) -> &str {
    if app == "claude" || app == "claude-code" {
        "claude"
    } else if app == "codex" {
        "codex"
    } else {
        ""
    }
}
pub fn trial_of(state: &Value, now: f64, fresh: bool) -> Value {
    let kept = &state["trial"];
    json!({"started_at":if fresh{kept.get("started_at").cloned().unwrap_or(json!(now))}else{json!(now)},"samples":if fresh{num(&kept["samples"],0.) as u64+1}else{1},"error_count":num(&kept["error_count"],0.) as u64,"healthy":if fresh{num(&kept["healthy"],0.) as u64}else{0}})
}
pub fn settle_trial(state: &mut Value, config: &Value, ok: bool) {
    if !state["trial"].is_object() {
        state["trial"] = json!({})
    }
    let t = &mut state["trial"];
    if !ok {
        t["error_count"] = json!(num(&t["error_count"], 0.) as u64 + 1);
        t["healthy"] = json!(0);
    } else {
        t["healthy"] = json!(num(&t["healthy"], 0.) as u64 + 1);
        if truth(&t["error_count"])
            && num(&t["healthy"], 0.) >= num(&config["error_reset_after"], 3.)
        {
            t["error_count"] = json!(0);
        }
    }
}
pub fn process_table() -> Result<Value> {
    let mut rows = json!({});
    for line in command(&strings(&["ps", "-axo", "pid=,ppid=,comm="]), 12., false)?.lines() {
        let mut p = line.trim().splitn(3, char::is_whitespace);
        let pid = p.next().unwrap_or("");
        let rest = line.trim().strip_prefix(pid).unwrap_or("").trim_start();
        let mut p = rest.splitn(2, char::is_whitespace);
        let parent = p.next().unwrap_or("");
        let name = p.next().unwrap_or("").trim();
        if let (Ok(id), Ok(parent)) = (pid.parse::<u64>(), parent.parse::<u64>()) {
            if !name.is_empty() {
                rows[pid] = json!({"pid":id,"parent":parent,"name":Path::new(name).file_name().unwrap_or_default().to_string_lossy(),"args":""});
            }
        }
    }
    for line in command(&strings(&["ps", "-axo", "pid=,args="]), 12., false)?.lines() {
        let mut p = line.trim().splitn(2, char::is_whitespace);
        let pid = p.next().unwrap_or("");
        if rows.get(pid).is_some() {
            rows[pid]["args"] = json!(p.next().unwrap_or("").trim_start());
        }
    }
    Ok(rows)
}
pub fn is_helper(info: &Value) -> bool {
    let line = if truth(&info["args"]) {
        s(&info["args"])
    } else {
        s(&info["name"])
    };
    [
        r"(?i)(?:^|/)node_repl(?:\s|$)",
        r"(?i)(?:^|/)codex-code-mode-host(?:\s|$)",
        r"(?i)/cua_node/bin/node\s",
        r"(?i)\s--mcp\b",
        r"(?i)\bmcp(?:\s|$)",
        r"(?i)\bmcp[-_]server\b",
        r"(?i)-mcp(?:\s|$|/)",
        r"(?i)^(?:/usr/bin/)?caffeinate -i -t \d{1,4}$",
    ]
    .iter()
    .any(|p| re(p).is_match(line))
}
pub fn process_evidence(t: &Value, processes: &Value) -> (bool, String, Vec<u64>) {
    let Some(root) = t["pid"].as_u64() else {
        return (false, "process evidence unavailable".into(), vec![]);
    };
    if processes.get(root.to_string()).is_none() || !truth(&t["foreground"]) {
        return (false, "process evidence unavailable".into(), vec![]);
    }
    let mut family = BTreeSet::new();
    let mut pending = vec![root];
    while let Some(p) = pending.pop() {
        if !family.insert(p) {
            continue;
        }
        if let Some(o) = processes.as_object() {
            for (k, v) in o {
                if v["parent"].as_u64() == Some(p) {
                    if let Ok(id) = k.parse() {
                        pending.push(id)
                    }
                }
            }
        }
    }
    let mut extra = BTreeSet::new();
    let mut agents = false;
    for pid in &family {
        let i = &processes[pid.to_string()];
        let name = s(&i["name"]);
        agents |= AGENTS.contains(&name);
        if *pid != root && !is_helper(i) && !AGENTS.contains(&name) && name != "expect" {
            extra.insert(name.to_string());
        }
    }
    let p = family.into_iter().collect();
    if !extra.is_empty() {
        return (
            false,
            format!(
                "running/unknown child processes: {}",
                extra.into_iter().collect::<Vec<_>>().join(", ")
            ),
            p,
        );
    }
    if !agents {
        return (false, "agent process identity unverified".into(), p);
    }
    (true, String::new(), p)
}
fn valid_uuid(s: &str) -> bool {
    re(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").is_match(s)
}
pub fn inherited_child_session(pid: u64) -> bool {
    command(
        &vec![
            "ps".into(),
            "eww".into(),
            "-p".into(),
            pid.to_string(),
            "-o".into(),
            "command=".into(),
        ],
        12.,
        false,
    )
    .map(|t| {
        t.split_whitespace()
            .any(|w| w == "CLAUDE_CODE_CHILD_SESSION=1")
    })
    .unwrap_or(false)
}
pub fn pane_session_id(address: &str, created: &Value, pid: u64) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("herdr-pane-session:{address}:{created}:{pid}").as_bytes(),
    )
    .to_string()
}
pub fn child_session(t: &Value) -> Result<Value> {
    let pid = t["foreground"]["pid"].as_u64().unwrap_or(0);
    if provider(s(&t["status"]["app"])) != "claude"
        || pid == 0
        || !truth(&t["created_ms"])
        || !truth(&t["address"])
        || !inherited_child_session(pid)
    {
        return Ok(Value::Null);
    }
    Ok(
        json!({"session_id":pane_session_id(s(&t["address"]),&t["created_ms"],pid),"no_resume":true}),
    )
}
pub fn session_mapping(t: &Value, c: &Value) -> Result<Value> {
    let fg = &t["foreground"];
    let app = s(&t["status"]["app"]);
    let pid = fg["pid"].as_u64().unwrap_or(0);
    if pid == 0 || !AGENTS.contains(&app) {
        return err("session mapping unverified: agent foreground missing");
    }
    let mut base =
        json!({"pid":t["pid"],"created_ms":t["created_ms"],"agent":app,"process_pid":pid});
    if provider(app) == "claude" {
        let h = if c["claude_home"].is_string() {
            expand(s(&c["claude_home"]))
        } else {
            home().join(".claude")
        };
        let meta = match load(h.join("sessions").join(format!("{pid}.json")), Value::Null) {
            Ok(m) if m.is_object() => m,
            _ => {
                return err(if inherited_child_session(pid) {
                    "cannot resume: Claude runs as an inherited child session (no session file or transcript)"
                } else {
                    "session mapping unverified: Claude session file missing"
                })
            }
        };
        if !valid_uuid(s(&meta["sessionId"])) || meta["pid"].as_u64() != Some(pid) {
            return err("session mapping unverified: Claude session file invalid");
        }
        base["session_id"] = meta["sessionId"].clone();
        return Ok(base);
    }
    let argv = arr(&fg["argv"]);
    let mut sid = argv
        .iter()
        .position(|x| x == "resume")
        .and_then(|i| argv.get(i + 1))
        .filter(|x| valid_uuid(s(x)))
        .map(|x| s(x).to_owned());
    let held = command(
        &vec![
            "lsof".into(),
            "-n".into(),
            "-P".into(),
            "-p".into(),
            pid.to_string(),
            "-Fn".into(),
        ],
        10.,
        false,
    )
    .map_err(|_| std::io::Error::other("session mapping unverified: open rollouts unreadable"))?;
    let db = if c["codex_db"].is_string() {
        expand(s(&c["codex_db"]))
    } else {
        home().join(".codex/state_5.sqlite")
    };
    let read = (|| -> Result<BTreeSet<String>> {
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(Duration::from_secs(1))?;
        conn.pragma_update(None, "query_only", true)?;
        let mut st = conn.prepare("select child_thread_id from thread_spawn_edges")?;
        let children = st
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        let mut st = conn.prepare("select rollout_path,id from threads")?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
        Ok(held
            .lines()
            .filter_map(|l| l.strip_prefix('n'))
            .filter(|l| re(r"/rollout-[^/]*\.jsonl$").is_match(l))
            .filter_map(|p| rows.get(p))
            .filter(|id| !children.contains(*id))
            .cloned()
            .collect())
    })();
    let top = read.map_err(|_| {
        std::io::Error::other("session mapping unverified: Codex state database unreadable")
    })?;
    if let Some(id) = &sid {
        if !top.is_empty() && (top.len() != 1 || !top.contains(id)) {
            return err("session mapping unverified: resume id and open rollout disagree");
        }
    } else {
        if top.len() != 1 {
            return err(format!(
                "session mapping unverified: {} top-level Codex rollouts open",
                top.len()
            ));
        }
        sid = top.into_iter().next();
    }
    base["session_id"] = json!(sid);
    Ok(base)
}
pub fn prompt_cells(raw: &str, marker: &str) -> Option<Vec<(char, bool)>> {
    let i = raw.rfind(marker)? + marker.len();
    let mut row = vec![];
    let (mut pos, mut dim) = (i, false);
    while pos < raw.len() {
        let ch = raw[pos..].chars().next()?;
        if ch == '\r' || ch == '\n' {
            break;
        }
        if ch == '\x1b' {
            let rest = &raw[pos..];
            if let Some(m) = re(r"^\x1b\[([0-9;:]*)m").captures(rest) {
                let codes = &m[1];
                if codes.is_empty() {
                    dim = false
                }
                for c in codes.split([';', ':']) {
                    if c == "0" || c == "22" {
                        dim = false
                    } else if c == "2" {
                        dim = true
                    }
                }
                pos += m.get(0)?.end();
                continue;
            }
            return if re(r"^\x1b(?:\[[0-9;?:]*[A-Za-ln-z@`]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[=>78])").is_match(rest){Some(row)}else{None};
        }
        row.push((ch, dim));
        pos += ch.len_utf8();
    }
    Some(row)
}
pub fn suggestion_only(text: &str, raw: &str) -> bool {
    let Some(cells) = prompt_cells(raw, "❯") else {
        return false;
    };
    let shown = cells
        .iter()
        .map(|(c, _)| *c)
        .collect::<String>()
        .replace('\u{a0}', " ");
    let visible: Vec<_> = cells
        .iter()
        .filter(|(c, _)| !c.is_whitespace() && *c != '\u{a0}')
        .collect();
    !text.is_empty()
        && !visible.is_empty()
        && visible.iter().all(|(_, d)| *d)
        && shown.trim() == text.trim()
}
pub fn styled_screen(core: &str, address: &str, limit: f64, quiet: f64) -> Result<String> {
    let mut c = Command::new(core);
    c.args(["attach", "--observe", address])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("HC_TERMINAL_ID")
        .env_remove("HC_SCOPE");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    let mut child = c.spawn()?;
    let mut out = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = [0u8; 65536];
        loop {
            match out.read(&mut b) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(b[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let end = Instant::now() + Duration::from_secs_f64(limit);
    let mut bytes = vec![];
    while Instant::now() < end {
        let wait = if bytes.is_empty() { 0.1 } else { quiet };
        match rx.recv_timeout(Duration::from_secs_f64(
            wait.min((end - Instant::now()).as_secs_f64()),
        )) {
            Ok(b) => bytes.extend(b),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !bytes.is_empty() => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            _ => {}
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if bytes.is_empty() {
        return err("styled screen unavailable");
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
const CV: &[&str] = &[
    "--model",
    "--permission-mode",
    "--append-system-prompt",
    "--system-prompt",
    "--settings",
    "--setting-sources",
    "--agents",
    "--agent",
    "--fallback-model",
    "--permission-prompt-tool",
    "--append-system-prompt-file",
    "--system-prompt-file",
    "--debug-file",
    "--name",
    "-n",
];
const CL: &[&str] = &[
    "--add-dir",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--mcp-config",
    "--tools",
    "--betas",
    "--plugin-dir",
];
const CD: &[&str] = &[
    "-p",
    "--print",
    "-c",
    "--continue",
    "--fork-session",
    "--replay-user-messages",
    "--include-partial-messages",
    "--no-session-persistence",
];
const CDV: &[&str] = &[
    "--resume",
    "-r",
    "--session-id",
    "--output-format",
    "--input-format",
    "--max-turns",
    "--max-budget-usd",
    "--json-schema",
    "--from-pr",
];
const XV: &[&str] = &[
    "-m",
    "--model",
    "-c",
    "--config",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-C",
    "--cd",
    "--add-dir",
    "--enable",
    "--disable",
    "--local-provider",
];
pub fn launch_flags(
    argv: &[String],
    value: &[&str],
    many: &[&str],
    drop: &[&str],
    drop_value: &[&str],
    stop: &[&str],
) -> Vec<String> {
    let mut out = vec![];
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        let head = a.split('=').next().unwrap_or("");
        if stop.contains(&a.as_str()) {
            break;
        }
        if !a.starts_with('-') || a == "-" {
            i += 1;
            continue;
        }
        if a.starts_with("--") && a.contains('=') {
            if !drop.contains(&head) && !drop_value.contains(&head) {
                out.push(a.clone())
            }
            i += 1;
            continue;
        }
        if drop.contains(&a.as_str()) {
            i += 1;
            continue;
        }
        if drop_value.contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if value.contains(&a.as_str()) {
            if let Some(v) = argv.get(i + 1) {
                out.extend([a.clone(), v.clone()])
            }
            i += 2;
            continue;
        }
        if many.contains(&a.as_str()) {
            let mut j = i + 1;
            while j < argv.len()
                && !argv[j].is_empty()
                && !argv[j].starts_with('-')
                && !argv[j].chars().any(|c| c.is_whitespace() || c == '<')
            {
                j += 1
            }
            out.extend_from_slice(&argv[i..j]);
            i = j;
            continue;
        }
        out.push(a.clone());
        i += 1;
    }
    out
}
pub fn new_session_argv(app: &str, argv: &[String]) -> Result<Vec<String>> {
    let kind = provider(app);
    if kind.is_empty() {
        return err(format!("unknown agent {app:?}"));
    }
    let first = argv
        .first()
        .filter(|a| Path::new(a).file_name().unwrap_or_default() == kind)
        .cloned()
        .unwrap_or_else(|| kind.into());
    Ok(vec![first])
}
pub fn resume_argv(app: &str, argv: &[String], sid: &str) -> Result<Vec<String>> {
    let mut out = new_session_argv(app, argv)?;
    let rest = argv.get(1..).unwrap_or_default();
    if provider(app) == "claude" {
        out.extend(launch_flags(rest, CV, CL, CD, CDV, &[]));
        out.extend(["--resume".into(), sid.into()]);
    } else {
        out.extend(launch_flags(
            rest,
            XV,
            &["-i", "--image"],
            &[],
            &[],
            &["resume", "exec", "e", "fork"],
        ));
        out.extend(["resume".into(), sid.into()]);
    }
    Ok(out)
}
pub fn git_brief(folder: &str) -> Value {
    let mut v = json!({"branch":null,"uncommitted":null,"worktrees":null,"head":null});
    if folder.is_empty() {
        return v;
    }
    let read = |a: &[&str]| {
        let mut argv = strings(&["git", "-C", folder]);
        argv.extend(strings(a));
        command(&argv, 12., false)
    };
    if let Ok(b) = read(&["branch", "--show-current"]) {
        v["branch"] = json!(if b.trim().is_empty() {
            "detached"
        } else {
            b.trim()
        });
    }
    if let Ok(h) = read(&["rev-parse", "--short", "HEAD"]) {
        v["head"] = json!(h.trim());
    }
    if let Ok(d) = read(&["status", "--porcelain"]) {
        v["uncommitted"] = json!(d.lines().filter(|l| !l.trim().is_empty()).count());
    }
    if let Ok(w) = read(&["worktree", "list", "--porcelain"]) {
        v["worktrees"] = json!(w.matches("\nworktree ").count() + 1);
    }
    v
}
fn clean(t: &str, limit: usize) -> String {
    let x = re(r"[\x00-\x1f\x7f]+").replace_all(t, " ");
    let x = re(r"(?i)(?:^|[^\w.])/(?:users|home)/[^\s]+").replace_all(x.trim(), "<path>");
    let x = re(r"(?:^|[^\w.])~/[^\s]+").replace_all(&x, "<path>");
    take(&x, limit)
}
pub fn denylist(c: &Value) -> Vec<String> {
    let local = std::env::var_os("HERDR_HARNESS_LOCAL")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_home().join("data/sixfold/harness-local"));
    let path = if truth(&c["harness"]["denylist"]) {
        expand(s(&c["harness"]["denylist"]))
    } else {
        local.join("denylist.txt")
    };
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| l.trim().into())
        .collect()
}
pub fn mask_text(t: &str, terms: &[String]) -> String {
    let mut terms = terms
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    terms.sort_by_key(|s| std::cmp::Reverse(s.chars().count()));
    if terms.is_empty() {
        return t.into();
    }
    re(&format!(
        "(?i){}",
        terms
            .iter()
            .map(|t| regex::escape(t))
            .collect::<Vec<_>>()
            .join("|")
    ))
    .replace_all(t, "[가림]")
    .into_owned()
}
pub fn summary(i: &Value) -> Value {
    let sid = s(&i["session_id"]);
    let app = s(&i["app"]);
    let done = clean(
        &format!(
            "{} {}: {}",
            if truth(&i["space_name"]) {
                s(&i["space_name"])
            } else {
                "?"
            },
            s(&i["address"]),
            if truth(&i["title"]) {
                s(&i["title"])
            } else {
                "제목 없음"
            }
        ),
        280,
    );
    let remaining = if truth(&i["no_resume"]) {
        "다시 열기: 전사 없는 세션이라 이어 열 수 없음. 그 칸에서 Enter 또는 harness.py reopen 으로 새 세션이 워크스페이스 기억을 읽고 시작".into()
    } else {
        format!(
            "다시 열기: 그 칸에서 Enter, 또는 {}",
            if provider(app) == "claude" {
                format!("claude --resume {sid}")
            } else {
                format!("codex resume {sid}")
            }
        )
    };
    let g = &i["git"];
    let risks = if g["branch"].is_null() {
        "git 상태 미확인 또는 git 폴더 아님".into()
    } else {
        clean(
            &format!(
                "git {}@{}: 미커밋 {}개, worktree {}개",
                s(&g["branch"]),
                s(&g["head"]),
                g["uncommitted"],
                g["worktrees"]
            ),
            280,
        )
    };
    json!({"done":done,"remaining":remaining,"risks":risks})
}
pub fn harness_command(c: &Value) -> Result<Vec<String>> {
    let h = &c["harness"];
    if let Some(a) = h["command"].as_array() {
        let a: Vec<_> = a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if !a.is_empty() {
            return Ok(a);
        }
    }
    if truth(&h["python"]) && truth(&h["script"]) {
        return Ok(strings(&[s(&h["python"]), s(&h["script"])]));
    }
    err("harness not configured")
}
fn harness_value(argv: &[String]) -> Result<Value> {
    let o = execute(argv, 60., false)
        .map_err(|e| std::io::Error::other(format!("harness call failed: {e}")))?;
    if o.code != 0 {
        let last = o
            .stderr
            .lines()
            .last()
            .or_else(|| o.stdout.lines().last())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("exit {}", o.code));
        let problems = o
            .stdout
            .trim()
            .lines()
            .last()
            .filter(|l| l.starts_with('{'))
            .and_then(|l| serde_json::from_str::<Value>(l).ok())
            .map(|v| {
                arr(&v["problems"])
                    .iter()
                    .map(|v| s(v))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .filter(|s| !s.is_empty());
        return err(format!(
            "harness refused: {}",
            take(problems.as_deref().unwrap_or(&last), 240)
        ));
    }
    Ok(serde_json::from_str(
        o.stdout
            .trim()
            .lines()
            .last()
            .ok_or_else(|| std::io::Error::other("harness output unreadable"))?,
    )
    .map_err(|_| std::io::Error::other("harness output unreadable"))?)
}
fn identity_argv(c: &Value, i: &Value, action: &str) -> Result<Vec<String>> {
    let mut a = harness_command(c)?;
    a.extend(strings(&[
        action,
        s(&i["address"]),
        "--provider",
        provider(s(&i["app"])),
        "--session-id",
        s(&i["session_id"]),
    ]));
    Ok(a)
}
pub fn harness_park(c: &Value, i: &Value, event: &str, dry: bool, reason: &str) -> Result<Value> {
    let mut a = identity_argv(c, i, "park")?;
    let su = summary(i);
    a.extend(strings(&[
        "--event",
        event,
        "--done",
        s(&su["done"]),
        "--remaining",
        s(&su["remaining"]),
        "--risks",
        s(&su["risks"]),
    ]));
    if truth(&i["space_id"]) {
        a.extend(strings(&["--space-id", s(&i["space_id"])]));
    }
    if !reason.is_empty() {
        a.extend(["--reason".into(), clean(reason, 280)]);
    }
    if truth(&i["report_task_id"]) {
        a.extend(strings(&["--task-id", s(&i["report_task_id"])]));
    }
    a.push("--mask".into());
    if dry {
        a.push("--dry-run".into())
    }
    let v = harness_value(&a)?;
    if dry {
        if truth(&v["ok"]) {
            Ok(json!("harness would accept"))
        } else {
            err("harness refused")
        }
    } else if truth(&v["id"]) {
        Ok(v["id"].clone())
    } else {
        err("harness record id missing")
    }
}
pub fn harness_close_status(c: &Value, i: &Value, since: &str) -> Result<Value> {
    let mut a = identity_argv(c, i, "close-status")?;
    a.extend(strings(&["--since", since]));
    let output = execute(&a, 60., false)
        .map_err(|e| std::io::Error::other(take(&format!("close-status unavailable: {e}"), 240)))?;
    let v: Value = serde_json::from_str(output.stdout.trim().lines().last().unwrap_or(""))
        .map_err(|e| std::io::Error::other(take(&format!("close-status unavailable: {e}"), 240)))?;
    if output.code != 0 || !v.is_object() {
        return err("close-status refused");
    }
    if truth(&v["ok"]) && truth(&v["report_id"]) {
        Ok(json!({"report_id":v["report_id"],"task_id":v["task_id"],"at":v["at"]}))
    } else {
        err("no close report yet")
    }
}
pub fn harness_close_gate(c: &Value, i: &Value) -> Result<Value> {
    let mut a = identity_argv(c, i, "close-gate")?;
    if truth(&i["space_id"]) {
        a.extend(strings(&["--space-id", s(&i["space_id"])]))
    }
    let output = execute(&a, 60., false)
        .map_err(|e| std::io::Error::other(take(&format!("close-gate unavailable: {e}"), 200)))?;
    let v: Value = serde_json::from_str(output.stdout.trim().lines().last().unwrap_or(""))
        .map_err(|e| std::io::Error::other(take(&format!("close-gate unavailable: {e}"), 200)))?;
    if output.code != 0 || !v.is_object() {
        return err("close-gate refused");
    }
    if truth(&v["ok"]) {
        Ok(v)
    } else {
        let blockers = arr(&v["blockers"])
            .iter()
            .map(|v| s(v))
            .collect::<Vec<_>>()
            .join(", ");
        err(if blockers.is_empty() {
            "refused".into()
        } else {
            blockers
        })
    }
}
pub fn harness_archive(c: &Value, data: &Value) -> Result<Value> {
    if !truth(&data["workspace_id"]) || s(&data["workspace_id"]).starts_with("None-") {
        return err("machine id unknown");
    }
    let mut a = harness_command(c)?;
    let file = std::env::temp_dir().join(format!("space-archive-{}.json", uuid::Uuid::new_v4()));
    save(&file, data)?;
    a.extend(strings(&[
        "archive",
        "--file",
        &file.to_string_lossy(),
        "--mask",
    ]));
    let v = harness_value(&a);
    let _ = fs::remove_file(file);
    let v = v?;
    if truth(&v["archive"]) {
        Ok(v["archive"].clone())
    } else {
        err("harness output unreadable")
    }
}
pub fn close_report_message(c: &Value) -> String {
    let h = &c["harness"];
    let command = if let Ok(a) = harness_command(c) {
        a.join(" ")
    } else {
        format!(
            "{} {}",
            h["python"].as_str().unwrap_or("python3"),
            h["script"].as_str().unwrap_or("harness.py")
        )
    };
    format!("{REPORT_MARK} 관찰기가 이 세션을 곧 정리(절전)합니다. 새 작업은 시작하지 말고 아래만 하세요. 1) 레포 밖 임시 파일(예: $TMPDIR/experience-close.json)에 experience JSON을 씁니다: {{\"judgments\": [{{\"situation\": \"무엇을 판단했나\", \"expected\": \"예상\", \"actual\": \"실제\", \"error\": \"MATCHED|PARTIAL|WRONG\"}}]}} (판단 1~5개, 선택: cause·surprise·pattern_candidates). 2) {command} close-report --mask --done \"이 세션이 한 일\" --remaining \"남은 일\" --experience <그 파일> 를 실행합니다. 확정한 결정은 --decision \"…\"(여러 번), 만들거나 고친 문서는 --doc <파일>(여러 번, 원본은 그대로)을 붙입니다. 3) 고객·회사·제품 이름 대신 워크스페이스 id를 씁니다(--mask가 남은 이름을 [가림]으로 바꿉니다). 다른 이유로 거부되면 문장을 고쳐 다시 실행합니다. 다른 세션에 보고하지 말고, 보고 id만 한 줄로 답하고 끝내세요. 승인은 사람이 기억함에서 합니다.")
}
fn in_time(at: &Value, deadline: f64) -> bool {
    at.as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp() as f64 <= deadline)
        .unwrap_or(false)
}
pub fn report_gate(
    entries: &mut Value,
    item: &Value,
    a: &mut dyn Adapter,
    c: &Value,
    now: f64,
) -> Result<(String, Value)> {
    let cfg = &c["close_report"];
    if cfg["enabled"] == false {
        return Ok(("off".into(), Value::Null));
    }
    let (timeout, retry, turns) = (
        num(&cfg["timeout_seconds"], 900.),
        num(&cfg["retry_seconds"], 3600.),
        num(&cfg["turns"], 1.),
    );
    let address = s(&item["address"]);
    let mut entry = entries[address].clone();
    if entry["session_id"] != item["session_id"] {
        entry = Value::Null
    }
    let mut worked = false;
    if entry.is_object()
        && item["turn"].as_i64().is_some()
        && entry["turn"].as_i64().is_some()
        && num(&item["turn"], 0.) > num(&entry["turn"], 0.) + turns
    {
        entry = Value::Null;
        worked = true
    }
    if truth(&entry["failed_at"]) {
        if now - num(&entry["failed_at"], now) < retry {
            return Ok((
                "failed".into(),
                json!(format!(
                    "no close report (asked {} minutes ago): kept, asks again later",
                    ((now - num(&entry["requested_at"], now)) / 60.).floor()
                )),
            ));
        }
        entry = Value::Null
    }
    if entry.is_null() {
        if let Some(e) = entries.as_object_mut() {
            e.remove(address);
        }
        let idle = num(&item["status_ms"], 0.) / 1000.;
        if idle > 0. && !worked {
            let lookback = if truth(&item["answered_report"]) {
                num(&cfg["answered_lookback_seconds"], 21600.)
            } else {
                num(&cfg["report_lookback_seconds"], 900.)
            };
            let since = iso(idle - lookback);
            if let Ok(detail) = a.close_status(c, item, &since) {
                entries[address] = json!({"session_id":item["session_id"],"requested_at":now,"since":since,"turn":item["turn"],"report":detail,"earlier":true});
                return Ok(("ready".into(), detail));
            }
        }
        a.request_report(address, &close_report_message(c))?;
        entries[address] = json!({"session_id":item["session_id"],"requested_at":now,"since":iso(now.ceil()),"turn":item["turn"]});
        return Ok(("requested".into(), Value::Null));
    }
    if truth(&entry["report"]) {
        return Ok(("ready".into(), entry["report"].clone()));
    }
    let deadline = num(&entry["requested_at"], now) + timeout;
    let mut found = a.close_status(c, item, s(&entry["since"]));
    if found.is_err() && truth(&item["answered_report"]) {
        found = a.close_status(
            c,
            item,
            &iso(num(&entry["requested_at"], now) - num(&cfg["answered_lookback_seconds"], 21600.)),
        );
    }
    match found {
        Ok(detail)
            if in_time(&detail["at"], deadline) || (detail["at"].is_null() && now < deadline) =>
        {
            entry["report"] = detail.clone();
            entries[address] = entry;
            Ok(("ready".into(), detail))
        }
        x => {
            if now >= deadline {
                entry["failed_at"] = json!(now);
                entries[address] = entry;
                Ok((
                    "failed".into(),
                    json!(format!(
                        "no close report within {} minutes: kept (fail-closed)",
                        (timeout / 60.).floor()
                    )),
                ))
            } else {
                Ok((
                    "waiting".into(),
                    json!(match x {
                        Ok(_) => "report after the limit".into(),
                        Err(e) => e.to_string(),
                    }),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn flags_drop_prompts() {
        assert_eq!(
            resume_argv(
                "claude",
                &strings(&[
                    "claude",
                    "--model",
                    "opus",
                    "--resume",
                    "old",
                    "implement old task"
                ]),
                "sid"
            )
            .unwrap(),
            strings(&["claude", "--model", "opus", "--resume", "sid"])
        );
        assert_eq!(
            resume_argv(
                "codex",
                &strings(&["codex", "-m", "m", "resume", "old", "prompt"]),
                "new"
            )
            .unwrap(),
            strings(&["codex", "-m", "m", "resume", "new"])
        );
    }
    #[test]
    fn suggestions_are_dim_only() {
        assert!(suggestion_only(
            "Try fixing tests",
            "❯ \x1b[2mTry fixing tests\x1b[0m"
        ));
        assert!(!suggestion_only("Try fixing tests", "❯ Try fixing tests"));
    }
    #[test]
    fn gap_keeps_errors() {
        assert_eq!(
            trial_of(
                &json!({"trial":{"error_count":2,"healthy":2,"samples":5}}),
                50.,
                false
            )["error_count"],
            2
        );
        let mut st = json!({"trial":{"error_count":1}});
        for _ in 0..2 {
            settle_trial(&mut st, &json!({}), true);
        }
        assert_eq!(st["trial"]["error_count"], 1);
        settle_trial(&mut st, &json!({}), true);
        assert_eq!(st["trial"]["error_count"], 0);
    }
    #[test]
    fn helper_descendants_still_work() {
        let t = json!({"pid":1,"foreground":{"pid":2}});
        let p = json!({"1":{"name":"zsh","parent":0},"2":{"name":"codex","parent":1},"3":{"name":"node_repl","args":"/x/node_repl","parent":2},"4":{"name":"bash","parent":3}});
        assert!(!process_evidence(&t, &p).0);
    }
    #[test]
    fn mask_longest_first() {
        assert_eq!(
            mask_text("Abc abcdef", &strings(&["abc", "abcdef"])),
            "[가림] [가림]"
        );
    }
}
