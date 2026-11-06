//! Session identity uses process metadata and file ownership; never transcript text guesses.
use crate::documents::common::*;
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
pub fn family(agent: &str) -> &str {
    if agent == "claude" || agent == "claude-code" {
        "claude"
    } else {
        agent
    }
}
pub fn valid_pid(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n > 0)
}
pub fn foreground_kind(f: &Value) -> Option<String> {
    let program = if f["argv"].is_array() {
        f["argv"][0].as_str()
    } else {
        f["name"].as_str()
    }?;
    let name = filename(program);
    ["claude", "codex"].contains(&name.as_str()).then_some(name)
}
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    let paths = std::env::split_paths(&path_env);
    for folder in paths {
        for suffix in if cfg!(windows) {
            vec![".exe", ".cmd", ".bat", ""]
        } else {
            vec![""]
        } {
            let path = folder.join(format!("{name}{suffix}"));
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}
fn run_json(program: &str, args: &[&str]) -> Result<Value> {
    let output =
        timeout_output(command(program).args(args), 10).map_err(|_| "discovery_unavailable")?;
    if !output.status.success() {
        return Err("discovery_unavailable".into());
    }
    let data: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "discovery_unavailable")?;
    if !data.is_object() {
        return Err("discovery_unavailable".into());
    }
    Ok(data)
}
fn session_regex() -> Regex {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
}
fn rollout_regex() -> Regex {
    Regex::new(r"(?i)rollout-[\dT-]+-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl").unwrap()
}
pub struct Resolver {
    pub hc: String,
    pub herdr: String,
    pub home: PathBuf,
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub bridges: PathBuf,
    holders: HashMap<PathBuf, Option<Vec<u32>>>,
    parents: Option<HashMap<u32, u32>>,
}
impl Resolver {
    pub fn new(hc: Option<&str>) -> Self {
        let home = user_home();
        Self {
            hc: hc
                .map(str::to_owned)
                .or_else(|| {
                    find_executable("herdr-core")
                        .or_else(|| find_executable("hc"))
                        .map(|p| p.to_string_lossy().into_owned())
                })
                .unwrap_or_else(|| "hc".into()),
            herdr: find_executable("herdr")
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "herdr".into()),
            claude: std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude")),
            codex: std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex")),
            bridges: home.join(".local/state/herdr-sixfold/migration-map.local.json"),
            home,
            holders: HashMap::new(),
            parents: None,
        }
    }
    pub fn live_agents(&mut self) -> Result<Vec<Value>> {
        self.holders.clear();
        self.parents = None;
        let data = run_json(&self.hc, &["ls", "--json"])?;
        let terminals = data["terminals"]
            .as_array()
            .ok_or("discovery_unavailable")?;
        let mut found = vec![];
        for item in terminals {
            if item["state"] != "live" || !item["address"].is_string() {
                continue;
            }
            if ["claude", "codex"].contains(&family(s(&item["agent"]))) {
                found.push(item.clone())
            } else if let Some(hidden) = self.hidden_agent(item) {
                found.push(hidden)
            }
        }
        Ok(found)
    }
    fn hidden_agent(&self, item: &Value) -> Option<Value> {
        let address = s(&item["address"]);
        if address.contains('/') {
            return None;
        }
        let facts = run_json(&self.hc, &["get", address, "--json"]).ok()?;
        let foreground = &facts["foreground"];
        let parked = facts["labels"]["sixfold.sleep"].as_str();
        let argv = arr(&foreground["argv"]);
        if let Some(parked) = parked {
            if argv.iter().any(|arg| {
                s(arg).ends_with("session_sleep_stub.py")
                    || ["session_sleep_stub", "session-sleep-stub"].contains(&s(arg))
            }) {
                let (kind, session) = parked.split_once(':')?;
                let kind = family(kind);
                let session = session.to_lowercase();
                if ["claude", "codex"].contains(&kind) && session_regex().is_match(&session) {
                    return Some(json!({"address":address,"agent":kind,"sleepSession":session}));
                }
                return None;
            }
        }
        foreground_kind(foreground).map(|kind| json!({"address":address,"agent":kind}))
    }
    fn children(&self, pid: u32) -> Result<Vec<u32>> {
        #[cfg(windows)]
        {
            Ok(windows_parents()?
                .into_iter()
                .filter_map(|(child, parent)| {
                    (parent == pid && child != 0 && child != pid).then_some(child)
                })
                .collect())
        }
        #[cfg(not(windows))]
        {
            let output =
                timeout_output(command("/usr/bin/pgrep").args(["-P", &pid.to_string()]), 10)
                    .map_err(|_| "discovery_unavailable")?;
            if !output.status.success() && output.status.code() != Some(1) {
                return Err("discovery_unavailable".into());
            }
            Ok(String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .filter_map(|p| p.parse().ok())
                .collect())
        }
    }
    pub fn process_tree(&self, pid: u32) -> Result<Vec<u32>> {
        if pid == 0 {
            return Ok(vec![]);
        }
        let mut found = vec![];
        let mut pending = VecDeque::from([pid]);
        while let Some(current) = pending.pop_front() {
            if found.contains(&current) {
                continue;
            }
            if found.len() >= 12 {
                return Err("process_tree_limit".into());
            }
            found.push(current);
            pending.extend(self.children(current)?)
        }
        Ok(found)
    }
    pub fn sessions_for(&self, kind: &str, pids: &[u32]) -> Result<Option<String>> {
        let mut sessions = HashSet::new();
        for pid in pids {
            if kind == "claude" {
                let path = self.claude.join("sessions").join(format!("{pid}.json"));
                let value = match read_json(&path) {
                    Ok(v) => v,
                    Err(_) if !path.exists() => continue,
                    Err(_) => return Err("session_metadata_unavailable".into()),
                };
                if let Some(id) = value["sessionId"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.chars().count() <= 128)
                {
                    sessions.insert(id.to_owned());
                }
            } else if !cfg!(windows) {
                let output = timeout_output(
                    command("/usr/sbin/lsof").args(["-Fn", "-p", &pid.to_string()]),
                    10,
                )
                .map_err(|_| "discovery_unavailable")?;
                if !output.status.success() && output.status.code() != Some(1) {
                    return Err("discovery_unavailable".into());
                }
                for cap in rollout_regex().captures_iter(&String::from_utf8_lossy(&output.stdout)) {
                    sessions.insert(cap[1].to_lowercase());
                }
            }
        }
        if sessions.len() > 1 && kind == "codex" {
            sessions = self.codex_roots(&sessions)
        }
        if sessions.len() > 1 {
            return Err("ambiguous_session".into());
        }
        Ok(sessions.into_iter().next())
    }
    pub fn codex_roots(&self, sessions: &HashSet<String>) -> HashSet<String> {
        let result = (|| -> Result<HashSet<String>> {
            let db = Connection::open_with_flags(
                self.codex.join("state_5.sqlite"),
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            db.busy_timeout(Duration::from_secs(1))?;
            let mut statement =
                db.prepare("SELECT child_thread_id, parent_thread_id FROM thread_spawn_edges")?;
            let edges = statement
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<HashMap<_, _>, _>>()?;
            let mut roots = sessions.clone();
            for session in sessions {
                let mut seen = HashSet::new();
                let mut ancestor = session.as_str();
                while let Some(parent) = edges.get(ancestor) {
                    if !seen.insert(ancestor) {
                        break;
                    }
                    ancestor = parent;
                    if sessions.contains(ancestor) {
                        roots.remove(session);
                        break;
                    }
                }
            }
            Ok(if roots.is_empty() {
                sessions.clone()
            } else {
                roots
            })
        })();
        result.unwrap_or_else(|_| sessions.clone())
    }
    pub fn codex_named_session(&self, facts: &Value) -> Option<String> {
        let (mut title, cwd) = (facts["title"].as_str()?, facts["cwd"].as_str()?);
        if cwd.is_empty() {
            return None;
        }
        if let Some(t) = title.strip_prefix("● ") {
            title = t
        }
        let mut chars = title.chars();
        if chars.next().is_some_and(|c| "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".contains(c)) && chars.next() == Some(' ')
        {
            title = chars.as_str()
        }
        let (name, project) = title.rsplit_once(" | ")?;
        if project != filename(cwd)
            || name.is_empty()
            || name.chars().count() >= 48
            || name.ends_with('…')
            || name.ends_with("...")
        {
            return None;
        }
        let by_id = session_regex().is_match(name);
        let db = Connection::open_with_flags(
            self.codex.join("state_5.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .ok()?;
        db.busy_timeout(Duration::from_secs(1)).ok()?;
        let mut statement = db
            .prepare(&format!(
                "SELECT id, cwd, archived FROM threads WHERE {} = ?",
                if by_id { "id" } else { "name" }
            ))
            .ok()?;
        let rows = statement
            .query_map([name], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .ok()?
            .collect::<std::result::Result<Vec<_>, _>>()
            .ok()?;
        if rows.len() != 1 {
            return None;
        }
        let (session, recorded, archived) = &rows[0];
        if *archived != 0
            || normcase(recorded) != normcase(cwd)
            || !Regex::new(r"^[0-9a-f]{8}-[0-9a-f-]{27}$")
                .unwrap()
                .is_match(session)
        {
            return None;
        }
        Some(session.clone())
    }
    pub fn codex_rollouts(
        &self,
        cwd: Option<&str>,
        days: f64,
        limit: usize,
    ) -> Vec<(PathBuf, String)> {
        let cutoff = now() - days * 86400.;
        let root = self.codex.join("sessions");
        let mut paths = walkdir::WalkDir::new(root)
            .min_depth(4)
            .max_depth(4)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && filename(e.path()).starts_with("rollout-")
                    && suffix(e.path()) == ".jsonl"
                    && mtime(e.path()) as f64 / 1000. > cutoff
            })
            .map(|e| e.path().to_owned())
            .collect::<Vec<_>>();
        paths.sort_by_key(|p| std::cmp::Reverse(mtime(p)));
        let mut same = vec![];
        let mut other = vec![];
        for path in paths {
            let Some(id) = rollout_regex()
                .captures(&filename(&path))
                .map(|c| c[1].to_lowercase())
            else {
                continue;
            };
            use std::io::BufRead;
            let first = fs::File::open(&path)
                .ok()
                .and_then(|f| std::io::BufReader::new(f).lines().next())
                .and_then(|l| l.ok())
                .and_then(|l| serde_json::from_str::<Value>(&l).ok());
            let started = first.as_ref().and_then(|r| r["payload"]["cwd"].as_str());
            if cwd
                .filter(|c| !c.is_empty())
                .zip(started)
                .is_some_and(|(a, b)| normcase(a) == normcase(b))
            {
                same.push((path, id))
            } else {
                other.push((path, id))
            }
        }
        same.extend(other);
        same.truncate(limit);
        same
    }
    #[cfg(windows)]
    pub fn windows_codex_session(
        &mut self,
        root: u32,
        cwd: Option<&str>,
    ) -> Result<Option<String>> {
        if root == 0 {
            return Ok(None);
        }
        if self.parents.is_none() {
            self.parents = Some(windows_parents()?)
        }
        let parents = self.parents.as_ref().unwrap();
        let under = |mut pid: u32| {
            for _ in 0..32 {
                if pid == root {
                    return true;
                }
                let Some(parent) = parents.get(&pid) else {
                    return false;
                };
                pid = *parent;
                if pid == 0 {
                    return false;
                }
            }
            false
        };
        for (path, session) in self.codex_rollouts(cwd, 45., 40) {
            let holders = self
                .holders
                .entry(path.clone())
                .or_insert_with(|| windows_file_holders(&path));
            if holders
                .as_ref()
                .is_some_and(|holders| holders.iter().any(|p| under(*p)))
            {
                return Ok(Some(session));
            }
        }
        Ok(None)
    }
    fn bridge_pane(&self, address: &str, strict: bool) -> Result<Option<String>> {
        let mapping = match read_json(&self.bridges) {
            Ok(value) => value,
            Err(_) if !self.bridges.exists() => return Ok(None),
            Err(_) if !strict => return Ok(None),
            Err(_) => return Err("bridge_metadata_unavailable".into()),
        };
        let matches = arr(&mapping["panes"])
            .into_iter()
            .filter(|i| i["terminal"] == address)
            .map(|i| i["source"].clone())
            .collect::<Vec<_>>();
        if matches.is_empty() {
            return Ok(None);
        }
        if matches.len() != 1 || !matches[0].is_string() {
            if strict {
                return Err("ambiguous_session".into());
            }
            return Ok(None);
        }
        Ok(Some(s(&matches[0]).to_owned()))
    }
    pub fn bridge_session(&self, address: &str, kind: &str) -> Result<Option<String>> {
        let Some(pane) = self.bridge_pane(address, true)? else {
            return Ok(None);
        };
        let result = run_json(&self.herdr, &["pane", "process-info", "--pane", &pane])?;
        fn visit(value: &Value, pids: &mut HashSet<u32>) {
            if valid_pid(&value["pid"]) {
                pids.insert(value["pid"].as_u64().unwrap() as u32);
            }
            if let Some(map) = value.as_object() {
                for child in map.values() {
                    visit(child, pids)
                }
            } else if let Some(list) = value.as_array() {
                for child in list {
                    visit(child, pids)
                }
            }
        }
        let mut pids = HashSet::new();
        visit(&result, &mut pids);
        let mut pids = pids.into_iter().collect::<Vec<_>>();
        pids.sort();
        let session = self.sessions_for(kind, &pids)?;
        if session.is_some() || kind != "claude" {
            return Ok(session);
        }
        let result = run_json(&self.herdr, &["pane", "get", &pane])?;
        let result = &result["result"];
        let pane = result
            .get("pane")
            .filter(|p| !p.is_null())
            .unwrap_or(result);
        Ok(pane["agent_session"]["value"]
            .as_str()
            .filter(|v| !v.is_empty() && v.chars().count() <= 128)
            .map(str::to_owned))
    }
    pub fn bridge_source(&self, address: &str) -> Option<Value> {
        let pane = self.bridge_pane(address, false).ok()??;
        let result = run_json(&self.herdr, &["pane", "get", &pane]).ok()?;
        let result = &result["result"];
        let pane = result
            .get("pane")
            .filter(|p| !p.is_null())
            .unwrap_or(result);
        let title = pane["terminal_title_stripped"]
            .as_str()
            .filter(|t| !t.is_empty())
            .or_else(|| pane["terminal_title"].as_str())?;
        let cwd = pane["foreground_cwd"]
            .as_str()
            .filter(|c| !c.is_empty())
            .or_else(|| pane["cwd"].as_str())?;
        Some(json!({"title":title,"cwd":cwd}))
    }
    fn named_facts(&self, address: &str, facts: &Value) -> Value {
        let mut facts = facts.clone();
        if let Some(source) = self.bridge_source(address) {
            facts["title"] = source["title"].clone();
            facts["cwd"] = source["cwd"].clone()
        }
        facts
    }
    fn current_kind(facts: &Value) -> String {
        family(
            facts["agent"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| facts["status"]["app"].as_str().filter(|s| !s.is_empty()))
                .map(str::to_owned)
                .or_else(|| foreground_kind(&facts["foreground"]))
                .as_deref()
                .unwrap_or(""),
        )
        .to_owned()
    }
    pub fn identify(&mut self, terminal: &Value) -> Result<Option<String>> {
        if let Some(session) = terminal["sleepSession"].as_str().filter(|s| !s.is_empty()) {
            return Ok(Some(session.into()));
        }
        let address = s(&terminal["address"]);
        let kind = family(s(&terminal["agent"]));
        if address.contains('/') {
            return Err("remote_session_unsupported".into());
        }
        let facts = run_json(&self.hc, &["get", address, "--json"])?;
        if facts["state"] != "live" {
            return Err("not_live".into());
        }
        if Self::current_kind(&facts) != kind {
            return Err("agent_changed".into());
        }
        if !facts["foreground"].is_null() && !facts["foreground"].is_object() {
            return Err("discovery_unavailable".into());
        }
        let pid = if valid_pid(&facts["foreground"]["pid"]) {
            facts["foreground"]["pid"].as_u64()
        } else {
            facts["pid"].as_u64()
        }
        .unwrap_or(0) as u32;
        #[cfg(windows)]
        if kind == "codex" {
            return self.windows_codex_session(pid, facts["cwd"].as_str());
        }
        let session = if pid > 0 {
            self.sessions_for(kind, &[pid])?
        } else {
            None
        };
        if session.is_some() {
            return Ok(session);
        }
        let mut session = self.sessions_for(kind, &self.process_tree(pid)?)?;
        if session.is_none() {
            session = self.bridge_session(address, kind)?;
        }
        if session.is_some() || kind != "codex" {
            return Ok(session);
        }
        let session = self.codex_named_session(&self.named_facts(address, &facts));
        if let Some(session) = &session {
            let current = run_json(&self.hc, &["get", address, "--json"])?;
            if ["state", "pid", "cwd", "foreground"]
                .iter()
                .any(|k| current[*k] != facts[*k])
                || Self::current_kind(&current) != kind
                || self
                    .codex_named_session(&self.named_facts(address, &current))
                    .as_ref()
                    != Some(session)
            {
                return Ok(None);
            }
        }
        Ok(session)
    }
}
fn normcase(s: &str) -> String {
    let normalized = Path::new(s)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned();
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}
#[cfg(windows)]
fn windows_parents() -> Result<HashMap<u32, u32>> {
    use windows_sys::Win32::{Foundation::*, System::Diagnostics::ToolHelp::*};
    let mut result = HashMap::new();
    unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if handle == INVALID_HANDLE_VALUE {
            return Err("discovery_unavailable".into());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(handle, &mut entry);
        while more != 0 {
            result.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            more = Process32NextW(handle, &mut entry)
        }
        CloseHandle(handle);
    }
    Ok(result)
}
#[cfg(windows)]
fn windows_file_holders(path: &Path) -> Option<Vec<u32>> {
    use windows_sys::Win32::System::RestartManager::*;
    unsafe {
        let mut session = 0;
        let mut key = [0u16; 33];
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
            return None;
        }
        let result = (|| {
            let path = path
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let name = path.as_ptr();
            if RmRegisterResources(session, 1, &name, 0, std::ptr::null(), 0, std::ptr::null()) != 0
            {
                return None;
            }
            let mut needed = 0;
            let mut count = 0;
            let mut reasons = 0;
            RmGetList(
                session,
                &mut needed,
                &mut count,
                std::ptr::null_mut(),
                &mut reasons,
            );
            if needed == 0 {
                return Some(vec![]);
            }
            let mut info = Vec::<RM_PROCESS_INFO>::with_capacity(needed as usize);
            info.resize_with(needed as usize, || std::mem::zeroed());
            count = needed;
            if RmGetList(
                session,
                &mut needed,
                &mut count,
                info.as_mut_ptr(),
                &mut reasons,
            ) != 0
            {
                return None;
            }
            Some(
                info.iter()
                    .take(count as usize)
                    .map(|i| i.Process.dwProcessId)
                    .collect(),
            )
        })();
        RmEndSession(session);
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_kind_never_guesses_from_parameters() {
        assert_eq!(
            foreground_kind(&json!({"argv":["/bin/claude","codex"]})),
            Some("claude".into())
        );
        assert_eq!(foreground_kind(&json!({"argv":["env","claude"]})), None);
    }
    #[test]
    fn ancestry_keeps_root_sessions_only() {
        let t = tempfile::tempdir().unwrap();
        let db = Connection::open(t.path().join("state_5.sqlite")).unwrap();
        db.execute(
            "create table thread_spawn_edges(child_thread_id text,parent_thread_id text)",
            [],
        )
        .unwrap();
        db.execute(
            "insert into thread_spawn_edges values('child','parent')",
            [],
        )
        .unwrap();
        let mut resolver = Resolver::new(None);
        resolver.codex = t.path().to_owned();
        assert_eq!(
            resolver.codex_roots(&HashSet::from(["parent".into(), "child".into()])),
            HashSet::from(["parent".into()])
        );
    }
}
