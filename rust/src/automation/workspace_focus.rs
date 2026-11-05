//! Preserve workspace creation selection behavior from upstream fb3c234.
//! A failed creation with unknown IDs still has the documented concurrent-pane
//! ambiguity; this module deliberately retains that behavior.
use crate::common::{call, strings, Result};
use serde_json::{json, Map, Value};

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.is_empty(),
        Value::Number(v) => v.as_f64().is_some_and(|v| v != 0.),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}
fn view_with(mut invoke: impl FnMut(&[String]) -> Result<Value>) -> Option<Value> {
    let status = invoke(&strings(&["status"])).ok()?;
    let listing = invoke(&strings(&["ls"])).ok()?;
    let mut panes = Map::new();
    for space in listing.get("spaces")?.as_array()? {
        let empty = vec![];
        let tabs = match space.get("tabs") {
            None => &empty,
            Some(value) => value.as_array()?,
        };
        for tab in tabs {
            let terminals = match tab.get("terminals") {
                None => &empty,
                Some(value) => value.as_array()?,
            };
            for terminal in terminals {
                let item = terminal.as_object()?;
                let key = match item.get("terminal") {
                    Some(Value::String(key)) => key.clone(),
                    None | Some(Value::Null) => "null".into(),
                    Some(key) => key.to_string(),
                };
                panes.insert(key, item.get("pane").cloned().unwrap_or(Value::Null));
            }
        }
    }
    status.as_object()?;
    Some(json!([
        status["space"],
        status["tab"],
        status["focused_pane"],
        panes
    ]))
}
pub fn view() -> Option<Value> {
    view_with(|args| call("herdr-app", args))
}
pub fn took_selection(before: &Value, reply: &Value, after: &Value) -> bool {
    if ["pane", "terminal", "tab"]
        .iter()
        .any(|k| truthy(&reply[k]))
    {
        let terminal = reply["terminal"].as_str().unwrap_or("null");
        let mapped = after[3].get(terminal).unwrap_or(&Value::Null);
        return (!reply["pane"].is_null() && after[2] == reply["pane"])
            || (!mapped.is_null() && after[2] == *mapped)
            || (truthy(&reply["tab"]) && after[1] == reply["tab"]);
    }
    // Only unknown-ID replies use a newly observed terminal as a fallback.
    // This intentionally includes the upstream known concurrent-terminal limit.
    let Some(old) = before[3].as_object() else {
        return false;
    };
    after[3].as_object().is_some_and(|panes| {
        panes
            .values()
            .any(|pane| *pane == after[2] && !old.values().any(|v| v == pane))
    })
}
fn restore_with(
    before: Option<&Value>,
    reply: &Value,
    read_view: impl FnOnce() -> Option<Value>,
    mut invoke: impl FnMut(&[String]) -> Result<Value>,
) {
    // Even an unreadable initial view still performs the final best-effort read.
    let after = read_view();
    let (Some(before), Some(after)) = (before, after) else {
        return;
    };
    if !took_selection(before, reply, &after) {
        return;
    }
    for (index, (command, key)) in [
        ("space.select", "id"),
        ("tab.select", "id"),
        ("pane.focus", "pane"),
    ]
    .into_iter()
    .enumerate()
    {
        if truthy(&before[index]) && after[index] != before[index] {
            let mut args = Map::new();
            args.insert(key.into(), before[index].clone());
            // Each action is independently best effort; failure must not mask
            // the creation result or prevent the following restoration actions.
            let _ = invoke(&["do".into(), command.into(), Value::Object(args).to_string()]);
        }
    }
}
pub fn restore(before: Option<&Value>, reply: &Value) {
    restore_with(before, reply, view, |args| call("herdr-app", args));
}

#[cfg(test)]
mod tests {
    use super::*;
    fn corpus() -> Value {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/workspace-focus-upstream.json"
        ))
        .unwrap()
    }
    fn action(args: &[String]) -> Value {
        json!([args[1], serde_json::from_str::<Value>(&args[2]).unwrap()])
    }
    #[test]
    fn untouched_upstream_pure_reference_cases() {
        for case in corpus()["cases"].as_array().unwrap() {
            let input = &case["input"];
            let actual = match case["function"].as_str().unwrap() {
                "took_selection" => json!(took_selection(
                    &input["before"],
                    &input["reply"],
                    &input["after"]
                )),
                "view" => {
                    let mut calls = vec![];
                    let result = view_with(|args| {
                        calls.push(json!(args));
                        if input["failure"] == args[0] {
                            return Err("synthetic read failure".into());
                        }
                        Ok(input[if args[0] == "status" {
                            "status"
                        } else {
                            "listing"
                        }]
                        .clone())
                    });
                    json!({"result":result,"calls":calls})
                }
                "restore_view" => {
                    let mut calls = vec![];
                    let mut views = 0;
                    restore_with(
                        input.get("before").filter(|v| !v.is_null()),
                        &input["reply"],
                        || {
                            views += 1;
                            input.get("after").filter(|v| !v.is_null()).cloned()
                        },
                        |args| {
                            calls.push(action(args));
                            if input["errors"]
                                .as_array()
                                .unwrap()
                                .contains(&json!(args[1]))
                            {
                                return Err("synthetic restore failure".into());
                            }
                            Ok(json!({}))
                        },
                    );
                    json!({"calls":calls,"view_calls":views})
                }
                name => panic!("unknown upstream function {name}"),
            };
            assert_eq!(
                actual, case["expected"],
                "{} {}",
                case["function"], case["name"]
            );
        }
    }
    #[test]
    fn all_ten_original_window_scenarios_keep_their_recorded_selection() {
        let corpus = corpus();
        let windows = corpus["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 10);
        for case in windows {
            let input = &case["input"];
            let after = &input["after"];
            let mut selected = json!({"space":after[0],"tab":after[1],"pane":after[2]});
            let mut calls = vec![];
            restore_with(
                Some(&input["before"]),
                &input["reply"],
                || Some(after.clone()),
                |args| {
                    let event = action(args);
                    let parameter = &event[1];
                    match args[1].as_str() {
                        "space.select" => {
                            let space = parameter["id"].as_str().unwrap();
                            let tabs = input["spaces"][space].as_object().unwrap();
                            let (tab, panes) = tabs.iter().next().unwrap();
                            selected = json!({"space":space,"tab":tab,"pane":panes[0].as_str().unwrap_or("p-mod")});
                        }
                        "tab.select" => {
                            let tab = parameter["id"].as_str().unwrap();
                            let panes = &input["spaces"][selected["space"].as_str().unwrap()][tab];
                            selected["tab"] = json!(tab);
                            selected["pane"] = json!(panes[0].as_str().unwrap_or("p-mod"));
                        }
                        "pane.focus" => selected["pane"] = parameter["pane"].clone(),
                        _ => panic!("unexpected restore command"),
                    }
                    calls.push(event);
                    Ok(json!({}))
                },
            );
            assert_eq!(json!(calls), case["expected"]["calls"], "{}", case["name"]);
            assert_eq!(selected, case["expected"]["selection"], "{}", case["name"]);
        }
    }
}
