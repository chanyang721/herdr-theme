use herdr_theme::documents::{common::*, install, observers};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn write_plist(path: &Path, argv: &[String], cwd: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut dict = plist::Dictionary::new();
    dict.insert(
        "ProgramArguments".into(),
        plist::Value::Array(argv.iter().cloned().map(plist::Value::String).collect()),
    );
    dict.insert(
        "WorkingDirectory".into(),
        plist::Value::String(cwd.to_string_lossy().into_owned()),
    );
    plist::Value::Dictionary(dict).to_file_xml(path).unwrap();
}
fn files(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| {
            (
                e.path().strip_prefix(root).unwrap().to_owned(),
                fs::read(e.path()).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
#[test]
fn exact_original_review_policy_snapshots() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/observer-approval-policy.json")).unwrap();
    for case in arr(&fixture["cases"]) {
        let config = case.get("config").filter(|v| !v.is_null());
        let result = observers::review_approval_snapshot(
            Path::new(s(&case["home"])),
            s(&case["commit"]),
            config,
            &arr(&case["records"]),
            &case["reviews"],
        );
        assert_eq!(
            result,
            case[if cfg!(windows) {
                "expected_windows"
            } else {
                "expected_posix"
            }],
            "{}",
            s(&case["name"])
        );
    }
}
#[test]
fn policy_reads_actual_isolated_ledger_without_writing_it() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/observer-approval-policy.json")).unwrap();
    let case = arr(&fixture["cases"])
        .into_iter()
        .find(|c| c["name"] == "latest-hold-wins")
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    let harness = home.path().join("external-harness");
    let local = home
        .path()
        .join(".config/herdr-app/data/sixfold/harness-local");
    atomic_json(local.join("config.json"), &json!({"repo_path":harness})).unwrap();
    for (index, record) in arr(&case["records"]).iter().enumerate() {
        atomic_json(
            harness
                .join("records/synthetic")
                .join(format!("record-{index:04}.json")),
            record,
        )
        .unwrap();
    }
    for (name, text) in case["reviews"].as_object().unwrap() {
        atomic_bytes(local.join("reviews").join(name), s(text).as_bytes()).unwrap();
    }
    let before = files(home.path());
    let result = observers::review_approval(
        home.path(),
        Path::new("unused-source"),
        Some(s(&case["commit"])),
    );
    assert_eq!(result["ok"], false);
    assert_eq!(result["why"], "verdict HOLD");
    assert_eq!(result["verdict_id"], "REC-0004");
    assert_eq!(result["report_id"], "REPORT-TWO");
    assert_eq!(files(home.path()), before);
}
#[test]
fn mixed_native_and_legacy_observers_refresh_only_the_native_registration() {
    let home = tempfile::tempdir().unwrap();
    let base = home.path().join("state");
    let binary = base.join(install::native_name());
    atomic_json(
        home.path()
            .join(".config/herdr-app/data/sixfold/site.local.json"),
        &json!({"state_dir":base}),
    )
    .unwrap();
    atomic_bytes(&binary, b"previous native executable").unwrap();
    let previous = hash(fs::read(&binary).unwrap());
    let agents = home.path().join("Library/LaunchAgents");
    let native_plist = agents.join("local.herdr-sixfold.close-finished-spaces.plist");
    let legacy_plist = agents.join("local.herdr-sixfold.sleep-idle-sessions.plist");
    write_plist(
        &native_plist,
        &[
            binary.to_string_lossy().into_owned(),
            "close_finished_spaces".into(),
            "--dry-run".into(),
        ],
        &base,
    );
    let legacy = base.join("sleep_idle_sessions.py");
    atomic_bytes(&legacy, b"# untouched external legacy observer\n").unwrap();
    write_plist(
        &legacy_plist,
        &[
            "/usr/bin/python3".into(),
            legacy.to_string_lossy().into_owned(),
            "--dry-run".into(),
        ],
        &base,
    );
    atomic_json(
        base.join("close-finished-spaces.json"),
        &json!({"user_approved_apply":true,"reviewed_observer_sha256":previous}),
    )
    .unwrap();
    atomic_json(
        base.join("sleep-idle-sessions.json"),
        &json!({"user_approved_apply":true,"reviewed_observer_sha256":"legacy-approval"}),
    )
    .unwrap();
    let original_native_plist = fs::read(&native_plist).unwrap();
    let original_legacy_plist = fs::read(&legacy_plist).unwrap();
    let original_legacy_config = fs::read(base.join("sleep-idle-sessions.json")).unwrap();
    let original_legacy_script = fs::read(&legacy).unwrap();
    let result = observers::refresh(home.path(), Path::new("no-source-probe-needed")).unwrap();
    assert_eq!(result["refreshed"], json!(["close-finished-spaces"]));
    assert_eq!(result["reinstallRequired"][0]["job"], "sleep-idle-sessions");
    assert!(result["observers"].get("sleep-idle-sessions").is_none());
    assert_eq!(
        result["observers"]["close-finished-spaces"]["approval_carried"],
        true
    );
    assert_eq!(
        hash(fs::read(&binary).unwrap()),
        hash(fs::read(std::env::current_exe().unwrap()).unwrap())
    );
    assert_eq!(fs::read(native_plist).unwrap(), original_native_plist);
    assert_eq!(fs::read(legacy_plist).unwrap(), original_legacy_plist);
    assert_eq!(
        fs::read(base.join("sleep-idle-sessions.json")).unwrap(),
        original_legacy_config
    );
    assert_eq!(fs::read(legacy).unwrap(), original_legacy_script);
}
#[test]
fn legacy_or_wrong_command_plists_require_reinstall_without_any_write() {
    let home = tempfile::tempdir().unwrap();
    let base = home.path().join("state");
    let binary = base.join(install::native_name());
    atomic_json(
        home.path()
            .join(".config/herdr-app/data/sixfold/site.local.json"),
        &json!({"state_dir":base}),
    )
    .unwrap();
    atomic_bytes(&binary, b"native shared executable exists").unwrap();
    let agents = home.path().join("Library/LaunchAgents");
    write_plist(
        &agents.join("local.herdr-sixfold.close-finished-spaces.plist"),
        &["/usr/bin/python3".into(), "legacy.py".into()],
        &base,
    );
    write_plist(
        &agents.join("local.herdr-sixfold.sleep-idle-sessions.plist"),
        &[binary.to_string_lossy().into_owned(), "--help".into()],
        &base,
    );
    let before = files(home.path());
    let result = observers::refresh(home.path(), Path::new("unused-source")).unwrap();
    assert_eq!(result["refreshed"], json!([]));
    assert_eq!(arr(&result["reinstallRequired"]).len(), 2);
    assert_eq!(files(home.path()), before);
}
