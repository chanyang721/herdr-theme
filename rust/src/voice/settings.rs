use super::Result;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn home() -> PathBuf {
    crate::common::home()
}
pub fn app_home() -> PathBuf {
    env::var_os("HERDR_APP_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config/herdr-app"))
}
pub fn state_dir() -> PathBuf {
    env::var_os("HERDR_PLUGIN_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/state/herdr/plugins/local.focus-queue"))
}
pub fn voice_home() -> PathBuf {
    home().join(".local/share/herdr-focus-queue")
}
pub fn path() -> PathBuf {
    env::var_os("HERDR_VOICE_SETTINGS")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_home().join("data/sixfold/voice.local.json"))
}
pub fn defaults() -> Value {
    json!({"auto_send_devices":[],"devices":{},"max_chars_per_second":25,"short_score":0.5,"dictation_score":0.5,"default_threshold":0.4,"max_threshold":0.5,"pool_score":0.5,"vad_threshold":0.35,"vad_gain":10.0})
}
pub fn read_file(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}
pub fn read() -> Value {
    read_file(&path())
}
fn repr(v: &Value) -> String {
    match v {
        Value::String(s) => format!(
            "'{}'",
            s.replace('\\', "\\\\")
                .replace('\'', "\\'")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
                .replace('\t', "\\t")
        ),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", repr(&json!(k)), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        v => v.to_string(),
    }
}
pub fn merge(raw: &Value) -> Value {
    let mut merged = defaults();
    if let Some(raw) = raw.as_object() {
        for (key, value) in raw {
            let Some(default) = merged.get(key) else {
                continue;
            };
            let selected = if default.is_array() && value.is_array() {
                Some(Value::Array(
                    value
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            Value::Bool(true) => "True".into(),
                            Value::Bool(false) => "False".into(),
                            Value::Null => "None".into(),
                            v => repr(v),
                        })
                        .filter(|s| !s.trim().is_empty())
                        .map(Value::String)
                        .collect(),
                ))
            } else if default.is_object() && value.is_object() {
                Some(Value::Object(
                    value
                        .as_object()
                        .unwrap()
                        .iter()
                        .filter(|(_, v)| v.is_object())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect(),
                ))
            } else if default.is_number() && value.is_number() {
                Some(value.clone())
            } else {
                None
            };
            if let Some(v) = selected {
                merged[key] = v;
            }
        }
    }
    merged
}
pub fn load() -> Value {
    merge(&read())
}
pub fn update<F: FnOnce(&mut Value)>(change: F) -> Result<Value> {
    let mut data = read();
    change(&mut data);
    let target = path();
    let parent = target.parent().ok_or("voice settings path lacks parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".voice.local-")
        .tempfile_in(parent)?;
    use std::io::Write;
    serde_json::to_writer_pretty(&mut temporary, &data)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist(&target)?;
    Ok(data)
}
pub fn device_key(name: &str) -> String {
    regex::Regex::new(r"[^\p{L}\p{N}_]+")
        .unwrap()
        .replace_all(name, "-")
        .trim_matches('-')
        .to_lowercase()
}
pub fn device_threshold(key: &str) -> Option<f64> {
    load()["devices"][key]["threshold"].as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overrides_are_typed_and_unknown_ignored() {
        let got = merge(
            &json!({"vad_gain":"loud","dictation_score":true,"devices":{"x":3,"y":{"threshold":0.45}},"unknown":1}),
        );
        assert_eq!(got["vad_gain"], 10.0);
        assert_eq!(got["dictation_score"], 0.5);
        assert_eq!(got["devices"], json!({"y":{"threshold":0.45}}));
        assert!(got.get("unknown").is_none());
    }
    #[test]
    fn microphone_keys_keep_unicode() {
        assert_eq!(device_key("Example Headset (2)"), "example-headset-2");
        assert_eq!(device_key("내 마이크"), "내-마이크");
    }
}
