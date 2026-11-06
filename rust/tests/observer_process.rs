//! Observer helpers preserve each original subprocess timeout policy.
use serde_json::{json, Value};
use std::{
    fs,
    process::Command,
    time::{Duration, Instant},
};

#[test]
fn explicit_finite_timeout_still_kills_owned_child_while_unbounded_capture_waits_for_reply() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let schema = root.join("fixture.json");
    fs::write(&schema, json!({"allowDelayedReply":true,"replyDelayMs":120,"delayedReply":{"fixture":"late-reply"}}).to_string()).unwrap();
    let argv = vec![
        env!("CARGO_BIN_EXE_herdr-theme-test-fixture").into(),
        "herdr-app".into(),
        "do".into(),
        "fixture".into(),
        "{}".into(),
    ];
    let configure = |command: &mut Command| {
        command
            .current_dir(root)
            .env("HERDR_TEST_FIXTURE", &schema)
            .env("HERDR_TEST_CALL_LOG", root.join("calls.jsonl"));
    };
    let finite = herdr_theme::observers::execute_with(&argv, 0.01, false, configure);
    assert!(finite
        .err()
        .expect("finite wait must time out")
        .to_string()
        .starts_with("command timed out:"));
    let started = Instant::now();
    let output = herdr_theme::observers::execute_unbounded_with(&argv, false, configure).unwrap();
    assert!(started.elapsed() >= Duration::from_millis(120));
    assert_eq!(output.code, 0);
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_str::<Value>(&output.stdout).unwrap(),
        json!({"fixture":"late-reply"})
    );
}
