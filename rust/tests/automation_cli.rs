//! Real native CLI/child-process/ledger tests. All hc/herdr-app invocations run a
//! native fake executable from a per-test directory; no user service is contacted.
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output, Stdio},
};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    app: PathBuf,
    tools: PathBuf,
    schema: PathBuf,
    log: PathBuf,
}
#[test]
fn collaboration_capability_probe_is_read_only_and_needs_no_identity_or_config() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("app");
    let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(["collaborate", "capabilities"])
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("HERDR_APP_HOME", &app)
        .env("LOCALAPPDATA", root.path().join("local"))
        .env("PATH", root.path())
        .env_remove("HC_TERMINAL_ID")
        .env_remove("HERDR_PANE_ID")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap(),
        json!({"harness_intake_protocol":1})
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
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
        // The former imported Python API has moved to this Rust source file.
        // Keep the oracle text intact and assert this one explicit transport
        // reference substitution; every other help/output byte stays exact.
        let expected_stdout = if command == "workspace" {
            case["stdout"]
                .as_str()
                .unwrap()
                .replace("scripts/model_tier.py", "rust/src/automation/tiers.rs")
        } else {
            case["stdout"].as_str().unwrap().to_owned()
        };
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
impl Fixture {
    fn new(route: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let tools = root.join("bin");
        let app = root.join("app");
        fs::create_dir_all(&tools).unwrap();
        fs::create_dir_all(app.join("data/sixfold")).unwrap();
        // Unsupported legacy names resolve to the refusing fixture too, so an
        // unexpected implementation command can never fall through to a real app.
        for name in ["hc", "herdr-app", "herdr-core", "herdr"] {
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
        let schema = root.join("fixture.json");
        let log = root.join("calls.jsonl");
        let fixture = Self {
            _temp: temp,
            root,
            app,
            tools,
            schema,
            log,
        };
        let config = if route {
            json!({"spaces":[{"id":"common","name":"Share","folder":"/fixture/common","tabs":[{"active":true,"terminals":[{"terminal":"s0"},{"terminal":"s1"},{"terminal":"s2"}]}]},{"id":"project","name":"Project B","folder":"/fixture/project-b","tabs":[{"active":true,"terminals":[{"terminal":"p0"},{"terminal":"p1"},{"terminal":"p2"}]}]}],"terminals":[{"address":"s2","agent":"codex","state":"live","status":"working"},{"address":"p0","agent":"claude-code","state":"live","status":"idle"},{"address":"p1","agent":"codex","state":"live","status":"idle"},{"address":"p2","agent":"codex","state":"live","status":"idle"}]})
        } else {
            json!({"spaces":[{"id":"p","name":"FixtureProject","tabs":[{"active":true,"terminals":[{"terminal":"origin"},{"terminal":"helper1"},{"terminal":"helper2"}]}]}],"terminals":[{"address":"origin","state":"live","agent":"codex","status":"idle"},{"address":"helper1","state":"live","agent":"codex","status":"idle"},{"address":"helper2","state":"live","agent":"codex","status":"idle"}]})
        };
        let mut config = config;
        config["allowCollaborationIntake"] = json!(true);
        fs::write(fixture.app.join("data/sixfold/collaboration.json"),
            json!({"harness_command":[env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),"collaboration-intake-contract"]}).to_string()).unwrap();
        fixture.write_config(&config);
        fixture
    }
    fn write_config(&self, c: &Value) {
        fs::write(&self.schema, c.to_string()).unwrap()
    }
    fn edit(&self, edit: impl FnOnce(&mut Value)) {
        let mut c = self.config();
        edit(&mut c);
        self.write_config(&c)
    }
    fn config(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.schema).unwrap()).unwrap()
    }
    fn command(&self, actor: &str, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        self.configure(&mut command, actor, args);
        command
    }
    fn configure(&self, command: &mut Command, actor: &str, args: &[&str]) {
        let path = std::env::join_paths(std::iter::once(self.tools.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .unwrap();
        command
            .args(args)
            .current_dir(&self.root)
            .env("PATH", path)
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env("HERDR_APP_HOME", &self.app)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("LOCALAPPDATA", self.root.join("local"))
            .env("HC_TERMINAL_ID", actor)
            .env_remove("HERDR_PANE_ID")
            .env_remove("HERDR_TAB_ID")
            .env_remove("HERDR_WORKSPACE_ID")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    }
    fn legacy(&self, actor: &str, args: &[&str]) -> Output {
        let python = std::env::var_os("HERDR_THEME_ORACLE_PYTHON")
            .expect("set the external baseline Python executable");
        let scripts = PathBuf::from(
            std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS")
                .expect("set external baseline scripts directory"),
        );
        let mut command = Command::new(python);
        command
            .arg("-X")
            .arg("utf8")
            .arg(scripts.join(format!("{}.py", args[0])));
        self.configure(&mut command, actor, &args[1..]);
        command.output().unwrap()
    }
    fn legacy_ok(&self, actor: &str, args: &[&str]) -> Value {
        let out = self.legacy(actor, args);
        assert!(
            out.status.success(),
            "legacy {args:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stderr.is_empty());
        if out.stdout.iter().all(u8::is_ascii_whitespace) {
            Value::Null
        } else {
            serde_json::from_slice(&out.stdout).unwrap()
        }
    }
    fn run(&self, actor: &str, args: &[&str]) -> Output {
        let out = self.command(actor, args).output().unwrap();
        out
    }
    fn ok(&self, actor: &str, args: &[&str]) -> Value {
        let out = self.run(actor, args);
        assert!(
            out.status.success(),
            "{args:?}: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(
            out.stderr.is_empty(),
            "unexpected stderr for {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        if out.stdout.iter().all(u8::is_ascii_whitespace) {
            Value::Null
        } else {
            serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
                panic!(
                    "{args:?}: invalid JSON {e}: {}",
                    String::from_utf8_lossy(&out.stdout)
                )
            })
        }
    }
    fn data(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.app.join("data/sixfold").join(name)).unwrap())
            .unwrap()
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn sends(&self) -> Vec<Value> {
        self.calls()
            .into_iter()
            .filter(|c| c["program"] == "hc" && c["args"][0] == "send")
            .collect()
    }
    fn enqueue(&self, id: &str) {
        self.ok(
            "origin",
            &[
                "collaborate",
                "enqueue",
                "--id",
                id,
                "--batch",
                "counts",
                "--mode",
                "read-only",
                "--text",
                "count fixture lines",
            ],
        );
    }
    fn original_route(&self, request: Value, candidates: bool) -> Output {
        self.edit(|config| {
            config["allowOriginalRoute"] = json!(true);
            config["dispatchRequest"] = request;
        });
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
        self.configure(&mut command, "s2", &[]);
        command
            .arg(if candidates {
                "route-candidates-contract"
            } else {
                "route-dispatch-contract"
            })
            .output()
            .unwrap()
    }
}

