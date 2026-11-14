//! Real persistent stdio subprocesses, entirely backed by the gated fixture.
//! These tests never connect to an installed core or read real session state.
use herdr_theme::{
    automation::{workflow, workflow_core::Connection},
    common::{command, Result},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

struct Fixture {
    _temp: tempfile::TempDir,
    schema: PathBuf,
    log: PathBuf,
}
impl Fixture {
    fn new(settings: Value) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let schema = temp.path().join("fixture.json");
        let log = temp.path().join("calls.jsonl");
        fs::write(
            &schema,
            json!({"allowWorkflowCore":true,"workflowCore":settings}).to_string(),
        )
        .unwrap();
        Self {
            _temp: temp,
            schema,
            log,
        }
    }
    fn command(&self) -> Command {
        let mut child = command(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
        child
            .args(["hc", "connect"])
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log);
        child
    }
    fn connect(&self) -> Connection {
        Connection::start(self.command()).unwrap()
    }
    fn records(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn child_pid(&self) -> u32 {
        self.records()
            .iter()
            .find(|row| row["event"] == "start")
            .unwrap()["pid"]
            .as_u64()
            .unwrap() as u32
    }
}

fn assert_child_exited(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use std::ffi::c_void;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        let handle = OpenProcess(0x00100000, 0, pid); // SYNCHRONIZE
        if handle.is_null() {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(87),
                "child lookup failed for a reason other than an absent PID"
            );
        } else {
            let status = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            assert_eq!(status, 0, "child remained alive after Connection drop");
        }
    }
    #[cfg(unix)]
    {
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "child remained alive after Connection drop"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}

#[test]
fn repeated_lists_share_one_child_and_read_fresh_snapshot_identity() {
    let before = json!({"address":"t-parent","pid":21,"parent":null,"created_ms":1001,"state":"live","argv":["/bin/claude"],"status":{"app":"claude-code","state":"working"}});
    let after = json!({"address":"t-parent","pid":22,"parent":"t-owner","created_ms":2002,"state":"live","argv":["/bin/codex"],"status":{"app":"codex","state":"idle"}});
    let f = Fixture::new(json!({"snapshots":[{"terminals":[before]},{"terminals":[after]}]}));
    let mut connection = f.connect();
    assert_eq!(
        connection.list(Duration::from_secs(5)).unwrap(),
        json!({"terminals":[before]})
    );
    assert_eq!(
        connection.list(Duration::from_secs(5)).unwrap(),
        json!({"terminals":[after]})
    );
    let records = f.records();
    assert_eq!(
        records.iter().filter(|row| row["event"] == "start").count(),
        1
    );
    let requests = records
        .iter()
        .filter(|row| row["event"] == "request")
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["pid"], requests[1]["pid"]);
    for (index, row) in requests.iter().enumerate() {
        assert_eq!(row["args"], json!(["connect"]));
        assert_eq!(
            row["rpc"],
            json!({"jsonrpc":"2.0","id":index+1,"method":"terminal.list","params":{}})
        );
    }
    let pid = f.child_pid();
    drop(connection);
    assert_child_exited(pid);
}

#[test]
fn timeout_is_bounded_and_discarding_connection_reaps_its_waiting_child() {
    let f = Fixture::new(json!({"modes":["reply","timeout"]}));
    let mut connection = f.connect();
    connection.list(Duration::from_secs(5)).unwrap();
    let pid = f.child_pid();
    let started = Instant::now();
    assert!(connection.list(Duration::from_millis(150)).is_err());
    drop(connection);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "timeout/drop waited for the fixture's three-second response"
    );
    assert_child_exited(pid);
    // A replacement transport starts at request 1; no stale old reply can
    // satisfy its first request or share the abandoned child.
    let mut replacement = f.connect();
    assert_eq!(
        replacement.list(Duration::from_secs(5)).unwrap(),
        json!({"terminals":[]})
    );
    let starts = f
        .records()
        .into_iter()
        .filter(|row| row["event"] == "start")
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 2);
    assert_ne!(starts[0]["pid"], starts[1]["pid"]);
    let replacement_pid = starts[1]["pid"].as_u64().unwrap() as u32;
    drop(replacement);
    assert_child_exited(replacement_pid);
}

