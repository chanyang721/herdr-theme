//! Original tests/test_space_job_evidence.py wrapper cases. Test method names,
//! session/log contents, SQLite schemas, times and pass/hold assertions match.
use super::*;
const STAMP: i64 = 1_790_000_000_000;
fn event(kind: &str) -> Value {
    json!({"type":"event_msg","payload":{"type":kind}})
}
fn call(id: &str, name: &str, args: Value) -> Value {
    json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"name":name,"arguments":args}})
}
fn output(id: &str, value: Value) -> Value {
    json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":value}})
}
fn completed() -> Vec<Value> {
    vec![event("task_started"), event("task_complete")]
}
fn lines(records: &[Value]) -> String {
    records
        .iter()
        .map(|r| crate::common::json_text(r, true) + "\n")
        .collect()
}
fn stamp(path: &Path, millis: i64) {
    filetime::set_file_mtime(
        path,
        filetime::FileTime::from_unix_time(millis / 1000, ((millis % 1000) * 1_000_000) as u32),
    )
    .unwrap();
}
struct Codex {
    root: tempfile::TempDir,
    db: PathBuf,
    t: Value,
    c: Value,
}
impl Codex {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let db = root.path().join("state.sqlite");
        rusqlite::Connection::open(&db).unwrap().execute_batch("create table threads(id text primary key, rollout_path text);create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text);").unwrap();
        let f = Self {
            root,
            db: db.clone(),
            t: json!({"address":"fixture-terminal","pid":100,"created_ms":STAMP-100_000,"status_ms":STAMP,"status":{"app":"codex","state":"done"}}),
            c: json!({"codex_db":db,"sessions":{"fixture-terminal":{"pid":100,"created_ms":STAMP-100_000,"session_id":"main-session","agent":"codex"}}}),
        };
        f.log("main-session", completed());
        f
    }
    fn path(&self, id: &str) -> PathBuf {
        self.root.path().join(format!("{id}.jsonl"))
    }
    fn log(&self, id: &str, records: Vec<Value>) -> PathBuf {
        let path = self.path(id);
        let mut all = vec![json!({"type":"session_meta","payload":{"id":id}})];
        all.extend(records);
        fs::write(&path, lines(&all)).unwrap();
        stamp(&path, STAMP);
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .execute(
                "insert or replace into threads values(?,?)",
                rusqlite::params![id, path.to_string_lossy()],
            )
            .unwrap();
        path
    }
    fn child(&self, records: Option<Vec<Value>>, edge: &str, name: &str, parent: &str) {
        self.log(name, records.unwrap_or_else(completed));
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .execute(
                "insert into thread_spawn_edges values(?,?,?)",
                rusqlite::params![parent, name, edge],
            )
            .unwrap();
    }
    fn check(&self) -> (bool, String, String) {
        check_jobs(&self.t, &self.c, &Value::Null, false)
    }
    fn hold(&self, reason: Option<&str>) {
        let (safe, why, fingerprint) = self.check();
        assert!(!safe, "{why}");
        assert!(!why.is_empty());
        assert_eq!(fingerprint.len(), 64);
        if let Some(reason) = reason {
            assert!(why.contains(reason), "{why} lacks {reason}");
        }
    }
}
#[test]
fn test_complete_main_without_children_has_stable_fingerprint() {
    let f = Codex::new();
    let result = f.check();
    assert!(result.0, "{result:?}");
    assert_eq!(result, f.check());
    let mut records = completed();
    records.push(json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}));
    f.log("main-session", records);
    assert_ne!(result.2, f.check().2);
}
#[test]
fn test_missing_or_reused_pid_created_session_agent_mapping_holds() {
    let mut f = Codex::new();
    for (key, value) in [
        ("pid", json!(101)),
        ("created_ms", json!(STAMP)),
        ("session_id", json!("other-session")),
        ("agent", json!("claude")),
    ] {
        let original = f.c.clone();
        f.c["sessions"]["fixture-terminal"][key] = value;
        f.hold(None);
        f.c = original;
    }
    f.c["sessions"].as_object_mut().unwrap().clear();
    f.hold(Some("mapping missing"));
}
#[test]
fn test_missing_db_schema_rollout_or_status_timestamp_holds() {
    let mut f = Codex::new();
    let original = f.c["codex_db"].clone();
    f.c["codex_db"] = json!(f.root.path().join("absent.sqlite"));
    f.hold(Some("database missing"));
    f.c["codex_db"] = original;
    fs::remove_file(f.path("main-session")).unwrap();
    f.hold(Some("unreadable"));
    f.log("main-session", completed());
    f.t.as_object_mut().unwrap().remove("status_ms");
    f.hold(Some("timestamp missing"));
}
#[test]
fn test_freshness_rejects_five_second_old_main_mapping() {
    let f = Codex::new();
    let path = f.path("main-session");
    stamp(&path, STAMP - 5000);
    f.hold(Some("stale"));
    stamp(&path, STAMP - 4999);
    assert!(f.check().0);
}
#[test]
fn test_incomplete_oversized_wrong_identity_or_truncated_history_holds() {
    let f = Codex::new();
    let path = f.path("main-session");
    let mut data = fs::read(&path).unwrap();
    while data.last() == Some(&b'\n') {
        data.pop();
    }
    for value in [
        data,
        b"{invalid\n".to_vec(),
        (crate::common::json_text(&event("task_complete"), true) + "\n").into_bytes(),
    ] {
        fs::write(&path, value).unwrap();
        f.hold(None);
    }
    f.log(
        "main-session",
        vec![
            json!({"type":"event_msg","payload":{"type":"task_complete","history_truncated":true}}),
        ],
    );
    f.hold(Some("truncated"));
    fs::File::create(&path)
        .unwrap()
        .set_len(MAX_BYTES + 1)
        .unwrap();
    f.hold(Some("64 MiB"));
}
#[test]
fn test_main_or_open_child_working_or_unknown_holds() {
    let f = Codex::new();
    let mut resumed = completed();
    resumed.push(event("task_started"));
    for records in [vec![], vec![event("task_started")], resumed] {
        f.log("main-session", records);
        f.hold(Some("main backend task"));
    }
    f.log("main-session", completed());
    f.child(
        Some(vec![event("task_started")]),
        "open",
        "child-session",
        "main-session",
    );
    f.hold(Some("child task"));
    f.log("child-session", vec![]);
    f.hold(Some("child task"));
}
#[test]
fn test_completed_or_aborted_child_can_be_verified_even_with_open_edge() {
    let f = Codex::new();
    f.child(None, "open", "child-session", "main-session");
    assert!(f.check().0);
    f.log(
        "child-session",
        vec![event("task_started"), event("turn_aborted")],
    );
    assert!(f.check().0);
}
#[test]
fn test_closed_child_background_exec_still_blocks_parent() {
    let f = Codex::new();
    f.child(
        Some(vec![
            event("task_started"),
            call("shell", "exec_command", json!("{}")),
            output("shell", json!({"session_id":123,"exit_code":null})),
            event("task_complete"),
        ]),
        "closed",
        "child-session",
        "main-session",
    );
    f.hold(Some("exec sessions"));
}
#[test]
fn test_running_exec_session_requires_matched_poll_exit_not_task_completion() {
    let f = Codex::new();
    let mut r = vec![
        event("task_started"),
        call("launch", "exec_command", json!("{}")),
        output("launch", json!({"session_id":94887,"exit_code":null})),
        event("task_complete"),
    ];
    f.log("main-session", r.clone());
    f.hold(Some("exec sessions"));
    r.extend([
        call("poll", "write_stdin", json!("{\"session_id\": 94887}")),
        output(
            "poll",
            json!([{"type":"input_text","text":"{\"exit_code\": 0, \"output\": \"finished\"}"}]),
        ),
    ]);
    f.log("main-session", r);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_raw_javascript_write_stdin_and_array_text_json_are_correlated() {
    let f = Codex::new();
    f.log("main-session",vec![event("task_started"),call("launch","functions.exec",json!("text(await tools.exec_command({cmd:\"sleep 5\"}));")),output("launch",json!([{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"{\"session_id\":94887,\"exit_code\":null}"}])),call("poll","functions.exec",json!("text(await tools.write_stdin({session_id:94887,chars:\"\"}));")),output("poll",json!([{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"{\"exit_code\":0,\"output\":\"done\"}"}])),event("task_complete")]);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_unrelated_sync_exit_does_not_close_an_open_session() {
    let f = Codex::new();
    f.log(
        "main-session",
        vec![
            event("task_started"),
            call("launch", "exec_command", json!("{}")),
            output("launch", json!({"session_id":1})),
            call("other", "exec_command", json!("{}")),
            output("other", json!({"exit_code":0})),
            event("task_complete"),
        ],
    );
    f.hold(Some("exec sessions"));
}
#[test]
fn test_program_stdout_cannot_forge_completion_of_an_unrelated_session() {
    let f = Codex::new();
    f.log(
        "main-session",
        vec![
            event("task_started"),
            call("launch", "exec_command", json!("{}")),
            output("launch", json!({"session_id":1})),
            call("other", "exec_command", json!("{}")),
            output(
                "other",
                json!({"exit_code":0,"output":"{\"session_id\":1,\"exit_code\":0}"}),
            ),
            event("task_complete"),
        ],
    );
    f.hold(Some("exec sessions"));
}
#[test]
fn test_backend_cell_must_finish_via_matching_wait() {
    let f = Codex::new();
    let mut r = vec![
        event("task_started"),
        call(
            "launch",
            "functions.exec",
            json!("await tools.exec_command({cmd:\"work\"})"),
        ),
        output(
            "launch",
            json!([{"type":"input_text","text":"Script running with cell ID g32:51\n"}]),
        ),
        event("task_complete"),
    ];
    f.log("main-session", r.clone());
    f.hold(Some("execution cells"));
    r.extend([call("wait","functions.wait",json!("{\"cell_id\":\"g32:51\"}")),output("wait",json!([{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"{\"exit_code\":0}"}]))]);
    f.log("main-session", r);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_wait_can_finish_cell_but_reveal_still_running_exec_session() {
    let f = Codex::new();
    f.log("main-session",vec![event("task_started"),call("launch","functions.exec",json!("await tools.exec_command({cmd:\"work\"})")),output("launch",json!("Script running with cell ID cell-a")),call("wait","functions.wait",json!("{\"cell_id\":\"cell-a\"}")),output("wait",json!([{"type":"input_text","text":"Script completed\n"},{"type":"input_text","text":"{\"session_id\":77,\"exit_code\":null}"}])),event("task_complete")]);
    f.hold(Some("exec sessions"));
}
#[test]
fn test_wrong_poll_or_wait_identity_and_missing_output_hold() {
    let f = Codex::new();
    f.log(
        "main-session",
        vec![
            event("task_started"),
            call("one", "exec_command", json!("{}")),
            output("one", json!({"session_id":1})),
            call("poll", "write_stdin", json!("{\"session_id\":2}")),
            output("poll", json!({"session_id":1,"exit_code":0})),
            event("task_complete"),
        ],
    );
    f.hold(Some("mismatch"));
    let mut r = completed();
    r.push(call("missing", "exec_command", json!("{}")));
    f.log("main-session", r);
    f.hold(Some("pending"));
    let mut r = completed();
    r.push(output("absent-call", json!({"exit_code":0})));
    f.log("main-session", r);
    f.hold(Some("history"));
}
#[test]
fn test_unknown_shell_output_and_closed_child_missing_log_hold() {
    let f = Codex::new();
    f.log(
        "main-session",
        vec![
            event("task_started"),
            call("shell", "exec_command", json!("{}")),
            output("shell", json!("The command may still be running")),
            event("task_complete"),
        ],
    );
    f.hold(Some("result unverified"));
    f.log("main-session", completed());
    f.child(None, "closed", "child-session", "main-session");
    fs::remove_file(f.path("child-session")).unwrap();
    f.hold(Some("unreadable"));
}
#[test]
fn test_completed_code_cell_mentioning_exec_command_is_a_result() {
    let f = Codex::new();
    f.log("main-session",vec![event("task_started"),call("c","exec",json!("text(await tools.exec_command({cmd:\"ls\"}));")),output("c",json!([{"type":"input_text","text":"Script completed\nWall time 0.1 seconds\n"},{"type":"input_text","text":"Warning: truncated output (original token count: 9)\nTotal output lines: 2\n\n[{\"name\":\"x\"}]"}])),event("task_complete")]);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_refused_spawn_without_output_after_task_end_is_not_work() {
    let f = Codex::new();
    f.child(
        Some(vec![
            event("task_started"),
            call("s", "spawn_agent", json!("{}")),
            event("task_complete"),
        ]),
        "open",
        "child-session",
        "main-session",
    );
    assert!(f.check().0, "{:?}", f.check());
    f.child(
        Some(vec![
            event("task_started"),
            call("x", "exec_command", json!("{}")),
            event("task_complete"),
        ]),
        "open",
        "other-child",
        "main-session",
    );
    f.hold(Some("pending backend tool calls"));
}
#[test]
fn test_open_exec_sessions_pass_only_with_a_clean_process_tree() {
    let f = Codex::new();
    f.log(
        "main-session",
        vec![
            event("task_started"),
            call("l", "exec_command", json!("{}")),
            output("l", json!({"session_id":5,"exit_code":null})),
            event("task_complete"),
        ],
    );
    f.hold(Some("exec sessions"));
    assert!(check_jobs(&f.t, &f.c, &Value::Null, true).0);
}
#[test]
fn test_closed_child_needs_no_finished_turn_but_its_commands_still_count() {
    let f = Codex::new();
    f.child(
        Some(vec![event("task_started")]),
        "closed",
        "child-session",
        "main-session",
    );
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_child_graph_cycle_cannot_be_accepted() {
    let f = Codex::new();
    f.child(None, "open", "child-session", "main-session");
    rusqlite::Connection::open(&f.db)
        .unwrap()
        .execute(
            "insert into thread_spawn_edges values('child-session','main-session','open')",
            [],
        )
        .unwrap();
    f.hold(Some("cycle"));
}
#[test]
fn test_no_file_database_or_process_writes_are_performed() {
    let f = Codex::new();
    let snapshot = || -> BTreeMap<String, Vec<u8>> {
        fs::read_dir(f.root.path())
            .unwrap()
            .map(|e| e.unwrap())
            .filter(|e| e.path().is_file())
            .map(|e| {
                (
                    e.file_name().to_string_lossy().into_owned(),
                    fs::read(e.path()).unwrap(),
                )
            })
            .collect()
    };
    let before = snapshot();
    assert!(f.check().0);
    assert_eq!(before, snapshot());
}

struct Claude {
    home: tempfile::TempDir,
    log: PathBuf,
    t: Value,
    c: Value,
}
impl Claude {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("sessions")).unwrap();
        fs::create_dir_all(home.path().join("projects/fixture")).unwrap();
        let log = home.path().join("projects/fixture/claude-main.jsonl");
        fs::write(
            home.path().join("sessions/100.json"),
            crate::common::json_text(
                &json!({"sessionId":"claude-main","transcriptPath":log}),
                true,
            ),
        )
        .unwrap();
        let f = Self {
            c: json!({"claude_home":home.path(),"sessions":{"claude-terminal":{"pid":100,"created_ms":STAMP-10000,"session_id":"claude-main","agent":"claude"}}}),
            home,
            log,
            t: json!({"address":"claude-terminal","pid":100,"created_ms":STAMP-10000,"status_ms":STAMP,"status":{"app":"claude","state":"done"}}),
        };
        f.write(vec![json!({"sessionId":"claude-main","message":{"role":"assistant","stop_reason":"end_turn","content":[]}})]);
        f
    }
    fn write(&self, records: Vec<Value>) {
        fs::write(&self.log, lines(&records)).unwrap();
        stamp(&self.log, STAMP);
    }
    fn check(&self) -> (bool, String, String) {
        check_jobs(&self.t, &self.c, &Value::Null, false)
    }
    fn child_dir(&self) -> PathBuf {
        let path = self
            .home
            .path()
            .join("projects/fixture/claude-main/subagents");
        fs::create_dir_all(&path).unwrap();
        path
    }
}
fn use_tool(id: &str, background: bool) -> Value {
    json!({"type":"assistant","sessionId":"claude-main","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":id,"name":"Bash","input":if background{json!({"run_in_background":true})}else{json!({})}}]}})
}
fn result(id: &str, text: &str, extra: Value, error: bool) -> Value {
    json!({"type":"user","sessionId":"claude-main","toolUseResult":extra,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":text,"is_error":error}]}})
}
fn end() -> Value {
    json!({"type":"assistant","sessionId":"claude-main","message":{"role":"assistant","stop_reason":"end_turn","content":[]}})
}
fn notice(task: &str, id: &str, status: &str, kind: &str) -> Value {
    json!({"type":kind,"sessionId":"claude-main","content":format!("<task-notification> <task-id>{task}</task-id> <tool-use-id>{id}</tool-use-id> <status>{status}</status> </task-notification>")})
}
#[test]
fn test_verified_completed_log_can_be_accepted() {
    let f = Claude::new();
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_metadata_lines_rewritten_without_work_keep_the_fingerprint() {
    let f = Claude::new();
    let talk = vec![
        json!({"sessionId":"claude-main","timestamp":"2026-11-05T04:58:48Z","message":{"role":"assistant","stop_reason":"end_turn","content":[]}}),
    ];
    f.write(talk.clone());
    let before = f.check();
    let meta: Vec<Value> = [
        "mode",
        "permission-mode",
        "session-owner",
        "atis-latch",
        "last-prompt",
    ]
    .iter()
    .map(|kind| json!({"type":kind,"sessionId":"claude-main"}))
    .collect();
    let mut records = talk.clone();
    records.extend(meta);
    f.write(records.clone());
    let after = f.check();
    assert!(after.0, "{after:?}");
    assert_eq!(before.2, after.2);
    records.push(json!({"sessionId":"claude-main","timestamp":"2026-11-05T05:10:00Z","type":"user","message":{"role":"user","content":"다음 일"}}));
    records.extend(talk);
    f.write(records);
    assert_ne!(before.2, f.check().2);
}
#[test]
fn test_missing_process_meta_or_unknown_completion_is_unverified() {
    let f = Claude::new();
    fs::remove_file(f.home.path().join("sessions/100.json")).unwrap();
    assert!(!f.check().0);
    assert!(f.check().1.contains("backend jobs unverified"));
}
#[test]
fn test_background_bash_blocks_even_after_end_turn() {
    let f = Claude::new();
    f.write(vec![json!({"sessionId":"claude-main","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"bash","name":"Bash","input":{"run_in_background":true}}]}}),json!({"sessionId":"claude-main","message":{"role":"assistant","stop_reason":"end_turn","content":[]}})]);
    assert!(!f.check().0);
    assert!(f.check().1.contains("background"));
}
#[test]
fn test_unfinished_or_unidentified_subagent_blocks() {
    let f = Claude::new();
    fs::write(
        f.child_dir().join("agent.meta.json"),
        b"{\"finished\":false}",
    )
    .unwrap();
    assert!(!f.check().0);
    assert!(f.check().1.contains("child working/unknown"));
}
#[test]
fn test_api_request_copies_of_tool_results_are_not_events() {
    let f = Claude::new();
    let blob = json!({"type":"api-request-blob","sessionId":"claude-main","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a"}]}});
    f.write(vec![
        use_tool("a", false),
        blob,
        result("a", "ok", json!({}), false),
        end(),
    ]);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_compaction_is_read_through() {
    let f = Claude::new();
    f.write(vec![use_tool("a",false),result("a","ok",json!({}),false),json!({"type":"user","isCompactSummary":true,"sessionId":"claude-main","message":{"role":"user","content":"summary"}}),end()]);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_idle_compaction_after_end_turn_is_not_a_new_prompt() {
    let f = Claude::new();
    let summary = json!({"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"sessionId":"claude-main","message":{"role":"user","content":"This session is being continued from a previous conversation"}});
    let boundary = json!({"type":"system","subtype":"compact_boundary","sessionId":"claude-main","content":"Conversation compacted"});
    f.write(vec![
        use_tool("a", false),
        result("a", "ok", json!({}), false),
        end(),
        boundary.clone(),
        summary.clone(),
    ]);
    assert!(f.check().0, "{:?}", f.check());
    let prompt = json!({"type":"user","sessionId":"claude-main","message":{"role":"user","content":"다음 일 해줘"}});
    f.write(vec![end(), boundary, summary, prompt]);
    assert!(f.check().1.contains("turn not ended"));
}
#[test]
fn test_background_job_blocks_until_its_completion_notice() {
    let f = Claude::new();
    let started = vec![
        use_tool("a", true),
        result(
            "a",
            "Command running in background with ID: b1.",
            json!({"backgroundTaskId":"b1"}),
            false,
        ),
        end(),
    ];
    f.write(started.clone());
    assert!(f.check().1.contains("background job running"));
    let mut records = started.clone();
    records.push(notice("b1", "a", "completed", "queue-operation"));
    f.write(records);
    assert!(f.check().0, "{:?}", f.check());
    let mut records = started;
    records.push(notice("b1", "a", "running", "queue-operation"));
    f.write(records);
    assert!(f.check().1.contains("background job running"));
}
#[test]
fn test_stopped_background_job_and_denied_launch_do_not_block() {
    let f = Claude::new();
    f.write(vec![
        use_tool("a", true),
        result(
            "a",
            "Command running in background with ID: b1.",
            json!({}),
            false,
        ),
        use_tool("s", false),
        result(
            "s",
            "Successfully stopped task: b1 (sleep 99)",
            json!({}),
            false,
        ),
        use_tool("d", true),
        result(
            "d",
            "Permission for this action was denied",
            json!({}),
            true,
        ),
        end(),
    ]);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_async_agent_blocks_until_notified() {
    let f = Claude::new();
    let mut started = vec![
        use_tool("a", false),
        result(
            "a",
            "launched",
            json!({"isAsync":true,"status":"async_launched","agentId":"ag1"}),
            false,
        ),
        end(),
    ];
    f.write(started.clone());
    assert!(f.check().1.contains("background job running"));
    started.push(notice("ag1", "a", "completed", "attachment"));
    f.write(started);
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_unicode_line_separators_inside_strings_do_not_split_records() {
    let f = Claude::new();
    let records = vec![
        use_tool("a", false),
        result("a", "line\u{2028}still the same record", json!({}), false),
        end(),
    ];
    let text: String = records
        .iter()
        .map(|r| crate::common::json_text(r, false) + "\n")
        .collect();
    fs::write(&f.log, text).unwrap();
    stamp(&f.log, STAMP);
    assert!(fs::read_to_string(&f.log).unwrap().contains('\u{2028}'));
    assert!(f.check().0, "{:?}", f.check());
}
#[test]
fn test_finished_subagent_ending_on_its_result_tool_is_accepted() {
    let f = Claude::new();
    let dir = f.child_dir();
    fs::write(dir.join("agent-x.meta.json"), b"{\"finished\":true}").unwrap();
    fs::write(
        dir.join("agent-x.jsonl"),
        lines(&[use_tool("final", false)]),
    )
    .unwrap();
    assert!(f.check().0, "{:?}", f.check());
    fs::write(dir.join("agent-x.meta.json"), b"{}").unwrap();
    assert!(!f.check().0);
}
#[test]
fn test_complete_exit_metadata_before_truncated_stdout_is_evidence() {
    let text="Warning: truncated output (original token count: 123)\nTotal output lines: 1\n\n{\"chunk_id\":\"abc123\",\"wall_time_seconds\":0.1,\"exit_code\":0,\"original_token_count\":999,\"output\":\"cut off";
    let mut objects = vec![];
    outputs(&json!([{"type":"input_text","text":text}]), 0, &mut objects).unwrap();
    assert!(objects.iter().any(|item| item["exit_code"] == 0));
}
#[test]
fn test_unframed_or_incomplete_result_remains_unknown() {
    assert!(truncated_result("{\"exit_code\":0,\"output\":\"cut").is_none());
    assert!(truncated_result("Warning: truncated output (original token count: 123)\nTotal output lines: 1\n\n{\"chunk_id\":\"abc123\",\"output\":\"cut").is_none());
}
#[test]
fn test_stdout_cannot_forge_truncated_host_exit() {
    let fake="Warning: truncated output (original token count: 123)\nTotal output lines: 1\n\n{\"chunk_id\":\"abc123\",\"wall_time_seconds\":0.1,\"exit_code\":0,\"output\":\"cut";
    let mut objects = vec![];
    outputs(
        &json!({"exit_code":null,"session_id":7,"output":fake}),
        0,
        &mut objects,
    )
    .unwrap();
    assert_eq!(objects.len(), 1);
    assert!(objects[0]["exit_code"].is_null());
}
