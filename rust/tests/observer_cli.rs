//! Actual observer CLI/report/park/recheck state-machine tests against strictly
//! fixture-owned process, transcript, app/core and harness evidence.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};
const SID: &str = "11111111-2222-3333-4444-555555555555";
#[test]
fn space_observer_non_help_args_still_require_explicit_fixed_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("empty-config.json");
    fs::write(&config, "{}").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(["close-finished-spaces", "--dry-run", "--config"])
        .arg(config)
        .env("HERDR_APP_HOME", temp.path().join("app"))
        .env("HOME", temp.path().join("home"))
        .env("USERPROFILE", temp.path().join("home"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(
        out.stdout.is_empty(),
        "normal runtime arguments must not trigger help"
    );
    assert!(String::from_utf8_lossy(&out.stderr)
        .contains("explicit fixed workspace configuration required"));
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    tools: PathBuf,
    schema: PathBuf,
    config: PathBuf,
    state: PathBuf,
    log: PathBuf,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let tools = root.join("bin");
        fs::create_dir_all(&tools).unwrap();
        fs::create_dir_all(root.join("workspace")).unwrap();
        for name in ["hc", "herdr-app", "herdr-core", "herdr", "ps", "lsof"] {
            let name = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            };
            fs::copy(
                env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
                tools.join(name),
            )
            .unwrap();
        }
        let stamp = ((now() - 3600.) * 1000.) as i64;
        let target = json!({"address":"fixture-target","state":"live","pid":100,"created_ms":1000,"reported":true,"status":{"app":"codex","state":"done"},"status_ms":stamp,"turn":1,"title":"Synthetic observer target","cwd":root.join("workspace").to_string_lossy(),"argv":["zsh","-l"],"labels":{},"foreground":{"pid":101,"argv":["codex"],"name":"codex"}});
        let mut keep = target.clone();
        keep["address"] = json!("fixture-keep");
        keep["pid"] = json!(200);
        keep["foreground"]["pid"] = json!(201);
        keep["status"]["state"] = json!("working");
        let mut current = keep.clone();
        current["address"] = json!("fixture-current");
        current["pid"] = json!(300);
        current["foreground"]["pid"] = json!(301);
        let rollout = root.join("rollout-fixture.jsonl");
        fs::write(
            &rollout,
            format!(
                "{}\n{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":SID}}),
                json!({"type":"event_msg","payload":{"type":"task_started"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete"}})
            ),
        )
        .unwrap();
        let rollout = rollout.to_string_lossy().replace('\\', "/");
        let db = root.join("codex.sqlite");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT);CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT);").unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES(?1,?2)",
                rusqlite::params![SID, rollout],
            )
            .unwrap();
        drop(connection);
        let schema = root.join("fixture.json");
        let log = root.join("calls.jsonl");
        fs::write(&schema,json!({"allowObserver":true,"observerScenario":scenario,"observerRollout":rollout,"observerStatus":{"space":"current","tab":"current-tab","focused_pane":"current-pane","errors":[]},"observerProcesses":[{"pid":100,"parent":1,"name":"zsh","args":"zsh"},{"pid":101,"parent":100,"name":"codex","args":"codex"},{"pid":200,"parent":1,"name":"zsh","args":"zsh"},{"pid":201,"parent":200,"name":"codex","args":"codex"},{"pid":300,"parent":1,"name":"zsh","args":"zsh"},{"pid":301,"parent":300,"name":"codex","args":"codex"}],"spaces":[{"id":"current","name":"Share","machine":null,"active":true,"tabs":[{"id":"current-tab","terminals":[{"terminal":"fixture-current","pane":"current-pane"}]}]},{"id":"fixture-space","name":"Fixture Project","machine":null,"active":false,"tabs":[{"id":"fixture-tab","terminals":[{"terminal":"fixture-target","pane":"target-pane"},{"terminal":"fixture-keep","pane":"keep-pane"}]}]}],"terminals":[target,keep,current],"get":{"fixture-target":target,"fixture-keep":keep,"fixture-current":current}}).to_string()).unwrap();
        let binary = env!("CARGO_BIN_EXE_herdr-theme");
        let observer_hash = herdr_theme::observers::hash(fs::read(binary).unwrap());
        let config = root.join("observer.json");
        fs::write(&config,json!({"idle_seconds":300,"user_approved_apply":true,"reviewed_observer_sha256":observer_hash,"codex_db":db.to_string_lossy(),"harness":{"command":[env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),"observer-harness"]},"close_report":{"enabled":true,"timeout_seconds":0,"settle_seconds":0},"sessions":{"fixture-target":{"pid":100,"created_ms":1000,"agent":"codex","process_pid":101,"session_id":SID}}}).to_string()).unwrap();
        let state = root.join("observer-state.json");
        Self {
            _temp: temp,
            root,
            tools,
            schema,
            config,
            state,
            log,
        }
    }
    fn run(&self, apply: bool) -> Value {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.arg("sleep-idle-sessions")
            .arg(if apply { "--apply" } else { "--dry-run" })
            .arg("--config")
            .arg(&self.config)
            .arg("--state")
            .arg(&self.state)
            .arg("--log")
            .arg(self.root.join("observer-log.jsonl"))
            .arg("--data")
            .arg(self.root.join("sleep-data"));
        let path = std::env::join_paths(std::iter::once(self.tools.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .unwrap();
        let out = c
            .current_dir(&self.root)
            .env("PATH", path)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("HERDR_APP_HOME", self.root.join("app"))
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env("HC_TERMINAL_ID", "fixture-observer-origin")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(0),
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stderr.is_empty());
        let v: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|error| {
            panic!(
                "observer runtime must emit JSON, not help: {error}; stdout={}",
                String::from_utf8_lossy(&out.stdout)
            )
        });
        assert!(v.get("error").is_none(), "{v}");
        assert!(v.get("skipped").is_none(), "{v}");
        v
    }
    fn ready(&self) {
        self.run(false);
        let mut state: Value = serde_json::from_slice(&fs::read(&self.state).unwrap()).unwrap();
        assert!(
            state["sessions"]["fixture-target"]["fingerprint"].is_string(),
            "target was not safe on initial dry run: {state}"
        );
        state["last_at"] = json!(now() - 300.);
        state["sessions"]["fixture-target"]["since"] = json!(now() - 1200.);
        state["trial"]["samples"] = json!(1);
        state["trial"]["error_count"] = json!(0);
        fs::write(&self.state, state.to_string()).unwrap();
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn assert_no_close_or_exit(&self) {
        let calls = self.calls();
        assert!(!calls
            .iter()
            .any(|c| c["program"] == "herdr-app" && c["args"][0] == "do"));
        assert!(!calls
            .iter()
            .any(|c| c["program"] == "hc" && c["args"][0] == "keys"));
    }
}
fn target(v: &Value) -> &Value {
    v["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["address"] == "fixture-target")
        .unwrap()
}
#[test]
fn missing_harness_close_report_keeps_agent_and_never_closes() {
    let f = Fixture::new("missing-report");
    f.ready();
    let first = f.run(true);
    assert_eq!(target(&first)["action"], "report_requested");
    let second = f.run(true);
    assert_eq!(target(&second)["action"], "keep");
    assert!(target(&second)["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r.as_str().unwrap_or("").contains("fail-closed")));
    f.assert_no_close_or_exit();
    let asks = f
        .calls()
        .into_iter()
        .filter(|c| c["program"] == "hc" && c["args"][0] == "send")
        .collect::<Vec<_>>();
    assert_eq!(asks.len(), 1);
    assert!(asks[0]["args"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap()
        .contains("[세션 정리 보고 요청]"));
}
#[test]
fn work_starting_during_park_is_rechecked_and_close_aborted() {
    recheck_refuses("working-after-park");
}
#[test]
fn process_identity_changing_during_park_is_rechecked_and_close_aborted() {
    recheck_refuses("identity-after-park");
}
fn recheck_refuses(scenario: &str) {
    let f = Fixture::new(scenario);
    f.ready();
    let out = f.run(true);
    assert_eq!(target(&out)["action"], "keep");
    assert!(
        target(&out)["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r.as_str().unwrap_or("").contains("recheck before close")),
        "{out}"
    );
    f.assert_no_close_or_exit();
    let parks = f
        .calls()
        .into_iter()
        .filter(|c| c["program"] == "observer-harness" && c["args"][0] == "park")
        .map(|c| {
            let args = c["args"].as_array().unwrap();
            let i = args.iter().position(|a| a == "--event").unwrap();
            args[i + 1].as_str().unwrap().to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(parks, vec!["close_requested", "close_aborted"]);
}
