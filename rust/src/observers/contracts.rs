//! Frozen calls recorded from the original Python lifecycle test suite at baseline
//! 8c5b71d. Tests here use fixture data only and never need a Python interpreter.
use super::*;
fn argv(v: &Value) -> Vec<String> {
    arr(v).iter().map(|v| s(v).to_owned()).collect()
}
fn evaluate(c: &Value) -> Result<Value> {
    let a = &c["args"];
    match s(&c["fn"]) {
        "codex_log" => Ok(json!(jobs::codex_log(&arr(&a[0]))?)),
        "claude_log" => {
            jobs::claude_log(
                &arr(&a[0]),
                s(&a[1]),
                a[2].as_bool()
                    .or(c["kwargs"]["finished_by_meta"].as_bool())
                    .unwrap_or(false),
            )?;
            Ok(Value::Null)
        }
        "empty_prompt" => Ok(json!(spaces::empty_prompt(s(&a[0]), s(&a[1])))),
        "decision_pending" => Ok(json!(spaces::decision_pending(s(&a[0])))),
        "background_running" => Ok(json!(spaces::background_running(s(&a[0])))),
        "fixed" => Ok(json!(spaces::fixed(&a[0], &a[1]))),
        "in_float" => Ok(json!(sleep::in_float(s(&a[0]), &a[1]))),
        "is_helper" => Ok(json!(sessions::is_helper(&a[0]))),
        "resume_argv" => Ok(json!(sessions::resume_argv(
            s(&a[0]),
            &argv(&a[1]),
            s(&a[2])
        )?)),
        "new_session_argv" => Ok(json!(sessions::new_session_argv(s(&a[0]), &argv(&a[1]))?)),
        "prompt_cells" => Ok(json!(sessions::prompt_cells(
            s(&a[0]),
            a[1].as_str()
                .or(c["kwargs"]["marker"].as_str())
                .unwrap_or("❯")
        ))),
        "suggestion_only" => Ok(json!(sessions::suggestion_only(s(&a[0]), s(&a[1])))),
        "trial_of" => Ok(sessions::trial_of(&a[0], num(&a[1], 0.), truth(&a[2]))),
        "process_evidence" => Ok(json!(sessions::process_evidence(&a[0], &a[1]))),
        "mask_text" => Ok(json!(sessions::mask_text(s(&a[0]), &argv(&a[1])))),
        "stub_launch" => Ok(json!(stub::launch(&a[0]))),
        "stub_command" => Ok(json!(stub::command_of(&a[0], s(&a[1])))),
        "stub_shown" => Ok(json!(stub::shown(
            &argv(&a[0]),
            a[1].as_u64()
                .or(c["kwargs"]["limit"].as_u64())
                .unwrap_or(72) as usize
        ))),
        other => err(format!("unknown fixture function {other}")),
    }
}
fn equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| equivalent(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| equivalent(v, w)))
        }
        _ => a == b,
    }
}
#[test]
fn frozen_python_lifecycle_contracts() {
    let cases: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/observer-contracts.json")).unwrap();
    let mut failures = vec![];
    for (index, c) in arr(&cases).iter().enumerate() {
        let actual = evaluate(c);
        if let Some(expected) = c["error"].as_str() {
            match actual {
                Err(e) if e.to_string() == expected => {}
                other => failures.push(format!(
                    "case {index} {} expected error {expected:?}; got {other:?}",
                    s(&c["fn"])
                )),
            }
        } else {
            match actual {
                Ok(v) if equivalent(&v, &c["value"]) => {}
                other => failures.push(format!(
                    "case {index} {} expected {}; got {other:?}",
                    s(&c["fn"]),
                    c["value"]
                )),
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

struct Fake {
    snapshot: Value,
    text: String,
    raw: String,
    mapping: Value,
    jobs: (bool, String, String),
    calls: Vec<String>,
    reported: bool,
    park_ok: bool,
    final_park_ok: bool,
    closed_ok: bool,
}
impl Fake {
    fn fixture(c: &Value) -> Self {
        Self {
            snapshot: c["snapshot"].clone(),
            text: s(&c["text"]).into(),
            raw: s(&c["raw"]).into(),
            mapping: c["mapping"].clone(),
            jobs: (
                truth(&c["jobs"][0]),
                s(&c["jobs"][1]).into(),
                s(&c["jobs"][2]).into(),
            ),
            calls: vec![],
            reported: false,
            park_ok: true,
            final_park_ok: true,
            closed_ok: true,
        }
    }
}
impl Adapter for Fake {
    fn snapshot(&mut self) -> Result<Value> {
        Ok(self.snapshot.clone())
    }
    fn screen(&mut self, _: &str) -> Result<String> {
        Ok(self.text.clone())
    }
    fn styled_screen(&mut self, _: &str) -> Result<String> {
        Ok(self.raw.clone())
    }
    fn terminal(&mut self, _: &str) -> Result<Value> {
        Ok(json!({"foreground":{"argv":["zsh"],"name":"zsh"}}))
    }
    fn request_report(&mut self, address: &str, _: &str) -> Result<()> {
        self.calls.push(format!("ask:{address}"));
        Ok(())
    }
    fn keys(&mut self, address: &str, _: &[String]) -> Result<()> {
        self.calls.push(format!("keys:{address}"));
        Ok(())
    }
    fn label(&mut self, address: &str, _: &Value) -> Result<()> {
        self.calls.push(format!("label:{address}"));
        Ok(())
    }
    fn close_pane(&mut self, pane: &str) -> Result<()> {
        self.calls.push(format!("close:{pane}"));
        if self.closed_ok {
            let mut gone = vec![];
            for space in self.snapshot["spaces"].as_array_mut().unwrap() {
                for tab in space["tabs"].as_array_mut().unwrap() {
                    tab["terminals"].as_array_mut().unwrap().retain(|t| {
                        if sleep::pane_id(t) == pane {
                            gone.push(s(&t["terminal"]).to_owned());
                            false
                        } else {
                            true
                        }
                    })
                }
            }
            for a in gone {
                self.snapshot["terminals"]
                    .as_object_mut()
                    .unwrap()
                    .remove(&a);
            }
        }
        Ok(())
    }
    fn close_space(&mut self, space: &str, _: &Value) -> Result<()> {
        self.calls.push(format!("close-space:{space}"));
        self.snapshot["spaces"]
            .as_array_mut()
            .unwrap()
            .retain(|s| s["id"] != space);
        Ok(())
    }
    fn mapping(&mut self, _: &Value, _: &Value) -> Result<Value> {
        Ok(self.mapping.clone())
    }
    fn session_mapping(&mut self, _: &Value, _: &Value) -> Result<Value> {
        Ok(self.mapping.clone())
    }
    fn child(&mut self, _: &Value) -> Result<Value> {
        Ok(Value::Null)
    }
    fn backend(&mut self, _: &Value, _: &Value, _: bool) -> (bool, String, String) {
        self.jobs.clone()
    }
    fn git(&mut self, _: &str) -> Value {
        json!({"branch":"main","head":"abc1234","uncommitted":1,"worktrees":1})
    }
    fn park(&mut self, _: &Value, item: &Value, event: &str, dry: bool, _: &str) -> Result<Value> {
        self.calls
            .push(format!("park:{event}:{}:{dry}", s(&item["address"])));
        if self.park_ok && (event != "closed" || self.final_park_ok) {
            Ok(json!("REC1"))
        } else {
            err("harness refused")
        }
    }
    fn close_status(&mut self, _: &Value, _: &Value, _: &str) -> Result<Value> {
        if self.reported {
            Ok(json!({"report_id":"REP1","task_id":"TASK1"}))
        } else {
            err("no close report yet")
        }
    }
    fn close_gate(&mut self, _: &Value, item: &Value) -> Result<Value> {
        self.calls.push(format!("gate:{}", s(&item["address"])));
        Ok(json!({"ok":true}))
    }
    fn archive(&mut self, _: &Value, _: &Value) -> Result<Value> {
        self.calls.push("archive".into());
        Ok(json!("ARCH.json"))
    }
    fn machine(&mut self) -> Result<String> {
        Ok("m".repeat(32))
    }
    fn wait(&mut self, _: f64) {}
}
fn inspect_cases() -> Vec<Value> {
    serde_json::from_str(include_str!("../../tests/fixtures/observer-inspect.json")).unwrap()
}
#[test]
fn frozen_python_inspect_contracts() {
    let mut failures = vec![];
    for c in inspect_cases() {
        let mut a = Fake::fixture(&c);
        let actual = if c["kind"] == "space" {
            spaces::inspect(&c["space"], &c["snapshot"], &mut a, &c["config"])
        } else {
            sleep::inspect(
                s(&c["address"]),
                &c["space"],
                &c["snapshot"],
                &mut a,
                &c["config"],
                &c["tab"],
            )
        };
        match actual {
            Ok(v) => {
                if !equivalent(&v, &c["expected"]) {
                    failures.push(format!(
                        "{} {} expected {}; got {v}",
                        s(&c["kind"]),
                        s(&c["case"]),
                        c["expected"]
                    ))
                }
            }
            Err(e) => failures.push(format!("{} {} errored {e}", s(&c["kind"]), s(&c["case"]))),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn finished_pane_reports_before_closing_and_preserves_others() {
    let c = inspect_cases()
        .into_iter()
        .find(|c| c["kind"] == "sleep" && c["case"] == "normal")
        .unwrap();
    let mut a = Fake::fixture(&c);
    a.reported = true;
    let config = json!({"idle_seconds":1200,"exclude_addresses":["t3"],"user_approved_apply":true,"reviewed_observer_sha256":"code"});
    let mut state = json!({"observer_sha256":"code"});
    let dir = tempfile::tempdir().unwrap();
    let paths = json!({"notes":dir.path().join("notes").to_string_lossy(),"tickets":dir.path().join("tickets").to_string_lossy(),"stub":"native"});
    sleep::cycle(
        &mut a,
        &config,
        &mut state,
        1800000000. - 1200.,
        false,
        &paths,
    )
    .unwrap();
    a.calls.clear();
    state["last_at"] = json!(1800000000. - 300.);
    let observation = sleep::cycle(&mut a, &config, &mut state, 1800000000., true, &paths).unwrap();
    let item = arr(&observation["results"])
        .into_iter()
        .find(|i| i["address"] == "t12")
        .unwrap();
    assert_eq!(item["action"], "closed");
    assert_eq!(
        a.calls,
        vec![
            "park:close_requested:t12:false",
            "close:p12",
            "park:closed:t12:false"
        ]
    );
    assert!(sleep::pane_of(&a.snapshot).contains_key("t3"));
    assert!(sleep::pane_of(&a.snapshot).contains_key("t1"));
}
#[test]
fn denied_park_never_closes_or_exits() {
    let c = inspect_cases()
        .into_iter()
        .find(|c| c["kind"] == "sleep" && c["case"] == "normal")
        .unwrap();
    let mut a = Fake::fixture(&c);
    a.reported = true;
    a.park_ok = false;
    let config = json!({"idle_seconds":1200,"exclude_addresses":["t3"],"user_approved_apply":true,"reviewed_observer_sha256":"code"});
    let mut state = json!({"observer_sha256":"code"});
    let dir = tempfile::tempdir().unwrap();
    let paths =
        json!({"notes":dir.path().to_string_lossy(),"tickets":dir.path().to_string_lossy()});
    sleep::cycle(
        &mut a,
        &config,
        &mut state,
        1800000000. - 1200.,
        false,
        &paths,
    )
    .unwrap();
    a.calls.clear();
    state["last_at"] = json!(1800000000. - 300.);
    sleep::cycle(&mut a, &config, &mut state, 1800000000., true, &paths).unwrap();
    assert!(!a
        .calls
        .iter()
        .any(|c| c.starts_with("close:") || c.starts_with("keys:")));
    assert!(sleep::pane_of(&a.snapshot).contains_key("t12"));
}
#[test]
fn final_space_park_refusal_keeps_confirmed_close_and_completed_cycle() {
    let mut case = inspect_cases()
        .into_iter()
        .find(|c| c["kind"] == "space" && c["case"] == "normal")
        .unwrap();
    for terminal in case["snapshot"]["terminals"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        terminal["cwd"] = Value::Null;
    }
    for space in case["snapshot"]["spaces"].as_array_mut().unwrap() {
        space["folder"] = Value::Null;
    }
    let mut adapter = Fake::fixture(&case);
    adapter.reported = true;
    adapter.final_park_ok = false;
    let mut state = json!({});
    let reports = tempfile::tempdir().unwrap();
    let observation = spaces::cycle(
        &mut adapter,
        &json!({"fixed_names":[],"_manual":true,"close_report":{"enabled":false}}),
        &mut state,
        1800000000.,
        true,
        Some("temporary"),
        reports.path(),
    )
    .unwrap();
    let item = arr(&observation["results"])
        .into_iter()
        .find(|i| i["id"] == "temporary")
        .unwrap();
    let expected: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/observer-final-park.json"
    ))
    .unwrap();
    assert_eq!(item["action"], expected["action"]);
    assert_eq!(item["reasons"], expected["reasons"]);
    assert_eq!(json!(adapter.calls), expected["calls"]);
    assert_eq!(
        json!(state["spaces"].get("temporary").is_none()),
        expected["tracking_removed"]
    );
    assert_eq!(
        json!(arr(&adapter.snapshot["spaces"])
            .iter()
            .map(|s| s["id"].clone())
            .collect::<Vec<_>>()),
        expected["remaining_spaces"]
    );
}
#[test]
fn observer_option_routing_keeps_argparse_equals_last_value_and_abbreviations() {
    let args = normalize_args(
        &strings(&[
            "--core=first",
            "--core",
            "second",
            "--ap",
            "fixture-app",
            "--dry-run",
        ]),
        &["--core", "--app"],
        &["--dry-run"],
    )
    .unwrap();
    assert_eq!(
        spaces::option(&args, "--core", Path::new("default")),
        PathBuf::from("second")
    );
    assert_eq!(
        spaces::option(&args, "--app", Path::new("default")),
        PathBuf::from("fixture-app")
    );
    assert!(normalize_args(
        &strings(&["--co", "anything"]),
        &["--core", "--config"],
        &[]
    )
    .is_err());
    assert!(normalize_args(
        &strings(&["--core", "--dry-run"]),
        &["--core"],
        &["--dry-run"]
    )
    .is_err());
}
#[test]
fn observer_uses_machine_id_none_sentinel_and_site_report_folder() {
    assert_eq!(machine_id(&json!({"core":{}})), "None");
    assert_eq!(
        machine_id(&json!({"core":{"id":"fixture-machine"}})),
        "fixture-machine"
    );
    assert_eq!(
        sessions::harness_archive(
            &json!({"harness":{"command":["fixture-harness"]}}),
            &json!({"workspace_id":"None-fixture-space"})
        )
        .unwrap_err()
        .to_string(),
        "machine id unknown"
    );
    assert_eq!(
        spaces::report_dir(
            &json!({"reports_dir":"~/fixture-reports"}),
            Path::new("/fixture/home")
        ),
        Path::new("/fixture/home/fixture-reports").join("워크스페이스-기록")
    );
    assert_eq!(
        spaces::report_dir(
            &json!({"reports_dir":"/fixture/custom"}),
            Path::new("/unused")
        ),
        Path::new("/fixture/custom").join("워크스페이스-기록")
    );
}
#[test]
fn original_stub_and_sleep_unicode_whitespace_contracts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/observer-stub-whitespace.json"
    ))
    .unwrap();
    for case in cases {
        let actual = match s(&case["kind"]) {
            "message" => stub::message_of(
                &arr(&case["bytes"])
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u8)
                    .collect::<Vec<_>>(),
            ),
            "shown" => stub::shown(
                &argv(&case["argv"]),
                case["limit"].as_u64().unwrap() as usize,
            ),
            "tail" => tail(s(&case["text"]), case["lines"].as_u64().unwrap() as usize),
            _ => panic!("unknown frozen case"),
        };
        assert_eq!(actual, case["expected"].as_str().unwrap(), "{case}");
    }
}
#[test]
fn original_native_ui_argparse_contracts_run_before_any_platform_calls() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/native-ui-args.json")).unwrap();
    for case in cases {
        let actual = super::native_ui::options(&argv(&case["args"]));
        if let Some(expected) = case["error"].as_str() {
            let error = actual.unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<crate::common::CliError>()
                    .unwrap()
                    .code,
                case["code"].as_i64().unwrap() as i32
            );
            assert_eq!(error.to_string(), expected, "{case}");
        } else {
            let (_, reloads, failed) = actual.unwrap();
            assert_eq!(json!(reloads), case["value"]["reloads"]);
            assert_eq!(json!(failed), case["value"]["failed_reloads"]);
        }
    }
}
#[test]
fn original_unicode_safety_gates_preserve_visibility_pins_input_and_dim_resets() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/observer-unicode-safety.json"
    ))
    .unwrap();
    for case in cases {
        assert_eq!(evaluate(&case).unwrap(), case["value"], "{case}");
    }
}
#[test]
fn original_helper_unicode_boundaries_never_exempt_unknown_child_commands() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../tests/fixtures/observer-helper-unicode.json"
    ))
    .unwrap();
    for case in cases {
        assert_eq!(evaluate(&case).unwrap(), case["value"], "{case}");
    }
    let args = normalize_args(
        &strings(&["--app=--apply", "--core=--core", "--dry-run"]),
        &["--app", "--core"],
        &["--apply", "--dry-run"],
    )
    .unwrap();
    assert!(!apply_mode(&args).unwrap());
    assert_eq!(option_value(&args, "--app"), Some("--apply"));
    assert_eq!(option_value(&args, "--core"), Some("--core"));
}
#[cfg(unix)]
#[test]
fn direct_notes_and_tickets_follow_symlinks_and_chmod_target_but_state_replaces_link() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let item = json!({"address":"fixture-pane","app":"codex","session_id":"11111111-2222-3333-4444-555555555555","argv":["codex"],"space_id":"fixture-space"});
    let note = sleep::note(&item, temp.path(), 1800000000.).unwrap();
    let ticket = sleep::ticket(&item, temp.path(), None).unwrap();
    for destination in [PathBuf::from(note), ticket] {
        let target = destination.with_extension("target");
        fs::write(&target, "previous").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_file(&destination).unwrap();
        symlink(&target, &destination).unwrap();
        if destination.file_name().unwrap() == "fixture-pane.json" {
            sleep::ticket(&item, temp.path(), None).unwrap();
        } else {
            sleep::note(&item, temp.path(), 1800000000.).unwrap();
        }
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            load(&target, Value::Null).unwrap()["address"],
            "fixture-pane"
        );
    }
    let target = temp.path().join("state-target");
    let state = temp.path().join("state.json");
    fs::write(&target, "previous").unwrap();
    symlink(&target, &state).unwrap();
    save(&state, &json!({"state":"new"})).unwrap();
    assert!(!fs::symlink_metadata(&state)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_to_string(target).unwrap(), "previous");
    assert_eq!(
        fs::metadata(state).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
