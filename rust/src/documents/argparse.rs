//! Native parsing from the unchanged helpers' declarative argparse actions.
//! Types/choices/mutex actions run in source order; option ambiguity is scanned
//! first, exactly as argparse does before executing an eager help action.
use super::common::{s, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[derive(Clone)]
enum Token {
    Plain,
    Separator,
    Unknown,
    Option(usize, Option<String>),
}
fn negative(value: &str) -> bool {
    let value = crate::python_unicode::decimal_ascii(value);
    regex::Regex::new(r"^-\d+$|^-\d*\.\d+$")
        .unwrap()
        .is_match(&value)
}
fn repr(text: &str) -> String {
    crate::automation::format::repr(&json!(text))
}
fn label(action: &Value) -> String {
    let options = action["options"].as_array().unwrap();
    if options.is_empty() {
        s(&action["dest"]).into()
    } else {
        options.iter().map(s).collect::<Vec<_>>().join("/")
    }
}
fn fail<T>(message: impl Into<String>) -> Result<T> {
    crate::common::usage(message)
}
fn classify(value: &str, actions: &[Value]) -> Result<Token> {
    if value == "--" {
        return Ok(Token::Separator);
    }
    if !value.starts_with('-') || value == "-" || negative(value) {
        return Ok(Token::Plain);
    }
    let (key, inline) = value
        .split_once('=')
        .map(|(a, b)| (a, Some(b.to_owned())))
        .unwrap_or((value, None));
    let names = actions
        .iter()
        .enumerate()
        .flat_map(|(index, action)| {
            action["options"]
                .as_array()
                .unwrap()
                .iter()
                .map(move |name| (index, s(name)))
        })
        .collect::<Vec<_>>();
    if let Some((index, _)) = names.iter().find(|(_, name)| *name == key) {
        return Ok(Token::Option(*index, inline));
    }
    if key.starts_with("--") {
        let candidates = names
            .iter()
            .filter(|(_, name)| name.starts_with(key))
            .collect::<Vec<_>>();
        if candidates.len() > 1 {
            return fail(format!(
                "ambiguous option: {key} could match {}",
                candidates
                    .iter()
                    .map(|(_, name)| *name)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if let Some((index, _)) = candidates.first() {
            return Ok(Token::Option(*index, inline));
        }
    } else if value.starts_with("-h") && !value.contains('=') {
        // Help is eager even when grouped with an otherwise unknown short tail.
        if let Some((index, _)) = names.iter().find(|(_, name)| *name == "-h") {
            return Ok(Token::Option(*index, None));
        }
    }
    if value.contains(' ') {
        Ok(Token::Plain)
    } else {
        Ok(Token::Unknown)
    }
}
fn float(value: &str) -> Option<String> {
    let text =
        crate::python_unicode::decimal_ascii(value.trim_matches(|c| {
            crate::python_unicode::is_space(c) && !matches!(c, '\u{1c}'..='\u{1f}')
        }));
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'_'
            && (index == 0
                || index + 1 == bytes.len()
                || !bytes[index - 1].is_ascii_digit()
                || !bytes[index + 1].is_ascii_digit())
        {
            return None;
        }
    }
    let text = text.replace('_', "");
    let (sign, word) = if let Some(s) = text.strip_prefix('-') {
        (-1., s)
    } else {
        (1., text.strip_prefix('+').unwrap_or(&text))
    };
    let value = if word.eq_ignore_ascii_case("nan") {
        f64::NAN
    } else if word.eq_ignore_ascii_case("inf") || word.eq_ignore_ascii_case("infinity") {
        sign * f64::INFINITY
    } else {
        text.parse::<f64>().ok()?
    };
    Some(value.to_string())
}
fn convert(action: &Value, value: &str) -> Result<String> {
    let converted = match s(&action["type"]) {
        "int" => super::render::width_bucket(value)
            .map(|v| v.to_string())
            .map_err(|_| {
                Box::new(crate::common::CliError {
                    code: 2,
                    message: format!(
                        "argument {}: invalid int value: {}",
                        label(action),
                        repr(value)
                    ),
                }) as Box<dyn std::error::Error>
            })?,
        "float" => float(value).ok_or_else(|| {
            Box::new(crate::common::CliError {
                code: 2,
                message: format!(
                    "argument {}: invalid float value: {}",
                    label(action),
                    repr(value)
                ),
            }) as Box<dyn std::error::Error>
        })?,
        "Path" => {
            let path = std::path::Path::new(value);
            let path = path.components().collect::<std::path::PathBuf>();
            if path.as_os_str().is_empty() {
                ".".into()
            } else {
                path.to_string_lossy().into_owned()
            }
        }
        _ => value.to_owned(),
    };
    if let Some(choices) = action["choices"].as_array() {
        if !choices.iter().any(|choice| s(choice) == value) {
            return fail(format!(
                "argument {}: invalid choice: {} (choose from {})",
                label(action),
                repr(value),
                choices
                    .iter()
                    .map(|v| if let Some(text) = v.as_str() {
                        text.to_owned()
                    } else {
                        crate::automation::format::repr(v)
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    Ok(converted)
}
pub fn parse(command: &str, args: &[String]) -> Option<Result<Vec<String>>> {
    let specs: Value = serde_json::from_str(include_str!("argparse.json"))
        .expect("compiled original argparse actions");
    let spec = specs["parsers"].get(command)?;
    Some(parse_spec(command, args, spec))
}
pub fn with_usage(command: &str, error: Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {
    let Some(cli) = error
        .downcast_ref::<crate::common::CliError>()
        .filter(|e| e.code == 2)
    else {
        return error;
    };
    if cli.message.starts_with("usage:") {
        return error;
    }
    let specs: Value = serde_json::from_str(include_str!("argparse.json"))
        .expect("compiled original argparse actions");
    let Some(usage) = specs["parsers"][command]["usage"].as_str() else {
        return error;
    };
    Box::new(crate::common::CliError {
        code: 2,
        message: format!(
            "{}\nherdr-theme {command}: error: {}",
            usage.trim_end(),
            cli.message
        ),
    })
}
fn parse_spec(command: &str, args: &[String], spec: &Value) -> Result<Vec<String>> {
    let mut actions = spec["actions"].as_array().unwrap().clone();
    if command == "install" {
        // New explicit source selection replaces the original script-location
        // dependency when the one native binary is run from an installed copy.
        actions.push(json!({"options":["--repo"],"dest":"repo","required":false,"nargs":null,"class":"_StoreAction","type":"Path","choices":null,"group":null}));
    }
    let mut ended = false;
    let tokens = args
        .iter()
        .map(|arg| {
            if ended {
                return Ok(Token::Plain);
            }
            let token = classify(arg, &actions)?;
            if matches!(token, Token::Separator) {
                ended = true
            }
            Ok(token)
        })
        .collect::<Result<Vec<_>>>()?;
    let positionals = actions
        .iter()
        .enumerate()
        .filter(|(_, a)| a["options"].as_array().unwrap().is_empty())
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    let mut position = 0;
    let mut index = 0;
    let mut used = vec![false; actions.len()];
    let mut groups = BTreeMap::<u64, usize>::new();
    let mut options = vec![];
    let mut literals = vec![];
    let mut unknown = vec![];
    while index < args.len() {
        match &tokens[index] {
            Token::Separator => {
                index += 1;
                continue;
            }
            Token::Unknown => {
                unknown.push(args[index].clone());
                index += 1;
                continue;
            }
            Token::Plain => {
                let Some(&action_index) = positionals.get(position) else {
                    unknown.push(args[index].clone());
                    index += 1;
                    continue;
                };
                let action = &actions[action_index];
                used[action_index] = true;
                position += 1;
                if action["nargs"] == "*" {
                    while index < args.len()
                        && matches!(tokens[index], Token::Plain | Token::Separator)
                    {
                        if matches!(tokens[index], Token::Plain) {
                            literals.push(convert(action, &args[index])?)
                        }
                        index += 1;
                    }
                } else {
                    literals.push(convert(action, &args[index])?);
                    index += 1;
                }
            }
            Token::Option(action_index, inline) => {
                let action_index = *action_index;
                let action = &actions[action_index];
                if action["nargs"] == 0 && inline.is_some() {
                    return fail(format!(
                        "argument {}: ignored explicit argument {}",
                        label(action),
                        repr(inline.as_deref().unwrap())
                    ));
                }
                if action["class"] == "_HelpAction" {
                    return Ok(vec!["--help".into()]);
                }
                let key = action["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(s)
                    .find(|s| s.starts_with("--"))
                    .unwrap();
                let value = if action["nargs"] == 0 {
                    None
                } else {
                    let raw = if let Some(value) = inline {
                        value.clone()
                    } else {
                        index += 1;
                        if !matches!(tokens.get(index), Some(Token::Plain)) {
                            return fail(format!(
                                "argument {}: expected one argument",
                                label(action)
                            ));
                        }
                        args[index].clone()
                    };
                    Some(convert(action, &raw)?)
                };
                if let Some(group) = action["group"].as_u64() {
                    if let Some(previous) = groups.get(&group).filter(|v| **v != action_index) {
                        return fail(format!(
                            "argument {}: not allowed with argument {}",
                            label(action),
                            label(&actions[*previous])
                        ));
                    }
                    groups.insert(group, action_index);
                }
                used[action_index] = true;
                if let Some(value) = value {
                    options.push(format!("{key}={value}"))
                } else {
                    options.push(key.to_owned())
                }
                index += 1;
            }
        }
    }
    let missing = actions
        .iter()
        .enumerate()
        .filter(|(i, action)| action["required"] == true && !used[*i])
        .map(|(_, a)| label(a))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return fail(format!(
            "the following arguments are required: {}",
            missing.join(", ")
        ));
    }
    if !unknown.is_empty() {
        return fail(format!("unrecognized arguments: {}", unknown.join(" ")));
    }
    if !literals.is_empty() {
        options.push("--".into());
        options.extend(literals)
    }
    Ok(options)
}
