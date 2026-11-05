use super::*;
struct Fixture {
    _dir: tempfile::TempDir,
    db: PathBuf,
    t: Value,
    m: Value,
    c: Value,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);").unwrap();
        drop(conn);
        let t = json!({"address":"fixture-terminal","pid":100,"created_ms":1000,"status_ms":crate::observers::now()*1000.-1000.,"status":{"app":"codex","state":"done"}});
        let m = json!({"pid":100,"created_ms":1000,"session_id":"main-session","agent":"codex"});
        let c = json!({"codex_db":db.to_string_lossy()});
        let f = Self {
            _dir: dir,
            db,
            t,
            m,
            c,
        };
        f.log(
            "main-session",
            &[
                json!({"type":"event_msg","payload":{"type":"task_started"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete"}}),
            ],
        );
        f
    }
    fn log(&self, sid: &str, records: &[Value]) -> PathBuf {
        let path = self._dir.path().join(format!("{sid}.jsonl"));
        let mut text = json!({"type":"session_meta","payload":{"id":sid}}).to_string() + "\n";
        for r in records {
            text.push_str(&r.to_string());
            text.push('\n');
        }
        fs::write(&path, text).unwrap();
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO threads VALUES(?1,?2)",
            rusqlite::params![sid, path.to_string_lossy()],
        )
        .unwrap();
        path
    }
    fn check(&self, clean: bool) -> (bool, String, String) {
        check_jobs(&self.t, &self.c, &self.m, clean)
    }
}
#[test]
fn sqlite_evidence_is_read_only_and_stable() {
    let f = Fixture::new();
    let before = fs::read(&f.db).unwrap();
    let result = f.check(false);
    assert!(result.0, "{}", result.1);
    assert_eq!(result, f.check(false));
    assert_eq!(before, fs::read(&f.db).unwrap());
    assert!(!f.db.with_extension("sqlite-journal").exists());
}
#[test]
fn reused_terminal_identity_never_passes() {
    let mut f = Fixture::new();
    f.m["created_ms"] = json!(999);
    let result = f.check(false);
    assert!(!result.0);
    assert!(result.1.contains("terminal/session mapping mismatch"));
}
#[test]
fn closed_child_still_must_finish_commands() {
    let f = Fixture::new();
    f.log("child",&[json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call","arguments":{}}}),json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":{"session_id":5}}})]);
    let conn = rusqlite::Connection::open(&f.db).unwrap();
    conn.execute(
        "INSERT INTO thread_spawn_edges VALUES('main-session','child','closed')",
        [],
    )
    .unwrap();
    drop(conn);
    let result = f.check(false);
    assert!(!result.0);
    assert!(result.1.contains("running backend exec sessions"));
    assert!(f.check(true).0);
}
#[test]
fn incomplete_log_is_unverified() {
    let f = Fixture::new();
    let path = f._dir.path().join("main-session.jsonl");
    let mut bytes = fs::read(&path).unwrap();
    bytes.pop();
    fs::write(path, bytes).unwrap();
    let result = f.check(false);
    assert!(!result.0);
    assert!(result.1.contains("incomplete rollout history"));
}
