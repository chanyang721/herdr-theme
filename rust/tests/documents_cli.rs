//! CLI protocol errors must be distinguishable from runtime/install failures.
use serde_json::Value;
use std::{
    fs,
    process::{Command, Output},
};
fn invoke(args: &[&str], home: &std::path::Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(args)
        .env("HERDR_APP_HOME", home)
        .output()
        .unwrap()
}
#[test]
fn invalid_arguments_exit_two_before_any_file_is_written() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("app");
    for args in [
        vec!["install", "--updtae"],
        vec!["render_html"],
        vec!["render_html", "--doc", "missing", "--width", "bad"],
        vec!["resolve_doc_pins"],
        vec!["desktop", "unknown-action", "missing"],
        vec!["update_install", "--verify-timeout", "1"],
    ] {
        let out = invoke(&args, &home);
        assert_eq!(
            out.status.code(),
            Some(2),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stdout.is_empty(), "{args:?}");
        assert!(!out.stderr.is_empty());
        assert!(!home.exists());
    }
}
#[test]
fn missing_html_renderer_keeps_json_error_and_exit_one() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("app");
    let out = invoke(&["render_html", "--doc", "missing.html"], &home);
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stderr.is_empty());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(value["error"]
        .as_str()
        .unwrap()
        .contains("설치되지 않았습니다"));
    assert!(!home.exists());
}
#[test]
fn missing_insights_collector_keeps_json_error_and_empty_stderr() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("app");
    let collector = temp.path().join("missing-collector.mjs");
    let store = temp.path().join("unwritten-store.json");
    let out = invoke(
        &[
            "pinned_scan_insights",
            "--store",
            store.to_str().unwrap(),
            "--collector",
            collector.to_str().unwrap(),
        ],
        &home,
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stderr.is_empty());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["ok"], false);
    assert!(value["error"]
        .as_str()
        .unwrap()
        .contains("설치되지 않았습니다"));
    assert!(!home.exists());
    assert!(!store.exists());
}
#[test]
fn updater_runtime_failure_uses_original_error_prefix_without_stdout() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("app");
    let missing = temp.path().join("missing-source");
    let out = invoke(
        &[
            "update_install",
            "--repo",
            missing.to_str().unwrap(),
            "--without-workspace-mods",
            "mods/example/main.js",
        ],
        &home,
    );
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("Install failed: "));
    assert!(!home.exists());
}
#[test]
fn help_and_no_file_updater_usage_never_install() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("app");
    let out = invoke(&["install", "--help"], &home);
    assert!(out.status.success());
    assert!(!out.stdout.is_empty());
    assert!(!home.exists());
    let repo = temp.path().join("source");
    fs::create_dir_all(repo.join("mods")).unwrap();
    fs::create_dir_all(repo.join("layouts")).unwrap();
    let out = invoke(
        &[
            "update_install",
            "--repo",
            repo.to_str().unwrap(),
            "--without-workspace-mods",
        ],
        &home,
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(!home.exists());
}
