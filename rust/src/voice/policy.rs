use super::{alive, append_json, mtime, now, settings, Result};
use serde_json::Value;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

pub fn segments(path: &Path, lines: usize) -> Vec<Value> {
    let Ok(text) = fs::read_to_string(path) else {
        return vec![];
    };
    let all: Vec<_> = text.lines().collect();
    all[all.len().saturating_sub(lines)..]
        .iter()
        .map(|l| serde_json::from_str(l))
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap_or_default()
}
fn overlap(item: &Value, start: f64, end: f64) -> f64 {
    (item["end"].as_f64().unwrap_or(0.0).min(end)
        - item["start"].as_f64().unwrap_or(0.0).max(start))
    .max(0.0)
}
pub fn heard(segments: &[Value], start: f64, end: f64, short: f64) -> (f64, f64) {
    let (mut mine, mut others) = (0., 0.);
    for item in segments {
        let seconds = overlap(item, start, end);
        if item["me"] == true
            || (item["me"].is_null() && item["score"].as_f64().unwrap_or(0.) >= short)
        {
            mine += seconds;
        } else if item["me"] == false {
            others += seconds;
        }
    }
    (mine, others)
}
pub fn mean_score(segments: &[Value], start: f64, end: f64, short: f64) -> f64 {
    let (mut weighted, mut total) = (0., 0.);
    for item in segments {
        let seconds = overlap(item, start, end);
        if item["me"] != false && seconds > 0. {
            if let Some(score) = item["score"].as_f64() {
                if item["me"] == true || score >= short {
                    weighted += seconds * score;
                    total += seconds;
                }
            }
        }
    }
    if total > 0. {
        weighted / total
    } else {
        0.
    }
}
pub fn own_dictation(
    segments: &[Value],
    start: f64,
    end: f64,
    chars: usize,
    settings: &Value,
) -> bool {
    let short = settings["short_score"].as_f64().unwrap_or(0.5);
    let (mine, others) = heard(segments, start, end, short);
    mine > 0.
        && mine >= others
        && mine * settings["max_chars_per_second"].as_f64().unwrap_or(25.) >= chars as f64
        && mean_score(segments, start, end, short)
            >= settings["dictation_score"].as_f64().unwrap_or(0.5)
}
pub fn headset(name: &str, settings: &Value) -> bool {
    !name.is_empty()
        && settings["auto_send_devices"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .any(|d| name.to_lowercase().contains(&d.to_lowercase()))
            })
            .unwrap_or(false)
}
pub fn audio_devices() -> Option<Value> {
    super::output(
        "/usr/sbin/system_profiler",
        &["-json", "SPAudioDataType"],
        5.,
    )
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
}
pub fn devices(payload: &Value) -> Vec<&Value> {
    payload["SPAudioDataType"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|s| s["_items"].as_array().into_iter().flatten())
        .collect()
}
pub fn default_input() -> String {
    audio_devices()
        .map(|v| {
            devices(&v)
                .into_iter()
                .find(|d| d["coreaudio_default_audio_input_device"] == "spaudio_yes")
                .and_then(|d| d["_name"].as_str())
                .unwrap_or("")
                .to_owned()
        })
        .unwrap_or_default()
}
pub fn builtin_input() -> bool {
    audio_devices()
        .map(|v| {
            devices(&v)
                .into_iter()
                .find(|d| d["coreaudio_default_audio_input_device"] == "spaudio_yes")
                .map(|d| {
                    d["coreaudio_device_transport"].is_null()
                        || d["coreaudio_device_transport"] == "coreaudio_device_type_builtin"
                })
                .unwrap_or(true)
        })
        .unwrap_or(true)
}
pub fn marker(dir: &Path, prefix: &str, pane: &str) -> PathBuf {
    dir.join(format!("{}-{}", prefix, pane.replace(':', "_")))
}
#[cfg(target_os = "macos")]
pub fn seconds_since_key() -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event: u32) -> f64;
    }
    unsafe { CGEventSourceSecondsSinceLastEventType(1, 10) }
}
#[cfg(not(target_os = "macos"))]
pub fn seconds_since_key() -> f64 {
    0.
}
pub struct Decision<'a> {
    pub prompt: &'a str,
    pub pane: &'a str,
    pub now: f64,
    pub keys: f64,
    pub segments: &'a [Value],
    pub armed: Option<f64>,
    pub learned: bool,
    pub running: bool,
    pub headset: bool,
}
pub fn decide(d: &Decision<'_>, settings: &Value) -> Option<String> {
    let Some(armed) = d.armed else { return None };
    if d.pane.is_empty()
        || d.now - armed > 130.
        || d.keys < 1.
        || d.prompt.contains("<hc from=")
        || d.prompt.trim_start().starts_with('/')
    {
        return None;
    }
    let count = d.prompt.chars().count();
    if !d.running {
        return Some(format!(
            "목소리 판정기가 꺼져 있어 받아쓰기를 전송하지 않았습니다 ({count}자)"
        ));
    }
    if !d.headset {
        return Some(format!(
            "헤드셋이 아닌 마이크라 받아쓰기를 자동 전송하지 않았습니다 ({count}자)"
        ));
    }
    if !d.learned {
        return Some(format!(
            "이 마이크의 목소리 학습이 없어 받아쓰기를 전송하지 않았습니다 ({count}자)"
        ));
    }
    if own_dictation(d.segments, armed - 1., d.now + 1., count, settings) {
        return None;
    }
    let (mine, others) = heard(
        d.segments,
        armed - 1.,
        d.now + 1.,
        settings["short_score"].as_f64().unwrap_or(0.5),
    );
    Some(format!("본인 목소리로 확인되지 않아 전송하지 않았습니다 ({count}자, 본인 {mine:.1}초, 다른 목소리 {others:.1}초)"))
}
pub fn submit_hook() -> Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let payload: Value = serde_json::from_str(&input)?;
    let prompt = payload["prompt"].as_str().unwrap_or("");
    let pane = std::env::var("HERDR_PANE_ID").unwrap_or_default();
    let dir = settings::state_dir();
    let armed = mtime(&marker(&dir, "armed", &pane));
    let learned = dir.join("voiceprint.json").exists();
    let running = alive(&dir.join("voicegate.pid"));
    let settings = settings::load();
    let headset = armed.is_some() && headset(&default_input(), &settings);
    let keys = seconds_since_key();
    submit_to(
        prompt,
        &pane,
        &dir,
        &HookObservation {
            armed,
            learned,
            running,
            headset,
            keys,
        },
        &settings,
        now,
        || thread::sleep(Duration::from_secs_f64(0.6)),
        &mut io::stderr(),
    )
}
pub struct HookObservation {
    pub armed: Option<f64>,
    pub learned: bool,
    pub running: bool,
    pub headset: bool,
    pub keys: f64,
}
pub fn submit_to<C: FnMut() -> f64, S: FnMut(), W: Write>(
    prompt: &str,
    pane: &str,
    dir: &Path,
    observed: &HookObservation,
    settings: &Value,
    mut clock: C,
    mut settle: S,
    stderr: &mut W,
) -> Result<()> {
    let mut reason = None;
    for attempt in 0..2 {
        if attempt == 1 {
            settle();
        }
        reason = decide(
            &Decision {
                prompt,
                pane,
                now: clock(),
                keys: observed.keys,
                segments: &segments(&dir.join("voice-segments.jsonl"), 200),
                armed: observed.armed,
                learned: observed.learned,
                running: observed.running,
                headset: observed.headset,
            },
            settings,
        );
        if reason.is_none() {
            return Ok(());
        }
    }
    fs::create_dir_all(dir)?;
    append_json(
        &dir.join("voice-blocked.jsonl"),
        &serde_json::json!({"time":super::round(clock(),3),"pane":pane,"text":prompt}),
    )?;
    fs::write(marker(dir, "blocked", pane), "")?;
    writeln!(stderr, "{}", reason.unwrap())?;
    Err(super::Exit(2).into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn submit_refusal_preserves_stderr_exit_and_machine_local_evidence() {
        let sandbox = tempfile::tempdir().unwrap();
        let mut stderr = vec![];
        let mut settled = 0;
        let result = submit_to(
            "타인의 말",
            "fixture:pane-one",
            sandbox.path(),
            &HookObservation {
                armed: Some(990.),
                learned: true,
                running: true,
                headset: true,
                keys: 30.,
            },
            &settings::defaults(),
            || 1000.,
            || settled += 1,
            &mut stderr,
        );
        let error = result.unwrap_err();
        assert_eq!(error.downcast_ref::<super::super::Exit>().unwrap().0, 2);
        assert_eq!(settled, 1);
        assert_eq!(String::from_utf8(stderr).unwrap(),"본인 목소리로 확인되지 않아 전송하지 않았습니다 (5자, 본인 0.0초, 다른 목소리 0.0초)\n");
        assert_eq!(
            fs::read(sandbox.path().join("blocked-fixture_pane-one")).unwrap(),
            b""
        );
        let text = fs::read_to_string(sandbox.path().join("voice-blocked.jsonl")).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(text.trim()).unwrap(),
            json!({"time":1000.,"pane":"fixture:pane-one","text":"타인의 말"})
        );
        assert_eq!(fs::read_dir(sandbox.path()).unwrap().count(), 2);
    }
    #[test]
    fn late_segment_is_reloaded_once_before_refusal() {
        let sandbox = tempfile::tempdir().unwrap();
        let path = sandbox.path().join("voice-segments.jsonl");
        let mut stderr = vec![];
        let result = submit_to(
            "내 말",
            "p",
            sandbox.path(),
            &HookObservation {
                armed: Some(990.),
                learned: true,
                running: true,
                headset: true,
                keys: 30.,
            },
            &settings::defaults(),
            || 1000.,
            || {
                fs::write(
                    &path,
                    "{\"start\":992,\"end\":998,\"seconds\":6,\"score\":0.7,\"me\":true}\n",
                )
                .unwrap()
            },
            &mut stderr,
        );
        assert!(result.is_ok());
        assert!(stderr.is_empty());
        assert_eq!(fs::read_dir(sandbox.path()).unwrap().count(), 1);
    }
    fn s(a: f64, b: f64, me: Value, score: f64) -> Value {
        json!({"start":a,"end":b,"me":me,"score":score})
    }
    #[test]
    fn speech_must_explain_current_text() {
        let cfg = settings::defaults();
        assert!(own_dictation(
            &[s(100., 106., json!(true), 0.7)],
            99.,
            110.,
            40,
            &cfg
        ));
        assert!(!own_dictation(&[], 99., 110., 16, &cfg));
        assert!(!own_dictation(
            &[s(60., 70., json!(true), 0.7)],
            95.,
            100.,
            16,
            &cfg
        ));
        assert!(!own_dictation(
            &[s(100., 101.5, json!(true), 0.7)],
            99.,
            125.,
            120,
            &cfg
        ));
        assert!(!own_dictation(
            &[
                s(100., 102., json!(true), 0.7),
                s(102., 108., json!(false), 0.)
            ],
            99.,
            110.,
            20,
            &cfg
        ));
        assert!(own_dictation(
            &[s(100., 100.6, Value::Null, 0.6)],
            99.,
            102.,
            3,
            &cfg
        ));
        assert!(!own_dictation(
            &[s(100., 100.6, Value::Null, 0.1)],
            99.,
            102.,
            3,
            &cfg
        ));
    }
    #[test]
    fn keyboard_hc_and_slash_pass_closed_gate() {
        let cfg = settings::defaults();
        for (prompt, keys) in [
            ("typing", 0.2),
            ("<hc from=\"fixture-agent\">work</hc>", 30.),
            ("/compact", 30.),
        ] {
            assert!(decide(
                &Decision {
                    prompt,
                    pane: "p",
                    now: 1000.,
                    keys,
                    segments: &[],
                    armed: Some(990.),
                    learned: false,
                    running: false,
                    headset: false
                },
                &cfg
            )
            .is_none());
        }
    }
}
