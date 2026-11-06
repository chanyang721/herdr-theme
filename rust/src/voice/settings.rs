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
    path_for(
        env::var_os("HERDR_VOICE_SETTINGS")
            .as_deref()
            .map(Path::new),
        &app_home(),
    )
}
pub fn path_for(explicit: Option<&Path>, app: &Path) -> PathBuf {
    explicit
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_owned)
        .unwrap_or_else(|| app.join("data/sixfold/voice.local.json"))
}
pub fn defaults() -> Value {
    json!({"auto_send_devices":[],"devices":{},"max_chars_per_second":25,"short_score":0.5,"dictation_score":0.5,"default_threshold":0.4,"max_threshold":0.5,"pool_score":0.5,"vad_threshold":0.35,"vad_gain":10.0})
}
pub fn read_file(path: &Path) -> Value {
    crate::legacy_text::read(path, crate::legacy_text::ErrorPolicy::Strict)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}
pub fn read() -> Value {
    read_file(&path())
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
                            v => crate::automation::format::repr(v),
                        })
                        .filter(|s| !crate::python_unicode::trim(s).is_empty())
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
                value.as_f64().map(|number| json!(number))
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
    load_at(&path())
}
pub fn load_at(path: &Path) -> Value {
    merge(&read_file(path))
}
pub fn update<F: FnOnce(&mut Value)>(change: F) -> Result<Value> {
    update_at(&path(), change)
}
pub fn update_at<F: FnOnce(&mut Value)>(target: &Path, change: F) -> Result<Value> {
    let mut data = read_file(target);
    change(&mut data);
    let parent = target.parent().ok_or("voice settings path lacks parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".voice.local-")
        .tempfile_in(parent)?;
    use std::io::Write;
    let sorted = super::json_pretty_sorted(&data);
    let text = crate::common::json_pretty(&sorted, false) + "\n";
    temporary.write_all(&crate::legacy_text::encode_default(
        &crate::legacy_text::platform_newlines(&text),
        crate::legacy_text::ErrorPolicy::Strict,
    )?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(target)?;
    Ok(data)
}
pub fn device_key(name: &str) -> String {
    let mut key = String::new();
    let mut separator = false;
    for ch in name.chars() {
        if crate::python_unicode::is_word(ch) {
            if separator && !key.is_empty() {
                key.push('-');
            }
            separator = false;
            key.push(ch);
        } else {
            separator = true;
        }
    }
    key.to_lowercase()
}
pub fn device_threshold(key: &str) -> Option<f64> {
    threshold_in(&load(), key)
}
pub fn threshold_in(settings: &Value, key: &str) -> Option<f64> {
    settings["devices"][key]["threshold"].as_f64()
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
        let integer_override = merge(&json!({"max_chars_per_second":20,"vad_gain":3}));
        assert!(integer_override["max_chars_per_second"].is_f64());
        assert!(integer_override["vad_gain"].is_f64());
    }
    #[test]
    fn microphone_keys_keep_unicode() {
        assert_eq!(device_key("Example Headset (2)"), "example-headset-2");
        assert_eq!(device_key("내 마이크"), "내-마이크");
    }
    #[test]
    fn frozen_settings_numeric_types_and_python_strings() {
        let corpus: Value =
            serde_json::from_str(include_str!("review-numeric-fixtures.json")).unwrap();
        for row in corpus["settings"].as_array().unwrap() {
            let got = merge(&row["raw"]);
            assert_eq!(got, row["merged"]);
            for (key, expected) in row["types"].as_object().unwrap() {
                if expected == "float" {
                    assert!(got[key].is_f64(), "{key}");
                }
                if expected == "int" {
                    assert!(got[key].is_i64() || got[key].is_u64(), "{key}");
                }
            }
        }
    }
}
