//! The voice installers and replay use argparse; focusq deliberately does not.
use super::Result;
pub struct Options {
    pub normalized: Vec<String>,
    pub unknown: Vec<String>,
    pub help: bool,
}
fn negative_number(text: &str) -> bool {
    crate::python_unicode::regex(r"^-\d+$|^-\d*\.\d+$").is_match(text)
}
pub fn parse(args: &[String], values: &[&str], flags: &[&str]) -> Result<Options> {
    let flags = std::iter::once("--help")
        .chain(flags.iter().copied())
        .collect::<Vec<_>>();
    let mut result = Options {
        normalized: vec![],
        unknown: vec![],
        help: false,
    };
    let mut i = 0;
    while i < args.len() {
        let raw = &args[i];
        if raw == "--" {
            result.unknown.extend(args[i..].iter().cloned());
            break;
        }
        let (key, assigned) = raw
            .split_once('=')
            .map(|(a, b)| (a, Some(b)))
            .unwrap_or((raw.as_str(), None));
        // argparse runs the first short help action before consuming a short
        // option cluster, but an explicit '=' argument is rejected.
        if raw.starts_with("-h") && !raw.starts_with("--") && !raw.starts_with("-h=") {
            result.help = true;
            return Ok(result);
        }
        let all = std::iter::once("--help")
            .chain(values.iter().copied())
            .chain(flags.iter().copied().filter(|f| *f != "--help"))
            .collect::<Vec<_>>();
        let matching = all
            .iter()
            .copied()
            .filter(|name| key.starts_with("--") && name.starts_with(key))
            .collect::<Vec<_>>();
        let key = if key == "-h" {
            "--help"
        } else if all.contains(&key) {
            key
        } else if matching.len() == 1 {
            matching[0]
        } else if matching.len() > 1 {
            return crate::common::usage(format!(
                "ambiguous option: {raw} could match {}",
                matching.join(", ")
            ));
        } else {
            key
        };
        if values.contains(&key) {
            let value = if let Some(v) = assigned {
                v.to_owned()
            } else {
                i += 1;
                let Some(value) = args
                    .get(i)
                    .filter(|v| !v.starts_with('-') || v.as_str() == "-" || negative_number(v))
                else {
                    return crate::common::usage(format!("argument {key}: expected one argument"));
                };
                value.clone()
            };
            result.normalized.extend([key.into(), value]);
        } else if flags.contains(&key) {
            if let Some(value) = assigned {
                let name = if key == "--help" { "-h/--help" } else { key };
                return crate::common::usage(format!(
                    "argument {name}: ignored explicit argument {}",
                    crate::automation::format::repr(&serde_json::json!(value))
                ));
            }
            if key == "--help" {
                result.help = true;
                return Ok(result);
            }
            result.normalized.push(key.into());
        } else {
            result.unknown.push(raw.clone());
        }
        i += 1;
    }
    Ok(result)
}
pub fn value<'a>(args: &'a [String], key: &str, values: &[&str]) -> Option<&'a str> {
    let (mut i, mut found) = (0, None);
    while i < args.len() {
        if values.contains(&args[i].as_str()) {
            if args[i] == key {
                found = args.get(i + 1).map(String::as_str);
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    found
}
pub fn unknown(args: &[String]) -> Result<()> {
    if !args.is_empty() {
        return crate::common::usage(format!("unrecognized arguments: {}", args.join(" ")));
    }
    Ok(())
}
pub fn flag(args: &[String], key: &str, values: &[&str]) -> bool {
    let mut i = 0;
    while i < args.len() {
        if values.contains(&args[i].as_str()) {
            i += 2;
        } else {
            if args[i] == key {
                return true;
            }
            i += 1;
        }
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_argparse_actions_and_messages() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("argparse-fixtures.json")).unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let args = case["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            let (values, flags): (&[&str], &[&str]) = if case["file"] == "install.py" {
                (&["--home"], &["--enroll", "--check", "--no-start"])
            } else {
                (&["--target-home"], &["--no-start", "--uninstall"])
            };
            let result = parse(&args, values, flags).and_then(|parsed| {
                if !parsed.help {
                    unknown(&parsed.unknown)?;
                }
                Ok(parsed)
            });
            if case["code"] == 0 {
                assert!(result.unwrap().help, "{case}");
            } else {
                let error = match result {
                    Err(e) => e,
                    Ok(_) => panic!("expected parser rejection: {case}"),
                };
                assert_eq!(error.to_string(), case["error"].as_str().unwrap(), "{case}");
            }
        }
    }
    #[test]
    fn repeated_options_and_dash_values_are_data() {
        let parsed = parse(
            &["--home=--no-start", "--home", "second"].map(String::from),
            &["--home"],
            &["--no-start"],
        )
        .unwrap();
        assert_eq!(
            value(&parsed.normalized, "--home", &["--home"]),
            Some("second")
        );
        assert!(!flag(&parsed.normalized, "--no-start", &["--home"]));
    }
}
