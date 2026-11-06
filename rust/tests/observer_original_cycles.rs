//! Native translations of existing lifecycle tests in test_session_sleep.py and
//! test_close_finished_spaces.py. The fake adapters below have the same fault
//! boundaries as those originals; they never call an app, core, or harness.
use herdr_theme::observers::{self as o, sessions, sleep, spaces, Adapter, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
const NOW: f64 = 1_800_000_000.;
const SID: &str = "11111111-2222-3333-4444-555555555555";

struct Fake {
    data: Value,
    text: String,
    mapping: Value,
    calls: Vec<Value>,
    archives: Vec<Value>,
    reads: Vec<String>,
    screen_error: Option<&'static str>,
    reported: bool,
    report_at: Option<f64>,
    park_ok: bool,
    fail_closed: usize,
    close_stays: bool,
    close_error: bool,
    closed_pane: bool,
    unreadable_after_close: bool,
    snapshot_error: bool,
    snapshots: usize,
    second_snapshot: Option<&'static str>,
    park_change: Option<&'static str>,
    archive_error: bool,
    space_close_stays: bool,
    space_close_error: bool,
    focus_after_close: bool,
    report_dir: PathBuf,
    panic_after_close: bool,
    raw: String,
    jobs: (bool, String, String),
    child_session: Value,
    gate_blockers: Vec<String>,
    gate_unavailable: bool,
    parks_with_sessions: Vec<(String, String)>,
    space_job: bool,
    exits: bool,
    child_from_terminal: bool,
    texts: std::collections::BTreeMap<String, String>,
    empty_turn_zero: bool,
    wake_mapping: Option<Value>,
    type_during_park: Option<String>,
}
impl Fake {
    fn new(kind: &str, report_dir: &Path) -> Self {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/observer-inspect.json")).unwrap();
        let fixture = cases
            .into_iter()
            .find(|v| v["kind"] == kind && v["case"] == "normal")
            .unwrap();
        let mut data = fixture["snapshot"].clone();
        // Literal e383c3c fixture rename: Share is now a user-controlled space.
        if kind == "sleep" {
            data["spaces"][0]["name"] = json!("Shown space");
        }
        // The original tests mock git_info. Null folders keep this isolated
        // equivalent adapter from spawning Git while exercising the same gates.
        for terminal in data["terminals"].as_object_mut().unwrap().values_mut() {
            terminal["cwd"] = Value::Null;
        }
        for space in data["spaces"].as_array_mut().unwrap() {
            space["folder"] = Value::Null;
        }
        Self {
            data,
            text: o::s(&fixture["text"]).into(),
            mapping: fixture["mapping"].clone(),
            calls: vec![],
            archives: vec![],
            reads: vec![],
            screen_error: None,
            reported: true,
            report_at: None,
            park_ok: true,
            fail_closed: 0,
            close_stays: false,
            close_error: false,
            closed_pane: false,
            unreadable_after_close: false,
            snapshot_error: false,
            snapshots: 0,
            second_snapshot: None,
            park_change: None,
            archive_error: false,
            space_close_stays: false,
            space_close_error: false,
            focus_after_close: false,
            report_dir: report_dir.into(),
            panic_after_close: false,
            raw: String::new(),
            jobs: (true, String::new(), "jobs".into()),
            child_session: Value::Null,
            gate_blockers: vec![],
            gate_unavailable: false,
            parks_with_sessions: vec![],
            space_job: kind == "space",
            exits: true,
            child_from_terminal: false,
            texts: Default::default(),
            empty_turn_zero: false,
            wake_mapping: None,
            type_during_park: None,
        }
    }
    fn events(&self, event: &str) -> Vec<Value> {
        self.calls
            .iter()
            .filter(|v| v[0] == event)
            .cloned()
            .collect()
    }
    fn parks(&self) -> Vec<String> {
        self.events("park")
            .iter()
            .map(|v| o::s(&v[1]).to_owned())
            .collect()
    }
    fn closed_spaces(&self) -> Vec<String> {
        self.events("space.close")
            .iter()
            .map(|v| o::s(&v[1]).to_owned())
            .collect()
    }
    fn quiet(&mut self) {
        self.calls.clear();
        self.reads.clear();
        self.snapshots = 0;
    }
    fn change(&mut self, change: &str) {
        match change {
            "working" => self.data["terminals"]["t12"]["status"]["state"] = json!("working"),
            "input" => self.text = self.text.replace("❯ ", "❯ 이어서 할 일"),
            "focus" => self.data["status"]["focused_pane"] = json!("p12"),
            "last pane" => {
                self.data["spaces"][1]["tabs"][0]["terminals"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            "snapshot failure" => self.snapshot_error = true,
            "screen timeout" => self.screen_error = Some("t-test"),
            "view space" => self.data["status"]["space"] = json!("temporary"),
            "new output" => {
                self.text = "Changed at the last moment\n› Ask Codex to do anything\n".into()
            }
            "elsewhere" => {
                self.data["status"]["tab"] = json!("tab-elsewhere");
                self.data["status"]["focused_pane"] = json!("pane-elsewhere");
            }
            other => panic!("unknown original scenario {other}"),
        }
    }
}
impl Adapter for Fake {
    fn empty(&mut self, t: &Value, _: &Value) -> bool {
        self.empty_turn_zero && t["turn"] == 0
    }
    fn snapshot(&mut self) -> Result<Value> {
        self.snapshots += 1;
        if self.snapshots == 2 {
            if let Some(change) = self.second_snapshot {
                self.change(change);
            }
        }
        if self.snapshot_error || (self.closed_pane && self.unreadable_after_close) {
            return o::err("herdr-app status failed");
        }
        Ok(self.data.clone())
    }
    fn screen(&mut self, address: &str) -> Result<String> {
        if self.panic_after_close && self.closed_pane && address == "t3" {
            panic!("focus read failed");
        }
        if self.screen_error == Some(address) {
            return o::err("herdr-core get timed out");
        }
        self.reads.push(address.into());
        Ok(self
            .texts
            .get(address)
            .cloned()
            .unwrap_or_else(|| self.text.clone()))
    }
    fn styled_screen(&mut self, address: &str) -> Result<String> {
        self.calls.push(json!(["styled", address]));
        Ok(self.raw.clone())
    }
    fn terminal(&mut self, _: &str) -> Result<Value> {
        let name = if self.exits { "zsh" } else { "claude" };
        Ok(json!({"foreground":{"argv":[name],"name":name}}))
    }
    fn request_report(&mut self, address: &str, text: &str) -> Result<()> {
        self.calls.push(json!(["ask", address, text]));
        Ok(())
    }
    fn keys(&mut self, address: &str, keys: &[String]) -> Result<()> {
        self.calls.push(json!(["keys", address, keys]));
        Ok(())
    }
    fn type_line(&mut self, address: &str, text: &str) -> Result<()> {
        self.calls.push(json!(["type", address, text]));
        Ok(())
    }
    fn label(&mut self, address: &str, labels: &Value) -> Result<()> {
        self.calls.push(json!(["label", address, labels]));
        Ok(())
    }
    fn close_pane(&mut self, pane: &str) -> Result<()> {
        self.calls.push(json!(["pane.close", pane]));
        if self.close_error {
            return o::err("herdr-app do pane.close: exit 1");
        }
        if self.close_stays {
            return Ok(());
        }
        let mut gone = vec![];
        for space in self.data["spaces"].as_array_mut().unwrap() {
            for tab in space["tabs"].as_array_mut().unwrap() {
                tab["terminals"].as_array_mut().unwrap().retain(|entry| {
                    if sleep::pane_id(entry) == pane {
                        gone.push(o::s(&entry["terminal"]).to_owned());
                        false
                    } else {
                        true
                    }
                });
            }
        }
        for address in gone {
            self.data["terminals"]
                .as_object_mut()
                .unwrap()
                .remove(&address);
        }
        self.closed_pane = true;
        Ok(())
    }
    fn close_space(&mut self, id: &str, _: &Value) -> Result<()> {
        assert!(
            self.report_dir.read_dir()?.any(|entry| entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "md")),
            "original contract: report precedes close"
        );
        self.calls.push(json!(["space.close", id]));
        if self.space_close_error {
            return o::err("close failed");
        }
        if !self.space_close_stays {
            self.data["spaces"]
                .as_array_mut()
                .unwrap()
                .retain(|space| space["id"] != id);
        }
        if self.focus_after_close {
            self.data["status"]["focused_pane"] = json!("unexpected-pane");
        }
        Ok(())
    }
    fn mapping(&mut self, _: &Value, _: &Value) -> Result<Value> {
        Ok(self.mapping.clone())
    }
    fn session_mapping(&mut self, t: &Value, _: &Value) -> Result<Value> {
        if t.get("status").is_none() {
            if let Some(mapping) = &self.wake_mapping {
                return Ok(mapping.clone());
            }
        }
        if self.child_from_terminal || !self.child_session.is_null() {
            return o::err("cannot resume: Claude runs as an inherited child session (no session file or transcript)");
        }
        Ok(self.mapping.clone())
    }
    fn child(&mut self, terminal: &Value) -> Result<Value> {
        if self.child_from_terminal {
            return sessions::child_session_with_inherited(terminal, &mut |_| true);
        }
        Ok(self.child_session.clone())
    }
    fn backend(&mut self, _: &Value, _: &Value, _: bool) -> (bool, String, String) {
        self.jobs.clone()
    }
    fn git(&mut self, _: &str) -> Value {
        json!({"branch":"main","head":"abc1234","uncommitted":1,"worktrees":1})
    }
    fn park(&mut self, _: &Value, item: &Value, event: &str, _: bool, _: &str) -> Result<Value> {
        self.calls.push(json!(["park", event, item["address"]]));
        self.parks_with_sessions
            .push((event.into(), o::s(&item["session_id"]).into()));
        if event == "close_requested" {
            if let Some(address) = self.type_during_park.take() {
                self.texts.entry(address).or_default().push('a');
            }
            if let Some(change) = self.park_change.take() {
                self.change(change);
            }
        }
        if !self.park_ok {
            return o::err("harness refused: denylist");
        }
        if event == "closed" && self.fail_closed > 0 {
            self.fail_closed -= 1;
            return o::err("storage unavailable");
        }
        Ok(if self.space_job {
            json!(format!("record-{}", self.events("park").len()))
        } else {
            json!("REC1")
        })
    }
    fn close_status(&mut self, _: &Value, item: &Value, since: &str) -> Result<Value> {
        self.calls.push(json!(["status", item["address"], since]));
        if let Some(at) = self.report_at {
            let at = o::iso(at);
            if at.as_str() >= since {
                return Ok(json!({"report_id":"R","task_id":"T","at":at}));
            }
            return o::err("no close report yet");
        }
        if self.reported {
            Ok(json!({"report_id":"REP1","task_id":"TASK1"}))
        } else {
            o::err("no close report yet")
        }
    }
    fn close_gate(&mut self, _: &Value, item: &Value) -> Result<Value> {
        self.calls.push(json!(["gate", item["address"]]));
        if self.gate_unavailable {
            return o::err("close gate unavailable");
        }
        if !self.gate_blockers.is_empty() {
            return o::err(self.gate_blockers.join(", "));
        }
        Ok(json!({"ok":true}))
    }
    fn has_close_gate(&self) -> bool {
        !self.gate_unavailable
    }
    fn archive(&mut self, _: &Value, value: &Value) -> Result<Value> {
        assert!(self.closed_spaces().is_empty());
        self.calls.push(json!(["archive"]));
        if self.archive_error {
            return o::err("harness refused: x");
        }
        self.archives.push(value.clone());
        Ok(json!("ARCH.json"))
    }
    fn machine(&mut self) -> Result<String> {
        Ok("m".repeat(32))
    }
    fn wait(&mut self, _: f64) {}
}
#[path = "support/observer_latest_e383.rs"]
mod latest_e383;
struct SleepFixture {
    _temp: tempfile::TempDir,
    live: Fake,
    config: Value,
    state: Value,
    paths: Value,
}
impl SleepFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let live = Fake::new("sleep", temp.path());
        let paths = json!({"notes":temp.path().join("notes"),"tickets":temp.path().join("tickets"),"stub":temp.path().join("stub")});
        let config = json!({"idle_seconds":1200,"exclude_addresses":["t3"],"user_approved_apply":true,"reviewed_observer_sha256":"code","close_report":{"timeout_seconds":900,"retry_seconds":3600,"settle_seconds":120}});
        let mut value = Self {
            _temp: temp,
            live,
            config,
            state: json!({}),
            paths,
        };
        value.reset_state(1200.);
        value
    }
    fn reset_state(&mut self, quiet: f64) {
        let first = sleep::cycle(
            &mut self.live,
            &self.config,
            &mut json!({"observer_sha256":"code"}),
            NOW - quiet,
            false,
            &self.paths,
        )
        .unwrap();
        self.state = json!({"observer_sha256":"code","last_at":NOW-300.,"trial":{"started_at":NOW-600.,"samples":1,"error_count":0},"sessions":{}});
        for item in o::arr(&first["results"]) {
            // Exact SleepTests.state predicate: cycle's observation-window
            // message is informational while constructing the warm fixture.
            if item["fingerprint"].is_string()
                && sleep::blockers(&item)
                    .iter()
                    .all(|reason| reason.starts_with("unchanged"))
            {
                self.state["sessions"][o::s(&item["address"])] =
                    json!({"since":NOW-quiet,"fingerprint":item["fingerprint"]});
            }
        }
        self.live.quiet();
    }
    fn run(&mut self) -> Result<Value> {
        sleep::cycle(
            &mut self.live,
            &self.config,
            &mut self.state,
            NOW,
            true,
            &self.paths,
        )
    }
    fn retry(&mut self) -> Result<Value> {
        self.state["last_at"] = json!(NOW - 300.);
        self.live.quiet();
        self.run()
    }
}
fn item<'a>(result: &'a Value, key: &str, address: &str) -> &'a Value {
    result["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i[key] == address)
        .unwrap()
}
fn reasons(value: &Value) -> String {
    o::arr(&value["reasons"])
        .iter()
        .map(|v| o::s(v))
        .collect::<Vec<_>>()
        .join("; ")
}
struct SpaceFixture {
    _temp: tempfile::TempDir,
    live: Fake,
    config: Value,
    state: Value,
    reports: PathBuf,
}
impl SpaceFixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let reports = temp.path().join("reports");
        let live = Fake::new("space", &reports);
        let config = json!({"idle_seconds":600,"trial_seconds":1800,"max_sample_gap_seconds":660,"fixed_names":["Share","Project A","Project B"],"fixed_spaces":[],"reviewed_dry_run_at":NOW,"reviewed_observer_sha256":"test","notify_terminal":"review-session","space_close_enabled":true,"close_report":{"enabled":false}});
        let mut value = Self {
            _temp: temp,
            live,
            config,
            state: json!({}),
            reports,
        };
        value.reset_state(600.);
        value
    }
    fn reset_state(&mut self, quiet: f64) {
        let space = self.live.data["spaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == "temporary")
            .unwrap()
            .clone();
        let snapshot = self.live.data.clone();
        let inspected = spaces::inspect(&space, &snapshot, &mut self.live, &self.config).unwrap();
        self.state = json!({"observer_sha256":"test","last_at":NOW-300.,"trial":{"started_at":NOW-1800.,"samples":6,"error_count":0},"spaces":{"temporary":{"since":NOW-quiet,"fingerprint":inspected["fingerprint"]}}});
        self.live.quiet();
    }
    fn run(&mut self, apply: bool) -> Result<Value> {
        spaces::cycle(
            &mut self.live,
            &self.config,
            &mut self.state,
            NOW,
            apply,
            Some("temporary"),
            &self.reports,
        )
    }
}

