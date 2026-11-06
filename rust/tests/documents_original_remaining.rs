//! Remaining existing catalog and seed filesystem/CLI assertions.
use herdr_theme::documents::{common::*, pins};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
struct Catalog {
    _temp: tempfile::TempDir,
    root: PathBuf,
    docs: PathBuf,
    app: PathBuf,
    config: Value,
}
impl Catalog {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = resolved(temp.path());
        let docs = root.join("docs");
        let app = root.join("app");
        Self {
            _temp: temp,
            root,
            docs: docs.clone(),
            app,
            config: json!({"version":1,"spaces":{"sp1":{"name":"Demo","folders":[docs],"pins":[]}}}),
        }
    }
    fn file(&self, name: &str) {
        let path = self.docs.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "본문").unwrap();
    }
    fn view(&self) -> Value {
        pins::catalog(
            &self.config,
            "sp1",
            chrono::NaiveDate::from_ymd_opt(2026, 11, 4).unwrap(),
            &self.app,
            &json!({}),
        )
        .unwrap()
    }
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut output = BTreeMap::new();
    if !root.exists() {
        return output;
    }
    for e in fs::read_dir(root).unwrap() {
        let path = e.unwrap().path();
        if path.is_file() {
            output.insert(path.clone(), fs::read(path).unwrap());
        } else if path.is_dir() {
            output.extend(snapshot(&path));
        }
    }
    output
}
#[test]
fn test_reading_the_catalog_changes_no_file() {
    let f = Catalog::new();
    f.file("20261104_회신.md");
    let before = snapshot(&f.root);
    f.view();
    assert_eq!(snapshot(&f.root), before);
}
#[test]
fn test_kinds_come_from_folder_then_name_and_local_rules_replace_defaults() {
    let mut f = Catalog::new();
    for name in [
        "adr/0015-shared-queue-status.md",
        "20261104_계정목록.md",
        "20261104_무언가.md",
    ] {
        f.file(name);
    }
    let view = f.view();
    let kind = |name: &str| {
        view["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == name)
            .unwrap()["kind"]
            .clone()
    };
    assert_eq!(kind("0015-shared-queue-status.md"), "decision");
    assert_eq!(kind("20261104_계정목록.md"), "account");
    assert_eq!(kind("20261104_무언가.md"), "other");
    f.config["classify"] = json!({"kinds":[{"id":"misc","label":"잡무","terms":["무언가"]}]});
    let view = f.view();
    assert_eq!(
        view["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == "20261104_무언가.md")
            .unwrap()["kind"],
        "misc"
    );
    assert_eq!(
        view["kinds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!("misc"), json!("other")]
    );
}
struct Seed {
    _temp: tempfile::TempDir,
    root: PathBuf,
    app: PathBuf,
    tool: PathBuf,
    schema: PathBuf,
    log: PathBuf,
}
impl Seed {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let app = root.join("app");
        fs::create_dir_all(app.join("data/sixfold")).unwrap();
        fs::write(
            app.join("data/sixfold/site.local.json"),
            json!({"fixed_space_names":["Share","Project A","Project B"]}).to_string(),
        )
        .unwrap();
        let tool = root.join(if cfg!(windows) {
            "herdr-app.exe"
        } else {
            "herdr-app"
        });
        fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), &tool).unwrap();
        let schema = root.join("fixture.json");
        fs::write(&schema,json!({"allowWorkspaceSeed":true,"originalSeedIds":true,"spaces":[{"id":"remote-share","name":"Share","machine":"remote"},{"id":"local-share","name":"Share","machine":null}],"seedStatus":{"space":"local-share","focused_pane":"pane-original"}}).to_string()).unwrap();
        let log = root.join("calls.jsonl");
        Self {
            _temp: temp,
            root,
            app,
            tool,
            schema,
            log,
        }
    }
    fn target(&self) -> PathBuf {
        self.app.join("data/sixfold/workspace-pins.local.json")
    }
    fn run(&self, ensure: bool) -> Output {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.arg("seed_workspace_pins");
        if ensure {
            c.arg("--ensure-spaces");
        }
        c.env("HERDR_APP_HOME", &self.app)
            .env("HERDR_APP_BIN", &self.tool)
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .output()
            .unwrap()
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["args"].clone())
            .collect()
    }
}
#[test]
fn test_first_seed_creates_only_missing_local_spaces_then_second_run_is_read_only() {
    let f = Seed::new();
    let out = f.run(true);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let before = f.calls();
    assert!(f.run(true).status.success());
    assert_eq!(f.calls(), before);
    let data: Value = serde_json::from_slice(&fs::read(f.target()).unwrap()).unwrap();
    assert_eq!(
        data,
        json!({"spaces":[{"id":"local-share","machine":null},{"id":"generated-Project A","machine":null},{"id":"generated-Project B","machine":null}]})
    );
    assert_eq!(
        before
            .iter()
            .filter(|c| c[0] == "do" && c[1] == "space.new")
            .count(),
        2
    );
    assert_eq!(
        before
            .iter()
            .filter(|c| c[0] == "do" && c[1] == "pane.focus")
            .cloned()
            .collect::<Vec<_>>(),
        vec![json!(["do", "pane.focus", "--pane", "pane-original"]); 2]
    );
}
#[test]
fn test_existing_manual_configuration_is_preserved_without_contacting_app() {
    let f = Seed::new();
    fs::write(f.target(), "manual even if invalid JSON").unwrap();
    assert!(f.run(true).status.success());
    assert!(f.calls().is_empty());
    assert_eq!(
        fs::read_to_string(f.target()).unwrap(),
        "manual even if invalid JSON"
    );
}
#[test]
fn test_missing_space_without_ensure_does_not_write_partial_configuration() {
    let f = Seed::new();
    let out = f.run(false);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("Project A"));
    assert!(!f.target().exists());
    assert!(!f.calls().iter().any(|c| c[0] == "do"));
}
