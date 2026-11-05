//! Installation and rollback contracts run against isolated files and a fake app CLI.
use herdr_theme::documents::{common::*, install, update};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn put(root: &Path, path: &str, body: &str) {
    let out = root.join(path);
    fs::create_dir_all(out.parent().unwrap()).unwrap();
    fs::write(out, body).unwrap();
}
fn source(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    put(
        &repo,
        "keys.json",
        r#"{"layout:sixfold":{"ctrl-x":"original"}}"#,
    );
    put(&repo, "mods/sixfold-desk/main.js", "import './model.js';");
    put(&repo, "mods/sixfold-desk/model.js", "export const value=1;");
    put(&repo, "mods/sixfold-desk/jsconfig.json", "generated");
    put(&repo, "layouts/sixfold.json", r#"{"owned":1}"#);
    put(
        &repo,
        "themes/sixfold-night.json",
        r#"{"color":"original"}"#,
    );
    put(&repo, "themes/win98.json", r#"{"reference":1}"#);
    repo
}
#[test]
fn native_base_install_preserves_custom_settings_and_updates_whole_mod() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    install::base_install(&repo, &app, false, &[]).unwrap();
    assert!(app
        .join("scripts/sixfold")
        .join(install::native_name())
        .is_file());
    for (name, bytes) in herdr_theme::notices::files() {
        assert_eq!(
            fs::read(app.join("scripts/sixfold/native-licenses").join(name)).unwrap(),
            *bytes
        );
    }
    assert!(!app.join("mods/sixfold-desk/jsconfig.json").exists());
    assert!(install::base_install(&repo, &app, false, &[]).is_err());
    let custom = [
        (
            "keys.json",
            r#"{"layout:sixfold":{"ctrl-x":"mine"},"global":{"cmd-p":"mine"}}"#,
        ),
        ("settings.json", r#"{"zoom":2}"#),
        (
            "data/sixfold/workspace-pins.local.json",
            r#"{"spaces":[{"id":"mine"}]}"#,
        ),
        ("layouts/sixfold.json", r#"{"monitor":"mine"}"#),
        ("themes/sixfold-night.json", r#"{"color":"mine"}"#),
        ("themes/win98.json", r#"{"reference":"mine"}"#),
        ("mods/sixfold-desk/local-helper.js", "my code"),
    ];
    for (path, body) in custom {
        put(&app, path, body)
    }
    put(&repo, "mods/sixfold-desk/model.js", "export const value=2;");
    for _ in 0..2 {
        install::base_install(&repo, &app, true, &[]).unwrap()
    }
    assert_eq!(
        text(app.join("mods/sixfold-desk/model.js")).unwrap(),
        "export const value=2;"
    );
    for (path, body) in custom {
        assert_eq!(text(app.join(path)).unwrap(), body, "preserved {path}");
    }
}
fn fake_cli(root: &Path, fail_after: bool) -> PathBuf {
    let script = root.join("fake.mjs");
    fs::write(&script,format!(r#"import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),home=process.env.HERDR_APP_HOME;
if(args[0]==='check'){{process.stdout.write('{{}}');process.exit(0);}}
if(args[0]!=='status')process.exit(9);
const f=path.join(home,'.samples');const count=Number(fs.existsSync(f)?fs.readFileSync(f,'utf8'):0);fs.writeFileSync(f,String(count+1));
process.stdout.write(JSON.stringify({{errors:{}&&count>0?['candidate failure']:[],space:'s',tab:'t',focused_pane:'p'}}));
"#,fail_after)).unwrap();
    #[cfg(windows)]
    {
        let wrapper = root.join("fake-app.cmd");
        fs::write(
            &wrapper,
            format!("@echo off\r\nnode \"{}\" %*\r\n", script.display()),
        )
        .unwrap();
        wrapper
    }
    #[cfg(not(windows))]
    {
        let wrapper = root.join("fake-app");
        fs::write(
            &wrapper,
            format!("#!/bin/sh\nexec node '{}' \"$@\"\n", script.display()),
        )
        .unwrap();
        chmod(&wrapper, 0o755).unwrap();
        wrapper
    }
}
#[test]
fn updater_verifies_candidate_without_changing_focus() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    put(&app, "mods/sixfold-desk/main.js", "old");
    put(&app, "mods/sixfold-desk/local.js", "keep");
    let cli = fake_cli(temp.path(), false);
    let receipt = update::update(
        &repo,
        &app,
        &["mods/sixfold-desk/main.js".into()],
        cli.to_str().unwrap(),
        3.,
        false,
        &[],
    )
    .unwrap();
    assert_eq!(
        read_json(receipt.join("receipt.json")).unwrap()["phase"],
        "verified"
    );
    assert_eq!(
        text(app.join("mods/sixfold-desk/main.js")).unwrap(),
        "import './model.js';"
    );
    assert_eq!(
        text(app.join("mods/sixfold-desk/local.js")).unwrap(),
        "keep"
    );
}
#[test]
fn unhealthy_candidate_rolls_back_selected_mod() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    put(&app, "mods/sixfold-desk/main.js", "old");
    put(&app, "mods/sixfold-desk/local.js", "keep");
    let cli = fake_cli(temp.path(), true);
    let error = update::update(
        &repo,
        &app,
        &["mods/sixfold-desk/main.js".into()],
        cli.to_str().unwrap(),
        1.5,
        false,
        &[],
    )
    .unwrap_err();
    assert!(error.to_string().contains("rolled_back"), "{error}");
    assert_eq!(text(app.join("mods/sixfold-desk/main.js")).unwrap(), "old");
    assert_eq!(
        text(app.join("mods/sixfold-desk/local.js")).unwrap(),
        "keep"
    );
    let receipts = fs::read_dir(app.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| read_json(e.path().join("receipt.json")).ok())
        .collect::<Vec<Value>>();
    assert_eq!(receipts[0]["phase"], "rolled_back");
}
#[test]
fn repository_paths_never_escape_or_seed_over_user_values() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    put(
        &repo,
        "config/templates/settings.json",
        r#"{"zoom":1,"nested":{"keep":"default","added":true}}"#,
    );
    put(
        &app,
        "settings.json",
        r#"{"zoom":2,"nested":{"keep":"mine"}}"#,
    );
    let entries =
        update::input_files(&repo, &app, &["config/templates/settings.json".into()]).unwrap();
    assert_eq!(entries[0].0, PathBuf::from("settings.json"));
    assert_eq!(
        serde_json::from_slice::<Value>(&entries[0].1).unwrap(),
        json!({"zoom":2,"nested":{"keep":"mine","added":true}})
    );
    for name in [
        "../outside",
        "config/local-secrets.json",
        "mods/recovery-copy/main.js",
    ] {
        assert!(update::input_files(&repo, &app, &[name.into()]).is_err());
    }
}
#[test]
fn base_installer_migrates_exact_owned_helper_configs_and_keeps_user_fields() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    atomic_json(
        app.join("data/sixfold/routing.json"),
        &json!({"script":repo.join("scripts/route.py"),"enabled":true,"custom":{"keep":1}}),
    )
    .unwrap();
    atomic_json(app.join("data/sixfold/collaboration.json"),&json!({"script":app.join("scripts/sixfold/collaborate.py"),"enabled":false,"custom":"preserved"})).unwrap();
    atomic_json(
        app.join("data/sixfold/voice-integration.json"),
        &json!({"script":repo.join("voice/focus_queue.py"),"custom":"voice-preserved"}),
    )
    .unwrap();
    install::base_install(&repo, &app, false, &[]).unwrap();
    for (name, stem) in [
        ("routing.json", "route"),
        ("collaboration.json", "collaborate"),
        ("voice-integration.json", "focus_queue"),
    ] {
        let value = read_json(app.join("data/sixfold").join(name)).unwrap();
        assert!(value.get("script").is_none());
        assert_eq!(value["command"][1], stem);
        assert_eq!(
            Path::new(s(&value["command"][0]))
                .components()
                .collect::<PathBuf>(),
            app.join("scripts/sixfold")
                .join(install::native_name())
                .components()
                .collect::<PathBuf>()
        );
    }
    assert_eq!(
        read_json(app.join("data/sixfold/routing.json")).unwrap()["custom"],
        json!({"keep":1})
    );
    assert_eq!(
        read_json(app.join("data/sixfold/collaboration.json")).unwrap()["enabled"],
        false
    );
    assert_eq!(
        read_json(app.join("data/sixfold/voice-integration.json")).unwrap()["custom"],
        "voice-preserved"
    );
}
#[test]
fn installer_preserves_external_same_name_scripts_and_existing_native_commands_verbatim() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    let values = [
        (
            "routing.json",
            json!({"script":temp.path().join("custom/scripts/route.py"),"custom":1}),
        ),
        (
            "collaboration.json",
            json!({"script":temp.path().join("custom/scripts/sixfold/collaborate.py"),"custom":2}),
        ),
        (
            "voice-integration.json",
            json!({"command":["other-native-helper","focus_queue"],"custom":3}),
        ),
    ];
    for (name, value) in &values {
        put(&app, &format!("data/sixfold/{name}"), &value.to_string())
    }
    let before = values
        .iter()
        .map(|(name, _)| {
            (
                *name,
                fs::read(app.join("data/sixfold").join(name)).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    install::base_install(&repo, &app, false, &[]).unwrap();
    for (name, bytes) in before {
        assert_eq!(
            fs::read(app.join("data/sixfold").join(name)).unwrap(),
            bytes,
            "{name}"
        );
    }
}
#[test]
fn updater_migrates_owned_configs_and_installs_native_runtime_in_its_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    put(&app, "mods/sixfold-desk/main.js", "old");
    atomic_json(
        app.join("data/sixfold/routing.json"),
        &json!({"script":repo.join("scripts/route.py"),"user":"kept"}),
    )
    .unwrap();
    atomic_json(
        app.join("data/sixfold/collaboration.json"),
        &json!({"script":app.join("scripts/sixfold/collaborate.py"),"enabled":true}),
    )
    .unwrap();
    let external =
        json!({"script":temp.path().join("custom/scripts/voice/focus_queue.py"),"user":"external"})
            .to_string();
    put(&app, "data/sixfold/voice-integration.json", &external);
    let cli = fake_cli(temp.path(), false);
    let backup = update::update(
        &repo,
        &app,
        &["mods/sixfold-desk/main.js".into()],
        cli.to_str().unwrap(),
        3.,
        false,
        &[],
    )
    .unwrap();
    let routing = read_json(app.join("data/sixfold/routing.json")).unwrap();
    assert_eq!(routing["command"][1], "route");
    assert_eq!(routing["user"], "kept");
    assert!(routing.get("script").is_none());
    assert!(app
        .join("scripts/sixfold")
        .join(install::native_name())
        .is_file());
    assert_eq!(
        text(app.join("data/sixfold/voice-integration.json")).unwrap(),
        external
    );
    let receipt = read_json(backup.join("receipt.json")).unwrap();
    assert_eq!(receipt["phase"], "verified");
    for (name, bytes) in herdr_theme::notices::files() {
        let relative = Path::new("scripts/sixfold/native-licenses").join(name);
        assert_eq!(fs::read(app.join(&relative)).unwrap(), *bytes);
        assert!(arr(&receipt["files"]).contains(&json!(relative)));
    }
    for relative in [
        PathBuf::from("data/sixfold/routing.json"),
        PathBuf::from("data/sixfold/collaboration.json"),
        Path::new("scripts/sixfold").join(install::native_name()),
    ] {
        assert!(arr(&receipt["files"]).contains(&json!(relative)));
    }
}
#[test]
fn updater_rolls_back_config_migrations_and_native_runtime_with_unhealthy_candidate() {
    let temp = tempfile::tempdir().unwrap();
    let repo = source(temp.path());
    let app = temp.path().join("app");
    put(&app, "mods/sixfold-desk/main.js", "old");
    let original = json!({"script":repo.join("scripts/route.py"),"user":"original"}).to_string();
    put(&app, "data/sixfold/routing.json", &original);
    let binary = app.join("scripts/sixfold").join(install::native_name());
    atomic_bytes(&binary, b"original native runtime").unwrap();
    let cli = fake_cli(temp.path(), true);
    let error = update::update(
        &repo,
        &app,
        &["mods/sixfold-desk/main.js".into()],
        cli.to_str().unwrap(),
        1.5,
        false,
        &[],
    )
    .unwrap_err();
    assert!(error.to_string().contains("rolled_back"), "{error}");
    assert_eq!(
        text(app.join("data/sixfold/routing.json")).unwrap(),
        original
    );
    assert_eq!(fs::read(binary).unwrap(), b"original native runtime");
    assert_eq!(text(app.join("mods/sixfold-desk/main.js")).unwrap(), "old");
    let receipt = fs::read_dir(app.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok())
        .find_map(|e| read_json(e.path().join("receipt.json")).ok())
        .unwrap();
    assert_eq!(receipt["phase"], "rolled_back");
    assert!(
        arr(&receipt["files"]).contains(&json!(PathBuf::from("data/sixfold/routing.json"))),
        "the config migration must have participated in rollback"
    );
}
