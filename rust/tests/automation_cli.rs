//! Native CLI argument tests and the extension-command convention. Every run uses an
//! isolated home and PATH; no user service is contacted.
use serde_json::Value;
use std::{fs, process::Command};
#[test]
fn fixture_refuses_without_explicit_test_schema() {
    let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"))
        .env_remove("HERDR_TEST_FIXTURE")
        .arg("hc")
        .arg("ls")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no real service is contacted"));
}
#[test]
fn original_argparse_errors_help_and_precedence_keep_exact_bytes() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/automation-argparse.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        let command = case["command"].as_str().unwrap();
        let args = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect::<Vec<_>>();
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .arg(command)
            .args(&args)
            .env("HOME", root.path())
            .env("USERPROFILE", root.path())
            .env("HERDR_APP_HOME", root.path().join("app"))
            .env("LOCALAPPDATA", root.path().join("local"))
            .env("PATH", root.path())
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            case["code"].as_i64().map(|c| c as i32),
            "{command} {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let expected_stdout = case["stdout"].as_str().unwrap().to_owned();
        assert_eq!(
            out.stdout,
            herdr_theme::common::text_bytes(&expected_stdout),
            "stdout: {command} {args:?}"
        );
        assert_eq!(
            out.stderr,
            herdr_theme::common::text_bytes(case["stderr"].as_str().unwrap()),
            "stderr: {command} {args:?}"
        );
        assert_eq!(
            fs::read_dir(root.path()).unwrap().count(),
            0,
            "parser touched isolated home: {command} {args:?}"
        );
    }
}
#[test]
#[cfg(unix)]
fn unknown_commands_run_an_installed_extension_executable_or_fail_as_unknown() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let theme = bin.join("herdr-theme");
    fs::copy(env!("CARGO_BIN_EXE_herdr-theme"), &theme).unwrap();
    let missing = Command::new(&theme)
        .args(["demo-ext", "a"])
        .env("PATH", root.path().join("empty"))
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("unknown command: demo_ext"));
    let ext = bin.join("herdr-theme-demo-ext");
    fs::write(&ext, "#!/bin/sh\nprintf '%s|' \"$@\"\nexit 7\n").unwrap();
    fs::set_permissions(&ext, fs::Permissions::from_mode(0o755)).unwrap();
    let out = Command::new(&theme)
        .args(["demo-ext", "a", "--b"])
        .env("PATH", root.path().join("empty"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7), "the extension's exit code is kept");
    assert_eq!(String::from_utf8_lossy(&out.stdout), "a|--b|");
}
