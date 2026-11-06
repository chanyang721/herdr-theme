//! Exact untouched argparse outcomes; no successful helper action is executed.
use herdr_theme::documents::{arguments, common::*};
use serde_json::Value;
use std::{fs, process::Command};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/documents-argparse.json")).unwrap()
}
#[test]
fn all_original_argparse_cases_preserve_source_order_and_error_precedence() {
    for case in corpus()["cases"].as_array().unwrap() {
        let command = case["command"].as_str().unwrap();
        let args = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let parsed = arguments::parse_only(command, &args);
        match case["expected"]["kind"].as_str().unwrap() {
            "accepted" => {
                assert!(parsed.is_ok(), "{command} {args:?}: {parsed:?}");
            }
            "help" => {
                assert!(has(&parsed.unwrap(), "--help"), "{command} {args:?}");
            }
            "error" => {
                let error = parsed.unwrap_err();
                let error = error
                    .downcast_ref::<herdr_theme::common::CliError>()
                    .unwrap();
                assert_eq!(error.code, 2);
                assert_eq!(
                    format!("{}\n", error.message),
                    case["expected"]["stderr"].as_str().unwrap(),
                    "{command} {args:?}"
                );
            }
            other => panic!("unknown frozen outcome {other}"),
        }
    }
}
#[test]
fn original_help_and_usage_error_clis_match_exact_stdout_stderr_and_status() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("app");
    for case in corpus()["cases"].as_array().unwrap() {
        if case["expected"]["kind"] == "accepted" {
            continue;
        }
        let command = case["command"].as_str().unwrap();
        let args = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        // First prove this is a parser-only outcome in this same library build;
        // no unexpected successful installation/app call may run in the CLI.
        let checked = arguments::normalize(command, &args);
        if case["expected"]["kind"] == "error" {
            assert!(checked.is_err(), "{command} {args:?}")
        } else {
            assert!(has(&checked.unwrap(), "--help"))
        }
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .arg(command)
            .args(&args)
            .env("HERDR_APP_HOME", &app)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code().map(i64::from),
            case["expected"]["exit"].as_i64(),
            "{command} {args:?}"
        );
        let actual_stdout = String::from_utf8(out.stdout).unwrap().replace("\r\n", "\n");
        let original_stdout = case["expected"]["stdout"].as_str().unwrap();
        if command == "update_install" && case["expected"]["kind"] == "help" {
            // One explicit interpreter-removal transport reference. The frozen
            // original remains untouched and every other help byte is exact.
            assert_eq!(original_stdout.matches("voice/install.py").count(), 1);
            assert_eq!(
                actual_stdout.matches("herdr-theme voice_install").count(),
                1
            );
            assert!(!actual_stdout.contains("voice/install.py"));
            let (before, after) = original_stdout.split_once("voice/install.py").unwrap();
            assert_eq!(
                actual_stdout,
                format!("{before}herdr-theme voice_install{after}"),
                "{command} {args:?} literal transport reference"
            );
        } else {
            assert_eq!(actual_stdout, original_stdout, "{command} {args:?} stdout");
        }
        assert_eq!(
            String::from_utf8(out.stderr).unwrap().replace("\r\n", "\n"),
            case["expected"]["stderr"].as_str().unwrap(),
            "{command} {args:?} stderr"
        );
        assert!(
            !app.exists(),
            "parser-only invocation must not create app data"
        );
    }
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}
