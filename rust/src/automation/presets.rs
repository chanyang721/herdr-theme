//! Optional model presets for the one agent session a new workspace opens.
//!
//! site.local.json may name presets per agent CLI and a default for new workspaces:
//!   "model_presets": {"claude": {"deep": {"model": "m", "effort": "high"}}},
//!   "new_space_preset": "deep"
//! Without them the session starts as plain `claude` (the CLI's own default).
use crate::common::*;
use serde_json::{json, Value};
pub const EFFORTS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const NAME: &str = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$";
fn entry(v: &Value) -> Option<Value> {
    if let Some(m) = v.as_str().filter(|s| !s.is_empty()) {
        return Some(json!({"model":m,"effort":null}));
    }
    let model = v["model"].as_str().filter(|s| !s.is_empty())?;
    let effort = v["effort"].as_str().filter(|e| EFFORTS.contains(e));
    Some(json!({"model":model,"effort":effort}))
}
fn checked_effort(effort: Option<&str>) -> Result<Option<String>> {
    match effort.filter(|e| !e.is_empty()) {
        None => Ok(None),
        Some(e) if EFFORTS.contains(&e) => Ok(Some(e.to_owned())),
        Some(e) => Err(format!("effort must be one of {}: {e}", EFFORTS.join("|")).into()),
    }
}
/// The model and effort for the session: an explicit model wins, then a named preset, then the
/// site's default preset. `Value::Null` means the CLI default (no flags).
pub fn choose(
    site: &Value,
    agent: &str,
    preset: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(Option<String>, Value)> {
    let effort = checked_effort(effort)?;
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        return Ok((None, json!({"model":model,"effort":effort})));
    }
    if effort.is_some() {
        return Err("--effort needs --model or a preset that names a model".into());
    }
    let (name, explicit) = match preset.filter(|p| !p.is_empty()) {
        Some(p) => (Some(p.to_owned()), true),
        None => (site["new_space_preset"].as_str().map(str::to_owned), false),
    };
    let Some(name) = name else {
        return Ok((None, Value::Null));
    };
    if !crate::python_unicode::regex(NAME).is_match(&name) {
        return Err(format!("invalid preset name: {name}").into());
    }
    match entry(&site["model_presets"][agent][&name]) {
        Some(found) => Ok((Some(name), found)),
        None if explicit => Err(format!("unknown model preset for {agent}: {name}").into()),
        None => {
            eprintln!("warning: new_space_preset {name:?} is not in model_presets.{agent}; using the CLI default");
            Ok((None, Value::Null))
        }
    }
}
pub fn flags(agent: &str, entry: &Value) -> Vec<String> {
    let Some(model) = entry["model"].as_str().filter(|m| !m.is_empty()) else {
        return vec![];
    };
    let effort = entry["effort"].as_str().filter(|e| !e.is_empty());
    match agent {
        "claude" | "claude-code" => {
            let mut a = strings(&["--model", model]);
            if let Some(e) = effort {
                a.extend(strings(&["--effort", e]));
            }
            a
        }
        "codex" => {
            let mut a = strings(&["-m", model]);
            if let Some(e) = effort {
                a.extend(["-c".into(), format!("model_reasoning_effort={e}")]);
            }
            a
        }
        _ => vec![],
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_model_then_preset_then_site_default_then_cli_default() {
        let site = json!({"model_presets":{"claude":{"deep":{"model":"m-deep","effort":"high"},"quick":"m-quick"}},"new_space_preset":"quick"});
        assert_eq!(
            choose(&site, "claude", Some("deep"), Some("m-x"), Some("low")).unwrap(),
            (None, json!({"model":"m-x","effort":"low"}))
        );
        assert_eq!(
            choose(&site, "claude", Some("deep"), None, None).unwrap(),
            (Some("deep".into()), json!({"model":"m-deep","effort":"high"}))
        );
        assert_eq!(
            choose(&site, "claude", None, None, None).unwrap(),
            (Some("quick".into()), json!({"model":"m-quick","effort":null}))
        );
        assert_eq!(
            choose(&json!({}), "claude", None, None, None).unwrap(),
            (None, Value::Null)
        );
    }
    #[test]
    fn unknown_or_malformed_choices_are_refused() {
        assert!(choose(&json!({}), "claude", Some("deep"), None, None).is_err());
        assert!(choose(&json!({}), "claude", Some("../x"), None, None).is_err());
        assert!(choose(&json!({}), "claude", None, Some("m"), Some("huge")).is_err());
        assert!(choose(&json!({}), "claude", None, None, Some("high")).is_err());
        assert_eq!(
            choose(&json!({"new_space_preset":"gone"}), "claude", None, None, None).unwrap(),
            (None, Value::Null)
        );
    }
    #[test]
    fn flags_per_cli() {
        assert_eq!(
            flags("claude", &json!({"model":"m","effort":"medium"})),
            strings(&["--model", "m", "--effort", "medium"])
        );
        assert_eq!(
            flags("codex", &json!({"model":"g","effort":"low"})),
            strings(&["-m", "g", "-c", "model_reasoning_effort=low"])
        );
        assert!(flags("claude", &Value::Null).is_empty());
    }
}
