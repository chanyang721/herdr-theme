//! Existing tests/test_workflow_collector.py assertions through production seams.
use herdr_theme::{
    automation::workflow::{self, Collector},
    common::Result,
};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::Path,
};
// The original creationflags assertion also maps to the existing real Windows
// process_contracts::workflow_gui_collector_hides_its_actual_hc_child test.
#[test]
fn test_background_core_queries_suppress_windows_console_windows() {
    let value = workflow::hc_with(&["ls", "--json"], |command| {
        assert_eq!(command.get_program(), workflow::hc_program().as_os_str());
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["ls", "--json"]
        );
        Ok((0, "{}".into(), String::new()))
    })
    .unwrap();
    assert_eq!(value, json!({}));
}
struct Identify {
    codex: VecDeque<Option<String>>,
    bridges: VecDeque<Option<String>>,
    tree_calls: usize,
    tree: Vec<u32>,
}
impl workflow::IdentifyBackend for Identify {
    fn facts(&mut self, _: &str) -> Result<Value> {
        Ok(json!({"pid":10}))
    }
    fn process_tree(&mut self, _: u32) -> Vec<u32> {
        self.tree_calls += 1;
        self.tree.clone()
    }
    fn codex_thread(&mut self, _: &[u32]) -> Result<Option<String>> {
        Ok(self.codex.pop_front().unwrap_or(None))
    }
    fn claude_session(&mut self, _: &[u32]) -> Option<String> {
        None
    }
    fn bridged_session(&mut self, _: &str, _: &str) -> Result<Option<String>> {
        Ok(self.bridges.pop_front().unwrap_or(None))
    }
}
#[test]
fn test_same_pty_and_agent_pid_can_switch_session() {
    let mut b = Identify {
        codex: [Some("old".into()), Some("new".into()), None].into(),
        bridges: VecDeque::new(),
        tree_calls: 0,
        tree: vec![10, 99],
    };
    let terminal = json!({"address":"t4","agent":"codex"});
    assert_eq!(
        workflow::identify_with(&terminal, &mut b).unwrap()["session"],
        "old"
    );
    assert_eq!(
        workflow::identify_with(&terminal, &mut b).unwrap()["session"],
        "new"
    );
    assert!(workflow::identify_with(&terminal, &mut b).unwrap()["session"].is_null());
}
#[test]
fn test_bridged_claude_session_is_rechecked_without_pid_change() {
    let mut b = Identify {
        codex: VecDeque::new(),
        bridges: [Some("before-clear".into()), Some("after-clear".into())].into(),
        tree_calls: 0,
        tree: vec![10],
    };
    let terminal = json!({"address":"t2","agent":"claude-code"});
    assert_eq!(
        workflow::identify_with(&terminal, &mut b).unwrap()["session"],
        "before-clear"
    );
    assert_eq!(
        workflow::identify_with(&terminal, &mut b).unwrap()["session"],
        "after-clear"
    );
}
#[test]
fn test_remote_terminal_pid_is_not_looked_up_here() {
    let mut b = Identify {
        codex: VecDeque::new(),
        bridges: VecDeque::new(),
        tree_calls: 0,
        tree: vec![],
    };
    workflow::identify_with(&json!({"address":"sub1/t7","agent":"codex"}), &mut b).unwrap();
    assert_eq!(b.tree_calls, 0);
}
#[test]
fn test_history_is_baseline_and_only_a_new_child_generates_a_delegation() {
    let old = json!({"id":"old","parent":"t5","terminal":"t5","status":"finished"});
    let mut new = json!({"id":"new","parent":"old","terminal":"t5","status":"recent"});
    let (mut seen, mut events) = (None, vec![]);
    workflow::events_for(&[old.clone()], &mut seen, &mut events);
    assert!(events.is_empty());
    workflow::events_for(&[old.clone(), new.clone()], &mut seen, &mut events);
    assert_eq!(
        events
            .iter()
            .map(|e| (&e["source"], &e["target"], &e["kind"]))
            .collect::<Vec<_>>(),
        vec![(&json!("old"), &json!("new"), &json!("delegate"))]
    );
    new["status"] = json!("finished");
    workflow::events_for(&[old.clone(), new.clone()], &mut seen, &mut events);
    assert_eq!(
        events.len(),
        1,
        "status changes must not invent return messages"
    );
    workflow::events_for(&[old, new], &mut None, &mut vec![]);
}
fn transcript(path: &Path, events: &[Value]) {
    let text = events
        .iter()
        .map(|event| json!({"type":"event_msg","payload":event}).to_string() + "\n")
        .collect::<String>();
    fs::write(path, text).unwrap();
}
#[test]
fn test_fork_history_is_reset_and_completion_does_not_close_link() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("child.jsonl");
    let mut events = vec![
        json!({"type":"task_complete"}),
        json!({"type":"thread_settings_applied","thread_id":"child"}),
        json!({"type":"task_started"}),
        json!({"type":"user_message","message":"Inspect DB calls\nDetails"}),
    ];
    let mut collector = Collector::default();
    transcript(&path, &events);
    assert_eq!(
        collector.transcript(&path, "codex", "child"),
        (
            Some("working".into()),
            Some("codex.task_started".into()),
            "Inspect DB calls".into()
        )
    );
    events.push(json!({"type":"task_complete"}));
    transcript(&path, &events);
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("create table thread_spawn_edges(parent_thread_id,child_thread_id,status);create table threads(id,agent_nickname,agent_role,title,updated_at_ms,created_at_ms,rollout_path,first_user_message);insert into thread_spawn_edges values('root','child','open');").unwrap();
    db.execute(
        "insert into threads values(?,?,?,?,?,?,?,?)",
        params![
            "child",
            "Nash",
            Option::<String>::None,
            "",
            1_000_000i64,
            1i64,
            path.to_str().unwrap(),
            ""
        ],
    )
    .unwrap();
    let row = collector
        .codex_children(&db, "root", "t1", "t1", 1000., &mut HashSet::new())
        .unwrap()
        .remove(0);
    assert_eq!(
        (
            row["status"].as_str(),
            row["label"].as_str(),
            row["task"].as_str()
        ),
        (Some("finished"), Some("Nash"), Some("Inspect DB calls"))
    );
    events.push(json!({"type":"task_started"}));
    transcript(&path, &events);
    assert_eq!(
        collector.transcript(&path, "codex", "child").0,
        Some("working".into())
    );
    events.push(json!({"type":"turn_aborted"}));
    transcript(&path, &events);
    assert_eq!(
        collector.transcript(&path, "codex", "child").0,
        Some("interrupted".into())
    );
}
#[test]
fn test_claude_stop_hook_is_completion_without_finished_metadata() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("agent.jsonl");
    let mut collector = Collector::default();
    fs::write(
        &path,
        json!({"type":"attachment","attachment":{"hookEvent":"SubagentStop"}}).to_string() + "\n",
    )
    .unwrap();
    let (state, source, _) = collector.transcript(&path, "claude", "");
    assert_eq!(
        (state, source),
        (Some("finished".into()), Some("claude.SubagentStop".into()))
    );
    fs::write(
        &path,
        json!({"type":"assistant","message":{"stop_reason":"tool_use"}}).to_string() + "\n",
    )
    .unwrap();
    assert_eq!(collector.transcript(&path, "claude", "").0, None);
}
#[test]
fn test_utf8_transcript_reads_on_any_locale() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("child.jsonl");
    transcript(
        &path,
        &[json!({"type":"user_message","message":"검수해줘 — ✓"})],
    );
    assert_eq!(
        Collector::default().transcript(&path, "codex", "").2,
        "검수해줘 — ✓"
    );
}
#[test]
fn test_second_collector_does_not_take_the_lock() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("workflow.lock");
    let first = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    let second = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .unwrap();
    assert!(workflow::lock_once(&first));
    assert!(!workflow::lock_once(&second));
}
struct Rollouts {
    holders: HashMap<String, HashSet<u32>>,
    alive: HashMap<u32, u32>,
    calls: Vec<String>,
}
impl workflow::RolloutBackend for Rollouts {
    fn clock(&self) -> f64 {
        1000.
    }
    fn holders(&mut self, path: &str) -> HashSet<u32> {
        self.calls.push(path.into());
        self.holders[path].clone()
    }
    fn processes(&mut self) -> HashMap<u32, u32> {
        self.alive.clone()
    }
}
fn root_db(path: &Path, with_other: bool) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch("create table threads(id,rollout_path,archived,updated_at);create table thread_spawn_edges(parent_thread_id,child_thread_id,status);insert into threads values('root','r.jsonl',0,1);").unwrap();
    if with_other {
        db.execute_batch("insert into threads values('child','c.jsonl',0,3);insert into threads values('other','o.jsonl',0,2);insert into thread_spawn_edges values('root','child','open');").unwrap();
    }
    drop(db);
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}
#[test]
fn test_codex_thread_comes_from_the_root_rollout_a_process_holds() {
    let d = tempfile::tempdir().unwrap();
    let db = root_db(&d.path().join("state.sqlite"), true);
    let mut b = Rollouts {
        holders: HashMap::from([
            ("r.jsonl".into(), HashSet::from([40])),
            ("c.jsonl".into(), HashSet::from([40])),
            ("o.jsonl".into(), HashSet::from([50])),
        ]),
        alive: HashMap::from([(30, 1), (40, 30), (50, 1)]),
        calls: vec![],
    };
    let (mut holders, mut scanned) = (HashMap::new(), HashMap::new());
    assert_eq!(
        workflow::windows_codex_thread_with(&db, &[30, 40], &mut holders, &mut scanned, &mut b)
            .unwrap(),
        Some("root".into())
    );
    assert!(
        !b.calls.contains(&"c.jsonl".into()),
        "a sub-agent thread never names the session"
    );
    b.calls.clear();
    assert_eq!(
        workflow::windows_codex_thread_with(&db, &[30, 40], &mut holders, &mut scanned, &mut b)
            .unwrap(),
        Some("root".into())
    );
    assert_eq!(b.calls, vec!["r.jsonl"]);
    b.holders.insert("r.jsonl".into(), HashSet::new());
    assert_eq!(
        workflow::windows_codex_thread_with(&db, &[30, 40], &mut holders, &mut scanned, &mut b)
            .unwrap(),
        None
    );
    b.calls.clear();
    assert_eq!(
        workflow::windows_codex_thread_with(&db, &[30, 40], &mut holders, &mut scanned, &mut b)
            .unwrap(),
        None
    );
    assert!(
        b.calls.is_empty(),
        "a fruitless scan waits before scanning again"
    );
}
#[test]
fn test_codex_resumed_under_a_new_pid_is_found_again() {
    let d = tempfile::tempdir().unwrap();
    let db = root_db(&d.path().join("state.sqlite"), false);
    let mut b = Rollouts {
        holders: HashMap::from([("r.jsonl".into(), HashSet::from([40]))]),
        alive: HashMap::from([(30, 1), (40, 30)]),
        calls: vec![],
    };
    let (mut holders, mut scanned) = (HashMap::new(), HashMap::new());
    assert_eq!(
        workflow::windows_codex_thread_with(&db, &[30, 40], &mut holders, &mut scanned, &mut b)
            .unwrap(),
        Some("root".into())
    );
    b.holders.insert("r.jsonl".into(), HashSet::from([41]));
    b.alive = HashMap::from([(31, 1), (41, 31)]);
    assert_eq!(
        workflow::windows_codex_thread_with(&db, &[31, 41], &mut holders, &mut scanned, &mut b)
            .unwrap(),
        Some("root".into())
    );
    assert_eq!(
        holders,
        HashMap::from([(41, "root".into())]),
        "the gone pid is forgotten"
    );
}