fn normalize(value: &Value) -> Value {
    match value {
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, v) in o {
                out.insert(
                    k.clone(),
                    if [
                        "created",
                        "at",
                        "lease",
                        "token",
                        "accepted_at",
                        "oldest_seconds",
                    ]
                    .contains(&k.as_str())
                    {
                        json!("<volatile>")
                    } else {
                        normalize(v)
                    },
                );
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
        _ => value.clone(),
    }
}
#[test]
#[ignore = "manual migration check: requires an external baseline checkout/Python, never required by the shipped runtime"]
fn external_python_and_native_cli_have_matching_protocol_receipts() {
    let n = Fixture::new(false);
    let p = Fixture::new(false);
    for id in ["count1", "count2"] {
        let args = [
            "collaborate",
            "enqueue",
            "--id",
            id,
            "--batch",
            "counts",
            "--mode",
            "read-only",
            "--text",
            "count fixture lines",
        ];
        assert_eq!(
            normalize(&n.ok("origin", &args)),
            normalize(&p.legacy_ok("origin", &args))
        );
    }
    assert_eq!(
        normalize(&n.ok("origin", &["collaborate", "drain"])),
        normalize(&p.legacy_ok("origin", &["collaborate", "drain"]))
    );
    let nl = n.ok("origin", &["collaborate", "status"]);
    let pl = p.legacy_ok("origin", &["collaborate", "status"]);
    assert_eq!(normalize(&nl), normalize(&pl));
    for id in ["count1", "count2"] {
        let nt = &nl["tasks"][id];
        let pt = &pl["tasks"][id];
        let na = nt["target"].as_str().unwrap();
        let pa = pt["target"].as_str().unwrap();
        let nl = nt["lease"].as_str().unwrap();
        let pl = pt["lease"].as_str().unwrap();
        for action in ["accept", "complete"] {
            let mut n_args = vec!["collaborate", action, id, "--lease", nl];
            let mut p_args = vec!["collaborate", action, id, "--lease", pl];
            if action == "complete" {
                n_args.extend(["--result", "12 lines"]);
                p_args.extend(["--result", "12 lines"]);
            }
            assert_eq!(
                normalize(&n.ok(na, &n_args)),
                normalize(&p.legacy_ok(pa, &p_args))
            );
        }
    }
    for _ in 0..2 {
        let args = ["collaborate", "report", "--batch", "counts"];
        assert_eq!(
            normalize(&n.ok("origin", &args)),
            normalize(&p.legacy_ok("origin", &args))
        );
    }
    assert_eq!(n.sends().len(), 2);
    assert_eq!(p.sends().len(), 2);
    let n = Fixture::new(false);
    let p = Fixture::new(false);
    for fixture in [&n, &p] {
        fixture.edit(|c| c["sendMode"] = json!("ambiguous"));
    }
    for id in ["count1", "count2"] {
        let args = [
            "collaborate",
            "enqueue",
            "--id",
            id,
            "--batch",
            "counts",
            "--mode",
            "read-only",
            "--text",
            "count fixture lines",
        ];
        n.ok("origin", &args);
        p.legacy_ok("origin", &args);
    }
    for _ in 0..3 {
        let args = ["collaborate", "drain"];
        assert_eq!(
            normalize(&n.ok("origin", &args)),
            normalize(&p.legacy_ok("origin", &args))
        );
    }
    assert_eq!(
        normalize(&n.data("collaboration-tasks.json")),
        normalize(&p.data("collaboration-tasks.json"))
    );
    assert_eq!(n.sends().len(), 2);
    assert_eq!(p.sends().len(), 2);
}
#[test]
fn persisted_two_receiver_protocol_reports_exactly_once() {
    let f = Fixture::new(false);
    f.enqueue("count1");
    f.enqueue("count2");
    let delivered = f.ok("origin", &["collaborate", "drain"]);
    assert_eq!(delivered.as_array().unwrap().len(), 2);
    assert_eq!(f.ok("origin", &["collaborate", "drain"]), json!([]));
    assert!(f.sends().is_empty());
    for task in f.data("collaboration-tasks.json")["tasks"]
        .as_object()
        .unwrap()
        .values()
    {
        assert_eq!(task["state"], "harness_managed");
        assert_eq!(
            task["harness_intake"]["result"]["parts"][0]["task_id"],
            "fixture-task"
        );
        assert!(task.get("lease").is_none());
    }
    assert_eq!(
        f.calls().iter().filter(|c| c["action"] == "drain").count(),
        2
    );
}
#[test]
fn uncertain_delivery_keeps_exclusive_leases_and_never_resends() {
    let f = Fixture::new(false);
    f.enqueue("count1");
    let mut ledger = f.data("collaboration-tasks.json");
    ledger["tasks"]["count1"]["state"] = json!("uncertain");
    ledger["tasks"]["count1"]["lease"] = json!("old-lease");
    ledger["tasks"]["count1"]
        .as_object_mut()
        .unwrap()
        .remove("harness_intake");
    fs::write(
        f.app.join("data/sixfold/collaboration-tasks.json"),
        ledger.to_string(),
    )
    .unwrap();
    for _ in 0..3 {
        f.ok("origin", &["collaborate", "drain"]);
    }
    assert!(f.sends().is_empty());
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["count1"]["state"],
        "uncertain"
    );
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["count1"]["lease"],
        "old-lease"
    );
    assert_eq!(
        f.calls().iter().filter(|c| c["action"] == "drain").count(),
        0
    );
}
#[test]
fn wrong_actor_or_token_cannot_accept_and_cli_errors_are_json() {
    let f = Fixture::new(false);
    f.enqueue("count1");
    let mut ledger = f.data("collaboration-tasks.json");
    let task = &mut ledger["tasks"]["count1"];
    task["state"] = json!("sent");
    task["target"] = json!("helper1");
    task["lease"] = json!("old-token");
    fs::write(
        f.app.join("data/sixfold/collaboration-tasks.json"),
        ledger.to_string(),
    )
    .unwrap();
    for (actor, token) in [("origin", "old-token"), ("helper1", "wrong-token")] {
        let out = f.run(
            actor,
            &["collaborate", "accept", "count1", "--lease", token],
        );
        assert_eq!(out.status.code(), Some(1));
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(value.get("error").is_some());
    }
}

