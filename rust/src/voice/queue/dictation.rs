//! The production dictation transitions with explicit clock and pane I/O.
//! These are the same boundaries mocked by the original Python voice tests.
use super::*;

#[derive(Clone, Copy)]
pub struct Timing {
    pub end_pause: f64,
    pub discard: f64,
    pub settle: f64,
    pub finish: f64,
    pub leave_judge: f64,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            end_pause: 2.,
            discard: 3.,
            settle: 1.,
            finish: 5.,
            leave_judge: 3.,
        }
    }
}
pub trait Backend {
    fn clock(&self) -> f64 {
        now()
    }
    fn pause(&mut self, seconds: f64) {
        thread::sleep(Duration::from_secs_f64(seconds));
    }
    fn pane(&mut self, id: &str) -> Result<Value> {
        Ok(panes()?.remove(id).unwrap_or(Value::Null))
    }
    fn screen(&mut self, id: &str) -> Result<String> {
        super::screen(id)
    }
    fn composer(&self, text: &str) -> String {
        super::composer(text, "❯")
    }
    fn recording_footer(&self, text: &str) -> bool {
        super::footer(text, "❯").contains("REC · ")
    }
    fn level(&self, text: &str) -> usize {
        super::meter(text, "❯")
    }
    fn ready(&self, text: &str, draft: bool) -> bool {
        super::input_ready(text, "❯", draft)
    }
    fn speaker(&mut self, since: f64, until: Option<f64>) -> (&'static str, Option<f64>) {
        super::voice_state(since, until)
    }
    fn headset(&self) -> bool {
        super::headset()
    }
    fn front(&mut self) -> Result<bool> {
        super::user_in_herdr()
    }
    fn key_seconds(&self) -> f64 {
        policy::seconds_since_key()
    }
    fn last_heard(&self) -> f64 {
        mtime(&settings::state_dir().join("voice-speaking")).unwrap_or(0.)
    }
    fn gate_running(&self) -> bool {
        alive(&settings::state_dir().join("voicegate.pid"))
    }
    fn start_gate(&mut self) -> Result<()> {
        super::start_gate()
    }
    fn read_kept(&self, id: &str) -> (String, bool) {
        super::read_kept(id)
    }
    fn write_kept(&mut self, id: &str, text: &str, spoken: bool) -> Result<()> {
        super::write_kept(id, text, spoken)
    }
    fn blocked_at(&self, id: &str) -> Option<f64> {
        mtime(&policy::marker(&settings::state_dir(), "blocked", id))
    }
    fn remove_blocked(&mut self, id: &str) -> Result<()> {
        fs::remove_file(policy::marker(&settings::state_dir(), "blocked", id))?;
        Ok(())
    }
    fn armed(&mut self, id: &str) -> Result<()> {
        fs::write(policy::marker(&settings::state_dir(), "armed", id), "")?;
        Ok(())
    }
    fn recording_since(&self, id: &str) -> f64 {
        super::recording_since(id)
    }
    fn recent_active(&self, id: &str) -> bool {
        super::recently_active(id)
    }
    fn mark_active(&mut self, id: &str) -> Result<()> {
        fs::write(super::active_path(id), "")?;
        Ok(())
    }
    fn keys(&mut self, id: &str, keys: &[&str]) -> Result<()> {
        super::send_keys(id, keys)
    }
    fn type_text(&mut self, id: &str, text: &str) -> Result<bool> {
        output_unchecked(&herdr(), &["pane", "send-text", id, text], 10.)?;
        Ok(true)
    }
    fn confirm(&mut self, since: Option<f64>) -> Result<()> {
        super::confirm_voice(since)
    }
    fn advance(&mut self) -> Result<()> {
        super::main_event(true)
    }
    fn restore(&mut self, id: &str, before: &str, speaker: &str, t: Timing) -> Result<()>
    where
        Self: Sized,
    {
        restore_box(id, before, speaker, self, t)
    }
    fn report(&mut self, message: &str) {
        super::log(message)
    }
    fn recording(&mut self, id: &str) -> Result<bool> {
        let text = self.screen(id)?;
        Ok(self.recording_footer(&text))
    }
    fn press(&mut self, id: &str, key: &str, on: bool, seconds: f64) -> Result<bool>
    where
        Self: Sized,
    {
        press_with(self, id, key, on, seconds)
    }
}
pub fn press_with<B: Backend>(
    b: &mut B,
    id: &str,
    key: &str,
    on: bool,
    seconds: f64,
) -> Result<bool> {
    b.keys(id, &[key])?;
    let deadline = b.clock() + seconds;
    while b.clock() < deadline {
        b.pause(0.05);
        if b.recording(id)? == on {
            return Ok(true);
        }
    }
    Ok(false)
}
pub struct Runtime;
impl Backend for Runtime {}
fn box_text<B: Backend>(b: &mut B, id: &str) -> Result<String> {
    let text = b.screen(id)?;
    Ok(b.composer(&text))
}
fn may_send<B: Backend>(b: &B, speaker: &str) -> bool {
    speaker == "me" && b.headset()
}
pub fn stop_key(typed: &str, status: &str, speaker: &str, headset: bool) -> &'static str {
    if !typed.is_empty() {
        if speaker == "me" && headset {
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
fn erase<B: Backend>(b: &mut B, id: &str, count: usize) -> Result<()> {
    if count > 0 {
        b.keys(id, &vec!["backspace"; count])?;
    }
    Ok(())
}
pub fn clear_blocked<B: Backend>(id: &str, b: &mut B) -> Result<bool> {
    let Some(at) = b.blocked_at(id) else {
        return Ok(false);
    };
    let text = box_text(b, id)?;
    if !text.is_empty() && b.clock() - at < 5. {
        erase(b, id, text.chars().count())?;
        b.report(&format!(
            "claude dictation refused {id} ({} chars)",
            text.chars().count()
        ));
    }
    if !text.is_empty() || b.clock() - at >= 5. {
        b.remove_blocked(id)?;
    }
    Ok(true)
}
pub fn restore_box<B: Backend>(
    id: &str,
    before: &str,
    speaker: &str,
    b: &mut B,
    t: Timing,
) -> Result<()> {
    let keep = if speaker == "other" {
        b.read_kept(id).0
    } else {
        before.to_owned()
    };
    if keep.is_empty() {
        return Ok(());
    }
    b.pause(t.settle);
    let current = box_text(b, id)?;
    if current == keep {
        return Ok(());
    }
    if id.starts_with("app:") {
        b.report(&format!(
            "claude dictation lost {id}: cannot type into app panes ({} chars)",
            keep.chars().count()
        ));
        return Ok(());
    }
    erase(b, id, current.chars().count())?;
    if b.type_text(id, &keep)? {
        b.write_kept(id, &keep, true)?;
    }
    b.report(&format!(
        "claude dictation kept {id} after its recording stopped ({} chars, {speaker} voice)",
        keep.chars().count()
    ));
    Ok(())
}
pub fn voice_off<B: Backend>(pane: &Value, state: &mut Value, b: &mut B, t: Timing) -> Result<()> {
    let id = pane["pane_id"].as_str().unwrap_or("");
    let text = b.screen(id)?;
    if !b.recording_footer(&text) {
        return Ok(());
    }
    if !state["voice_key_failures"].is_object() {
        state["voice_key_failures"] = json!({});
    }
    let before = b.composer(&text);
    let mut speaker = "unknown";
    if !before.is_empty() {
        let left = b.clock();
        loop {
            speaker = b.speaker(b.recording_since(id), Some(left)).0;
            if speaker != "unknown" || b.clock() >= left + t.leave_judge {
                break;
            }
            b.pause(0.3);
        }
    }
    let mut key = stop_key(
        &before,
        pane["agent_status"].as_str().unwrap_or(""),
        speaker,
        b.headset(),
    );
    if key == "f8" && !before.is_empty() && !id.starts_with("app:") && box_text(b, id)? != before {
        key = "esc";
    }
    let flipped = b.press(id, key, false, 1.5)?;
    b.report(&format!(
        "claude voice off {id}{}",
        if flipped { "" } else { " (no change)" }
    ));
    if key == "esc" && !before.is_empty() {
        b.restore(id, &before, speaker, t)?;
    }
    Ok(())
}
fn finish_dictation<B: Backend>(
    id: &str,
    spoken: Option<f64>,
    mut since: f64,
    b: &mut B,
    t: Timing,
) -> Result<()> {
    let (speaker, end) = b.speaker(spoken.unwrap_or(0.), None);
    let heard = end.unwrap_or(0.).max(b.last_heard());
    let mut typed = String::new();
    let deadline = b.clock() + t.finish;
    while b.clock() < deadline {
        b.pause(0.3);
        let text = box_text(b, id)?;
        if text.is_empty() {
            continue;
        }
        if text != typed {
            typed = text;
            since = b.clock();
        }
        if may_send(b, speaker)
            && sentence_end(&typed)
            && b.clock() - since.max(heard) >= t.end_pause
        {
            b.keys(id, &["enter"])?;
            b.confirm(spoken)?;
            b.report(&format!(
                "claude dictation sent {id} after focus left ({} chars, {speaker} voice)",
                typed.chars().count()
            ));
            return Ok(());
        }
    }
    Ok(())
}

pub fn listen_with<B: Backend>(id: &str, b: &mut B, t: Timing) -> Result<()> {
    let (mut last, mut since, mut started, mut misses, mut engaged) =
        (None::<String>, b.clock(), None::<f64>, 0, false);
    let mut spoken_since = None;
    let mut dictated = false;
    let (mut kept, mut spoken) = b.read_kept(id);
    if !kept.is_empty() && !box_text(b, id)?.starts_with(&kept) {
        b.write_kept(id, "", false)?;
        kept.clear();
        spoken = false;
    }
    let mut gate_checked = 0.;
    while misses < 6 {
        b.pause(0.3);
        let pane = b.pane(id)?;
        if pane["focused"] != true || pane["agent"] != "claude" {
            if pane["agent"] == "claude"
                && last.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                && dictated
            {
                finish_dictation(id, spoken_since, since, b, t)?;
                last = None;
                started = None;
                spoken_since = None;
                dictated = false;
                if b.pane(id)?["focused"] == true {
                    continue;
                }
            }
            return Ok(());
        }
        if clear_blocked(id, b)? {
            last = None;
            started = None;
            spoken_since = None;
            dictated = false;
            continue;
        }
        if b.clock() - gate_checked >= 5. {
            gate_checked = b.clock();
            if !b.gate_running() {
                b.start_gate()?;
            }
        }
        let text = b.screen(id)?;
        let in_box = b.composer(&text);
        let hand = !in_box.is_empty() && b.key_seconds() < 1.5;
        if in_box.is_empty() {
            if !kept.is_empty() {
                b.write_kept(id, "", false)?;
            }
            kept.clear();
            spoken = false;
        } else if (hand || !in_box.starts_with(&kept)) && in_box != kept {
            spoken = spoken || dictated;
            kept = in_box.clone();
            b.write_kept(id, &kept, spoken)?;
        }
        let fresh = in_box.strip_prefix(&kept).unwrap_or(&in_box);
        if fresh.is_empty() {
            dictated = false;
        }
        let headset = b.headset();
        if !headset || !b.front()? {
            if b.recording_footer(&text) && kept.is_empty() {
                let speaker = b.speaker(b.recording_since(id), None).0;
                b.press(
                    id,
                    stop_key(
                        &b.composer(&text),
                        pane["agent_status"].as_str().unwrap_or(""),
                        speaker,
                        b.headset(),
                    ),
                    false,
                    1.5,
                )?;
                b.report(&format!(
                    "claude voice paused {id}: {}",
                    if headset {
                        "another app is in front"
                    } else {
                        "input is not a headset"
                    }
                ));
            }
            if box_text(b, id)?.is_empty() {
                last = None;
                started = None;
                spoken_since = None;
                dictated = false;
            }
            continue;
        }
        if !b.recording_footer(&text) {
            let typed = b.composer(&text);
            if dictated && !typed.is_empty() {
                if last.as_deref() != Some(&typed) {
                    last = Some(typed.clone());
                    since = b.clock();
                }
                if b.clock() - since < t.settle {
                    continue;
                }
                let speaker = spoken_since
                    .map(|at| b.speaker(at, None).0)
                    .unwrap_or("unknown");
                if may_send(b, speaker) {
                    b.keys(id, &["enter"])?;
                    b.confirm(spoken_since)?;
                    b.report(&format!("claude dictation sent {id} after recording ended ({} chars, {speaker} voice)",typed.chars().count()));
                } else {
                    erase(
                        b,
                        id,
                        typed.chars().count().saturating_sub(kept.chars().count()),
                    )?;
                    b.report(&format!("claude dictation discarded {id} after recording ended ({} chars, {speaker} voice)",typed.chars().count().saturating_sub(kept.chars().count())));
                }
                last = None;
                started = None;
                spoken_since = None;
                dictated = false;
                continue;
            }
            if last.as_ref().map(|s| !s.is_empty()).unwrap_or(false) && dictated && typed.is_empty()
            {
                b.confirm(spoken_since)?;
                b.report(&format!("claude dictation submitted by user {id}"));
            }
            last = None;
            started = None;
            spoken_since = None;
            dictated = false;
            let draft =
                spoken && !kept.is_empty() && b.key_seconds() >= 1.5 && b.ready(&text, true);
            if ["done", "idle", "working"].contains(&pane["agent_status"].as_str().unwrap_or(""))
                && (b.ready(&text, false) || draft)
            {
                let on = b.press(id, "f8", true, 1.)?;
                misses = if on { 0 } else { misses + 1 };
                b.report(&format!(
                    "claude voice re-armed {id}{}",
                    if on { "" } else { " (no change)" }
                ));
            }
            continue;
        }
        if started.is_none() {
            started = Some(b.clock());
            b.armed(id)?;
        }
        let typed = b.composer(&text);
        if last.as_ref().map(|s| !s.is_empty()).unwrap_or(false) && dictated && typed.is_empty() {
            b.confirm(spoken_since)?;
            b.report(&format!("claude dictation submitted by user {id}"));
        }
        dictated = !fresh.is_empty() && !hand && (dictated || b.level(&text) > 1);
        if fresh.is_empty() {
            spoken_since = None;
        } else if spoken_since.is_none() {
            spoken_since = Some(b.clock() - 2.);
        }
        let (speaker, speech_end) = spoken_since
            .map(|at| b.speaker(at, None))
            .unwrap_or(("unknown", None));
        let current_engaged =
            (!typed.is_empty() || b.level(&text) > 1 || b.recent_active(id)) && speaker != "other";
        if engaged && !current_engaged {
            b.advance()?;
        }
        engaged = current_engaged;
        if (last.as_deref() != Some(&typed) || b.level(&text) > 1)
            && (!typed.is_empty() || b.level(&text) > 1)
            && speaker != "other"
        {
            b.mark_active(id)?;
        }
        let heard = speech_end.unwrap_or(0.).max(b.last_heard());
        if last.as_deref() != Some(&typed) {
            last = Some(typed.clone());
            since = b.clock();
        } else if dictated
            && may_send(b, speaker)
            && sentence_end(&typed)
            && b.clock() - since.max(heard) >= t.end_pause
        {
            b.keys(id, &["enter"])?;
            b.confirm(spoken_since)?;
            b.report(&format!(
                "claude dictation sent {id} ({} chars, {speaker} voice)",
                typed.chars().count()
            ));
            last = None;
        } else if dictated && !may_send(b, speaker) && b.clock() - since.max(heard) >= t.discard {
            if kept.is_empty() {
                b.press(id, "esc", false, 1.5)?;
            }
            let count = box_text(b, id)?
                .chars()
                .count()
                .saturating_sub(kept.chars().count());
            erase(b, id, count)?;
            b.report(&format!(
                "claude dictation discarded {id} ({} chars, {speaker} voice)",
                typed.chars().count().saturating_sub(kept.chars().count())
            ));
            last = None;
        } else if typed.is_empty()
            && b.clock() - started.unwrap_or(b.clock()) >= 100.
            && ["idle", "done"].contains(&pane["agent_status"].as_str().unwrap_or(""))
        {
            b.press(id, "esc", false, 1.5)?;
            b.report(&format!("claude voice recycled {id}"));
        }
    }
    b.report(&format!("claude voice stopped re-arming {id}: F8 ignored"));
    Ok(())
}
