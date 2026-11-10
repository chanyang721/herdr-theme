//! What the dictation watcher publishes for the pane header's microphone badge.
//! A scripted pane drives the production `listen_with`; only the published
//! changes are checked, and nothing touches a real pane, microphone or file.
use herdr_theme::voice::{
    queue::{
        dictation::{self, Backend, Timing},
        mic::{Change, Mic},
    },
    Result,
};
use serde_json::{json, Value};

#[derive(Debug)]
struct End;
impl std::fmt::Display for End {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("scripted pane ended")
    }
}
impl std::error::Error for End {}

struct Sim {
    clock: f64,
    limit: f64,
    leave_at: f64,
    headset: bool,
    dialog: bool,
    recording: bool,
    typed: String,
    speaker: &'static str,
    mics: Vec<(f64, Change)>,
}
impl Sim {
    fn new() -> Self {
        Self {
            clock: 100.,
            limit: f64::INFINITY,
            leave_at: f64::INFINITY,
            headset: true,
            dialog: false,
            recording: true,
            typed: String::new(),
            speaker: "me",
            mics: vec![],
        }
    }
    fn run(&mut self, seconds: f64) {
        self.limit = self.clock + seconds;
        if let Err(error) = dictation::listen_with("p", self, Timing::default()) {
            assert!(error.is::<End>(), "unexpected product error: {error}");
        }
    }
    fn changes(&self) -> Vec<Change> {
        self.mics.iter().map(|(_, c)| c.clone()).collect()
    }
}
impl Backend for Sim {
    fn clock(&self) -> f64 {
        self.clock
    }
    fn pause(&mut self, seconds: f64) {
        self.clock += seconds;
    }
    fn pane(&mut self, _: &str) -> Result<Value> {
        if self.clock > self.limit {
            return Err(End.into());
        }
        Ok(json!({"pane_id":"p","agent":"claude","agent_status":"idle",
            "focused": self.clock < self.leave_at}))
    }
    fn screen(&mut self, _: &str) -> Result<String> {
        if self.dialog {
            return Ok("Do you want to proceed?\n  1. Yes\n  2. No".into());
        }
        let level = if self.typed.is_empty() { "" } else { " ▄" };
        let rec = if self.recording { "REC · 0:02\n" } else { "" };
        Ok(format!("{rec}────────\n❯ {}{level}", self.typed))
    }
    fn speaker(&mut self, _: f64, _: Option<f64>) -> (&'static str, Option<f64>) {
        (self.speaker, None)
    }
    fn headset(&self) -> bool {
        self.headset
    }
    fn front(&mut self) -> Result<bool> {
        Ok(true)
    }
    fn key_seconds(&self) -> f64 {
        60.
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
        (String::new(), false)
    }
    fn write_kept(&mut self, _: &str, _: &str, _: bool) -> Result<()> {
        Ok(())
    }
    fn blocked_at(&self, _: &str) -> Option<f64> {
        None
    }
    fn remove_blocked(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn armed(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn recording_since(&self, _: &str) -> f64 {
        0.
    }
    fn recent_active(&self, _: &str) -> bool {
        false
    }
    fn mark_active(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn keys(&mut self, _: &str, keys: &[&str]) -> Result<()> {
        for key in keys {
            match *key {
                "f8" => self.recording = !self.recording,
                "esc" => self.recording = false,
                "backspace" => {
                    self.typed.pop();
                }
                "enter" => self.typed.clear(),
                _ => {}
            }
        }
        Ok(())
    }
    fn type_text(&mut self, _: &str, text: &str) -> Result<bool> {
        self.typed.push_str(text);
        Ok(true)
    }
    fn confirm(&mut self, _: Option<f64>) -> Result<()> {
        Ok(())
    }
    fn advance(&mut self) -> Result<()> {
        Ok(())
    }
    fn report(&mut self, _: &str) {}
    fn mic(&mut self, _: &str, change: Change) {
        self.mics.push((self.clock, change));
    }
}

#[test]
fn recording_is_published_once_and_removed_when_focus_leaves() {
    let mut p = Sim::new();
    p.leave_at = p.clock + 5.;
    p.run(10.);
    assert_eq!(
        p.changes(),
        vec![Change::State(Some(Mic::Recording)), Change::State(None)],
        "dozens of polls, two writes"
    );
}

#[test]
fn a_non_headset_input_is_shown_as_paused_not_off() {
    let mut p = Sim::new();
    p.headset = false;
    p.run(5.);
    assert_eq!(
        p.changes(),
        vec![Change::State(Some(Mic::Paused("headset")))]
    );
    assert!(!p.recording, "the watcher still stops the recording");
}

#[test]
fn a_missing_rec_footer_turns_off_only_after_it_stays_missing() {
    let mut p = Sim::new();
    p.dialog = true;
    let start = p.clock;
    p.run(5.);
    assert_eq!(
        p.changes(),
        vec![Change::State(Some(Mic::Off("not_ready")))]
    );
    assert!(
        p.mics[0].0 - start >= 1.5,
        "no flicker between a send and its re-arm"
    );
}

#[test]
fn a_sent_dictation_does_not_flicker_the_badge() {
    let mut p = Sim::new();
    p.typed = "보내 줘.".into();
    p.run(8.);
    assert_eq!(p.typed, "", "the sentence was sent");
    assert_eq!(p.changes(), vec![Change::State(Some(Mic::Recording))]);
}

#[test]
fn another_voice_is_shown_briefly_then_cleared() {
    let mut p = Sim::new();
    p.typed = "남의 말".into();
    p.speaker = "other";
    p.run(15.);
    let changes = p.changes();
    assert_eq!(
        changes,
        vec![
            Change::State(Some(Mic::Recording)),
            Change::Dropped {
                cause: "other",
                chars: 4
            },
            Change::ClearDropped,
        ]
    );
    let shown = p.mics[2].0 - p.mics[1].0;
    assert!((8. ..9.).contains(&shown), "shown for {shown} s");
}
