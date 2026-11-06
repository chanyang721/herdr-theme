//! Keep the observable repr output of the two layout maintenance CLIs.
use serde_json::Value;
#[path = "printable.rs"]
mod printable;
fn string(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if !printable::printable(c) => {
                let n = c as u32;
                out.push_str(&if n <= 0xff {
                    format!("\\x{n:02x}")
                } else if n <= 0xffff {
                    format!("\\u{n:04x}")
                } else {
                    format!("\\U{n:08x}")
                });
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}
pub fn repr(value: &Value) -> String {
    match value {
        Value::Null => "None".into(),
        Value::Bool(v) => {
            if *v {
                "True".into()
            } else {
                "False".into()
            }
        }
        Value::String(v) => string(v),
        Value::Number(n) => {
            if n.is_f64() {
                let v = n.as_f64().unwrap();
                let scientific = format!("{v:e}");
                let (mantissa, exponent) = scientific.split_once('e').unwrap();
                let exponent: i32 = exponent.parse().unwrap();
                if !(-4..16).contains(&exponent) {
                    format!(
                        "{mantissa}e{}{abs:02}",
                        if exponent < 0 { "-" } else { "+" },
                        abs = exponent.abs()
                    )
                } else {
                    let mut text = v.to_string();
                    if !text.contains('.') {
                        text.push_str(".0");
                    }
                    text
                }
            } else {
                n.to_string()
            }
        }
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", string(k), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untouched_python_repr_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/python-repr.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                repr(&case["value"]),
                case["repr"].as_str().unwrap(),
                "{}",
                case["value"]
            );
        }
    }
}
