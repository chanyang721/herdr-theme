//! Native SDK failure-boundary tests; every external tool is an explicit fixture.
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    config: PathBuf,
    log: PathBuf,
    tools: PathBuf,
}
impl Fixture {
    fn new(responses: Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let tools = root.join("bin");
        fs::create_dir(&tools).unwrap();
        for name in ["herdr", "herdr-core", "herdr-app", "hc", "lsappinfo"] {
            let path = tools.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
            fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), path).unwrap();
        }
        let config = root.join("fixture.json");
        let log = root.join("calls.jsonl");
        fs::write(&config,json!({"allowVoice":true,"voiceResponses":responses,"voicePane":{"pane_id":"pane","agent_session":{"value":"fallback"}}}).to_string()).unwrap();
        Self {
            _dir: dir,
            root,
            config,
            log,
            tools,
        }
    }
    fn invoke(&self, action: &str, id: &str) -> (Value, std::process::Output) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
        command
            .args(["voice-contract", action, id])
            .env("HERDR_TEST_FIXTURE", &self.config)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env(
                "HERDR_BIN_PATH",
                self.tools
                    .join(format!("herdr{}", std::env::consts::EXE_SUFFIX)),
            )
            .env(
                "SIXFOLD_REAL_HC",
                self.tools
                    .join(format!("herdr-core{}", std::env::consts::EXE_SUFFIX)),
            )
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("HERDR_APP_HOME", self.root.join("app"))
            .env("HERDR_PLUGIN_STATE_DIR", self.root.join("state"))
            .env("HERDR_SHERPA_LIBRARY", self.root.join("missing-sdk"))
            .env("PATH", &self.tools)
            .env("PYTHONUTF8", "1")
            .env(
                "HERDR_PLUGIN_EVENT_JSON",
                r#"{"type":"pane_agent_status_changed","pane_id":"target","agent_status":"done"}"#,
            );
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        (serde_json::from_slice(&output.stdout).unwrap(), output)
    }
    fn records(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}
