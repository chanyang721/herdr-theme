use super::{now, output, policy, queue, settings, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    thread,
    time::Duration,
};
pub fn live(text: &str) -> bool {
    let status = queue::footer(text, "›");
    ["/voice stop", "voice ● listening", "voice ◌ muted"]
        .iter()
        .any(|s| status.contains(s))
}
fn error_at(text: &str) -> Option<usize> {
    [
        "Voice conversation failed:",
        "voice audio session stopped unexpectedly",
        "Voice conversation ended: transport_closed",
    ]
    .iter()
    .filter_map(|s| text.rfind(s))
    .max()
}
pub fn manual_stop(text: &str) -> bool {
    let text = queue::plain(text);
    text.rfind("Voice conversation ended: requested")
        .map(|at| error_at(&text).map(|err| at > err).unwrap_or(true))
        .unwrap_or(false)
}
pub fn failure_marker(text: &str) -> Option<bool> {
    let text = queue::plain(text);
    let error = error_at(&text);
    let stopped = text.rfind("Voice conversation ended: requested");
    let started = text.rfind("Voice conversation started.");
    if stopped
        .into_iter()
        .chain(started)
        .max()
        .map(|at| error.map(|e| at > e).unwrap_or(true))
        .unwrap_or(false)
    {
        Some(false)
    } else {
        error.map(|_| true)
    }
}
pub fn eligible(record: &Value, text: &str, focused: bool, at: f64, device_ready: bool) -> bool {
    if !focused
        || record["seen"] != true
        || !record["failure"].is_object()
        || live(text)
        || manual_stop(text)
    {
        return false;
    }
    let failure = &record["failure"];
    if failure["kind"] == "device" && !device_ready {
        return false;
    }
    if failure["id"] == record["attempted"]
        || failure["ts"].as_f64().unwrap_or(0.) > at + 1.
        || at - record["absent_since"].as_f64().unwrap_or(at) < 3.
    {
        return false;
    }
    let attempts: Vec<_> = record["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .filter(|n| at - n < 900.)
        .collect();
    if attempts.len() >= 3 || attempts.last().map(|n| at - n < 60.).unwrap_or(false) {
        return false;
    }
    let p = queue::plain(text);
    let error = error_at(&p);
    if error.is_none() && record["failure_ui"] != failure["id"] && failure["confirmed"] != true {
        return false;
    }
    if p.rfind("Voice conversation started.")
        .map(|s| error.map(|e| s > e).unwrap_or(true))
        .unwrap_or(false)
    {
        return false;
    }
    if !p.contains("for shortcuts") || !p.lines().any(|s| s.trim_start().starts_with('›')) {
        return false;
    }
    queue::composer(text, "›").is_empty()
}
pub fn failures(connection: &Connection, cursor: i64) -> Result<(i64, Vec<Value>)> {
    let end = connection.query_row("select coalesce(max(id),0) from logs", [], |r| {
        r.get::<_, i64>(0)
    })?;
    let mut statement=connection.prepare("select id,ts,process_uuid,feedback_log_body from logs where id>? and id<=? and target='codex_realtime_webrtc::client' and feedback_log_body in ('voice helper output closed phase=Some(InspectAudio) exit_code=Some(28)','voice helper output closed phase=Some(Device) exit_code=Some(37)') order by id")?;
    let rows = statement.query_map(params![cursor, end], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let pattern = regex::Regex::new(r"^pid:\d+:[0-9a-f-]+$")?;
    let mut events = vec![];
    for row in rows {
        let (id, ts, process, body) = row?;
        let process = process.unwrap_or_default();
        if !pattern.is_match(&process) {
            continue;
        }
        let mut event = json!({"id":id,"ts":ts,"pid":process.split(':').nth(1).unwrap_or("")});
        if body.contains("Some(Device)") {
            event["kind"] = json!("device");
        }
        events.push(event);
    }
    Ok((end, events))
}
pub fn confirmed_closure(connection: &Connection, event: &Value) -> bool {
    connection.query_row("select 1 from logs where id>? and id<=? and ts between ? and ? and process_uuid glob ? and target='codex_realtime_webrtc::session' and feedback_log_body=? limit 1",params![event["id"].as_i64().unwrap_or(0),event["id"].as_i64().unwrap_or(0)+10000,event["ts"].as_f64().unwrap_or(0.),event["ts"].as_f64().unwrap_or(0.)+2.,format!("pid:{}:*",event["pid"].as_str().unwrap_or("")),"voice session operation failed stage=AudioSession kind=\"closed\""],|r|r.get::<_,i64>(0)).is_ok()
}
pub fn audio_selection(text: &str) -> Option<Value> {
    let section = regex::Regex::new(
        r"(?ms)^[ \t]*\[[ \t]*audio[ \t]*\][ \t]*(?:#[^\n]*)?\n(.*?)(?:^[ \t]*\[|\z)",
    )
    .ok()?;
    let Some(found) = section.captures(text) else {
        return if regex::Regex::new(r"(?m)^[ \t]*(?:audio[ \t]*=|\[[ \t]*audio[ \t]*\])")
            .ok()?
            .is_match(text)
        {
            None
        } else {
            Some(json!({}))
        };
    };
    let item = regex::Regex::new(
        r#"^\s*(microphone|speaker)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$"#,
    )
    .ok()?;
    let channel = regex::Regex::new(r"^\s*channel\s*=\s*\d+\s*(?:#.*)?$").ok()?;
    let mut value = json!({});
    for line in found[1].lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if let Some(c) = item.captures(line) {
            let quoted = &c[2];
            value[&c[1]] = if quoted.starts_with('"') {
                serde_json::from_str(quoted).ok()?
            } else {
                json!(&quoted[1..quoted.len() - 1])
            };
        } else if !channel.is_match(line) {
            return None;
        }
    }
    Some(value)
}
pub fn device_signature(payload: &Value, selection: Option<&Value>) -> Option<Value> {
    let selection = selection?;
    let devices = policy::devices(payload);
    let mut chosen = vec![];
    for (kind, key) in [("input", "microphone"), ("output", "speaker")] {
        let name = selection[key].as_str();
        let default = format!("coreaudio_default_audio_{kind}_device");
        let d = devices.iter().find(|d| {
            if let Some(name) = name {
                d["_name"] == name
            } else {
                d[&default] == "spaudio_yes"
            }
        })?;
        let channels = d[format!("coreaudio_device_{kind}")]
            .as_u64()
            .or_else(|| d[format!("coreaudio_device_{kind}")].as_str()?.parse().ok())?;
        let rate = d["coreaudio_device_srate"]
            .as_f64()
            .or_else(|| d["coreaudio_device_srate"].as_str()?.parse().ok())?;
        if channels == 0 || channels > 32 || !(8000. ..=384000.).contains(&rate) {
            return None;
        }
        chosen.push(json!([d["_name"], channels, rate]));
    }
    Some(json!(chosen))
}
fn inspect_devices() -> Option<Value> {
    let text = crate::legacy_text::read(
        settings::home().join(".codex/config.toml"),
        crate::legacy_text::ErrorPolicy::Strict,
    )
    .ok()?;
    let payload = serde_json::from_str(
        &output(
            "/usr/sbin/system_profiler",
            &["-json", "SPAudioDataType"],
            5.,
        )
        .ok()?,
    )
    .ok()?;
    device_signature(&payload, audio_selection(&text).as_ref())
}
pub fn stable_devices(state: &mut Value, signature: Option<Value>, at: f64) -> bool {
    let Some(signature) = signature else {
        state.as_object_mut().map(|m| m.remove("audio"));
        return false;
    };
    if state["audio"]["signature"] != signature {
        state["audio"] = json!({"signature":signature,"since":at});
        return false;
    }
    at - state["audio"]["since"].as_f64().unwrap_or(at) >= 3.
}
fn recent_failure(id: &str) -> Option<bool> {
    let text = if let Some(id) = id.strip_prefix("app:") {
        output(&queue::core(), &["read", id, "--lines", "200"], 5.)
    } else {
        output(
            &queue::herdr(),
            &[
                "pane", "read", id, "--source", "recent", "--lines", "200", "--ansi",
            ],
            5.,
        )
    };
    text.ok().and_then(|s| failure_marker(&s))
}
fn save(state: &Value) -> Result<()> {
    let path = settings::state_dir().join("voice-recovery.json");
    super::replace_json(&path, &path.with_extension("tmp"), state)
}
/// Runtime effects of the original recovery actor, injectable by its original
/// lifecycle tests without opening audio, reading user panes or sending keys.
pub trait RecoveryBackend {
    fn now(&mut self) -> f64;
    fn monotonic(&mut self) -> f64;
    fn panes(&mut self) -> Result<std::collections::BTreeMap<String, Value>>;
    fn session_of(&mut self, pane: &Value) -> Result<String>;
    fn screen(&mut self, id: &str) -> Result<String>;
    fn recent_failure(&mut self, id: &str) -> Option<bool>;
    fn inspect_devices(&mut self) -> Option<Value>;
    fn save(&mut self, state: &Value) -> Result<()>;
    fn send_start(&mut self, id: &str) -> Result<()>;
    fn route(&mut self, advance: bool) -> Result<()>;
    fn report(&mut self, message: &str);
    fn sleep(&mut self, duration: Duration);
}
struct RuntimeRecovery;
impl RecoveryBackend for RuntimeRecovery {
    fn now(&mut self) -> f64 {
        now()
    }
    fn monotonic(&mut self) -> f64 {
        static CLOCK: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        CLOCK
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_secs_f64()
    }
    fn panes(&mut self) -> Result<std::collections::BTreeMap<String, Value>> {
        queue::panes()
    }
    fn session_of(&mut self, pane: &Value) -> Result<String> {
        queue::session_of(pane)
    }
    fn screen(&mut self, id: &str) -> Result<String> {
        queue::screen(id)
    }
    fn recent_failure(&mut self, id: &str) -> Option<bool> {
        recent_failure(id)
    }
    fn inspect_devices(&mut self) -> Option<Value> {
        inspect_devices()
    }
    fn save(&mut self, state: &Value) -> Result<()> {
        save(state)
    }
    fn send_start(&mut self, id: &str) -> Result<()> {
        let request = if let Some(terminal) = id.strip_prefix("app:") {
            super::capture(&queue::hc(), &["send", terminal, "/voice"], Some(5.))
        } else {
            super::capture(&queue::herdr(), &["pane", "run", id, "/voice"], Some(5.))
        };
        if let Err(error) = request {
            if !error.is::<super::ProcessTimeout>() {
                return Err(error);
            }
        }
        Ok(())
    }
    fn route(&mut self, advance: bool) -> Result<()> {
        queue::main_event(advance)
    }
    fn report(&mut self, message: &str) {
        queue::log(message)
    }
    fn sleep(&mut self, duration: Duration) {
        thread::sleep(duration)
    }
}
pub fn tick(state: &mut Value, connection: &Connection) -> Result<()> {
    tick_with(state, connection, &mut RuntimeRecovery)
}
pub fn tick_with<B: RecoveryBackend>(
    state: &mut Value,
    connection: &Connection,
    backend: &mut B,
) -> Result<()> {
    let at = backend.now();
    let current = backend.panes()?;
    if !state["panes"].is_object() {
        state["panes"] = json!({});
    }
    let mut snapshots = std::collections::BTreeMap::new();
    let mut by_pid = std::collections::BTreeMap::new();
    for (id, pane) in &current {
        if pane["agent"] != "codex" {
            continue;
        }
        let observed = (|| -> Result<(String, String)> {
            Ok((backend.session_of(pane)?, backend.screen(id)?))
        })();
        let Ok((session, text)) = observed else {
            continue;
        };
        let pid = session.rsplit(':').next().unwrap_or("");
        if !pid.chars().all(|c| c.is_ascii_digit()) || pid.is_empty() {
            continue;
        }
        if state["panes"][id]["session"] != session {
            state["panes"][id] = json!({"session":session,"seen":false});
        }
        let record = &mut state["panes"][id];
        snapshots.insert(id.clone(), text.clone());
        by_pid.insert(pid.to_owned(), id.clone());
        if live(&text) {
            record["seen"] = json!(true);
            record.as_object_mut().unwrap().remove("absent_since");
            if at - record["failure"]["ts"].as_f64().unwrap_or(at) > 5. {
                record.as_object_mut().unwrap().remove("failure");
            }
        } else {
            if record.get("absent_since").is_none() {
                record["absent_since"] = json!(at);
            }
            if manual_stop(&text) {
                record["seen"] = json!(false);
                record.as_object_mut().unwrap().remove("failure");
            }
        }
    }
    let (cursor, events) = failures(connection, state["cursor"].as_i64().unwrap_or(0))?;
    state["cursor"] = json!(cursor);
    for event in events {
        if let Some(id) = event["pid"].as_str().and_then(|p| by_pid.get(p)) {
            state["panes"][id]["failure"] = event;
        }
    }
    for (id, text) in &snapshots {
        let record = &mut state["panes"][id];
        if !record["failure"].is_object() || record["seen"] != true || live(text) {
            continue;
        }
        if record["failure"]["confirmed"] != true
            && confirmed_closure(connection, &record["failure"])
        {
            record["failure"]["confirmed"] = json!(true);
        }
        let marker = failure_marker(text).or_else(|| {
            if record["failure_ui"] != record["failure"]["id"] {
                backend.recent_failure(id)
            } else {
                None
            }
        });
        if marker == Some(true) {
            record["failure_ui"] = record["failure"]["id"].clone();
        } else if marker == Some(false) && manual_stop(text) {
            record["seen"] = json!(false);
            record.as_object_mut().unwrap().remove("failure");
        }
    }
    let ready = if state["panes"]
        .as_object()
        .unwrap()
        .values()
        .any(|r| r["failure"]["kind"] == "device")
    {
        stable_devices(state, backend.inspect_devices(), at)
    } else {
        false
    };
    for (id, text) in snapshots {
        if !["done", "idle", "working"]
            .contains(&current[&id]["agent_status"].as_str().unwrap_or(""))
            || !eligible(
                &state["panes"][&id],
                &text,
                current[&id]["focused"] == true,
                at,
                ready,
            )
        {
            continue;
        }
        let fresh = backend.panes()?.get(&id).cloned().unwrap_or(Value::Null);
        if fresh["agent"] != "codex"
            || !["done", "idle", "working"].contains(&fresh["agent_status"].as_str().unwrap_or(""))
            || backend.session_of(&fresh)? != state["panes"][&id]["session"].as_str().unwrap_or("")
        {
            continue;
        }
        if !eligible(
            &state["panes"][&id],
            &backend.screen(&id)?,
            fresh["focused"] == true,
            backend.now(),
            ready,
        ) {
            continue;
        }
        if state["panes"][&id]["failure"]["kind"] == "device"
            && backend.inspect_devices().as_ref() != Some(&state["audio"]["signature"])
        {
            state.as_object_mut().unwrap().remove("audio");
            continue;
        }
        let record = &mut state["panes"][&id];
        record["attempted"] = record["failure"]["id"].clone();
        let mut attempts: Vec<_> = record["attempts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_f64)
            .filter(|n| at - n < 900.)
            .collect();
        attempts.push(at);
        record["attempts"] = json!(attempts);
        backend.save(state)?;
        backend.send_start(&id)?;
        backend.report(&format!(
            "codex voice recovery requested {id}; confirmed helper closure {}",
            state["panes"][&id]["attempted"]
        ));
        let deadline = backend.monotonic() + 12.;
        let mut confirmed = false;
        while backend.monotonic() < deadline {
            if live(&backend.screen(&id)?) {
                state["panes"][&id]
                    .as_object_mut()
                    .unwrap()
                    .remove("failure");
                backend.route(true)?;
                backend.report(&format!("codex voice recovery confirmed {id}"));
                confirmed = true;
                break;
            }
            backend.sleep(Duration::from_millis(300));
        }
        if !confirmed {
            backend.report(&format!(
                "codex voice recovery unconfirmed {id}; no repeated toggle"
            ));
        }
    }
    backend.save(state)
}
pub fn upgrade_state(state: &mut Value, connection: &Connection, at: f64) -> Result<()> {
    if state["version"].as_i64().unwrap_or(1) < 2 {
        let first = connection.query_row(
            "select min(id) from logs where ts>=? and target=? and feedback_log_body=?",
            params![
                at - 900.,
                "codex_realtime_webrtc::client",
                "voice helper output closed phase=Some(Device) exit_code=Some(37)"
            ],
            |r| r.get::<_, Option<i64>>(0),
        )?;
        if let Some(first) = first {
            state["cursor"] = json!(state["cursor"].as_i64().unwrap_or(0).min(first - 1));
        }
        state["version"] = json!(2);
    }
    Ok(())
}
pub fn serve() -> Result<()> {
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("voice-recovery.lock"))?;
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        return Ok(());
    }
    fs::write(
        dir.join("voice-recovery.pid"),
        std::process::id().to_string(),
    )?;
    let connection = Connection::open_with_flags(
        settings::home().join(".codex/logs_2.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    connection.busy_timeout(Duration::from_secs(1))?;
    let mut state = settings::read_file(&dir.join("voice-recovery.json"));
    if !state["cursor"].is_number() {
        state["cursor"] = json!(connection.query_row(
            "select coalesce(max(id),0) from logs",
            [],
            |r| r.get::<_, i64>(0)
        )?);
    }
    upgrade_state(&mut state, &connection, now())?;
    queue::log("codex voice recovery monitor started; healthy calls are observation-only");
    loop {
        if let Err(e) = tick(&mut state, &connection) {
            queue::log(&format!(
                "codex voice recovery observation failed: {}",
                super::error_class(e.as_ref())
            ));
        }
        thread::sleep(Duration::from_secs(3));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sqlite_reader_is_bounded_metadata_only_and_preserves_failure_class() {
        let c = Connection::open_in_memory().unwrap();
        c.execute("create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)",[]).unwrap();
        for (id, target, body) in [
            (
                1,
                "codex_realtime_webrtc::client",
                "voice helper output closed phase=Some(InspectAudio) exit_code=Some(28)",
            ),
            (
                2,
                "codex_realtime_webrtc::client",
                "voice helper output closed phase=Some(Shutdown) exit_code=Some(31)",
            ),
            (3, "unrelated", "synthetic private body: must never return"),
            (
                4,
                "codex_realtime_webrtc::client",
                "voice helper output closed phase=Some(Device) exit_code=Some(37)",
            ),
        ] {
            c.execute(
                "insert into logs values(?,100,'pid:123:aaaa',?,?)",
                params![id, target, body],
            )
            .unwrap();
        }
        let (cursor, events) = failures(&c, 0).unwrap();
        assert_eq!(cursor, 4);
        assert_eq!(
            events,
            vec![
                json!({"id":1,"ts":100.,"pid":"123"}),
                json!({"id":4,"ts":100.,"pid":"123","kind":"device"})
            ]
        );
        assert!(failures(&c, cursor).unwrap().1.is_empty());
    }
    #[test]
    fn independent_closure_must_match_process_and_time() {
        let c = Connection::open_in_memory().unwrap();
        c.execute("create table logs(id integer primary key,ts integer,process_uuid text,target text,feedback_log_body text)",[]).unwrap();
        let event = json!({"id":1,"ts":100.,"pid":"123"});
        for (id, pid, at) in [(2, "999", 100), (3, "123", 110), (4, "123", 100)] {
            c.execute(
                "insert into logs values(?,?,?,'codex_realtime_webrtc::session',?)",
                params![
                    id,
                    at,
                    format!("pid:{pid}:aaaa"),
                    "voice session operation failed stage=AudioSession kind=\"closed\""
                ],
            )
            .unwrap();
            assert_eq!(confirmed_closure(&c, &event), id == 4);
        }
    }
    #[test]
    fn requires_confirmed_loss_and_empty_focused_box() {
        let text = "Voice conversation failed: closed\nfor shortcuts\n────\n› ";
        let r = json!({"seen":true,"failure":{"id":5,"ts":90.},"absent_since":90.});
        assert!(eligible(&r, text, true, 100., false));
        assert!(!eligible(&r, text, false, 100., false));
        assert!(!eligible(&r, &format!("{text}draft"), true, 100., false));
        assert!(!eligible(&r, "for shortcuts\n────\n› ", true, 100., false));
        assert!(!eligible(&r,"Voice conversation failed:\nVoice conversation ended: requested\nfor shortcuts\n────\n› ",true,100.,false));
    }
    #[test]
    fn unsupported_audio_config_fails_closed() {
        assert_eq!(
            audio_selection("[audio]\nmicrophone = 'Headset'\nchannel=1\n"),
            Some(json!({"microphone":"Headset"}))
        );
        assert!(audio_selection("[audio]\nmicrophone=['bad']\n").is_none());
        assert_eq!(audio_selection("model='x'\n"), Some(json!({})));
    }
    #[test]
    fn devices_must_settle() {
        let mut s = json!({});
        assert!(!stable_devices(&mut s, Some(json!(["mic"])), 1.));
        assert!(!stable_devices(&mut s, Some(json!(["mic"])), 3.));
        assert!(stable_devices(&mut s, Some(json!(["mic"])), 4.));
        assert!(!stable_devices(&mut s, None, 5.));
        assert!(s.get("audio").is_none());
    }
}
