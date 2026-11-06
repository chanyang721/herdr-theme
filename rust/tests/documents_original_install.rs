//! Original catalog harness, document installer and Workspace Mods tests.
//! Git fixtures are local disposable repositories; no GitHub/app is contacted.
use chrono::NaiveDate;
use herdr_theme::documents::{catalog, common::*, install, update};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
struct Temp {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Temp {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = resolved(temp.path());
        Self { _temp: temp, root }
    }
    fn put(&self, name: &str, text: &str) -> PathBuf {
        put(&self.root, name, text)
    }
}
fn put(root: &Path, name: &str, text: &str) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}
fn save(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}
#[cfg(unix)]
fn link(from: &Path, to: &Path) {
    fs::create_dir_all(to.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(from, to).unwrap();
}
struct Catalog {
    temp: Temp,
    app: PathBuf,
    docs: PathBuf,
    config: Value,
}
impl Catalog {
    fn new() -> Self {
        let temp = Temp::new();
        let docs = temp.root.join("docs");
        let app = temp.root.join("app");
        Self {
            config: json!({"version":1,"spaces":{"sp1":{"name":"Demo","folders":[docs],"pins":[]}}}),
            temp,
            docs,
            app,
        }
    }
    fn view(&self) -> Value {
        herdr_theme::documents::pins::catalog(
            &self.config,
            "sp1",
            NaiveDate::from_ymd_opt(2026, 11, 4).unwrap(),
            &self.app,
            &json!({}),
        )
        .unwrap()
    }
    fn harness(&self, space: &str, machine: Value) -> PathBuf {
        let base = self.app.join("data/sixfold/harness-local/views/workspaces");
        let root = base.join(format!("core-{space}"));
        fs::create_dir_all(&root).unwrap();
        save(
            &base.join("index.json"),
            &json!({"workspaces":[{"workspace_id":format!("other-{space}"),"space_id":space,"machine_name":"remote"},{"workspace_id":format!("core-{space}"),"space_id":space,"machine_name":machine}]}),
        );
        root
    }
}
#[test]
#[cfg(unix)]
fn test_harness_sections_follow_the_folder_contract() {
    let f = Catalog::new();
    let root = f.harness("sp1", Value::Null);
    let listed = put(&f.docs, "20261104_데모_구조.md", "본문");
    for name in [
        "README.md",
        "context/goal.md",
        "context/constraints.md",
        "next.md",
        "escalation.md",
        "history/2026-11/2026-11-04/fix.md",
        "history/2026-10/2026-10-30/old.md",
        "decisions/2026-11-03-choose.md",
        "brain/brain.md",
        ".hidden.md",
    ] {
        put(&root, name, "본문");
    }
    link(&listed, &root.join("docs/고정/20261104_데모_구조.md"));
    link(&root.join("missing.md"), &root.join("docs/고정/broken.md"));
    let data = f.view();
    let sections = data["harness"]["sections"].as_array().unwrap();
    assert_eq!(
        sections
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["status", "history", "decisions", "docs", "brain"]
    );
    let rows = data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["harness"] == true)
        .map(|d| (s(&d["id"]), d))
        .collect::<BTreeMap<_, _>>();
    let section = |name: &str| sections.iter().find(|s| s["id"] == name).unwrap();
    let status = section("status")["groups"][0]["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| s(&rows[id.as_str().unwrap()]["name"]))
        .collect::<Vec<_>>();
    assert_eq!(
        status,
        vec![
            "README.md",
            "goal.md",
            "constraints.md",
            "next.md",
            "escalation.md"
        ]
    );
    assert_eq!(
        section("history")["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| s(&g["label"]))
            .collect::<Vec<_>>(),
        vec!["2026-11", "2026-10"]
    );
    let doc_ids = section("docs")["groups"][0]["ids"].as_array().unwrap();
    let alias = rows[doc_ids[0].as_str().unwrap()];
    let original = data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "20261104_데모_구조.md" && d["harness"] != true)
        .unwrap();
    assert_eq!(alias["aliasOf"], original["id"]);
    assert_eq!(doc_ids.len(), 1);
    assert!(!rows.values().any(|d| s(&d["name"]).starts_with('.')));
    assert!(data["watchRoots"]
        .as_array()
        .unwrap()
        .contains(&json!(root)));
}
#[test]
#[cfg(unix)]
fn test_harness_version_folders_fold_under_the_newest_link() {
    let f = Catalog::new();
    let root = f.harness("sp1", Value::Null);
    let older = f.temp.put("src/20261101_데모_구조.md", "본문");
    let newer = f.temp.put("src/20261103_데모_구조.md", "본문");
    let bundle = root.join("docs/주제/데모_구조");
    link(&older, &bundle.join(older.file_name().unwrap()));
    link(&newer, &bundle.join(newer.file_name().unwrap()));
    let data = f.view();
    let rows = data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["harness"] == true)
        .map(|d| (s(&d["name"]), d))
        .collect::<BTreeMap<_, _>>();
    let head = rows["20261103_데모_구조.md"];
    let previous = rows["20261101_데모_구조.md"];
    assert_eq!(head["label"], "데모 구조");
    assert_eq!(head["versions"], json!([previous["id"]]));
    assert_eq!(previous["state"], "previous");
    assert_eq!(previous["head"], head["id"]);
    let section = data["harness"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "docs")
        .unwrap();
    assert_eq!(section["groups"][0]["label"], "주제");
}
#[test]
fn test_harness_is_hidden_without_a_local_entry() {
    let mut f = Catalog::new();
    f.harness("other", Value::Null);
    assert!(f.view()["harness"].is_null());
    let root = f.temp.root.join("manual");
    put(&root, "README.md", "본문");
    f.config["spaces"]["sp1"]["harness"] = json!({"root":root});
    assert_eq!(f.view()["harness"]["root"], json!(root));
}
#[test]
fn test_remote_machine_entry_is_not_this_mac() {
    let f = Catalog::new();
    let base = f.app.join("data/sixfold/harness-local/views/workspaces");
    fs::create_dir_all(base.join("core-sp1")).unwrap();
    save(
        &base.join("index.json"),
        &json!({"workspaces":[{"workspace_id":"core-sp1","space_id":"sp1","machine_name":"remote"}]}),
    );
    assert!(catalog::harness_root("sp1", &f.app, None).is_none());
}

