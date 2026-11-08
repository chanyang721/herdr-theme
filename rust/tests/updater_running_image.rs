//! Actual mapped executable replacement; every process and file is test-owned.
use herdr_theme::documents::{common::*, install, update};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
fn put(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}
fn wait(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "missing {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn running_native_helper_child() {
    let Some(directory) = std::env::var_os("HERDR_TEST_MAPPED_CONTROL") else {
        return;
    };
    let directory = PathBuf::from(directory);
    #[cfg(windows)]
    let _locked = std::env::var_os("HERDR_TEST_LOCK_TARGET").map(|path| {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(path)
            .unwrap()
    });
    // Readers use existence as the readiness signal. Publish only after the
    // whole record is written; create-then-write exposes an empty JSON file.
    let ready = directory.join("ready.pending");
    fs::write(&ready, json!({"pid":std::process::id(),"image_sha256":hash(fs::read(std::env::current_exe().unwrap()).unwrap()),"locked_target":std::env::var_os("HERDR_TEST_LOCK_TARGET").map(PathBuf::from)}).to_string()).unwrap();
    fs::rename(ready, directory.join("ready")).unwrap();
    let begin = Instant::now();
    while !directory.join("release").exists() && begin.elapsed() < Duration::from_secs(45) {
        std::thread::sleep(Duration::from_millis(20));
    }
    fs::write(directory.join("done"), b"exited").unwrap();
}
struct Running {
    control: PathBuf,
    child: Option<Child>,
}
impl Running {
    fn start(executable: &Path, control: PathBuf) -> Self {
        fs::create_dir_all(&control).unwrap();
        let mut child = Command::new(executable)
            .args(["--exact", "running_native_helper_child", "--nocapture"])
            .env("HERDR_TEST_MAPPED_CONTROL", &control)
            .stdin(Stdio::null())
            .stdout(fs::File::create(control.join("stdout.log")).unwrap())
            .stderr(fs::File::create(control.join("stderr.log")).unwrap())
            .spawn()
            .unwrap();
        let begin = Instant::now();
        while !control.join("ready").exists() {
            let exit = child.try_wait().unwrap();
            assert!(
                exit.is_none() && begin.elapsed() < Duration::from_secs(20),
                "mapped child startup {exit:?}; stdout={}; stderr={}",
                fs::read_to_string(control.join("stdout.log")).unwrap_or_default(),
                fs::read_to_string(control.join("stderr.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            read_json(control.join("ready")).unwrap()["image_sha256"],
            hash(fs::read(executable).unwrap())
        );
        Self {
            control,
            child: Some(child),
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = fs::write(self.control.join("release"), b"stop");
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        } else if self.control.join("ready").exists() {
            let begin = Instant::now();
            while !self.control.join("done").exists() && begin.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
fn fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf, Vec<u8>) {
    let repo = root.join("repo");
    let app = root.join("app");
    put(&repo.join("keys.json"), b"{}");
    fs::create_dir_all(repo.join("layouts")).unwrap();
    fs::create_dir_all(repo.join("themes")).unwrap();
    put(&repo.join("mods/sixfold-desk/main.js"), b"new mod");
    put(
        &repo.join("config/templates/settings.json"),
        br#"{"added":"candidate"}"#,
    );
    put(&app.join("mods/sixfold-desk/main.js"), b"original mod");
    put(&app.join("settings.json"), br#"{"mine":"original"}"#);
    let binary = app.join("scripts/sixfold").join(install::native_name());
    let mut original = fs::read(std::env::current_exe().unwrap()).unwrap();
    original.extend(b"old-image-overlay");
    put(&binary, &original);
    chmod(&binary, 0o755).unwrap();
    (repo, app, binary, original)
}
fn app_cli(root: &Path, binary: &Path, new_control: Option<&Path>, lock: Option<&Path>) -> PathBuf {
    let script = root.join("app.mjs");
    let schema =
        json!({"counter":root.join("samples"),"binary":binary,"control":new_control,"lock":lock});
    fs::write(&script,format!(r#"import fs from 'node:fs';import {{spawn}} from 'node:child_process';
const c={schema},args=process.argv.slice(2);
if(args[0]==='check'){{console.log('{{}}');process.exit(0);}}
if(args[0]!=='status')process.exit(9);
const n=Number(fs.existsSync(c.counter)?fs.readFileSync(c.counter,'utf8'):0);fs.writeFileSync(c.counter,String(n+1));
if(n===1&&c.control){{
 const out=fs.openSync(c.control+'/stdout.log','w'),err=fs.openSync(c.control+'/stderr.log','w');
 const child=spawn(c.binary,['--exact','running_native_helper_child','--nocapture'],{{detached:true,windowsHide:true,stdio:['ignore',out,err],env:{{...process.env,HERDR_TEST_MAPPED_CONTROL:c.control,...(c.lock?{{HERDR_TEST_LOCK_TARGET:c.lock}}:{{}})}}}});child.unref();fs.closeSync(out);fs.closeSync(err);fs.writeFileSync(c.control+'/spawned-pid',String(child.pid));
 const begin=Date.now();while(!fs.existsSync(c.control+'/ready')){{if(Date.now()-begin>15000)throw Error('mapped candidate never ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}
}}
console.log(JSON.stringify({{errors:c.control&&n>0?['forced verification failure']:[],space:'old-space',tab:'old-tab',focused_pane:'old-pane'}}));
"#)).unwrap();
    #[cfg(windows)]
    {
        let path = root.join("app.cmd");
        fs::write(
            &path,
            format!("@echo off\r\nnode \"{}\" %*\r\n", script.display()),
        )
        .unwrap();
        path
    }
    #[cfg(not(windows))]
    {
        let path = root.join("fake-app");
        fs::write(
            &path,
            format!("#!/bin/sh\nexec node '{}' \"$@\"\n", script.display()),
        )
        .unwrap();
        chmod(&path, 0o755).unwrap();
        path
    }
}
#[test]
fn update_replaces_a_running_installed_native_image() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, app, binary, original) = fixture(temp.path());
    let unrelated = binary
        .parent()
        .unwrap()
        .join(format!(".{}.replaced-user-owned", install::native_name()));
    fs::write(&unrelated, b"unrelated user-owned file").unwrap();
    let _running = Running::start(&binary, temp.path().join("old"));
    let cli = app_cli(temp.path(), &binary, None, None);
    let receipt = update::update(
        &repo,
        &app,
        &[format!("scripts/{}", install::native_name())],
        cli.to_str().unwrap(),
        3.,
        false,
        &[],
    )
    .unwrap();
    assert_ne!(fs::read(&binary).unwrap(), original);
    assert_eq!(
        fs::read(&unrelated).unwrap(),
        b"unrelated user-owned file",
        "a matching prefix does not establish ownership"
    );
    assert_eq!(
        fs::read(&binary).unwrap(),
        fs::read(std::env::current_exe().unwrap()).unwrap()
    );
    assert_eq!(
        read_json(receipt.join("receipt.json")).unwrap()["phase"],
        "verified"
    );
}
#[test]
fn reinstall_replaces_a_running_installed_native_image() {
    let temp = tempfile::tempdir().unwrap();
    let (repo, app, binary, _) = fixture(temp.path());
    let _running = Running::start(&binary, temp.path().join("old"));
    install::base_install(&repo, &app, true, &[]).unwrap();
    assert_eq!(
        fs::read(&binary).unwrap(),
        fs::read(std::env::current_exe().unwrap()).unwrap()
    );
}
fn rollback_with_running_candidate(lock_settings: bool) {
    let temp = tempfile::tempdir().unwrap();
    let (repo, app, binary, original) = fixture(temp.path());
    let _old = Running::start(&binary, temp.path().join("old"));
    let control = temp.path().join("new");
    fs::create_dir_all(&control).unwrap();
    let mut candidate = Running {
        control: control.clone(),
        child: None,
    };
    let locked = app.join("settings.json");
    let cli = app_cli(
        temp.path(),
        &binary,
        Some(&control),
        lock_settings.then_some(locked.as_path()),
    );
    let result = update::update(
        &repo,
        &app,
        &[
            "mods/sixfold-desk/main.js".into(),
            format!("scripts/{}", install::native_name()),
            "config/templates/settings.json".into(),
        ],
        cli.to_str().unwrap(),
        1.5,
        false,
        &[],
    );
    assert!(result.is_err());
    let ready: Value = read_json(control.join("ready")).unwrap();
    assert_eq!(
        ready["image_sha256"],
        hash(fs::read(std::env::current_exe().unwrap()).unwrap()),
        "verification must have started the candidate, not the previous image"
    );
    assert_eq!(
        ready["pid"].as_u64().unwrap().to_string(),
        fs::read_to_string(control.join("spawned-pid")).unwrap()
    );
    assert!(
        !control.join("done").exists(),
        "candidate remains alive through rollback"
    );
    let receipt = fs::read_dir(app.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok())
        .find_map(|e| read_json(e.path().join("receipt.json")).ok())
        .unwrap();
    assert_eq!(
        receipt["phase"],
        if lock_settings {
            "rollback_conflict"
        } else {
            "rolled_back"
        }
    );
    assert_eq!(
        fs::read(&binary).unwrap(),
        original,
        "old image restored while candidate is still mapped"
    );
    assert_eq!(
        fs::read(app.join("mods/sixfold-desk/main.js")).unwrap(),
        b"original mod"
    );
    if lock_settings {
        assert!(arr(&receipt["rollback_conflicts"]).contains(&json!("settings.json")));
        assert!(arr(&receipt["rollback_errors"])
            .iter()
            .any(|e| e["target"] == "settings.json"));
    } else {
        assert_eq!(
            fs::read(app.join("settings.json")).unwrap(),
            br#"{"mine":"original"}"#
        );
    }
    assert!(receipt["rollback_status"].is_object());
    // End the mapped candidate before the scratch tree is removed.
    fs::write(control.join("release"), b"stop").unwrap();
    wait(&control.join("done"));
    candidate.child = None;
}
#[test]
fn rollback_restores_the_old_native_image_while_the_candidate_is_running() {
    rollback_with_running_candidate(false)
}
#[cfg(windows)]
#[test]
fn rollback_records_a_locked_data_file_and_still_restores_the_running_image_and_mod() {
    rollback_with_running_candidate(true)
}
