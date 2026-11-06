//! Native versions of InstallTests in the original test_space_cleanup_install.py.
//! Python helper paths become the native executable; approval and service
//! behavior retain the original assertions. No real launchd service is used.
use herdr_theme::documents::{common::*, install, observers};
use serde_json::{json, Value};
use std::{ffi::OsString, fs, path::PathBuf};

struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    source: PathBuf,
    log: PathBuf,
    previous: Vec<(&'static str, Option<OsString>)>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source = root.path().join("source");
        fs::create_dir_all(source.join("config")).unwrap();
        atomic_json(source.join("config/close-finished-spaces.example.json"),
            &json!({"fixed_names":["Share"],"fixed_spaces":[],"idle_seconds":600,"trial_seconds":1800})).unwrap();
        let bin = root.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
            bin.join(format!("launchctl{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();
        let config = root.path().join("fixture.json");
        let log = root.path().join("calls.jsonl");
        atomic_json(&config, &json!({"allowObserverInstall":true,"home":home})).unwrap();
        let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )))
        .unwrap();
        let mut previous = vec![];
        for (key, value) in [
            ("PATH", path),
            ("HERDR_TEST_FIXTURE", config.into_os_string()),
            ("HERDR_TEST_CALL_LOG", log.clone().into_os_string()),
        ] {
            previous.push((key, std::env::var_os(key)));
            std::env::set_var(key, value);
        }
        Self {
            _root: root,
            home,
            source,
            log,
            previous,
        }
    }
    fn base(&self) -> PathBuf {
        self.home.join("Library/Application Support/HerdrSixfold")
    }
    fn install(&self, apply: bool, approved: bool, execute: bool) -> Result<Value> {
        observers::install_observer_with_clock(
            &self.home,
            &self.source,
            observers::CLEANUP,
            apply,
            approved,
            execute,
            &|| 2000.,
        )
    }
    fn state(&self, value: &Value) {
        atomic_json(self.base().join("close-finished-spaces-state.json"), value).unwrap();
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn registered(&self) {
        fs::create_dir_all(self.base()).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
            self.base().join(install::native_name()),
        )
        .unwrap();
        let config = self._root.path().join("fixture.json");
        let mut value = read_json(&config).unwrap();
        value["nativeSourceHashes"] = json!({"cleanup":"b".repeat(64),"sleep":"c".repeat(64)});
        atomic_json(config, &value).unwrap();
        for spec in [observers::CLEANUP, observers::SLEEP] {
            let value = json!({"Label":spec.job,"ProgramArguments":[self.base().join(install::native_name()),spec.command,"--dry-run"],"WorkingDirectory":self.base()});
            let value: plist::Value = serde_json::from_value(value).unwrap();
            let path = self
                .home
                .join("Library/LaunchAgents")
                .join(format!("local.herdr-sixfold.{}.plist", spec.job));
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            value.to_file_xml(path).unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for (key, value) in self.previous.iter().rev() {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}
#[test]
fn test_plan_has_no_side_effects_and_defaults_to_dry_run() {
    let f = Fixture::new();
    let plan = f.install(false, false, false).unwrap();
    assert_eq!(plan["mode"], "--dry-run");
    assert!(!f.home.exists());
    assert!(f.calls().is_empty());
}
#[test]
fn test_registers_only_dry_run_and_is_idempotent() {
    let f = Fixture::new();
    let first = f.install(false, false, true).unwrap();
    let path = PathBuf::from(first["plist"].as_str().unwrap());
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    let second = f.install(false, false, true).unwrap();
    assert_eq!(second["loaded"], true);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    let value = plist::Value::from_file(path).unwrap();
    let doc = value.as_dictionary().unwrap();
    assert_eq!(doc["StartInterval"].as_unsigned_integer(), Some(300));
    let args = doc["ProgramArguments"].as_array().unwrap();
    assert!(args.iter().any(|v| v.as_string() == Some("--dry-run")));
    assert!(!args.iter().any(|v| v.as_string() == Some("--apply")));
    assert!(!doc.contains_key("KeepAlive"));
    for action in ["bootstrap", "kickstart"] {
        assert_eq!(
            f.calls()
                .iter()
                .filter(|call| call["args"][0] == action)
                .count(),
            1
        );
    }
    assert!(
        !f.home.join(".config/herdr-app").exists(),
        "the observer installer never writes app files"
    );
}
#[test]
fn test_imported_helpers_are_bundled_outside_the_reviewed_hash() {
    let f = Fixture::new();
    let before = f.install(false, false, false).unwrap();
    let installed = f.install(false, false, true).unwrap();
    assert!(PathBuf::from(installed["script"].as_str().unwrap()).is_file());
    assert_eq!(installed["observer_sha256"], before["observer_sha256"]);
    assert!(!f.base().join("file_lock.py").exists());
    assert!(!f.base().join("agent_env.py").exists());
    assert_eq!(
        PathBuf::from(installed["script"].as_str().unwrap())
            .file_name()
            .unwrap(),
        install::native_name()
    );
}
#[test]
fn test_existing_settings_are_preserved() {
    let f = Fixture::new();
    let existing = json!({"fixed_names":["Custom"],"fixed_spaces":[{"id":"stable"}],"notify_terminal":"local-review"});
    let path = f.base().join("close-finished-spaces.json");
    atomic_json(&path, &existing).unwrap();
    f.install(false, false, true).unwrap();
    assert_eq!(read_json(path).unwrap(), existing);
}
#[test]
fn test_apply_refuses_missing_or_unobserved_trial() {
    let f = Fixture::new();
    f.state(&json!({"trial":{"started_at":0,"samples":7}}));
    assert!(f.install(true, false, true).is_err());
    assert!(!f.home.join("Library/LaunchAgents").exists());
    assert!(f.calls().is_empty());
}
#[test]
fn test_apply_switch_requires_current_code_and_finished_review_window() {
    let f = Fixture::new();
    let code = observers::source_hash(observers::CLEANUP);
    f.state(&json!({"observer_sha256":code,"last_at":2000,"trial":{"started_at":0,"samples":7,"error_count":0}}));
    let installed = f.install(true, false, true).unwrap();
    let value = plist::Value::from_file(installed["plist"].as_str().unwrap()).unwrap();
    assert!(value.as_dictionary().unwrap()["ProgramArguments"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_string() == Some("--apply")));
    let config = read_json(f.base().join("close-finished-spaces.json")).unwrap();
    assert_eq!(config["reviewed_dry_run_at"], 2000.);
    assert_eq!(config["reviewed_observer_sha256"], code);
}
#[test]
fn test_user_approved_apply_needs_one_recorded_dry_run_of_the_current_code() {
    let f = Fixture::new();
    let code = observers::source_hash(observers::CLEANUP);
    let mut state = json!({"observer_sha256":"older","last_at":2000,"trial":{"started_at":1900,"samples":1,"error_count":0}});
    f.state(&state);
    assert!(f.install(true, true, true).is_err());
    state["observer_sha256"] = json!(code);
    f.state(&state);
    let installed = f.install(true, true, true).unwrap();
    assert_eq!(installed["mode"], "--apply");
    let config = read_json(f.base().join("close-finished-spaces.json")).unwrap();
    assert_eq!(config["user_approved_apply"], true);
    assert_eq!(config["reviewed_observer_sha256"], code);
}
#[test]
fn test_external_adapter_location_comes_from_its_local_config() {
    let f = Fixture::new();
    let repo = f._root.path().join("external-adapter");
    fs::create_dir_all(repo.join("runtime")).unwrap();
    fs::write(repo.join("runtime/harness.py"), b"").unwrap();
    atomic_json(
        f.home
            .join(".config/herdr-app/data/sixfold/harness-local/config.json"),
        &json!({"repo_path":repo}),
    )
    .unwrap();
    let plan = f.install(false, false, false).unwrap();
    assert_eq!(plan["harness"], true);
    f.install(false, false, true).unwrap();
    let config = read_json(f.base().join("close-finished-spaces.json")).unwrap();
    assert_eq!(
        config["harness"]["script"],
        json!(repo.join("runtime/harness.py"))
    );
}
#[test]
fn test_copies_match_the_source_and_an_approval_for_the_replaced_copy_does_not_carry_over() {
    let f = Fixture::new();
    f.registered();
    let old = "b".repeat(64);
    atomic_json(
        f.base().join("close-finished-spaces.json"),
        &json!({"user_approved_apply":true,"reviewed_observer_sha256":old}),
    )
    .unwrap();
    let result = observers::refresh_with_review(
        &f.home,
        &f.source,
        &|_, _| json!({"ok":false,"why":"no review in this fixture"}),
    )
    .unwrap();
    assert_eq!(
        fs::read(f.base().join(install::native_name())).unwrap(),
        fs::read(std::env::current_exe().unwrap()).unwrap()
    );
    assert_eq!(
        result["observers"]["close-finished-spaces"]["approved_for_this_copy"],
        false
    );
    assert_eq!(
        read_json(f.base().join("close-finished-spaces.json")).unwrap()["reviewed_observer_sha256"],
        old
    );
}
#[test]
fn test_an_approval_for_other_code_is_not_kept_for_this_copy() {
    let f = Fixture::new();
    f.registered();
    let path = f.base().join("close-finished-spaces.json");
    atomic_json(
        &path,
        &json!({"user_approved_apply":true,"reviewed_observer_sha256":"someone-elses-hash"}),
    )
    .unwrap();
    let result = observers::refresh_with_review(
        &f.home,
        &f.source,
        &|_, _| json!({"ok":false,"why":"no review"}),
    )
    .unwrap();
    assert_eq!(
        result["observers"]["close-finished-spaces"]["approved_for_this_copy"],
        false
    );
    assert_eq!(
        read_json(path).unwrap()["reviewed_observer_sha256"],
        "someone-elses-hash"
    );
}
// Added by the latest Python installer tests. These supersede the earlier
// approval-carry behavior rather than changing an expectation to fit Rust.
fn carried_fixture(f: &Fixture) -> String {
    f.registered();
    let current = observers::source_hash(observers::CLEANUP).to_owned();
    atomic_json(
        f.base().join("close-finished-spaces.json"),
        &json!({
            "user_approved_apply":true,
            "reviewed_observer_sha256":current,
            "reviewed_by_policy":{"observer_sha256":"older-copy","verdict_id":"older-verdict"}
        }),
    )
    .unwrap();
    current
}
#[test]
fn test_is_judged_again_and_recorded_when_the_review_allows() {
    let f = Fixture::new();
    let current = carried_fixture(&f);
    let result = observers::refresh_with_review(
        &f.home,
        &f.source,
        &|_, _| json!({"ok":true,"value":"CONDITIONAL","why":"CONDITIONAL: only install/live checks remain","verdict_id":"current-verdict"}),
    )
    .unwrap();
    let config = read_json(f.base().join("close-finished-spaces.json")).unwrap();
    assert_eq!(
        result["observers"]["close-finished-spaces"]["approved_for_this_copy"],
        true
    );
    assert_eq!(config["reviewed_observer_sha256"], current);
    assert_eq!(config["reviewed_by_policy"]["observer_sha256"], current);
    assert_eq!(config["reviewed_by_policy"]["value"], "CONDITIONAL");
    assert_eq!(
        config["reviewed_by_policy"]["verdict_id"],
        "current-verdict"
    );
}
#[test]
fn test_is_withdrawn_when_the_review_does_not_allow() {
    let f = Fixture::new();
    carried_fixture(&f);
    let result = observers::refresh_with_review(
        &f.home,
        &f.source,
        &|_, _| json!({"ok":false,"value":"HOLD"}),
    )
    .unwrap();
    assert_eq!(
        result["observers"]["close-finished-spaces"]["approved_for_this_copy"],
        false
    );
    assert_eq!(
        read_json(f.base().join("close-finished-spaces.json")).unwrap()["reviewed_observer_sha256"],
        "older-copy"
    );
}
#[test]
fn test_nothing_is_written_when_no_observer_is_registered() {
    let f = Fixture::new();
    let marker = f.base().join("agent_sessions.py");
    fs::create_dir_all(f.base()).unwrap();
    fs::write(&marker, b"# old agent_sessions.py\n").unwrap();
    assert_eq!(
        observers::refresh_with_review(&f.home, &f.source, &|_, _| panic!(
            "no registered observer needs no review"
        ))
        .unwrap()["refreshed"],
        json!([])
    );
    assert_eq!(fs::read(marker).unwrap(), b"# old agent_sessions.py\n");
}
#[test]
fn test_refresh_records_the_policy_approval_for_both_observers() {
    let f = Fixture::new();
    f.registered();
    for spec in [observers::CLEANUP, observers::SLEEP] {
        atomic_json(
            f.base().join(spec.config),
            &json!({"user_approved_apply":true,"reviewed_observer_sha256":"old"}),
        )
        .unwrap();
    }
    let result=observers::refresh_with_review(&f.home,&f.source,&|_,_|json!({"ok":true,"commit":"fixture-commit","verdict_id":"fixture-verdict","value":"CONDITIONAL","review_file":"fixture-review.md","report_id":"fixture-report"})).unwrap();
    for spec in [observers::CLEANUP, observers::SLEEP] {
        let config = read_json(f.base().join(spec.config)).unwrap();
        assert_eq!(
            result["observers"][spec.job]["approved_for_this_copy"],
            true
        );
        assert_eq!(
            config["reviewed_observer_sha256"],
            result["observers"][spec.job]["observer_sha256"]
        );
        assert_eq!(config["reviewed_by_policy"]["actor"], "auto-policy");
        assert_eq!(
            config["reviewed_by_policy"]["verdict_id"],
            "fixture-verdict"
        );
        assert_eq!(config["reviewed_by_policy"]["commit"], "fixture-commit");
        assert!(config["reviewed_by_policy"]["review_file"]
            .as_str()
            .unwrap()
            .ends_with(".md"));
    }
}
#[test]
fn test_refresh_without_an_allowing_review_installs_but_does_not_approve() {
    for why in ["verdict HOLD", "source scripts have uncommitted changes"] {
        let f = Fixture::new();
        f.registered();
        let path = f.base().join("close-finished-spaces.json");
        atomic_json(
            &path,
            &json!({"user_approved_apply":true,"reviewed_observer_sha256":"someone-elses-hash"}),
        )
        .unwrap();
        let result = observers::refresh_with_review(
            &f.home,
            &f.source,
            &|_, _| json!({"ok":false,"why":why}),
        )
        .unwrap();
        assert_eq!(
            result["observers"]["close-finished-spaces"]["approved_for_this_copy"],
            false
        );
        let config = read_json(path).unwrap();
        assert_eq!(config["reviewed_observer_sha256"], "someone-elses-hash");
        assert!(config.get("reviewed_by_policy").is_none());
    }
}
#[test]
fn test_registers_its_own_label_in_dry_run_with_the_stub() {
    let f = Fixture::new();
    atomic_json(
        f.source.join("config/sleep-idle-sessions.example.json"),
        &json!({"idle_seconds":1200,"exclude_addresses":[]}),
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(["install_session_sleep", "--install", "--home"])
        .arg(&f.home)
        .arg("--source")
        .arg(&f.source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let installed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        installed["label"],
        "local.herdr-sixfold.sleep-idle-sessions"
    );
    let plist = plist::Value::from_file(installed["plist"].as_str().unwrap()).unwrap();
    assert_eq!(
        plist.as_dictionary().unwrap()["Label"].as_string(),
        Some("local.herdr-sixfold.sleep-idle-sessions")
    );
    let argv = plist.as_dictionary().unwrap()["ProgramArguments"]
        .as_array()
        .unwrap();
    assert!(argv.iter().any(|v| v.as_string() == Some("--dry-run")));
    assert!(!argv.iter().any(|v| v.as_string() == Some("--apply")));
    assert_eq!(argv[1].as_string(), Some("sleep_idle_sessions"));
    assert!(
        PathBuf::from(argv[0].as_string().unwrap()).is_file(),
        "the bundled native executable contains the sleep stub entrypoint"
    );
    // The original asserts that the installed stub exists, not that it has an
    // argparse help interface (it takes a ticket filename directly). The native
    // replacement bundles that entrypoint in the installed executable.
    assert_eq!(
        fs::read(argv[0].as_string().unwrap()).unwrap(),
        fs::read(env!("CARGO_BIN_EXE_herdr-theme")).unwrap()
    );
}