#[test]
#[ignore = "requires the unchanged external Python baseline"]
fn original_cli_error_stdout_is_byte_exact() {
    let f = Fixture::new(false);
    for args in [
        vec!["collaborate", "accept", "missing", "--lease", "abc"],
        vec!["collaborate", "accept", "--lease", "abc", "missing"],
        vec!["collaborate", "accept", "missing", "--lease=abc"],
        vec![
            "collaborate",
            "accept",
            "missing",
            "--lease",
            "old",
            "--lease",
            "abc",
        ],
    ] {
        let legacy = f.legacy("origin", &args);
        let native = f.run("origin", &args);
        assert_eq!(native.status.code(), legacy.status.code(), "{args:?}");
        assert_eq!(native.stdout, legacy.stdout, "{args:?}");
        assert_eq!(native.stderr, legacy.stderr, "{args:?}");
    }
}

#[test]
#[ignore = "requires the unchanged external Python baseline"]
fn workflow_consumes_nonzero_bridge_stdout_like_original() {
    let f = Fixture::new(false);
    let herdr = f
        .tools
        .join(if cfg!(windows) { "herdr.exe" } else { "herdr" });
    fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), herdr).unwrap();
    let bridge = f
        .root
        .join("home/.local/state/herdr-sixfold/migration-map.local.json");
    fs::create_dir_all(bridge.parent().unwrap()).unwrap();
    fs::write(
        &bridge,
        json!({"panes":[{"terminal":"helper1","source":"fixture-pane"}]}).to_string(),
    )
    .unwrap();
    f.edit(|c| {
        c["allowWorkflow"] = json!(true);
        c["workflowExit"] = json!(1);
        c["workflowReply"] =
            json!({"result":{"pane":{"agent_session":{"value":"fixture-session"}}}});
        c["terminals"] =
            json!([{"address":"helper1","state":"live","agent":"claude","status":"idle"}]);
        c["get"] = json!({"helper1":{"parent":"helper1","created_ms":123}});
    });
    let original = f.legacy("origin", &["collect_workflow", "--once"]);
    assert!(original.status.success());
    assert!(
        original.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );
    let expected = fs::read(f.app.join("data/sixfold/workflow.json")).unwrap();
    fs::remove_file(f.app.join("data/sixfold/workflow.json")).unwrap();
    let native = f.run("origin", &["collect_workflow", "--once"]);
    assert_eq!(native.status.code(), original.status.code());
    assert_eq!(native.stdout, original.stdout);
    assert_eq!(native.stderr, original.stderr);
    assert_eq!(
        fs::read(f.app.join("data/sixfold/workflow.json")).unwrap(),
        expected
    );
}
#[test]
fn route_holds_are_durable_before_ambiguous_send_and_never_retry() {
    let f = Fixture::new(true);
    f.edit(|c| c["sendMode"] = json!("ambiguous"));
    let out = f.run("s2", &["route", "Project B", "fixture message"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stderr.is_empty());
    let error: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(error["error"].as_str().unwrap().contains("중복 전송"));
    let queue = f.data("routing-queue.json");
    assert_eq!(queue["requests"][0]["hold"], true);
    assert_eq!(queue["requests"][0]["text"], "fixture message");
    let sends = f.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0]["queue"]["requests"][0]["hold"], true);
    for _ in 0..2 {
        f.ok("s2", &["route", "--drain"]);
    }
    assert_eq!(f.sends().len(), 1);
}
#[test]
fn route_busy_requests_remain_retryable_then_use_same_slot() {
    let f = Fixture::new(true);
    f.edit(|c| {
        for t in c["terminals"].as_array_mut().unwrap() {
            if t["address"] != "s2" {
                t["status"] = json!("working")
            }
        }
    });
    let queued = f.ok("s2", &["route", "Project B", "fixture message"]);
    assert_eq!(queued["state"], "queued");
    let q = f.data("routing-queue.json");
    assert!(q["requests"][0].get("hold").is_none());
    assert!(f.sends().is_empty());
    f.edit(|c| {
        for t in c["terminals"].as_array_mut().unwrap() {
            if t["address"] != "s2" {
                t["status"] = json!("idle")
            }
        }
    });
    let sent = f.ok("s2", &["route", "--drain"]);
    assert_eq!(sent["state"], "sent");
    assert_eq!(f.sends()[0]["args"][1], "p2");
    assert!(f.data("routing-queue.json")["requests"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn route_removes_sent_request_before_failed_snapshot_refresh() {
    let f = Fixture::new(true);
    f.edit(|c| c["appFailAfter"] = json!(1));
    let data = f.app.join("data/sixfold/routing-queue.json");
    fs::write(&data,json!({"requests":[{"id":"fixture-request","source":"s2","project":"Project B","text":"fixture message","tier":"high"}]}).to_string()).unwrap();
    let out = f.run("s2", &["route", "--drain"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(f.data("routing-queue.json")["requests"]
        .as_array()
        .unwrap()
        .is_empty());
    f.ok("s2", &["route", "--drain"]);
    assert_eq!(f.sends().len(), 1);
}

// The following names match the pre-migration test_collaborate.py methods.
fn original_add(f: &Fixture, actor: &str, id: &str, mode: &str, owns: &str) -> Output {
    f.run(
        actor,
        &[
            "collaborate",
            "enqueue",
            "--id",
            id,
            "--batch",
            "counts",
            "--mode",
            mode,
            "--owns",
            owns,
            "--text",
            "count fixture lines",
        ],
    )
}
fn task_value(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn test_same_task_id_idempotent_and_no_source_steal() {
    let f = Fixture::new(false);
    let original = task_value(original_add(&f, "origin", "a", "read-only", ""));
    assert_eq!(
        original,
        task_value(original_add(&f, "origin", "a", "read-only", ""))
    );
    assert!(!original_add(&f, "helper1", "a", "read-only", "")
        .status
        .success());
}
#[test]
fn test_local_start_reduces_pending_and_completes_as_source() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.ok("origin", &["collaborate", "start", "a"]);
    f.ok(
        "origin",
        &["collaborate", "complete", "a", "--result", "42 lines"],
    );
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["state"],
        "completed"
    );
}
#[test]
fn test_leased_task_cannot_start_locally() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.enqueue("b");
    f.ok("origin", &["collaborate", "drain"]);
    assert!(!f
        .run("origin", &["collaborate", "start", "a"])
        .status
        .success());
}
#[test]
fn test_closed_batch_rejects_new_tasks_but_existing_id_remains_idempotent() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.ok("origin", &["collaborate", "start", "a"]);
    f.ok(
        "origin",
        &["collaborate", "complete", "a", "--result", "42 lines"],
    );
    f.ok("origin", &["collaborate", "report", "--batch", "counts"]);
    assert_eq!(
        task_value(original_add(&f, "origin", "a", "read-only", ""))["state"],
        "completed"
    );
    assert!(!original_add(&f, "origin", "b", "read-only", "")
        .status
        .success());
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn test_existing_id_cannot_move_to_another_batch() {
    let f = Fixture::new(false);
    f.enqueue("a");
    assert!(!f
        .run(
            "origin",
            &[
                "collaborate",
                "enqueue",
                "--id",
                "a",
                "--batch",
                "different",
                "--mode",
                "read-only",
                "--text",
                "count fixture lines"
            ]
        )
        .status
        .success());
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["batch"],
        "counts"
    );
}
#[test]
fn test_cli_identity_mismatch_rejected() {
    let f = Fixture::new(false);
    assert!(!f
        .run(
            "origin",
            &[
                "collaborate",
                "enqueue",
                "--id",
                "a",
                "--mode",
                "read-only",
                "--text",
                "count",
                "--from",
                "helper1"
            ]
        )
        .status
        .success());
}
#[test]
fn test_no_helper_keeps_queue_without_new_session() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.enqueue("b");
    f.edit(|c| c["intakeBlocked"] = json!(true));
    f.ok("origin", &["collaborate", "drain"]);
    assert!(f.sends().is_empty());
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["state"],
        "pending"
    );
    f.edit(|c| c["intakeBlocked"] = json!(false));
    f.ok("origin", &["collaborate", "drain"]);
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["state"],
        "harness_managed"
    );
}
#[test]
fn test_overlapping_ownership_waits_while_distinct_files_can_run() {
    let left =
        json!({"id":"a","source":"origin","space":"p","mode":"worktree","owns":"src/feature/**"});
    let mut right = json!({"id":"b","source":"origin","space":"p","mode":"worktree","owns":"src/feature/sub/file.py"});
    assert!(herdr_theme::automation::collaboration::ownership_conflict(
        &left,
        &[right.clone()]
    ));
    right["owns"] = json!("tests/test.py");
    assert!(!herdr_theme::automation::collaboration::ownership_conflict(
        &left,
        &[right]
    ));
}
#[test]
fn test_write_requires_ownership_and_message_protects_shared_checkout() {
    let f = Fixture::new(false);
    assert!(!original_add(&f, "origin", "a", "worktree", "")
        .status
        .success());
    f.ok(
        "origin",
        &[
            "collaborate",
            "enqueue",
            "--id",
            "a",
            "--text",
            "inspect",
            "--mode",
            "worktree",
            "--owns",
            "src/feature/**",
            "--repo",
            "fixture",
        ],
    );
    let call = f
        .calls()
        .into_iter()
        .find(|c| c["action"] == "enqueue")
        .unwrap();
    assert_eq!(call["request"]["owns"], "src/feature/**");
    assert_eq!(call["request"]["repo"], "fixture");
    assert!(f.sends().is_empty());
}
#[test]
fn test_corrupt_ledger_and_orphan_lease_fail_closed() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.enqueue("b");
    let lease = f.app.join("data/sixfold/collaboration-leases/a.json");
    fs::create_dir_all(lease.parent().unwrap()).unwrap();
    fs::write(lease, "{}").unwrap();
    f.ok("origin", &["collaborate", "drain"]);
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["state"],
        "pending"
    );
    assert!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["blocked_reason"]
            .as_str()
            .unwrap()
            .contains("lease")
    );
    fs::write(
        f.app.join("data/sixfold/collaboration-tasks.json"),
        "broken",
    )
    .unwrap();
    assert!(!f.run("origin", &["collaborate", "drain"]).status.success());
}
#[test]
fn test_done_list_with_raw_idle_is_delivered_guarded() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.enqueue("b");
    f.edit(|c| c["terminals"][1]["status"] = json!("done"));
    f.ok("origin", &["collaborate", "drain"]);
    assert!(f.sends().is_empty());
    assert_eq!(
        f.calls().iter().filter(|c| c["action"] == "drain").count(),
        2
    );
}
#[test]
fn test_done_without_atomic_guard_is_held() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.enqueue("b");
    f.edit(|c| c["intakeRefuse"] = json!(true));
    f.ok("origin", &["collaborate", "drain"]);
    assert!(f.sends().is_empty());
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["a"]["state"],
        "pending"
    );
}
#[test]
fn test_share_excluded_new_projects_included() {
    let f = Fixture::new(false);
    f.edit(|c| {
        c["spaces"][0]["name"] = json!("FutureProject");
        c["spaces"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"share","name":"Share","tabs":[{"terminals":[{"terminal":"s"}]}]}));
    });
    let task = task_value(original_add(&f, "origin", "a", "read-only", ""));
    assert_eq!(task["project"], "FutureProject");
    assert!(!original_add(&f, "s", "b", "read-only", "").status.success());
}
#[test]
fn test_custom_exclusions_cannot_allow_share() {
    let f = Fixture::new(false);
    f.edit(|c| {
        c["spaces"].as_array_mut().unwrap().push(
            json!({"id":"sp-share","name":"Renamed","tabs":[{"terminals":[{"terminal":"s"}]}]}),
        )
    });
    fs::write(
        f.app.join("data/sixfold/site.local.json"),
        json!({"hub_space_ids":["sp-share"]}).to_string(),
    )
    .unwrap();
    fs::write(
        f.app.join("data/sixfold/collaboration.json"),
        r#"{"exclude_spaces":[]}"#,
    )
    .unwrap();
    assert!(!original_add(&f, "s", "share-task", "read-only", "")
        .status
        .success());
}
#[test]
fn test_thresholds_each_independently_and_unknown_is_not_inferred() {
    use herdr_theme::automation::collaboration::thresholds;
    let cfg = json!({"pending_count":2,"active_count":3,"oldest_seconds":600});
    let mut tasks = vec![json!({"source":"origin","state":"pending","created":1000})];
    assert_eq!(
        thresholds(&tasks, "origin", &cfg, 1000.)["overloaded"],
        false
    );
    assert_eq!(
        thresholds(&tasks, "origin", &cfg, 1601.)["overloaded"],
        true
    );
    tasks.push(tasks[0].clone());
    assert_eq!(
        thresholds(&tasks, "origin", &cfg, 1000.)["overloaded"],
        true
    );
    let tasks = vec![json!({"source":"origin","state":"local_active"}); 3];
    assert_eq!(
        thresholds(&tasks, "origin", &cfg, 1000.)["overloaded"],
        true
    );
}
fn original_request() -> Value {
    json!({"id":"test","source":"s2","project":"Project B","text":"hi"})
}
#[test]
fn test_share_and_stable_space_id_survive_workspace_rename() {
    for (id, name) in [("common", "Share"), ("sp-share", "Renamed")] {
        let f = Fixture::new(true);
        f.edit(|c| {
            c["spaces"][0]["id"] = json!(id);
            c["spaces"][0]["name"] = json!(name);
        });
        fs::write(
            f.app.join("data/sixfold/site.local.json"),
            json!({"hub_space_ids":["sp-share"]}).to_string(),
        )
        .unwrap();
        let result = task_value(f.original_route(original_request(), true));
        assert_eq!(result[1], "p2");
    }
}
#[test]
fn test_same_position_wins_then_busy_falls_back_to_same_agent_kind() {
    let f = Fixture::new(true);
    fs::write(
        f.app.join("data/sixfold/site.local.json"),
        json!({"project_aliases":{"비":"project b"}}).to_string(),
    )
    .unwrap();
    let mut request = original_request();
    request["project"] = json!("비");
    assert_eq!(
        task_value(f.original_route(request, true)),
        json!(["Project B", "p2", ["p2", "p1", "p0"]])
    );
    f.edit(|c| c["terminals"][3]["status"] = json!("working"));
    assert_eq!(
        task_value(f.original_route(original_request(), true))[2],
        json!(["p1", "p0"])
    );
}
#[test]
fn test_all_busy_or_blocked_returns_no_target_instead_of_interrupting() {
    let f = Fixture::new(true);
    f.edit(|c| {
        for t in c["terminals"].as_array_mut().unwrap() {
            t["status"] = json!(if t["address"] == "p0" {
                "blocked"
            } else {
                "working"
            });
        }
    });
    assert_eq!(
        task_value(f.original_route(original_request(), true))[2],
        json!([])
    );
    assert_eq!(
        task_value(f.original_route(original_request(), false))["state"],
        "queued"
    );
    assert!(f.calls().is_empty());
}
#[test]
fn test_agent_became_busy_after_selection_is_never_sent_the_message() {
    let f = Fixture::new(true);
    f.edit(|c| c["get"] = json!({"p2":{"state":"live","status":{"state":"working"}}}));
    let result = task_value(f.original_route(original_request(), false));
    let sends = f.sends();
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0]["args"][1], "p1");
    assert_eq!(sends[0]["actor"], "s2");
    assert_eq!(result["fallback"], true);
}
#[test]
fn test_only_explicit_reply_requests_add_a_completion_report() {
    for reply in [false, true] {
        let f = Fixture::new(true);
        let mut request = original_request();
        request["reply"] = json!(reply);
        task_value(f.original_route(request, false));
        let sends = f.sends();
        let args = sends[0]["args"].as_array().unwrap();
        let text = args.last().unwrap().as_str().unwrap();
        assert_eq!(text.contains("한 번 회신하세요"), reply);
        assert_eq!(text.contains("진행·완료 보고는 보내지 마세요"), !reply);
    }
}
#[test]
fn test_unknown_project_or_non_common_source_is_not_guessed() {
    let f = Fixture::new(true);
    for (source, project) in [("s2", "another project"), ("p2", "Project B")] {
        let mut request = original_request();
        request["source"] = json!(source);
        request["project"] = json!(project);
        assert!(!f.original_route(request, true).status.success());
    }
}
#[test]
fn test_uncertain_send_is_not_retried_to_a_second_agent() {
    let f = Fixture::new(true);
    f.edit(|c| c["sendMode"] = json!("ambiguous"));
    assert!(!f.original_route(original_request(), false).status.success());
    assert_eq!(f.calls().len(), 3);
    assert_eq!(f.sends().len(), 1);
}
#[test]
fn test_drafts_recording_and_pending_questions_are_protected() {
    use herdr_theme::automation::routing::receiver_available;
    for text in [
        "❯ 보내지 않은 초안",
        "● REC · tap to send\n❯",
        "voice ● listening\n› Ask Codex to do anything",
        "• 이대로 진행할까요?\n\n› Ask Codex to do anything",
    ] {
        assert!(!receiver_available(text));
    }
    assert!(receiver_available(
        "• 완료했습니다.\n\n› Ask Codex to do anything"
    ));
    let f = Fixture::new(true);
    f.edit(|c| c["terminals"][3]["status"] = json!("done"));
    assert!(!task_value(f.original_route(original_request(), true))[2]
        .as_array()
        .unwrap()
        .contains(&json!("p2")));
}
#[test]
fn test_voice_and_recording_below_composer_are_protected() {
    for text in [
        "❯\nvoice ● listening",
        "❯\n● REC",
        "› Ask Codex to do anything\nvoice ● listening",
    ] {
        assert!(!herdr_theme::automation::routing::receiver_available(text));
    }
}
#[test]
fn test_claude_question_remains_protected_below_timing_lines() {
    use herdr_theme::automation::routing::receiver_available;
    for verb in ["Churned", "Brewed", "Sautéed", "Worked", "Cogitated"] {
        assert!(!receiver_available(&format!(
            "이대로 진행할까요?\n✻ {verb} for 3s done...\n❯"
        )));
    }
    assert!(receiver_available("완료했습니다.\n✻ Churned for 3s\n❯"));
}

