//! The original Windows stub cannot select a non-socket stdin after Enter.
//! Preserve its failure boundary: no labels, resumed record or agent launch.
#![cfg(windows)]
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

fn run(original: bool) -> Output {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let tools = root.join("bin");
    fs::create_dir(&tools).unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
        tools.join("hc.exe"),
    )
    .unwrap();
    let schema = root.join("fixture.json");
    let calls = root.join("calls.jsonl");
    fs::write(
        &schema,
        json!({"allowProcessContract":true,"allowPtyReceipt":true,"allowObserver":true})
            .to_string(),
    )
    .unwrap();
    let config = root.join("observer.json");
    fs::write(&config, json!({"harness":{"command":[env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),"observer-harness"]}}).to_string()).unwrap();
    let ticket = root.join("ticket.json");
    let bytes = json!({"address":"fixture-stub","app":"codex","session_id":"11111111-2222-3333-4444-555555555555","space_id":"fixture-space","space_name":"Fixture Workspace","title":"synthetic stub","config":config,"argv":[env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),"process-contract","0"]}).to_string();
    fs::write(&ticket, &bytes).unwrap();
    let mut command = if original {
        let mut command = Command::new(
            std::env::var_os("HERDR_THEME_ORACLE_PYTHON").expect("external baseline Python"),
        );
        command.arg(
            PathBuf::from(
                std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS").expect("external baseline scripts"),
            )
            .join("session_sleep_stub.py"),
        );
        command
    } else {
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        command.arg("session-sleep-stub");
        command
    };
    let mut child = command
        .arg(&ticket)
        .current_dir(root)
        .env("PATH", tools)
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("home"))
        .env("HERDR_APP_HOME", root.join("app"))
        .env("HERDR_TEST_FIXTURE", schema)
        .env("HERDR_TEST_CALL_LOG", &calls)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"\r\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(
        fs::read_to_string(&ticket).unwrap(),
        bytes,
        "failed read must preserve ticket"
    );
    assert!(!calls.exists(), "failed read must not invoke hc or harness");
    assert!(!root.join("cleared-labels.json").exists());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("FIXTURE_AGENT"));
    output
}

#[test]
fn enter_on_windows_preserves_original_unsupported_select_failure_without_resuming() {
    let output = run(false);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("10093"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains("Fixture Workspace fixture-stub synthetic stub"));
}

#[test]
#[ignore = "requires untouched external Python baseline"]
fn original_windows_pipe_select_failure_matches_native_exit_stdout_and_side_effects() {
    let original = run(true);
    let native = run(false);
    assert_eq!(native.status.code(), original.status.code());
    assert_eq!(native.stdout, original.stdout);
    assert!(String::from_utf8_lossy(&original.stderr).contains("10093"));
    assert!(String::from_utf8_lossy(&native.stderr).contains("10093"));
    // Python's traceback and the native exception transport intentionally remain
    // distinct diagnostics; this test does not normalize or claim their bytes.
}
