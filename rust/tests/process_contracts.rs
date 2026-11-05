//! Actual subprocess regressions for identity cleanup and Windows GUI collectors.
//! The fixture reports only a fixed marker allowlist; unrelated environment and
//! secret values are never printed. No app/core/network service is contacted.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
const AGENTS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CODEX_THREAD_ID",
];
const PANES: &[&str] = &["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    schema: PathBuf,
    log: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let schema = root.join("fixture.json");
        let log = root.join("calls.jsonl");
        fs::write(
            &schema,
            json!({"allowProcessContract":true,"spaces":[],"terminals":[]}).to_string(),
        )
        .unwrap();
        Self {
            _temp: temp,
            root,
            schema,
            log,
        }
    }
    fn configure(&self, c: &mut Command) {
        c.current_dir(&self.root)
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env("HERDR_APP_HOME", self.root.join("app"))
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("LOCALAPPDATA", self.root.join("local"));
        for key in AGENTS {
            c.env(key, "fixture-agent");
        }
        for key in PANES {
            c.env(key, "fixture-pane");
        }
        c.env("HERDR_TEST_PRESERVED", "fixture-keep")
            .env_remove("HC_TERMINAL_ID");
    }
    fn agent(&self, hc: Option<&str>, exit: &str) -> Output {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.args([
            "agent-env",
            env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
            "process-contract",
            exit,
        ]);
        self.configure(&mut c);
        if let Some(hc) = hc {
            c.env("HC_TERMINAL_ID", hc);
        }
        c.output().unwrap()
    }
}
fn parsed(out: &Output) -> Value {
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]
fn hc_agent_exec_drops_parent_agent_and_pane_identity_and_propagates_exit() {
    let f = Fixture::new();
    let out = f.agent(Some("fixture-terminal"), "37");
    assert_eq!(out.status.code(), Some(37));
    let v = parsed(&out);
    for key in AGENTS.iter().chain(PANES) {
        assert!(
            v["markers"].get(*key).is_none(),
            "parent marker survived: {key}"
        );
    }
    assert_eq!(v["markers"]["HC_TERMINAL_ID"], "fixture-terminal");
    assert_eq!(v["markers"]["HERDR_TEST_PRESERVED"], "fixture-keep");
}
#[test]
fn native_agent_exec_keeps_its_pane_identity_but_clears_agent_identity() {
    let f = Fixture::new();
    let out = f.agent(None, "0");
    assert_eq!(out.status.code(), Some(0));
    let v = parsed(&out);
    for key in AGENTS {
        assert!(v["markers"].get(*key).is_none());
    }
    for key in PANES {
        assert_eq!(v["markers"][*key], "fixture-pane");
    }
    assert!(v["markers"].get("HC_TERMINAL_ID").is_none());
}
#[test]
fn empty_hc_marker_has_original_false_value_semantics() {
    let f = Fixture::new();
    let out = f.agent(Some(""), "0");
    assert_eq!(out.status.code(), Some(0));
    let v = parsed(&out);
    for key in PANES {
        assert_eq!(v["markers"][*key], "fixture-pane");
    }
}
#[test]
fn structured_observer_failure_has_json_stdout_exit_one_and_no_stderr() {
    let f = Fixture::new();
    let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
    command.arg("observer-error-contract");
    f.configure(&mut command);
    let out = command.output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        value,
        json!({"at":"2000-01-01T00:00:00+00:00","mode":"dry-run","error":"synthetic observer failure","results":[]})
    );
    assert!(out
        .stdout
        .ends_with(if cfg!(windows) { b"\r\n" } else { b"\n" }));
}
#[cfg(windows)]
#[test]
fn common_capture_creates_a_real_child_without_a_console() {
    let f = Fixture::new();
    let mut c = herdr_theme::common::command(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
    c.args(["process-contract", "0"]);
    f.configure(&mut c);
    let (code, out, err) = herdr_theme::common::capture_cmd(c, 10.).unwrap();
    assert_eq!(code, 0);
    assert!(err.is_empty());
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["has_console"], false);
}
#[cfg(windows)]
#[test]
fn workflow_gui_collector_hides_its_actual_hc_child() {
    let f = Fixture::new();
    let tools = f.root.join("bin");
    fs::create_dir_all(&tools).unwrap();
    for name in ["hc.exe", "herdr-app.exe", "herdr-core.exe", "herdr.exe"] {
        fs::copy(
            env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
            tools.join(name),
        )
        .unwrap();
    }
    let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
    c.args(["collect-workflow", "--once"]);
    f.configure(&mut c);
    c.env("PATH", path);
    let out = c.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    let calls = fs::read_to_string(&f.log)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    assert!(!calls.is_empty());
    assert!(calls
        .iter()
        .all(|c| c["program"] == "hc" && c["args"][0] == "ls" && c["has_console"] == false));
    let output: Value =
        serde_json::from_slice(&fs::read(f.root.join("app/data/sixfold/workflow.json")).unwrap())
            .unwrap();
    assert_eq!(output, json!({"nodes":[],"events":[]}));
}