// test_session_sleep.py::PaneCloseTests (original assertions, isolated adapters).
#[test]
fn a_finished_session_in_a_space_with_another_pane_is_closed() {
    let mut f = SleepFixture::new();
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "closed");
    assert_eq!(f.live.parks(), ["close_requested", "closed"]);
    assert_eq!(
        f.live.events("pane.close"),
        vec![json!(["pane.close", "p12"])]
    );
    for event in ["keys", "type", "label"] {
        assert!(f.live.events(event).is_empty());
    }
    assert!(!sleep::pane_of(&f.live.data).contains_key("t12"));
    assert!(sleep::pane_of(&f.live.data).contains_key("t3"));
    assert!(Path::new(o::s(&i["note"])).exists());
}
#[test]
fn the_last_pane_of_its_space_sleeps_instead() {
    let mut f = SleepFixture::new();
    f.live.change("last pane");
    f.reset_state(1200.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "slept");
    assert!(f.live.events("pane.close").is_empty());
    assert!(reasons(i).contains("last pane in its space: slept instead of closed"));
}
#[test]
fn two_finished_sessions_in_a_two_pane_space_keep_one_pane() {
    let mut f = SleepFixture::new();
    f.config["exclude_addresses"] = json!([]);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "closed");
    assert_eq!(item(&out, "address", "t3")["action"], "slept");
    assert_eq!(
        f.live.events("pane.close"),
        vec![json!(["pane.close", "p12"])]
    );
    assert!(sleep::pane_of(&f.live.data).contains_key("t3"));
}
#[test]
fn no_harness_record_no_close() {
    let mut f = SleepFixture::new();
    f.live.park_ok = false;
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "keep");
    assert!(reasons(i).contains("harness record failed"));
    assert!(f.live.events("pane.close").is_empty());
    assert!(f.live.events("keys").is_empty());
}
#[test]
fn a_pane_still_there_after_close_stops_everything() {
    let mut f = SleepFixture::new();
    f.live.close_stays = true;
    assert!(f
        .run()
        .unwrap_err()
        .to_string()
        .contains("still present after pane.close"));
    assert_eq!(f.live.parks(), ["close_requested", "close_aborted"]);
}
#[test]
fn work_input_or_focus_that_starts_while_parking_keeps_the_pane() {
    for change in ["working", "input", "focus", "last pane"] {
        let mut f = SleepFixture::new();
        f.live.park_change = Some(change);
        let out = f.run().unwrap();
        let i = item(&out, "address", "t12");
        assert_eq!(i["action"], "keep", "{change}: {i}");
        assert!(reasons(i).contains("recheck before close"), "{change}: {i}");
        assert!(f.live.events("pane.close").is_empty());
        assert_eq!(f.live.parks(), ["close_requested", "close_aborted"]);
        assert!(sleep::pane_of(&f.live.data).contains_key("t12"));
    }
}
#[test]
fn a_failed_closed_record_is_not_reported_as_closed_and_is_retried() {
    let mut f = SleepFixture::new();
    f.config["exclude_addresses"] = json!([]);
    f.live.data["spaces"][1]["tabs"][0]["terminals"]
        .as_array_mut()
        .unwrap()
        .push(json!({"terminal":"t7","pane":"p7","sub_agents":[]}));
    f.live.data["terminals"]["t7"] = f.live.data["terminals"]["t3"].clone();
    f.live.data["terminals"]["t7"]["address"] = json!("t7");
    f.reset_state(1200.);
    f.live.fail_closed = 2;
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "closed_unrecorded");
    assert!(reasons(i).contains("closed record failed"));
    assert_eq!(
        f.live.events("pane.close"),
        vec![json!(["pane.close", "p12"])]
    );
    assert_eq!(f.state["unrecorded_closes"][0]["address"], "t12");
    f.retry().unwrap();
    assert_eq!(f.live.events("park")[0], json!(["park", "closed", "t12"]));
    assert_eq!(f.state["unrecorded_closes"], json!([]));
}
#[test]
fn while_a_closed_record_is_missing_nothing_else_acts() {
    let mut f = SleepFixture::new();
    f.state["unrecorded_closes"] =
        json!([{"address":"t99","app":"claude-code","session_id":SID,"space_id":"fixed"}]);
    f.live.park_ok = false;
    let out = f.run().unwrap();
    for event in ["pane.close", "keys", "ask"] {
        assert!(f.live.events(event).is_empty());
    }
    assert!(reasons(item(&out, "address", "t12")).contains("without a harness record"));
    assert_eq!(f.state["unrecorded_closes"].as_array().unwrap().len(), 1);
}
// Original injects RuntimeError into the pure spaces.focus after a close. Rust
// focus cannot return an error; inject an unexpected adapter panic at the next
// pane instead. This checks durable pending state across unwinding, and does
// not equate a normally handled Result::Err with a panic.
#[test]
fn an_unrecorded_close_survives_an_exception_later_in_the_cycle() {
    let mut f = SleepFixture::new();
    f.config["exclude_addresses"] = json!([]);
    f.reset_state(1200.);
    f.live.fail_closed = 2;
    f.live.panic_after_close = true;
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.run()));
    assert!(failure.is_err());
    assert!(!sleep::pane_of(&f.live.data).contains_key("t12"));
    assert_eq!(f.state["unrecorded_closes"][0]["address"], "t12");
    assert_eq!(f.state["unrecorded_closes"][0]["pending"], "unrecorded");
    f.live.panic_after_close = false;
    f.retry().unwrap();
    assert!(f
        .live
        .events("park")
        .contains(&json!(["park", "closed", "t12"])));
    assert_eq!(f.state["unrecorded_closes"], json!([]));
}
#[test]
fn a_layout_unreadable_right_after_pane_close_is_not_recorded_as_aborted() {
    let mut f = SleepFixture::new();
    f.live.unreadable_after_close = true;
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "close_unconfirmed");
    assert_eq!(f.live.parks(), ["close_requested"]);
    assert_eq!(f.state["unrecorded_closes"][0]["pending"], "unconfirmed");
    f.live.unreadable_after_close = false;
    f.retry().unwrap();
    assert_eq!(f.live.events("park")[0], json!(["park", "closed", "t12"]));
    assert_eq!(f.state["unrecorded_closes"], json!([]));
}
#[test]
fn an_unconfirmed_close_whose_pane_is_still_there_is_settled_as_aborted() {
    let mut f = SleepFixture::new();
    f.state["unrecorded_closes"] = json!([{"address":"t12","app":"claude-code","session_id":SID,"space_id":"fixed","_pane_id":"p12","pending":"unconfirmed"}]);
    f.run().unwrap();
    assert_eq!(
        f.live.events("park")[0],
        json!(["park", "close_aborted", "t12"])
    );
    assert_eq!(f.state["unrecorded_closes"], json!([]));
}
#[test]
fn an_unreadable_app_at_the_start_skips_the_cycle() {
    let mut f = SleepFixture::new();
    f.live.snapshot_error = true;
    assert!(f.run().unwrap_err().to_string().starts_with("SKIP:"));
    for event in ["pane.close", "keys", "ask", "park"] {
        assert!(f.live.events(event).is_empty());
    }
}
#[test]
fn a_recheck_lookup_failure_before_close_settles_and_keeps() {
    let mut f = SleepFixture::new();
    f.live.park_change = Some("snapshot failure");
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "keep");
    assert!(f.live.events("pane.close").is_empty());
    assert_eq!(f.live.parks(), ["close_requested", "close_aborted"]);
}
#[test]
fn one_pane_lookup_timing_out_keeps_only_that_pane() {
    let mut f = SleepFixture::new();
    // Original patches sleep.inspect itself, before excluded-address checks.
    let mut inspect = |address: &str,
                       space: &Value,
                       snap: &Value,
                       a: &mut dyn Adapter,
                       c: &Value,
                       tab: &Value| {
        if address == "t3" {
            o::err("herdr-core get t3 timed out")
        } else {
            sleep::inspect(address, space, snap, a, c, tab)
        }
    };
    let out = sleep::cycle_with_inspector(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW,
        true,
        &f.paths,
        &mut inspect,
    )
    .unwrap();
    let i = item(&out, "address", "t3");
    assert_eq!(i["action"], "keep");
    assert!(o::s(&i["reasons"][0]).starts_with("lookup failed:"));
    assert_eq!(item(&out, "address", "t12")["action"], "closed");
}
#[test]
fn a_failing_pane_close_is_settled_with_close_aborted_and_stops() {
    let mut f = SleepFixture::new();
    f.live.close_error = true;
    let error = f.run().unwrap_err().to_string();
    assert!(
        error.contains("still present after pane.close (herdr-app do pane.close: exit 1)"),
        "{error}"
    );
    assert_eq!(f.live.parks(), ["close_requested", "close_aborted"]);
    assert!(sleep::pane_of(&f.live.data).contains_key("t12"));
}
#[test]
fn a_long_gap_does_not_clear_an_earlier_error() {
    let mut f = SleepFixture::new();
    f.state["trial"] = json!({"started_at":NOW-3000.,"samples":5,"error_count":1,"healthy":0});
    let mut readiness = vec![];
    for index in 0..4 {
        f.state["last_at"] = json!(NOW - if index == 0 { 900. } else { 300. });
        f.live.quiet();
        let out = f.run().unwrap();
        readiness.push(out["apply_ready"].clone());
        sessions::settle_trial(&mut f.state, &f.config, true);
        if index < 3 {
            assert!(f.live.events("pane.close").is_empty());
            assert!(f.live.events("keys").is_empty());
        }
    }
    assert_eq!(
        readiness,
        vec![json!(false), json!(false), json!(false), json!(true)]
    );
    assert_eq!(f.state["trial"]["error_count"], 0);
}
#[test]
fn main_skips_without_counting_an_error_and_errors_clear_after_healthy_cycles() {
    let mut f = SleepFixture::new();
    let state_path = f._temp.path().join("s.json");
    let config_path = f._temp.path().join("c.json");
    let log = f._temp.path().join("l.jsonl");
    o::save(&config_path, &f.config).unwrap();
    o::save(&state_path,&json!({"observer_sha256":env!("HERDR_SLEEP_SOURCE_SHA256"),"trial":{"started_at":NOW,"samples":3,"error_count":1,"healthy":0}})).unwrap();
    let config: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
    let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    f.live.snapshot_error = true;
    sleep::run_with_adapter_with_clock(
        &mut f.live,
        &config,
        &mut state,
        false,
        &f.paths,
        &state_path,
        &log,
        &mut || NOW,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&state_path).unwrap()).unwrap()["trial"]
            ["error_count"],
        1
    );
    let last: Value =
        serde_json::from_str(fs::read_to_string(&log).unwrap().lines().last().unwrap()).unwrap();
    assert!(last.get("skipped").is_some());
    f.live.snapshot_error = false;
    for _ in 0..3 {
        let mut state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
        sleep::run_with_adapter_with_clock(
            &mut f.live,
            &config,
            &mut state,
            false,
            &f.paths,
            &state_path,
            &log,
            &mut || NOW,
        )
        .unwrap();
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&state_path).unwrap()).unwrap()["trial"]
            ["error_count"],
        0
    );
}
#[test]
fn the_last_pane_of_a_hidden_tab_is_not_closed_even_if_the_space_keeps_others() {
    let mut f = SleepFixture::new();
    let other = f.live.data["spaces"][1]["tabs"][0]["terminals"]
        .as_array_mut()
        .unwrap()
        .pop()
        .unwrap();
    f.live.data["spaces"][1]["tabs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"tab-other","terminals":[other]}));
    f.reset_state(1200.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "slept");
    assert!(reasons(i).contains("last pane in its tab: slept instead of closed"));
    assert!(f.live.events("pane.close").is_empty());
}
#[test]
fn switched_off_it_sleeps() {
    let mut f = SleepFixture::new();
    f.config["close_finished_panes"] = json!(false);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "slept");
    assert!(f.live.events("pane.close").is_empty());
}
#[test]
fn close_reports_off_never_close() {
    let mut f = SleepFixture::new();
    f.config["close_report"] = json!({"enabled":false});
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "slept");
    assert!(f.live.events("pane.close").is_empty());
}
#[test]
fn live_close_pane_closes_by_id_only() {
    assert_eq!(
        o::pane_close_argv("herdr-app", "p12").unwrap(),
        ["herdr-app", "do", "pane.close", r#"{"pane": "p12"}"#]
    );
    let mut live = o::Live {
        app: "must-not-run".into(),
        core: "must-not-run".into(),
    };
    assert!(live
        .close_pane("")
        .unwrap_err()
        .to_string()
        .contains("no pane id"));
}
#[test]
fn dry_run_types_nothing_and_says_what_it_would_do() {
    let mut f = SleepFixture::new();
    let out = sleep::cycle(&mut f.live, &f.config, &mut f.state, NOW, false, &f.paths).unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "would_sleep");
    assert_eq!(i["close_if_finished"], true);
    assert!(f.live.calls.is_empty());
    f.reset_state(1200.);
    f.state["reports"] = json!({"t12":{"session_id":SID,"requested_at":NOW-600.,"since":"x","turn":3,"report":{"report_id":"REP1"}}});
    let out = sleep::cycle(&mut f.live, &f.config, &mut f.state, NOW, false, &f.paths).unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "would_close");
    for event in ["ask", "keys", "type", "pane.close"] {
        assert!(f.live.events(event).is_empty());
    }
}
fn make_non_shell(f: &mut SleepFixture) {
    f.live.data["terminals"]["t12"]["argv"] = json!(["claude", "--resume", SID]);
    f.live.data["processes"]["200"]["name"] = json!("claude");
}
#[test]
fn a_finished_agent_that_is_the_terminal_program_is_closed() {
    let mut f = SleepFixture::new();
    make_non_shell(&mut f);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "closed");
    assert!(f.live.events("keys").is_empty());
}
#[test]
fn a_non_shell_last_pane_is_kept_after_its_report() {
    let mut f = SleepFixture::new();
    f.live.change("last pane");
    make_non_shell(&mut f);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "reported");
    assert!(reasons(i).contains("last pane in its space"));
    for event in ["keys", "pane.close", "label"] {
        assert!(f.live.events(event).is_empty());
    }
}
#[test]
fn a_kept_session_is_asked_once_for_its_report() {
    let mut f = SleepFixture::new();
    f.live.reported = false;
    f.live.change("last pane");
    make_non_shell(&mut f);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "report_requested");
    assert_eq!(f.live.events("ask").len(), 1);
    sleep::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW + 60.,
        true,
        &f.paths,
    )
    .unwrap();
    assert_eq!(f.live.events("ask").len(), 1);
    f.state["reports"]["t12"]["requested_at"] = json!(NOW - 5000.);
    f.state["reports"]["t12"]["failed_at"] = json!(NOW - 4000.);
    f.state["last_at"] = json!(NOW + 60.);
    sleep::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW + 120.,
        true,
        &f.paths,
    )
    .unwrap();
    assert_eq!(f.live.events("ask").len(), 1);
    assert!(f.live.events("keys").is_empty());
    assert!(f.live.events("pane.close").is_empty());
}
#[test]
fn collect_after_seconds_asks_before_idle_seconds_without_closing() {
    let mut f = SleepFixture::new();
    f.config["close_report"]["collect_after_seconds"] = json!(300);
    f.live.data["terminals"]["t12"]["status_ms"] = json!((NOW - 600.) * 1000.);
    f.reset_state(600.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "reported");
    assert!(reasons(i).contains("not idle long enough"));
    for event in ["pane.close", "keys", "park"] {
        assert!(f.live.events(event).is_empty());
    }
}
#[test]
fn dry_run_collect_types_nothing() {
    let mut f = SleepFixture::new();
    f.live.change("last pane");
    make_non_shell(&mut f);
    f.reset_state(1200.);
    let out = sleep::cycle(&mut f.live, &f.config, &mut f.state, NOW, false, &f.paths).unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "would_collect_report");
    assert_eq!(i["close_if_finished"], false);
    assert!(f.live.calls.is_empty());
}
fn add_shown_pane(f: &mut SleepFixture, tab: usize) {
    let mut terminal = f.live.data["terminals"]["t3"].clone();
    terminal["address"] = json!("t5");
    terminal["pid"] = json!(500);
    terminal["foreground"]["pid"] = json!(501);
    f.live.data["terminals"]["t5"] = terminal;
    f.live.data["processes"]["500"] = json!({"pid":500,"parent":1,"name":"zsh","args":"zsh"});
    f.live.data["processes"]["501"] =
        json!({"pid":501,"parent":500,"name":"claude","args":"claude"});
    f.live.data["spaces"][0]["tabs"][tab]["terminals"]
        .as_array_mut()
        .unwrap()
        .push(json!({"terminal":"t5","pane":"p5","sub_agents":[]}));
}
#[test]
fn a_finished_session_in_the_shown_tab_is_closed_but_never_the_focused_pane() {
    let mut f = SleepFixture::new();
    add_shown_pane(&mut f, 0);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t5")["action"], "closed");
    assert!(f
        .live
        .events("pane.close")
        .contains(&json!(["pane.close", "p5"])));
    assert!(reasons(item(&out, "address", "t1")).contains("focused pane"));
    assert!(!f
        .live
        .calls
        .iter()
        .any(|call| call[1] == "t1" || call.as_array().unwrap().contains(&json!("p-focus"))));
}
#[test]
fn the_shown_tab_still_blocks_sleep_and_its_last_pane_is_not_closed() {
    let mut f = SleepFixture::new();
    f.live.data["status"]["focused_pane"] = json!("p-float");
    f.live.data["spaces"][0]["tabs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"tab-2","terminals":[]}));
    add_shown_pane(&mut f, 1);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t1");
    assert_eq!(i["action"], "reported");
    assert!(reasons(i).contains("last pane in its tab"));
    assert!(!f
        .live
        .events("pane.close")
        .contains(&json!(["pane.close", "p-focus"])));
    assert!(!f.live.events("keys").iter().any(|call| call[1] == "t1"));
}
#[test]
fn typed_input_or_a_float_blocks_closing_and_asking() {
    for change in ["input", "float"] {
        let mut f = SleepFixture::new();
        add_shown_pane(&mut f, 0);
        f.reset_state(1200.);
        if change == "input" {
            f.live.change("input");
        } else {
            f.live.data["status"]["floats"] = json!({"f":{"terminal":"t5"}});
        }
        let out = f.run().unwrap();
        assert_eq!(item(&out, "address", "t5")["action"], "keep");
        assert!(!f.live.events("ask").iter().any(|call| call[1] == "t5"));
        assert!(!f
            .live
            .events("pane.close")
            .contains(&json!(["pane.close", "p5"])));
    }
}

// test_session_sleep.py::ReportGateTimingTests + AlreadyReportedTests.
fn gate_fixture(at: f64) -> (Fake, tempfile::TempDir, Value, Value) {
    let temp = tempfile::tempdir().unwrap();
    let mut fake = Fake::new("sleep", temp.path());
    fake.report_at = Some(at);
    (
        fake,
        temp,
        json!({"address":"t12","session_id":SID,"turn":3}),
        json!({"close_report":{"timeout_seconds":900,"retry_seconds":3600}}),
    )
}
#[test]
fn a_report_written_before_the_request_is_not_an_answer() {
    let now = 1_793_000_000.4;
    let (mut a, _temp, i, c) = gate_fixture(now - 3.);
    let mut entries = json!({});
    assert_eq!(
        sessions::report_gate(&mut entries, &i, &mut a, &c, now)
            .unwrap()
            .0,
        "requested"
    );
    assert_eq!(
        sessions::report_gate(&mut entries, &i, &mut a, &c, now + 60.)
            .unwrap()
            .0,
        "waiting"
    );
    a.report_at = Some(now + 30.);
    assert_eq!(
        sessions::report_gate(&mut entries, &i, &mut a, &c, now + 90.)
            .unwrap()
            .0,
        "ready"
    );
}
#[test]
fn a_report_after_the_limit_is_not_accepted() {
    let now = 1_793_000_000.;
    let (mut a, _temp, i, c) = gate_fixture(now + 901.);
    let mut entries = json!({});
    sessions::report_gate(&mut entries, &i, &mut a, &c, now).unwrap();
    let (decision, detail) =
        sessions::report_gate(&mut entries, &i, &mut a, &c, now + 905.).unwrap();
    assert_eq!(decision, "failed");
    assert!(o::s(&detail).contains("fail-closed"));
}
#[test]
fn a_report_written_in_time_counts_even_when_the_observer_looks_late() {
    let now = 1_793_000_000.;
    let (mut a, _temp, i, c) = gate_fixture(now + 50.);
    let mut entries = json!({});
    sessions::report_gate(&mut entries, &i, &mut a, &c, now).unwrap();
    assert_eq!(
        sessions::report_gate(&mut entries, &i, &mut a, &c, now + 1200.)
            .unwrap()
            .0,
        "ready"
    );
}
#[test]
fn a_report_accepted_in_time_stays_ready_on_later_cycles() {
    let now = 1_793_000_000.;
    let (mut a, _temp, i, c) = gate_fixture(now + 30.);
    let mut entries = json!({});
    sessions::report_gate(&mut entries, &i, &mut a, &c, now).unwrap();
    for delta in [60., 1000.] {
        assert_eq!(
            sessions::report_gate(&mut entries, &i, &mut a, &c, now + delta)
                .unwrap()
                .0,
            "ready"
        );
    }
}
fn reported_item(idle: f64, turn: i64) -> Value {
    json!({"address":"t38","session_id":SID,"turn":turn,"status_ms":(idle*1000.)as i64})
}
#[test]
fn a_report_from_its_last_work_is_ready_without_asking() {
    let now = 1_793_000_000.;
    let (mut a, _temp, _, c) = gate_fixture(now - 9. * 3600.);
    assert_eq!(
        sessions::report_gate(
            &mut json!({}),
            &reported_item(now - 9. * 3600. + 5., 3),
            &mut a,
            &c,
            now
        )
        .unwrap()
        .0,
        "ready"
    );
    assert!(a.events("ask").is_empty());
}
#[test]
fn an_old_report_before_later_work_does_not_count() {
    let now = 1_793_000_000.;
    let (mut a, _temp, _, c) = gate_fixture(now - 3. * 3600.);
    assert_eq!(
        sessions::report_gate(
            &mut json!({}),
            &reported_item(now - 600., 3),
            &mut a,
            &c,
            now
        )
        .unwrap()
        .0,
        "requested"
    );
    assert_eq!(a.events("ask")[0][1], "t38");
}
#[test]
fn a_session_that_answered_an_earlier_request_points_to_its_older_report() {
    let now = 1_793_000_000.;
    let (mut a, _temp, _, c) = gate_fixture(now - 3600.);
    let mut i = reported_item(now - 1800., 3);
    i["answered_report"] = json!(true);
    assert_eq!(
        sessions::report_gate(&mut json!({}), &i, &mut a, &c, now)
            .unwrap()
            .0,
        "ready"
    );
    assert!(a.events("ask").is_empty());
}
#[test]
fn answering_a_pending_request_with_an_earlier_report_is_ready() {
    let now = 1_793_000_000.;
    let (mut a, _temp, _, c) = gate_fixture(now - 3600.);
    let mut i = reported_item(now - 60., 3);
    let mut entries =
        json!({"t38":{"session_id":SID,"requested_at":now-300.,"since":o::iso(now-300.),"turn":3}});
    assert_eq!(
        sessions::report_gate(&mut entries, &i, &mut a, &c, now)
            .unwrap()
            .0,
        "waiting"
    );
    i["answered_report"] = json!(true);
    assert_eq!(
        sessions::report_gate(&mut entries, &i, &mut a, &c, now)
            .unwrap()
            .0,
        "ready"
    );
}
#[test]
fn work_after_the_request_still_asks_again() {
    let now = 1_793_000_000.;
    let (mut a, _temp, _, c) = gate_fixture(now + 10.);
    let mut entries = json!({});
    sessions::report_gate(&mut entries, &reported_item(now - 60., 3), &mut a, &c, now).unwrap();
    a.calls.clear();
    assert_eq!(
        sessions::report_gate(
            &mut entries,
            &reported_item(now + 15., 6),
            &mut a,
            &c,
            now + 60.
        )
        .unwrap()
        .0,
        "requested"
    );
    assert_eq!(a.events("ask")[0][1], "t38");
}
#[test]
fn the_memory_window_answer_is_not_a_user_decision() {
    let screen="❯ [세션 정리 보고 요청] 관찰기가 이 세션을 곧 정리(절전)합니다. 새 작업은 시작하지 말고 아래만 하세요.\n  다른 세션에 보고하지 말고, 보고 id만 한 줄로 답하고 끝내세요. 승인은 사람이 기억함에서 합니다.\n⏺ 01ARZ3NDEKTSV4RRFFQ69G5FAV (이미 제출함, 기억함에서 승인 대기 중)\n✻ Cogitated for 4s · done 오전 10:21\n────────\n❯ \n────────\n  ⏵⏵ auto mode on\n";
    assert!(!spaces::decision_pending(screen));
    assert!(spaces::decision_pending(
        &(screen.to_owned() + "사용자 승인 대기: 배포 범위\n")
    ));
    assert!(spaces::decision_pending(
        "Do you want to proceed?\n❯ 1. Yes\n"
    ));
}

// test_close_finished_spaces.py::CleanupPolicyTests / ArchiveBeforeCloseTests.
#[test]
fn by_default_no_space_is_ever_closed() {
    let mut f = SpaceFixture::new();
    f.config
        .as_object_mut()
        .unwrap()
        .remove("space_close_enabled");
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(
        reasons(i).contains("space close held: workspaces are kept until the person enables it")
    );
    assert!(f.live.closed_spaces().is_empty());
    assert!(!f.live.parks().contains(&"close_requested".to_owned()));
}
#[test]
fn the_live_close_refuses_without_the_switch() {
    let mut live = o::Live {
        app: "must-not-run".into(),
        core: "must-not-run".into(),
    };
    assert!(live
        .close_space("sp-any", &json!({}))
        .unwrap_err()
        .to_string()
        .contains("workspaces are kept"));
}
#[test]
fn idle_boundary_is_600_seconds_and_record_precedes_close() {
    let mut f = SpaceFixture::new();
    f.reset_state(599.);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "keep"
    );
    assert!(!f.reports.exists());
    f.reset_state(600.);
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "closed");
    assert_eq!(f.live.closed_spaces(), ["temporary"]);
    assert!(Path::new(o::s(&i["record"])).exists());
}
#[test]
fn dry_run_never_records_closes_or_notifies() {
    let mut f = SpaceFixture::new();
    let out = f.run(false).unwrap();
    assert_eq!(item(&out, "id", "temporary")["action"], "would_close");
    assert!(f.live.closed_spaces().is_empty());
    assert!(f.live.events("ask").is_empty());
    assert!(!f.reports.exists());
}
#[test]
fn requires_both_30_minutes_and_seven_samples() {
    for (elapsed, samples) in [(1799., 6), (1800., 5)] {
        let mut f = SpaceFixture::new();
        f.state["trial"]["started_at"] = json!(NOW - elapsed);
        f.state["trial"]["samples"] = json!(samples);
        assert_eq!(
            item(&f.run(true).unwrap(), "id", "temporary")["action"],
            "keep"
        );
        assert!(f.live.closed_spaces().is_empty());
    }
    let mut f = SpaceFixture::new();
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "closed"
    );
}
#[test]
fn seven_real_dry_run_samples_reach_trial_readiness_only_at_30_minutes() {
    let mut f = SpaceFixture::new();
    f.state = json!({"observer_sha256":"test"});
    for index in 0..7 {
        let out = spaces::cycle(
            &mut f.live,
            &f.config,
            &mut f.state,
            NOW + index as f64 * 300.,
            false,
            Some("temporary"),
            &f.reports,
        )
        .unwrap();
        assert_eq!(out["trial_ready"], index == 6);
        assert_eq!(out["trial"]["samples"], index + 1);
    }
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn review_gate_is_required() {
    let mut f = SpaceFixture::new();
    f.config
        .as_object_mut()
        .unwrap()
        .remove("reviewed_dry_run_at");
    assert_space_blocked(&mut f, "review");
}
#[test]
fn review_of_different_observer_is_rejected() {
    let mut f = SpaceFixture::new();
    f.config["reviewed_observer_sha256"] = json!("different-observer");
    assert_space_blocked(&mut f, "review");
}
#[test]
fn review_before_30_minute_trial_is_rejected() {
    let mut f = SpaceFixture::new();
    f.config["reviewed_dry_run_at"] = json!(NOW - 1.);
    assert_space_blocked(&mut f, "review");
}
#[test]
fn trial_with_previous_error_never_applies() {
    let mut f = SpaceFixture::new();
    f.state["trial"]["error_count"] = json!(1);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "keep"
    );
    assert!(f.live.closed_spaces().is_empty());
}
fn assert_space_blocked(f: &mut SpaceFixture, reason: &str) {
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(reasons(i).contains(reason), "{i}");
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn output_change_resets_observation_window() {
    let mut f = SpaceFixture::new();
    f.live.text = "New output\n› Ask Codex to do anything\n".into();
    let out = f.run(true).unwrap();
    assert_eq!(item(&out, "id", "temporary")["quiet_seconds"], 0.);
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn old_or_future_sample_resets_trial_and_idle_window() {
    for gap in [661., -1.] {
        let mut f = SpaceFixture::new();
        f.state["last_at"] = json!(NOW - gap);
        let out = f.run(true).unwrap();
        assert_eq!(item(&out, "id", "temporary")["quiet_seconds"], 0.);
        assert_eq!(out["trial"]["samples"], 1);
        assert!(f.live.closed_spaces().is_empty());
    }
}
#[test]
fn focus_race_onto_the_space_immediately_before_close_blocks_operation() {
    let mut f = SpaceFixture::new();
    f.live.second_snapshot = Some("view space");
    assert_space_blocked(&mut f, "the person is viewing this space");
    assert!(!f.reports.exists());
}
#[test]
fn evidence_race_immediately_before_close_blocks_operation() {
    let mut f = SpaceFixture::new();
    f.live.second_snapshot = Some("new output");
    assert_space_blocked(&mut f, "evidence changed");
    assert!(!f.reports.exists());
}
#[test]
fn failed_close_confirmation_keeps_record_and_raises() {
    let mut f = SpaceFixture::new();
    f.live.space_close_stays = true;
    assert!(f
        .run(true)
        .unwrap_err()
        .to_string()
        .contains("not confirmed"));
    assert_eq!(f.live.closed_spaces(), ["temporary"]);
    assert_eq!(fs::read_dir(&f.reports).unwrap().count(), 1);
}
#[test]
fn focus_change_after_close_stops_further_cleanup() {
    let mut f = SpaceFixture::new();
    let mut other = f.live.data["spaces"][1].clone();
    other["id"] = json!("other");
    other["name"] = json!("Other temporary");
    f.live.data["spaces"].as_array_mut().unwrap().push(other);
    f.state["spaces"]["other"] = f.state["spaces"]["temporary"].clone();
    f.live.focus_after_close = true;
    let error = spaces::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW,
        true,
        None,
        &f.reports,
    )
    .unwrap_err();
    assert!(error.to_string().contains("focus changed after close"));
    assert_eq!(f.live.closed_spaces(), ["temporary"]);
}
#[test]
fn the_person_moving_elsewhere_does_not_stop_cleanup() {
    let mut f = SpaceFixture::new();
    f.live.second_snapshot = Some("elsewhere");
    let out = f.run(true).unwrap();
    assert_eq!(item(&out, "id", "temporary")["action"], "closed");
    assert_eq!(f.live.closed_spaces(), ["temporary"]);
}
#[test]
fn the_space_the_person_is_viewing_is_kept() {
    let mut f = SpaceFixture::new();
    f.live.second_snapshot = Some("view space");
    assert_space_blocked(&mut f, "the person is viewing this space");
}
#[test]
fn close_exception_is_not_reported_as_success() {
    let mut f = SpaceFixture::new();
    f.live.space_close_error = true;
    assert!(f
        .run(true)
        .unwrap_err()
        .to_string()
        .contains("close failed"));
    assert_eq!(fs::read_dir(&f.reports).unwrap().count(), 1);
}
#[test]
fn failed_archive_keeps_the_space() {
    let mut f = SpaceFixture::new();
    f.live.archive_error = true;
    assert_space_blocked(&mut f, "harness archive failed");
    assert!(!f.reports.exists());
}
#[test]
fn archive_names_tabs_sessions_and_git_before_close() {
    let mut f = SpaceFixture::new();
    let mut space = f.live.data["spaces"][1].clone();
    space["folder"] = json!("/fixture/worktree");
    let snapshot = f.live.data.clone();
    let inspected = spaces::inspect(&space, &snapshot, &mut f.live, &f.config).unwrap();
    let archive = spaces::archive_of(
        &space,
        &o::arr(&inspected["sessions"]),
        &snapshot,
        &mut f.live,
    )
    .unwrap();
    assert_eq!(
        archive["workspace_id"],
        format!("{}-temporary", "m".repeat(32))
    );
    assert_eq!(archive["name"], "Temporary work");
    assert_eq!(archive["folder"], "/fixture/worktree");
    let pane = &archive["tabs"][0]["panes"][0];
    assert_eq!(pane["address"], "t-test");
    assert_eq!(pane["agent"], "codex");
    assert_eq!(pane["session_id"], SID);
    assert_eq!(pane["git"]["uncommitted"], 1);
}
#[test]
fn existing_record_is_appended_without_destroying_previous_content() {
    let mut f = SpaceFixture::new();
    let snapshot = f.live.data.clone();
    let inspected =
        spaces::inspect(&snapshot["spaces"][1], &snapshot, &mut f.live, &f.config).unwrap();
    let path = spaces::record_space(&inspected, &f.reports, NOW, &[]).unwrap();
    fs::write(&path, b"Existing human report\n").unwrap();
    let second = spaces::record_space(&inspected, &f.reports, NOW + 60., &[]).unwrap();
    assert_eq!(path, second);
    let text = fs::read_to_string(path).unwrap();
    assert!(text.starts_with("Existing human report\n"));
    assert!(text.contains("자동 정리 시각"));
    assert!(text.contains("temporary"));
}
#[test]
fn user_approval_replaces_the_30_minute_review_after_one_recorded_dry_run() {
    let mut f = SpaceFixture::new();
    f.config
        .as_object_mut()
        .unwrap()
        .remove("reviewed_dry_run_at");
    f.config["user_approved_apply"] = json!(true);
    f.state["trial"]["started_at"] = json!(NOW - 300.);
    f.state["trial"]["samples"] = json!(1);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "closed"
    );
}
#[test]
fn user_approval_is_tied_to_the_reviewed_code() {
    let mut f = SpaceFixture::new();
    f.config
        .as_object_mut()
        .unwrap()
        .remove("reviewed_dry_run_at");
    f.config["user_approved_apply"] = json!(true);
    f.config["reviewed_observer_sha256"] = json!("other-code");
    f.state["trial"]["started_at"] = json!(NOW - 300.);
    f.state["trial"]["samples"] = json!(1);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "keep"
    );
}
#[test]
fn refused_harness_record_keeps_the_space_and_writes_no_document() {
    let mut f = SpaceFixture::new();
    f.live.park_ok = false;
    assert_space_blocked(&mut f, "harness record failed");
    assert!(!f.reports.exists());
}
#[test]
fn fixed_spaces_are_never_archived_or_closed_even_when_the_person_asks_now() {
    for name in ["Share", "share", "PROJECT A"] {
        let mut f = SpaceFixture::new();
        f.live.data["spaces"][1]["name"] = json!(name);
        f.config["_manual"] = json!(true);
        assert_space_blocked(&mut f, "fixed workspace");
        assert!(f.live.archives.is_empty());
    }
    let mut f = SpaceFixture::new();
    f.live.data["spaces"][1]["name"] = json!("Renamed");
    f.config["fixed_spaces"] = json!([{"id":"temporary","machine":null}]);
    assert_space_blocked(&mut f, "fixed workspace");
}
#[test]
fn now_skips_the_quiet_window_and_the_switch_but_not_the_safety_checks() {
    let mut f = SpaceFixture::new();
    f.config["space_close_enabled"] = json!(false);
    f.config["_manual"] = json!(true);
    f.config["reviewed_observer_sha256"] = json!("other");
    f.reset_state(0.);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "closed"
    );
    let mut f = SpaceFixture::new();
    f.config["space_close_enabled"] = json!(false);
    f.config["_manual"] = json!(true);
    f.config["reviewed_observer_sha256"] = json!("other");
    f.live.data["terminals"]["t-test"]["status"]["state"] = json!("working");
    f.reset_state(0.);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "keep"
    );
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn default_idle_window_is_six_hours() {
    let mut f = SpaceFixture::new();
    f.config.as_object_mut().unwrap().remove("idle_seconds");
    f.reset_state(21599.);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "keep"
    );
    f.reset_state(21600.);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "closed"
    );
}
fn inspect_space(f: &mut SpaceFixture) -> Value {
    let snapshot = f.live.data.clone();
    spaces::inspect(&snapshot["spaces"][1], &snapshot, &mut f.live, &f.config).unwrap()
}
#[test]
fn current_space_is_never_inspected_or_closed() {
    let mut f = SpaceFixture::new();
    f.live.data["status"]["space"] = json!("temporary");
    assert_eq!(inspect_space(&mut f)["safe"], false);
    assert!(f.live.reads.is_empty());
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn active_flag_alone_prevents_cleanup() {
    let mut f = SpaceFixture::new();
    f.live.data["spaces"][1]["active"] = json!(true);
    assert_space_blocked(&mut f, "currently visible");
}
#[test]
fn fixed_names_ignore_case_and_fixed_ids_are_machine_specific() {
    let mut f = SpaceFixture::new();
    for name in ["Share", "PROJECT A", "project b"] {
        f.live.data["spaces"][1]["name"] = json!(name);
        assert_eq!(inspect_space(&mut f)["safe"], false);
    }
    f.live.data["spaces"][1]["name"] = json!("Renamed fixed workspace");
    f.config["fixed_spaces"] = json!([{"id":"temporary","machine":null}]);
    assert_eq!(inspect_space(&mut f)["safe"], false);
    f.config["fixed_spaces"] = json!([{"id":"temporary","machine":"remote"}]);
    assert_eq!(inspect_space(&mut f)["safe"], true);
}
#[test]
fn remote_workspaces_are_never_assumed_safe() {
    let mut f = SpaceFixture::new();
    f.live.data["spaces"][1]["machine"] = json!("remote");
    assert_space_blocked(&mut f, "remote");
    assert!(f.live.reads.is_empty());
}
#[test]
fn working_or_unreported_agent_blocks_cleanup() {
    for status in [json!("working"), json!("blocked"), Value::Null] {
        let mut f = SpaceFixture::new();
        f.live.data["terminals"]["t-test"]["status"]["state"] = status;
        assert_space_blocked(&mut f, "not a confirmed");
    }
    let mut f = SpaceFixture::new();
    f.live.data["terminals"]["t-test"]["reported"] = json!(false);
    assert_space_blocked(&mut f, "not a confirmed");
}
#[test]
fn pending_input_or_wrapped_multiline_input_blocks_cleanup() {
    for text in ["› please continue\n", "›\nwrapped pending input\n"] {
        let mut f = SpaceFixture::new();
        f.live.text = text.into();
        assert_space_blocked(&mut f, "empty input unverified");
    }
}
#[test]
fn approval_wait_blocks_and_is_notified_once_per_day_after_review() {
    let mut f = SpaceFixture::new();
    f.live.text = "사용자 승인 대기\n› Ask Codex to do anything\n".into();
    f.run(true).unwrap();
    assert!(f.live.closed_spaces().is_empty());
    assert_eq!(f.live.events("ask").len(), 1);
    assert_eq!(f.live.events("ask")[0][1], "review-session");
    spaces::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW + 300.,
        true,
        Some("temporary"),
        &f.reports,
    )
    .unwrap();
    assert_eq!(f.live.events("ask").len(), 1);
}
#[test]
fn running_child_shell_or_unknown_process_blocks_cleanup() {
    for name in ["sh", "bash", "sleep", "unknown-helper"] {
        let mut f = SpaceFixture::new();
        f.live.data["processes"]["102"] = json!({"pid":102,"parent":101,"name":name});
        assert_space_blocked(&mut f, "child processes");
    }
}
#[test]
fn live_subagent_terminal_blocks_cleanup() {
    let mut f = SpaceFixture::new();
    f.live.data["terminals"]["child"] = json!({"address":"child","parent":"t-test","state":"live"});
    assert_space_blocked(&mut f, "live subagent");
}
#[test]
fn missing_process_or_terminal_evidence_blocks_cleanup() {
    let mut f = SpaceFixture::new();
    f.live.data["processes"] = json!({});
    assert_space_blocked(&mut f, "process evidence unavailable");
    f.live.data["terminals"] = json!({});
    assert_space_blocked(&mut f, "terminal evidence unavailable");
}
#[test]
fn slept_pane_counts_as_idle_and_is_archived_with_its_session() {
    let mut f = SpaceFixture::new();
    let sid = "22222222-3333-4444-5555-666666666666";
    f.live.data["terminals"]["t-test"] = json!({"address":"t-test","state":"live","pid":100,"reported":true,"status":null,"cwd":null,"labels":{"sixfold.sleep":format!("claude:{sid}"),"sixfold.title":"절전 · 문서"},"foreground":{"pid":300,"argv":["python3","/x/session_sleep_stub.py","/x/t.json"]}});
    assert_eq!(inspect_space(&mut f)["safe"], true);
    f.reset_state(600.);
    assert_eq!(
        item(&f.run(true).unwrap(), "id", "temporary")["action"],
        "closed"
    );
    let pane = &f.live.archives[0]["tabs"][0]["panes"][0];
    assert_eq!(pane["agent"], "claude-code");
    assert_eq!(pane["session_id"], sid);
    assert_eq!(pane["last_state"], "slept");
}
#[test]
fn a_sleep_label_without_the_stub_is_not_trusted() {
    let mut f = SpaceFixture::new();
    f.live.data["terminals"]["t-test"]["labels"] =
        json!({"sixfold.sleep":"claude:22222222-3333-4444-5555-666666666666"});
    f.live.data["terminals"]["t-test"]["status"] = json!({"app":"claude-code","state":"working"});
    assert_eq!(inspect_space(&mut f)["safe"], false);
}
// Original LookupFailureTests and RecheckTimeoutTests fault the inspection call.
#[test]
fn cleanup_an_unreadable_app_at_the_start_skips_the_cycle() {
    let mut f = SpaceFixture::new();
    f.live.snapshot_error = true;
    assert!(f.run(true).unwrap_err().to_string().starts_with("SKIP:"));
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn a_failing_space_lookup_keeps_that_space_only() {
    let mut f = SpaceFixture::new();
    f.live.screen_error = Some("t-test");
    let out = spaces::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW,
        true,
        None,
        &f.reports,
    )
    .unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(reasons(i).contains("lookup failed: herdr-core get timed out"));
    assert!(out["results"].as_array().unwrap().len() > 1);
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn a_failing_recheck_keeps_the_space_without_an_error() {
    let mut f = SpaceFixture::new();
    f.live.second_snapshot = Some("snapshot failure");
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(o::s(&i["reasons"][0]).starts_with("recheck lookup failed"));
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn a_recheck_inspect_timing_out_keeps_only_that_space() {
    let mut f = SpaceFixture::new();
    f.live.second_snapshot = Some("screen timeout");
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(o::arr(&i["reasons"])
        .iter()
        .any(|reason| o::s(reason).starts_with("recheck lookup failed")));
    assert!(f.live.closed_spaces().is_empty());
}
#[test]
fn uncommitted_work_is_recorded_before_close_but_worktree_is_not_deleted() {
    fn git(cwd: &Path, args: &[&str]) {
        let out = herdr_theme::common::command("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let mut f = SpaceFixture::new();
    let repo = f._temp.path().join("repo");
    let worktree = f._temp.path().join("worktree");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    fs::write(repo.join("committed.txt"), b"saved").unwrap();
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture saved work",
        ],
    );
    git(
        &repo,
        &["worktree", "add", "--detach", worktree.to_str().unwrap()],
    );
    fs::write(
        worktree.join("pending.txt"),
        b"Uncommitted work must remain on disk",
    )
    .unwrap();
    f.live.data["spaces"][1]["folder"] = json!(worktree);
    f.live.data["terminals"]["t-test"]["cwd"] = json!(worktree);
    f.reset_state(600.);
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "closed");
    assert!(worktree.is_dir());
    assert_eq!(
        fs::read(worktree.join("pending.txt")).unwrap(),
        b"Uncommitted work must remain on disk"
    );
    let report = fs::read_to_string(o::s(&i["record"])).unwrap();
    for expected in ["pending.txt", "fixture saved work", "worktrees"] {
        assert!(report.contains(expected), "{report}");
    }
}
#[test]
fn an_error_stops_apply_until_three_healthy_cycles_in_a_row() {
    let mut state = json!({"trial":{"started_at":1,"samples":5,"error_count":0}});
    sessions::settle_trial(&mut state, &json!({}), false);
    for _ in 0..2 {
        sessions::settle_trial(&mut state, &json!({}), true);
    }
    assert_eq!(state["trial"]["error_count"], 1);
    sessions::settle_trial(&mut state, &json!({}), false);
    for _ in 0..2 {
        sessions::settle_trial(&mut state, &json!({}), true);
    }
    assert_eq!(state["trial"]["error_count"], 2);
    sessions::settle_trial(&mut state, &json!({}), true);
    assert_eq!(state["trial"]["error_count"], 0);
    let mut state = json!({"trial":{"error_count":1,"healthy":0}});
    sessions::settle_trial(&mut state, &json!({"error_reset_after":1}), true);
    assert_eq!(state["trial"]["error_count"], 0);
}
#[test]
fn the_streak_survives_the_next_cycle() {
    let trial = sessions::trial_of(
        &json!({"trial":{"started_at":5,"samples":2,"error_count":1,"healthy":2}}),
        9.,
        true,
    );
    assert_eq!(
        (
            trial["error_count"].clone(),
            trial["healthy"].clone(),
            trial["samples"].clone()
        ),
        (json!(1), json!(2), json!(3))
    );
}

// Remaining original test_close_finished_spaces.py lifecycle groups.
#[test]
fn harness_record_precedes_document_and_close_and_closed_follows() {
    let mut f = SpaceFixture::new();
    let out = f.run(true).unwrap();
    assert_eq!(item(&out, "id", "temporary")["action"], "closed");
    assert_eq!(f.live.parks(), ["close_requested", "closed"]);
    assert_eq!(
        item(&out, "id", "temporary")["harness"],
        json!(["record-1"])
    );
    let order: Vec<_> = f
        .live
        .calls
        .iter()
        .filter(|v| ["park", "archive", "space.close"].contains(&o::s(&v[0])))
        .map(|v| o::s(&v[0]))
        .collect();
    assert_eq!(order, ["park", "archive", "space.close", "park"]);
}
#[test]
fn unknown_session_id_is_a_reason_to_keep() {
    let mut f = SpaceFixture::new();
    f.live.mapping = Value::Null;
    assert_space_blocked(&mut f, "session id unverified");
}
#[test]
fn claude_input_box_borders_do_not_hide_an_empty_prompt() {
    let border = "─".repeat(40);
    let empty = format!(
        "done\n{border}\n❯ \n{border}\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents\n"
    );
    let typed=format!("done\n{border}\n❯ 예시값도 하나 넣어줘\n{border}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n");
    assert!(spaces::empty_prompt(&empty, "claude-code"));
    assert!(!spaces::empty_prompt(&typed, "claude-code"));
}
fn claude(f: &mut SpaceFixture, typed: &str) {
    f.live.data["terminals"]["t-test"]["status"]["app"] = json!("claude-code");
    f.live.data["processes"]["101"]["name"] = json!("claude");
    let border = "─".repeat(30);
    f.live.text =
        format!("done\n{border}\n❯ {typed}\n{border}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n");
}
fn claude_child(f: &mut SpaceFixture) {
    claude(f, "");
    f.live.mapping = Value::Null;
    f.live.jobs=(false,"backend jobs unverified: cannot resume: Claude runs as an inherited child session (no session file or transcript)".into(),String::new());
    f.live.child_session =
        json!({"session_id":"aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee","no_resume":true});
}
#[test]
fn a_faint_suggestion_is_empty_input_but_typed_text_is_not() {
    let mut f = SpaceFixture::new();
    claude(&mut f, "push 완료했어, worktree 정리해");
    f.live.raw = "❯\u{a0}\x1b[0m\x1b[2mpush 완료했어, worktree 정리해\x1b[0m\r\n".into();
    assert_eq!(inspect_space(&mut f)["safe"], true);
    for raw in [
        "❯\u{a0}\x1b[0mpush 완료했어, worktree 정리해\r\n",
        "❯\u{a0}\x1b[2mpush\x1b[22m 완료했어, worktree 정리해\r\n",
        "",
    ] {
        f.live.raw = raw.into();
        assert!(reasons(&inspect_space(&mut f)).contains("t-test: empty input unverified"));
    }
    f.live.raw.clear();
    assert!(reasons(&inspect_space(&mut f)).contains("t-test: empty input unverified"));
}
#[test]
fn answering_the_report_request_keeps_the_idle_window() {
    let mut f = SpaceFixture::new();
    claude(&mut f, "");
    f.reset_state(300.);
    let border = "─".repeat(30);
    f.live.text=format!("done\n❯ [세션 정리 보고 요청] 관찰기가 이 세션을 곧 정리합니다.\n⏺ 01REPORT\n{border}\n❯ \n{border}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n");
    f.run(true).unwrap();
    assert_eq!(f.state["spaces"]["temporary"]["since"], NOW - 300.);
    f.live.text = format!("done\n❯ 다른 일\n⏺ ok\n{border}\n❯ \n{border}\n  ⏵⏵ auto mode on\n");
    spaces::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW + 60.,
        true,
        Some("temporary"),
        &f.reports,
    )
    .unwrap();
    assert_eq!(f.state["spaces"]["temporary"]["since"], NOW + 60.);
}
#[test]
fn a_description_mentioning_check_needed_is_not_a_decision() {
    assert!(!spaces::decision_pending(
        "- 툴팁 첫 줄에는 '모두 정상' 또는 '확인 필요 n개'가 나옵니다.\n❯ \n"
    ));
    assert!(spaces::decision_pending("배포 전에 사용자 확인 필요\n"));
    assert!(spaces::decision_pending("진행하려면 확인이 필요합니다.\n"));
}
#[test]
fn a_session_without_a_transcript_is_reported_parked_archived_and_closed() {
    let mut f = SpaceFixture::new();
    claude_child(&mut f);
    f.config["close_report"] = json!({"enabled":true});
    f.live.reported = false;
    f.reset_state(600.);
    let first = f.run(true).unwrap();
    assert_eq!(item(&first, "id", "temporary")["action"], "keep");
    assert!(f.live.events("ask").iter().any(|v| v[1] == "t-test"));
    f.live.reported = true;
    let out = f.run(true).unwrap();
    assert_eq!(item(&out, "id", "temporary")["action"], "closed");
    assert_eq!(
        f.live.parks_with_sessions,
        vec![
            (
                "close_requested".into(),
                "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee".into()
            ),
            (
                "closed".into(),
                "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee".into()
            )
        ]
    );
    let pane = &f.live.archives[0]["tabs"][0]["panes"][0];
    assert_eq!(pane["no_transcript"], true);
    assert!(pane.get("session_id").is_none());
}
#[test]
fn a_child_session_with_a_running_process_is_kept() {
    let mut f = SpaceFixture::new();
    claude_child(&mut f);
    f.live.data["processes"]["102"] = json!({"pid":102,"parent":101,"name":"npm"});
    let inspected = inspect_space(&mut f);
    let reason = reasons(&inspected);
    assert!(reason.contains("child processes"), "{inspected}");
    assert!(reason.contains("inherited child session"), "{inspected}");
}
#[test]
fn the_workspace_record_masks_denylisted_names() {
    let f = SpaceFixture::new();
    let path = PathBuf::from(
        spaces::record_space(
            &json!({"id":"sp1","name":"Acme 정리","summary":"acme 배포 확인","folders":[]}),
            &f.reports,
            NOW,
            &["acme".into()],
        )
        .unwrap(),
    );
    let text = fs::read_to_string(&path).unwrap();
    assert!(
        !format!("{}{}", path.file_name().unwrap().to_string_lossy(), text)
            .to_lowercase()
            .contains("acme")
    );
    assert!(path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("[가림]"));
}
const MONITOR_SCREEN:&str="⏺ Bash(kill 4242)\n  ⎿  Blocked by auto mode · /permissions to review\n⏺ Monitor(Slack collector health)\n  ⎿  Monitor started · task bfpugik7k · timeout 1800s\n  ⎿  Allowed by auto mode\n✻ Worked for 3m 42s · done 오후 5:29 · 1 monitor still running\n────────\n❯ \n────────\n  ⏵⏵ auto mode on · 1 monitor\n";
#[test]
fn auto_mode_lines_are_not_a_user_decision() {
    assert!(!spaces::decision_pending(MONITOR_SCREEN));
    assert!(!spaces::decision_pending(
        "⎿  Blocked by auto mode · /permissions to review\n❯ \n"
    ));
}
#[test]
fn a_running_monitor_or_shell_is_in_progress() {
    assert!(spaces::background_running(MONITOR_SCREEN));
    assert!(spaces::background_running(
        "done · 2 shells still running\n❯ \n"
    ));
    assert!(!spaces::background_running(
        "✻ Worked for 3s · done 오후 5:29\n❯ \n"
    ));
}
#[test]
fn real_questions_still_count() {
    assert!(spaces::decision_pending(
        "Do you want to proceed?\n❯ 1. Yes\n  2. No\n"
    ));
    assert!(spaces::decision_pending("사용자 승인 대기: 배포 범위\n"));
}
#[test]
fn monitor_running_keeps_the_space_in_progress_without_a_notice() {
    let mut f = SpaceFixture::new();
    f.config["user_approved_apply"] = json!(true);
    f.live.text = MONITOR_SCREEN.into();
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(f.live.closed_spaces().is_empty());
    assert!(reasons(i).contains("in progress"));
    assert!(!reasons(i).contains("user decision pending"));
    assert!(f.live.events("ask").is_empty());
}
#[test]
fn claude_keep_awake_timer_is_a_helper_but_other_caffeinate_is_not() {
    assert!(sessions::is_helper(&json!({"args":"caffeinate -i -t 300"})));
    assert!(!sessions::is_helper(
        &json!({"args":"caffeinate -i make build"})
    ));
    assert!(!sessions::is_helper(&json!({"args":"caffeinate -dims"})));
}
#[test]
fn not_accepted_keeps_the_space_and_writes_nothing() {
    let mut f = SpaceFixture::new();
    f.live.gate_blockers = vec!["final report not accepted by a trusted actor".into()];
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(f.live.closed_spaces().is_empty());
    assert!(f.live.parks().is_empty());
    assert!(f.live.archives.is_empty());
    assert!(reasons(i).contains("harness close gate") && reasons(i).contains("not accepted"));
    assert!(!f.reports.exists());
}
#[test]
fn accepted_closes_after_the_gate() {
    let mut f = SpaceFixture::new();
    let out = f.run(true).unwrap();
    assert_eq!(item(&out, "id", "temporary")["action"], "closed");
    assert_eq!(f.live.events("gate"), vec![json!(["gate", "t-test"])]);
}
#[test]
fn open_task_or_escalation_keeps_it() {
    for why in [
        "open task in this workspace: 모델 분배 (pending)",
        "open escalation in this workspace (decision)",
    ] {
        let mut f = SpaceFixture::new();
        f.live.gate_blockers = vec![why.into()];
        let out = f.run(true).unwrap();
        let i = item(&out, "id", "temporary");
        assert_eq!(i["action"], "keep");
        assert!(f.live.closed_spaces().is_empty());
        assert!(reasons(i).contains(why));
    }
}
#[test]
fn an_adapter_without_the_gate_never_closes() {
    let mut f = SpaceFixture::new();
    f.live.gate_unavailable = true;
    let out = f.run(true).unwrap();
    let i = item(&out, "id", "temporary");
    assert_eq!(i["action"], "keep");
    assert!(f.live.closed_spaces().is_empty());
    assert!(o::arr(&i["reasons"]).contains(&json!("harness close gate: close gate unavailable")));
}
#[test]
fn one_terminal_timing_out_is_marked_and_the_others_are_read() {
    let mut calls = vec![];
    let mut run = |argv: &[String]| -> Result<String> {
        calls.push(argv.to_vec());
        let args: Vec<_> = argv[1..].iter().map(String::as_str).collect();
        match args.as_slice(){["status"]=>Ok(json!({"space":"s1","tab":"tb1","focused_pane":"p1"}).to_string()),["ls"]=>Ok(json!({"spaces":[]}).to_string()),["ls","--all","--json"]=>Ok(json!({"terminals":[{"address":"t-ok","state":"live"},{"address":"t-bad","state":"live"}]}).to_string()),["get","t-bad","--json"]=>o::err("Command get t-bad timed out after 12 seconds"),["get","t-ok","--json"]=>Ok(json!({"address":"t-ok","pid":1}).to_string()),other=>panic!("unexpected original Live.snapshot argv: {other:?}")}
    };
    let mut snap =
        o::snapshot_with_runner("herdr-app", "herdr-core", &mut run, &mut || Ok(json!({})))
            .unwrap();
    assert_eq!(
        snap["terminals"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        vec!["t-ok"]
    );
    assert!(snap["lookup_errors"].get("t-bad").is_some());
    snap["status"]["space"] = json!("other");
    let space = json!({"id":"sp","name":"Temp","machine":null,"tabs":[{"id":"tb","terminals":[{"terminal":"t-bad"}]}]});
    let mut f = SpaceFixture::new();
    let inspected = spaces::inspect(
        &space,
        &snap,
        &mut f.live,
        &json!({"fixed_names":[],"fixed_spaces":[]}),
    )
    .unwrap();
    assert_eq!(inspected["safe"], false);
    assert!(reasons(&inspected).contains("t-bad: lookup failed"));
    assert_eq!(calls.len(), 5);
}
// These originals supplied runner= mocks. Native entrypoints delegate to these
// exact same command/parse bodies with the real runner in normal operation.
#[test]
fn the_gate_command_and_fail_closed_answers() {
    let config = json!({"harness":{"python":"py","script":"harness.py"}});
    let item = json!({"address":"t3","app":"claude-code","session_id":SID,"space_id":"sp1"});
    let mut seen = vec![];
    let mut runner = |args: &[String]| {
        seen.push(args.to_vec());
        Ok(o::Output {
            code: 0,
            stdout: r#"{"ok": true, "blockers": []}"#.into(),
            stderr: String::new(),
        })
    };
    let value = sessions::harness_close_gate_with_runner(&config, &item, &mut runner).unwrap();
    assert_eq!(value["ok"], true);
    assert_eq!(
        &seen[0][2..],
        [
            "close-gate",
            "t3",
            "--provider",
            "claude",
            "--session-id",
            SID,
            "--space-id",
            "sp1"
        ]
    );
    for (out, code) in [
        (r#"{"ok": false, "blockers": ["x"]}"#, 0),
        ("not json", 0),
        (r#"{"ok": true}"#, 2),
    ] {
        let mut runner = |_: &[String]| {
            Ok(o::Output {
                code,
                stdout: out.into(),
                stderr: String::new(),
            })
        };
        let result = sessions::harness_close_gate_with_runner(&config, &item, &mut runner);
        assert!(result.is_err());
        if out.contains("blockers") {
            assert_eq!(result.unwrap_err().to_string(), "x");
        }
    }
    assert!(
        sessions::harness_close_gate_with_runner(&json!({}), &item, &mut |_| panic!(
            "unconfigured harness must not run"
        ))
        .is_err()
    );
}
#[test]
fn park_carries_the_report_task_and_masks() {
    let mut argv = vec![];
    let mut runner = |args: &[String]| {
        argv.extend_from_slice(args);
        Ok(o::Output {
            code: 0,
            stdout: r#"{"id": "X"}"#.into(),
            stderr: String::new(),
        })
    };
    sessions::harness_park_with_runner(
        &json!({"harness":{"python":"py","script":"h.py"}}),
        &json!({"address":"t12","app":"claude-code","session_id":SID,"report_task_id":"TASK1"}),
        "suspended",
        false,
        "",
        &mut runner,
    )
    .unwrap();
    assert!(argv.contains(&"--mask".to_owned()));
    assert_eq!(
        argv[argv.iter().position(|arg| arg == "--task-id").unwrap() + 1],
        "TASK1"
    );
}
#[test]
fn close_status_parses_the_harness_answer() {
    let config = json!({"harness":{"python":"py","script":"h.py"}});
    let item = json!({"address":"t12","app":"claude-code","session_id":SID});
    let mut runner = |_: &[String]| {
        Ok(o::Output {
            code: 0,
            stdout:
                r#"{"ok": true, "report_id": "R", "task_id": "T", "at": "2026-11-05T00:56:03Z"}"#
                    .into(),
            stderr: String::new(),
        })
    };
    assert_eq!(
        sessions::harness_close_status_with_runner(&config, &item, "S", &mut runner).unwrap(),
        json!({"report_id":"R","task_id":"T","at":"2026-11-05T00:56:03Z"})
    );
    assert!(
        sessions::harness_close_status_with_runner(&config, &item, "S", &mut |_| Ok(o::Output {
            code: 0,
            stdout: r#"{"ok": false}"#.into(),
            stderr: String::new()
        }))
        .is_err()
    );
    assert!(
        sessions::harness_close_status_with_runner(&json!({}), &item, "S", &mut |_| panic!(
            "unconfigured harness must not run"
        ))
        .is_err()
    );
}

// test_session_sleep.py::SleepTests (report closing is disabled in this group).
fn basic_sleep() -> SleepFixture {
    let mut f = SleepFixture::new();
    f.config["close_report"] = json!({"enabled":false});
    f.live.reported = false;
    f.reset_state(1200.);
    f
}
fn exit_sent(f: &SleepFixture, address: &str) -> bool {
    f.live
        .events("keys")
        .iter()
        .any(|call| call[1] == address && call[2] == json!(["/", "e", "x", "i", "t", "enter"]))
}
#[test]
fn visible_workspace_focused_pane_and_excluded_address_never_sleep() {
    let mut f = basic_sleep();
    let out = f.run().unwrap();
    assert!(reasons(item(&out, "address", "t1")).contains("shown on screen (visible tab)"));
    assert!(reasons(item(&out, "address", "t1")).contains("focused pane"));
    assert!(reasons(item(&out, "address", "t3")).contains("excluded address"));
    assert_eq!(item(&out, "address", "t12")["action"], "slept");
}
#[test]
fn other_tabs_of_the_shown_space_may_sleep_but_the_shown_tab_may_not() {
    let mut f = basic_sleep();
    f.live.data["spaces"][0]["tabs"]
        .as_array_mut()
        .unwrap()
        .push(
            json!({"id":"tab-other","terminals":[{"terminal":"t7","pane":"p7","sub_agents":[]}]}),
        );
    let mut terminal = f.live.data["terminals"]["t12"].clone();
    terminal["address"] = json!("t7");
    terminal["pid"] = json!(700);
    terminal["foreground"] = json!({"pid":701,"argv":["claude"],"name":"claude"});
    f.live.data["terminals"]["t7"] = terminal;
    for (pid, parent, name) in [(700, 1, "zsh"), (701, 700, "claude")] {
        f.live.data["processes"][pid.to_string()] =
            json!({"pid":pid,"parent":parent,"name":name,"args":name});
    }
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t7")["action"], "slept");
    assert!(reasons(item(&out, "address", "t1")).contains("shown on screen (visible tab)"));
}
#[test]
fn a_pane_shown_in_a_float_never_sleeps() {
    let mut f = basic_sleep();
    f.live.data["status"]["floats"] = json!({"f1":{"terminal":"t12"}});
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert!(reasons(item(&out, "address", "t12")).contains("shown on screen (visible tab)"));
    assert!(!exit_sent(&f, "t12"));
}
#[test]
fn a_faint_claude_suggestion_is_not_input_but_typed_text_is() {
    let mut f = basic_sleep();
    f.live.text = f.live.text.replace("❯ \n", "❯ 앱 다시 띄워서 반영해줘\n");
    f.live.raw = format!(
        "{}\r\n❯\u{a0}\x1b[0m\x1b[2m앱 다시 띄워서 반영해줘\x1b[0m\r\n{}",
        "─".repeat(30),
        "─".repeat(30)
    );
    f.reset_state(1200.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "slept");
    assert_eq!(i["prompt_suggestion"], true);
    for raw in [
        "❯\u{a0}\x1b[0m앱 다시 띄워서 반영해줘\r\n",
        "❯\u{a0}\x1b[2m앱 다시\x1b[22m 띄워서 반영해줘\r\n",
        "❯\u{a0}\x1b[2m다른 글\x1b[0m\r\n",
        "",
    ] {
        let mut f = basic_sleep();
        f.live.text = f.live.text.replace("❯ \n", "❯ 앱 다시 띄워서 반영해줘\n");
        f.live.raw = raw.into();
        f.reset_state(1200.);
        let out = f.run().unwrap();
        let i = item(&out, "address", "t12");
        assert_eq!(i["action"], "keep", "{raw:?}: {i}");
        assert!(reasons(i).contains("input not empty"));
    }
}
#[test]
fn a_suggestion_with_text_below_the_input_row_is_still_input() {
    let mut f = basic_sleep();
    f.live.text = f.live.text.replace("❯ \n", "❯ 첫 줄\n  둘째 줄\n");
    f.live.raw = "❯\u{a0}\x1b[2m첫 줄\x1b[0m\r\n".into();
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert!(reasons(item(&out, "address", "t12")).contains("input not empty"));
    assert!(!f.live.events("styled").contains(&json!(["styled", "t12"])));
}
#[test]
fn focus_moving_elsewhere_during_a_cycle_does_not_block_sleep() {
    let mut f = basic_sleep();
    f.live.second_snapshot = Some("elsewhere");
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "slept");
}
#[test]
fn focus_moving_onto_the_candidate_keeps_it() {
    let mut f = basic_sleep();
    f.live.data["status"] =
        json!({"space":"fixed","tab":"tab-fixed","focused_pane":"p12","errors":[]});
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "keep");
}
#[test]
fn a_child_session_without_a_session_file_is_named_and_kept() {
    let f = basic_sleep();
    let home = tempfile::tempdir().unwrap();
    let terminal = &f.live.data["terminals"]["t12"];
    let error = sessions::session_mapping_with_inherited(
        terminal,
        &json!({"claude_home":home.path()}),
        &mut |_| true,
    )
    .unwrap_err();
    assert!(error.to_string().contains("cannot resume"));
    assert!(sessions::inherited_child_session_with_reader(
        1,
        &mut |_| Ok("claude CLAUDECODE=1 CLAUDE_CODE_CHILD_SESSION=1 HOME=/x".into())
    ));
    assert!(!sessions::inherited_child_session_with_reader(
        1,
        &mut |_| Ok("claude HOME=/x".into())
    ));
}
#[test]
fn a_child_session_reports_sleeps_and_wakes_as_a_new_session() {
    let mut f = basic_sleep();
    f.live.data["terminals"]["t12"]["foreground"]["argv"] =
        json!(["claude", "사용자 요청: 오래된 첫 지시"]);
    f.live.jobs = (false, "should not be asked".into(), String::new());
    f.live.child_from_terminal = true;
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "slept");
    let pane_sid = sessions::pane_session_id("t12", &json!(5), 201);
    let ticket: Value = serde_json::from_slice(
        &fs::read(Path::new(o::s(&f.paths["tickets"])).join("t12.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(ticket["argv"], json!(["claude"]));
    assert_eq!(ticket["session_id"], pane_sid);
    assert_eq!(ticket["new_session"], true);
    let label_call = f
        .live
        .events("label")
        .into_iter()
        .find(|v| v[1] == "t12")
        .unwrap();
    let labels = &label_call[2];
    assert_eq!(labels["sixfold.sleep"], format!("claude:{pane_sid}"));
    assert_eq!(labels["sixfold.sleep.new"], "1");
}
#[test]
fn an_agent_that_is_the_terminal_program_never_sleeps() {
    let mut f = basic_sleep();
    f.live.data["terminals"]["t12"]["argv"] = json!(["claude", "--resume", SID]);
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert!(reasons(item(&out, "address", "t12"))
        .contains("terminal program is not a shell: the pane would not survive /exit"));
    assert!(!exit_sent(&f, "t12"));
}
#[test]
fn sleep_never_closes_panes_tabs_or_spaces() {
    let mut f = basic_sleep();
    f.run().unwrap();
    assert!(exit_sent(&f, "t12"));
    for kind in ["close", "kill", "rm", "pane.close", "space.close"] {
        assert!(f.live.events(kind).is_empty());
    }
    let mut live = o::Live {
        app: "must-not-run".into(),
        core: "must-not-run".into(),
    };
    assert!(live
        .close_space("sp-any", &f.config)
        .unwrap_err()
        .to_string()
        .contains("workspaces are kept"));
}
#[test]
fn order_is_harness_then_exit_then_stub_then_labels() {
    let mut f = basic_sleep();
    f.run().unwrap();
    let steps: Vec<_> = f
        .live
        .calls
        .iter()
        .filter(|call| call[1] == "t12" || (call[0] == "park" && call[2] == "t12"))
        .collect();
    assert_eq!(
        steps.iter().map(|v| o::s(&v[0])).collect::<Vec<_>>(),
        ["park", "keys", "type", "label"]
    );
    assert_eq!(steps[1][2], json!(["/", "e", "x", "i", "t", "enter"]));
    assert!(o::s(&steps[2][2]).contains("session-sleep-stub"));
    assert_eq!(steps[3][2]["sixfold.sleep"], format!("claude:{SID}"));
    assert!(o::s(&steps[3][2]["sixfold.title"]).starts_with("절전"));
    let ticket: Value = serde_json::from_slice(
        &fs::read(Path::new(o::s(&f.paths["tickets"])).join("t12.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        ticket["argv"],
        json!(["claude", "--dangerously-skip-permissions", "--resume", SID])
    );
}
#[test]
fn no_harness_record_no_sleep() {
    let mut f = basic_sleep();
    f.live.park_ok = false;
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "keep");
    for kind in ["keys", "type", "label"] {
        assert!(f.live.events(kind).is_empty());
    }
}
#[test]
fn dry_run_types_nothing() {
    let mut f = basic_sleep();
    let out = sleep::cycle(&mut f.live, &f.config, &mut f.state, NOW, false, &f.paths).unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "would_sleep");
    assert!(f.live.calls.is_empty());
}
#[test]
fn twenty_minutes_unchanged_is_required() {
    let mut f = basic_sleep();
    f.reset_state(1100.);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "keep");
    assert!(o::arr(&i["reasons"])
        .iter()
        .any(|v| o::s(v).starts_with("unchanged for 18 of 20")));
}
#[test]
fn each_blocking_condition() {
    for (name, expected) in [
        ("typed input", "input not empty"),
        ("approval text", "user decision pending"),
        ("voice", "voice input active"),
        ("working", "not a confirmed idle/done agent"),
        ("background job", "background job running"),
        ("child command", "caffeinate"),
        ("subagent pane", "subagents shown"),
    ] {
        let mut f = basic_sleep();
        match name {
            "typed input" => f.live.text = f.live.text.replace("❯ ", "❯ 이어서 확인해"),
            "approval text" => f.live.text = format!("waiting for your approval\n{}", f.live.text),
            "voice" => f.live.text.push_str("  🎙 Listening…\n"),
            "working" => f.live.change("working"),
            "background job" => {
                f.live.jobs = (
                    false,
                    "backend jobs unverified: Claude background job running".into(),
                    "x".into(),
                )
            }
            "child command" => {
                f.live.data["processes"]["202"] =
                    json!({"pid":202,"parent":201,"name":"caffeinate","args":"caffeinate -i"})
            }
            "subagent pane" => {
                f.live.data["spaces"][1]["tabs"][0]["terminals"][0]["sub_agents"] = json!(["x"])
            }
            _ => unreachable!(),
        };
        let out = f.run().unwrap();
        let i = item(&out, "address", "t12");
        assert_eq!(i["action"], "keep", "{name}: {i}");
        assert!(reasons(i).contains(expected), "{name}: {i}");
        for kind in ["keys", "type", "label"] {
            assert!(f.live.events(kind).is_empty());
        }
    }
}
#[test]
fn apply_needs_approval_of_this_exact_code() {
    let mut f = basic_sleep();
    f.config["reviewed_observer_sha256"] = json!("older-code");
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "keep");
    assert!(reasons(i).contains("apply not approved"));
}
#[test]
fn agent_that_does_not_exit_is_recorded_back_and_stops_the_cycle() {
    let mut f = basic_sleep();
    f.live.exits = false;
    assert!(f.run().is_err());
    assert_eq!(f.live.parks(), ["suspended", "resumed"]);
    assert!(f.live.events("type").is_empty());
    assert!(f.live.events("label").is_empty());
}
#[test]
fn already_asleep_pane_is_left_alone() {
    let mut f = basic_sleep();
    f.live.data["terminals"]["t12"]["labels"] = json!({"sixfold.sleep":format!("claude:{SID}")});
    f.reset_state(1200.);
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "asleep");
    assert!(f.live.calls.is_empty());
}

