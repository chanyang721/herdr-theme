//! The original subprocess deadline receives a float without rounding to seconds.
use serde_json::Value;
use std::{
    fs,
    process::Command,
    time::{Duration, Instant},
};
#[test]
fn fractional_scan_deadlines_and_error_json_match_the_untouched_original() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/scan-fractional-timeout.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let temp = tempfile::tempdir().unwrap();
        let collector = temp.path().join("collector.mjs");
        let store = temp.path().join("never-written.json");
        fs::write(&collector, "setTimeout(()=>{},2000);\n").unwrap();
        let timeout = case["timeout"].as_f64().unwrap();
        assert_eq!(timeout, case["subprocess_timeout"].as_f64().unwrap());
        let begin = Instant::now();
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .args(["pinned_scan_insights", "--collector"])
            .arg(&collector)
            .arg("--store")
            .arg(&store)
            .args(["--timeout", &timeout.to_string()])
            .output()
            .unwrap();
        let elapsed = begin.elapsed();
        assert_eq!(out.status.code().map(i64::from), case["exit"].as_i64());
        assert_eq!(
            out.stdout,
            herdr_theme::common::text_bytes(case["stdout"].as_str().unwrap())
        );
        assert!(out.stderr.is_empty());
        assert!(!store.exists());
        if timeout == 0.05 {
            assert!(
                elapsed < Duration::from_millis(750),
                "50ms deadline rounded up or blocked: {elapsed:?}"
            );
        }
    }
}
