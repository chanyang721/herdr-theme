use crate::common::*;
use serde_json::{json, Value};
pub const TIERS: [&str; 4] = ["low", "mid", "high", "max"];
const EFFORTS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];
pub fn family(agent: &str) -> &str {
    if agent == "claude-code" {
        "claude"
    } else {
        agent
    }
}
pub fn tier_name(value: Option<&str>) -> Result<String> {
    let value = crate::python_unicode::trim(value.filter(|s| !s.is_empty()).unwrap_or("high"))
        .to_lowercase();
    if TIERS.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(format!("tier는 low|mid|high|max 중 하나입니다: {value}").into())
    }
}
pub fn pane_tier(site: &Value, given: Option<&str>) -> Result<String> {
    if let Some(given) = given.filter(|v| !v.is_empty()) {
        if given.split(',').count() != 1 {
            return Err("--tiers는 세션 1개의 tier 하나만 받습니다(low|mid|high|max). 칸은 dispatch로 늘립니다.".into());
        }
        return tier_name(Some(given));
    }
    if let Some(first) = list(&site["new_space_tiers"]).first() {
        eprintln!("경고: site.local.json new_space_tiers는 더 이상 칸 6개를 열지 않습니다. 첫 값만 쓰고 나머지는 무시합니다.");
        return tier_name(first.as_str());
    }
    tier_name(None)
}
fn entry(v: &Value) -> Value {
    if let Some(m) = v.as_str().filter(|s| !s.is_empty()) {
        json!({"model":m,"effort":null})
    } else if v["model"].as_str().is_some_and(|s| !s.is_empty()) {
        json!({"model":v["model"],"effort":if EFFORTS.contains(&s(&v["effort"])){v["effort"].clone()}else{Value::Null}})
    } else {
        Value::Null
    }
}
pub fn mapping(site: &Value) -> Value {
    let mut result = json!({"claude":{"low":{"model":"claude-haiku-5-5"},"mid":{"model":"claude-sonnet-5-5","effort":"medium"},"max":{"model":"claude-opus-5-5","effort":"xhigh"}},"codex":{"low":{"model":"gpt-6-luna","effort":"low"},"mid":{"model":"gpt-6.1-sol","effort":"medium"},"high":{"model":"gpt-6.1-sol","effort":"high"},"max":{"model":"gpt-6-astra"}}});
    if let Some(local) = site["model_tiers"].as_object() {
        for (family, tiers) in local {
            if !result[family].is_object() {
                result[family] = json!({});
            }
            if let Some(tiers) = tiers.as_object() {
                for (k, v) in tiers {
                    result[family][k] = v.clone();
                }
            }
        }
    }
    for table in result.as_object_mut().unwrap().values_mut() {
        let map = table.as_object_mut().unwrap();
        map.retain(|k, _| TIERS.contains(&k.as_str()));
        for v in map.values_mut() {
            *v = entry(v);
        }
        map.retain(|_, v| !v.is_null());
    }
    result
}
pub fn model_for(agent: &str, tier: &str, models: &Value) -> Result<(String, Value)> {
    let tier = tier_name(Some(tier))?;
    let start = TIERS.iter().position(|t| *t == tier).unwrap();
    let top = if tier == "max" { 3 } else { 2 };
    for t in &TIERS[start..=top] {
        let entry = &models[family(agent)][*t];
        if !entry.is_null() {
            return Ok((t.to_string(), entry.clone()));
        }
    }
    Ok(("high".into(), Value::Null))
}
pub fn flags(agent: &str, entry: &Value) -> Vec<String> {
    if entry.is_null() {
        return vec![];
    }
    let mut a = match family(agent) {
        "claude" => strings(&["--model", s(&entry["model"])]),
        "codex" => strings(&["-m", s(&entry["model"])]),
        _ => return vec![],
    };
    if let Some(e) = entry["effort"].as_str().filter(|s| !s.is_empty()) {
        if family(agent) == "claude" {
            a.extend(strings(&["--effort", e]));
        } else {
            a.extend(["-c".into(), format!("model_reasoning_effort={e}")]);
        }
    }
    a
}
pub fn tier_of(agent: &str, session: &Value, models: &Value) -> usize {
    let model = session.get("model").unwrap_or(session);
    let effort = EFFORTS
        .iter()
        .position(|v| *v == s(&session["effort"]))
        .unwrap_or(1);
    let on: Vec<_> = TIERS
        .iter()
        .enumerate()
        .filter(|(_, t)| !model.is_null() && models[family(agent)][**t]["model"] == *model)
        .collect();
    if on.is_empty() {
        return 2;
    }
    on.iter()
        .filter(|(_, t)| {
            let e = s(&models[family(agent)][**t]["effort"]);
            e.is_empty() || effort >= EFFORTS.iter().position(|v| *v == e).unwrap_or(1)
        })
        .last()
        .map(|(i, _)| *i)
        .unwrap_or(on[0].0.saturating_sub(1))
}
pub fn rank(tier: &str, have: usize) -> Result<Option<usize>> {
    let tier = tier_name(Some(tier))?;
    let want = TIERS.iter().position(|v| *v == tier).unwrap();
    Ok(have.checked_sub(want))
}
pub fn session_models() -> Value {
    let shared = read_json(app_home().join("shared.json")).unwrap_or(Value::Null);
    let mut result = json!({});
    if let Some(ts) = shared["agent-usage.shares"]["terminals"].as_object() {
        for (k, v) in ts {
            if v["meta"].is_object() {
                result[k] = json!({"model":v["meta"]["modelId"],"effort":v["meta"]["effort"]});
            }
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_never_reaches_max() {
        let m = mapping(&json!({"model_tiers":{"claude":{"low":null,"mid":null}}}));
        assert_eq!(
            model_for("claude", "low", &m).unwrap(),
            ("high".into(), Value::Null)
        );
        assert_eq!(model_for("claude", "max", &m).unwrap().0, "max");
    }
    #[test]
    fn effort_controls_shared_models() {
        let m = mapping(&json!({}));
        assert_eq!(
            tier_of(
                "codex",
                &json!({"model":"gpt-6.1-sol","effort":"medium"}),
                &m
            ),
            1
        );
        assert_eq!(
            tier_of("codex", &json!({"model":"gpt-6.1-sol","effort":"high"}), &m),
            2
        );
        assert_eq!(rank("high", 1).unwrap(), None);
        assert!(pane_tier(&json!({}), Some("low,high")).is_err());
    }
}