// test_session_sleep.py::CloseReportTests (the two runner cases are above).
fn close_report_fixture() -> SleepFixture {
    let mut f = SleepFixture::new();
    f.live.reported = false;
    f.reset_state(1200.);
    f
}
fn answer_report(f: &mut SleepFixture, minutes: f64, turn_delta: i64) {
    let turn = f.live.data["terminals"]["t12"]["turn"].as_i64().unwrap();
    f.live.data["terminals"]["t12"]["turn"] = json!(turn + turn_delta);
    f.live.data["terminals"]["t12"]["status_ms"] = json!((NOW - minutes * 60.) * 1000.);
    let first = sleep::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW - minutes * 60. + 1.,
        false,
        &f.paths,
    )
    .unwrap();
    for i in o::arr(&first["results"]) {
        if i["address"] == "t12" && i["fingerprint"].is_string() {
            f.state["sessions"]["t12"] =
                json!({"since":NOW-minutes*60.,"fingerprint":i["fingerprint"]});
        }
    }
    f.state["last_at"] = json!(NOW - 60.);
}
#[test]
fn first_cycle_asks_and_does_not_sleep() {
    let mut f = close_report_fixture();
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "report_requested");
    let asks: Vec<_> = f
        .live
        .events("ask")
        .into_iter()
        .filter(|v| v[1] == "t12")
        .collect();
    assert_eq!(asks.len(), 1);
    assert!(o::s(&asks[0][2]).starts_with(sessions::REPORT_MARK));
    assert!(o::s(&asks[0][2]).contains("close-report"));
    for event in ["park", "keys", "label"] {
        assert!(!f
            .live
            .events(event)
            .iter()
            .any(|v| v.as_array().unwrap().contains(&json!("t12"))));
    }
    assert_eq!(f.state["reports"]["t12"]["session_id"], SID);
}
#[test]
fn after_the_report_the_session_sleeps_without_another_twenty_minutes() {
    let mut f = close_report_fixture();
    f.config["close_finished_panes"] = json!(false);
    f.run().unwrap();
    f.live.calls.clear();
    f.live.reported = true;
    answer_report(&mut f, 3., 1);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "slept", "{i}");
    let steps: Vec<_> = f
        .live
        .calls
        .iter()
        .filter(|v| v.as_array().unwrap().contains(&json!("t12")))
        .map(|v| o::s(&v[0]))
        .collect();
    assert_eq!(&steps[..3], ["status", "park", "keys"]);
    assert!(!steps.contains(&"ask"));
    assert_eq!(i["close_report"], "REP1");
    assert!(f.state["reports"].get("t12").is_none());
}
#[test]
fn no_report_within_the_limit_keeps_the_session_and_does_not_ask_again_at_once() {
    let mut f = close_report_fixture();
    f.run().unwrap();
    f.state["reports"]["t12"]["requested_at"] = json!(NOW - 901.);
    answer_report(&mut f, 3., 1);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "keep");
    assert!(reasons(i).contains("fail-closed"));
    for event in ["park", "keys", "label"] {
        assert!(!f
            .live
            .events(event)
            .iter()
            .any(|v| v.as_array().unwrap().contains(&json!("t12"))));
    }
    f.live.calls.clear();
    f.state["last_at"] = json!(NOW - 60.);
    sleep::cycle(
        &mut f.live,
        &f.config,
        &mut f.state,
        NOW + 60.,
        true,
        &f.paths,
    )
    .unwrap();
    assert!(!f.live.events("ask").iter().any(|v| v[1] == "t12"));
}
#[test]
fn waiting_within_the_limit_keeps_it() {
    let mut f = close_report_fixture();
    f.run().unwrap();
    answer_report(&mut f, 3., 1);
    let out = f.run().unwrap();
    let i = item(&out, "address", "t12");
    assert_eq!(i["action"], "keep");
    assert!(o::arr(&i["reasons"]).contains(&json!("waiting for the session close report")));
}
#[test]
fn work_after_the_request_needs_a_new_report() {
    let mut f = close_report_fixture();
    f.run().unwrap();
    f.live.reported = true;
    answer_report(&mut f, 3., 3);
    let out = f.run().unwrap();
    assert_ne!(item(&out, "address", "t12")["action"], "slept");
}
#[test]
fn typed_input_still_blocks_even_with_a_report() {
    let mut f = close_report_fixture();
    f.run().unwrap();
    f.live.reported = true;
    answer_report(&mut f, 3., 1);
    f.live.text = f.live.text.replace("❯ ", "❯ 이어서");
    let out = f.run().unwrap();
    assert_eq!(item(&out, "address", "t12")["action"], "keep");
    for event in ["keys", "label"] {
        assert!(!f
            .live
            .events(event)
            .iter()
            .any(|v| v.as_array().unwrap().contains(&json!("t12"))));
    }
}