#[test]
fn ui_timer_cannot_impersonate_origin_for_harness_dispatch() {
    let f = Fixture::new(false);
    f.enqueue("a");
    f.enqueue("b");
    let result = f.ok("helper1", &["collaborate", "drain"]);
    assert!(result[0]["reason"]
        .as_str()
        .unwrap()
        .contains("originating agent"));
    assert_eq!(
        f.calls().iter().filter(|c| c["action"] == "drain").count(),
        0
    );
    assert!(f.sends().is_empty());
}

#[test]
fn finished_harness_role_releases_area_but_missing_projection_protects_it() {
    let f = Fixture::new(false);
    for id in ["a", "b"] {
        f.ok(
            "origin",
            &[
                "collaborate",
                "enqueue",
                "--id",
                id,
                "--text",
                "inspect",
                "--mode",
                "worktree",
                "--owns",
                if id == "a" { "src/a" } else { "src/b" },
                "--repo",
                "fixture",
            ],
        );
    }
    f.ok("origin", &["collaborate", "drain"]);
    f.ok(
        "origin",
        &[
            "collaborate",
            "enqueue",
            "--id",
            "next",
            "--text",
            "inspect next",
            "--mode",
            "worktree",
            "--owns",
            "src/a",
            "--repo",
            "fixture",
        ],
    );
    assert!(!f
        .run("origin", &["collaborate", "start", "next"])
        .status
        .success());
    f.edit(|c| c["intakeSettled"] = json!(true));
    f.ok("origin", &["collaborate", "start", "next"]);
    let released = f.data("collaboration-tasks.json");
    for id in ["a", "b"] {
        assert_eq!(released["tasks"][id]["state"], "harness_released");
        assert_eq!(
            released["tasks"][id]["harness_projection"]["ownership_released"],
            true
        );
    }
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["next"]["state"],
        "local_active"
    );
    let before = f.calls().len();
    f.ok("origin", &["collaborate", "status"]);
    assert_eq!(
        f.calls().len(),
        before,
        "terminal releases need no status call"
    );
    assert_eq!(
        f.ok("origin", &["collaborate", "report", "--batch", "a"])["state"],
        "harness_managed",
        "an area release must not manufacture task completion or a new report"
    );
    assert!(f.sends().is_empty());
}

