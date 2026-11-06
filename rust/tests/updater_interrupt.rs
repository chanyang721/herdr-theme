//! Real SIGINT/isolated-console Ctrl-C; no live app/agent or other console touched.
use herdr_theme::documents::common::*;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn put(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}
fn send_interrupt(
    root: &Path,
    args: &[String],
    app: &Path,
    ready: Option<&Path>,
    original: bool,
) -> Value {
    let (binary, args) = if original {
        let binary = PathBuf::from(
            std::env::var_os("HERDR_THEME_ORACLE_PYTHON")
                .expect("external original Python required"),
        );
        let scripts = PathBuf::from(
            std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS")
                .expect("archived original scripts required"),
        );
        let mut original_args = vec![
            "-X".into(),
            "utf8".into(),
            scripts
                .join(format!("{}.py", args[0]))
                .to_string_lossy()
                .into_owned(),
        ];
        original_args.extend_from_slice(&args[1..]);
        (binary, original_args)
    } else {
        (
            PathBuf::from(env!("CARGO_BIN_EXE_herdr-theme")),
            args.to_vec(),
        )
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let mut child = Command::new(&binary)
            .args(&args)
            .env("HERDR_APP_HOME", app)
            .stdout(fs::File::create(root.join("stdout")).unwrap())
            .stderr(fs::File::create(root.join("stderr")).unwrap())
            .spawn()
            .unwrap();
        let begin = Instant::now();
        if let Some(ready) = ready {
            while !ready.exists() {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "worker exited before readiness"
                );
                assert!(begin.elapsed() < Duration::from_secs(25));
                std::thread::sleep(Duration::from_millis(20));
            }
        } else {
            std::thread::sleep(Duration::from_millis(500));
            assert!(child.try_wait().unwrap().is_none());
        }
        assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
        let status = child.wait().unwrap();
        json!({"code":status.code(),"signal":status.signal(),"stdout":fs::read_to_string(root.join("stdout")).unwrap(),"stderr":fs::read_to_string(root.join("stderr")).unwrap()})
    }
    #[cfg(windows)]
    {
        let driver = root.join("driver.ps1");
        let launcher = root.join("launcher.ps1");
        fs::write(
            &driver,
            include_str!("fixtures/console-interrupt-driver.ps1"),
        )
        .unwrap();
        fs::write(
            &launcher,
            include_str!("fixtures/console-interrupt-launcher.ps1"),
        )
        .unwrap();
        let result = root.join("signal-result.json");
        let config = root.join("signal-config.json");
        fs::write(&config,json!({"binary":binary,"arguments":args,"environment":{"HERDR_APP_HOME":app},"ready":ready,"result":result}).to_string()).unwrap();
        let output = command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&launcher)
            .arg(&driver)
            .arg(&config)
            .output()
            .unwrap();
        let receipt = read_json(&result).unwrap_or_else(|_| {
            panic!(
                "console driver status {}; stdout={}; stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        });
        assert!(
            output.status.success(),
            "isolated console did not complete: {receipt}; {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(receipt["signalSent"], true);
        assert!(receipt["driverError"].is_null());
        receipt
    }
}
#[test]
fn actual_ctrl_c_during_verification_rolls_back_like_original_keyboard_interrupt() {
    interrupt_updater(false)
}
#[test]
#[ignore = "manual comparison requires archived original updater and external Python"]
fn actual_ctrl_c_original_updater_matches_the_same_rollback_and_exit_contract() {
    interrupt_updater(true)
}
fn interrupt_updater(original_cli: bool) {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let app = root.path().join("app");
    fs::create_dir_all(repo.join("layouts")).unwrap();
    put(&repo.join("mods/demo/main.js"), "candidate mod");
    put(&app.join("mods/demo/main.js"), "original mod");
    put(&repo.join("themes/demo.json"), "{\"color\":\"candidate\"}");
    put(&app.join("themes/demo.json"), "{\"color\":\"original\"}");
    let ready = root.path().join("verification-ready");
    let script = root.path().join("app.mjs");
    let schema = json!({"counter":root.path().join("counter"),"ready":ready});
    fs::write(&script,format!(r#"import fs from 'node:fs';const c={schema},args=process.argv.slice(2);if(args[0]==='check'){{console.log('{{}}');process.exit(0);}}if(args[0]!=='status')process.exit(9);const n=Number(fs.existsSync(c.counter)?fs.readFileSync(c.counter,'utf8'):0);fs.writeFileSync(c.counter,String(n+1));if(n===1){{fs.writeFileSync(c.ready,'candidate verification');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,12000);}}console.log(JSON.stringify({{errors:[],space:'original-space',tab:'original-tab',focused_pane:'original-pane'}}));"#)).unwrap();
    #[cfg(windows)]
    let cli = {
        let p = root.path().join("app.cmd");
        fs::write(
            &p,
            format!("@echo off\r\nnode \"{}\" %*\r\n", script.display()),
        )
        .unwrap();
        p
    };
    #[cfg(unix)]
    let cli = {
        let p = root.path().join("fake-app");
        fs::write(
            &p,
            format!("#!/bin/sh\nexec node '{}' \"$@\"\n", script.display()),
        )
        .unwrap();
        chmod(&p, 0o755).unwrap();
        p
    };
    let args = vec![
        "update_install".into(),
        "--repo".into(),
        repo.to_string_lossy().into_owned(),
        "--home".into(),
        app.to_string_lossy().into_owned(),
        "--cli".into(),
        cli.to_string_lossy().into_owned(),
        "--without-workspace-mods".into(),
        "--verify-timeout".into(),
        "20".into(),
        "mods/demo/main.js".into(),
        "themes/demo.json".into(),
    ];
    let outcome = send_interrupt(root.path(), &args, &app, Some(&ready), original_cli);
    let original: Value =
        serde_json::from_str(include_str!("fixtures/updater-interrupt-original.json")).unwrap();
    assert_eq!(outcome["code"], original["exit"]);
    assert_eq!(outcome["stdout"], original["stdout"]);
    let receipt = fs::read_dir(app.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok())
        .find_map(|e| {
            read_json(e.path().join("receipt.json"))
                .ok()
                .map(|v| (e.path().join("receipt.json"), v))
        })
        .unwrap();
    let stderr = outcome["stderr"]
        .as_str()
        .unwrap()
        .replace("\r\n", "\n")
        .replace(resolved(&receipt.0).to_str().unwrap(), "<receipt>");
    assert_eq!(stderr, original["stderr"]);
    assert_eq!(receipt.1["phase"], original["phase"]);
    assert_eq!(receipt.1["failure"], original["failure"]);
    assert_eq!(
        receipt.1["rollback_conflicts"],
        original["rollback_conflicts"]
    );
    assert_eq!(receipt.1["rollback_status"], original["rollback_status"]);
    assert_eq!(
        fs::read_to_string(app.join("mods/demo/main.js")).unwrap(),
        original["mod"]
    );
    assert_eq!(
        read_json(app.join("themes/demo.json")).unwrap(),
        original["theme"]
    );
}
#[test]
fn other_document_commands_keep_default_os_interrupt_behavior() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("app");
    let config = root.path().join("pins.json");
    let file = root.path().join("note.md");
    put(&file, "public test note");
    atomic_json(
        &config,
        &json!({"version":1,"spaces":{"test":{"folders":[],"pins":[]}}}),
    )
    .unwrap();
    let before = fs::read(&config).unwrap();
    let _locked = lock(config.with_extension("lock"), false).unwrap();
    let args = vec![
        "resolve_doc_pins".into(),
        "--config".into(),
        config.to_string_lossy().into_owned(),
        "--space".into(),
        "test".into(),
        "--pin".into(),
        file.to_string_lossy().into_owned(),
    ];
    let outcome = send_interrupt(root.path(), &args, &app, None, false);
    #[cfg(unix)]
    assert_eq!(outcome["signal"], libc::SIGINT);
    #[cfg(windows)]
    assert_eq!(
        outcome["code"], -1073741510i64,
        "normal CTRL_C_EVENT termination is STATUS_CONTROL_C_EXIT"
    );
    assert_eq!(fs::read(config).unwrap(), before);
}