fn response(program: &str, args: &[&str], stdout: &str, code: i32) -> Value {
    json!({"program":program,"args":args,"stdout":stdout,"stderr":"private fixture stderr\n","code":code})
}
#[test]
fn unchecked_reads_and_keys_accept_nonzero_status_and_keep_stderr_captured() {
    let f = Fixture::new(json!([
        response(
            "herdr",
            &["pane", "read", "pane", "--source", "visible", "--lines", "14", "--ansi"],
            "screen\r\n",
            19
        ),
        response("herdr", &["pane", "send-keys", "pane", "f8"], "", 23),
        response("herdr-core", &["read", "native"], "native-screen", 19),
        response("herdr-core", &["keys", "native", "f8"], "", 23)
    ]));
    for (id, expected) in [("pane", "screen\n"), ("app:native", "native-screen")] {
        let (value, output) = f.invoke("screen", id);
        assert_eq!(value, json!({"ok":true,"value":expected}));
        assert!(output.stderr.is_empty());
        let (value, output) = f.invoke("send", id);
        assert_eq!(value, json!({"ok":true,"value":true}));
        assert!(output.stderr.is_empty());
    }
    assert_eq!(
        f.records()
            .iter()
            .map(|r| r["program"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["herdr", "herdr", "herdr-core", "herdr-core"]
    );
}
#[test]
fn frontmost_reads_ignore_nonzero_status_when_stdout_is_valid() {
    let f = Fixture::new(json!([
        response("lsappinfo", &["front"], "front-token", 9),
        response(
            "lsappinfo",
            &["info", "-only", "bundleid", "front-token"],
            "bundleid=dev.herdr.app",
            8
        )
    ]));
    let (value, output) = f.invoke("front", "");
    assert_eq!(value, json!({"ok":true,"value":true}));
    assert!(output.stderr.is_empty());
    assert_eq!(f.records().len(), 2);
}
#[test]
fn session_json_errors_fallback_but_spawn_errors_propagate() {
    let f = Fixture::new(json!([response(
        "herdr",
        &["pane", "process-info", "--pane", "pane"],
        "not-json",
        17
    )]));
    assert_eq!(
        f.invoke("session", "").0,
        json!({"ok":true,"value":"pane:fallback"})
    );
    fs::remove_file(
        f.tools
            .join(format!("herdr{}", std::env::consts::EXE_SUFFIX)),
    )
    .unwrap();
    assert_eq!(
        f.invoke("session", "").0,
        json!({"ok":false,"class":"FileNotFoundError"})
    );
}
#[test]
fn no_optional_sdk_listener_does_not_create_or_respawn_gate() {
    let f = Fixture::new(json!([
        response(
            "herdr",
            &["pane", "read", "pane", "--source", "visible", "--lines", "14", "--ansi"],
            "",
            0
        ),
        response("herdr", &["pane", "list"], "{\"result\":{\"panes\":[]}}", 0),
        response("lsappinfo", &["front"], "front-token", 9),
        response(
            "lsappinfo",
            &["info", "-only", "bundleid", "front-token"],
            "bundleid=other.app",
            8
        )
    ]));
    let (value, _) = f.invoke("listen", "pane");
    assert_eq!(value, json!({"ok":true,"value":true}));
    assert!(!f.root.join("state/voicegate.err").exists());
    assert!(!f.root.join("state/voicegate.pid").exists());
    assert!(f
        .records()
        .iter()
        .all(|r| r["program"] == "herdr" || r["program"] == "lsappinfo"));
}
#[test]
fn checked_app_session_failure_keeps_stderr_inherited() {
    let f = Fixture::new(json!([response(
        "herdr-core",
        &["get", "native"],
        "{}",
        19
    )]));
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["voicePane"] = json!({"pane_id":"app:native"});
    fs::write(&f.config, config.to_string()).unwrap();
    let (value, output) = f.invoke("session", "");
    assert_eq!(value, json!({"ok":false,"class":"CalledProcessError"}));
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "private fixture stderr\n"
    );
}
#[test]
fn asked_app_projection_uses_valid_json_even_when_every_sdk_exit_is_nonzero() {
    let f = Fixture::new(json!([
        response(
            "herdr",
            &["pane", "list"],
            r#"{"result":{"panes":[{"pane_id":"tui","agent":"claude","agent_status":"idle","focused":true}]}}"#,
            17
        ),
        response("lsappinfo", &["front"], "token", 9),
        response(
            "lsappinfo",
            &["info", "-only", "bundleid", "token"],
            "bundleid=dev.herdr.app",
            8
        ),
        response(
            "herdr-app",
            &["status"],
            r#"{"focused_pane":"focused"}"#,
            19
        ),
        response(
            "herdr-app",
            &["ls"],
            r#"{"spaces":[{"tabs":[{"terminals":[{"pane":"focused","terminal":"native"}]}]}]}"#,
            18
        ),
        response(
            "herdr-core",
            &["ls", "--json"],
            r#"{"terminals":[{"address":"native","agent":"claude-code","status":"idle"}]}"#,
            16
        ),
        response(
            "herdr-core",
            &["ls", "--json", "--label", "sixfold.source-session=default"],
            r#"{"terminals":[]}"#,
            15
        ),
        response("herdr-core", &["get", "native"], r#"{"labels":{}}"#, 14)
    ]));
    let (value, output) = f.invoke("panes", "");
    assert_eq!(value["ok"], true);
    assert_eq!(value["value"]["app:native"]["focused"], true);
    assert_eq!(value["value"]["tui"]["focused"], false);
    assert!(output.stderr.is_empty());
    assert_eq!(f.records().last().unwrap()["program"], "herdr-core");
}
#[test]
fn checked_codex_controller_rejects_nonzero_json_reply() {
    let f = Fixture::new(json!([
        response("herdr", &["pane", "list"], r#"{"result":{"panes":[]}}"#, 0),
        response("herdr-core", &["ls", "--json"], r#"{"terminals":[]}"#, 19)
    ]));
    let (value, output) = f.invoke("targets", "");
    assert_eq!(value, json!({"ok":false,"class":"CalledProcessError"}));
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "private fixture stderr\nprivate fixture stderr\n"
    );
}
#[test]
fn nonzero_agent_focus_does_not_abort_queue_state_update() {
    let panes = r#"{"result":{"panes":[{"pane_id":"current","agent":"claude","agent_status":"working","focused":true},{"pane_id":"target","agent":"shell","agent_status":"done","focused":false}]}}"#;
    let f = Fixture::new(json!([
        response("herdr", &["pane", "list"], panes, 0),
        response(
            "herdr",
            &["pane", "read", "current", "--source", "visible", "--lines", "14", "--ansi"],
            "",
            0
        ),
        response("herdr", &["agent", "focus", "target"], "", 55),
        response("lsappinfo", &["front"], "token", 9),
        response(
            "lsappinfo",
            &["info", "-only", "bundleid", "token"],
            "bundleid=other.app",
            8
        )
    ]));
    let (value, output) = f.invoke("event", "");
    assert_eq!(value, json!({"ok":true,"value":true}));
    assert!(output.stderr.is_empty());
    let state: Value =
        serde_json::from_slice(&fs::read(f.root.join("state/state.json")).unwrap()).unwrap();
    let original: Value =
        serde_json::from_str(include_str!("fixtures/voice-event-state-original.json")).unwrap();
    assert_eq!(state, original["state"]);
    let expected = original["state_bytes_hex"]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|hex| u8::from_str_radix(std::str::from_utf8(hex).unwrap(), 16).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(fs::read(f.root.join("state/state.json")).unwrap(), expected);
    assert!(f
        .records()
        .iter()
        .any(|r| r["program"] == "herdr" && r["args"] == json!(["agent", "focus", "target"])));
}
