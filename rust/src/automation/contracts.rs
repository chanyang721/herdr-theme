use super::*;
fn evaluate(c: &Value) -> Result<Value> {
    let a = &c["args"];
    Ok(match s(&c["fn"]) {
        "computers" => json!(computers(&a[0])?),
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
