//! The 36 original test_dictation.py and two test_app_dictation.py methods.
//! Only their existing mock boundaries (clock/pane/keys) are injected; every
//! assertion below runs the production queue transitions. No microphone opens.
use herdr_theme::voice::{
    queue::{
        self,
        dictation::{self, Backend, Timing},
    },
    Result,
};
use serde_json::{json, Value};
use std::collections::VecDeque;

#[derive(Debug)]
struct End;
impl std::fmt::Display for End {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("original Listener timeout")
    }
}
impl std::error::Error for End {}
enum Change {
    Keys(f64),
    Speech(&'static str, &'static str),
}
struct Pane {
    typed: String,
    level: usize,
    id: String,
    commands: Vec<Vec<String>>,
    speaker: &'static str,
    stop_after: Option<f64>,
    leave_after: Option<f64>,
    record_start: f64,
    clock: f64,
    limit: f64,
    key_seconds: f64,
    headset: bool,
    enter: usize,
    kept: (String, bool),
    events: VecDeque<(f64, Change)>,
    blocked: Option<f64>,
    pressed: Vec<String>,
    stub_press: bool,
    draft_only: bool,
    verdicts: VecDeque<&'static str>,
    restored: Vec<(String, String, String)>,
    capture_restore: bool,
    typed_back: Vec<String>,
}
impl Pane {
    fn new(text: &str, level: usize) -> Self {
        Self {
            typed: text.into(),
            level,
            id: "p".into(),
            commands: vec![],
            speaker: "me",
            stop_after: None,
            leave_after: None,
            record_start: 100.,
            clock: 100.,
            limit: f64::INFINITY,
            key_seconds: 60.,
            headset: true,
            enter: 0,
            kept: (String::new(), false),
            events: VecDeque::new(),
            blocked: None,
            pressed: vec![],
            stub_press: false,
            draft_only: false,
            verdicts: VecDeque::new(),
            restored: vec![],
            capture_restore: false,
            typed_back: vec![],
        }
    }
    fn focused(&self) -> bool {
        self.leave_after
            .is_none_or(|after| self.clock - self.record_start < after)
    }
    fn is_recording(&self) -> bool {
        self.focused()
            && self
                .stop_after
                .is_none_or(|after| self.clock - self.record_start < after)
    }
    fn original_timing() -> Timing {
        Timing {
            end_pause: 0.5,
            finish: 1.5,
            ..Timing::default()
        }
    }
    fn run(&mut self, seconds: f64, t: Timing) -> usize {
        self.limit = self.clock + seconds;
        let id = self.id.clone();
        let result = dictation::listen_with(&id, self, t);
        if let Err(error) = result {
            assert!(error.is::<End>(), "unexpected product error: {error}");
        }
        self.enter
    }
    fn later(&mut self, after: f64, change: Change) {
        self.events.push_back((self.clock + after, change));
    }
    fn key_names(&self) -> Vec<&str> {
        self.commands
            .iter()
            .flat_map(|c| {
                c.iter()
                    .skip(if c.get(1).map(String::as_str) == Some("keys") {
                        3
                    } else {
                        4
                    })
            })
            .map(String::as_str)
            .collect()
    }
}
impl Backend for Pane {
    fn clock(&self) -> f64 {
        self.clock
    }
    fn pause(&mut self, seconds: f64) {
        self.clock += seconds;
        while self.events.front().is_some_and(|(at, _)| *at <= self.clock) {
            match self.events.pop_front().unwrap().1 {
                Change::Keys(seconds) => self.key_seconds = seconds,
                Change::Speech(speaker, text) => {
                    self.key_seconds = 60.;
                    self.speaker = speaker;
                    self.typed.push_str(text);
                }
            }
        }
    }
    fn pane(&mut self, id: &str) -> Result<Value> {
        if self.clock > self.limit {
            return Err(Box::new(End));
        }
        Ok(json!({"pane_id":id,"focused":self.focused(),"agent":"claude","agent_status":"idle"}))
    }
    fn screen(&mut self, _: &str) -> Result<String> {
        Ok(String::new())
    }
    fn composer(&self, _: &str) -> String {
        self.typed.clone()
    }
    fn recording_footer(&self, _: &str) -> bool {
        self.is_recording()
    }
    fn level(&self, _: &str) -> usize {
        self.level
    }
    fn ready(&self, text: &str, draft: bool) -> bool {
        if self.draft_only {
            draft
        } else {
            queue::input_ready(text, "❯", draft)
        }
    }
    fn speaker(&mut self, _: f64, _: Option<f64>) -> (&'static str, Option<f64>) {
        let speaker = if self.verdicts.len() > 1 {
            self.verdicts.pop_front().unwrap()
        } else {
            self.verdicts.front().copied().unwrap_or(self.speaker)
        };
        (speaker, None)
    }
    fn headset(&self) -> bool {
        self.headset
    }
    fn front(&mut self) -> Result<bool> {
        Ok(true)
    }
    fn key_seconds(&self) -> f64 {
        self.key_seconds
    }
    fn last_heard(&self) -> f64 {
        0.
    }
    fn gate_running(&self) -> bool {
        true
    }
    fn start_gate(&mut self) -> Result<()> {
        Ok(())
    }
    fn read_kept(&self, _: &str) -> (String, bool) {
        self.kept.clone()
    }
    fn write_kept(&mut self, _: &str, text: &str, spoken: bool) -> Result<()> {
        self.kept = (text.into(), spoken);
        Ok(())
    }
    fn blocked_at(&self, _: &str) -> Option<f64> {
        self.blocked
    }
    fn remove_blocked(&mut self, _: &str) -> Result<()> {
        self.blocked = None;
        Ok(())
    }
    fn armed(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn recording_since(&self, _: &str) -> f64 {
        100.
    }
    fn recent_active(&self, _: &str) -> bool {
        false
    }
    fn mark_active(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn keys(&mut self, id: &str, keys: &[&str]) -> Result<()> {
        let (program, args) = queue::key_command(id, keys);
        let command = std::iter::once(program).chain(args).collect::<Vec<_>>();
        self.commands.push(command);
        match keys.last().copied() {
            Some("enter") => {
                self.enter += 1;
                self.typed.clear();
            }
            Some("backspace") => self.typed.clear(),
            _ => {}
        }
        Ok(())
    }
    fn type_text(&mut self, _: &str, text: &str) -> Result<bool> {
        self.typed_back.push(text.into());
        Ok(true)
    }
    fn confirm(&mut self, _: Option<f64>) -> Result<()> {
        Ok(())
    }
    fn advance(&mut self) -> Result<()> {
        Ok(())
    }
    fn report(&mut self, _: &str) {}
    fn press(&mut self, id: &str, key: &str, on: bool, seconds: f64) -> Result<bool> {
        if self.stub_press {
            self.pressed.push(key.into());
            Ok(true)
        } else {
            dictation::press_with(self, id, key, on, seconds)
        }
    }
    fn restore(&mut self, id: &str, before: &str, speaker: &str, t: Timing) -> Result<()> {
        if self.capture_restore {
            self.restored
                .push((id.into(), before.into(), speaker.into()));
            Ok(())
        } else {
            dictation::restore_box(id, before, speaker, self, t)
        }
    }
}

mod discard_tests {
    use super::*;
    #[test]
    fn test_dictation_the_gate_did_not_pass_is_gone_before_claude_submits_it() {
        assert!(Timing::default().discard < 15.);
        let mut p = Pane::new("옆 사람 말입니다.", 2);
        p.speaker = "other";
        p.run(
            3.,
            Timing {
                discard: 0.5,
                ..Pane::original_timing()
            },
        );
        assert_eq!(p.enter, 0);
        assert_eq!(p.typed, "");
        assert!(p
            .commands
            .iter()
            .any(|c| c.last().map(String::as_str) == Some("esc")));
    }
}
mod stopped_recording_tests {
    use super::*;
    fn left_in_box(text: &str, speaker: &'static str) -> (usize, String) {
        let mut p = Pane::new(text, 2);
        p.stop_after = Some(0.5);
        p.speaker = speaker;
        let sent = p.run(
            2.5,
            Timing {
                settle: 0.3,
                end_pause: 9.,
                discard: 9.,
                ..Pane::original_timing()
            },
        );
        (sent, p.typed)
    }
    #[test]
    fn test_own_text_is_sent_so_the_next_recording_can_start() {
        assert_eq!(left_in_box("작업 중에 말한 내용", "me"), (1, "".into()));
    }
    #[test]
    fn test_other_voice_is_erased_not_sent() {
        assert_eq!(left_in_box("옆 사람 말", "other"), (0, "".into()));
    }
}
mod stop_key_tests {
    use super::*;
    fn key(text: &str, speaker: &str, status: &str, headset: bool) -> &'static str {
        dictation::stop_key(text, status, speaker, headset)
    }
    #[test]
    fn test_own_dictation_is_finished_not_discarded() {
        assert_eq!(key("말한 내용", "me", "idle", true), "f8");
    }
    #[test]
    fn test_dictation_on_an_unlearned_microphone_is_discarded() {
        assert_eq!(key("말한 내용", "unknown", "idle", true), "esc");
    }
    #[test]
    fn test_own_voice_on_a_laptop_microphone_is_not_sent() {
        assert_eq!(key("말한 내용", "me", "idle", false), "esc");
    }
    #[test]
    fn test_other_voice_is_discarded() {
        assert_eq!(key("옆 사람 말", "other", "idle", true), "esc");
        assert_eq!(key("판정 없음", "unknown", "idle", true), "esc");
    }
    #[test]
    fn test_speech_from_before_this_recording_does_not_finish_it() {
        let segments = [json!({"start":950,"end":990,"seconds":40,"score":0.7,"me":true})];
        let speaker = queue::voice_state_from(&segments, 1000., None, true).0;
        assert_eq!(key("옆 사람 말", speaker, "working", true), "esc");
    }
    #[test]
    fn test_empty_recording_only_takes_esc_when_idle() {
        assert_eq!(key("", "unknown", "idle", true), "esc");
        assert_eq!(key("", "unknown", "working", true), "f8");
    }
}
struct VoiceOn {
    recording: bool,
    text: String,
    pressed: Vec<String>,
}
impl queue::VoiceOnBackend for VoiceOn {
    fn listening(&mut self, _: &str) -> bool {
        false
    }
    fn screen(&mut self, _: &str) -> Result<String> {
        Ok(self.text.clone())
    }
    fn recording_footer(&mut self, _: &str) -> bool {
        self.recording
    }
    fn session(&mut self, _: &Value) -> Result<String> {
        Ok("s".into())
    }
    fn ready(&mut self, _: &str) -> Result<bool> {
        Ok(true)
    }
    fn eligible(&mut self) -> Result<bool> {
        Ok(true)
    }
    fn start(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn press_on(&mut self, _: &str) -> Result<bool> {
        self.pressed.push("f8".into());
        Ok(false)
    }
    fn clock(&self) -> f64 {
        100.
    }
    fn report(&mut self, _: &str) {}
}
mod voice_key_tests {
    use super::*;
    fn turn_on(failures: Value, recording: bool, text: &str) -> (Vec<String>, Value) {
        let mut b = VoiceOn {
            recording,
            text: text.into(),
            pressed: vec![],
        };
        let mut state = json!({"voice_key_failures":failures});
        queue::set_voice_on(
            &json!({"pane_id":"w8:p12","agent":"claude","agent_status":"idle"}),
            &mut state,
            &mut b,
        )
        .unwrap();
        (b.pressed, state["voice_key_failures"].clone())
    }
    #[test]
    fn test_two_misses_hold_the_key_back_for_a_while() {
        assert!(turn_on(json!({"s":[2,100]}), false, "").0.is_empty());
    }
    #[test]
    fn test_misses_do_not_lock_a_session_out_for_good() {
        assert_eq!(turn_on(json!({"s":[2,39]}), false, "").0, vec!["f8"]);
    }
    #[test]
    fn test_a_count_saved_before_the_retry_is_tried_again() {
        assert_eq!(turn_on(json!({"s":2}), false, "").0, vec!["f8"]);
    }
    #[test]
    fn test_turning_voice_back_on_lifts_the_hold_at_once() {
        assert_eq!(
            turn_on(
                json!({"s":[2,100]}),
                false,
                "Voice mode enabled (tap). Tap f8"
            )
            .0,
            vec!["f8"]
        );
    }
    #[test]
    fn test_a_recording_clears_the_misses() {
        assert_eq!(turn_on(json!({"s":[2,100]}), true, "").1, json!({}));
    }
}
mod refused_dictation_tests {
    use super::*;
    fn clear(text: &str, age: f64) -> (bool, Pane) {
        let mut p = Pane::new(text, 0);
        p.blocked = Some(p.clock - age);
        let result = dictation::clear_blocked("p", &mut p).unwrap();
        (result, p)
    }
    #[test]
    fn test_refused_text_is_erased_when_it_comes_back() {
        let (result, p) = clear("옆 사람 말", 0.);
        assert!(result);
        assert_eq!(p.commands.len(), 1);
        assert_eq!(p.key_names(), vec!["backspace"; 6]);
        assert!(p.blocked.is_none());
    }
    #[test]
    fn test_waits_for_the_text_to_come_back() {
        assert!(clear("", 0.).1.blocked.is_some());
    }
    #[test]
    fn test_a_late_draft_is_left_alone() {
        let (_, p) = clear("새로 친 글", 6.);
        assert!(p.commands.is_empty());
        assert!(p.blocked.is_none());
    }
}
mod hand_typed_tests {
    use super::*;
    #[test]
    fn test_typing_while_recording_is_neither_erased_nor_sent() {
        let mut p = Pane::new("직접 친 메시지.", 3);
        p.speaker = "unknown";
        p.key_seconds = 0.2;
        assert_eq!(
            p.run(
                2.,
                Timing {
                    discard: 0.5,
                    ..Pane::original_timing()
                }
            ),
            0
        );
        assert_eq!(p.typed, "직접 친 메시지.");
        assert!(!p
            .commands
            .iter()
            .any(|c| ["esc", "backspace"].contains(&c.last().unwrap().as_str())));
    }
    #[test]
    fn test_typed_text_left_after_the_recording_ends_stays() {
        let mut p = Pane::new("직접 친 메시지", 3);
        p.stop_after = Some(0.5);
        p.speaker = "unknown";
        p.key_seconds = 0.2;
        assert_eq!(
            p.run(
                2.5,
                Timing {
                    settle: 0.3,
                    discard: 9.,
                    ..Pane::original_timing()
                }
            ),
            0
        );
        assert_eq!(p.typed, "직접 친 메시지");
    }
    #[test]
    fn test_a_dictation_corrected_by_hand_is_not_sent() {
        let mut p = Pane::new("받아쓴 뒤 고친 문장.", 3);
        p.run(0.5, Pane::original_timing());
        p.key_seconds = 0.2;
        p.record_start = p.clock;
        assert_eq!(p.run(2., Pane::original_timing()), 0);
        assert_eq!(p.typed, "받아쓴 뒤 고친 문장.");
    }
    #[test]
    fn test_own_speech_after_a_correction_is_sent() {
        let mut p = Pane::new("받아쓴 뒤 고친", 3);
        p.later(0.5, Change::Keys(0.2));
        p.later(1.1, Change::Speech("me", " 문장입니다."));
        assert_eq!(p.run(3., Pane::original_timing()), 1);
    }
    #[test]
    fn test_other_voice_after_a_correction_takes_only_its_own_words() {
        let mut p = Pane::new("받아쓴 뒤 고친", 3);
        p.later(0.5, Change::Keys(0.2));
        p.later(1.1, Change::Speech("other", " 문장입니다."));
        assert_eq!(
            p.run(
                2.5,
                Timing {
                    discard: 0.5,
                    end_pause: 9.,
                    ..Pane::original_timing()
                }
            ),
            0
        );
        let keys = p.key_names();
        assert!(!keys.contains(&"esc"));
        assert_eq!(
            keys.iter().filter(|key| **key == "backspace").count(),
            " 문장입니다.".chars().count()
        );
    }
    #[test]
    fn test_a_corrected_dictation_gets_the_next_recording() {
        let mut p = Pane::new("받아쓴 뒤 고친", 3);
        p.stop_after = Some(0.4);
        p.later(0.5, Change::Keys(0.2));
        p.later(1., Change::Keys(60.));
        p.stub_press = true;
        p.draft_only = true;
        p.run(
            1.8,
            Timing {
                settle: 9.,
                ..Pane::original_timing()
            },
        );
        assert!(p.pressed.iter().any(|key| key == "f8"));
        assert_eq!(p.typed, "받아쓴 뒤 고친");
    }
    #[test]
    fn test_a_typed_draft_does_not_start_a_recording() {
        let mut p = Pane::new("손으로 친 초안", 3);
        p.key_seconds = 0.2;
        p.stop_after = Some(0.);
        p.later(0.5, Change::Keys(60.));
        p.stub_press = true;
        p.draft_only = true;
        p.run(1.3, Pane::original_timing());
        assert!(!p.pressed.iter().any(|key| key == "f8"));
    }
}
mod leaving_pane_tests {
    use super::*;
    fn leave(judged: Vec<&'static str>) -> Pane {
        let mut p = Pane::new("내가 한 말입니다.", 0);
        p.id = "w8:p1".into();
        p.verdicts = judged.into();
        p.capture_restore = true;
        p.stub_press = true;
        dictation::voice_off(
            &json!({"pane_id":"w8:p1","agent":"claude","agent_status":"idle"}),
            &mut json!({}),
            &mut p,
            Timing {
                leave_judge: 1.,
                ..Timing::default()
            },
        )
        .unwrap();
        p
    }
    #[test]
    fn test_speech_judged_a_moment_later_is_finished_not_discarded() {
        let p = leave(vec!["unknown", "unknown", "me"]);
        assert_eq!(p.pressed, vec!["f8"]);
        assert!(p.restored.is_empty());
    }
    #[test]
    fn test_unjudged_speech_is_put_back_after_esc() {
        let p = leave(vec!["unknown"]);
        assert_eq!(p.pressed, vec!["esc"]);
        assert_eq!(p.restored[0].1, "내가 한 말입니다.");
        assert_eq!(p.restored[0].2, "unknown");
    }
    #[test]
    fn test_other_voice_is_still_discarded() {
        let p = leave(vec!["other"]);
        assert_eq!(p.pressed, vec!["esc"]);
        assert_eq!(p.restored[0].2, "other");
    }
}
mod restore_box_tests {
    use super::*;
    fn restore(id: &str, speaker: &str, kept: &str) -> (Vec<String>, (String, bool)) {
        let mut p = Pane::new("", 0);
        p.kept = (kept.into(), !kept.is_empty());
        dictation::restore_box(
            id,
            "내가 한 말입니다.",
            speaker,
            &mut p,
            Timing {
                settle: 0.,
                ..Timing::default()
            },
        )
        .unwrap();
        (p.typed_back, p.kept)
    }
    #[test]
    fn test_unjudged_speech_is_typed_back_and_kept() {
        assert_eq!(
            restore("w8:p1", "unknown", ""),
            (
                vec!["내가 한 말입니다.".into()],
                ("내가 한 말입니다.".into(), true)
            )
        );
    }
    #[test]
    fn test_other_voice_leaves_only_what_the_user_kept() {
        assert_eq!(restore("w8:p1", "other", "내가 고친").0, vec!["내가 고친"]);
        assert!(restore("w8:p1", "other", "").0.is_empty());
    }
    #[test]
    fn test_app_panes_cannot_be_typed_into() {
        assert!(restore("app:t1", "unknown", "").0.is_empty());
    }
}
mod laptop_microphone_tests {
    use super::*;
    #[test]
    fn test_recording_is_stopped_and_not_restarted() {
        let mut p = Pane::new("", 0);
        p.headset = false;
        p.run(1.5, Pane::original_timing());
        let keys = p.key_names();
        assert!(keys.contains(&"esc"));
        assert!(!keys.contains(&"f8"));
    }
    #[test]
    fn test_nothing_dictated_is_sent() {
        let mut p = Pane::new("옆 사람 말입니다.", 5);
        p.headset = false;
        assert_eq!(p.run(2., Pane::original_timing()), 0);
    }
}
mod dictation_tests {
    use super::*;
    #[test]
    fn test_room_noise_does_not_hold_back_a_finished_sentence() {
        assert_eq!(
            Pane::new("확인해봐.", 5).run(3., Pane::original_timing()),
            1
        );
    }
    #[test]
    fn test_unfinished_sentence_is_not_sent() {
        assert_eq!(
            Pane::new("사이즈를", 5).run(1.5, Pane::original_timing()),
            0
        );
    }
    #[test]
    fn test_finished_sentence_is_sent_after_focus_left() {
        let mut p = Pane::new("확인해봐.", 5);
        p.leave_after = Some(0.7);
        assert_eq!(p.run(3., Pane::original_timing()), 1);
    }
    #[test]
    fn test_unfinished_sentence_stays_after_focus_left() {
        let mut p = Pane::new("사이즈를", 5);
        p.leave_after = Some(0.7);
        assert_eq!(p.run(3., Pane::original_timing()), 0);
    }
}
mod native_dictation_tests {
    use super::*;
    fn assert_core_target(p: &Pane) {
        let enter = p
            .commands
            .iter()
            .filter(|c| c.last().map(String::as_str) == Some("enter"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            enter,
            vec![vec![
                queue::core(),
                "keys".into(),
                "t10".into(),
                "enter".into()
            ]]
        );
    }
    #[test]
    fn test_finished_native_dictation_targets_its_core_terminal() {
        let mut p = Pane::new("Continue.", 5);
        p.id = "app:t10".into();
        assert_eq!(p.run(3., Pane::original_timing()), 1);
        assert_core_target(&p);
    }
    #[test]
    fn test_finishing_after_focus_left_keeps_the_original_core_target() {
        let mut p = Pane::new("Continue.", 5);
        p.id = "app:t10".into();
        p.leave_after = Some(0.7);
        assert_eq!(p.run(3., Pane::original_timing()), 1);
        assert_core_target(&p);
    }
}
// Original test_codex_voice_focus.SettleTests. The same production settling
// phase used by main_event consumes the second and third pane snapshots.
mod settle_tests {
    use super::*;
    fn view(focus: &str) -> std::collections::BTreeMap<String, Value> {
        ["blink","real"].into_iter().map(|id|(id.into(),json!({"pane_id":id,"agent":"claude","agent_status":"idle","focused":id==focus}))).collect()
    }
    struct Focus {
        snapshots: VecDeque<std::collections::BTreeMap<String, Value>>,
        calls: Vec<(String, bool)>,
    }
    impl queue::FocusBackend for Focus {
        fn pause(&mut self, _: f64) {}
        fn active(&mut self) -> bool {
            true
        }
        fn panes(&mut self) -> Result<std::collections::BTreeMap<String, Value>> {
            Ok(if self.snapshots.len() > 1 {
                self.snapshots.pop_front().unwrap()
            } else {
                self.snapshots.front().unwrap().clone()
            })
        }
        fn codex_sync(&mut self) -> Result<()> {
            panic!("original fixture contains no Codex panes")
        }
        fn voice(&mut self, pane: &Value, on: bool, _: &mut Value) -> Result<()> {
            self.calls
                .push((pane["pane_id"].as_str().unwrap().into(), on));
            Ok(())
        }
        fn report(&mut self, _: &str) {}
    }
    #[test]
    fn test_a_focus_blink_never_moves_the_microphone() {
        let mut b = Focus {
            snapshots: VecDeque::from([view("real"), view("real")]),
            calls: vec![],
        };
        queue::settle_voice_with(view("blink"), Some("blink".into()), &mut json!({}), &mut b)
            .unwrap();
        assert_eq!(
            b.calls,
            vec![("real".into(), true), ("blink".into(), false)]
        );
    }
}
// Original test_voice_device_recovery.DeviceRecoveryTests and
// test_app_backend.NativeVoiceSafetyTests/StaleHeartbeatTests startup guards.
mod app_codex_startup_tests {
    use super::*;
    struct Startup {
        value: Value,
        text: String,
        starts: Vec<String>,
    }
    impl queue::AppCodexBackend for Startup {
        fn focus(&mut self) -> Option<Value> {
            Some(self.value.clone())
        }
        fn screen(&mut self, _: &str) -> Result<String> {
            Ok(self.text.clone())
        }
        fn start(&mut self, terminal: &str) -> Result<()> {
            self.starts.push(terminal.into());
            Ok(())
        }
        fn clock(&self) -> f64 {
            100.
        }
        fn pause(&mut self, _: f64) {
            panic!("original guard must return without starting or polling")
        }
        fn report(&mut self, _: &str) {}
    }
    fn startup(text: &str, asked: bool) -> Startup {
        Startup {
            value: json!({"active":true,"terminal":"t8","asked":asked,"panes":[{"pane_id":"app:t8","agent":"codex","agent_status":"idle"}]}),
            text: text.into(),
            starts: vec![],
        }
    }
    #[test]
    fn test_focus_startup_does_not_bypass_device_failure_recovery() {
        let mut b=startup("Voice conversation failed: voice audio session stopped unexpectedly\n\n› Ask Codex to do anything\n\nGPT-6.1-Sol medium\n? for shortcuts",false);
        queue::prepare_app_codex_with(&mut b).unwrap();
        assert!(b.starts.is_empty());
    }
    #[test]
    fn test_existing_codex_connection_is_never_toggled() {
        let mut b = startup("voice listening /voice stop", false);
        queue::prepare_app_codex_with(&mut b).unwrap();
        assert!(b.starts.is_empty());
    }
    #[test]
    fn test_asked_focus_never_starts_a_voice_connection() {
        let mut b = startup("› \n? for shortcuts", true);
        queue::prepare_app_codex_with(&mut b).unwrap();
        assert!(b.starts.is_empty());
    }
    #[test]
    fn test_native_microphone_key_goes_only_to_its_target() {
        let (program, args) = queue::key_command("app:t8", &["f9"]);
        assert_eq!(
            std::iter::once(program).chain(args).collect::<Vec<_>>(),
            vec![queue::core(), "keys".into(), "t8".into(), "f9".into()]
        );
    }
}
