use super::{
    alive, append_json, json_output, mtime, now, output, policy, self_launch, settings, write_json,
    Result,
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
    let path = env::var_os("PATH")?;
    for folder in env::split_paths(&path) {
        let candidate = folder.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
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
        let _ = writeln!(
            f,
            "{} {message}",
            chrono::Local::now().format("%H:%M:%S%.3f")
        );
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
        output(&core(), &["read", id], 5.)
    } else {
        output(
            &herdr(),
            &[
                "pane", "read", pane, "--source", "visible", "--lines", "14", "--ansi",
            ],
            5.,
        )
    }
}
pub fn send_keys(pane: &str, keys: &[&str]) -> Result<()> {
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
    output(&program, &args, 10.)?;
    Ok(())
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
        let record = json_output(&core(), &["get", id], 5.)?;
        return Ok(format!(
            "{pid}:{}",
            record["foreground"]["pid"]
                .as_i64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "None".into())
        ));
    }
    let info =
        json_output(&herdr(), &["pane", "process-info", "--pane", pid], 5.).unwrap_or(Value::Null);
    let group = info["result"]["process_info"]["foreground_process_group_id"]
        .as_i64()
        .map(|v| v.to_string())
        .or_else(|| pane["agent_session"]["value"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "None".into());
    Ok(format!("{pid}:{group}"))
}
pub fn front_is_app() -> Result<bool> {
    let front = output("lsappinfo", &["front"], 3.)?;
    Ok(output(
        "lsappinfo",
        &["info", "-only", "bundleid", front.trim()],
        3.,
    )?
    .contains("dev.herdr.app"))
}
pub fn app_focus() -> Option<Value> {
    let value = settings::read_file(&settings::app_home().join("data/sixfold/voice-focus.json"));
    if now() * 1000. - value["at"].as_f64().unwrap_or(0.) < 2500. {
        return Some(value);
    }
    asked_focus()
}
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
    if !front_is_app().ok()? {
        *cache = (now(), None);
        return None;
    }
    let asked = (|| -> Result<Value> {
        let focused = json_output(&app(), &["status"], 3.)?["focused_pane"].clone();
        let listed = json_output(&app(), &["ls"], 3.)?;
        let terminal = listed["spaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|s| s["tabs"].as_array().into_iter().flatten())
            .flat_map(|t| t["terminals"].as_array().into_iter().flatten())
            .find(|t| !focused.is_null() && t["pane"] == focused)
            .and_then(|t| t["terminal"].as_str())
            .map(str::to_owned);
        let all = json_output(&core(), &["ls", "--json"], 3.)?;
        let bridged = json_output(
            &core(),
            &["ls", "--json", "--label", "sixfold.source-session=default"],
            3.,
        )?;
        let ids: Vec<_> = bridged["terminals"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["address"].as_str())
            .collect();
        let labels = terminal
            .as_ref()
            .and_then(|t| json_output(&core(), &["get", t], 3.).ok())
            .unwrap_or(Value::Null);
        let panes:Vec<_>=all["terminals"].as_array().into_iter().flatten().filter(|t|!ids.contains(&t["address"].as_str().unwrap_or(""))&&["claude","claude-code","codex"].contains(&t["agent"].as_str().unwrap_or(""))).map(|t|json!({"pane_id":format!("app:{}",t["address"].as_str().unwrap_or("")),"agent":if t["agent"]=="claude-code"{"claude"}else{t["agent"].as_str().unwrap_or("")},"agent_status":t["status"]})).collect();
        Ok(
            json!({"at":now()*1000.,"active":true,"terminal":terminal,"asked":true,"source":labels["labels"]["sixfold.source-pane"],"panes":panes}),
        )
    })();
    let value = match asked {
        Ok(value) => Some(value),
        Err(_) => {
            if front_is_app().unwrap_or(false) {
                Some(
                    json!({"at":now()*1000.,"active":true,"terminal":null,"asked":true,"panes":[]}),
                )
            } else {
                None
            }
        }
    };
    *cache = (now(), value.clone());
    value
}
pub fn panes() -> Result<BTreeMap<String, Value>> {
    let listed = json_output(&herdr(), &["pane", "list"], 5.)?;
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
pub fn selected() -> Option<String> {
    if !front_is_app().ok()? {
        return None;
    }
    let status = json_output(&app(), &["status"], 3.).ok()?;
    let t = status["agent"].as_str()?;
    let labels = json_output(&core(), &["get", t], 3.).ok()?;
    Some(
        labels["labels"]["sixfold.source-pane"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("app:{t}")),
    )
}
pub fn targets() -> Result<BTreeMap<String, Value>> {
    let mut current = json_output(&herdr(), &["pane", "list"], 5.)
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
    let all = json_output(&core(), &["ls", "--json"], 3.)?;
    let bridges = json_output(
        &core(),
        &["ls", "--json", "--label", "sixfold.source-session=default"],
        3.,
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
    write_json(&path, &Value::Object(owned))
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
    let items: Vec<_> = policy::segments(&settings::state_dir().join("voice-segments.jsonl"), 50)
        .into_iter()
        .filter(|s| {
            s["end"].as_f64().unwrap_or(0.) >= since
                && until
                    .map(|u| s["start"].as_f64().unwrap_or(0.) < u)
                    .unwrap_or(true)
        })
        .collect();
    let last = items.last().and_then(|i| i["end"].as_f64());
    if !settings::state_dir().join("voiceprint.json").exists() {
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
    let front = output("lsappinfo", &["front"], 5.)?;
    let bundle = output(
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
fn may_send(speaker: &str) -> bool {
    speaker == "me" && headset()
}
fn stop_key(text: &str, status: &str, speaker: &str) -> &'static str {
    if !composer(text, "❯").is_empty() {
        if may_send(speaker) {
            "f8"
        } else {
            "esc"
        }
    } else if ["idle", "done"].contains(&status) {
        "esc"
    } else {
        "f8"
    }
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
        write_json(&path, &json!({"text":text,"spoken":spoken}))
    }
}
fn erase(id: &str, count: usize) -> Result<()> {
    if count > 0 {
        send_keys(id, &vec!["backspace"; count])?;
    }
    Ok(())
}
fn restore_box(id: &str, before: &str, speaker: &str) -> Result<()> {
    let keep = if speaker == "other" {
        read_kept(id).0
    } else {
        before.to_owned()
    };
    if keep.is_empty() {
        return Ok(());
    }
    thread::sleep(Duration::from_secs(1));
    let current = composer(&screen(id)?, "❯");
    if current == keep {
        return Ok(());
    }
    if id.starts_with("app:") {
        log(&format!(
            "claude dictation lost {id}: cannot type into app panes ({} chars)",
            keep.chars().count()
        ));
        return Ok(());
    }
    erase(id, current.chars().count())?;
    output(&herdr(), &["pane", "send-text", id, &keep], 10.)?;
    write_kept(id, &keep, true)?;
    log(&format!(
        "claude dictation kept {id} after its recording stopped ({} chars, {speaker} voice)",
        keep.chars().count()
    ));
    Ok(())
}
fn confirm_voice(since: Option<f64>) -> Result<()> {
    if let Some(since) = since {
        append_json(
            &settings::state_dir().join("voice-confirmed.jsonl"),
            &json!({"start":super::round(since,3),"end":super::round(now(),3)}),
        )?;
    }
    Ok(())
}
fn start_gate() -> Result<()> {
    if !alive(&settings::state_dir().join("voicegate.pid")) {
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
fn clear_blocked(id: &str) -> Result<bool> {
    let path = policy::marker(&settings::state_dir(), "blocked", id);
    let Some(at) = mtime(&path) else {
        return Ok(false);
    };
    let text = composer(&screen(id)?, "❯");
    if !text.is_empty() && now() - at < 5. {
        erase(id, text.chars().count())?;
        log(&format!(
            "claude dictation refused {id} ({} chars)",
            text.chars().count()
        ));
    }
    if !text.is_empty() || now() - at >= 5. {
        fs::remove_file(path)?;
    }
    Ok(true)
}
fn finish_dictation(id: &str, spoken: Option<f64>, mut since: f64) -> Result<()> {
    let (speaker, end) = voice_state(spoken.unwrap_or(0.), None);
    let heard = end
        .unwrap_or(0.)
        .max(mtime(&settings::state_dir().join("voice-speaking")).unwrap_or(0.));
    let mut typed = String::new();
    let deadline = now() + 5.;
    while now() < deadline {
        thread::sleep(Duration::from_millis(300));
        let text = composer(&screen(id)?, "❯");
        if text.is_empty() {
            continue;
        }
        if text != typed {
            typed = text;
            since = now();
        }
        if may_send(speaker) && sentence_end(&typed) && now() - since.max(heard) >= 2. {
            send_keys(id, &["enter"])?;
            confirm_voice(spoken)?;
            log(&format!(
                "claude dictation sent {id} after focus left ({} chars, {speaker} voice)",
                typed.chars().count()
            ));
            return Ok(());
        }
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
    let result = (|| -> Result<()> {
        let (mut last, mut since, mut started, mut misses, mut engaged) =
            (None::<String>, now(), None::<f64>, 0, false);
        let mut spoken_since = None;
        let mut dictated = false;
        let (mut kept, mut spoken) = read_kept(id);
        if !kept.is_empty() && !composer(&screen(id)?, "❯").starts_with(&kept) {
            write_kept(id, "", false)?;
            kept.clear();
            spoken = false;
        }
        let mut gate_checked = 0.;
        while misses < 6 {
            thread::sleep(Duration::from_millis(300));
            let pane = panes()?.get(id).cloned().unwrap_or(Value::Null);
            if pane["focused"] != true || pane["agent"] != "claude" {
                if pane["agent"] == "claude"
                    && last.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                    && dictated
                {
                    finish_dictation(id, spoken_since, since)?;
                    last = None;
                    started = None;
                    spoken_since = None;
                    dictated = false;
                    if panes()?
                        .get(id)
                        .map(|p| p["focused"] == true)
                        .unwrap_or(false)
                    {
                        continue;
                    }
                }
                return Ok(());
            }
            if clear_blocked(id)? {
                last = None;
                started = None;
                spoken_since = None;
                dictated = false;
                continue;
            }
            if now() - gate_checked >= 5. {
                gate_checked = now();
                start_gate()?;
            }
            let text = screen(id)?;
            let in_box = composer(&text, "❯");
            let hand = !in_box.is_empty() && policy::seconds_since_key() < 1.5;
            if in_box.is_empty() {
                if !kept.is_empty() {
                    write_kept(id, "", false)?;
                }
                kept.clear();
                spoken = false;
            } else if (hand || !in_box.starts_with(&kept)) && in_box != kept {
                spoken = spoken || dictated;
                kept = in_box.clone();
                write_kept(id, &kept, spoken)?;
            }
            let fresh = in_box.strip_prefix(&kept).unwrap_or(&in_box);
            if fresh.is_empty() {
                dictated = false;
            }
            let headset = headset();
            if !headset || !user_in_herdr()? {
                if footer(&text, "❯").contains("REC · ") && kept.is_empty() {
                    let speaker = voice_state(recording_since(id), None).0;
                    press(
                        id,
                        stop_key(&text, pane["agent_status"].as_str().unwrap_or(""), speaker),
                        || Ok(!recording(id)?),
                        1.5,
                    )?;
                    log(&format!(
                        "claude voice paused {id}: {}",
                        if headset {
                            "another app is in front"
                        } else {
                            "input is not a headset"
                        }
                    ));
                }
                if composer(&screen(id)?, "❯").is_empty() {
                    last = None;
                    started = None;
                    spoken_since = None;
                    dictated = false;
                }
                continue;
            }
            if !footer(&text, "❯").contains("REC · ") {
                let typed = composer(&text, "❯");
                if dictated && !typed.is_empty() {
                    if last.as_deref() != Some(&typed) {
                        last = Some(typed.clone());
                        since = now();
                    }
                    if now() - since < 1. {
                        continue;
                    }
                    let speaker = spoken_since
                        .map(|at| voice_state(at, None).0)
                        .unwrap_or("unknown");
                    if may_send(speaker) {
                        send_keys(id, &["enter"])?;
                        confirm_voice(spoken_since)?;
                        log(&format!("claude dictation sent {id} after recording ended ({} chars, {speaker} voice)",typed.chars().count()));
                    } else {
                        erase(
                            id,
                            typed.chars().count().saturating_sub(kept.chars().count()),
                        )?;
                        log(&format!("claude dictation discarded {id} after recording ended ({} chars, {speaker} voice)",typed.chars().count().saturating_sub(kept.chars().count())));
                    }
                    last = None;
                    started = None;
                    spoken_since = None;
                    dictated = false;
                    continue;
                }
                if last.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                    && dictated
                    && typed.is_empty()
                {
                    confirm_voice(spoken_since)?;
                    log(&format!("claude dictation submitted by user {id}"));
                }
                last = None;
                started = None;
                spoken_since = None;
                dictated = false;
                let draft = spoken
                    && !kept.is_empty()
                    && policy::seconds_since_key() >= 1.5
                    && input_ready(&text, "❯", true);
                if ["done", "idle", "working"]
                    .contains(&pane["agent_status"].as_str().unwrap_or(""))
                    && (input_ready(&text, "❯", false) || draft)
                {
                    let on = press(id, "f8", || recording(id), 1.)?;
                    misses = if on { 0 } else { misses + 1 };
                    log(&format!(
                        "claude voice re-armed {id}{}",
                        if on { "" } else { " (no change)" }
                    ));
                }
                continue;
            }
            if started.is_none() {
                started = Some(now());
                fs::write(policy::marker(&dir, "armed", id), "")?;
            }
            let typed = composer(&text, "❯");
            if last.as_ref().map(|s| !s.is_empty()).unwrap_or(false) && dictated && typed.is_empty()
            {
                confirm_voice(spoken_since)?;
                log(&format!("claude dictation submitted by user {id}"));
            }
            dictated = !fresh.is_empty() && !hand && (dictated || meter(&text, "❯") > 1);
            if fresh.is_empty() {
                spoken_since = None;
            } else if spoken_since.is_none() {
                spoken_since = Some(now() - 2.);
            }
            let (speaker, speech_end) = spoken_since
                .map(|at| voice_state(at, None))
                .unwrap_or(("unknown", None));
            let current_engaged =
                (!typed.is_empty() || meter(&text, "❯") > 1 || recently_active(id))
                    && speaker != "other";
            if engaged && !current_engaged {
                main_event(true)?;
            }
            engaged = current_engaged;
            if (last.as_deref() != Some(&typed) || meter(&text, "❯") > 1)
                && (!typed.is_empty() || meter(&text, "❯") > 1)
                && speaker != "other"
            {
                fs::write(active_path(id), "")?;
            }
            let heard = speech_end
                .unwrap_or(0.)
                .max(mtime(&dir.join("voice-speaking")).unwrap_or(0.));
            if last.as_deref() != Some(&typed) {
                last = Some(typed.clone());
                since = now();
            } else if dictated
                && may_send(speaker)
                && sentence_end(&typed)
                && now() - since.max(heard) >= 2.
            {
                send_keys(id, &["enter"])?;
                confirm_voice(spoken_since)?;
                log(&format!(
                    "claude dictation sent {id} ({} chars, {speaker} voice)",
                    typed.chars().count()
                ));
                last = None;
            } else if dictated && !may_send(speaker) && now() - since.max(heard) >= 3. {
                if kept.is_empty() {
                    press(id, "esc", || Ok(!recording(id)?), 1.5)?;
                }
                erase(
                    id,
                    composer(&screen(id)?, "❯")
                        .chars()
                        .count()
                        .saturating_sub(kept.chars().count()),
                )?;
                log(&format!(
                    "claude dictation discarded {id} ({} chars, {speaker} voice)",
                    typed.chars().count().saturating_sub(kept.chars().count())
                ));
                last = None;
            } else if typed.is_empty()
                && now() - started.unwrap_or(now()) >= 100.
                && ["idle", "done"].contains(&pane["agent_status"].as_str().unwrap_or(""))
            {
                press(id, "esc", || Ok(!recording(id)?), 1.5)?;
                log(&format!("claude voice recycled {id}"));
            }
        }
        log(&format!("claude voice stopped re-arming {id}: F8 ignored"));
        Ok(())
    })();
    let _ = fs::remove_file(pid);
    result
}
fn set_voice(pane: &Value, on: bool, state: &mut Value) -> Result<()> {
    let id = pane["pane_id"].as_str().unwrap_or("");
    if pane["agent"] == "codex" {
        return codex_sync();
    }
    if pane["agent"] != "claude" {
        return Ok(());
    }
    if on && alive(&listen_pid(id)) {
        return Ok(());
    }
    let text = screen(id)?;
    let session = session_of(pane)?;
    if !state["voice_key_failures"].is_object() {
        state["voice_key_failures"] = json!({});
    }
    if footer(&text, "❯").contains("REC · ") == on {
        if on {
            state["voice_key_failures"]
                .as_object_mut()
                .unwrap()
                .remove(&session);
            start_listening(id)?;
        }
        return Ok(());
    }
    let status = pane["agent_status"].as_str().unwrap_or("");
    if on {
        let failure = &state["voice_key_failures"][&session];
        if voice_key_locked(failure, now()) && !text.contains("Voice mode enabled") {
            return Ok(());
        }
        if !["done", "idle", "working"].contains(&status)
            || !input_ready(&screen(id)?, "❯", false)
            || !user_in_herdr()?
            || !headset()
        {
            start_listening(id)?;
            return Ok(());
        }
    }
    let before = if on {
        String::new()
    } else {
        composer(&text, "❯")
    };
    let mut speaker = "unknown";
    if !before.is_empty() {
        let left = now();
        loop {
            speaker = voice_state(recording_since(id), Some(left)).0;
            if speaker != "unknown" || now() >= left + 3. {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }
    }
    let mut key = if on {
        "f8"
    } else {
        stop_key(&text, status, speaker)
    };
    if key == "f8"
        && !before.is_empty()
        && !id.starts_with("app:")
        && composer(&screen(id)?, "❯") != before
    {
        key = "esc";
    }
    let flipped = press(
        id,
        key,
        || Ok(recording(id)? == on),
        if on { 3. } else { 1.5 },
    )?;
    log(&format!(
        "claude voice {} {id}{}",
        if on { "on" } else { "off" },
        if flipped { "" } else { " (no change)" }
    ));
    if key == "esc" && !before.is_empty() {
        restore_box(id, &before, speaker)?;
    }
    if on && !flipped && ["idle", "done"].contains(&status) {
        let failure = &state["voice_key_failures"][&session];
        let misses = if failure.is_array() {
            failure[0].as_u64().unwrap_or(0)
        } else {
            failure.as_u64().unwrap_or(0)
        } + 1;
        state["voice_key_failures"][&session] = json!([misses, now()]);
    } else if on {
        state["voice_key_failures"]
            .as_object_mut()
            .unwrap()
            .remove(&session);
        start_listening(id)?;
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
        output(&herdr(), &["agent", "focus", &target], 5.)?;
        log(&format!("focused {target} (was {focused:?})"));
        focused = Some(target);
    }
    thread::sleep(Duration::from_secs_f64(
        if app_focus().map(|v| v["active"] == true).unwrap_or(false) {
            0.6
        } else {
            0.15
        },
    ));
    let settled = panes()?;
    let now_focus = settled
        .iter()
        .find(|(_, p)| p["focused"] == true)
        .map(|(id, _)| id.clone());
    if now_focus != focused {
        focused = now_focus;
        current = settled;
    }
    if current.values().any(|p| p["agent"] == "codex") {
        codex_sync()?;
    }
    if let Some(id) = focused.as_ref() {
        if let Some(p) = current.get(id) {
            if p["agent"] != "codex"
                && (attention(p["agent_status"].as_str().unwrap_or(""))
                    || p["agent_status"] == "working")
                && panes()?
                    .get(id)
                    .map(|p| p["focused"] == true)
                    .unwrap_or(false)
            {
                set_voice(p, true, &mut state)?;
            }
        }
    }
    for (id, p) in &current {
        if Some(id) != focused.as_ref() && p["agent"] == "claude" {
            set_voice(p, false, &mut state)?;
        }
    }
    state["queue"] = json!(queue);
    write_json(&path, &state)
}
pub fn attention(s: &str) -> bool {
    ["done", "blocked", "idle"].contains(&s)
}
/// Retained explicit startup helper. The normal focus actor does not call it;
/// only a fresh sidebar heartbeat may request startup of an observed empty CLI.
pub fn prepare_app_codex() -> Result<()> {
    let Some(value) = app_focus() else {
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
    let text = screen(&id)?;
    if text.contains("/voice stop")
        || text.contains("voice ")
        || !composer(&text, "›").is_empty()
        || !text.contains("for shortcuts")
        || !text.lines().any(|s| s.trim_start().starts_with('›'))
    {
        return Ok(());
    }
    let _ = output(&hc(), &["send", terminal, "/voice"], 2.);
    let deadline = now() + 6.;
    while now() < deadline {
        let fresh = app_focus();
        if fresh
            .as_ref()
            .map(|v| v["active"] != true || v["terminal"] != terminal)
            .unwrap_or(true)
        {
            return Ok(());
        }
        let screen = screen(&id)?;
        if screen.contains("/voice stop") || screen.contains("voice ") {
            log(&format!("app codex voice connected {id}"));
            return Ok(());
        }
        thread::sleep(Duration::from_millis(200));
    }
    log(&format!("app codex voice startup unconfirmed {id}"));
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
