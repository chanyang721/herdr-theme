//! Direct translations of all 20 existing test_update_install.py methods at
//! fb3c234 (same original tests as 8c5b71d). Filesystem transactions are real;
//! only the original fake CLI/process/rename dependencies are injected through
//! the shared production bodies. No real app, voice installer or service runs.
//! Owned scripts/workspace.py intentionally substitutes the migrated native
//! payload/path. Unknown scripts/helper.py remains byte-exact copied user data.
use herdr_theme::documents::{common::*, install, update};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Output},
};

fn output(code: i32, text: String) -> Output {
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::ExitStatusExt;
        ExitStatus::from_raw(code as u32)
    };
    #[cfg(unix)]
    let status = {
        use std::os::unix::process::ExitStatusExt;
        ExitStatus::from_raw(code << 8)
    };
    Output {
        status,
        stdout: text.into_bytes(),
        stderr: vec![],
    }
}
fn put(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
#[derive(Default)]
struct FakeCli {
    calls: Vec<Value>,
    exchanges: usize,
    status_calls: usize,
    first_focus_override: bool,
}
impl update::UpdateRuntime for FakeCli {
    fn run(&mut self, _: &str, home: &Path, args: &[String], _: u64) -> Result<Output> {
        let config: Value = read_json(home.join("fake.json"))?;
        let target = home.join("mods/example/main.js");
        let current = fs::read_to_string(&target).unwrap_or_else(|_| "absent".into());
        self.calls.push(json!({"argv":args,"installed":current}));
        match args.first().map(String::as_str) {
            Some("check") => {
                let stage = Path::new(&args[1]);
                let candidate = fs::read_to_string(stage.join("main.js"))?;
                let bad = config["check_fail"] == true
                    || (candidate == "needs-dependency" && !stage.join("required.js").exists());
                Ok(output(
                    if bad { 3 } else { 0 },
                    if bad {
                        String::new()
                    } else {
                        "check passed\n".into()
                    },
                ))
            }
            Some("status") => {
                self.status_calls += 1;
                if current == "new" && config["runtime_cache"] == true {
                    let cache = home.join("mods/example/__pycache__");
                    fs::create_dir_all(&cache)?;
                    fs::write(cache.join("helper.cpython.pyc"), b"compiled")?;
                }
                let mut errors = if config["unhealthy"] == true
                    || (current == "old" && config["pre_errors"] == true)
                    || (current != "old" && config["post_fail"] == true)
                {
                    json!(["broken"])
                } else {
                    json!([])
                };
                if current == "new" && config["concurrent"] == true {
                    fs::write(&target, b"other writer")?;
                    errors = json!(["broken"]);
                }
                let moved = (current == "new" && config["focus_change"] == true)
                    || (config["focus_always"] == true && home.join("probe.txt").exists());
                let moved = moved && !(self.first_focus_override && self.status_calls == 1);
                Ok(output(0,json!({"errors":errors,"space":"space","tab":"tab","focused_pane":if moved{"moved"}else{"pane"}}).to_string()))
            }
            _ => Ok(output(4, String::new())),
        }
    }
    // Same original exchange mock boundary, while preserving the actual swap.
    fn exchange(&mut self, left: &Path, right: &Path) -> Result<()> {
        self.exchanges += 1;
        update::exchange(left, right)
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    repo: PathBuf,
    home: PathBuf,
    source: PathBuf,
    target: PathBuf,
    cli: FakeCli,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let home = temp.path().join("app");
        let source = repo.join("mods/example");
        let target = home.join("mods/example");
        put(&source.join("main.js"), "new");
        put(&source.join("required.js"), "dependency");
        put(&target.join("main.js"), "old");
        put(&target.join("unlisted.js"), "preserve me");
        fs::create_dir_all(repo.join("layouts")).unwrap();
        put(&home.join("fake.json"), "{}");
        Self {
            _temp: temp,
            repo,
            home,
            source,
            target,
            cli: FakeCli::default(),
        }
    }
    fn configure(&self, config: Value) {
        fs::write(
            self.home.join("fake.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
    }
    fn install(&mut self, files: &[&str], allow: bool) -> Result<PathBuf> {
        let files: Vec<String> = if files.is_empty() {
            vec!["mods/example/main.js".into()]
        } else {
            files.iter().map(|v| v.to_string()).collect()
        };
        update::update_with_runtime(
            &self.repo,
            &self.home,
            &files,
            "fake-herdr",
            1.6,
            allow,
            &[],
            &mut self.cli,
        )
    }
    fn backup_dirs(&self) -> Vec<PathBuf> {
        fs::read_dir(self.home.join("backups"))
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("sixfold-update-")
            })
            .map(|e| e.path())
            .collect()
    }
    fn receipt(&self) -> Value {
        let dirs = self.backup_dirs();
        assert_eq!(dirs.len(), 1);
        read_json(dirs[0].join("receipt.json")).unwrap()
    }
    fn main_text(&self) -> String {
        fs::read_to_string(self.target.join("main.js")).unwrap()
    }
}

#[test]
fn test_checks_complete_candidate_then_atomically_exchanges_and_preserves_unlisted_files() {
    let mut f = Fixture::new();
    put(&f.source.join("main.js"), "needs-dependency");
    let backup = f
        .install(&["mods/example/main.js", "mods/example/required.js"], false)
        .unwrap();
    assert_eq!(f.main_text(), "needs-dependency");
    assert_eq!(
        fs::read_to_string(f.target.join("unlisted.js")).unwrap(),
        "preserve me"
    );
    assert_eq!(
        fs::read_to_string(backup.join("mods/example/main.js")).unwrap(),
        "old"
    );
    assert_eq!(
        fs::read_to_string(backup.join("mods/example/unlisted.js")).unwrap(),
        "preserve me"
    );
    let check = f
        .cli
        .calls
        .iter()
        .find(|v| v["argv"][0] == "check")
        .unwrap();
    assert_eq!(check["installed"], "old");
    assert!(!resolved(Path::new(s(&check["argv"][1]))).starts_with(resolved(f.home.join("mods"))));
    assert_eq!(f.receipt()["phase"], "verified");
}
#[test]
fn test_import_cache_created_during_reload_is_not_a_concurrent_code_edit() {
    let mut f = Fixture::new();
    f.configure(json!({"runtime_cache":true}));
    f.install(&[], false).unwrap();
    assert_eq!(f.receipt()["phase"], "verified");
    assert_eq!(f.main_text(), "new");
    assert!(f.target.join("__pycache__/helper.cpython.pyc").is_file());
}
#[test]
fn test_missing_selected_dependency_fails_before_installation() {
    let mut f = Fixture::new();
    put(&f.source.join("main.js"), "needs-dependency");
    assert!(f
        .install(&[], false)
        .unwrap_err()
        .to_string()
        .contains("Native check failed"));
    assert_eq!(f.main_text(), "old");
    assert!(f.backup_dirs().is_empty());
}
#[test]
fn test_post_install_errors_restore_complete_mod_and_remove_new_files() {
    let mut f = Fixture::new();
    f.configure(json!({"post_fail":true}));
    assert!(f
        .install(&["mods/example/main.js", "mods/example/required.js"], false)
        .unwrap_err()
        .to_string()
        .contains("rolled_back"));
    assert_eq!(f.main_text(), "old");
    assert!(!f.target.join("required.js").exists());
    assert_eq!(
        fs::read_to_string(f.target.join("unlisted.js")).unwrap(),
        "preserve me"
    );
    assert_eq!(f.receipt()["rollback_status"]["errors"], json!([]));
}
#[test]
fn test_preexisting_errors_refuse_install_by_default() {
    let mut f = Fixture::new();
    f.configure(json!({"unhealthy":true}));
    assert!(f
        .install(&[], false)
        .unwrap_err()
        .to_string()
        .contains("already reports errors"));
    assert!(!f.cli.calls.iter().any(|v| v["argv"][0] == "check"));
    assert_eq!(f.main_text(), "old");
}
#[test]
fn test_authorized_repair_allows_initial_errors_but_requires_final_zero() {
    let mut f = Fixture::new();
    f.configure(json!({"pre_errors":true}));
    f.install(&[], true).unwrap();
    let receipt = f.receipt();
    assert_eq!(receipt["before"]["errors"], json!(["broken"]));
    assert_eq!(receipt["after"]["errors"], json!([]));
}
#[test]
fn test_authorized_repair_with_persistent_errors_still_rolls_back() {
    let mut f = Fixture::new();
    f.configure(json!({"unhealthy":true}));
    assert!(f
        .install(&[], true)
        .unwrap_err()
        .to_string()
        .contains("rolled_back"));
    assert_eq!(f.main_text(), "old");
}
#[test]
fn test_focus_change_is_reported_and_content_is_rolled_back_without_focus_commands() {
    let mut f = Fixture::new();
    f.configure(json!({"focus_change":true}));
    assert!(f
        .install(&[], false)
        .unwrap_err()
        .to_string()
        .to_lowercase()
        .contains("focus changed"));
    assert_eq!(f.main_text(), "old");
    assert!(f
        .cli
        .calls
        .iter()
        .all(|v| ["status", "check"].contains(&s(&v["argv"][0]))));
}
#[test]
fn test_a_person_using_the_app_does_not_roll_back_helper_scripts() {
    let mut f = Fixture::new();
    put(&f.repo.join("scripts/helper.py"), "# new helper\n");
    put(
        &f.home.join("probe.txt"),
        "focus moves after the first status",
    );
    f.configure(json!({"focus_always":true}));
    f.cli.first_focus_override = true;
    f.install(&["scripts/helper.py"], false).unwrap();
    assert_eq!(
        fs::read_to_string(f.home.join("scripts/sixfold/helper.py")).unwrap(),
        "# new helper\n"
    );
}
#[test]
fn test_existing_installation_lock_refuses_all_cli_and_file_changes() {
    let mut f = Fixture::new();
    let path = f.home.join("data/sixfold/install.lock");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .unwrap();
    fs2::FileExt::lock_exclusive(&lock).unwrap();
    assert!(f
        .install(&[], false)
        .unwrap_err()
        .to_string()
        .contains("holds the lock"));
    assert!(f.cli.calls.is_empty());
    assert_eq!(f.main_text(), "old");
}
#[test]
fn test_rollback_does_not_overwrite_an_uncooperative_later_writer() {
    let mut f = Fixture::new();
    f.configure(json!({"concurrent":true}));
    assert!(f
        .install(&[], false)
        .unwrap_err()
        .to_string()
        .contains("rollback_conflict"));
    assert_eq!(f.main_text(), "other writer");
    assert_eq!(f.receipt()["rollback_conflicts"], json!(["mods/example"]));
}
#[test]
fn test_unchanged_candidate_causes_no_native_check_or_mod_exchange() {
    let mut f = Fixture::new();
    put(&f.source.join("main.js"), "old");
    f.install(&[], false).unwrap();
    assert_eq!(f.cli.exchanges, 0);
    assert_eq!(
        f.cli
            .calls
            .iter()
            .map(|v| s(&v["argv"][0]))
            .collect::<Vec<_>>(),
        ["status"]
    );
    assert_eq!(f.receipt()["phase"], "unchanged");
}
#[test]
fn test_recovery_mod_clones_and_escaping_targets_are_refused() {
    let mut f = Fixture::new();
    for target in [
        "mods/example-recovery/main.js",
        "../main.js",
        "layouts/.state/sixfold.json",
    ] {
        assert!(f.install(&[target], false).is_err());
    }
    assert!(f.cli.calls.is_empty());
}
#[test]
fn test_script_destination_matches_initial_installer() {
    let mut f = Fixture::new();
    put(&f.repo.join("scripts/workspace.py"), "updated helper");
    // This path case writes and rechecks a complete native test executable,
    // rather than the original small helper text. Keep production's one-second
    // clean interval while allowing filesystem overhead in this fixture.
    update::update_with_runtime(
        &f.repo,
        &f.home,
        &["scripts/workspace.py".into()],
        "fake-herdr",
        5.0,
        false,
        &[],
        &mut f.cli,
    )
    .unwrap();
    let destination = f.home.join("scripts/sixfold").join(install::native_name());
    assert_eq!(
        fs::read(destination).unwrap(),
        fs::read(std::env::current_exe().unwrap()).unwrap()
    );
    assert!(!f.home.join("scripts").join(install::native_name()).exists());
    assert!(!f.home.join("scripts/sixfold/workspace.py").exists()); /* Owned-entrypoint adapter: original compares installed helper source text; native compares complete replacement binary bytes at the same scripts/sixfold destination scope. */
}
#[test]
fn test_layout_files_roll_back_together_with_mod() {
    let mut f = Fixture::new();
    put(&f.repo.join("layouts/sixfold.json"), r#"{"new":true}"#);
    put(&f.home.join("layouts/sixfold.json"), r#"{"old":true}"#);
    f.configure(json!({"post_fail":true}));
    assert!(f
        .install(&["mods/example/main.js", "layouts/sixfold.json"], false)
        .unwrap_err()
        .to_string()
        .contains("rolled_back"));
    assert_eq!(
        fs::read_to_string(f.home.join("layouts/sixfold.json")).unwrap(),
        r#"{"old":true}"#
    );
    assert_eq!(f.main_text(), "old");
}
#[test]
fn test_exchange_swaps_directory_contents_and_leaves_no_scratch_path() {
    let f = Fixture::new();
    let left = f._temp.path().join("stage/example");
    let right = f._temp.path().join("live/example");
    put(&left.join("main.js"), "candidate");
    put(&right.join("main.js"), "installed");
    update::exchange(&left, &right).unwrap();
    assert_eq!(
        fs::read_to_string(right.join("main.js")).unwrap(),
        "candidate"
    );
    assert_eq!(
        fs::read_to_string(left.join("main.js")).unwrap(),
        "installed"
    );
    assert_eq!(
        fs::read_dir(left.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>(),
        vec![std::ffi::OsString::from("example")]
    );
}
#[cfg(windows)]
#[test]
fn test_windows_failed_second_rename_restores_the_installed_directory() {
    let f = Fixture::new();
    let left = f._temp.path().join("stage/example");
    let right = f._temp.path().join("live/example");
    fs::create_dir_all(&left).unwrap();
    put(&right.join("main.js"), "installed");
    let result = update::exchange_windows_with_rename(&left, &right, &mut |source, target| {
        if source == left.as_path() {
            return Err(
                std::io::Error::new(std::io::ErrorKind::PermissionDenied, "held open").into(),
            );
        }
        fs::rename(source, target)?;
        Ok(())
    });
    assert_eq!(
        result
            .unwrap_err()
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        fs::read_to_string(right.join("main.js")).unwrap(),
        "installed"
    );
    assert!(!left
        .parent()
        .unwrap()
        .join("example.exchange-aside")
        .exists());
}

#[derive(Default)]
struct VoiceBackend {
    calls: Vec<Value>,
}
impl update::UpdateCliBackend for VoiceBackend {
    fn pinned_files(
        &mut self,
        repo: &Path,
        _: Option<&Path>,
    ) -> Result<(Value, PathBuf, Vec<(PathBuf, PathBuf)>)> {
        Ok((Value::Null, repo.into(), vec![]))
    }
    fn update(
        &mut self,
        _: &Path,
        _: &Path,
        names: &[String],
        _: &str,
        _: f64,
        _: bool,
        _: &[(PathBuf, PathBuf)],
    ) -> Result<PathBuf> {
        self.calls.push(json!(["update", names]));
        Ok(PathBuf::from("receipt"))
    }
    fn record(&mut self, _: &Path, _: &Value) -> Result<()> {
        panic!("original absent pin must not be recorded")
    }
    fn voice(&mut self, repo: &Path, _: &Path) -> Result<()> {
        self.calls.push(json!(["voice", repo]));
        Ok(())
    }
}
fn routing(names: &[&str]) -> Vec<Value> {
    let f = Fixture::new();
    let mut args = vec![
        "--repo".into(),
        f.repo.to_string_lossy().into_owned(),
        "--home".into(),
        f.home.to_string_lossy().into_owned(),
    ];
    args.extend(names.iter().map(|v| v.to_string()));
    let mut backend = VoiceBackend::default();
    update::cli_with_backend(&args, &mut backend).unwrap();
    backend.calls
}
#[test]
fn test_voice_alone_skips_the_app_update() {
    let calls = routing(&["voice"]);
    assert_eq!(
        calls.iter().map(|v| s(&v[0])).collect::<Vec<_>>(),
        ["voice"]
    );
}
#[test]
fn test_app_files_and_voice_install_both_in_order() {
    let calls = routing(&["mods/sixfold-desk/main.js", "voice/focus_queue.py"]);
    assert_eq!(calls[0], json!(["update", ["mods/sixfold-desk/main.js"]]));
    assert_eq!(calls[1][0], "voice");
}
#[test]
fn test_a_failed_voice_install_fails_the_update() {
    let f = Fixture::new();
    put(
        &f.repo.join("voice/install.py"),
        "import sys; sys.exit(1)\n",
    );
    let result = update::install_voice_with_runner(&f.repo, &f.home, &mut |_: &mut Command| {
        Ok(output(1, String::new()))
    });
    assert!(result.is_err());
}
