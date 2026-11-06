//! Original portable helper cases, with native child processes in place of
//! the Python interpreter. Every file and lock belongs to a scratch directory.
use herdr_theme::locking::FileLock;
use serde_json::json;
use std::{fs, process::Command};

#[test]
fn test_document_index_is_utf8_even_without_python_utf8_mode() {
    const CHILD: &str = "HERDR_ORIGINAL_UTF8_INDEX";
    if let Some(path) = std::env::var_os(CHILD) {
        herdr_theme::documents::common::atomic_json(
            std::path::PathBuf::from(path),
            &json!({"text":"한📄"}),
        )
        .unwrap();
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("index.json");
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "test_document_index_is_utf8_even_without_python_utf8_mode",
        ])
        .env(CHILD, &path)
        .env("PYTHONUTF8", "0")
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    let utf8 = String::from_utf8(fs::read(path).unwrap()).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&utf8).unwrap(),
        json!({"text":"한📄"})
    );
}

#[test]
fn test_lock_contends_across_processes_and_keeps_owner_readable() {
    const CHILD: &str = "HERDR_ORIGINAL_LOCK_PATH";
    if let Some(path) = std::env::var_os(CHILD) {
        let file = fs::OpenOptions::new()
            .append(true)
            .read(true)
            .open(path)
            .unwrap();
        // The original child exits nonzero with BlockingIOError. The native
        // error kind is the matching WouldBlock, without an interpreter.
        let error = FileLock::try_lock_exclusive(&file).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
        eprintln!("WouldBlock");
        std::process::exit(1);
    }
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owner.json");
    fs::write(&path, b"{\"owner\":\"test\"}").unwrap();
    {
        let file = fs::OpenOptions::new()
            .append(true)
            .read(true)
            .open(&path)
            .unwrap();
        FileLock::try_lock_exclusive(&file).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"owner\":\"test\"}");
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "test_lock_contends_across_processes_and_keeps_owner_readable",
                "--nocapture",
            ])
            .env(CHILD, &path)
            .output()
            .unwrap();
        assert!(!child.status.success());
        assert!(String::from_utf8_lossy(&child.stderr).contains("WouldBlock"));
    }
    let file = fs::OpenOptions::new()
        .append(true)
        .read(true)
        .open(path)
        .unwrap();
    FileLock::try_lock_exclusive(&file).unwrap();
    herdr_theme::locking::unlock(&file).unwrap();
}
