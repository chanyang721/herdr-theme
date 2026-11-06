//! Pure and sandboxed outputs of the reviewed Workspace Mods Python release.
use herdr_theme::documents::{
    common::*,
    pinned::{agent, plan},
};
use serde_json::{json, Value};
#[test]
fn pinned_original_contracts() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/pinned-agent-plan-baseline.json")).unwrap();
    let mut checked = 0;
    for (index, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let function = s(&case["function"]);
        let result: Result<Value> = (|| {
            Ok(match function {
                "collect.token_count" => json!(agent::token_count(&input["value"])?),
                "collect.weighted" => json!(agent::weighted(&input["row"], s(&input["kind"]))),
                "collect.aggregate" => {
                    let mut since = input["since"].clone();
                    if since.is_null() {
                        since = input["_fallback"].clone()
                    } else if since.is_object() {
                        for kind in ["claude", "codex"] {
                            if since[kind].is_null() {
                                since[kind] = input["_fallback"].clone()
                            }
                        }
                    }
                    let totals = agent::aggregate(&input["store"], &since)?;
                    let mut output = json!({});
                    for ((kind, id), record) in totals {
                        output[format!("{kind}:{id}")] = record
                    }
                    output
                }
                "collect.unknown" => agent::unknown(&input["terminal"], s(&input["reason"])),
                "meta.model_name" => json!(agent::model_name(&input["model"])),
                "meta.choice" => {
                    let allowed = input["allowed"]
                        .as_array()
                        .map(|a| a.iter().map(s).collect::<Vec<_>>());
                    json!(agent::choice(&input["value"], allowed.as_deref()))
                }
                "meta.permission_level" => json!(agent::permission_level(s(&input["label"]))),
                "meta.sandbox_of" => json!(agent::sandbox_of(&input["settings"])),
                "meta.claude_meta" | "meta.codex_meta" => {
                    let temp = tempfile::tempdir()?;
                    let path = temp.path().join("fixture.jsonl");
                    let mut text = String::new();
                    for repeated in arr(&input["records"]) {
                        let raw = if let Some(raw) = repeated["record"]["_invalid_raw"].as_str() {
                            raw.to_owned()
                        } else {
                            repeated["record"].to_string()
                        };
                        for _ in 0..repeated["repeat"].as_u64().unwrap_or(1) {
                            text.push_str(&raw);
                            text.push('\n')
                        }
                    }
                    std::fs::write(&path, text)?;
                    if function == "meta.claude_meta" {
                        agent::claude_meta(&path)?
                    } else {
                        agent::codex_meta(&path)?
                    }
                }
                "usage.percent" => json!(plan::percent(&input["value"])),
                "usage.label_for" => json!(match input["seconds"].as_i64() {
                    Some(18000) => "5h",
                    Some(604800) => "7d",
                    _ => s(&input["fallback"]),
                }),
                "usage.epoch" => json!(plan::epoch(&input["value"])),
                "usage.short_name" => json!(plan::short_name(&input["value"])),
                "usage.codex_rate" => json!(plan::codex_rate(&input["rate"])),
                "usage.codex_windows" => json!(plan::codex_windows(&input["data"])),
                "usage.claude_scope" => json!(plan::claude_scope(&input["scope"])),
                "usage.claude_windows" => json!(plan::claude_windows(&input["data"])),
                "usage.codex_credits" => plan::codex_credits(&input["data"]),
                "usage.response_shape" => plan::response_shape(
                    &input["value"],
                    input["depth"].as_u64().unwrap_or(0) as usize,
                ),
                "usage.codex_workspace" => plan::codex_workspace(&input["data"]),
                "resets.usable" => json!(plan::usable(&input["details"])),
                "resets.window_label" => json!(match input["seconds"].as_i64() {
                    Some(604800) => Some("7일"),
                    Some(18000) => Some("5시간"),
                    _ => None,
                }),
                "resets.summary" => plan::reset_summary(&input["usage"], &input["details"]),
                "scan_insights.version" => json!(agent::version(s(&input["path"]))),
                other => panic!("unhandled {other}"),
            })
        })();
        if let Some(error) = case["error"].as_str() {
            assert_eq!(
                result.unwrap_err().to_string(),
                error,
                "case {index} {function}"
            )
        } else {
            assert_eq!(
                result.unwrap(),
                case["expected"],
                "case {index} {function}\ninput={input}"
            )
        }
        checked += 1;
    }
    assert!(checked >= 150, "lost original cases");
}