// Audit additions: existing pure fixtures already cover helper process rows,
// resume flags, and old/new stub command construction. These original asserts
// were absent from those captures or require an actual written ticket/archive.
#[test]
fn pane_session_id_matches_the_harness_and_is_a_uuid() {
    assert_eq!(
        sessions::pane_session_id("t38", &json!(1), 2),
        "901ebaf1-e70d-5c12-aff5-2ab7a207eba4"
    );
    let sid = sessions::pane_session_id("t1", &json!(5), 6);
    assert!(uuid::Uuid::parse_str(&sid).is_ok());
}
#[test]
fn summary_carries_no_paths() {
    let summary = sessions::summary(
        &json!({"address":"t12","app":"claude-code","session_id":SID,"space_name":"Project B","title":"edit /Users/someone/work/x.md","git":{"branch":"main","head":"abc","uncommitted":0,"worktrees":1}}),
    );
    let text = serde_json::to_string(&summary).unwrap();
    assert!(!text.contains("/Users/"));
    assert!(text.contains(&format!("claude --resume {SID}")));
}
#[test]
fn cleanup_records_are_masked() {
    assert!(sessions::close_report_message(&json!({})).contains("close-report --mask"));
    let mut seen = vec![];
    let archive = sessions::harness_archive_with_runner(
        &json!({"harness":{"python":"py","script":"h.py"}}),
        &json!({"workspace_id":"m-sp"}),
        &mut |args| {
            seen.push(args.to_vec());
            Ok(o::Output {
                code: 0,
                stdout: r#"{"ok": true, "archive": "A.json"}"#.into(),
                stderr: String::new(),
            })
        },
    )
    .unwrap();
    assert_eq!(archive, "A.json");
    assert_eq!(seen[0].last().unwrap(), "--mask");
    assert_eq!(
        sessions::mask_text("Acme 정리 · ACME-2", &["acme".into()]),
        "[가림] 정리 · [가림]-2"
    );
    assert!(o::s(
        &sessions::summary(
            &json!({"session_id":SID,"app":"claude","address":"t1","no_resume":true})
        )["remaining"]
    )
    .contains("새 세션"));
}
#[test]
fn harness_failure_modes_are_not_ok() {
    let config = json!({"harness":{"python":"py","script":"h.py"}});
    let item = json!({"address":"t12","app":"codex","session_id":SID,"space_id":"sp1"});
    assert!(sessions::harness_park_with_runner(
        &json!({}),
        &item,
        "suspended",
        false,
        "",
        &mut |_| panic!("missing harness must not execute")
    )
    .is_err());
    for (code, out, err) in [(2, "", "invalid choice: park"), (0, "not json", "")] {
        assert!(sessions::harness_park_with_runner(
            &config,
            &item,
            "suspended",
            false,
            "",
            &mut |_| Ok(o::Output {
                code,
                stdout: out.into(),
                stderr: err.into()
            })
        )
        .is_err());
    }
    let mut seen = vec![];
    let rid =
        sessions::harness_park_with_runner(&config, &item, "suspended", false, "", &mut |args| {
            seen.extend_from_slice(args);
            Ok(o::Output {
                code: 0,
                stdout: r#"{"id":"REC"}"#.into(),
                stderr: String::new(),
            })
        })
        .unwrap();
    assert_eq!(rid, "REC");
    assert_eq!(&seen[2..4], ["park", "t12"]);
    assert!(seen.contains(&"--space-id".to_owned()));
}
#[test]
fn ps_args_cut_mid_character_do_not_fail_the_observer() {
    let mut cut = "세션 절전".as_bytes().to_vec();
    cut.pop();
    let rows = sessions::process_table_with_runner(&mut |args| {
        assert_eq!(&args[..2], ["ps", "-axo"]);
        match args[2].as_str() {
            "pid=,ppid=,comm=" => Ok("  10     1 /usr/local/bin/claude\n".into()),
            "pid=,args=" => {
                let mut bytes = b"  10 claude ".to_vec();
                bytes.extend_from_slice(&cut);
                bytes.push(b'\n');
                Ok(String::from_utf8_lossy(&bytes).into_owned())
            }
            other => panic!("unexpected process-table format: {other}"),
        }
    })
    .unwrap();
    assert_eq!(rows["10"]["name"], "claude");
    assert!(o::s(&rows["10"]["args"]).starts_with("claude 세션 절"));
}
#[test]
fn ticket_written_by_observer_has_no_prompt() {
    let root = tempfile::tempdir().unwrap();
    let item = json!({"address":"t11","app":"claude-code","session_id":SID,"argv":["claude","<hc from=\"t3\">11/4 요청 …","<hc from=\"t3\">번역 확인 …","--resume","old-id"],"space_id":"sp","space_name":"Project"});
    let path = sleep::ticket(&item, root.path(), None).unwrap();
    let data: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(data["argv"], json!(["claude", "--resume", SID]));
}
#[test]
fn message_text_is_cleaned_of_paste_markers_and_crs() {
    assert_eq!(
        o::stub::message_of(b"\x1b[200~a\r\nb\rc\x1b[201~\r"),
        "a\nb\nc"
    );
    assert_eq!(o::stub::message_of(b"\r"), "");
}
