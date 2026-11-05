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
        println!("{}", settings_scene(scene)?);
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
        println!("{}", json!(results));
    } else {
        println!(
            "{}",
            evaluate(request["op"].as_str().unwrap_or(""), &request["args"])?
        );
    }
    Ok(())
}
pub fn settings_scene(scene: usize) -> Result<bool> {
    if scene > 8 {
        return Err("settings scene must be 0..8".into());
    }
    let mut failure = json!(null);
    let mut recording = false;
    let mut busy = 0;
    let mut mode = "tap";
    let mut stamp = 100.;
    let mut notice = false;
    fn focus(
        failure: &mut Value,
        recording: &mut bool,
        busy: &mut usize,
        mode: &str,
        stamp: f64,
        notice: bool,
    ) {
        if *recording {
            *failure = Value::Null;
            return;
        }
        if queue::voice_key_locked(failure, stamp) && !notice {
            return;
        }
        if *busy > 0 {
            *busy -= 1;
        } else if mode == "tap" {
            *recording = !*recording;
        }
        if *recording {
            *failure = Value::Null;
        } else {
            let misses = if failure.is_array() {
                failure[0].as_u64().unwrap_or(0)
            } else {
                failure.as_u64().unwrap_or(0)
            };
            *failure = json!([misses + 1, stamp]);
        }
    }
    if (1..=6).contains(&scene) || scene == 8 {
        mode = if [1, 2, 3, 8].contains(&scene) {
            "off"
        } else {
            "tap"
        };
        if [4, 5, 6].contains(&scene) {
            busy = 2;
        }
        focus(&mut failure, &mut recording, &mut busy, mode, stamp, false);
        focus(&mut failure, &mut recording, &mut busy, mode, stamp, false);
    }
    match scene {
        1 => {
            mode = "tap";
            notice = true;
        }
        2 | 3 => mode = "tap",
        5 => {
            recording = true;
            focus(&mut failure, &mut recording, &mut busy, mode, stamp, false);
            recording = false;
        }
        6 => failure = Value::Null,
        7 | 8 => mode = "hold",
        _ => {}
    }
    if [3, 4, 8].contains(&scene) {
        stamp += 61.;
    }
    focus(&mut failure, &mut recording, &mut busy, mode, stamp, notice);
    Ok(recording)
}
#[cfg(test)]
mod tests {
    use super::*;
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