#[test]
fn collaboration_drain_waits_for_a_receiver_beyond_the_ordinary_call_deadline() {
    let f = Fixture::new(false);
    let path = f.app.join("data/sixfold/collaboration.json");
    let mut cfg: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    cfg["pending_count"] = json!(1);
    fs::write(&path, cfg.to_string()).unwrap();
    f.enqueue("slow");
    f.edit(|c| c["intakeDrainDelayMs"] = json!(31_000));
    let started = std::time::Instant::now();
    let receipt = f.ok("origin", &["collaborate", "drain"]);
    assert!(started.elapsed() >= std::time::Duration::from_secs(30));
    assert_eq!(receipt[0]["state"], "harness_managed");
    assert_eq!(receipt[0]["harness"]["state"], "handed_off");
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["slow"]["state"],
        "harness_managed"
    );
    f.ok("origin", &["collaborate", "drain"]);
    assert_eq!(
        f.calls().iter().filter(|c| c["action"] == "drain").count(),
        1,
        "a delayed successful receipt is never dispatched twice"
    );
    assert!(f.sends().is_empty());
}

#[test]
fn released_history_is_retired_before_status_and_survives_service_or_spawn_failures() {
    let f = Fixture::new(false);
    for (id, owns) in [("a", "src/a"), ("b", "src/b")] {
        f.ok(
            "origin",
            &[
                "collaborate",
                "enqueue",
                "--id",
                id,
                "--text",
                "inspect",
                "--mode",
                "worktree",
                "--owns",
                owns,
                "--repo",
                "fixture",
            ],
        );
    }
    f.ok("origin", &["collaborate", "drain"]);
    f.edit(|c| c["intakeReleasedIds"] = json!(["a"]));
    let released = f.ok("origin", &["collaborate", "status"]);
    assert_eq!(released["tasks"]["a"]["state"], "harness_released");
    assert_eq!(released["tasks"]["b"]["state"], "harness_managed");

    // Older ledgers kept released requests active. Their retained bodies would
    // exceed the Windows command-line limit if copied into a later status batch.
    let mut legacy = released.clone();
    for i in 0..256 {
        let id = format!("retired-{i}");
        let mut row = legacy["tasks"]["a"].clone();
        row["id"] = json!(id);
        row["state"] = json!("harness_managed");
        row["text"] = json!("old result ".repeat(256));
        legacy["tasks"][id] = row;
    }
    let ledger_path = f.app.join("data/sixfold/collaboration-tasks.json");
    fs::write(&ledger_path, legacy.to_string()).unwrap();
    f.edit(|c| c["intakeStatusRefuse"] = json!(true));
    let failed_status = f.ok("origin", &["collaborate", "status"]);
    let calls = f.calls();
    let status = calls
        .iter()
        .rev()
        .find(|c| c["action"] == "status")
        .unwrap();
    assert_eq!(status["request"].as_array().unwrap().len(), 1);
    assert_eq!(status["request"][0]["id"], "b");
    for (id, task) in failed_status["tasks"].as_object().unwrap() {
        if id != "b" {
            assert_eq!(task["state"], "harness_released", "{id}");
            assert_eq!(
                task["harness_projection"]["ownership_released"], true,
                "{id}"
            );
        }
    }
    assert_eq!(
        failed_status["tasks"]["b"]["harness_projection"]["ownership_released"],
        false
    );

    let config_path = f.app.join("data/sixfold/collaboration.json");
    let original_config = fs::read(&config_path).unwrap();
    fs::write(
        &config_path,
        json!({"harness_command":[f.root.join("missing-status-adapter")]}).to_string(),
    )
    .unwrap();
    let after_spawn_failure = f.ok("origin", &["collaborate", "status"]);
    assert_eq!(
        after_spawn_failure["tasks"]["a"]["state"],
        "harness_released"
    );
    assert_eq!(
        after_spawn_failure["tasks"]["a"]["harness_projection"]["ownership_released"],
        true
    );
    assert_eq!(
        f.calls().len(),
        calls.len(),
        "the missing executable was not started"
    );
    fs::write(&config_path, original_config).unwrap();

    f.ok(
        "origin",
        &[
            "collaborate",
            "enqueue",
            "--id",
            "next",
            "--text",
            "inspect next",
            "--mode",
            "worktree",
            "--owns",
            "src/a",
            "--repo",
            "fixture",
        ],
    );
    f.ok("origin", &["collaborate", "start", "next"]);
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["next"]["state"],
        "local_active"
    );
    assert_eq!(
        f.calls().iter().filter(|c| c["action"] == "drain").count(),
        2
    );
    assert!(f.sends().is_empty());
}
