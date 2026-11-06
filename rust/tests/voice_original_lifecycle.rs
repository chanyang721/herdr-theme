//! Assertions ported from the unchanged voice/tests/test_codex_focus_guard.py,
//! test_voice_recovery.py and test_voice_device_recovery.py. Runtime effects
//! are injected at the same boundaries the originals patch; no live app/audio.
use herdr_theme::voice::{queue, recovery, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    time::Duration,
};

// voice/tests/test_codex_voice_focus.py::CodexFocusTests, unchanged two calls.
// Its SettleTests focus-blink case lives in voice_original_dictation.rs and
// exercises the same production settled-routing backend.
#[test]
fn test_legacy_event_delegates_to_the_serialized_controller() {
    let mut calls = 0;
    let pane = json!({"pane_id":"p","agent":"codex"});
    let mut state = json!({});
    queue::set_voice_with_codex(&pane, true, &mut state, || {
        calls += 1;
        Ok(())
    })
    .unwrap();
    queue::set_voice_with_codex(&pane, false, &mut state, || {
        calls += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(calls, 2);
}

struct Guard {
    voices: BTreeMap<String, (bool, bool)>,
    focus: Option<String>,
    sequence: Option<VecDeque<Option<String>>>,
    identity: String,
    toggle_ok: bool,
    calls: Vec<(String, bool)>,
}
impl queue::GuardBackend for Guard {
    fn focus(&mut self) -> Option<String> {
        match self.sequence.as_mut() {
            Some(sequence) => sequence
                .pop_front()
                .expect("unexpected extra focus observation"),
            None => self.focus.clone(),
        }
    }
    fn voice(&mut self, id: &str) -> Result<(bool, bool)> {
        Ok(self.voices[id])
    }
    fn identity(&mut self, _: &Value) -> Result<String> {
        Ok(self.identity.clone())
    }
    fn toggle(&mut self, id: &str, on: bool) -> Result<bool> {
        self.calls.push((id.into(), on));
        if self.toggle_ok {
            self.voices.insert(id.into(), (on, !on));
        }
        Ok(self.toggle_ok)
    }
    fn report(&mut self, _: &str) {}
}
fn route(
    voices: &[(&str, (bool, bool))],
    focus: Option<&str>,
    owned: Value,
    identity: &str,
    toggle_ok: bool,
    sequence: Option<Vec<Option<&str>>>,
) -> (Vec<(String, bool)>, Map<String, Value>) {
    let mut backend = Guard {
        voices: voices.iter().map(|(id, v)| ((*id).into(), *v)).collect(),
        focus: focus.map(str::to_owned),
        sequence: sequence.map(|s| s.into_iter().map(|id| id.map(str::to_owned)).collect()),
        identity: identity.into(),
        toggle_ok,
        calls: vec![],
    };
    let current = backend
        .voices
        .keys()
        .map(|id| (id.clone(), json!({"pane_id":id})))
        .collect();
    let mut owned = owned.as_object().unwrap().clone();
    queue::reconcile(&current, &mut owned, &mut backend);
    if let Some(sequence) = backend.sequence {
        assert!(sequence.is_empty(), "missing original focus recheck");
    }
    (backend.calls, owned)
}
#[test]
fn test_other_microphone_is_muted_before_owned_focus_resumes() {
    let (calls, owned) = route(
        &[("a", (false, true)), ("b", (true, false))],
        Some("a"),
        json!({"a":"p:123"}),
        "p:123",
        true,
        None,
    );
    assert_eq!(calls, vec![("b".into(), false), ("a".into(), true)]);
    assert_eq!(owned, json!({"b":"p:123"}).as_object().unwrap().clone());
}
#[test]
fn test_initial_manual_mute_is_preserved() {
    assert!(route(
        &[("a", (false, true))],
        Some("a"),
        json!({}),
        "p:123",
        true,
        None
    )
    .0
    .is_empty());
}
#[test]
fn test_unknown_focus_mutes_every_live_microphone() {
    assert_eq!(
        route(
            &[("a", (true, false)), ("b", (true, false))],
            None,
            json!({}),
            "p:123",
            true,
            None
        )
        .0,
        vec![("a".into(), false), ("b".into(), false)]
    );
}
#[test]
fn test_failed_background_mute_prevents_unmute() {
    let (calls, owned) = route(
        &[("a", (false, true)), ("b", (true, false))],
        Some("a"),
        json!({"a":"p:123"}),
        "p:123",
        false,
        None,
    );
    assert_eq!(calls, vec![("b".into(), false)]);
    assert!(!owned.contains_key("b"));
}
#[test]
fn test_unknown_process_identity_can_mute_but_never_resume() {
    let (calls, owned) = route(
        &[("a", (true, false))],
        None,
        json!({}),
        "a:None",
        true,
        None,
    );
    assert_eq!(calls, vec![("a".into(), false)]);
    assert!(owned.is_empty());
    assert_eq!(
        route(
            &[("a", (false, true))],
            Some("a"),
            json!({"a":"a:None"}),
            "a:None",
            true,
            None
        ),
        (vec![], Map::new())
    );
}
#[test]
fn test_new_process_never_inherits_unmute_permission() {
    assert_eq!(
        route(
            &[("a", (false, true))],
            Some("a"),
            json!({"a":"p:122"}),
            "p:123",
            true,
            None
        ),
        (vec![], Map::new())
    );
}
#[test]
fn test_missing_connection_drops_resume_permission_without_keys() {
    assert_eq!(
        route(
            &[("a", (false, false))],
            Some("a"),
            json!({"a":"p:123"}),
            "p:123",
            true,
            None
        ),
        (vec![], Map::new())
    );
}
#[test]
fn test_ambiguous_footer_blocks_unmute_and_receives_no_keys() {
    assert!(route(
        &[("b", (true, true)), ("a", (false, true))],
        Some("a"),
        json!({"a":"p:123"}),
        "p:123",
        true,
        None
    )
    .0
    .is_empty());
}
#[test]
fn test_focus_change_during_unmute_is_immediately_remuted() {
    let (calls, owned) = route(
        &[("a", (false, true))],
        Some("a"),
        json!({"a":"p:123"}),
        "p:123",
        true,
        Some(vec![Some("a"), Some("a"), Some("a"), Some("b")]),
    );
    assert_eq!(calls, vec![("a".into(), true), ("a".into(), false)]);
    assert!(owned.contains_key("a"));
}
#[test]
fn test_focus_change_before_unmute_never_receives_key() {
    assert!(route(
        &[("a", (false, true))],
        Some("a"),
        json!({"a":"p:123"}),
        "p:123",
        true,
        Some(vec![Some("a"), Some("a"), Some("b")])
    )
    .0
    .is_empty());
}

const ERROR:&str="Voice conversation failed: voice audio session stopped unexpectedly\n\n› Ask Codex to do anything\n\nGPT-6.1-Sol medium\n? for shortcuts";
fn pane(focused: bool, status: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([(
        "app:t10".into(),
        json!({"pane_id":"app:t10","agent":"codex","agent_status":status,"focused":focused}),
    )])
}
fn record() -> Value {
    json!({"session":"app:t10:123","seen":true,"failure":{"id":30,"ts":100,"pid":"123"},"absent_since":100})
}
fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute("create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)",[]).unwrap();
    c
}
fn failure(c: &Connection, device: bool) {
    c.execute(
        "insert into logs values(1,100,'pid:123:aaaa','codex_realtime_webrtc::client',?)",
        [if device {
            "voice helper output closed phase=Some(Device) exit_code=Some(37)"
        } else {
            "voice helper output closed phase=Some(InspectAudio) exit_code=Some(28)"
        }],
    )
    .unwrap();
}
struct Recovery {
    panes: VecDeque<BTreeMap<String, Value>>,
    screens: VecDeque<String>,
    signature: Option<Value>,
    calls: Vec<String>,
    saved: Vec<Value>,
    clock: f64,
}
impl Recovery {
    fn new(panes: Vec<BTreeMap<String, Value>>, screens: Vec<String>) -> Self {
        Self {
            panes: panes.into(),
            screens: screens.into(),
            signature: None,
            calls: vec![],
            saved: vec![],
            clock: 0.,
        }
    }
}
impl recovery::RecoveryBackend for Recovery {
    fn now(&mut self) -> f64 {
        110.
    }
    fn monotonic(&mut self) -> f64 {
        self.clock
    }
    fn panes(&mut self) -> Result<BTreeMap<String, Value>> {
        self.calls.push("panes".into());
        if self.panes.len() > 1 {
            Ok(self.panes.pop_front().unwrap())
        } else {
            Ok(self
                .panes
                .front()
                .expect("unexpected pane observation")
                .clone())
        }
    }
    fn session_of(&mut self, pane: &Value) -> Result<String> {
        assert_eq!(pane["pane_id"], "app:t10");
        self.calls.push("session".into());
        Ok("app:t10:123".into())
    }
    fn screen(&mut self, id: &str) -> Result<String> {
        assert_eq!(id, "app:t10");
        self.calls.push("screen".into());
        Ok(self
            .screens
            .pop_front()
            .expect("unexpected screen observation"))
    }
    fn recent_failure(&mut self, _: &str) -> Option<bool> {
        self.calls.push("recent_failure".into());
        None
    }
    fn inspect_devices(&mut self) -> Option<Value> {
        self.calls.push("inspect_devices".into());
        self.signature.clone()
    }
    fn save(&mut self, state: &Value) -> Result<()> {
        self.calls.push("save".into());
        self.saved.push(state.clone());
        Ok(())
    }
    fn send_start(&mut self, id: &str) -> Result<()> {
        assert_eq!(id, "app:t10");
        self.calls.push("send_start".into());
        Ok(())
    }
    fn route(&mut self, advance: bool) -> Result<()> {
        assert!(advance);
        self.calls.push("route:true".into());
        Ok(())
    }
    fn report(&mut self, _: &str) {}
    fn sleep(&mut self, duration: Duration) {
        self.clock += duration.as_secs_f64();
    }
}
#[test]
fn test_normal_live_tick_sends_no_voice_command() {
    let c = db();
    let text = ERROR.replace("\n\n›", "\nvoice ◌ muted  /voice stop\n\n›");
    let mut backend = Recovery::new(vec![pane(true, "idle")], vec![text]);
    let mut state = json!({"cursor":0});
    recovery::tick_with(&mut state, &c, &mut backend).unwrap();
    assert_eq!(backend.calls, vec!["panes", "session", "screen", "save"]);
    assert!(backend.screens.is_empty());
}
#[test]
fn test_recovery_requires_fresh_focus_and_confirms_the_new_footer() {
    let c = db();
    failure(&c, false);
    let mut state = json!({"cursor":0,"panes":{"app:t10":record()}});
    let connected = ERROR.replace("\n\n›", "\nvoice ● listening /voice stop\n\n›");
    let mut backend = Recovery::new(
        vec![pane(true, "working")],
        vec![ERROR.into(), ERROR.into(), connected],
    );
    recovery::tick_with(&mut state, &c, &mut backend).unwrap();
    assert_eq!(
        backend.calls,
        vec![
            "panes",
            "session",
            "screen",
            "panes",
            "session",
            "screen",
            "save",
            "send_start",
            "screen",
            "route:true",
            "save"
        ]
    );
    assert!(state["panes"]["app:t10"].get("failure").is_none());
    assert_eq!(backend.saved[0]["panes"]["app:t10"]["attempted"], 1);
    assert!(backend.screens.is_empty());
}
#[test]
fn test_focus_change_before_action_cancels_recovery() {
    let c = db();
    let mut state = json!({"cursor":0,"panes":{"app:t10":record()}});
    let mut backend = Recovery::new(
        vec![pane(true, "idle"), pane(false, "idle")],
        vec![ERROR.into(), ERROR.into()],
    );
    recovery::tick_with(&mut state, &c, &mut backend).unwrap();
    assert_eq!(
        backend.calls,
        vec!["panes", "session", "screen", "panes", "session", "screen", "save"]
    );
    assert!(backend.screens.is_empty());
}
#[test]
fn test_upgrade_catches_only_recent_device_errors_once() {
    let c = Connection::open_in_memory().unwrap();
    c.execute(
        "create table logs(id integer primary key,ts integer,target text,feedback_log_body text)",
        [],
    )
    .unwrap();
    for (id, ts) in [(1, 1), (2, 950)] {
        c.execute("insert into logs values(?,?,'codex_realtime_webrtc::client','voice helper output closed phase=Some(Device) exit_code=Some(37)')",params![id,ts]).unwrap();
    }
    let mut state = json!({"cursor":9});
    recovery::upgrade_state(&mut state, &c, 1000.).unwrap();
    assert_eq!(state["cursor"], 1);
    state["cursor"] = json!(9);
    recovery::upgrade_state(&mut state, &c, 1001.).unwrap();
    assert_eq!(state["cursor"], 9);
}
#[test]
fn test_confirmed_device_closure_recovers_only_after_preflight() {
    let c = db();
    failure(&c, true);
    c.execute("insert into logs values(2,100,'pid:123:aaaa','codex_realtime_webrtc::session','voice session operation failed stage=AudioSession kind=\"closed\"')",[]).unwrap();
    let devices = json!({"SPAudioDataType":[{"_items":[{"_name":"Mic","coreaudio_default_audio_input_device":"spaudio_yes","coreaudio_device_input":1,"coreaudio_device_srate":48000},{"_name":"Speakers","coreaudio_default_audio_output_device":"spaudio_yes","coreaudio_device_output":2,"coreaudio_device_srate":48000}]}]});
    let signature = recovery::device_signature(&devices, Some(&json!({}))).unwrap();
    let mut state = json!({"cursor":0,"panes":{"app:t10":record()},"audio":{"signature":signature,"since":100}});
    let plain = ERROR.replace(
        "Voice conversation failed: voice audio session stopped unexpectedly",
        "",
    );
    let connected = ERROR.replace("\n\n›", "\nvoice ● listening /voice stop\n\n›");
    let mut backend = Recovery::new(
        vec![pane(true, "working")],
        vec![plain.clone(), plain, connected],
    );
    backend.signature = Some(signature);
    recovery::tick_with(&mut state, &c, &mut backend).unwrap();
    assert_eq!(
        backend.calls,
        vec![
            "panes",
            "session",
            "screen",
            "recent_failure",
            "inspect_devices",
            "panes",
            "session",
            "screen",
            "inspect_devices",
            "save",
            "send_start",
            "screen",
            "route:true",
            "save"
        ]
    );
    assert!(backend.screens.is_empty());
    assert!(state["panes"]["app:t10"].get("failure").is_none());
}
