//! Read-only bounded transcript proof; command stdout cannot manufacture host completion.
use super::*;
#[cfg(test)]
mod database_contracts;
use std::collections::{BTreeMap, BTreeSet};
const MAX_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Debug)]
struct Unverified(String);
impl std::fmt::Display for Unverified {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for Unverified {}
fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(Box::new(Unverified(message.into())))
}
fn identifier(v: &Value) -> Option<String> {
    match v {
        Value::String(t) if !t.is_empty() => Some(t.clone()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}
fn arguments(p: &Value) -> Result<(Value, String)> {
    let raw = p
        .get("arguments")
        .or_else(|| p.get("input"))
        .or_else(|| p.get("call_args"))
        .cloned()
        .unwrap_or(json!({}));
    if raw.is_object() {
        return Ok((raw, String::new()));
    }
    let Some(t) = raw.as_str() else {
        return Ok((json!({}), String::new()));
    };
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        if v.is_object() {
            return Ok((v, t.into()));
        }
    }
    let mut args = json!({});
    for key in ["session_id", "cell_id"] {
        let pattern = format!(r#"\b{}\s*:\s*("[^"\n]+"|'[^'\n]+'|\d+)"#, key);
        let values: BTreeSet<_> = re(&pattern)
            .captures_iter(t)
            .map(|m| m[1].trim_matches(['\'', '"']).to_owned())
            .collect();
        if values.len() > 1 {
            return err("ambiguous backend poll session");
        }
        if let Some(v) = values.first() {
            args[key] = json!(v)
        }
    }
    Ok((args, t.into()))
}
fn truncated_result(t: &str) -> Option<Value> {
    let m = re(
        r"\AWarning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n",
    )
    .find(t)?;
    let t = &t[m.end()..];
    let boundary = re(r#",\s*"output"\s*:"#).find(t)?;
    let prefix: Value = serde_json::from_str(&format!("{}}}", &t[..boundary.start()])).ok()?;
    if prefix["chunk_id"]
        .as_str()
        .map(|x| re(r"^[0-9a-f]+$").is_match(x))
        != Some(true)
        || !prefix["wall_time_seconds"].is_number()
    {
        return None;
    }
    if prefix.get("exit_code").is_some() || prefix.get("session_id").is_some() {
        Some(prefix)
    } else {
        None
    }
}
fn outputs(v: &Value, depth: usize, out: &mut Vec<Value>) -> Result<()> {
    if depth > 32 {
        return err("backend output nesting unverified");
    }
    match v {
        Value::String(t) => match serde_json::from_str::<Value>(t) {
            Ok(v) => outputs(&v, depth + 1, out)?,
            Err(_) => {
                if let Some(p) = truncated_result(t) {
                    out.push(p)
                }
            }
        },
        Value::Array(a) => {
            for p in a {
                outputs(p, depth + 1, out)?
            }
        }
        Value::Object(o) => {
            out.push(v.clone());
            if o.contains_key("session_id") || o.contains_key("exit_code") {
                return Ok(());
            }
            for k in ["text", "output", "content", "result", "structuredContent"] {
                if let Some(v) = o.get(k) {
                    outputs(v, depth + 1, out)?
                }
            }
        }
        _ => {}
    }
    Ok(())
}
fn wrapper_texts(v: &Value) -> Vec<String> {
    match v {
        Value::String(t) => serde_json::from_str::<Value>(t)
            .map(|v| wrapper_texts(&v))
            .unwrap_or_else(|_| vec![t.clone()]),
        Value::Array(a) => a
            .iter()
            .filter_map(|p| p["text"].as_str().map(str::to_owned))
            .collect(),
        Value::Object(o) => {
            if let Some(t) = o.get("text").and_then(Value::as_str) {
                vec![t.into()]
            } else if let Some(a) = o.get("content").filter(|v| v.is_array()) {
                wrapper_texts(a)
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}
#[derive(Clone)]
struct Call {
    name: String,
    args: Value,
    relevant: bool,
    raw: String,
}
pub fn codex_log(records: &[Value]) -> Result<Option<String>> {
    let (mut calls, mut pending, mut sessions, mut cells) = (
        BTreeMap::<String, Call>::new(),
        BTreeSet::<String>::new(),
        BTreeSet::<String>::new(),
        BTreeSet::<String>::new(),
    );
    let mut lifecycle = None;
    for r in records {
        let p = &r["payload"];
        if truth(&r["history_truncated"])
            || truth(&r["truncated_history"])
            || truth(&p["history_truncated"])
            || truth(&p["truncated_history"])
        {
            return err("truncated rollout history");
        }
        if !p.is_object() {
            return err("invalid rollout payload");
        }
        if r["type"] == "event_msg" {
            if p["type"] == "task_started" {
                lifecycle = Some("working".into())
            } else if p["type"] == "task_complete" || p["type"] == "turn_aborted" {
                lifecycle = Some("finished".into())
            }
        }
        if r["type"] != "response_item" {
            continue;
        }
        let kind = s(&p["type"]);
        if ["function_call", "custom_tool_call", "tool_call"].contains(&kind) {
            let id = p
                .get("call_id")
                .or_else(|| p.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if id.is_empty() || calls.contains_key(id) {
                return err("tool call identity/history unverified");
            }
            let (args, raw) = arguments(p)?;
            let name = s(&p["name"])
                .split('.')
                .next_back()
                .unwrap_or("")
                .to_lowercase();
            let relevant = [
                "exec_command",
                "write_stdin",
                "exec",
                "wait",
                "shell",
                "bash",
            ]
            .contains(&name.as_str())
                || re(r"\b(?:exec_command|write_stdin)\s*\(").is_match(&raw);
            calls.insert(
                id.into(),
                Call {
                    name,
                    args,
                    relevant,
                    raw,
                },
            );
            pending.insert(id.into());
        } else if [
            "function_call_output",
            "custom_tool_call_output",
            "tool_result",
        ]
        .contains(&kind)
        {
            let id = p
                .get("call_id")
                .or_else(|| p.get("tool_call_id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(call) = calls.get(id) else {
                return err("tool output without its complete call history");
            };
            if !pending.remove(id) {
                return err("tool output without its complete call history");
            }
            if !call.relevant {
                continue;
            }
            let output = p
                .get("output")
                .or_else(|| p.get("content"))
                .unwrap_or(&Value::Null);
            let mut objects = vec![];
            outputs(output, 0, &mut objects)?;
            let texts = wrapper_texts(output);
            let mut running = false;
            for t in &texts {
                for m in
                    re(r"(?m)^Script running with cell ID\s+([A-Za-z0-9:_-]+)").captures_iter(t)
                {
                    cells.insert(m[1].into());
                    running = true;
                }
            }
            let completed = texts
                .iter()
                .any(|t| re(r"^Script completed(?:\s|$)").is_match(t));
            if let Some(cell) = identifier(&call.args["cell_id"]) {
                if completed && !cells.remove(&cell) {
                    return err("execution cell completion has no matching start");
                }
            }
            let session = identifier(&call.args["session_id"]);
            let mut saw = false;
            for result in objects {
                let result_session = identifier(&result["session_id"]);
                let exited = result["exit_code"].as_i64().is_some();
                if let Some(rs) = result_session {
                    saw = true;
                    if session.as_ref().is_some_and(|id| *id != rs) && call.name != "exec" {
                        return err("backend poll session identity mismatch");
                    }
                    if exited {
                        sessions.remove(&rs);
                    } else {
                        sessions.insert(rs);
                    }
                } else if exited {
                    saw = true;
                    if let Some(s) = &session {
                        sessions.remove(s);
                    }
                }
            }
            let shell = ["exec_command", "write_stdin", "shell", "bash"]
                .contains(&call.name.as_str())
                || call.raw.contains("exec_command")
                || call.raw.contains("write_stdin");
            if shell && !saw && !running && !completed {
                return err("backend command result unverified");
            }
        }
    }
    if pending.iter().any(|id| calls[id].relevant)
        || (!pending.is_empty() && lifecycle.as_deref() != Some("finished"))
    {
        return err("pending backend tool calls");
    }
    if !cells.is_empty() {
        return err("running backend execution cells");
    }
    if !sessions.is_empty() {
        return err("running backend exec sessions");
    }
    Ok(lifecycle)
}
pub fn codex_finished(records: &[Value]) -> bool {
    records
        .iter()
        .rev()
        .find(|r| {
            r["type"] == "event_msg"
                && ["task_started", "task_complete", "turn_aborted"]
                    .contains(&s(&r["payload"]["type"]))
        })
        .is_some_and(|r| r["payload"]["type"] != "task_started")
}
fn read_jsonl(
    path: &Path,
    sid: Option<&str>,
    obs: &mut Vec<Value>,
    claude: bool,
) -> Result<(Vec<Value>, f64)> {
    let before = fs::metadata(path)?;
    let used: u64 = obs.iter().map(|i| i["bytes"].as_u64().unwrap_or(0)).sum();
    if before.len() > MAX_BYTES || (!claude && before.len() + used > MAX_BYTES) {
        return err(if claude {
            "backend jobs unverified: Claude history too large"
        } else {
            "rollout exceeds 64 MiB read budget; backend jobs unverified"
        });
    }
    let bytes = fs::read(path)?;
    let after = fs::metadata(path)?;
    if bytes.len() as u64 > MAX_BYTES
        || bytes.last() != Some(&b'\n')
        || before.len() != after.len()
        || before.modified()? != after.modified()?
    {
        return err(if claude {
            "backend jobs unverified: Claude history incomplete"
        } else {
            "incomplete rollout history"
        });
    }
    let text = std::str::from_utf8(&bytes)?;
    let mut records = vec![];
    let mut talk = vec![];
    for line in text.split('\n').filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line)?;
        if !v.is_object() {
            return err("invalid rollout history");
        }
        if truth(&v["timestamp"]) {
            talk.push(line)
        }
        records.push(v);
    }
    let modified = after.modified()?.duration_since(UNIX_EPOCH)?.as_secs_f64() * 1000.;
    if claude {
        obs.push(json!({"claude_log":path.to_string_lossy(),"sha256":hash(talk.join("\n")),"lines":talk.len()}));
    } else {
        if records
            .first()
            .map(|r| r["type"] == "session_meta" && r["payload"]["id"] == sid.unwrap_or(""))
            != Some(true)
        {
            return err("rollout session identity/history unverified");
        }
        let ns = after.modified()?.duration_since(UNIX_EPOCH)?.as_nanos();
        obs.push(json!({"session":sid,"sha256":hash(bytes),"mtime_ns":ns.to_string(),"bytes":after.len()}));
    }
    Ok((records, modified))
}
fn codex(t: &Value, m: &Value, c: &Value, obs: &mut Vec<Value>) -> Result<()> {
    let db = if truth(&c["codex_db"]) {
        expand(s(&c["codex_db"]))
    } else {
        home().join(".codex/state_5.sqlite")
    };
    if !db.is_file() {
        return err("backend jobs unverified: Codex state database missing");
    }
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.busy_timeout(Duration::from_secs(1))?;
    conn.pragma_update(None, "query_only", true)?;
    let mut seen = BTreeSet::new();
    fn visit(
        conn: &rusqlite::Connection,
        sid: &str,
        main: bool,
        edge: &str,
        t: &Value,
        c: &Value,
        obs: &mut Vec<Value>,
        seen: &mut BTreeSet<String>,
    ) -> Result<()> {
        if seen.contains(sid) {
            return err("child session graph cycle/alias unverified");
        }
        if seen.len() >= 1000 {
            return err("child session graph too large");
        }
        seen.insert(sid.into());
        let path = conn
            .query_row(
                "select rollout_path from threads where id = ?",
                [sid],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| Unverified("backend jobs unverified: rollout path missing".into()))?;
        let (records, mtime) = read_jsonl(Path::new(&path), Some(sid), obs, false)?;
        if main && mtime <= num(&t["status_ms"], 0.) - 5000. {
            return err("stale main rollout/session mapping");
        }
        let phase = match codex_log(&records) {
            Ok(p) => p,
            Err(e)
                if e.to_string() == "running backend exec sessions"
                    && truth(&c["_process_tree_clean"]) =>
            {
                obs.push(json!({"open_exec_sessions_without_processes":sid}));
                if codex_finished(&records) {
                    Some("finished".into())
                } else {
                    None
                }
            }
            Err(e) => return Err(e),
        };
        if phase.as_deref() != Some("finished") && edge != "closed" {
            return err(if main {
                "main backend task working/unknown"
            } else {
                "open child task working/unknown"
            });
        }
        let mut st=conn.prepare("select child_thread_id,status from thread_spawn_edges where parent_thread_id = ? order by child_thread_id")?;
        let rows = st
            .query_map([sid], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        obs.push(json!({"parent":sid,"children":rows}));
        for (child, edge) in rows {
            if !["open", "closed"].contains(&edge.as_str()) {
                return err("child session link status unverified");
            }
            visit(conn, &child, false, &edge, t, c, obs, seen)?;
        }
        Ok(())
    }
    visit(&conn, s(&m["session_id"]), true, "", t, c, obs, &mut seen)
}
fn ended_tasks(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for block in re(r"(?s)<task-notification>(.*?)</task-notification>").captures_iter(text) {
        if re(r"<status>(?:completed|failed|killed|stopped|cancelled)</status>").is_match(&block[1])
        {
            for id in re(r"<(?:task-id|tool-use-id)>([A-Za-z0-9_-]+)</(?:task-id|tool-use-id)>")
                .captures_iter(&block[1])
            {
                found.insert(id[1].into());
            }
        }
    }
    found
}
fn real_prompt(i: &Value, m: &Value) -> bool {
    if truth(&i["isMeta"]) || !i["toolUseResult"].is_null() || truth(&i["isCompactSummary"]) {
        return false;
    }
    let content = &m["content"];
    let t = if content.is_array() {
        if arr(content).iter().any(|p| p["type"] == "tool_result") {
            return false;
        }
        arr(content)
            .iter()
            .map(|p| s(&p["text"]))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        s(content).into()
    };
    let t = t.trim_start();
    !t.is_empty()
        && !['<'].iter().any(|_| {
            [
                "<local-command-",
                "<command-name>",
                "<command-message>",
                "<task-notification>",
                "<system-reminder>",
            ]
            .iter()
            .any(|x| t.starts_with(x))
        })
}
pub fn claude_log(records: &[Value], sid: &str, finished_by_meta: bool) -> Result<()> {
    let (mut pending, mut started, mut ended, mut background) = (
        BTreeSet::<String>::new(),
        BTreeSet::<String>::new(),
        BTreeSet::<String>::new(),
        BTreeSet::<String>::new(),
    );
    let mut alias = BTreeMap::<String, String>::new();
    let (mut finished, mut identified) = (false, false);
    for i in records {
        if !i.is_object() {
            return err("backend jobs unverified: Claude history invalid");
        }
        let m = &i["message"];
        let kind = i["type"].as_str().or(m["role"].as_str()).unwrap_or("");
        if kind.starts_with("api-request") {
            continue;
        }
        if truth(&i["sessionId"]) {
            if i["sessionId"] != sid {
                return err("backend jobs unverified: Claude session identity mismatch");
            }
            identified = true
        }
        let raw = i.to_string();
        if raw.contains("<task-notification>") {
            ended.extend(ended_tasks(&raw.replace("\\n", "\n")));
        }
        if !["assistant", "user"].contains(&kind) {
            continue;
        }
        let r = &i["toolUseResult"];
        let mut launched = BTreeSet::new();
        if truth(&r["backgroundTaskId"]) {
            launched.insert(s(&r["backgroundTaskId"]).to_string());
        }
        if truth(&r["agentId"]) && (truth(&r["isAsync"]) || r["status"] == "async_launched") {
            launched.insert(s(&r["agentId"]).to_string());
        }
        started.extend(launched.clone());
        for part in arr(&m["content"]) {
            if part["type"] == "tool_use" {
                let id = s(&part["id"]);
                if id.is_empty() || !pending.insert(id.into()) {
                    return err("backend jobs unverified: Claude tool identity");
                }
                if truth(&part["input"]["run_in_background"]) {
                    background.insert(id.into());
                }
            } else if part["type"] == "tool_result" {
                let id = s(&part["tool_use_id"]);
                if !pending.remove(id) {
                    return err("backend jobs unverified: Claude tool history");
                }
                let text = part["content"].to_string();
                let mut tasks: BTreeSet<String> =
                    re(r"(?i)running in (?:the )?background with ID:\s*([A-Za-z0-9_-]+)")
                        .captures_iter(&text)
                        .map(|m| m[1].into())
                        .collect();
                tasks.extend(launched.clone());
                if background.contains(id) && tasks.is_empty() && !truth(&part["is_error"]) {
                    tasks.insert(id.into());
                }
                started.extend(tasks.clone());
                for task in tasks {
                    alias.insert(task.clone(), id.into());
                    alias.insert(id.into(), task);
                }
                for m in re(r"Successfully (?:stopped task|killed shell):?\s*([A-Za-z0-9_-]+)")
                    .captures_iter(&text)
                {
                    ended.insert(m[1].into());
                }
            }
        }
        if m["role"] == "assistant" {
            finished = m["stop_reason"] == "end_turn"
        } else if real_prompt(i, m) {
            finished = false
        }
    }
    if !identified {
        return err("backend jobs unverified: Claude session identity");
    }
    if pending.intersection(&background).next().is_some()
        || started
            .iter()
            .any(|t| !ended.contains(t) && !alias.get(t).is_some_and(|a| ended.contains(a)))
    {
        return err("backend jobs unverified: Claude background job running");
    }
    if finished_by_meta {
        return Ok(());
    }
    if !pending.is_empty() {
        return err("backend jobs unverified: Claude tool call without result");
    }
    if !finished {
        return err("backend jobs unverified: Claude turn not ended");
    }
    Ok(())
}
fn project_files(home: &Path, sid: &str, children: bool) -> Result<Vec<PathBuf>> {
    let root = home.join("projects");
    let mut out = vec![];
    if !root.is_dir() {
        return Ok(out);
    }
    for folder in fs::read_dir(root)? {
        let folder = folder?.path();
        if children {
            let child = folder.join(sid).join("subagents");
            if child.is_dir() {
                for e in fs::read_dir(child)? {
                    let p = e?.path();
                    if p.to_string_lossy().ends_with(".meta.json") {
                        out.push(p)
                    }
                }
            }
        } else {
            let p = folder.join(format!("{sid}.jsonl"));
            if p.is_file() {
                out.push(p)
            }
        }
    }
    out.sort();
    Ok(out)
}
fn claude(t: &Value, m: &Value, c: &Value, obs: &mut Vec<Value>) -> Result<()> {
    let h = if truth(&c["claude_home"]) {
        expand(s(&c["claude_home"]))
    } else {
        home().join(".claude")
    };
    let pid = m.get("process_pid").unwrap_or(&m["pid"]);
    let Some(pid) = pid.as_u64() else {
        return err("backend jobs unverified: Claude process identity");
    };
    let meta = load(h.join("sessions").join(format!("{pid}.json")), Value::Null)?;
    let sid = s(&m["session_id"]);
    if !meta.is_object() || meta["sessionId"] != sid {
        return err("backend jobs unverified: Claude session mapping");
    }
    obs.push(json!({"claude_meta":meta}));
    let log = if truth(&meta["transcriptPath"]) {
        PathBuf::from(s(&meta["transcriptPath"]))
    } else if truth(&meta["logPath"]) {
        PathBuf::from(s(&meta["logPath"]))
    } else {
        let p = project_files(&h, sid, false)?;
        if p.len() != 1 {
            return err("backend jobs unverified: Claude log identity");
        }
        p[0].clone()
    };
    let (records, mtime) = read_jsonl(&log, None, obs, true)?;
    if mtime <= num(&t["status_ms"], 0.) - 5000. {
        return err("backend jobs unverified: stale Claude log");
    }
    claude_log(&records, sid, false)?;
    for meta_path in project_files(&h, sid, true)? {
        let child = load(&meta_path, Value::Null)?;
        if !child.is_object() || child["finished"] == false {
            return err("backend jobs unverified: Claude child working/unknown");
        }
        let log = if truth(&child["logPath"]) {
            PathBuf::from(s(&child["logPath"]))
        } else {
            PathBuf::from(meta_path.to_string_lossy().replace(".meta.json", ".jsonl"))
        };
        let (records, _) = read_jsonl(&log, None, obs, true)?;
        let child_sid = child["sessionId"].as_str().unwrap_or(sid);
        if child_sid.is_empty() {
            return err("backend jobs unverified: Claude child session identity");
        }
        claude_log(&records, child_sid, child["finished"] == true)?;
        obs.push(json!({"claude_child_meta":child}));
    }
    Ok(())
}
pub fn check_jobs(t: &Value, c: &Value, mapping: &Value, clean: bool) -> (bool, String, String) {
    let mut c = c.clone();
    c["_process_tree_clean"] = json!(clean);
    let mut info = json!({});
    for k in ["address", "pid", "created_ms", "status_ms", "status"] {
        info[k] = t[k].clone()
    }
    let mut obs = vec![json!({"terminal":info})];
    let checked = (|| -> Result<()> {
        let configured = &c["sessions"][s(&t["address"])];
        let m = if truth(configured) {
            configured
        } else {
            mapping
        };
        if !m.is_object() {
            return err("backend jobs unverified: session mapping missing");
        }
        obs.push(json!({"mapping":m}));
        for key in ["pid", "created_ms"] {
            if t[key].as_u64().unwrap_or(0) == 0 || m[key] != t[key] {
                return err("backend jobs unverified: terminal/session mapping mismatch");
            }
        }
        if !t["status_ms"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n > 0.)
        {
            return err("backend jobs unverified: status timestamp missing");
        }
        let agent = s(&m["agent"]);
        if !m["session_id"].as_str().is_some_and(|x| !x.is_empty())
            || !sessions::AGENTS.contains(&agent)
            || t["status"]["app"] != agent
        {
            return err("backend jobs unverified: agent/session mapping mismatch");
        }
        if agent == "codex" {
            codex(t, m, &c, &mut obs)
        } else {
            claude(t, m, &c, &mut obs)
        }
    })();
    let fp = fingerprint_ascii(&json!(obs), false);
    match checked {
        Ok(_) => (true, String::new(), fp),
        Err(e) => (
            false,
            if e.is::<Unverified>() {
                e.to_string()
            } else {
                "backend jobs unverified: evidence unreadable or invalid".into()
            },
            fp,
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn r(p: Value) -> Value {
        json!({"type":"response_item","payload":p})
    }
    #[test]
    fn unrelated_exit_does_not_finish_session() {
        let v = vec![
            r(json!({"type":"function_call","name":"exec_command","call_id":"a","arguments":{}})),
            r(json!({"type":"function_call_output","call_id":"a","output":{"session_id":12}})),
            r(json!({"type":"function_call","name":"exec_command","call_id":"b","arguments":{}})),
            r(
                json!({"type":"function_call_output","call_id":"b","output":{"exit_code":0,"output":"{\"session_id\":12,\"exit_code\":0}"}}),
            ),
        ];
        assert!(codex_log(&v)
            .unwrap_err()
            .to_string()
            .contains("running backend exec sessions"));
    }
    #[test]
    fn pending_exec_blocks_finished_turn() {
        assert!(codex_log(&[
            r(json!({"type":"function_call","name":"exec_command","call_id":"a","arguments":{}})),
            json!({"type":"event_msg","payload":{"type":"task_complete"}})
        ])
        .is_err());
    }
    #[test]
    fn claude_background_survives_end_turn() {
        let v = vec![
            json!({"type":"assistant","sessionId":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","input":{"run_in_background":true}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"running in background with ID: job"}]}}),
            json!({"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn"}}),
        ];
        assert!(claude_log(&v, "s", false)
            .unwrap_err()
            .to_string()
            .contains("background job"));
    }
}
