//! Deterministic public test surface used by frozen baseline fixtures and the
//! offline settings diagnostic. It never opens devices or sends pane input.
use super::{gate, policy, queue, recovery, settings, Result};
use serde_json::{json, Value};
use std::io::{self, Read};
fn number(v: &Value, key: &str, default: f64) -> f64 {
    v[key].as_f64().unwrap_or(default)
}
pub fn evaluate(op: &str, a: &Value) -> Result<Value> {
    let cfg = settings::defaults();
    Ok(match op {
        "iso-timestamp" => {
            json!({"timestamp_bits":format!("{:016x}",super::iso::timestamp(a["text"].as_str().ok_or("missing ISO text")?)?.to_bits())})
        }
        "decode-audio" => json!(super::audio::decode(&std::fs::read(
            a["audio"].as_str().ok_or("audio probe path missing")?
        )?)?),
        "dataset" => super::evaluate::dataset_probe(std::path::Path::new(
            a["data_dir"]
                .as_str()
                .ok_or("dataset probe directory missing")?,
        ))?,
        "dsp" => super::evaluate::dsp_probe(a)?,
        "settings" => settings::merge(a),
        "device-key" => json!(settings::device_key(a["name"].as_str().unwrap_or(""))),
        "screen" => {
            let text = a["text"].as_str().unwrap_or("");
            let prompt = a["prompt"].as_str().unwrap_or("❯");
            json!({"plain":queue::plain(text),"footer":queue::footer(text,prompt),"composer":queue::composer(text,prompt),"meter":queue::meter(text,prompt),"ready":queue::input_ready(text,prompt,false),"draft":queue::input_ready(text,prompt,true)})
        }
        "event" => queue::find_event(a).unwrap_or(Value::Null),
        "project" => {
            let current = a["current"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            json!(queue::project(current, a.get("value")))
        }
        "device-signature" => {
            recovery::device_signature(&a["payload"], a.get("selection").filter(|v| !v.is_null()))
                .unwrap_or(Value::Null)
        }
        "policy" => {
            let segments = a["segments"].as_array().cloned().unwrap_or_default();
            let start = number(a, "start", 0.);
            let end = number(a, "end", 0.);
            let short = number(&cfg, "short_score", 0.5);
            json!({"heard":policy::heard(&segments,start,end,short),"mean":policy::mean_score(&segments,start,end,short),"own":policy::own_dictation(&segments,start,end,a["chars"].as_u64().unwrap_or(0)as usize,&cfg)})
        }
        "hook" => json!(policy::decide(
            &policy::Decision {
                prompt: a["prompt"].as_str().unwrap_or(""),
                pane: a["pane"].as_str().unwrap_or(""),
                now: number(a, "now", 0.),
                keys: number(a, "keys", 0.),
                segments: a["segments"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                armed: a["armed"].as_f64(),
                learned: a["learned"] == true,
                running: a["running"] == true,
                headset: a["headset"] == true
            },
            &cfg
        )),
        "failure-marker" => {
            let text = a["text"].as_str().unwrap_or("");
            json!({"marker":recovery::failure_marker(text),"manual_stop":recovery::manual_stop(text),"live":recovery::live(text)})
        }
        "eligible" => json!(recovery::eligible(
            &a["record"],
            a["text"].as_str().unwrap_or(""),
            a["focused"] == true,
            number(a, "now", 0.),
            a["device_ready"] == true
        )),
        "audio-selection" => {
            recovery::audio_selection(a["text"].as_str().unwrap_or("")).unwrap_or(Value::Null)
        }
        "build" => json!(gate::build(
            &a["vectors"]
                .as_array()
                .into_iter()
                .flatten()
                .map(gate::vector)
                .collect::<Vec<_>>(),
            &gate::vector(&a["weights"]),
            0.4
        )?),
        "threshold" => json!(gate::adapted_threshold(
            &gate::vector(&a["held"]),
            &a["previous"],
            &cfg
        )),
        "key-lock" => json!(queue::voice_key_locked(&a["failure"], number(a, "now", 0.))),
        "settings-scene" => json!(settings_scene(
            a["scene"].as_u64().ok_or("missing scene")? as usize
        )?),
        "judged" => {
            let seconds = number(a, "seconds", 0.);
            let score = number(a, "score", 0.);
            json!({"seconds":seconds,"score":score,"me":gate::judged(seconds,score,number(a,"threshold",0.4))})
        }
        _ => return Err(format!("unknown voice probe: {op}").into()),
    })
}
pub fn run(args: &[String]) -> Result<()> {
    if args.first().map(String::as_str) == Some("settings-scene") {
        let scene = args.get(1).ok_or("missing scene number")?.parse()?;
        let kind = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(0);
        let recording = if args.get(3).map(String::as_str) == Some("current-input") {
            settings_scene_current(scene, kind)?
        } else {
            settings_scene_with(scene, kind, true)?
        };
        crate::legacy_text::print_line(&recording.to_string())?;
        return Ok(());
    }
    let mut text = String::new();
    io::stdin().read_to_string(&mut text)?;
    let request: Value = serde_json::from_str(&text)?;
    if let Some(cases) = request.as_array() {
        let results = cases
            .iter()
            .map(|c| evaluate(c["op"].as_str().unwrap_or(""), &c["args"]))
            .collect::<Result<Vec<_>>>()?;
        voice_println!("{}", json!(results));
    } else {
        voice_println!(
            "{}",
            evaluate(request["op"].as_str().unwrap_or(""), &request["args"])?
        );
    }
    Ok(())
}
pub fn settings_scene(scene: usize) -> Result<bool> {
    return settings_scene_with(scene, 0, true);
}
pub fn settings_scene_with(scene: usize, kind: usize, eligible: bool) -> Result<bool> {
    settings_scene_policy(scene, kind, Some(eligible))
}
pub fn settings_scene_current(scene: usize, kind: usize) -> Result<bool> {
    settings_scene_policy(scene, kind, None)
}
fn settings_scene_policy(scene: usize, kind: usize, eligible: Option<bool>) -> Result<bool> {
    if scene > 8 || kind > 2 {
        return Err("invalid settings scene or pane kind".into());
    }
    struct Pane {
        mode: &'static str,
        recording: bool,
        busy: usize,
        text: String,
        session: String,
        stamp: f64,
        eligible: Option<bool>,
    }
    impl queue::VoiceOnBackend for Pane {
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
            Ok(self.session.clone())
        }
        fn ready(&mut self, _: &str) -> Result<bool> {
            Ok(true)
        }
        fn eligible(&mut self) -> Result<bool> {
            Ok(self
                .eligible
                .unwrap_or_else(|| policy::headset(&policy::default_input(), &settings::load())))
        }
        fn start(&mut self, _: &str) -> Result<()> {
            Ok(())
        }
        fn press_on(&mut self, _: &str) -> Result<bool> {
            if self.busy > 0 {
                self.busy -= 1;
            } else if self.mode == "tap" {
                self.recording = !self.recording;
            }
            Ok(self.recording)
        }
        fn clock(&self) -> f64 {
            self.stamp
        }
        fn report(&mut self, _: &str) {}
    }
    let base = std::collections::BTreeMap::from([(
        "w8:p12".into(),
        json!({"pane_id":"w8:p12","agent":"claude","agent_status":"idle","focused":kind==0}),
    )]);
    let (current, target) = match kind {
        0 => (base, "w8:p12"),
        1 => (
            queue::project(
                base,
                Some(&json!({"active":true,"terminal":"bridge","source":"w8:p12","panes":[]})),
            ),
            "w8:p12",
        ),
        _ => (
            queue::project(
                base,
                Some(
                    &json!({"active":true,"terminal":"native","panes":[{"pane_id":"app:native","agent":"claude","agent_status":"idle"}]}),
                ),
            ),
            "app:native",
        ),
    };
    let pane = &current[target];
    if pane["focused"] != true {
        return Err("settings diagnostic projection lost focus".into());
    }
    let mut fake = Pane {
        mode: "tap",
        recording: false,
        busy: 0,
        text: String::new(),
        session: "s1".into(),
        stamp: 100.,
        eligible,
    };
    let mut state = json!({});
    fn focus(pane: &Value, state: &mut Value, fake: &mut Pane) -> Result<bool> {
        queue::set_voice_on(pane, state, fake)?;
        Ok(fake.recording)
    }
    if (1..=6).contains(&scene) || scene == 8 {
        if [1, 2, 3, 8].contains(&scene) {
            fake.mode = "off";
        } else {
            fake.busy = 2;
        }
        focus(pane, &mut state, &mut fake)?;
        focus(pane, &mut state, &mut fake)?;
    }
    match scene {
        1 => {
            fake.mode = "tap";
            fake.text =
                "Voice mode enabled (tap). Tap f8 (with input empty) to start, tap again to send."
                    .into();
        }
        2 | 3 => fake.mode = "tap",
        5 => {
            fake.recording = true;
            focus(pane, &mut state, &mut fake)?;
            fake.recording = false;
        }
        6 => fake.session = "s2".into(),
        7 | 8 => fake.mode = "hold",
        _ => {}
    }
    if [3, 4, 8].contains(&scene) {
        if let Some(failures) = state["voice_key_failures"].as_object_mut() {
            for entry in failures.values_mut() {
                if entry.is_array() {
                    entry[1] = json!(entry[1].as_f64().unwrap_or(0.) - 61.);
                }
            }
        }
    }
    focus(pane, &mut state, &mut fake)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_scenes_use_all_real_projections_and_default_opt_out() {
        let corpus: Value = serde_json::from_str(include_str!("parity-fixtures.json")).unwrap();
        for case in corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["op"] == "settings-scene")
        {
            let scene = case["args"]["scene"].as_u64().unwrap() as usize;
            for kind in 0..3 {
                assert_eq!(
                    settings_scene_with(scene, kind, true).unwrap(),
                    case["expected"].as_bool().unwrap(),
                    "scene{scene} kind{kind}"
                );
                assert!(
                    !settings_scene_with(scene, kind, false).unwrap(),
                    "scene{scene} kind{kind}"
                );
            }
        }
    }
    fn close(a: &Value, b: &Value) -> bool {
        match (a, b) {
            (Value::Number(a), Value::Number(b)) => {
                (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() <= 1e-10
            }
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| close(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(k, a)| b.get(k).map(|b| close(a, b)).unwrap_or(false))
            }
            _ => a == b,
        }
    }
    #[test]
    fn original_python_contract_corpus() {
        let fixture: Value = serde_json::from_str(include_str!("parity-fixtures.json")).unwrap();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let got = evaluate(case["op"].as_str().unwrap(), &case["args"]).unwrap();
            assert!(
                close(&got, &case["expected"]),
                "case {index} op={} args={}\ngot={got}\nexpected={}",
                case["op"],
                case["args"],
                case["expected"]
            );
        }
    }
}
