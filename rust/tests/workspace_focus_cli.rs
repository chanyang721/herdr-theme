//! End-to-end finally behavior through a refusing native fake app executable.
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};
fn exercise(original: bool) -> Vec<Value> {
    let mut receipts = vec![];
    for scenario in [
        "created-selection",
        "partial-create-error",
        "named-concurrent-selection",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        let tools = temp.path().join("tools");
        fs::create_dir_all(&tools).unwrap();
        let tool = tools.join(if cfg!(windows) {
            "herdr-app.exe"
        } else {
            "herdr-app"
        });
        fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), &tool).unwrap();
        let fixture = temp.path().join("fixture.json");
        fs::write(
            &fixture,
            json!({"allowWorkspaceFocus":true,"workspaceFocusScenario":scenario}).to_string(),
        )
        .unwrap();
        let log = temp.path().join("calls.jsonl");
        let mut command = if original {
            let mut c = Command::new(
                std::env::var_os("HERDR_THEME_ORACLE_PYTHON")
                    .expect("external original Python required"),
            );
            let scripts = PathBuf::from(
                std::env::var_os("HERDR_THEME_UPSTREAM_SCRIPTS")
                    .expect("exact upstream scripts required"),
            );
            c.args(["-X", "utf8"]).arg(scripts.join("workspace.py"));
            c.env(
                "PYTHONPATH",
                std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS")
                    .expect("unchanged baseline dependencies required"),
            );
            c
        } else {
            let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
            c.arg("workspace");
            c
        };
        let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )))
        .unwrap();
        let out = command
            .args(["Fixture Space", "/fixture/workspace", "--shells"])
            .env("PATH", path)
            .env("HERDR_APP_HOME", &app)
            .env("HERDR_TEST_FIXTURE", &fixture)
            .env("HERDR_TEST_CALL_LOG", &log)
            .env("PYTHONUTF8", "1")
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(if scenario == "partial-create-error" {
                1
            } else {
                0
            }),
            "{scenario}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let calls: Vec<Value> = fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| {
                let row: Value = serde_json::from_str(line).unwrap();
                let mut args = row["args"].as_array().unwrap().clone();
                if args[0] == "do" {
                    args[2] = serde_json::from_str(args[2].as_str().unwrap()).unwrap();
                }
                json!(args)
            })
            .collect();
        let mut expected = vec![
            json!(["ls"]),
            json!(["status"]),
            json!(["ls"]),
            json!(["do","space.new",{"name":"Fixture Space","folder":"/fixture/workspace","tab":"개발"}]),
        ];
        if scenario != "partial-create-error" {
            expected.extend([
                json!(["ls"]),
                json!(["do","space.rename",{"id":"new-space","name":"Fixture Space"}]),
            ]);
        }
        expected.extend([json!(["status"]), json!(["ls"])]);
        if scenario != "named-concurrent-selection" {
            expected.extend([
                json!(["do","space.select",{"id":"old-space"}]),
                json!(["do","tab.select",{"id":"old-tab"}]),
                json!(["do","pane.focus",{"pane":"old-pane"}]),
            ]);
        }
        assert_eq!(
            calls, expected,
            "{scenario}: action order including failure-finally"
        );
        let state: Value = serde_json::from_slice(
            &fs::read(temp.path().join("workspace-focus-state.json")).unwrap(),
        )
        .unwrap();
        let selection = json!([state["space"], state["tab"], state["focused_pane"]]);
        assert_eq!(
            selection,
            if scenario == "named-concurrent-selection" {
                json!(["other-space", "concurrent-tab", "concurrent-pane"])
            } else {
                json!(["old-space", "old-tab", "old-pane"])
            }
        );
        assert!(
            !app.join("data/sixfold/space-tiers.json").exists(),
            "shell creation never writes a tier book"
        );
        let output = if out.status.success() {
            serde_json::from_slice::<Value>(&out.stdout).unwrap()
        } else {
            assert!(out.stdout.is_empty());
            assert!(!out.stderr.is_empty());
            Value::Null
        };
        receipts
            .push(json!({"scenario":scenario,"calls":calls,"selection":selection,"output":output}));
    }
    receipts
}
#[test]
fn native_workspace_restores_success_and_partial_failure_but_preserves_concurrent_choice() {
    exercise(false);
}
#[test]
#[ignore = "manual comparison requires exact upstream original and baseline external Python dependencies"]
fn external_upstream_workspace_cli_matches_native_action_receipts() {
    assert_eq!(exercise(false), exercise(true));
}
