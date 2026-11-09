//! Original workspace/model-tier methods. All service operations are a refusing
//! native fixture in a scratch directory; no user app or agent is started.
use herdr_theme::automation::{collaboration, launch_argv, tiers};
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
#[test]
fn test_default_opens_exactly_one_claude_session_and_no_splits() {
    let f = Creation::new(json!({}));
    let launches = f.successful(&[]);
    let argv = launches[0]["argv"].as_array().unwrap();
    let expected = launch_argv(engine_high_argv()).unwrap();
    assert_eq!(argv, &json!(expected).as_array().unwrap().clone());
    // The original extra POSIX marker assertion fails on original Windows:
    // docs/native-baseline-windows.md records that pre-existing test defect.
    #[cfg(unix)]
    assert!(argv.contains(&json!("CLAUDE_CODE_CHILD_SESSION")));
    #[cfg(windows)]
    assert_eq!(argv, &json!(engine_high_argv()).as_array().unwrap().clone());
}
/// `claude` with the flags the harness dispatch gives a high pane (engine roles.json model_tiers).
fn engine_high_argv() -> Vec<String> {
    ["claude", "--model", "claude-opus-5-5", "--effort", "high"]
        .map(String::from)
        .to_vec()
}
#[test]
fn test_shells_open_one_plain_shell() {
    let f = Creation::new(json!({}));
    let launches = f.successful(&["--shells"]);
    assert!(launches[0].get("argv").is_none());
}
#[test]
fn test_pane_count_and_multi_tier_options_are_gone() {
    for args in [
        vec!["--panes", "6"],
        vec!["--tiers", "high,mid,high,high,low,mid"],
    ] {
        let f = Creation::new(json!({}));
        assert!(!f.run(&args).status.success());
        assert!(f.launches().is_empty());
    }
}
#[test]
fn test_single_tier_is_accepted_and_invalid_one_refused() {
    let f = Creation::new(json!({}));
    assert_eq!(f.successful(&["--tiers", "low"]).len(), 1);
    let f = Creation::new(json!({}));
    assert!(!f.run(&["--tiers", "huge"]).status.success());
    assert!(f.launches().is_empty());
}
#[test]
fn test_old_six_value_site_setting_uses_first_value_with_warning() {
    let f = Creation::new(json!({"new_space_tiers":["mid","high","high","high","low","mid"]}));
    let out = f.run(&[]);
    assert!(out.status.success());
    assert_eq!(f.launches().len(), 1);
    assert!(String::from_utf8_lossy(&out.stderr).contains("new_space_tiers"));
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
#[test]
fn test_without_the_option_the_one_session_is_the_engines_explicit_high() {
    // A bare `claude` (CLI default) never proves high to dispatch, so the first pane was never
    // reused; it now carries the same model and effort flags a dispatch-opened high pane has.
    let f = Creation::new(json!({}));
    let launches = f.successful(&[]);
    assert_eq!(
        launches[0]["argv"],
        json!(launch_argv(engine_high_argv()).unwrap())
    );
    let book: Value =
        serde_json::from_slice(&fs::read(f.app.join("data/sixfold/space-tiers.json")).unwrap())
            .unwrap();
    let pane = &book["new-space"]["panes"][0];
    assert_eq!(
        (
            &pane["tier"],
            &pane["tier_used"],
            &pane["model"],
            &pane["effort"]
        ),
        (
            &json!("high"),
            &json!("high"),
            &json!("claude-opus-5-5"),
            &json!("high")
        )
    );
}
#[test]
fn test_tiers_argument_picks_the_one_sessions_model_and_is_recorded() {
    let f = Creation::new(json!({}));
    let launches = f.successful(&["--tiers", "low"]);
    let argv = launches[0]["argv"].as_array().unwrap();
    assert_eq!(
        &argv[argv.len() - 2..],
        &[json!("--model"), json!("claude-haiku-5-5")]
    );
    #[cfg(unix)]
    assert!(argv[0].as_str().unwrap().contains("env"));
    #[cfg(windows)]
    assert_eq!(argv[0], "claude");
    let book: Value =
        serde_json::from_slice(&fs::read(f.app.join("data/sixfold/space-tiers.json")).unwrap())
            .unwrap();
    let plan = &book["new-space"];
    assert_eq!(plan["by"], "t9");
    assert_eq!(
        plan["panes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["tier"].clone())
            .collect::<Vec<_>>(),
        vec![json!("low")]
    );
}
#[test]
fn test_old_six_value_site_setting_uses_only_its_first_value() {
    let f = Creation::new(json!({"new_space_tiers":["mid","low","low","low","low","low"]}));
    let launches = f.successful(&[]);
    let argv = launches[0]["argv"].as_array().unwrap();
    assert_eq!(
        &argv[argv.len() - 4..],
        &[
            json!("--model"),
            json!("claude-sonnet-5-5"),
            json!("--effort"),
            json!("medium")
        ]
    );
}
#[test]
fn test_more_than_one_tier_or_an_unknown_tier_is_refused_before_any_pane_opens() {
    assert!(tiers::pane_tier(&json!({}), Some("low,mid")).is_err());
    assert!(tiers::pane_tier(&json!({}), Some("ultra")).is_err());
}
#[test]
fn test_no_tier_is_high_and_bad_tiers_are_refused() {
    assert_eq!(tiers::tier_name(None).unwrap(), "high");
    assert_eq!(tiers::tier_name(Some(" MID ")).unwrap(), "mid");
    assert!(tiers::tier_name(Some("medium")).is_err());
}
#[test]
fn test_mapping_is_local_and_missing_tiers_move_up() {
    let table = tiers::mapping(
        &json!({"model_tiers":{"codex":{"high":"gpt-x","mid":null,"low":null},"claude":{"low":null}}}),
    );
    assert_eq!(
        tiers::model_for("codex", "low", &table).unwrap(),
        ("high".into(), json!({"model":"gpt-x","effort":null}))
    );
    assert_eq!(tiers::model_for("claude", "low", &table).unwrap().0, "mid");
    assert_eq!(
        tiers::model_for("claude", "high", &table).unwrap(),
        ("high".into(), Value::Null)
    );
}
#[test]
fn test_defaults_name_real_models_efforts_and_max_is_only_chosen() {
    let table = tiers::mapping(&json!({}));
    assert_eq!(
        tiers::model_for("codex", "low", &table).unwrap(),
        ("low".into(), json!({"model":"gpt-6-luna","effort":"low"}))
    );
    assert_eq!(
        tiers::model_for("codex", "high", &table).unwrap(),
        (
            "high".into(),
            json!({"model":"gpt-6.1-sol","effort":"high"})
        )
    );
    assert_eq!(
        tiers::model_for("codex", "max", &table).unwrap().1["model"],
        "gpt-6-astra"
    );
    assert_eq!(
        tiers::model_for(
            "claude",
            "high",
            &json!({"claude":{"max":{"model":"m","effort":null}}})
        )
        .unwrap(),
        ("high".into(), Value::Null)
    );
}
#[test]
fn test_flags_per_cli() {
    assert_eq!(
        tiers::flags(
            "claude-code",
            &json!({"model":"claude-sonnet-5-5","effort":"medium"})
        ),
        vec!["--model", "claude-sonnet-5-5", "--effort", "medium"]
    );
    assert_eq!(
        tiers::flags("codex", &json!({"model":"gpt-6-luna","effort":"low"})),
        vec!["-m", "gpt-6-luna", "-c", "model_reasoning_effort=low"]
    );
    assert!(tiers::flags("claude", &Value::Null).is_empty());
}
#[test]
fn test_session_tier_from_model_and_effort_unknown_is_high_lower_never_chosen() {
    let table = tiers::mapping(&json!({}));
    for (agent, session, want) in [
        ("claude", Value::Null, "high"),
        (
            "claude",
            json!({"model":"claude-opus-5-5","effort":"medium"}),
            "high",
        ),
        ("claude", json!("claude-haiku-5-5"), "low"),
        (
            "codex",
            json!({"model":"gpt-6.1-sol","effort":"medium"}),
            "mid",
        ),
        (
            "codex",
            json!({"model":"gpt-6.1-sol","effort":"high"}),
            "high",
        ),
        (
            "codex",
            json!({"model":"gpt-6-astra","effort":"medium"}),
            "max",
        ),
    ] {
        assert_eq!(tiers::TIERS[tiers::tier_of(agent, &session, &table)], want);
    }
    assert_eq!(tiers::rank("high", 1).unwrap(), None);
    assert_eq!(
        [
            tiers::rank("mid", 1).unwrap(),
            tiers::rank("mid", 2).unwrap()
        ],
        [Some(0), Some(1)]
    );
}
#[test]
fn test_session_models_read_the_pane_header_share() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("shared.json"),json!({"agent-usage.shares":{"terminals":{"t1":{"meta":{"agent":"claude","modelId":"claude-sonnet-5-5","effort":"medium"}},"t2":{}}}}).to_string()).unwrap();
    assert_eq!(
        tiers::session_models_at(temp.path()),
        json!({"t1":{"model":"claude-sonnet-5-5","effort":"medium"}})
    );
    assert_eq!(
        tiers::session_models_at(&temp.path().join("missing")),
        json!({})
    );
}
#[test]
fn test_collaborate_orders_same_model_then_higher_and_skips_lower() {
    let facts = json!({"a":{"agent":"claude"},"b":{"agent":"claude"},"c":{"agent":"claude"},"d":{"agent":"claude"}});
    let models = json!({"a":{"model":"claude-haiku-5-5"},"b":{"model":"claude-opus-5-5","effort":"medium"},"c":{"model":"claude-sonnet-5-5","effort":"medium"}});
    let names = vec!["a".into(), "b".into(), "c".into(), "d".into()];
    let table = tiers::mapping(&json!({}));
    assert_eq!(
        collaboration::tier_order(&names, Some("mid"), &facts, &models, &table).unwrap(),
        vec!["c", "b", "d"]
    );
    assert_eq!(
        collaboration::tier_order(&names, None, &facts, &models, &table).unwrap(),
        vec!["b", "d"]
    );
    assert_eq!(
        collaboration::tier_order(&names[..2], Some("low"), &facts, &models, &table).unwrap(),
        vec!["a", "b"]
    );
}
#[test]
fn test_route_keeps_its_old_order_without_a_tier_and_never_goes_lower() {
    let f = Creation::new(json!({"hub_space_ids":["common"]}));
    let spaces = json!([{"id":"common","name":"공통","folder":"/common","tabs":[{"active":true,"terminals":[{"terminal":"s0"},{"terminal":"s1"},{"terminal":"s2"}]}]},{"id":"project","name":"Project B","folder":"/project-b","tabs":[{"active":true,"terminals":[{"terminal":"p0"},{"terminal":"p1"},{"terminal":"p2"}]}]}]);
    let live = json!([{"address":"s2","agent":"claude","state":"live","status":"working"},{"address":"p0","agent":"claude","state":"live","status":"idle"},{"address":"p1","agent":"claude","state":"live","status":"idle"},{"address":"p2","agent":"claude","state":"live","status":"idle"}]);
    for (tier, models, want) in [
        (Value::Null, json!({}), vec!["p2", "p1", "p0"]),
        (
            json!("mid"),
            json!({"p0":{"model":"claude-sonnet-5-5","effort":"medium"},"p2":{"model":"claude-haiku-5-5"}}),
            vec!["p0", "p1"],
        ),
        (
            json!("high"),
            json!({"p0":{"model":"claude-sonnet-5-5","effort":"medium"},"p2":{"model":"claude-haiku-5-5"}}),
            vec!["p1"],
        ),
    ] {
        fs::write(&f.schema,json!({"allowOriginalRoute":true,"spaces":spaces,"terminals":live,"dispatchRequest":{"source":"s2","project":"Project B","tier":tier},"sessionModels":models,"tierMapping":tiers::mapping(&json!({}))}).to_string()).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"));
        c.arg("route-candidates-contract")
            .env("HERDR_TEST_FIXTURE", &f.schema)
            .env("HERDR_APP_HOME", &f.app);
        let out = c.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let data: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(data[2], json!(want));
    }
}
