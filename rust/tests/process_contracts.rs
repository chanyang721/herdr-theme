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
#[ignore = "requires external Python baseline; deliberately waits 31s per implementation"]
fn workspace_api_retains_original_wait_beyond_thirty_seconds() {
    let f = Fixture::new();
    let tools = f.root.join("bin");
    fs::create_dir(&tools).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
        tools.join(if cfg!(windows) {
            "herdr-app.exe"
        } else {
            "herdr-app"
        }),
    )
    .unwrap();
    fs::write(&f.schema, json!({"allowDelayedReply":true,"replyDelayMs":31000,"delayedReply":{"reply":"completed after 31s"}}).to_string()).unwrap();
    let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let mut native = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
    f.configure(&mut native);
    native.env("PATH", &path).arg("workspace-api-contract");
    let start = std::time::Instant::now();
    let native = native.output().unwrap();
    assert!(start.elapsed().as_secs() >= 31);
    let scripts = PathBuf::from(
        std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS").expect("external Python baseline scripts"),
    );
    let mut original = Command::new(
        std::env::var_os("HERDR_THEME_ORACLE_PYTHON").expect("external Python executable"),
    );
    f.configure(&mut original);
    original.env("PATH", path).args(["-X", "utf8", "-c", "import sys,runpy,json;sys.path.insert(0,sys.argv[1]);m=runpy.run_path(sys.argv[1]+'/workspace.py');print(json.dumps(m['app']('fixture',{}),ensure_ascii=False))"]).arg(scripts);
    let original = original.output().unwrap();
    assert_eq!(
        native.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&native.stderr)
    );
    assert_eq!(native.status.code(), original.status.code());
    assert_eq!(native.stdout, original.stdout);
    assert_eq!(native.stderr, original.stderr);
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
#[cfg(unix)]
fn test_launch_argv_really_clears_the_markers() {
    let f = Fixture::new();
    let argv = herdr_theme::automation::launch_argv(vec![
        env!("CARGO_BIN_EXE_herdr-theme-test-fixture").into(),
        "process-contract".into(),
        "0".into(),
    ])
    .unwrap();
    let mut child = Command::new(&argv[0]);
    f.configure(&mut child);
    child.args(&argv[1..]);
    let out = child.output().unwrap();
    assert!(out.status.success());
    let value = parsed(&out);
    for key in AGENTS.iter().chain(PANES) {
        assert!(value["markers"].get(*key).is_none(), "{key}");
    }
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
fn structured_process_failure_has_json_stdout_exit_one_and_no_stderr() {
    let f = Fixture::new();
    let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
    command.arg("json-error-contract");
    f.configure(&mut command);
    let out = command.output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value, json!({"error":"synthetic process failure"}));
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

fn stdin_fixture(f: &Fixture, mode: &str) -> Command {
    let mut c = herdr_theme::common::command(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
    c.args(["capture-stdin-contract", mode]);
    f.configure(&mut c);
    c
}

#[test]
fn capture_stdin_drains_both_outputs_before_the_child_reads_a_large_utf8_request() {
    let f = Fixture::new();
    let input = "한글 \"quoted\" \\path\\file\n".repeat(8192);
    assert!(input.encode_utf16().count() > 32767);
    let (code, out, err) = herdr_theme::common::capture_cmd_input(
        stdin_fixture(&f, "bulk"),
        10.,
        input.as_bytes().to_vec(),
    )
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(err, "e".repeat(128 * 1024));
    assert!(out.starts_with(&"o".repeat(128 * 1024)));
    let reply: Value = serde_json::from_str(&out[128 * 1024..]).unwrap();
    assert_eq!(reply["stdin_bytes"], input.len());
    assert_eq!(reply["stdin_text"], input);
}

#[test]
fn capture_stdin_keeps_early_cli_refusal_and_rejects_incomplete_success() {
    let f = Fixture::new();
    let (code, out, err) = herdr_theme::common::capture_cmd_input(
        stdin_fixture(&f, "refuse"),
        5.,
        vec![b'x'; 2 * 1024 * 1024],
    )
    .unwrap();
    assert_eq!(code, 2);
    assert!(out.is_empty());
    assert!(err.contains("stdin option unsupported"));
    assert!(herdr_theme::common::capture_cmd_input(
        stdin_fixture(&f, "early-success"),
        5.,
        vec![b'x'; 2 * 1024 * 1024]
    )
    .is_err());
}

#[test]
fn capture_stdin_deadline_also_bounds_a_blocked_input_writer() {
    let f = Fixture::new();
    let started = std::time::Instant::now();
    let error = herdr_theme::common::capture_cmd_input(
        stdin_fixture(&f, "ignore"),
        0.2,
        vec![b'x'; 2 * 1024 * 1024],
    )
    .unwrap_err();
    assert!(error.to_string().contains("timed out"));
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
}
#[cfg(windows)]
#[test]
fn test_gui_collector_does_not_allocate_a_console_for_its_core_query() {
    let f = Fixture::new();
    let tools = f.root.join("bin");
    fs::create_dir_all(&tools).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
        tools.join("hc.exe"),
    )
    .unwrap();
    fs::write(
        &f.schema,
        json!({"allowProcessContract":true,"allowWorkflowConsole":true}).to_string(),
    )
    .unwrap();
    let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    // The original starts a custom pythonw parent with CREATE_NO_WINDOW and
    // imports the real collector hc() path. This native parent imports that
    // same production query implementation, then starts a real native child.
    let mut parent = herdr_theme::common::command(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
    f.configure(&mut parent);
    let out = parent
        .arg("workflow-gui-parent")
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        parsed(&out),
        json!({"parentConsole":false,"child":{"console":false}})
    );
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
