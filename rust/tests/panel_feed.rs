use herdr_theme::panel_feed::{snapshot, MAX_FEED_BYTES};
use serde_json::{json, Value};
use std::fs;
use std::process::Command;

fn feed() -> Value {
    json!({"v":1,"at":"2026-01-01T00:00:00Z","computers":[],"spaces":[],"links":[],"events":[]})
}

#[test]
fn valid_display_data_is_read_without_normalization_or_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.json");
    let mut value = feed();
    value["spaces"] = json!([{"id":"space-demo","name":"데모","agents":[]}]);
    value["extra"] = json!({"preserved":"not interpreted"});
    let bytes = serde_json::to_vec_pretty(&value).unwrap();
    fs::write(&path, &bytes).unwrap();
    let result = snapshot(&path);
    assert_eq!(result["status"], "ready");
    assert_eq!(result["feed"], value);
    assert!(result["reduced_motion"].is_null());
    assert_eq!(fs::read(path).unwrap(), bytes);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn reduced_motion_only_reflects_the_typed_producer_value() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.json");
    for preference in [json!(true), json!(false), Value::Null, json!("true")] {
        let mut value = feed();
        value["reduced_motion"] = preference.clone();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let result = snapshot(&path);
        assert_eq!(result["feed"], value);
        assert_eq!(
            result["reduced_motion"],
            preference.as_bool().map_or(Value::Null, Value::Bool)
        );
    }
}

#[test]
fn missing_feed_does_not_create_files_or_parent_directories() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("absent/panel.json");
    let result = snapshot(&path);
    assert_eq!(result["status"], "missing");
    assert!(result["feed"].is_null());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn partial_unknown_version_and_invalid_shapes_are_neutral_failures() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.json");
    for bytes in [
        b"{\"v\":1,".as_slice(),
        b"{\"v\":2,\"at\":\"now\",\"computers\":[],\"spaces\":[]}",
        b"{\"v\":1,\"at\":\"now\",\"computers\":{},\"spaces\":[]}",
        b"[]",
        b"null",
    ] {
        fs::write(&path, bytes).unwrap();
        let result = snapshot(&path);
        assert_eq!(result["status"], "invalid");
        assert!(result["feed"].is_null());
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn oversized_or_non_file_inputs_are_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.json");
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_FEED_BYTES + 1).unwrap();
    drop(file);
    assert_eq!(snapshot(&path)["status"], "invalid");
    assert_eq!(fs::metadata(&path).unwrap().len(), MAX_FEED_BYTES + 1);
    assert_ne!(snapshot(directory.path())["status"], "ready");
}

#[test]
fn size_boundary_accepts_a_complete_feed_but_not_one_more_byte() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.json");
    let mut bytes = serde_json::to_vec(&feed()).unwrap();
    bytes.resize(MAX_FEED_BYTES as usize, b' ');
    fs::write(&path, &bytes).unwrap();
    assert_eq!(snapshot(&path)["status"], "ready");
    bytes.push(b' ');
    fs::write(&path, &bytes).unwrap();
    assert_eq!(snapshot(&path)["status"], "invalid");
}

#[cfg(unix)]
#[test]
fn a_named_pipe_is_not_opened_as_a_feed() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.pipe");
    let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    assert_eq!(snapshot(&path)["status"], "invalid");
    assert!(path.exists());
}

#[test]
fn native_cli_reads_an_explicit_fixture_with_an_empty_search_path() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("panel.json");
    fs::write(&path, serde_json::to_vec(&feed()).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(["panel-feed", "--path"])
        .arg(&path)
        .env("HERDR_APP_HOME", directory.path().join("unused-home"))
        .env("HERDR_PANEL_FEED", directory.path().join("unused-env.json"))
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["feed"], feed());
    assert_eq!(value["status"], "ready");
    assert!(!directory.path().join("unused-home").exists());
}

#[test]
fn native_cli_missing_snapshot_is_success_and_does_not_write() {
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .arg("panel-feed")
        .env("HERDR_PANEL_FEED", directory.path().join("missing.json"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["status"], "missing");
    assert!(value["feed"].is_null());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}
