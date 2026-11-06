//! Frozen original argparse help, with only native command references translated.
use serde_json::Value;
use std::{fs, process::Command};

#[test]
fn original_help_options_descriptions_and_subcommands_are_preserved() {
    let snapshots: Value = serde_json::from_str(include_str!("../src/cli-help.json")).unwrap();
    let home = tempfile::tempdir().unwrap();
    for (key, expected) in snapshots.as_object().unwrap() {
        let words = key.split_whitespace().collect::<Vec<_>>();
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .args(&words)
            .arg("--help")
            .current_dir(home.path())
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("HERDR_APP_HOME", home.path().join("app"))
            .output()
            .unwrap();
        assert!(out.status.success(), "{key}: {:?}", out.status);
        assert!(
            out.stderr.is_empty(),
            "{key}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let expected = expected.as_str().unwrap();
        let expected = if cfg!(windows) {
            expected.replace('\n', "\r\n")
        } else {
            expected.to_owned()
        };
        assert_eq!(String::from_utf8(out.stdout).unwrap(), expected, "{key}");
    }
    assert_eq!(
        fs::read_dir(home.path()).unwrap().count(),
        0,
        "help wrote to the isolated home"
    );
}