fn document() -> Value {
    json!({"spaces":[{"id":"sp1","name":"Demo","folder":"/demo","tabs":[{"id":"work","name":"Work","root":{"id":"row","type":"row","size":{"weight":2},"children":[{"id":"p1","type":"block","content":{"terminal":"t1"}}]}}]}]})
}
#[test]
fn test_seed_preserves_user_settings_and_original_project_config() {
    let existing =
        json!({"version":1,"spaces":{"sp1":{"pins":[],"recent":{"limit":2},"custom":true}}});
    let project = json!({"version":1,"spaces":{"Demo":{"folders":["/docs"]}}});
    let before = project.clone();
    let mut config = install::seed_config(
        &document(),
        &existing,
        &project,
        Path::new("/repo"),
        Path::new("/home"),
        &json!({}),
    )
    .unwrap();
    assert_eq!(config, existing);
    assert_eq!(project, before);
    config["spaces"]["sp1"]["custom"] = json!(false);
    assert_eq!(existing["spaces"]["sp1"]["custom"], true);
}
#[test]
fn test_share_seed_uses_stable_identity_and_preserves_document_sources() {
    let f = Temp::new();
    f.put("COMMON_ROUTING.md", "routing");
    f.put("README.ko.md", "readme");
    let site = json!({"hub_space_ids":["sp-share"]});
    for (id, name) in [("other", "Share"), ("sp-share", "Renamed")] {
        let config = install::seed_space(
            &json!({"id":id,"name":name}),
            &json!({}),
            &f.root,
            &f.root,
            &site,
        );
        assert!(config["pins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|pin| pin["path"] == json!(f.root.join("COMMON_ROUTING.md"))));
    }
}
#[test]
fn test_project_documents_come_from_the_machine_local_site_config() {
    let f = Temp::new();
    f.put("docs/ARCH.md", "# arch");
    f.put("20261101_ProjectB_overview.md", "# b");
    let site = json!({"doc_tabs":{"Project A":{"sources":[{"path":"~/docs/ARCH.md","label":"구조"}],"folders":["~/docs"]},"Project B":{"topics":[{"root":"~","suffix":"ProjectB_overview.md","label":"개요"}],"folders":[{"path":"~","match":["projectb"]}]}}});
    let a = install::seed_space(
        &json!({"id":"a","name":"Project A"}),
        &json!({}),
        Path::new("/repo"),
        &f.root,
        &site,
    );
    assert_eq!(
        a["pins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p["label"].clone(), p["path"].clone()))
            .collect::<Vec<_>>(),
        vec![(json!("구조"), json!(f.root.join("docs/ARCH.md")))]
    );
    assert_eq!(a["folders"], json!([f.root.join("docs")]));
    let b = install::seed_space(
        &json!({"id":"b","name":"Project B"}),
        &json!({}),
        Path::new("/repo"),
        &f.root,
        &site,
    );
    assert_eq!(
        (&b["pins"][0]["kind"], &b["pins"][0]["label"]),
        (&json!("latest"), &json!("개요"))
    );
    assert_eq!(b["folders"], json!([{"path":f.root,"match":["projectb"]}]));
    assert_eq!(
        install::seed_space(
            &json!({"id":"a","name":"Project A"}),
            &json!({}),
            Path::new("/repo"),
            &f.root,
            &json!({})
        )["pins"],
        json!([])
    );
}
#[test]
fn test_dates_follow_latest_in_exact_directory_and_keep_disk_unicode() {
    let f = Temp::new();
    let path = f.put("20261027_프로젝트비_전체구조_착수전_정리.md", "# 구조");
    let pin = install::file_pin(&path, Some("구조")).unwrap();
    assert_eq!(pin["kind"], "latest");
    assert_eq!(pin["topic"], "프로젝트비_전체구조_착수전_정리.md");
    assert_eq!(pin["root"], json!(f.root));
    assert_eq!(pin["recursive"], false);
    f.put("archive.md", "# archive");
    assert!(install::file_pin(&f.root.join("archive.md"), None).is_none());
    assert!(install::file_pin(&f.root.join("missing.md"), None).is_none());
}
#[test]
fn test_native_check_failure_prevents_feature_copy() {
    let f = Temp::new();
    let app = f.root.join("app");
    let result = install::copy_feature_with_checker(Path::new("/repo"), &app, &mut |_| {
        Err("invalid mod".into())
    });
    assert!(result.is_err());
    assert!(!app.exists());
}
struct Tabs {
    gets: VecDeque<Value>,
    attempts: Vec<Value>,
    focus: Value,
}
impl install::DocTabsBackend for Tabs {
    fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        if method == "doc.get" {
            return Ok(self.gets.pop_front().expect("unexpected document read"));
        }
        assert_eq!(method, "doc.set");
        self.attempts.push(params);
        if self.attempts.len() == 1 {
            Err("stale".into())
        } else {
            Ok(json!({"version":3}))
        }
    }
    fn status(&mut self) -> Result<Value> {
        Ok(self.focus.clone())
    }
    fn copy_feature(&mut self, _: &Path, _: &Path) -> Result<()> {
        panic!("--ensure-tabs must not copy feature")
    }
    fn sleep(&mut self, _: Duration) {}
}
#[test]
fn test_cas_retry_rereads_concurrent_document_and_reports_focus() {
    let f = Temp::new();
    f.put("mods/project-docs-tabs/main.js", "// checked");
    let doc = document();
    let mut concurrent = doc.clone();
    concurrent["spaces"][0]["tabs"][0]["name"] = json!("Renamed concurrently");
    let mut backend = Tabs {
        gets: vec![
            json!({"value":doc,"version":1}),
            json!({"value":doc,"version":1}),
            json!({"value":concurrent,"version":2}),
        ]
        .into(),
        attempts: vec![],
        focus: json!({"space":"sp1","tab":"work","focused_pane":"p1"}),
    };
    let result = install::tabs_with(
        &[
            "--ensure-tabs".into(),
            "--home".into(),
            f.root.to_string_lossy().into_owned(),
        ],
        &mut backend,
    )
    .unwrap();
    assert_eq!(result["focusUnchanged"], true);
    assert_eq!(backend.attempts[1]["version"], 2);
    assert_eq!(
        backend.attempts[1]["value"]["spaces"][0]["tabs"][0]["name"],
        "Renamed concurrently"
    );
    assert!(!f.root.join("data/sixfold/project-docs.json").exists());
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
struct Release {
    temp: Temp,
    mods: PathBuf,
    theme: PathBuf,
    commit: String,
}
impl Release {
    fn new() -> Self {
        let temp = Temp::new();
        let mods = temp.root.join("workspace-mods");
        for (path, text) in [
            (
                "system-metrics/mods/system-metrics/mod.json",
                "{\"title\":\"System Metrics\"}",
            ),
            (
                "system-metrics/mods/system-metrics/main.js",
                "export default 1;",
            ),
            (
                "system-metrics/mods/system-metrics/jsconfig.json",
                "generated",
            ),
            ("system-metrics/README.md", "docs, not installed"),
            (
                "plan-usage/mods/plan-usage/mod.json",
                "{\"title\":\"Plan Usage\"}",
            ),
            ("plan-usage/mods/plan-usage/usage.py", "print(1)\n"),
        ] {
            put(&mods, path, text);
        }
        git(&temp.root, &["init", "-q", mods.to_str().unwrap()]);
        git(&mods, &["add", "-A"]);
        git(
            &mods,
            &[
                "-c",
                "core.hooksPath=.no-hooks",
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "-qm",
                "release",
            ],
        );
        let commit = git(&mods, &["rev-parse", "HEAD"]);
        let theme = temp.root.join("theme");
        fs::create_dir(&theme).unwrap();
        let f = Self {
            temp,
            mods,
            theme,
            commit,
        };
        f.pin(json!({"system-metrics":"system-metrics/mods/system-metrics","plan-usage":"plan-usage/mods/plan-usage"}),None);
        f
    }
    fn pin(&self, mods: Value, commit: Option<&str>) {
        save(
            &self.theme.join("workspace-mods.lock.json"),
            &json!({"repository":self.mods,"tag":"v-test","commit":commit.unwrap_or(&self.commit),"mods":mods,"document_viewer":"document-viewer/scripts/install_preview.py"}),
        );
    }
    fn system_only(&self, commit: Option<&str>) {
        self.pin(
            json!({"system-metrics":"system-metrics/mods/system-metrics"}),
            commit,
        );
    }
    fn files(&self) -> (Value, PathBuf, Vec<(PathBuf, PathBuf)>) {
        install::pinned_files(&self.theme, Some(&self.mods)).unwrap()
    }
    fn cached(&self, cache: &Path) -> Result<(Value, PathBuf, Vec<(PathBuf, PathBuf)>)> {
        install::pinned_files_with_cache(&self.theme, None, Some(cache))
    }
    fn assets(&self) {
        for (path, text) in [
            ("keys.json", "{}"),
            ("mods/sixfold-desk/main.js", "x"),
            ("layouts/sixfold.json", "{}"),
            ("themes/sixfold-night.json", "{}"),
        ] {
            put(&self.theme, path, text);
        }
    }
}
#[test]
fn test_lists_each_pinned_mods_runtime_files_and_skips_generated_ones() {
    let f = Release::new();
    let (pin, _, files) = f.files();
    assert_eq!(pin["tag"], "v-test");
    let mut relative = files
        .iter()
        .map(|(_, rel)| rel.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>();
    relative.sort();
    assert_eq!(
        relative,
        vec![
            "mods/plan-usage/mod.json",
            "mods/system-metrics/main.js",
            "mods/system-metrics/mod.json"
        ]
    ); /* Explicit interpreter removal: original fourth file usage.py is provided by installed native pinned_plan_usage. */
    assert!(f.mods.join("plan-usage/mods/plan-usage/usage.py").exists());
}
#[test]
fn test_a_checkout_at_another_commit_or_with_changes_is_refused() {
    let f = Release::new();
    f.system_only(Some(&"0".repeat(40)));
    assert!(install::pinned_files(&f.theme, Some(&f.mods))
        .unwrap_err()
        .to_string()
        .contains("not the pinned"));
    f.system_only(None);
    put(&f.mods, "system-metrics/README.md", "edited");
    assert!(install::pinned_files(&f.theme, Some(&f.mods))
        .unwrap_err()
        .to_string()
        .contains("local changes"));
}
#[test]
fn test_unsafe_or_incomplete_pins_are_refused() {
    let f = Release::new();
    for (mods, commit) in [
        (json!({"x":"../outside"}), None),
        (json!({}), None),
        (json!({"x":"x"}), Some("abc")),
    ] {
        f.pin(mods, commit);
        assert!(install::read_pin(&f.theme).is_err());
    }
    f.pin(json!({"missing":"nowhere/mods/missing"}), None);
    assert!(install::pinned_files(&f.theme, Some(&f.mods))
        .unwrap_err()
        .to_string()
        .contains("no mod"));
}
#[test]
fn test_fetches_the_pinned_commit_into_an_empty_cache() {
    let f = Release::new();
    let cache = f.temp.root.join("cache");
    let (_, root, files) = f.cached(&cache).unwrap();
    assert_eq!(root, cache.join(&f.commit[..12]));
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), f.commit);
    assert_eq!(files.len(), 3);
}
#[test]
fn test_a_failed_fetch_leaves_no_cache_behind_and_the_next_try_works() {
    let f = Release::new();
    let cache = f.temp.root.join("cache");
    f.system_only(Some(&"f".repeat(40)));
    assert!(f
        .cached(&cache)
        .unwrap_err()
        .to_string()
        .contains("could not fetch"));
    assert_eq!(fs::read_dir(&cache).unwrap().count(), 0);
    f.system_only(None);
    let (_, _, files) = f.cached(&cache).unwrap();
    assert_eq!(files.len(), 2);
}
#[test]
fn test_installs_pinned_to_different_commits_keep_separate_checkouts() {
    let f = Release::new();
    let cache = f.temp.root.join("cache");
    let first = f.commit.clone();
    put(
        &f.mods,
        "system-metrics/mods/system-metrics/main.js",
        "export default 2;",
    );
    git(
        &f.mods,
        &[
            "-c",
            "core.hooksPath=.no-hooks",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-qam",
            "next",
        ],
    );
    let second = git(&f.mods, &["rev-parse", "HEAD"]);
    f.system_only(Some(&first));
    let (_, old_root, _) = f.cached(&cache).unwrap();
    f.system_only(Some(&second));
    let (_, new_root, files) = f.cached(&cache).unwrap();
    assert_ne!(old_root, new_root);
    assert_eq!(git(&old_root, &["rev-parse", "HEAD"]), first);
    let main = &files
        .iter()
        .find(|(_, rel)| rel.file_name().unwrap() == "main.js")
        .unwrap()
        .0;
    assert_eq!(fs::read_to_string(main).unwrap(), "export default 2;");
}
#[test]
fn test_ignored_files_in_a_checkout_are_not_installed() {
    let mut f = Release::new();
    put(&f.mods, ".gitignore", "*.log\n");
    git(&f.mods, &["add", ".gitignore"]);
    git(
        &f.mods,
        &[
            "-c",
            "core.hooksPath=.no-hooks",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-qm",
            "ignore logs",
        ],
    );
    f.commit = git(&f.mods, &["rev-parse", "HEAD"]);
    f.system_only(None);
    put(
        &f.mods,
        "system-metrics/mods/system-metrics/debug.log",
        "local",
    );
    assert!(!f
        .files()
        .2
        .iter()
        .any(|(_, rel)| rel.file_name().unwrap() == "debug.log"));
}
#[test]
fn test_records_the_installed_release_and_finds_a_files_layout() {
    let f = Release::new();
    let app = f.temp.root.join("app");
    let pin = install::read_pin(&f.theme).unwrap();
    install::record(&app, &pin).unwrap();
    let saved = read_json(app.join("data/sixfold/workspace-mods.json")).unwrap();
    assert_eq!(saved["commit"], f.commit);
    assert_eq!(saved["mods"], json!(["plan-usage", "system-metrics"]));
    assert!(install::has_files_layout(&app).is_none());
    put(
        &app,
        "layouts/plain.json",
        "{\"id\":\"root\",\"children\":[]}",
    );
    put(
        &app,
        "layouts/main.json",
        "{\"id\":\"root\",\"children\":[{\"id\":\"files\"}]}",
    );
    assert_eq!(install::has_files_layout(&app), Some("main".into()));
}
#[test]
fn test_the_first_install_brings_the_pinned_mods_with_the_theme() {
    let f = Release::new();
    f.assets();
    let app = f.temp.root.join("app");
    let files = f.files().2;
    install::base_install(&f.theme, &app, false, &files).unwrap();
    assert_eq!(
        fs::read_to_string(app.join("mods/system-metrics/main.js")).unwrap(),
        "export default 1;"
    );
    assert!(app
        .join("scripts/sixfold")
        .join(install::native_name())
        .exists());
    assert!(!app.join("mods/plan-usage/usage.py").exists());
    assert!(!app.join("mods/system-metrics/jsconfig.json").exists());
    assert!(app.join("mods/sixfold-desk/main.js").exists());
    assert!(install::base_install(&f.theme, &app, false, &files).is_err());
    install::base_install(&f.theme, &app, true, &files).unwrap();
}
#[test]
fn test_pinned_targets_are_checked_like_listed_files() {
    let f = Release::new();
    let home = f.temp.root.join("home");
    fs::create_dir_all(home.join("mods")).unwrap();
    let source = f.mods.join("plan-usage/mods/plan-usage/usage.py");
    let target = PathBuf::from("mods/plan-usage/usage.py");
    let entries = update::pinned_inputs(&[(source.clone(), target.clone())], &home).unwrap();
    assert_eq!(entries[0].0, target);
    assert!(
        update::pinned_inputs(&[(source.clone(), PathBuf::from("layouts/x.json"))], &home).is_err()
    );
    fs::create_dir_all(home.join(&target)).unwrap();
    assert!(update::pinned_inputs(&[(source, target)], &home)
        .unwrap_err()
        .to_string()
        .contains("regular"));
}
#[test]
fn test_a_linked_mods_folder_is_refused() {
    let f = Release::new();
    let home = f.temp.root.join("home2");
    let outside = f.temp.root.join("outside");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&outside).unwrap();
    #[cfg(unix)]
    link(&outside, &home.join("mods"));
    #[cfg(windows)]
    {
        let output = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(home.join("mods"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let source = f.mods.join("plan-usage/mods/plan-usage/usage.py");
    assert!(update::pinned_inputs(
        &[(source, PathBuf::from("mods/plan-usage/usage.py"))],
        &home
    )
    .unwrap_err()
    .to_string()
    .contains("Symlink"));
}
#[test]
fn test_the_later_document_viewer_command_names_the_home_and_quotes_paths() {
    let windows = install::later_command(
        &[
            "C:/Py/python.exe".into(),
            "C:/Users/A B/x.py".into(),
            "--layout".into(),
            "<layout>".into(),
            "--markdown-only".into(),
        ],
        Path::new("C:/Users/A B/.config/herdr-app"),
        true,
    );
    assert_eq!(
        windows,
        r"$env:HERDR_APP_HOME = 'C:\Users\A B\.config\herdr-app'; & 'C:/Py/python.exe' 'C:/Users/A B/x.py' --layout '<layout>' --markdown-only"
    );
    let posix = install::later_command(
        &[
            "/usr/bin/python3".into(),
            "/home/a b/x.py".into(),
            "--layout".into(),
            "<layout>".into(),
        ],
        Path::new("/home/a b/.config/herdr-app"),
        false,
    );
    assert_eq!(posix,"HERDR_APP_HOME='/home/a b/.config/herdr-app' /usr/bin/python3 '/home/a b/x.py' --layout '<layout>'");
}

struct UpdateCalls {
    pin: Value,
    checkout: PathBuf,
    extra: Vec<(PathBuf, PathBuf)>,
    calls: Vec<Value>,
}
impl update::UpdateCliBackend for UpdateCalls {
    fn pinned_files(
        &mut self,
        _: &Path,
        _: Option<&Path>,
    ) -> Result<(Value, PathBuf, Vec<(PathBuf, PathBuf)>)> {
        Ok((self.pin.clone(), self.checkout.clone(), self.extra.clone()))
    }
    fn update(
        &mut self,
        _: &Path,
        _: &Path,
        names: &[String],
        _: &str,
        _: f64,
        _: bool,
        extra: &[(PathBuf, PathBuf)],
    ) -> Result<PathBuf> {
        self.calls.push(json!([
            names,
            extra
                .iter()
                .map(|(_, relative)| relative.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        ]));
        Ok(self.checkout.join("receipt"))
    }
    fn record(&mut self, _: &Path, _: &Value) -> Result<()> {
        Ok(())
    }
    fn voice(&mut self, _: &Path, _: &Path) -> Result<()> {
        self.calls.push(json!("voice"));
        Ok(())
    }
}
#[test]
fn test_updater_includes_the_pinned_mods_by_default_and_not_for_voice_alone() {
    let f = Release::new();
    f.assets();
    let relative = PathBuf::from("mods/plan-usage/usage.py");
    let mut backend = UpdateCalls {
        pin: install::read_pin(&f.theme).unwrap(),
        checkout: f.mods.clone(),
        extra: vec![(
            f.mods.join("plan-usage/mods/plan-usage/usage.py"),
            relative.clone(),
        )],
        calls: vec![],
    };
    let mut run = |names: &[&str]| {
        backend.calls.clear();
        let mut args = vec![
            "--repo".to_owned(),
            f.theme.to_string_lossy().into_owned(),
            "--home".into(),
            f.temp.root.join("app").to_string_lossy().into_owned(),
        ];
        args.extend(names.iter().map(|name| (*name).to_owned()));
        update::cli_with_backend(&args, &mut backend).unwrap();
        backend.calls.clone()
    };
    assert_eq!(run(&[]), vec![json!([[], [relative]])]);
    assert_eq!(
        run(&["mods/sixfold-desk/main.js"])[0][0],
        json!(["mods/sixfold-desk/main.js"])
    );
    assert_eq!(
        run(&["mods/sixfold-desk/main.js", "--without-workspace-mods"]),
        vec![json!([["mods/sixfold-desk/main.js"], []])]
    );
    assert_eq!(run(&["voice"]), vec![json!("voice")]);
}
