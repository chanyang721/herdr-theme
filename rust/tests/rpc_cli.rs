//! JSON-RPC process sandbox for the real balancing CLIs. Native fake `hc connect`
//! owns its document/version entirely inside this fixture directory.
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};
// Measured from the original CPython CLI's piped stdout: TextIOWrapper writes
// CRLF on Windows and LF on POSIX. Keep this expectation independent of the
// native output helper so the regression still detects newline drift.
fn original_line(body: &str) -> String {
    format!("{body}{}", if cfg!(windows) { "\r\n" } else { "\n" })
}
fn document() -> Value {
    let cells=(1..=6).map(|i|json!({"id":format!("cell{i}"),"type":"block","size":{"px":i*10},"content":{"terminal":format!("fixture-t{i}")},"retained":{"position":i}})).collect::<Vec<_>>();
    json!({"documentMeta":{"retained":true},"spaces":[{"id":"space-a","name":"Synthetic Space","tabs":[{"id":"tab-six","name":"Six","root":{"id":"root-six","type":"row","oldRootMetadata":"source replacement deliberately drops this","children":[{"id":"left","type":"column","size":{"weight":9},"children":cells[..2]},{"id":"right","type":"column","size":{"px":47},"children":cells[2..]}]}},{"id":"tab-two","name":"Unrelated","root":{"id":"root-two","type":"row","children":[{"id":"keep1","type":"block","size":{"px":31},"content":{"terminal":"other-t1"}},{"id":"keep2","type":"block","size":{"weight":8},"content":{"terminal":"other-t2"}}]}}]},{"id":"space-b","name":"Other","tabs":[{"id":"single","name":"Single","root":{"id":"single-cell","type":"block","size":{"px":77},"content":{"terminal":"other-single"}}}]}]})
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    tools: PathBuf,
    schema: PathBuf,
    log: PathBuf,
    original: Value,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let tools = root.join("bin");
        fs::create_dir_all(&tools).unwrap();
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
        let original = document();
        fs::write(
            &schema,
            json!({"rpc":{"version":7,"document":original}}).to_string(),
        )
        .unwrap();
        Self {
            _temp: temp,
            root,
            tools,
            schema,
            log,
            original,
        }
    }
    fn configure(&self, c: &mut Command) {
        let path = std::env::join_paths(std::iter::once(self.tools.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .unwrap();
        c.current_dir(&self.root)
            .env("PATH", path)
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env("HERDR_APP_HOME", self.root.join("app"))
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("HC_TERMINAL_ID", "fixture-rpc-origin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    }
    fn run(&self, name: &str) -> Output {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.arg(name);
        self.configure(&mut c);
        c.output().unwrap()
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.root.join("rpc-state.json")).unwrap()).unwrap()
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn request(&self, request: &Value) -> Value {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
        c.args(["hc", "connect"]);
        self.configure(&mut c);
        c.stdin(Stdio::piped());
        let mut child = c.spawn().unwrap();
        writeln!(child.stdin.take().unwrap(), "{request}").unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stderr.is_empty());
        serde_json::from_slice(&out.stdout).unwrap()
    }
}
fn cells(v: &Value) -> Vec<Value> {
    if v["content"]["terminal"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        vec![v.clone()]
    } else {
        v["children"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(cells)
            .collect()
    }
}
fn assert_transport(f: &Fixture) {
    let calls = f.calls();
    assert_eq!(calls.len(), 2);
    for c in &calls {
        assert_eq!(c["program"], "hc");
        assert_eq!(c["args"], json!(["connect"]));
        assert_eq!(c["rpc"]["id"], 1);
        assert_eq!(c["rpc"]["jsonrpc"], "2.0");
        assert_eq!(c["rpc"]["params"]["name"], "herdr-app");
    }
    assert_eq!(calls[0]["rpc"]["method"], "doc.get");
    assert_eq!(calls[1]["rpc"]["method"], "doc.set");
    assert_eq!(calls[1]["rpc"]["params"]["version"], 7);
}
#[test]
fn six_cell_grid_preserves_ids_order_payload_and_unrelated_tabs() {
    let f = Fixture::new();
    let out = f.run("balance-grid");
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stderr.is_empty());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        original_line("{'balanced': ['Synthetic Space / Six'], 'version': 8}"),
        "observable Python CLI repr must be retained"
    );
    assert_transport(&f);
    let state = f.state();
    assert_eq!(state["version"], 8);
    let after = &state["value"];
    assert_eq!(after["documentMeta"], f.original["documentMeta"]);
    assert_eq!(
        after["spaces"][0]["tabs"][1],
        f.original["spaces"][0]["tabs"][1]
    );
    assert_eq!(after["spaces"][1], f.original["spaces"][1]);
    let root = &after["spaces"][0]["tabs"][0]["root"];
    assert_eq!(root["id"], "root-six");
    assert_eq!(root["type"], "column");
    let rows = root["children"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0]["id"], rows[1]["id"]);
    let original = cells(&f.original["spaces"][0]["tabs"][0]["root"]);
    let actual = cells(root);
    assert_eq!(actual.len(), 6);
    for (mut old, new) in original.into_iter().zip(actual) {
        old["size"] = json!({"weight":1});
        assert_eq!(new, old);
    }
    for row in rows {
        assert_eq!(row["type"], "row");
        assert_eq!(row["size"], json!({"weight":1}));
        assert!(row["id"].as_str().unwrap().starts_with("sf-row-"));
        assert_eq!(row["children"].as_array().unwrap().len(), 3);
    }
}
#[test]
fn core_balance_weights_every_container_without_changing_structure() {
    let f = Fixture::new();
    let out = f.run("core-api");
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stderr.is_empty());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        original_line("{'version': 8}"),
        "core_api prints the original Python repr result"
    );
    assert_transport(&f);
    let state = f.state();
    assert_eq!(state["version"], 8);
    let mut before = f.original.clone();
    fn balanced(node: &mut Value) {
        if matches!(node["type"].as_str(), Some("row" | "column")) {
            for c in node
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                c["size"] = json!({"weight":1});
            }
        }
        for c in node
            .get_mut("children")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            balanced(c)
        }
    }
    for s in before["spaces"].as_array_mut().unwrap() {
        for t in s["tabs"].as_array_mut().unwrap() {
            balanced(&mut t["root"]);
        }
    }
    assert_eq!(state["value"], before);
    for space in state["value"]["spaces"].as_array().unwrap() {
        for tab in space["tabs"].as_array().unwrap() {
            for leaf in cells(&tab["root"]) {
                assert!(
                    leaf.get("children").is_none(),
                    "balancing must preserve an absent children field"
                );
            }
        }
    }
}
#[test]
fn fixture_refuses_arbitrary_rpc_methods_and_stale_versions() {
    let f = Fixture::new();
    let get = f
        .request(&json!({"jsonrpc":"2.0","id":1,"method":"doc.get","params":{"name":"herdr-app"}}));
    assert_eq!(get["result"]["version"], 7);
    let before = f.state();
    let wrong = f.request(
        &json!({"jsonrpc":"2.0","id":2,"method":"terminal.kill","params":{"name":"herdr-app"}}),
    );
    assert_eq!(wrong["error"]["code"], -32601);
    let stale=f.request(&json!({"jsonrpc":"2.0","id":3,"method":"doc.set","params":{"name":"herdr-app","version":6,"value":f.original}}));
    assert_eq!(stale["error"]["code"], -32009);
    assert_eq!(f.state(), before);
}
#[test]
fn rejected_rpc_set_exits_nonzero_without_a_success_line() {
    let f = Fixture::new();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.schema).unwrap()).unwrap();
    config["rpc"]["rejectSet"] = json!(true);
    fs::write(&f.schema, config.to_string()).unwrap();
    let out = f.run("balance-grid");
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(!out.stderr.is_empty());
    assert_eq!(f.state()["version"], 7);
    assert_eq!(f.state()["value"], f.original);
}
#[test]
fn optional_container_keys_are_preserved_when_absent() {
    for name in ["core-api", "balance-grid"] {
        for original in [
            json!({"documentMeta":{"retained":true}}),
            json!({"spaces":[{"id":"untabbed","retained":true}]}),
        ] {
            let f = Fixture::new();
            let mut config: Value = serde_json::from_slice(&fs::read(&f.schema).unwrap()).unwrap();
            config["rpc"]["document"] = original.clone();
            fs::write(&f.schema, config.to_string()).unwrap();
            let out = f.run(name);
            assert_eq!(out.status.code(), Some(0));
            assert!(out.stderr.is_empty());
            assert_eq!(
                f.state()["value"],
                original,
                "{name} must not insert null for an absent optional key"
            );
        }
    }
}
fn normalize_rows(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, v) in o {
                out.insert(
                    k.clone(),
                    if k == "id" && v.as_str().is_some_and(|s| s.starts_with("sf-row-")) {
                        json!("<generated-row>")
                    } else {
                        normalize_rows(v)
                    },
                );
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(normalize_rows).collect()),
        _ => v.clone(),
    }
}
#[test]
#[ignore = "manual migration comparison needs an external original Python checkout/executable"]
fn external_python_rpc_clis_match_native_stdout_and_document() {
    let python =
        std::env::var_os("HERDR_THEME_ORACLE_PYTHON").expect("external baseline Python required");
    let scripts = PathBuf::from(
        std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS").expect("external baseline scripts required"),
    );
    for (name, script) in [
        ("core-api", "core_api.py"),
        ("balance-grid", "balance_grid.py"),
    ] {
        let n = Fixture::new();
        let p = Fixture::new();
        let native = n.run(name);
        let mut c = Command::new(&python);
        c.args(["-X", "utf8"]).arg(scripts.join(script));
        p.configure(&mut c);
        let original = c.output().unwrap();
        assert_eq!(native.status.code(), original.status.code());
        assert_eq!(native.stdout, original.stdout, "stdout drift for {name}");
        assert_eq!(native.stderr, original.stderr);
        assert_eq!(
            normalize_rows(&n.state()),
            normalize_rows(&p.state()),
            "document drift for {name}"
        );
    }
}
