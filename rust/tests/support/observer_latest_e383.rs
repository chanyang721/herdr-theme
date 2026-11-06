//! Literal added original tests from e383c3c, with the same adapter/FS boundaries.
//! These supplement, rather than replace, the pre-existing lifecycle cases.
use super::*;
use herdr_theme::observers::stub;

struct Latest {
    f: SleepFixture,
}
impl Latest {
    fn spare() -> Self {
        let mut f = SleepFixture::new();
        f.live.empty_turn_zero = true;
        f.live.reported = false;
        Self { f }
    }
    fn trim() -> Self {
        let mut x = Self::spare();
        x.f.config["exclude_addresses"] = json!([]);
        x.f.config["trim_fixed"] = json!({"names":["Project B"],"keep_addresses":[]});
        x.f.live.data["terminals"]["t12"]["status_ms"] = json!((NOW - 1300.) * 1000.);
        x.f.live.data["terminals"]["t3"]["status_ms"] = json!((NOW - 3600.) * 1000.);
        x
    }
    fn seed(&mut self, quiet: f64) {
        let first = sleep::cycle(
            &mut self.f.live,
            &self.f.config,
            &mut json!({"observer_sha256":"code"}),
            NOW - quiet,
            false,
            &self.f.paths,
        )
        .unwrap();
        self.f.state = json!({"observer_sha256":"code","last_at":NOW-300.,"trial":{"started_at":NOW-600.,"samples":1,"error_count":0},"sessions":{}});
        for row in o::arr(&first["results"]) {
            if row.get("fingerprint").is_some() {
                self.f.state["sessions"][o::s(&row["address"])] =
                    json!({"since":NOW-quiet,"fingerprint":row["fingerprint"]});
            }
        }
        self.f.live.quiet();
    }
    fn at(&mut self, at: f64, apply: bool) -> Value {
        sleep::cycle(
            &mut self.f.live,
            &self.f.config,
            &mut self.f.state,
            at,
            apply,
            &self.f.paths,
        )
        .unwrap()
    }
    fn run(&mut self) -> Value {
        self.at(NOW, true)
    }
    fn empty(&mut self, a: &str) {
        self.f.live.data["terminals"][a]["turn"] = json!(0);
    }
    fn asleep(&mut self, a: &str) {
        let path = Path::new(o::s(&self.f.paths["tickets"])).join(format!("{a}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let value = json!({"address":a,"app":"claude-code","session_id":SID,"argv":["claude","--resume",SID],"title":"PR 검토 마무리","space_name":"Project B"});
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        self.f.live.data["terminals"][a]["labels"] = json!({"sixfold.sleep":format!("claude:{SID}"),"sixfold.title":"절전 · PR 검토 마무리"});
        self.f.live.data["terminals"][a]["foreground"] = json!({"pid":999,"argv":["python3","/fixture/session_sleep_stub.py",path],"name":"python3"});
        self.f.live.texts.insert(a.into(), screen(&value));
    }
    fn keeper(&self) -> Option<String> {
        sleep::trim_keeper(
            &self.f.live.data["spaces"][1],
            &self.f.live.data,
            &self.f.config,
        )
    }
    fn asked(&mut self, a: &str) {
        self.seed(2400.);
        self.f.state["reports"] = json!({(a):{"session_id":SID,"requested_at":NOW-1000.,"since":"2026-11-05T00:00:00Z","turn":3,"idle_ok":true}});
    }
    fn shell(&mut self, a: &str, text: &str) {
        let t = &mut self.f.live.data["terminals"][a];
        let pid = t["pid"].clone();
        t["status"] = json!({"app":null,"state":null});
        t["foreground"] = json!({"pid":pid,"argv":["-zsh"],"name":"zsh"});
        self.f.live.data["processes"]
            .as_object_mut()
            .unwrap()
            .retain(|_, p| p["parent"] != pid);
        self.f.live.text = format!("{text}\n");
    }
    fn no_action(&self, a: &str, p: &str) {
        assert!(
            !self
                .f
                .live
                .calls
                .iter()
                .any(
                    |c| ["keys", "type", "label", "ask", "pane.close"].contains(&o::s(&c[0]))
                        && (c[1] == a || c[1] == p)
                ),
            "{:?}",
            self.f.live.calls
        );
    }
}
fn screen(ticket: &Value) -> String {
    format!("\n  절전 중 — {} {} {}\n  Enter: 이어 열기 · 메시지를 보내면 이어 열고 그대로 전달 · ctrl+c: 셸로 나가기\n  직접 열기: {}\n\n",o::s(&ticket["space_name"]),o::s(&ticket["address"]),o::s(&ticket["title"]),stub::shown(&stub::launch(ticket),72))
}
fn row<'a>(out: &'a Value, a: &str) -> &'a Value {
    item(out, "address", a)
}
fn has(out: &Value, a: &str, why: &str) {
    assert!(
        o::arr(&row(out, a)["reasons"])
            .iter()
            .any(|r| o::s(r) == why),
        "{}",
        row(out, a)
    );
}
fn not_closed(x: &Latest, p: &str) {
    assert!(!x.f.live.events("pane.close").iter().any(|v| v[1] == p));
}