#[test]
fn invalid_partial_and_oversized_replies_fail_closed_and_release_the_child() {
    for mode in [
        "wrong-id",
        "wrong-version",
        "error",
        "missing-terminals",
        "malformed",
        "eof",
        "disconnect",
        "oversized",
    ] {
        let f = Fixture::new(json!({"modes":["reply",mode]}));
        let mut connection = f.connect();
        connection.list(Duration::from_secs(5)).unwrap();
        let pid = f.child_pid();
        let started = Instant::now();
        assert!(
            connection.list(Duration::from_secs(5)).is_err(),
            "accepted invalid mode: {mode}"
        );
        drop(connection);
        assert!(
            started.elapsed() < Duration::from_secs(6),
            "unbounded mode: {mode}"
        );
        assert_child_exited(pid);
    }
}

struct SnapshotIdentity(Value);
impl workflow::IdentifyBackend for SnapshotIdentity {
    fn facts(&mut self, _: &str) -> Result<Value> {
        Ok(self.0.clone())
    }
    fn process_tree(&mut self, pid: u32) -> Vec<u32> {
        assert_eq!(pid, 42);
        vec![pid]
    }
    fn codex_thread(&mut self, _: &[u32]) -> Result<Option<String>> {
        Ok(None)
    }
    fn claude_session(&mut self, _: &[u32]) -> Option<String> {
        None
    }
    fn bridged_session(&mut self, _: &str, _: &str) -> Result<Option<String>> {
        Ok(None)
    }
}

#[test]
fn raw_terminal_mapping_matches_cli_fields_and_preserves_identity() {
    let raw = json!({"address":"t-child","pid":42,"parent":"t-parent","created_ms":1234567890123i64,"argv":["/opt/bin/fallback"],"status":{"app":"claude-code","state":"working"},"state":"live"});
    let mapped = workflow::workflow_terminal(&raw);
    assert_eq!(mapped["agent"], "claude-code");
    assert_eq!(mapped["status"], "working");
    for key in ["address", "pid", "parent", "created_ms", "argv", "state"] {
        assert_eq!(mapped[key], raw[key]);
    }
    assert_eq!(
        workflow::identify_with(&mapped, &mut SnapshotIdentity(raw.clone())).unwrap(),
        json!({"pid":42,"session":null,"parent":"t-parent","created":1234567890123i64})
    );
    let mut no_report = raw.clone();
    no_report["status"] = Value::Null;
    let mapped = workflow::workflow_terminal(&no_report);
    assert_eq!(mapped["agent"], "fallback");
    assert!(mapped["status"].is_null());
    // The CLI currently splits only '/', including on Windows.
    no_report["argv"] = json!(["C:\\tools\\codex.exe"]);
    assert_eq!(
        workflow::workflow_terminal(&no_report)["agent"],
        "C:\\tools\\codex.exe"
    );
}

#[test]
fn actual_collector_uses_raw_parent_and_creation_facts_without_per_terminal_queries() {
    let f = Fixture::new(json!({"terminals":[
        {"address":"t-parent","pid":42,"parent":null,"created_ms":111,"state":"live","argv":["/bin/fixture-agent"],"status":{"app":"fixture-agent","state":"working"}},
        {"address":"t-child","pid":43,"parent":"t-parent","created_ms":222,"state":"live","argv":["/bin/fixture-agent"],"status":{"app":"fixture-agent","state":"idle"}}
    ]}));
    let root = f._temp.path();
    let tools = root.join("bin");
    fs::create_dir(&tools).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
        tools.join(if cfg!(windows) { "hc.exe" } else { "hc" }),
    )
    .unwrap();
    let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let output = command(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(["collect-workflow", "--once"])
        .env("HERDR_TEST_FIXTURE", &f.schema)
        .env("HERDR_TEST_CALL_LOG", &f.log)
        .env("HERDR_APP_HOME", root.join("app"))
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("home"))
        .env("LOCALAPPDATA", root.join("local"))
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let workflow: Value =
        serde_json::from_slice(&fs::read(root.join("app/data/sixfold/workflow.json")).unwrap())
            .unwrap();
    assert_eq!(
        workflow,
        json!({"nodes":[{"id":"sub:t-parent:t-child","parent":"t-parent","terminal":"t-parent","label":"fixture-agent","status":"idle","statusSource":"hc","at":222}],"events":[]})
    );
    let records = f.records();
    assert_eq!(
        records.len(),
        2,
        "only one connect child and one terminal.list request are needed"
    );
    assert_eq!(records[0]["event"], "start");
    assert_eq!(records[1]["event"], "request");
    assert_child_exited(f.child_pid());
}
