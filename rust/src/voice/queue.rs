pub mod dictation;
use super::{
    alive, append_json, json_unchecked, mtime, now, output_unchecked, policy, self_launch,
    settings, Result,
};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, OpenOptions},
    thread,
    time::Duration,
};
pub fn core() -> String {
    env::var("SIXFOLD_REAL_HC").unwrap_or_else(|_| binary("herdr-core"))
}
pub fn hc() -> String {
    find_binary("hc").unwrap_or_else(core)
}
pub fn herdr() -> String {
    env::var("HERDR_BIN_PATH").unwrap_or_else(|_| "/opt/homebrew/bin/herdr".into())
}
pub fn app() -> String {
    binary("herdr-app")
}
fn find_binary(name: &str) -> Option<String> {
    crate::common::find_executable(name).map(|p| p.to_string_lossy().into_owned())
}
fn binary(name: &str) -> String {
    find_binary(name).unwrap_or_else(|| {
        settings::home()
            .join(".local/bin")
            .join(name)
            .to_string_lossy()
            .into_owned()
    })
}
pub fn log(message: &str) {
    let dir = settings::state_dir();
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("focus-queue.log"))
    {
        use std::io::Write;
        if let Ok(bytes) = crate::legacy_text::encode_default(
            &crate::legacy_text::platform_newlines(&format!(
                "{} {message}\n",
                chrono::Local::now().format("%H:%M:%S%.3f")
            )),
            crate::legacy_text::ErrorPolicy::Strict,
        ) {
            let _ = f.write_all(&bytes);
        }
    }
}
pub fn plain(text: &str) -> String {
    regex::Regex::new("\u{1b}\\[[0-9;?]*[A-Za-z]|\\r")
        .unwrap()
        .replace_all(text, "")
        .into_owned()
}
pub fn footer(text: &str, prompt: &str) -> String {
    let text = plain(text);
    let lines: Vec<_> = text.lines().collect();
    let Some(row) = lines
        .iter()
        .rposition(|s| s.trim_start().starts_with(prompt))
    else {
        return String::new();
    };
    lines[row.saturating_sub(4)..row].join("\n")
}
pub fn composer(text: &str, prompt: &str) -> String {
    let text = if footer(text, prompt).contains("REC · ") {
        text.to_owned()
    } else {
        regex::Regex::new("(?m)\u{1b}\\[2m[^\\n]*?(?:\u{1b}\\[(?:0|22)m|$)")
            .unwrap()
            .replace_all(text, "")
            .into_owned()
    };
    let text = plain(&text);
    let Some(line) = text
        .lines()
        .filter(|s| s.trim_start().starts_with(prompt))
        .last()
    else {
        return String::new();
    };
    let value = line
        .trim()
        .strip_prefix(prompt)
        .unwrap_or("")
        .trim_matches(|c: char| c == ' ' || "▁▂▃▄▅▆▇█".contains(c))
        .trim();
    if [
        "Try \"",
        "Ask Codex to do anything",
        "Ask a follow-up question",
    ]
    .iter()
    .any(|p| value.starts_with(p))
    {
        String::new()
    } else {
        value.to_owned()
    }
}
pub fn meter(text: &str, prompt: &str) -> usize {
    let text = plain(text);
    text.lines()
        .filter(|l| l.trim_start().starts_with(prompt))
        .last()
        .and_then(|l| l.trim_end().chars().last())
        .and_then(|c| "▁▂▃▄▅▆▇█".chars().position(|m| m == c))
        .unwrap_or(0)
}
pub fn input_ready(text: &str, prompt: &str, draft: bool) -> bool {
    let text = plain(text);
    let lines: Vec<_> = text.lines().collect();
    for i in (1..lines.len()).rev() {
        if lines[i].trim_start().starts_with(prompt) {
            return lines[i - 1].trim_start().starts_with('─')
                && (draft || composer(&text, prompt).is_empty());
        }
    }
    false
}
pub fn find_event(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) => {
            if ["pane_agent_status_changed", "pane_focused"]
                .contains(&value["type"].as_str().unwrap_or(""))
                && value.get("pane_id").is_some()
            {
                return Some(value.clone());
            }
            map.values().find_map(find_event)
        }
        Value::Array(a) => a.iter().find_map(find_event),
        _ => None,
    }
}
pub fn screen(pane: &str) -> Result<String> {
    if let Some(id) = pane.strip_prefix("app:") {
        output_unchecked(&core(), &["read", id], 5.)
    } else {
        output_unchecked(
            &herdr(),
            &[
                "pane", "read", pane, "--source", "visible", "--lines", "14", "--ansi",
            ],
            5.,
        )
    }
}
pub fn send_keys(pane: &str, keys: &[&str]) -> Result<()> {
    let (program, args) = key_command(pane, keys);
    output_unchecked(
        &program,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        10.,
    )?;
    Ok(())
}
pub fn key_command(pane: &str, keys: &[&str]) -> (String, Vec<String>) {
    let mut args = if let Some(id) = pane.strip_prefix("app:") {
        vec!["keys", id]
    } else {
        vec!["pane", "send-keys", pane]
    };
    args.extend(keys);
    let program = if pane.starts_with("app:") {
        core()
    } else {
        herdr()
    };
    (program, args.into_iter().map(str::to_owned).collect())
}
pub fn press<F: FnMut() -> Result<bool>>(
    pane: &str,
    key: &str,
    mut changed: F,
    wait: f64,
) -> Result<bool> {
    send_keys(pane, &[key])?;
    let deadline = now() + wait;
    while now() < deadline {
        thread::sleep(Duration::from_millis(50));
        if changed()? {
            return Ok(true);
        }
    }
    Ok(false)
}
pub fn codex_voice(pane: &str) -> Result<(bool, bool)> {
    let status = footer(&screen(pane)?, "›");
    Ok((
        status.contains("voice ● listening"),
        status.contains("voice ◌ muted"),
    ))
}
pub fn recording(pane: &str) -> Result<bool> {
    Ok(footer(&screen(pane)?, "❯").contains("REC · "))
}
pub fn session_of(pane: &Value) -> Result<String> {
    let pid = pane["pane_id"].as_str().ok_or("pane lacks identity")?;
    if let Some(id) = pid.strip_prefix("app:") {
        let record = super::checked_json_bytes(&core(), &["get", id])?;
        return Ok(format!(
            "{pid}:{}",
            record["foreground"]["pid"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "None".into())
        ));
    }
    let text = output_unchecked(&herdr(), &["pane", "process-info", "--pane", pid], 5.)?;
    let info = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    let group = info["result"]["process_info"]["foreground_process_group_id"]
        .as_i64()
        .map(|v| v.to_string())
        .or_else(|| pane["agent_session"]["value"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "None".into());
    Ok(format!("{pid}:{group}"))
}
pub fn front_is_app() -> Result<bool> {
    let front = output_unchecked("lsappinfo", &["front"], 3.)?;
    Ok(bundle_is_app(&output_unchecked(
        "lsappinfo",
        &["info", "-only", "bundleid", front.trim()],
        3.,
    )?))
}
pub fn bundle_is_app(bundle: &str) -> bool {
    bundle.contains("dev.herdr.app")
}
pub fn app_focus() -> Option<Value> {
    let value = settings::read_file(&settings::app_home().join("data/sixfold/voice-focus.json"));
    if now() * 1000. - value["at"].as_f64().unwrap_or(0.) < 2500. {
        return Some(value);
    }
    asked_focus()
}
pub trait WindowBackend {
    fn clock(&self) -> f64 {
        now()
    }
    fn front(&mut self, checked: bool) -> Result<bool> {
        if !checked {
            return front_is_app();
        }
        let front = super::checked_stdout("lsappinfo", &["front"], Some(2.))?;
        if front.trim().is_empty() {
            return Ok(false);
        }
        Ok(bundle_is_app(&super::checked_stdout(
            "lsappinfo",
            &["info", "-only", "bundleid", front.trim()],
            Some(2.),
        )?))
    }
    fn app(&mut self, args: &[&str], checked: bool) -> Result<Value> {
        if checked {
            codex_json(&app(), args, 3.)
        } else {
            json_unchecked(&app(), args, 3.)
        }
    }
    fn core(&mut self, args: &[&str], checked: bool) -> Result<Value> {
        if checked {
            codex_json(&core(), args, 3.)
        } else {
            json_unchecked(&core(), args, 3.)
        }
    }
    fn tui(&mut self) -> Result<Value> {
        codex_json(&herdr(), &["pane", "list"], 3.)
    }
}
struct RuntimeWindow;
impl WindowBackend for RuntimeWindow {}
pub fn asked_focus() -> Option<Value> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<(f64, Option<Value>)>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| std::sync::Mutex::new((0., None)))
        .lock()
        .ok()?;
    if now() - cache.0 < 0.5 {
        return cache.1.clone();
    }
    let value = asked_focus_with(&mut RuntimeWindow).ok()?;
    *cache = (now(), value.clone());
    value
}
pub fn asked_focus_with<B: WindowBackend>(b: &mut B) -> Result<Option<Value>> {
    if !b.front(false)? {
        return Ok(None);
    }
    let asked = (|| -> Result<Value> {
        let focused = b.app(&["status"], false)?["focused_pane"].clone();
        let listed = b.app(&["ls"], false)?;
        let terminal = listed["spaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|s| s["tabs"].as_array().into_iter().flatten())
            .flat_map(|t| t["terminals"].as_array().into_iter().flatten())
            .find(|t| !focused.is_null() && t["pane"] == focused)
            .and_then(|t| t["terminal"].as_str())
            .map(str::to_owned);
        let all = b.core(&["ls", "--json"], false)?;
        let bridged = b.core(
            &["ls", "--json", "--label", "sixfold.source-session=default"],
            false,
        )?;
        let ids: Vec<_> = bridged["terminals"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["address"].as_str())
            .collect();
        let labels = if let Some(terminal) = terminal.as_ref() {
            b.core(&["get", terminal], false)?
        } else {
            Value::Null
        };
        let panes:Vec<_>=all["terminals"].as_array().into_iter().flatten().filter(|t|!ids.contains(&t["address"].as_str().unwrap_or(""))&&["claude","claude-code","codex"].contains(&t["agent"].as_str().unwrap_or(""))).map(|t|json!({"pane_id":format!("app:{}",t["address"].as_str().unwrap_or("")),"agent":if t["agent"]=="claude-code"{"claude"}else{t["agent"].as_str().unwrap_or("")},"agent_status":t["status"]})).collect();
        Ok(
            json!({"at":b.clock()*1000.,"active":true,"terminal":terminal,"asked":true,"source":labels["labels"]["sixfold.source-pane"],"panes":panes}),
        )
    })();
    let value = match asked {
        Ok(value) => Some(value),
        Err(_) => {
            if b.front(false).unwrap_or(false) {
                Some(
                    json!({"at":b.clock()*1000.,"active":true,"terminal":null,"asked":true,"panes":[]}),
                )
            } else {
                None
            }
        }
    };
    Ok(value)
}
pub fn panes() -> Result<BTreeMap<String, Value>> {
    let listed = json_unchecked(&herdr(), &["pane", "list"], 5.)?;
    let mut current: BTreeMap<_, _> = listed["result"]["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["pane_id"].as_str().map(|id| (id.to_owned(), p.clone())))
        .collect();
    Ok(project(current, app_focus().as_ref()))
}
pub fn project(
    mut current: BTreeMap<String, Value>,
    value: Option<&Value>,
) -> BTreeMap<String, Value> {
    if let Some(value) = value {
        for pane in value["panes"].as_array().into_iter().flatten() {
            if let Some(id) = pane["pane_id"].as_str() {
                let mut p = pane.clone();
                p["focused"] = json!(false);
                current.insert(id.to_owned(), p);
            }
        }
        if value["active"] == true {
            let target = value["source"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("app:{}", value["terminal"].as_str().unwrap_or("None")));
            for (id, p) in &mut current {
                p["focused"] = json!(*id == target);
            }
        }
    }
    current
}
fn codex_json(command: &str, args: &[&str], timeout: f64) -> Result<Value> {
    Ok(serde_json::from_str(&super::checked_stdout(
        command,
        args,
        Some(timeout),
    )?)?)
}
pub fn selected() -> Option<String> {
    selected_with(&mut RuntimeWindow)
}
pub fn selected_with<B: WindowBackend>(b: &mut B) -> Option<String> {
    if !b.front(true).ok()? {
        return None;
    }
    let status = b.app(&["status"], true).ok()?;
    let t = status["agent"].as_str()?;
    let labels = b.core(&["get", t], true).ok()?;
    Some(
        labels["labels"]["sixfold.source-pane"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("app:{t}")),
    )
}
pub fn targets() -> Result<BTreeMap<String, Value>> {
    targets_with(&mut RuntimeWindow)
}
pub fn targets_with<B: WindowBackend>(b: &mut B) -> Result<BTreeMap<String, Value>> {
    let mut current = b
        .tui()
        .ok()
        .map(|v| {
            v["result"]["panes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| p["pane_id"].as_str().map(|id| (id.to_owned(), p.clone())))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let all = b.core(&["ls", "--json"], true)?;
    let bridges = b.core(
        &["ls", "--json", "--label", "sixfold.source-session=default"],
        true,
    )?;
    let ids: Vec<_> = bridges["terminals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["address"].as_str())
        .collect();
    for t in all["terminals"].as_array().into_iter().flatten() {
        let id = t["address"].as_str().unwrap_or("");
        if t["agent"] == "codex" && !ids.contains(&id) {
            let pane = format!("app:{id}");
            current.insert(pane.clone(), json!({"pane_id":pane,"agent":"codex"}));
        }
    }
    current.retain(|_, p| p["agent"] == "codex");
    Ok(current)
}
pub fn known_identity(value: &str) -> bool {
    value
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|n| n > 0)
        .unwrap_or(false)
}
pub fn voice_key_locked(failure: &Value, at: f64) -> bool {
    let (misses, last) = if failure.is_array() {
        (
            failure[0].as_u64().unwrap_or(0),
            failure[1].as_f64().unwrap_or(0.),
        )
    } else {
        (failure.as_u64().unwrap_or(0), 0.)
    };
    misses >= 2 && at - last < 60.
}
pub trait GuardBackend {
    fn focus(&mut self) -> Option<String>;
    fn voice(&mut self, id: &str) -> Result<(bool, bool)>;
    fn identity(&mut self, pane: &Value) -> Result<String>;
    fn toggle(&mut self, id: &str, on: bool) -> Result<bool>;
    fn report(&mut self, message: &str);
}
pub fn reconcile<B: GuardBackend>(
    current: &BTreeMap<String, Value>,
    owned: &mut Map<String, Value>,
    b: &mut B,
) {
    let mut safe = true;
    for (id, pane) in current {
        let check = (|| -> Result<()> {
            let (live, muted) = b.voice(id)?;
            if !live && !muted {
                owned.remove(id);
                return Ok(());
            }
            if b.focus().as_deref() == Some(id) {
                return Ok(());
            }
            if live && muted {
                safe = false;
                return Ok(());
            }
            if muted {
                return Ok(());
            }
            let session = b.identity(pane)?;
            if b.focus().as_deref() == Some(id) || b.voice(id)? != (true, false) {
                safe = false;
                return Ok(());
            }
            if b.toggle(id, false)? {
                if known_identity(&session) {
                    owned.insert(id.clone(), json!(session));
                } else {
                    owned.remove(id);
                }
                b.report(&format!("codex focus guard muted {id}"));
            } else {
                safe = false;
                b.report(&format!("codex focus guard mute unconfirmed {id}"));
            }
            Ok(())
        })();
        if check.is_err() {
            safe = false;
        }
    }
    if !safe {
        return;
    }
    let Some(id) = b.focus() else { return };
    let Some(pane) = current.get(&id) else { return };
    let Some(session) = owned.get(&id).and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let result = (|| -> Result<()> {
        if !known_identity(&session) || session != b.identity(pane)? {
            owned.remove(&id);
            return Ok(());
        }
        let status = b.voice(&id)?;
        if status == (true, false) {
            owned.remove(&id);
        } else if status == (false, true)
            && b.focus().as_deref() == Some(&id)
            && b.voice(&id)? == (false, true)
            && b.toggle(&id, true)?
        {
            owned.remove(&id);
            b.report(&format!("codex focus guard resumed {id}"));
            if b.focus().as_deref() != Some(&id)
                && b.voice(&id)? == (true, false)
                && b.toggle(&id, false)?
            {
                owned.insert(id.clone(), json!(b.identity(pane)?));
                b.report(&format!("codex focus guard remuted after focus race {id}"));
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        log(&format!("codex focus guard observation failed: {e}"));
    }
}
struct RuntimeGuard;
impl GuardBackend for RuntimeGuard {
    fn focus(&mut self) -> Option<String> {
        selected()
    }
    fn voice(&mut self, id: &str) -> Result<(bool, bool)> {
        codex_voice(id)
    }
    fn identity(&mut self, p: &Value) -> Result<String> {
        session_of(p)
    }
    fn toggle(&mut self, id: &str, on: bool) -> Result<bool> {
        let status = footer(&screen(id)?, "›").to_lowercase();
        if !status.contains(if on { "f9 unmute" } else { "f9 mute" }) {
            return Ok(false);
        }
        press(
            id,
            "f9",
            || Ok(codex_voice(id)? == if on { (true, false) } else { (false, true) }),
            1.5,
        )
    }
    fn report(&mut self, s: &str) {
        log(s)
    }
}
pub fn codex_sync() -> Result<()> {
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("codex-focus.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    let current = targets()?;
    let path = dir.join("codex-focus.json");
    let mut owned = settings::read_file(&path)
        .as_object()
        .cloned()
        .unwrap_or_default();
    owned.retain(|id, _| current.contains_key(id));
    reconcile(&current, &mut owned, &mut RuntimeGuard);
    super::replace_json(&path, &path.with_extension("tmp"), &Value::Object(owned))
}
pub fn codex_run(args: &[String]) -> Result<()> {
    if !args.iter().any(|s| s == "--serve") {
        return codex_sync();
    }
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("codex-focus-monitor.lock"))?;
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        return Ok(());
    }
    log("codex focus guard started; manual mute preserved; sidebar independent");
    loop {
        if let Err(e) = codex_sync() {
            log(&format!("codex focus guard observation failed: {e}"));
        }
        thread::sleep(Duration::from_millis(500));
    }
}
fn headset() -> bool {
    static INPUT: std::sync::OnceLock<std::sync::Mutex<(f64, String)>> = std::sync::OnceLock::new();
    let mut input = INPUT
        .get_or_init(|| std::sync::Mutex::new((0., String::new())))
        .lock()
        .unwrap();
    if now() - input.0 >= 2. {
        *input = (now(), policy::default_input());
    }
    policy::headset(&input.1, &settings::load())
}
fn voice_state(since: f64, until: Option<f64>) -> (&'static str, Option<f64>) {
    voice_state_from(
        &policy::segments(&settings::state_dir().join("voice-segments.jsonl"), 50),
        since,
        until,
        settings::state_dir().join("voiceprint.json").exists(),
    )
}
pub fn voice_state_from(
    segments: &[Value],
    since: f64,
    until: Option<f64>,
    learned: bool,
) -> (&'static str, Option<f64>) {
    let items: Vec<_> = segments
        .iter()
        .filter(|s| {
            s["end"].as_f64().unwrap_or(0.) >= since
                && until
                    .map(|u| s["start"].as_f64().unwrap_or(0.) < u)
                    .unwrap_or(true)
        })
        .collect();
    let last = items.last().and_then(|i| i["end"].as_f64());
    if !learned {
        return ("unknown", last);
    }
    let mine: f64 = items
        .iter()
        .filter(|i| i["me"] == true)
        .map(|i| i["seconds"].as_f64().unwrap_or(0.))
        .sum();
    let other: f64 = items
        .iter()
        .filter(|i| i["me"] == false)
        .map(|i| i["seconds"].as_f64().unwrap_or(0.))
        .sum();
    (
        if other > mine {
            "other"
        } else if mine > 0. {
            "me"
        } else {
            "unknown"
        },
        last,
    )
}
fn user_in_herdr() -> Result<bool> {
    let front = output_unchecked("lsappinfo", &["front"], 5.)?;
    let bundle = output_unchecked(
        "lsappinfo",
        &["info", "-only", "bundleid", front.trim()],
        5.,
    )?;
    Ok(front.trim().is_empty()
        || !bundle.contains('=')
        || bundle.contains("dev.herdr.app")
        || bundle.contains("com.googlecode.iterm2"))
}
fn active_path(id: &str) -> std::path::PathBuf {
    policy::marker(&settings::state_dir(), "active", id)
}
fn recently_active(id: &str) -> bool {
    mtime(&active_path(id))
        .map(|at| now() - at < 5.)
        .unwrap_or(false)
}
fn user_engaged(pane: &Value) -> Result<bool> {
    let agent = pane["agent"].as_str().unwrap_or("");
    if !["claude", "codex"].contains(&agent) {
        return Ok(true);
    }
    let id = pane["pane_id"].as_str().unwrap_or("");
    let text = screen(id)?;
    let prompt = if agent == "claude" { "❯" } else { "›" };
    let p = plain(&text);
    if agent == "codex"
        && ["voice ● listening", "voice ◌ muted", "/voice stop"]
            .iter()
            .any(|s| p.contains(s))
    {
        return Ok(true);
    }
    Ok(!composer(&text, prompt).is_empty() || meter(&text, prompt) > 1 || recently_active(id))
}
fn listen_pid(id: &str) -> std::path::PathBuf {
    settings::state_dir().join(format!("listen-{}.pid", id.replace(':', "_")))
}
fn recording_since(id: &str) -> f64 {
    mtime(&policy::marker(&settings::state_dir(), "armed", id)).unwrap_or(now() - 60.)
}
fn read_kept(id: &str) -> (String, bool) {
    let v = settings::read_file(
        &settings::state_dir().join(format!("kept-{}.json", id.replace(':', "_"))),
    );
    (
        v["text"].as_str().unwrap_or("").to_owned(),
        v["spoken"] == true,
    )
}
fn write_kept(id: &str, text: &str, spoken: bool) -> Result<()> {
    let path = settings::state_dir().join(format!("kept-{}.json", id.replace(':', "_")));
    if text.is_empty() {
        let _ = fs::remove_file(path);
        Ok(())
    } else {
        super::write_json_direct(
            &path,
            &json!({"text":text,"spoken":spoken}),
            false,
            false,
            false,
        )
    }
}
fn confirm_voice(since: Option<f64>) -> Result<()> {
    if let Some(since) = since.filter(|since| *since != 0. && super::native::runtime_available()) {
        append_json(
            &settings::state_dir().join("voice-confirmed.jsonl"),
            &json!({"start":super::round(since,3),"end":super::round(now(),3)}),
        )?;
    }
    Ok(())
}
fn start_gate() -> Result<()> {
    if super::native::runtime_available() {
        super::self_launch_logged(
            "voicegate",
            &["serve"],
            &settings::state_dir().join("voicegate.err"),
        )?;
    }
    Ok(())
}
fn start_listening(id: &str) -> Result<()> {
    if !alive(&listen_pid(id)) {
        self_launch("focus_queue", &["--listen", id])?;
    }
    Ok(())
}
fn sentence_end(text: &str) -> bool {
    ['.', '?', '!', '。'].iter().any(|c| text.ends_with(*c))
}
pub fn listen(id: &str) -> Result<()> {
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(listen_pid(id).with_extension("lock"))?;
    if fs2::FileExt::try_lock_exclusive(&lock).is_err() {
        return Ok(());
    }
    let pid = listen_pid(id);
    fs::write(&pid, std::process::id().to_string())?;
    start_gate()?;
    let result = dictation::listen_with(id, &mut dictation::Runtime, dictation::Timing::default());
    let _ = fs::remove_file(pid);
    result
}
/// Production voice-on transitions and the offline diagnostic share this protocol.
pub trait VoiceOnBackend {
    fn listening(&mut self, id: &str) -> bool;
    fn screen(&mut self, id: &str) -> Result<String>;
    fn recording_footer(&mut self, text: &str) -> bool;
    fn session(&mut self, pane: &Value) -> Result<String>;
    fn ready(&mut self, id: &str) -> Result<bool>;
    fn eligible(&mut self) -> Result<bool>;
    fn start(&mut self, id: &str) -> Result<()>;
    fn press_on(&mut self, id: &str) -> Result<bool>;
    fn clock(&self) -> f64;
    fn report(&mut self, message: &str);
}
pub fn set_voice_on<B: VoiceOnBackend>(
    pane: &Value,
    state: &mut Value,
    backend: &mut B,
) -> Result<()> {
    let id = pane["pane_id"].as_str().unwrap_or("");
    if backend.listening(id) {
        return Ok(());
    }
    let text = backend.screen(id)?;
    if backend.recording_footer(&text) {
        if state["voice_key_failures"]
            .as_object()
            .is_some_and(|m| !m.is_empty())
        {
            let session = backend.session(pane)?;
            state["voice_key_failures"]
                .as_object_mut()
                .unwrap()
                .remove(&session);
        }
        backend.start(id)?;
        return Ok(());
    }
    if !state["voice_key_failures"].is_object() {
        state["voice_key_failures"] = json!({});
    }
    let session = backend.session(pane)?;
    if voice_key_locked(&state["voice_key_failures"][&session], backend.clock())
        && !text.contains("Voice mode enabled")
    {
        return Ok(());
    }
    let status = pane["agent_status"].as_str().unwrap_or("");
    if !["done", "idle", "working"].contains(&status)
        || !backend.ready(id)?
        || !backend.eligible()?
    {
        backend.start(id)?;
        return Ok(());
    }
    let flipped = backend.press_on(id)?;
    backend.report(&format!(
        "claude voice on {id}{}",
        if flipped { "" } else { " (no change)" }
    ));
    if !flipped && ["idle", "done"].contains(&status) {
        let session = backend.session(pane)?;
        let failure = &state["voice_key_failures"][&session];
        let misses = if failure.is_array() {
            failure[0].as_u64().unwrap_or(0)
        } else {
            failure.as_u64().unwrap_or(0)
        } + 1;
        let session = backend.session(pane)?;
        state["voice_key_failures"][&session] = json!([misses, backend.clock()]);
        if misses >= 2 {
            backend.report(&format!(
                "claude voice key ignored in {id} ({misses} times); trying again in 60 s"
            ));
        }
    } else {
        let session = backend.session(pane)?;
        state["voice_key_failures"]
            .as_object_mut()
            .unwrap()
            .remove(&session);
        backend.start(id)?;
    }
    Ok(())
}
struct RuntimeVoiceOn;
impl VoiceOnBackend for RuntimeVoiceOn {
    fn listening(&mut self, id: &str) -> bool {
        alive(&listen_pid(id))
    }
    fn screen(&mut self, id: &str) -> Result<String> {
        screen(id)
    }
    fn recording_footer(&mut self, text: &str) -> bool {
        footer(text, "❯").contains("REC · ")
    }
    fn session(&mut self, pane: &Value) -> Result<String> {
        session_of(pane)
    }
    fn ready(&mut self, id: &str) -> Result<bool> {
        Ok(input_ready(&screen(id)?, "❯", false))
    }
    fn eligible(&mut self) -> Result<bool> {
        Ok(user_in_herdr()? && headset())
    }
    fn start(&mut self, id: &str) -> Result<()> {
        start_listening(id)
    }
    fn press_on(&mut self, id: &str) -> Result<bool> {
        press(id, "f8", || recording(id), 3.)
    }
    fn clock(&self) -> f64 {
        now()
    }
    fn report(&mut self, message: &str) {
        log(message)
    }
}
fn set_voice(pane: &Value, on: bool, state: &mut Value) -> Result<()> {
    set_voice_with_codex(pane, on, state, codex_sync)
}
pub fn set_voice_with_codex<F: FnMut() -> Result<()>>(
    pane: &Value,
    on: bool,
    state: &mut Value,
    mut sync: F,
) -> Result<()> {
    if pane["agent"] == "codex" {
        return sync();
    }
    if pane["agent"] != "claude" {
        return Ok(());
    }
    if on {
        return set_voice_on(pane, state, &mut RuntimeVoiceOn);
    }
    dictation::voice_off(
        pane,
        state,
        &mut dictation::Runtime,
        dictation::Timing::default(),
    )
}
pub trait FocusBackend {
    fn pause(&mut self, seconds: f64) {
        thread::sleep(Duration::from_secs_f64(seconds));
    }
    fn active(&mut self) -> bool {
        app_focus()
            .map(|value| value["active"] == true)
            .unwrap_or(false)
    }
    fn panes(&mut self) -> Result<BTreeMap<String, Value>> {
        super_panes()
    }
    fn codex_sync(&mut self) -> Result<()> {
        codex_sync()
    }
    fn voice(&mut self, pane: &Value, on: bool, state: &mut Value) -> Result<()> {
        set_voice(pane, on, state)
    }
    fn report(&mut self, message: &str) {
        log(message)
    }
}
fn super_panes() -> Result<BTreeMap<String, Value>> {
    panes()
}
struct RuntimeFocus;
impl FocusBackend for RuntimeFocus {}
pub fn settle_voice_with<B: FocusBackend>(
    mut current: BTreeMap<String, Value>,
    mut focused: Option<String>,
    state: &mut Value,
    b: &mut B,
) -> Result<()> {
    let wait = if b.active() { 0.6 } else { 0.15 };
    b.pause(wait);
    let settled = b.panes()?;
    let now_focus = settled
        .iter()
        .find(|(_, p)| p["focused"] == true)
        .map(|(id, _)| id.clone());
    if now_focus != focused {
        b.report(&format!(
            "focus moved to {} while settling (was {})",
            now_focus.as_deref().unwrap_or("None"),
            focused.as_deref().unwrap_or("None")
        ));
        focused = now_focus;
        current = settled;
    }
    if current.values().any(|p| p["agent"] == "codex") {
        b.codex_sync()?;
    }
    if let Some(id) = focused.as_ref() {
        if let Some(p) = current.get(id) {
            if p["agent"] != "codex"
                && (attention(p["agent_status"].as_str().unwrap_or(""))
                    || p["agent_status"] == "working")
                && b.panes()?
                    .get(id)
                    .map(|p| p["focused"] == true)
                    .unwrap_or(false)
            {
                b.voice(p, true, state)?;
            }
        }
    }
    for (id, p) in &current {
        if Some(id) != focused.as_ref() && p["agent"] == "claude" {
            b.voice(p, false, state)?;
        }
    }
    Ok(())
}
pub fn main_event(advance: bool) -> Result<()> {
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    if settings::home().join(".codex/logs_2.sqlite").exists()
        && !alive(&dir.join("voice-recovery.pid"))
    {
        self_launch("voice_recovery", &[])?;
    }
    let event = if advance {
        json!({})
    } else {
        find_event(&serde_json::from_str(
            &env::var("HERDR_PLUGIN_EVENT_JSON").unwrap_or_else(|_| "{}".into()),
        )?)
        .unwrap_or_else(|| json!({}))
    };
    if event.as_object().map(|o| o.is_empty()).unwrap_or(true) && !advance {
        return Ok(());
    }
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("state.json.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    let path = dir.join("state.json");
    let mut state = settings::read_file(&path);
    if state.get("queue").is_none() {
        state["queue"] = json!([]);
    }
    let mut queue: Vec<String> = state["queue"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    if !state["status"].is_object() {
        state["status"] = json!({});
    }
    let mut current = panes()?;
    let mut focused = current
        .iter()
        .find(|(_, p)| p["focused"] == true)
        .map(|(id, _)| id.clone());
    let id = event["pane_id"].as_str().unwrap_or("");
    if event["type"] == "pane_agent_status_changed" {
        let status = event["agent_status"].as_str().unwrap_or("");
        let previous = state["status"][id].as_str().unwrap_or("").to_owned();
        state["status"][id] = json!(status);
        if attention(status)
            && (["working", "blocked"].contains(&previous.as_str())
                || ["done", "blocked"].contains(&status))
        {
            if focused.as_deref() != Some(id) && !queue.iter().any(|p| p == id) {
                queue.push(id.to_owned());
                log(&format!("queued {id} ({status})"));
            }
        } else if status == "working" {
            queue.retain(|p| p != id);
        }
    } else {
        queue.retain(|p| p != id);
    }
    queue.retain(|id| {
        current
            .get(id)
            .map(|p| attention(p["agent_status"].as_str().unwrap_or("")))
            .unwrap_or(false)
    });
    let focused_pane = focused.as_ref().and_then(|id| current.get(id));
    let busy = match focused_pane {
        None => true,
        Some(p) => attention(p["agent_status"].as_str().unwrap_or("")) || user_engaged(p)?,
    };
    if !queue.is_empty() && !busy && !app_focus().map(|v| v["active"] == true).unwrap_or(false) {
        let target = queue.remove(0);
        output_unchecked(&herdr(), &["agent", "focus", &target], 5.)?;
        log(&format!(
            "focused {target} (was {}: {})",
            focused.as_deref().unwrap_or("None"),
            focused_pane
                .and_then(|p| p["agent_status"].as_str())
                .unwrap_or("None")
        ));
        focused = Some(target);
    }
    settle_voice_with(current, focused, &mut state, &mut RuntimeFocus)?;
    state["queue"] = json!(queue);
    super::write_json_direct(&path, &state, true, false, false)
}
pub fn attention(s: &str) -> bool {
    ["done", "blocked", "idle"].contains(&s)
}
/// Retained explicit startup helper. The normal focus actor does not call it;
/// only a fresh sidebar heartbeat may request startup of an observed empty CLI.
pub trait AppCodexBackend {
    fn focus(&mut self) -> Option<Value> {
        app_focus()
    }
    fn screen(&mut self, id: &str) -> Result<String> {
        screen(id)
    }
    fn start(&mut self, terminal: &str) -> Result<()> {
        super::capture(&hc(), &["send", terminal, "/voice"], Some(2.))?;
        Ok(())
    }
    fn clock(&self) -> f64 {
        now()
    }
    fn pause(&mut self, seconds: f64) {
        thread::sleep(Duration::from_secs_f64(seconds));
    }
    fn report(&mut self, message: &str) {
        log(message)
    }
}
struct RuntimeAppCodex;
impl AppCodexBackend for RuntimeAppCodex {}
pub fn prepare_app_codex() -> Result<()> {
    prepare_app_codex_with(&mut RuntimeAppCodex)
}
pub fn prepare_app_codex_with<B: AppCodexBackend>(b: &mut B) -> Result<()> {
    let Some(value) = b.focus() else {
        return Ok(());
    };
    if value["active"] != true
        || value["source"].as_str().is_some_and(|s| !s.is_empty())
        || value["asked"] == true
    {
        return Ok(());
    }
    let Some(terminal) = value["terminal"].as_str() else {
        return Ok(());
    };
    let id = format!("app:{terminal}");
    let pane = value["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["pane_id"] == id);
    let Some(pane) = pane else { return Ok(()) };
    if pane["agent"] != "codex"
        || !["idle", "done"].contains(&pane["agent_status"].as_str().unwrap_or(""))
    {
        return Ok(());
    }
    let text = b.screen(&id)?;
    if text.contains("/voice stop")
        || text.contains("voice ")
        || !composer(&text, "›").is_empty()
        || !text.contains("for shortcuts")
        || !text.lines().any(|s| s.trim_start().starts_with('›'))
    {
        return Ok(());
    }
    match b.start(terminal) {
        Ok(_) => {}
        Err(error) if error.is::<super::ProcessTimeout>() => {}
        Err(error) => return Err(error),
    }
    let deadline = b.clock() + 6.;
    while b.clock() < deadline {
        let fresh = b.focus();
        if fresh
            .as_ref()
            .map(|v| v["active"] != true || v["terminal"] != terminal)
            .unwrap_or(true)
        {
            return Ok(());
        }
        let screen = b.screen(&id)?;
        if screen.contains("/voice stop") || screen.contains("voice ") {
            b.report(&format!("app codex voice connected {id}"));
            return Ok(());
        }
        b.pause(0.2);
    }
    b.report(&format!("app codex voice startup unconfirmed {id}"));
    Ok(())
}
pub fn run(args: &[String]) -> Result<()> {
    let result = if args.len() == 2 && args[0] == "--listen" {
        listen(&args[1])
    } else {
        main_event(args.len() == 1 && args[0] == "--app-focus")
    };
    if let Err(e) = result {
        log(&format!("error: {e}"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn footer_does_not_read_conversation() {
        let t = "voice ● listening\nconversation\nmore\nmore\nmore\n────────\n› hi";
        assert!(!footer(t, "›").contains("voice ● listening"));
        assert_eq!(composer("────────\n❯ 직접 입력 █", "❯"), "직접 입력");
        assert_eq!(meter("❯ hi ▄", "❯"), 3);
        assert!(input_ready("────────\n❯ ", "❯", false));
        assert!(!input_ready("Dialog\n❯ ", "❯", false));
    }
    #[test]
    fn dim_suggestion_is_ignored_until_recording() {
        assert_eq!(composer("────\n❯ \u{1b}[2mtry this\u{1b}[0m", "❯"), "");
        assert_eq!(
            composer("REC · 0:02\n────\n❯ \u{1b}[2mspoken\u{1b}[0m", "❯"),
            "spoken"
        );
    }
    struct Fake {
        focus: Option<String>,
        voices: BTreeMap<String, (bool, bool)>,
        calls: Vec<(String, bool)>,
        ok: bool,
    }
    impl GuardBackend for Fake {
        fn focus(&mut self) -> Option<String> {
            self.focus.clone()
        }
        fn voice(&mut self, id: &str) -> Result<(bool, bool)> {
            Ok(self.voices[id])
        }
        fn identity(&mut self, _: &Value) -> Result<String> {
            Ok("p:123".into())
        }
        fn toggle(&mut self, id: &str, on: bool) -> Result<bool> {
            self.calls.push((id.into(), on));
            if self.ok {
                self.voices.insert(id.into(), (on, !on));
            }
            Ok(self.ok)
        }
        fn report(&mut self, _: &str) {}
    }
    #[test]
    fn guard_preserves_manual_mute_and_breaks_before_make() {
        let current = BTreeMap::from([
            ("a".into(), json!({"pane_id":"a"})),
            ("b".into(), json!({"pane_id":"b"})),
        ]);
        let mut fake = Fake {
            focus: Some("a".into()),
            voices: BTreeMap::from([("a".into(), (false, true)), ("b".into(), (true, false))]),
            calls: vec![],
            ok: true,
        };
        let mut owned = Map::from_iter([("a".into(), json!("p:123"))]);
        reconcile(&current, &mut owned, &mut fake);
        assert_eq!(fake.calls, vec![("b".into(), false), ("a".into(), true)]);
        assert_eq!(owned.get("b"), Some(&json!("p:123")));
        let mut empty = Map::new();
        fake.calls.clear();
        fake.voices.insert("a".into(), (false, true));
        reconcile(&current, &mut empty, &mut fake);
        assert!(fake.calls.is_empty());
    }
    #[test]
    fn failed_mute_prevents_resume() {
        let current = BTreeMap::from([("a".into(), json!({})), ("b".into(), json!({}))]);
        let mut fake = Fake {
            focus: Some("a".into()),
            voices: BTreeMap::from([("a".into(), (false, true)), ("b".into(), (true, false))]),
            calls: vec![],
            ok: false,
        };
        let mut owned = Map::from_iter([("a".into(), json!("p:123"))]);
        reconcile(&current, &mut owned, &mut fake);
        assert_eq!(fake.calls, vec![("b".into(), false)]);
        assert!(!owned.contains_key("b"));
    }
}
