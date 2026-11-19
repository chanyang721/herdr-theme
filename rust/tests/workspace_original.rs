//! Workspace creation with optional model presets. All service operations are a refusing
//! native fixture in a scratch directory; no user app or agent is started.
use herdr_theme::automation::launch_argv;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};
struct Creation {
    _temp: tempfile::TempDir,
    root: PathBuf,
    app: PathBuf,
    tools: PathBuf,
    schema: PathBuf,
    log: PathBuf,
}
impl Creation {
    fn new(site: Value) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let app = root.join("app");
        let tools = root.join("tools");
        fs::create_dir_all(app.join("data/sixfold")).unwrap();
        fs::create_dir(&tools).unwrap();
        fs::write(app.join("data/sixfold/site.local.json"), site.to_string()).unwrap();
        for name in ["herdr-app", "hc"] {
            let name = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.to_owned()
            };
            fs::copy(
                env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
                tools.join(name),
            )
            .unwrap();
        }
        let schema = root.join("fixture.json");
        let log = root.join("calls.jsonl");
        fs::write(&schema, json!({"allowWorkspaceFocus":true}).to_string()).unwrap();
        Self {
            _temp: temp,
            root,
            app,
            tools,
            schema,
            log,
        }
    }
    fn command(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.env("HERDR_APP_HOME", &self.app)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("HC_TERMINAL_ID", "t9")
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env(
                "PATH",
                std::env::join_paths(std::iter::once(self.tools.clone()).chain(
                    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
                ))
                .unwrap(),
            );
        c
    }
    fn run(&self, extra: &[&str]) -> Output {
        self.command()
            .args(["workspace", "Example", "/project"])
            .args(extra)
            .output()
            .unwrap()
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn launches(&self) -> Vec<Value> {
        self.calls()
            .iter()
            .filter(|v| {
                v["program"] == "herdr-app" && v["args"][0] == "do" && v["args"][1] == "space.new"
            })
            .map(|v| serde_json::from_str(v["args"][2].as_str().unwrap()).unwrap())
            .collect()
    }
    fn successful(&self, extra: &[&str]) -> Vec<Value> {
        let out = self.run(extra);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!self.calls().iter().any(|v| v["args"][0] == "send"));
        let launches = self.launches();
        assert_eq!(
            launches.len(),
            1,
            "one new workspace opens one session only"
        );
        launches
    }
}
fn claude(extra: &[&str]) -> Value {
    let mut argv = vec!["claude".to_string()];
    argv.extend(extra.iter().map(|s| s.to_string()));
    json!(launch_argv(argv).unwrap())
}
#[test]
fn test_default_opens_exactly_one_plain_claude_session_and_no_splits() {
    let f = Creation::new(json!({}));
    let launches = f.successful(&[]);
    assert_eq!(launches[0]["argv"], claude(&[]));
    #[cfg(unix)]
    assert!(launches[0]["argv"]
        .as_array()
        .unwrap()
        .contains(&json!("CLAUDE_CODE_CHILD_SESSION")));
    assert!(!f.app.join("data/sixfold").read_dir().unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("space-")));
}
#[test]
fn test_shells_open_one_plain_shell() {
    let f = Creation::new(json!({}));
    let launches = f.successful(&["--shells"]);
    assert!(launches[0].get("argv").is_none());
    let f = Creation::new(json!({}));
    assert!(!f.run(&["--shells", "--model", "m"]).status.success());
    assert!(f.launches().is_empty());
}
#[test]
fn test_removed_and_malformed_options_are_refused_before_any_pane_opens() {
    for args in [
        vec!["--panes", "6"],
        vec!["--by", "t1"],
        vec!["--preset", "missing"],
        vec!["--model", "m", "--effort", "huge"],
        vec!["--effort", "high"],
        vec!["--agents", "--shells"],
    ] {
        let f = Creation::new(json!({}));
        assert!(!f.run(&args).status.success(), "{args:?}");
        assert!(f.launches().is_empty(), "{args:?}");
    }
}
#[test]
fn test_explicit_model_and_effort_are_passed_to_the_session() {
    let f = Creation::new(json!({}));
    let launches = f.successful(&["--model", "m-x", "--effort", "max"]);
    assert_eq!(
        launches[0]["argv"],
        claude(&["--model", "m-x", "--effort", "max"])
    );
}
#[test]
fn test_presets_and_the_site_default_preset() {
    let site = json!({"model_presets":{"claude":{"deep":{"model":"m-deep","effort":"high"},"quick":"m-quick"}},"new_space_preset":"deep"});
    let f = Creation::new(site.clone());
    assert_eq!(
        f.successful(&[])[0]["argv"],
        claude(&["--model", "m-deep", "--effort", "high"])
    );
    let f = Creation::new(site.clone());
    assert_eq!(
        f.successful(&["--preset", "quick"])[0]["argv"],
        claude(&["--model", "m-quick"])
    );
    let f = Creation::new(site);
    assert_eq!(
        f.successful(&["--preset", "quick", "--model", "m-x"])[0]["argv"],
        claude(&["--model", "m-x"]),
        "an explicit model wins over a preset"
    );
    let f = Creation::new(json!({"new_space_preset":"gone"}));
    let out = f.run(&[]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("new_space_preset"));
    assert_eq!(f.launches()[0]["argv"], claude(&[]));
}
#[test]
fn test_missing_positionals_are_usage_errors() {
    for args in [vec![], vec!["name"]] {
        let root = tempfile::tempdir().unwrap();
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .arg("workspace")
            .args(&args)
            .env("HOME", root.path())
            .env("HERDR_APP_HOME", root.path().join("app"))
            .env("PATH", root.path())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage: herdr-theme workspace"));
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
#[test]
fn test_duplicate_name_does_not_create_more_terminals() {
    let f = Creation::new(json!({}));
    fs::write(
        f.root.join("workspace-focus-state.json"),
        json!({"spaces":[{"name":"Example"}]}).to_string(),
    )
    .unwrap();
    assert!(!f.run(&[]).status.success());
    assert!(f.launches().is_empty());
}
