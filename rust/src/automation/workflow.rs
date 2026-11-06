use super::tiers::family;
use crate::common::*;
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[derive(Default)]
pub struct Collector {
    holders: HashMap<u32, String>,
    scanned: HashMap<Vec<u32>, f64>,
    processes: (f64, HashMap<u32, u32>),
    transcripts:
        HashMap<(PathBuf, String, String), (u128, u64, (Option<String>, Option<String>, String))>,
}
#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Process {
        pid: u32,
        started: [u32; 2],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Info {
        process: Process,
        app: [u16; 256],
        service: [u16; 64],
        kind: i32,
        status: u32,
        session: u32,
        restartable: i32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(h: *mut c_void, e: *mut Entry) -> i32;
        fn Process32NextW(h: *mut c_void, e: *mut Entry) -> i32;
        fn CloseHandle(h: *mut c_void) -> i32;
    }
    #[link(name = "rstrtmgr", kind = "raw-dylib")]
    unsafe extern "system" {
        fn RmStartSession(session: *mut u32, flags: u32, key: *mut u16) -> u32;
        fn RmRegisterResources(
            session: u32,
            files: u32,
            names: *const *const u16,
            apps: u32,
            processes: *const Process,
            services: u32,
            service_names: *const *const u16,
        ) -> u32;
        fn RmGetList(
            session: u32,
            needed: *mut u32,
            count: *mut u32,
            infos: *mut Info,
            reasons: *mut u32,
        ) -> u32;
        fn RmEndSession(session: u32) -> u32;
    }
    pub fn processes() -> std::collections::HashMap<u32, u32> {
        let mut result = std::collections::HashMap::new();
        unsafe {
            let h = CreateToolhelp32Snapshot(2, 0);
            if h.is_null() || h as isize == -1 {
                return result;
            }
            let mut e: Entry = std::mem::zeroed();
            e.size = std::mem::size_of::<Entry>() as u32;
            let mut more = Process32FirstW(h, &mut e);
            while more != 0 {
                result.insert(e.pid, e.parent);
                more = Process32NextW(h, &mut e);
            }
            CloseHandle(h);
        }
        result
    }
    pub fn holders(path: &str) -> std::collections::HashSet<u32> {
        let mut result = std::collections::HashSet::new();
        unsafe {
            let mut session = 0;
            let mut key = [0u16; 64];
            if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
                return result;
            }
            let path: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
            let p = path.as_ptr();
            if RmRegisterResources(session, 1, &p, 0, std::ptr::null(), 0, std::ptr::null()) == 0 {
                let mut needed = 0;
                let mut count = 16;
                let mut reasons = 0;
                let mut infos: [Info; 16] = std::mem::zeroed();
                if RmGetList(
                    session,
                    &mut needed,
                    &mut count,
                    infos.as_mut_ptr(),
                    &mut reasons,
                ) == 0
                {
                    result.extend(infos[..count as usize].iter().map(|i| i.process.pid));
                }
            }
            RmEndSession(session);
        }
        result
    }
}
fn cached_process_table(cache: &mut (f64, HashMap<u32, u32>)) -> HashMap<u32, u32> {
    if now() - cache.0 < 1. {
        return cache.1.clone();
    }
    #[cfg(windows)]
    let p = win::processes();
    #[cfg(not(windows))]
    let p = output("ps", &strings(&["-axo", "pid=,ppid="]), 10.)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut w = crate::python_unicode::split_whitespace(l).into_iter();
            Some((w.next()?.parse().ok()?, w.next()?.parse().ok()?))
        })
        .collect();
    *cache = (now(), p);
    cache.1.clone()
}
pub trait RolloutBackend {
    fn clock(&self) -> f64;
    fn holders(&mut self, path: &str) -> HashSet<u32>;
    fn processes(&mut self) -> HashMap<u32, u32>;
}
#[cfg(windows)]
struct RuntimeRollouts<'a> {
    processes: &'a mut (f64, HashMap<u32, u32>),
}
#[cfg(windows)]
impl RolloutBackend for RuntimeRollouts<'_> {
    fn clock(&self) -> f64 {
        now()
    }
    fn holders(&mut self, path: &str) -> HashSet<u32> {
        win::holders(path)
    }
    fn processes(&mut self) -> HashMap<u32, u32> {
        cached_process_table(self.processes)
    }
}
pub fn windows_codex_thread_with<B: RolloutBackend>(
    db: &Connection,
    pids: &[u32],
    holder_cache: &mut HashMap<u32, String>,
    scan_cache: &mut HashMap<Vec<u32>, f64>,
    b: &mut B,
) -> Result<Option<String>> {
    for pid in pids {
        if let Some(thread) = holder_cache.get(pid).cloned() {
            let mut stmt = db.prepare("select rollout_path from threads where id = ?")?;
            let rollout = stmt.query_row([&thread], |r| r.get::<_, String>(0)).ok();
            if rollout.is_some_and(|r| b.holders(&r).contains(pid)) {
                return Ok(Some(thread));
            }
            holder_cache.remove(pid);
        }
    }
    if b.clock() - scan_cache.get(pids).copied().unwrap_or(0.) < 30. {
        return Ok(None);
    }
    let alive = b.processes();
    holder_cache.retain(|pid, _| alive.contains_key(pid));
    let mut stmt=db.prepare("select id, rollout_path from threads where archived = 0 and id not in (select child_thread_id from thread_spawn_edges) order by updated_at desc limit 64")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (thread, rollout) = row?;
        let holders = b.holders(&rollout);
        for pid in &holders {
            holder_cache.insert(*pid, thread.clone());
        }
        if pids.iter().any(|p| holders.contains(p)) {
            return Ok(Some(thread));
        }
    }
    scan_cache.insert(pids.to_vec(), b.clock());
    Ok(None)
}
pub trait IdentifyBackend {
    fn facts(&mut self, address: &str) -> Result<Value>;
    fn process_tree(&mut self, pid: u32) -> Vec<u32>;
    fn codex_thread(&mut self, pids: &[u32]) -> Result<Option<String>>;
    fn claude_session(&mut self, pids: &[u32]) -> Option<String>;
    fn bridged_session(&mut self, address: &str, kind: &str) -> Result<Option<String>>;
}
struct RuntimeIdentify<'a>(&'a mut Collector);
impl IdentifyBackend for RuntimeIdentify<'_> {
    fn facts(&mut self, address: &str) -> Result<Value> {
        hc(&["get", address])
    }
    fn process_tree(&mut self, pid: u32) -> Vec<u32> {
        self.0.tree(pid)
    }
    fn codex_thread(&mut self, pids: &[u32]) -> Result<Option<String>> {
        self.0.codex(pids)
    }
    fn claude_session(&mut self, pids: &[u32]) -> Option<String> {
        pids.iter().find_map(|pid| {
            read_json(home().join(format!(".claude/sessions/{pid}.json")))
                .ok()
                .and_then(|v| v["sessionId"].as_str().map(str::to_string))
        })
    }
    fn bridged_session(&mut self, address: &str, kind: &str) -> Result<Option<String>> {
        self.0.bridged(address, kind)
    }
}
pub fn identify_with<B: IdentifyBackend>(terminal: &Value, b: &mut B) -> Result<Value> {
    let address = s(&terminal["address"]);
    let facts = b.facts(address)?;
    let pids = if !address.contains('/') {
        facts["pid"]
            .as_u64()
            .map(|p| b.process_tree(p as u32))
            .unwrap_or_default()
    } else {
        vec![]
    };
    let kind = family(s(&terminal["agent"]));
    let session = if kind == "claude" {
        b.claude_session(&pids)
    } else if kind == "codex" {
        b.codex_thread(&pids)?
    } else {
        None
    };
    let session = match session {
        Some(s) => Some(s),
        None => b.bridged_session(address, kind)?,
    };
    Ok(
        json!({"pid":facts["pid"],"session":session,"parent":facts["parent"],"created":facts["created_ms"]}),
    )
}
impl Collector {
    fn process_table(&mut self) -> HashMap<u32, u32> {
        cached_process_table(&mut self.processes)
    }
    fn tree(&mut self, pid: u32) -> Vec<u32> {
        let p = self.process_table();
        let mut found = vec![];
        let mut queue = std::collections::VecDeque::from([pid]);
        while let Some(current) = queue.pop_front() {
            if found.len() >= 12 {
                break;
            }
            found.push(current);
            for (child, parent) in &p {
                if *parent == current {
                    queue.push_back(*child);
                }
            }
        }
        found
    }
    fn codex(&mut self, pids: &[u32]) -> Result<Option<String>> {
        #[cfg(windows)]
        {
            let db = home().join(".codex/state_5.sqlite");
            if !db.exists() {
                return Ok(None);
            }
            let db = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            db.busy_timeout(Duration::from_secs(1))?;
            windows_codex_thread_with(
                &db,
                pids,
                &mut self.holders,
                &mut self.scanned,
                &mut RuntimeRollouts {
                    processes: &mut self.processes,
                },
            )
        }
        #[cfg(not(windows))]
        {
            let re = regex::Regex::new(r"rollout-[\dT-]+-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl")?;
            for pid in pids {
                let text = output("/usr/sbin/lsof", &strings(&["-p", &pid.to_string()]), 10.)
                    .unwrap_or_default();
                if let Some(m) = re.captures(&text) {
                    return Ok(Some(m[1].into()));
                }
            }
            Ok(None)
        }
    }
    fn bridged(&mut self, address: &str, kind: &str) -> Result<Option<String>> {
        let mapping = read_json(home().join(".local/state/herdr-sixfold/migration-map.local.json"))
            .unwrap_or(Value::Null);
        let Some(pane) = list(&mapping["panes"])
            .iter()
            .find(|p| p["terminal"] == address)
            .map(|p| s(&p["source"]).to_string())
        else {
            return Ok(None);
        };
        let herdr =
            find_executable("herdr").unwrap_or_else(|| PathBuf::from("/opt/homebrew/bin/herdr"));
        let herdr = herdr.to_string_lossy();
        if kind == "claude" {
            // subprocess.run in the original consumes stdout even on a nonzero
            // exit (pane lookup races are common); only transport/JSON fails.
            let (_, text, _) = capture(&herdr, &strings(&["pane", "get", &pane]), 10.)?;
            let result: Value = serde_json::from_str(if text.is_empty() { "{}" } else { &text })?;
            let result = &result["result"];
            let p = result.get("pane").unwrap_or(result);
            return Ok(p["agent_session"]["value"].as_str().map(str::to_string));
        }
        let (_, result, _) = capture(
            &herdr,
            &strings(&["pane", "process-info", "--pane", &pane]),
            10.,
        )?;
        let pids = regex::Regex::new(r#""pid":\s*(\d+)"#)?
            .captures_iter(&result)
            .filter_map(|m| m[1].parse().ok())
            .collect::<Vec<_>>();
        self.codex(&pids)
    }
    fn identify(&mut self, terminal: &Value) -> Result<Value> {
        identify_with(terminal, &mut RuntimeIdentify(self))
    }
    pub fn transcript(
        &mut self,
        path: &Path,
        kind: &str,
        thread: &str,
    ) -> (Option<String>, Option<String>, String) {
        let Ok(meta) = path.metadata() else {
            return (None, None, String::new());
        };
        let time = meta
            .modified()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let key = (path.to_path_buf(), kind.into(), thread.into());
        if let Some((t, n, f)) = self.transcripts.get(&key) {
            if *t == time && *n == meta.len() {
                return f.clone();
            }
        }
        let facts = transcript_facts(
            &std::fs::read_to_string(path).unwrap_or_default(),
            kind,
            thread,
        );
        if self.transcripts.len() >= 256 {
            self.transcripts.clear();
        }
        self.transcripts
            .insert(key, (time, meta.len(), facts.clone()));
        facts
    }
    fn claude_children(&mut self, session: &str, terminal: &str, at: f64) -> Vec<Value> {
        let mut nodes = vec![];
        let projects = home().join(".claude/projects");
        let Ok(dirs) = std::fs::read_dir(projects) else {
            return nodes;
        };
        for project in dirs.flatten() {
            let folder = project.path().join(session).join("subagents");
            let Ok(entries) = std::fs::read_dir(folder) else {
                continue;
            };
            for entry in entries.flatten() {
                let meta = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".meta.json") {
                    continue;
                }
                let Ok(data) = read_json(&meta) else {
                    continue;
                };
                let log = meta.with_file_name(name.replace(".meta.json", ".jsonl"));
                let active = modified(if log.exists() { &log } else { &meta });
                let (observed, source, task) = self.transcript(&log, "claude", "");
                let (status, source) = if data["finished"].as_bool().unwrap_or(false)
                    || observed.as_deref() == Some("finished")
                {
                    if at - active > 21600. {
                        continue;
                    }
                    (
                        "finished",
                        if data["finished"] == true {
                            Some("meta.finished".into())
                        } else {
                            source
                        },
                    )
                } else {
                    (
                        if at - active < 30. { "recent" } else { "quiet" },
                        Some("recent-activity-estimate".into()),
                    )
                };
                let stem = log.file_stem().unwrap_or_default().to_string_lossy();
                let label = data["description"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or(data["agentType"].as_str().filter(|s| !s.is_empty()))
                    .unwrap_or(&stem);
                let born = meta
                    .metadata()
                    .and_then(|m| m.created().or_else(|_| m.modified()))
                    .unwrap_or(UNIX_EPOCH)
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                nodes.push(json!({"id":format!("sub:{terminal}:{stem}"),"parent":terminal,"terminal":terminal,"label":label,"task":data["description"].as_str().filter(|s|!s.is_empty()).unwrap_or(&task),"agentType":data["agentType"].as_str().unwrap_or(""),"status":status,"statusSource":source,"at":born}));
            }
        }
        nodes
    }
    pub fn codex_children(
        &mut self,
        db: &Connection,
        thread: &str,
        parent: &str,
        terminal: &str,
        at: f64,
        visited: &mut HashSet<String>,
    ) -> Result<Vec<Value>> {
        if !visited.insert(thread.into()) {
            return Err("cycle in Codex spawn edges".into());
        }
        let mut stmt=db.prepare("select e.child_thread_id, e.status, t.agent_nickname, t.agent_role, t.title, t.updated_at_ms, t.created_at_ms, t.rollout_path, t.first_user_message from thread_spawn_edges e left join threads t on t.id = e.child_thread_id where e.parent_thread_id = ?")?;
        let rows = stmt
            .query_map([thread], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut nodes = vec![];
        for (child, edge, nickname, role, title, updated, created, rollout, first) in rows {
            let (observed, source, task) = rollout
                .map(|p| self.transcript(Path::new(&p), "codex", &child))
                .unwrap_or((None, None, String::new()));
            let status = if edge != "open" {
                "closed".into()
            } else {
                observed.unwrap_or("open".into())
            };
            let child_id = format!("sub:{terminal}:{child}");
            let descendants = self.codex_children(db, &child, &child_id, terminal, at, visited)?;
            if ["closed", "finished", "interrupted"].contains(&status.as_str())
                && at - updated.unwrap_or(0) as f64 / 1000. > 21600.
                && descendants.is_empty()
            {
                continue;
            }
            let label = nickname
                .filter(|s| !s.is_empty())
                .or(role.filter(|s| !s.is_empty()))
                .unwrap_or_else(|| {
                    title
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&child)
                        .chars()
                        .take(60)
                        .collect()
                });
            let task = if !task.is_empty() {
                task
            } else {
                first
                    .filter(|s| !s.is_empty())
                    .or(title)
                    .unwrap_or_default()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(160)
                    .collect()
            };
            nodes.push(json!({"id":child_id,"parent":parent,"terminal":terminal,"label":label,"task":task,"status":status,"statusSource":if edge=="open"&&source.is_some(){source.unwrap()}else{"spawn-edge".into()},"at":created.unwrap_or(0)}));
            nodes.extend(descendants);
        }
        visited.remove(thread);
        Ok(nodes)
    }
    fn collect(&mut self) -> Result<Vec<Value>> {
        let at = now();
        let listing = hc(&["ls"])?;
        let listing = list(&listing["terminals"])
            .iter()
            .filter(|t| t["state"] == "live")
            .cloned()
            .collect::<Vec<_>>();
        let live: HashSet<_> = listing
            .iter()
            .map(|t| s(&t["address"]).to_string())
            .collect();
        let dbpath = home().join(".codex/state_5.sqlite");
        let db = if dbpath.exists() {
            let c = Connection::open_with_flags(dbpath, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            c.busy_timeout(Duration::from_secs(1))?;
            Some(c)
        } else {
            None
        };
        let mut nodes = vec![];
        for terminal in listing {
            let address = s(&terminal["address"]);
            let facts = self.identify(&terminal)?;
            if live.contains(s(&facts["parent"])) {
                let owner = s(&facts["parent"]);
                nodes.push(json!({"id":format!("sub:{owner}:{address}"),"parent":owner,"terminal":owner,"label":terminal["agent"].as_str().filter(|s|!s.is_empty()).unwrap_or(address),"status":terminal["status"],"statusSource":"hc","at":facts["created"].as_i64().unwrap_or(0)}));
            }
            let kind = family(s(&terminal["agent"]));
            if let Some(session) = facts["session"].as_str() {
                if kind == "claude" {
                    nodes.extend(self.claude_children(session, address, at));
                } else if kind == "codex" {
                    if let Some(db) = &db {
                        nodes.extend(self.codex_children(
                            db,
                            session,
                            address,
                            address,
                            at,
                            &mut HashSet::new(),
                        )?);
                    }
                }
            }
        }
        nodes.sort_by(|a, b| {
            (s(&a["terminal"]), a["at"].as_i64().unwrap_or(0))
                .cmp(&(s(&b["terminal"]), b["at"].as_i64().unwrap_or(0)))
        });
        Ok(nodes)
    }
}
fn hc(args: &[&str]) -> Result<Value> {
    hc_with(args, |command| capture_cmd(command, 10.))
}
pub fn hc_with<F>(args: &[&str], run: F) -> Result<Value>
where
    F: FnOnce(std::process::Command) -> Result<(i32, String, String)>,
{
    let program = hc_program();
    let mut process = command(&program.to_string_lossy());
    process.args(args);
    let (code, out, _) = run(process)?;
    let _ = code;
    Ok(serde_json::from_str(if out.is_empty() {
        "{}"
    } else {
        &out
    })?)
}
pub fn hc_program() -> PathBuf {
    find_executable("hc").unwrap_or_else(|| home().join(".local/share/herdr-sixfold/bin/hc"))
}
fn modified(path: &Path) -> f64 {
    path.metadata()
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn transcript_facts(
    text: &str,
    kind: &str,
    thread: &str,
) -> (Option<String>, Option<String>, String) {
    let (mut status, mut source, mut task) = (None, None, String::new());
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let p = &row["payload"];
        if kind == "codex" {
            if row["type"] == "event_msg" {
                let event = s(&p["type"]);
                if event == "thread_settings_applied" && p["thread_id"] == thread {
                    status = None;
                    source = None;
                    task.clear();
                }
                let state = match event {
                    "task_started" => Some("working"),
                    "task_complete" => Some("finished"),
                    "turn_aborted" => Some("interrupted"),
                    _ => None,
                };
                if let Some(state) = state {
                    status = Some(state.into());
                    source = Some(format!("codex.{event}"));
                }
                if event == "user_message" && !s(&p["message"]).is_empty() {
                    task = s(&p["message"]).into();
                }
            }
            if row["type"] == "response_item" && p["role"] == "user" {
                let text = list(&p["content"])
                    .iter()
                    .filter(|c| c.is_object())
                    .map(|c| s(&c["text"]))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty()
                    && !text.starts_with("# AGENTS.md")
                    && !text.starts_with("<environment_context>")
                {
                    task = text;
                }
            }
        } else {
            if row["type"] == "user" && task.is_empty() {
                if let Some(text) = row["message"]["content"].as_str() {
                    task = text.into();
                }
            }
            if row["type"] == "assistant" {
                if row["message"]["stop_reason"] == "end_turn" {
                    status = Some("finished".into());
                    source = Some("claude.end_turn".into());
                } else if row["message"]["stop_reason"] == "tool_use" {
                    status = None;
                    source = None;
                }
            }
            if row["attachment"]["hookEvent"] == "SubagentStop" {
                status = Some("finished".into());
                source = Some("claude.SubagentStop".into());
            }
        }
    }
    let task = task
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .chars()
        .take(160)
        .collect();
    (status, source, task)
}
pub fn events_for(nodes: &[Value], seen: &mut Option<HashSet<String>>, events: &mut Vec<Value>) {
    let current: HashSet<_> = nodes.iter().map(|n| s(&n["id"]).to_string()).collect();
    let previous = seen.get_or_insert_with(|| current.clone());
    for id in current.difference(previous) {
        let node = nodes.iter().find(|n| n["id"] == *id).unwrap();
        events.push(json!({"id":uuid::Uuid::new_v4().simple().to_string(),"source":node["parent"],"target":id,"at":(now()*1000.)as i64,"kind":"delegate"}));
    }
    previous.extend(current);
    if events.len() > 32 {
        events.drain(..events.len() - 32);
    }
}
pub fn lock_once(file: &std::fs::File) -> bool {
    file.try_lock_exclusive().is_ok()
}
pub fn run(args: &[String]) -> Result<()> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home)
            .join("HerdrSixfold")
    } else {
        expand(s(&site()["state_dir"]))
    };
    std::fs::create_dir_all(&base)?;
    std::fs::create_dir_all(data())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(base.join("workflow.lock"))?;
    if !lock_once(&lock) {
        return Ok(());
    }
    let (mut collector, mut seen, mut events) = (Collector::default(), None, vec![]);
    loop {
        let result = (|| {
            let nodes = collector.collect()?;
            events_for(&nodes, &mut seen, &mut events);
            let text = serde_json::to_string(&json!({"nodes":nodes,"events":events}))?;
            let path = data().join("workflow.json");
            if std::fs::read_to_string(&path).unwrap_or_default() != text {
                let tmp = path.with_file_name(".workflow.json.tmp");
                std::fs::write(&tmp, text)?;
                private(&tmp)?;
                std::fs::rename(tmp, path)?;
            }
            Ok::<(), Box<dyn std::error::Error>>(())
        })();
        if let Err(e) = result {
            eprintln!("workflow: {e}");
        }
        if flag(args, "--once") {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_fork_history_resets() {
        let input=[json!({"type":"event_msg","payload":{"type":"task_complete"}}),json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"child"}}),json!({"type":"event_msg","payload":{"type":"task_started"}}),json!({"type":"event_msg","payload":{"type":"user_message","message":"검수해줘 — ✓\nDetails"}})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(
            transcript_facts(&input, "codex", "child"),
            (
                Some("working".into()),
                Some("codex.task_started".into()),
                "검수해줘 — ✓".into()
            )
        );
    }
    #[test]
    fn baseline_and_seen_never_replay() {
        let old = json!({"id":"old","parent":"t"});
        let new = json!({"id":"new","parent":"old"});
        let (mut seen, mut events) = (None, vec![]);
        events_for(&[old.clone()], &mut seen, &mut events);
        assert!(events.is_empty());
        events_for(&[old.clone(), new.clone()], &mut seen, &mut events);
        assert_eq!(events.len(), 1);
        events_for(&[], &mut seen, &mut events);
        events_for(&[old, new], &mut seen, &mut events);
        assert_eq!(events.len(), 1);
    }
}