mod spare_close {
    use super::*;
    #[test]
    fn test_an_empty_pane_closes_without_a_harness_record_when_its_space_keeps_another() {
        let mut x = Latest::spare();
        x.empty("t12");
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "closed");
        assert!(x.f.live.calls.contains(&json!(["pane.close", "p12"])));
        for e in ["park", "ask", "status"] {
            assert!(x.f.live.events(e).is_empty());
        }
    }
    #[test]
    fn test_an_empty_pane_is_never_asked_for_a_report_and_waits_the_idle_window() {
        let mut x = Latest::spare();
        x.empty("t12");
        x.seed(600.);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "keep");
        has(&out, "t12", "empty pane unchanged for 10 of 20 minutes");
        for e in ["pane.close", "park", "ask"] {
            assert!(x.f.live.events(e).is_empty());
        }
    }
    #[test]
    fn test_the_last_pane_of_a_space_stays_even_when_empty() {
        let mut x = Latest::spare();
        x.empty("t12");
        x.f.live.data["spaces"][1]["tabs"][0]["terminals"] =
            json!([{"terminal":"t12","pane":"p12","sub_agents":[]}]);
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "keep");
        has(&out, "t12", "last pane in its space");
        not_closed(&x, "p12");
    }
    #[test]
    fn test_an_empty_pane_with_typed_input_is_not_empty() {
        let mut x = Latest::spare();
        x.empty("t12");
        x.f.live.text = x.f.live.text.replace("❯ \n", "❯ 지금 하는 일\n");
        x.seed(1200.);
        let out = x.run();
        not_closed(&x, "p12");
        assert_ne!(row(&out, "t12")["action"], "closed");
    }
    #[test]
    fn test_dry_run_says_would_close_empty() {
        let mut x = Latest::spare();
        x.empty("t12");
        x.seed(1200.);
        let out = x.at(NOW, false);
        assert_eq!(row(&out, "t12")["action"], "would_close_empty");
        assert!(x.f.live.events("pane.close").is_empty());
    }
    #[test]
    fn test_a_finished_asleep_pane_closes_with_its_harness_records() {
        let mut x = Latest::spare();
        x.asleep("t12");
        x.f.live.reported = true;
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "closed");
        assert_eq!(x.f.live.parks(), ["close_requested", "closed"]);
        assert!(x.f.live.calls.contains(&json!(["pane.close", "p12"])));
        assert_eq!(row(&out, "t12")["close_report"], "REP1");
    }
    #[test]
    fn test_an_asleep_pane_without_a_close_report_stays_asleep() {
        let mut x = Latest::spare();
        x.asleep("t12");
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "asleep");
        assert!(reasons(row(&out, "t12")).contains("without a close report"));
        not_closed(&x, "p12");
    }
}
mod empty_agent {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Value, Value) {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("sessions")).unwrap();
        fs::write(
            d.path().join("sessions/201.json"),
            serde_json::to_vec(&json!({"pid":201,"sessionId":SID})).unwrap(),
        )
        .unwrap();
        let c = json!({"claude_home":d.path()});
        let t = json!({"turn":0,"status":{"app":"claude-code","state":"idle"},"foreground":{"pid":201,"argv":["claude","--dangerously-skip-permissions"]}});
        (d, c, t)
    }
    #[test]
    fn test_claude_turn_zero_without_transcript_is_empty() {
        let (_d, c, t) = fixture();
        assert!(sessions::empty_agent(&t, &c));
    }
    #[test]
    fn test_a_transcript_or_a_turn_means_input_was_received() {
        let (d, c, mut t) = fixture();
        t["turn"] = json!(1);
        assert!(!sessions::empty_agent(&t, &c));
        t["turn"] = json!(0);
        fs::create_dir_all(d.path().join("projects/p")).unwrap();
        fs::write(d.path().join(format!("projects/p/{SID}.jsonl")), "{}\n").unwrap();
        assert!(!sessions::empty_agent(&t, &c));
    }
    #[test]
    fn test_unreadable_or_resumed_sessions_are_not_empty() {
        let (d, c, mut t) = fixture();
        t["foreground"]["argv"] = json!(["claude", "--resume", SID]);
        assert!(!sessions::empty_agent(&t, &c));
        t["foreground"]["argv"] = json!(["claude", "--dangerously-skip-permissions"]);
        fs::remove_file(d.path().join("sessions/201.json")).unwrap();
        assert!(!sessions::empty_agent(&t, &c));
        assert!(!sessions::empty_agent(
            &json!({"turn":0,"status":{"app":"claude-code"}}),
            &c
        ));
    }
    #[test]
    fn test_codex_without_a_rollout_is_empty_and_config_flags_are_not_resume() {
        let (_d, c, mut t) = fixture();
        t["status"]["app"] = json!("codex");
        t["foreground"]["argv"] = json!(["codex", "-c", "model_reasoning_effort=high"]);
        assert!(sessions::empty_agent_with(&t, &c, &mut |_| Some(vec![])));
        assert!(!sessions::empty_agent_with(&t, &c, &mut |_| Some(vec![
            "/x/rollout-1.jsonl".into()
        ])));
        t["foreground"]["argv"] = json!(["codex", "resume", SID]);
        assert!(!sessions::empty_agent_with(&t, &c, &mut |_| Some(vec![])));
    }
}
mod trim_fixed {
    use super::*;
    #[test]
    fn test_the_keeper_is_configured_else_working_else_the_agent_used_last() {
        let mut x = Latest::trim();
        assert_eq!(x.keeper().as_deref(), Some("t12"));
        x.f.live.data["terminals"]["t3"]["status"]["state"] = json!("working");
        assert_eq!(x.keeper().as_deref(), Some("t3"));
        x.f.config["trim_fixed"]["keep_addresses"] = json!(["t12"]);
        assert_eq!(x.keeper().as_deref(), Some("t12"));
        assert!(
            sleep::trim_keeper(&x.f.live.data["spaces"][0], &x.f.live.data, &x.f.config).is_none()
        );
        let mut remote = x.f.live.data["spaces"][1].clone();
        remote["machine"] = json!("home-main");
        assert!(sleep::trim_keeper(&remote, &x.f.live.data, &x.f.config).is_none());
    }
    #[test]
    fn test_an_asleep_pane_without_a_close_report_closes_with_its_records() {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t3")["action"], "closed");
        assert_eq!(x.f.live.parks(), ["close_requested", "closed"]);
        assert!(x.f.live.calls.contains(&json!(["pane.close", "p3"])));
    }
    #[test]
    fn test_the_keeper_is_never_closed() {
        let mut x = Latest::trim();
        x.asleep("t12");
        x.asleep("t3");
        x.f.live.data["terminals"]["t12"]["status_ms"] = json!((NOW - 100.) * 1000.);
        x.f.live.reported = true;
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t3")["action"], "closed");
        not_closed(&x, "p12");
        assert_eq!(row(&out, "t12")["keeper"], true);
    }
    #[test]
    fn test_an_agent_without_a_report_in_time_is_closed_with_its_lifecycle() {
        let mut x = Latest::trim();
        x.asked("t3");
        let out = x.run();
        assert_eq!(row(&out, "t3")["action"], "closed");
        assert_eq!(x.f.live.parks(), ["close_requested", "closed"]);
        assert!(x.f.live.calls.contains(&json!(["pane.close", "p3"])));
    }
    #[test]
    fn test_outside_a_trimmed_workspace_no_report_still_keeps_the_pane() {
        let mut x = Latest::trim();
        x.f.config["trim_fixed"] = json!({"names":[]});
        x.asked("t3");
        let out = x.run();
        not_closed(&x, "p3");
        assert_ne!(row(&out, "t3")["action"], "closed");
    }
    #[test]
    fn test_protections_still_keep_a_trimmed_pane() {
        for case in ["input", "working", "focus", "background job"] {
            let mut x = Latest::trim();
            x.asked("t3");
            match case {
                "input" => x.f.live.text = x.f.live.text.replace("❯ \n", "❯ 지금 하는 일\n"),
                "working" => x.f.live.data["terminals"]["t3"]["status"]["state"] = json!("working"),
                "focus" => x.f.live.data["status"]["focused_pane"] = json!("p3"),
                _ => {
                    x.f.live.jobs = (
                        false,
                        "backend jobs unverified: Claude background job running".into(),
                        "x".into(),
                    )
                }
            };
            let out = x.run();
            not_closed(&x, "p3");
            assert_ne!(row(&out, "t3")["action"], "closed", "{case}");
        }
    }
    #[test]
    fn test_an_agentless_shell_pane_is_kept_because_unsent_input_cannot_be_read() {
        for text in [
            "user@host ~ % ",
            "user@host ~ % echo #",
            "user@host ~ % echo 중요한말 >",
        ] {
            let mut x = Latest::trim();
            x.shell("t3", text);
            x.seed(1200.);
            let out = x.run();
            not_closed(&x, "p3");
            has(&out, "t3", "shell pane: unsent input cannot be verified");
        }
    }
    #[test]
    fn test_a_shell_with_typed_text_or_a_running_command_stays() {
        let mut x = Latest::trim();
        x.shell("t3", "user@host ~ % git push");
        x.seed(1200.);
        x.run();
        not_closed(&x, "p3");
        let mut x = Latest::trim();
        x.shell("t3", "user@host ~ % ");
        x.f.live.data["processes"]["999"] =
            json!({"pid":999,"parent":300,"name":"vim","args":"vim"});
        x.seed(1200.);
        x.run();
        not_closed(&x, "p3");
    }
}
mod bridge_kept {
    use super::*;
    #[test]
    fn test_a_bridge_pane_is_always_kept() {
        for reported in [false, true] {
            let mut x = Latest::trim();
            x.f.config["trim_fixed"]["keep_addresses"] = json!(["t12"]);
            x.f.live.data["terminals"]["t3"]["foreground"] = json!({"pid":301,"argv":["python3","/repo/scripts/tui_bridge.py"],"name":"python3"});
            x.f.live.data["processes"]["301"] =
                json!({"pid":301,"parent":300,"name":"python3","args":"python3 tui_bridge.py"});
            x.f.live.data["processes"]["302"] = json!({"pid":302,"parent":301,"name":"herdr","args":"herdr --session default terminal attach term_abc --takeover"});
            x.f.live.reported = reported;
            x.seed(1200.);
            let out = x.run();
            has(&out, "t3", sleep::BRIDGE);
            assert!(!["closed", "slept"].contains(&o::s(&row(&out, "t3")["action"])));
            x.no_action("t3", "p3");
            assert!(!x.f.live.events("park").iter().any(|c| c[2] == "t3"));
        }
    }
    #[test]
    fn test_the_bridge_close_path_is_gone() {
        let source = include_str!("../../src/observers/sleep.rs");
        for name in [
            "bridge_exit",
            "after_exit_blockers",
            "inspect_bridge",
            "tui_foreground",
            "bare_prompt",
        ] {
            assert!(!source.contains(&format!("fn {name}(")), "{name}");
        }
    }
}
mod keeper_awake {
    use super::*;
    fn sleeping() -> Latest {
        let mut x = Latest::trim();
        x.asleep("t12");
        x.asleep("t3");
        x
    }
    #[test]
    fn test_a_live_agent_pane_is_chosen_over_an_asleep_one_used_later() {
        let mut x = Latest::trim();
        x.asleep("t12");
        assert_eq!(x.keeper().as_deref(), Some("t3"));
    }
    #[test]
    fn test_the_live_keeper_is_never_slept_asked_or_closed() {
        let mut x = Latest::trim();
        x.seed(2400.);
        let out = x.run();
        has(&out, "t12", sleep::KEEP_AWAKE);
        x.no_action("t12", "p12");
        assert!(!["slept", "closed"].contains(&o::s(&row(&out, "t12")["action"])));
    }
    #[test]
    fn test_an_asleep_keeper_is_woken_with_enter() {
        let mut x = sleeping();
        x.f.live.exits = false;
        x.seed(1200.);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "woken");
        assert!(x.f.live.calls.contains(&json!(["keys", "t12", ["enter"]])));
        not_closed(&x, "p12");
    }
    #[test]
    fn test_a_dry_run_only_says_it_would_wake() {
        let mut x = sleeping();
        x.seed(1200.);
        let out = x.at(NOW, false);
        assert_eq!(row(&out, "t12")["action"], "would_wake");
        assert!(!x.f.live.calls.contains(&json!(["keys", "t12", ["enter"]])));
    }
    #[test]
    fn test_protections_stop_the_wake() {
        for case in ["typed", "focus", "unreadable"] {
            let mut x = sleeping();
            x.seed(1200.);
            match case {
                "typed" => x.f.live.texts.get_mut("t12").unwrap().push_str("쓰던 말"),
                "focus" => x.f.live.data["status"]["focused_pane"] = json!("p12"),
                _ => {
                    x.f.live
                        .texts
                        .insert("t12".into(), "something else\n".into());
                }
            };
            let out = x.run();
            assert!(!x.f.live.calls.contains(&json!(["keys", "t12", ["enter"]])));
            assert_eq!(row(&out, "t12")["action"], "asleep", "{case}");
        }
    }
    #[test]
    fn test_a_wake_that_does_not_start_the_agent_is_reported() {
        let mut x = sleeping();
        x.seed(1200.);
        x.f.live.wake_mapping = Some(Value::Null);
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "wake_unconfirmed");
    }
    #[test]
    fn test_a_different_session_after_waking_is_a_mismatch_not_a_wake() {
        let mut x = sleeping();
        x.seed(1200.);
        x.f.live.wake_mapping = Some(json!({"session_id":"99999999-8888-7777-6666-555555555555"}));
        let out = x.run();
        assert_eq!(row(&out, "t12")["action"], "wake_mismatch");
        assert!(o::arr(&row(&out, "t12")["reasons"])
            .iter()
            .any(|r| o::s(r).starts_with("wake mismatch")));
    }
    #[test]
    fn test_a_new_session_ticket_is_not_woken() {
        let mut x = sleeping();
        x.f.live.data["terminals"]["t12"]["labels"]["sixfold.sleep.new"] = json!("1");
        let p = PathBuf::from(o::s(
            x.f.live.data["terminals"]["t12"]["foreground"]["argv"]
                .as_array()
                .unwrap()
                .last()
                .unwrap(),
        ));
        let mut v: Value = o::load(&p, Value::Null).unwrap();
        v["new_session"] = json!(true);
        v["argv"] = json!(["claude", "--dangerously-skip-permissions"]);
        fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
        x.f.live.texts.insert("t12".into(), screen(&v));
        x.seed(1200.);
        let out = x.run();
        assert!(!x.f.live.calls.contains(&json!(["keys", "t12", ["enter"]])));
        assert_ne!(row(&out, "t12")["action"], "woken");
    }
    #[test]
    fn test_a_working_shell_is_kept_but_is_never_the_keeper() {
        let mut x = Latest::trim();
        x.shell("t12", "user@host ~ % ");
        x.f.live.data["terminals"]["t12"]["status"]["state"] = json!("working");
        assert_eq!(x.keeper().as_deref(), Some("t3"));
        x.f.live.reported = true;
        x.seed(2400.);
        x.run();
        not_closed(&x, "p3");
        not_closed(&x, "p12");
    }
    #[test]
    fn test_a_configured_shell_is_not_the_keeper() {
        let mut x = Latest::trim();
        x.f.config["trim_fixed"]["keep_addresses"] = json!(["t12"]);
        x.shell("t12", "user@host ~ % ");
        x.f.live.data["terminals"]["t12"]["status"]["state"] = json!("working");
        assert_eq!(x.keeper().as_deref(), Some("t3"));
        x.f.live.reported = true;
        x.seed(2400.);
        x.run();
        not_closed(&x, "p3");
        not_closed(&x, "p12");
    }
    #[test]
    fn test_a_space_with_only_shells_has_no_keeper_and_is_not_trimmed() {
        let mut x = Latest::trim();
        for a in ["t12", "t3"] {
            x.shell(a, "user@host ~ % ");
        }
        assert!(x.keeper().is_none());
        x.seed(1200.);
        let out = x.run();
        assert_eq!(
            row(&out, "t3")["trim_note"],
            "fixed workspace has no agent pane to keep: not trimmed"
        );
        assert!(x.f.live.events("pane.close").is_empty());
    }
}
mod share_user_controlled {
    use super::*;
    fn fixture() -> Latest {
        let mut x = Latest::spare();
        x.f.config["exclude_addresses"] = json!([]);
        x.f.config["trim_fixed"] = json!({"names":["Share","Project B"],"keep_addresses":["t1"]});
        x.f.live.data["spaces"][1]["name"] = json!("Share");
        x.f.live.reported = true;
        x
    }
    fn no_share_calls(x: &Latest) {
        assert!(!x.f.live.calls.iter().any(|c| c[0] != "status"
            && (c[1] == "t12" || c[1] == "t3" || c[1] == "p12" || c[1] == "p3")));
    }
    #[test]
    fn test_share_panes_are_never_slept_asked_or_closed() {
        let mut x = fixture();
        x.seed(1200.);
        let out = x.run();
        no_share_calls(&x);
        for a in ["t12", "t3"] {
            has(&out, a, sleep::USER_CONTROLLED);
            assert_eq!(row(&out, a)["action"], "keep");
        }
    }
    #[test]
    fn test_share_asleep_or_long_unreported_panes_stay_too() {
        let mut x = fixture();
        x.asleep("t3");
        x.seed(2400.);
        x.f.state["reports"] = json!({"t12":{"session_id":SID,"requested_at":NOW-1000.,"since":"2026-11-05T00:00:00Z","turn":3}});
        x.f.live.reported = false;
        x.run();
        no_share_calls(&x);
        assert!(x.keeper().is_none());
    }
    #[test]
    fn test_the_same_panes_in_another_workspace_are_handled() {
        let mut x = fixture();
        x.f.live.data["spaces"][1]["name"] = json!("Project B");
        x.seed(1200.);
        x.run();
        assert!(x
            .f
            .live
            .calls
            .iter()
            .any(|c| c[0] == "pane.close" || c[0] == "keys"));
    }
}
mod re_review_p1 {
    use super::*;
    #[test]
    fn test_typed_but_unsent_input_in_an_asleep_pane_keeps_it() {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.seed(1200.);
        x.f.live
            .texts
            .get_mut("t3")
            .unwrap()
            .push_str("이거 이어서 해줘");
        let out = x.run();
        not_closed(&x, "p3");
        assert_ne!(row(&out, "t3")["action"], "closed");
    }
    #[test]
    fn test_input_left_typed_for_the_whole_idle_window_still_keeps_it() {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.f.live
            .texts
            .get_mut("t3")
            .unwrap()
            .push_str("이거 이어서 해줘");
        x.seed(1200.);
        let out = x.run();
        not_closed(&x, "p3");
        has(&out, "t3", "input not empty");
    }
    #[test]
    fn test_input_typed_while_parking_an_asleep_pane_keeps_it() {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.seed(1200.);
        x.f.live.type_during_park = Some("t3".into());
        x.run();
        not_closed(&x, "p3");
        assert_eq!(x.f.live.parks(), ["close_requested", "close_aborted"]);
    }
    #[test]
    fn test_typed_text_ending_in_the_session_id_is_input() {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.seed(1200.);
        x.f.live
            .texts
            .get_mut("t3")
            .unwrap()
            .push_str(&format!("이 세션을 이어서 검토 {SID}"));
        let out = x.run();
        not_closed(&x, "p3");
        assert_ne!(row(&out, "t3")["action"], "closed");
        assert_eq!(
            sleep::stub_typed(
                &x.f.live.texts["t3"],
                &sleep::stub_ticket(&x.f.live.data["terminals"]["t3"])
            )
            .as_deref(),
            Some("input not empty")
        );
    }
    #[test]
    fn test_real_stub_screens_wrapped_or_indented_are_read() {
        let old = json!({"address":"t11","session_id":SID,"app":"claude-code","argv":["claude","<hc from=\"t3\">긴 지시 둘째 줄 제약: 수정 금지</hc>","--resume",SID]});
        let wrapped=format!("  Enter: 이어 열기\n  직접 열기: claude <hc from=\"t3\">긴 지시\n둘째 줄 제약: 수정 금지</hc> --resume {SID}\n\n");
        assert!(sleep::stub_typed(&wrapped, &old).is_none());
        assert_eq!(
            sleep::stub_typed(&format!("{wrapped}계속"), &old).as_deref(),
            Some("input not empty")
        );
        let new = json!({"address":"t1w","session_id":SID,"app":"codex","argv":["codex","--no-daemon","resume",SID]});
        let indented = format!(
            "      Enter: 이어 열기\n           직접 열기: {}\n",
            sleep::stub_shown(&new).last().unwrap()
        );
        assert!(sleep::stub_typed(&indented, &new).is_none());
        assert!(sleep::stub_typed(&indented, &Value::Null)
            .unwrap()
            .starts_with("asleep screen unverified"));
        let mut cleaned = old.clone();
        cleaned["argv"] = json!(["claude", "--resume", SID]);
        assert!(sleep::stub_typed(&wrapped, &cleaned)
            .unwrap()
            .starts_with("asleep screen unverified"));
    }
    #[test]
    fn test_an_unreadable_stub_screen_is_not_closed() {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.f.live
            .texts
            .insert("t3".into(), "something else\n".into());
        x.seed(1200.);
        let out = x.run();
        not_closed(&x, "p3");
        has(
            &out,
            "t3",
            "asleep screen unverified (stub prompt or ticket not found)",
        );
    }
}
mod lookup_hold {
    use super::*;
    fn fixture() -> Latest {
        let mut x = Latest::trim();
        x.asleep("t3");
        x.seed(900.);
        x
    }
    #[test]
    fn test_a_failed_lookup_keeps_the_idle_window_and_the_pane_closes_later() {
        let mut x = fixture();
        let since = x.f.state["sessions"]["t3"]["since"].clone();
        x.f.live.data["lookup_errors"] =
            json!({"t3":"herdr-core get t3 timed out after 12 seconds"});
        let out = x.run();
        has(&out, "t3", sessions::LOOKUP_HOLD);
        not_closed(&x, "p3");
        assert_eq!(x.f.state["sessions"]["t3"]["since"], since);
        x.f.live
            .data
            .as_object_mut()
            .unwrap()
            .remove("lookup_errors");
        let out = x.at(NOW + 400., true);
        assert_eq!(row(&out, "t3")["action"], "closed");
    }
    #[test]
    fn test_an_inspect_that_raises_is_held_too() {
        let mut x = fixture();
        let since = x.f.state["sessions"]["t3"]["since"].clone();
        x.f.live.screen_error = Some("t3");
        let out = x.run();
        has(&out, "t3", sessions::LOOKUP_HOLD);
        assert_eq!(x.f.state["sessions"]["t3"]["since"], since);
    }
    #[test]
    fn test_a_real_change_after_the_hold_still_resets_it() {
        let mut x = fixture();
        x.f.live.data["lookup_errors"] = json!({"t3":"timed out"});
        x.run();
        x.f.live
            .data
            .as_object_mut()
            .unwrap()
            .remove("lookup_errors");
        x.f.live.data["terminals"]["t3"]["pid"] = json!(4242);
        let out = x.at(NOW + 400., true);
        not_closed(&x, "p3");
        assert_eq!(x.f.state["sessions"]["t3"]["since"], NOW + 400.);
        assert_ne!(row(&out, "t3")["action"], "closed");
    }
    #[test]
    fn test_a_skipped_cycle_counts_as_looked_for_the_sample_gap() {
        assert_eq!(
            sessions::sample_gap(&json!({"last_at":NOW-900.,"held_at":NOW-300.}), NOW),
            300.
        );
        assert_eq!(
            sessions::sample_gap(&json!({"last_at":NOW-900.}), NOW),
            900.
        );
    }
}
mod cleanup_empty {
    use super::*;
    #[test]
    fn test_an_empty_agent_pane_is_not_a_session_and_does_not_hold_the_space() {
        let mut f = SpaceFixture::new();
        f.live.data["terminals"]["t-test"]["turn"] = json!(0);
        f.live.empty_turn_zero = true;
        f.live.jobs = (
            false,
            "backend jobs unverified: Claude log identity".into(),
            String::new(),
        );
        let snapshot = f.live.data.clone();
        let i = spaces::inspect(&snapshot["spaces"][1], &snapshot, &mut f.live, &f.config).unwrap();
        assert_eq!(i["safe"], true);
        assert_eq!(i["sessions"], json!([]));
        assert_eq!(i["empty_panes"], json!(["t-test"]));
    }
    #[test]
    fn test_an_empty_pane_with_typed_input_still_blocks() {
        let mut f = SpaceFixture::new();
        f.live.data["terminals"]["t-test"]["turn"] = json!(0);
        f.live.empty_turn_zero = true;
        f.live.text =
            "Completed requested task.\n› 아직 보내지 않은 글\nGPT-6.1 · 80% context left\n".into();
        f.live.jobs = (
            false,
            "backend jobs unverified: Claude log identity".into(),
            String::new(),
        );
        let snapshot = f.live.data.clone();
        let i = spaces::inspect(&snapshot["spaces"][1], &snapshot, &mut f.live, &f.config).unwrap();
        assert_eq!(i["safe"], false);
        assert_eq!(i["empty_panes"], json!([]));
    }
}
mod space_lookup_hold {
    use super::*;
    #[test]
    fn test_a_failed_lookup_keeps_the_space_idle_window() {
        let mut f = SpaceFixture::new();
        f.reset_state(300.);
        let since = f.state["spaces"]["temporary"]["since"].clone();
        f.live.screen_error = Some("t-test");
        let out = f.run(true).unwrap();
        assert!(reasons(item(&out, "id", "temporary")).contains(sessions::LOOKUP_HOLD));
        assert_eq!(f.state["spaces"]["temporary"]["since"], since);
        assert!(f.live.closed_spaces().is_empty());
        f.live.screen_error = None;
        let out = spaces::cycle(
            &mut f.live,
            &f.config,
            &mut f.state,
            NOW + 400.,
            true,
            Some("temporary"),
            &f.reports,
        )
        .unwrap();
        assert!(o::num(&item(&out, "id", "temporary")["quiet_seconds"], 0.) >= 600.);
        assert_eq!(f.live.closed_spaces(), ["temporary"]);
    }
    #[test]
    fn test_a_pane_lookup_error_in_the_space_is_held() {
        let mut f = SpaceFixture::new();
        f.reset_state(300.);
        let since = f.state["spaces"]["temporary"]["since"].clone();
        f.live.data["lookup_errors"] = json!({"t-test":"timed out"});
        let out = f.run(true).unwrap();
        assert!(reasons(item(&out, "id", "temporary")).contains(sessions::LOOKUP_HOLD));
        assert_eq!(f.state["spaces"]["temporary"]["since"], since);
    }
}
