//! Frozen differential cases from workspace-mods pinned Python status collectors.
use super::*;
fn evaluate(c: &Value) -> Result<Value> {
    let a = &c["args"];
    let reply = &c["reply"];
    let runner = |_: &str, _: &[String], _: f64| -> Result<Reply> {
        Ok((
            reply[0].as_i64().unwrap_or(0) as i32,
            s(&reply[1]).into(),
            s(&reply[2]).into(),
        ))
    };
    match s(&c["fn"]) {
        "mask" => Ok(json!(mask(s(&a[0])))),
        "clean_reason" => Ok(json!(clean_reason(s(&a[0])))),
        "aws_failure" => Ok(json!(aws_failure(s(&a[0])))),
        "short_context" => Ok(json!(short_context(s(&a[0])))),
        "domain_label" => Ok(domain_label(s(&a[0]))),
        "org_type" => Ok(json!(org_type(&a[0]))),
        "org_state" => Ok(json!(org_state(&a[0]))),
        "config_value" => Ok(config_value(&a[0])),
        "parse_claude" => Ok(parse_claude(s(&a[0]))),
        "parse_codex" => parse_codex(s(&a[0])),
        "github" => github(&runner, 15.),
        "kubectl" => kubectl(&runner, 15.),
        "docker" => docker(&runner, 15.),
        "salesforce" => salesforce(&runner, &a[0], 15., 1000.),
        "aws_profile" => {
            let run = |_: &str, args: &[String], _: f64| -> Result<Reply> {
                let key = if args.get(0).is_some_and(|a| a == "sts") {
                    "identity"
                } else if args.get(1).is_some_and(|a| a == "get") {
                    "region"
                } else {
                    "expiry"
                };
                let r = &c["responses"][key];
                Ok((
                    r[0].as_i64().unwrap_or(0) as i32,
                    s(&r[1]).into(),
                    s(&r[2]).into(),
                ))
            };
            aws_profile(&run, s(&a[0]), 15., 1800000000.)
        }
        _ => err("unknown pinned fixture function"),
    }
}
#[test]
fn original_python_status_contracts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/pinned-status.json"
    ))
    .unwrap();
    let mut failures = vec![];
    for (index, c) in cases.iter().enumerate() {
        let actual = evaluate(c);
        if let Some(expected) = c["error"].as_str() {
            match actual {
                Err(e) if e.to_string() == expected => {}
                other => failures.push(format!(
                    "{index} {} expected error {expected:?}, got {other:?}",
                    s(&c["fn"])
                )),
            }
        } else {
            match actual {
                Ok(v) if v == c["value"] => {}
                other => failures.push(format!(
                    "{index} {} expected {}, got {other:?}",
                    s(&c["fn"]),
                    c["value"]
                )),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn original_python_unicode_status_contracts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/pinned-status-unicode.json"
    ))
    .unwrap();
    let mut failures = vec![];
    for (index, c) in cases.iter().enumerate() {
        let actual = evaluate(c);
        if let Some(expected) = c["error"].as_str() {
            match actual {
                Err(e) if e.to_string() == expected => {}
                other => failures.push(format!(
                    "unicode case {index} {} expected error {expected:?}, got {other:?}",
                    s(&c["fn"])
                )),
            }
        } else {
            match actual {
                Ok(v) if v == c["value"] => {}
                other => failures.push(format!(
                    "unicode case {index} {} expected {}, got {other:?}",
                    s(&c["fn"]),
                    c["value"]
                )),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn original_python_ignorecase_status_contracts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/pinned-status-ignorecase.json"
    ))
    .unwrap();
    for c in cases {
        assert_eq!(
            evaluate(&c).unwrap(),
            c["value"],
            "original ignorecase mask for {:?}",
            c["args"]
        );
    }
}
#[test]
fn original_python_greedy_boundary_status_contracts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/pinned-status-boundary.json"
    ))
    .unwrap();
    for case in cases {
        assert_eq!(
            evaluate(&case).unwrap(),
            case["value"],
            "unchanged original mask for {:?}",
            case["args"]
        );
    }
}
