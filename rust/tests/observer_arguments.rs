//! Parser failures and lock contention must precede all live adapter work.
use herdr_theme::locking::FileLock;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Output, Stdio},
};

fn command(root: &Path, original: bool) -> Command {
    let mut command = if original {
        let mut command = Command::new(
            std::env::var_os("HERDR_THEME_ORACLE_PYTHON").expect("external baseline Python"),
        );
        command.arg(
            Path::new(
                &std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS").expect("external baseline scripts"),
            )
            .join("close_finished_spaces.py"),
        );
        command
    } else {
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        command.arg("close-finished-spaces");
        command
    };
    command
        .current_dir(root)
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("home"))
        .env("HERDR_APP_HOME", root.join("app"))
        .env("PATH", root.join("no-tools"))
        .stdin(Stdio::null());
    command
}

#[test]
fn original_mutual_exclusion_precedes_missing_configuration_for_both_observers() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/observer-argument-order.json")).unwrap();
    for case in cases {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .arg(case["command"].as_str().unwrap())
            .args(
                case["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap()),
            )
            .arg("--config")
            .arg(root.join("missing.json"))
            .env("HOME", root.join("home"))
            .env("USERPROFILE", root.join("home"))
            .env("HERDR_APP_HOME", root.join("app"))
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(case["code"].as_i64().unwrap() as i32)
        );
        assert_eq!(
            String::from_utf8(out.stdout).unwrap(),
            case["stdout"].as_str().unwrap()
        );
        assert!(String::from_utf8_lossy(&out.stderr)
            .trim_end()
            .ends_with(case["error"].as_str().unwrap()));
        assert!(!root.join("home").exists());
        assert!(!root.join("app").exists());
    }
}
#[test]
fn original_help_actions_preserve_earlier_argument_failures_and_skip_later_actions() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/observer-help-order.json")).unwrap();
    for case in cases {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path();
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .arg(case["command"].as_str().unwrap())
            .args(
                case["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap()),
            )
            .env("HOME", root.join("home"))
            .env("USERPROFILE", root.join("home"))
            .env("HERDR_APP_HOME", root.join("app"))
            .env("PATH", root.join("no-tools"))
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(case["code"].as_i64().unwrap() as i32),
            "{case}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        if case["help"] == true {
            assert!(out.stdout.starts_with(b"usage:"), "{case}");
            assert!(out.stderr.is_empty());
        } else {
            assert!(out.stdout.is_empty(), "{case}");
            assert!(
                String::from_utf8_lossy(&out.stderr)
                    .trim_end()
                    .ends_with(case["error"].as_str().unwrap()),
                "{case}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        assert!(!root.join("home").exists());
        assert!(!root.join("app").exists());
    }
}

fn locked_now(original: bool) -> Output {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let config = root.join("config.json");
    let state = root.join("observer-state.json");
    fs::write(&config, json!({"fixed_names":["Share"]}).to_string()).unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(state.with_extension("lock"))
        .unwrap();
    lock.try_lock_exclusive().unwrap();
    let out = command(root, original)
        .arg("--config")
        .arg(config)
        .arg("--state")
        .arg(&state)
        .arg("--now")
        .output()
        .unwrap();
    assert!(
        !state.exists(),
        "contended observer must not read or save state"
    );
    out
}

#[test]
fn contended_observer_skips_before_invalid_now_check_and_never_calls_an_adapter() {
    let out = locked_now(false);
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap(),
        json!({"action":"skip","reason":"another cleanup observer is running"})
    );
}

#[test]
#[ignore = "requires untouched external Python baseline"]
fn original_and_native_lock_contention_precede_invalid_now_with_identical_stdout() {
    let original = locked_now(true);
    let native = locked_now(false);
    assert_eq!(native.status.code(), original.status.code());
    assert_eq!(native.stdout, original.stdout);
    assert_eq!(native.stderr, original.stderr);
}

#[test]
fn invalid_now_after_acquiring_lock_creates_the_lock_but_never_state() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let config = root.join("config.json");
    let state = root.join("private/observer-state.json");
    fs::write(&config, json!({"fixed_names":["Share"]}).to_string()).unwrap();
    let out = command(root, false)
        .arg("--config")
        .arg(config)
        .arg("--state")
        .arg(&state)
        .arg("--now")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr)
        .trim_end()
        .ends_with("--now needs --apply and --only-space"));
    assert!(state.with_extension("lock").exists());
    assert!(!state.exists());
}
