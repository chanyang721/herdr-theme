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
    let ledger = f.ok("origin", &["collaborate", "status"]);
    for task in ledger["tasks"].as_object().unwrap().values() {
        let id = task["id"].as_str().unwrap();
        let target = task["target"].as_str().unwrap();
        let token = task["lease"].as_str().unwrap();
        f.ok(target, &["collaborate", "accept", id, "--lease", token]);
        f.ok(
            target,
            &[
                "collaborate",
                "complete",
                id,
                "--lease",
                token,
                "--result",
                "12 lines",
            ],
        );
        f.ok(
            target,
            &[
                "collaborate",
                "complete",
                id,
                "--lease",
                token,
                "--result",
                "12 lines",
            ],
        );
    }
    let first = f.ok("origin", &["collaborate", "report", "--batch", "counts"]);
    let second = f.ok("origin", &["collaborate", "report", "--batch", "counts"]);
    assert_eq!(first["state"], "reported");
    assert_eq!(second["state"], "already_reported");
    assert!(second.get("text").is_none());
    let sends = f.sends();
    assert_eq!(sends.len(), 2);
    assert_ne!(sends[0]["args"][1], sends[1]["args"][1]);
    for send in sends {
        assert_eq!(send["args"][3], "--if");
        assert_eq!(send["args"][4], "idle");
        assert!(send["leases"].as_u64().unwrap() > 0);
        assert!(send["ledger"]["tasks"]
            .as_object()
            .unwrap()
            .values()
            .any(|t| t["state"] == "sending"));
    }
    assert_eq!(
        f.data("collaboration-tasks.json")["reports"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn uncertain_delivery_keeps_exclusive_leases_and_never_resends() {
    for mode in ["ambiguous", "crash", "error_success"] {
        let f = Fixture::new(false);
        f.edit(|c| c["sendMode"] = json!(mode));
        f.enqueue("count1");
        f.enqueue("count2");
        let delivered = f.ok("origin", &["collaborate", "drain"]);
        assert!(
            delivered
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["state"] == "uncertain"),
            "{mode}: {delivered}"
        );
        let before = f.sends().len();
        assert_eq!(before, 2);
        for _ in 0..3 {
            assert_eq!(f.ok("origin", &["collaborate", "drain"]), json!([]));
        }
        assert_eq!(f.sends().len(), before);
        assert_eq!(
            fs::read_dir(f.app.join("data/sixfold/collaboration-leases"))
                .unwrap()
                .count(),
            2
        );
    }
}
#[test]
fn wrong_actor_or_token_cannot_accept_and_cli_errors_are_json() {
    let f = Fixture::new(false);
    f.enqueue("count1");
    f.enqueue("count2");
    f.ok("origin", &["collaborate", "drain"]);
    let ledger = f.data("collaboration-tasks.json");
    let task = &ledger["tasks"]["count1"];
    for (actor, token) in [
        ("origin", task["lease"].as_str().unwrap()),
        (task["target"].as_str().unwrap(), "wrong-token"),
    ] {
        let out = f.run(
            actor,
            &["collaborate", "accept", "count1", "--lease", token],
        );
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stderr.is_empty());
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(!v["error"].as_str().unwrap().is_empty());
    }
    assert_eq!(
        f.data("collaboration-tasks.json")["tasks"]["count1"]["state"],
        "sent"
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
