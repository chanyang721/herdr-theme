use super::*;
fn evaluate(c: &Value) -> Result<Value> {
    let a = &c["args"];
    Ok(match s(&c["fn"]) {
        "tier_name" => json!(tiers::tier_name(a[0].as_str())?),
        "mapping" => tiers::mapping(&a[0]),
        "model_for" => json!(tiers::model_for(s(&a[0]), s(&a[1]), &a[2])?),
        "tier_of" => json!(tiers::TIERS[tiers::tier_of(s(&a[0]), &a[1], &a[2])]),
        "flags" => json!(tiers::flags(s(&a[0]), &a[1])),
        "rank" => json!(tiers::rank(
            s(&a[0]),
            tiers::TIERS.iter().position(|v| *v == s(&a[1])).unwrap()
        )?),
        "receiver_available" => json!(routing::receiver_available(s(&a[0]))),
        "computers" => json!(computers(&a[0])?),
        "thresholds" => {
            collaboration::thresholds(list(&a[0]), s(&a[1]), &a[2], a[3].as_f64().unwrap())
        }
        "ownership_conflict" => json!(collaboration::ownership_conflict(&a[0], list(&a[1]))),
        "transcript" => json!(workflow::transcript_facts(s(&a[0]), s(&a[1]), s(&a[2]))),
        _ => return Err("unknown frozen case".into()),
    })
}
fn equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|w| equivalent(v, w)))
        }
        _ => a == b,
    }
}
#[test]
fn frozen_original_general_contracts() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/general-python-baseline.json"
    ))
    .unwrap();
    let mut failures = vec![];
    for (i, c) in list(&cases).iter().enumerate() {
        let got = evaluate(c);
        if let Some(error) = c["error"].as_str() {
            if !matches!(&got,Err(e)if e.to_string()==error) {
                failures.push(format!(
                    "{i} {}: expected error {error:?}, got {got:?}",
                    s(&c["fn"])
                ));
            }
        } else if !matches!(&got,Ok(v)if equivalent(v,&c["value"])) {
            failures.push(format!(
                "{i} {}: expected {}, got {got:?}",
                s(&c["fn"]),
                c["value"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
