//! Argument validation happens before any app, queue or filesystem mutation.
use crate::common::*;
const ACTIONS: &[&str] = &[
    "enable", "drain", "status", "enqueue", "start", "accept", "complete", "report",
];
fn negative_number(text: &str) -> bool {
    crate::python_unicode::regex(r"^-\d+$|^-\d*\.\d+$").is_match(text)
}
fn parse(
    args: &[String],
    values: &[&str],
    flags: &[&str],
    command: &str,
) -> Result<(Vec<String>, Vec<String>, Vec<String>)> {
    let (mut normalized, mut positional, mut unknown) = (vec![], vec![], vec![]);
    let flags = flags
        .iter()
        .copied()
        .chain(["--help", "-h"])
        .collect::<Vec<_>>();
    let mut i = 0;
    let mut literal = false;
    while i < args.len() {
        let a = &args[i];
        if literal {
            if command == "demo_agent" && positional.len() == 1 {
                choices(
                    Some(a.clone()),
                    "state",
                    &["working", "blocked", "done", "idle"],
                )?;
            }
            normalized.push(a.clone());
            positional.push(a.clone());
            i += 1;
            continue;
        }
        if a == "--" {
            literal = true;
            normalized.push(a.clone());
            i += 1;
            continue;
        }
        if a.starts_with('-') && a != "-" && !negative_number(a) {
            let (key, inline) = a
                .split_once('=')
                .map(|(a, b)| (a, Some(b)))
                .unwrap_or((a.as_str(), None));
            let key = long_option(key, values, &flags)?;
            if matches!(key, "--help" | "-h") && inline.is_none() {
                normalized.push("--help".into());
                return Ok((normalized, positional, vec![]));
            }
            if values.contains(&key) {
                let value = if let Some(v) = inline {
                    v.to_string()
                } else {
                    i += 1;
                    args.get(i)
                        .filter(|v| !v.starts_with('-') || v.as_str() == "-" || negative_number(v))
                        .cloned()
                        .ok_or_else(|| -> Box<dyn std::error::Error> {
                            Box::new(CliError {
                                code: 2,
                                message: format!("argument {key}: expected one argument"),
                            })
                        })?
                };
                if key == "--tier" {
                    choices(Some(value.clone()), key, &super::tiers::TIERS)?;
                }
                if key == "--mode" {
                    choices(Some(value.clone()), key, &["read-only", "worktree"])?;
                }
                normalized.extend([key.into(), value]);
            } else if flags.contains(&key) && inline.is_none() {
                let other = match key {
                    "--agents" => Some("--shells"),
                    "--shells" => Some("--agents"),
                    _ => None,
                };
                if let Some(other) = other.filter(|other| normalized.iter().any(|v| v == other)) {
                    return usage(format!("argument {key}: not allowed with argument {other}"));
                }
                normalized.push(key.into());
            } else {
                unknown.push(a.clone());
            }
        } else {
            if command == "collaborate" && positional.is_empty() {
                choices(Some(a.clone()), "action", ACTIONS)?;
            }
            if command == "demo_agent" && positional.len() == 1 {
                choices(
                    Some(a.clone()),
                    "state",
                    &["working", "blocked", "done", "idle"],
                )?;
            }
            normalized.push(a.clone());
            positional.push(a.clone());
        }
        i += 1;
    }
    Ok((normalized, positional, unknown))
}
fn count(pos: &[String], min: usize, max: usize) -> Result<()> {
    if pos.len() < min {
        return usage("required positional arguments are missing");
    }
    if pos.len() > max {
        return usage(format!("unrecognized arguments: {}", pos[max..].join(" ")));
    }
    Ok(())
}
fn required(args: &[String], keys: &[&str]) -> Result<()> {
    let missing = keys
        .iter()
        .filter(|key| option(args, key).is_none())
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        usage(format!(
            "the following arguments are required: {}",
            missing.join(", ")
        ))
    }
}
fn choices(value: Option<String>, key: &str, choices: &[&str]) -> Result<()> {
    if let Some(v) = value {
        if !choices.contains(&v.as_str()) {
            return usage(format!(
                "argument {key}: invalid choice: {} (choose from {})",
                super::format::repr(&serde_json::json!(v)),
                choices.join(", ")
            ));
        }
    }
    Ok(())
}
pub fn prepare(command: &str, args: &[String]) -> Result<Option<Vec<String>>> {
    if ![
        "workspace",
        "route",
        "collaborate",
        "collect_workflow",
        "demo_agent",
        "tui_bridge",
        "pinned_system_metrics",
    ]
    .contains(&command)
    {
        return Ok(Some(args.to_vec()));
    }
    let (values, flags): (&[&str], &[&str]) = match command {
        "workspace" => (&["--tiers", "--by"], &["--agents", "--shells"]),
        "route" => (&["--from", "--tier"], &["--drain", "--reply", "--enable"]),
        "collect_workflow" => (&[], &["--once"]),
        "demo_agent" => (&[], &[]),
        "tui_bridge" => (&["--pane", "--session", "--herdr"], &[]),
        "pinned_system_metrics" => (&["--machine"], &[]),
        "collaborate" => (
            &[
                "--id", "--text", "--mode", "--owns", "--batch", "--from", "--tier", "--lease",
                "--result",
            ],
            &["--drain"],
        ),
        _ => unreachable!(),
    };
    let (normalized, pos, mut unknown) = parse(args, values, flags, command)?;
    if normalized.iter().any(|v| v == "--help") {
        if !crate::help::show(command, args)? {
            println!("usage: herdr-theme {command} [options]");
        }
        return Ok(None);
    }
    if command == "collaborate" {
        let action = pos.first().map(String::as_str).unwrap_or("");
        let allowed: &[&str] = match action {
            "enqueue" => &[
                "--id", "--text", "--mode", "--owns", "--batch", "--from", "--tier",
            ],
            "start" | "accept" => &["--from", "--lease"],
            "complete" => &["--from", "--lease", "--result"],
            "report" => &["--batch", "--from"],
            _ => &[],
        };
        unknown = parse(args, allowed, &["--drain"], command)?.2;
        if let Some(index) = args.iter().position(|a| a == action) {
            if args[index + 1..].iter().any(|a| a == "--drain") {
                return usage("unrecognized arguments: --drain");
            }
        }
    }
    match command {
        "workspace" => {
            if pos.len() < 2 {
                return usage(format!(
                    "the following arguments are required: {}",
                    ["name", "folder"][pos.len()..].join(", ")
                ));
            }
            count(&pos, 2, 2)?;
            if flag(&normalized, "--agents") && flag(&normalized, "--shells") {
                return usage("argument --shells: not allowed with argument --agents");
            }
        }
        "route" => {
            count(&pos, 0, 2)?;
            if !unknown.is_empty() {
                return usage(format!("unrecognized arguments: {}", unknown.join(" ")));
            }
            if pos.len() < 2 && !flag(&normalized, "--enable") && !flag(&normalized, "--drain") {
                return usage("project 와 작업 메시지가 필요합니다.");
            }
            choices(
                option(&normalized, "--tier"),
                "--tier",
                &super::tiers::TIERS,
            )?;
        }
        "demo_agent" => {
            if pos.len() < 2 {
                return usage(format!(
                    "the following arguments are required: {}",
                    ["name", "state"][pos.len()..].join(", ")
                ));
            }
            count(&pos, 2, 2)?;
            choices(
                Some(pos[1].clone()),
                "state",
                &["working", "blocked", "done", "idle"],
            )?;
        }
        "collect_workflow" | "pinned_system_metrics" => count(&pos, 0, 0)?,
        "tui_bridge" => {
            count(&pos, 0, 0)?;
            required(&normalized, &["--pane"])?;
        }
        "collaborate" => {
            if pos.is_empty() && flag(&normalized, "--drain") {
                return Ok(Some(normalized));
            }
            let action = pos.first().map(String::as_str).unwrap_or("");
            match action {
                "enable" | "drain" | "status" => count(&pos, 1, 1)?,
                "enqueue" => {
                    count(&pos, 1, 1)?;
                    required(&normalized, &["--id", "--text", "--mode"])?;
                    choices(
                        option(&normalized, "--mode"),
                        "--mode",
                        &["read-only", "worktree"],
                    )?;
                    choices(
                        option(&normalized, "--tier"),
                        "--tier",
                        &super::tiers::TIERS,
                    )?;
                }
                "start" | "accept" => {
                    if pos.len() < 2 {
                        return usage("the following arguments are required: id");
                    }
                    count(&pos, 2, 2)?;
                }
                "complete" => {
                    if pos.len() < 2 {
                        return usage("the following arguments are required: id, --result");
                    }
                    count(&pos, 2, 2)?;
                    required(&normalized, &["--result"])?;
                }
                "report" => {
                    count(&pos, 1, 1)?;
                    required(&normalized, &["--batch"])?;
                }
                _ => return usage("명령을 지정하세요."),
            }
        }
        _ => {}
    }
    if !unknown.is_empty() {
        return usage(format!("unrecognized arguments: {}", unknown.join(" ")));
    }
    Ok(Some(normalized))
}
pub fn positionals(args: &[String], values: &[&str]) -> Vec<String> {
    let mut result = vec![];
    let (mut i, mut literal) = (0, false);
    while i < args.len() {
        if literal {
            result.push(args[i].clone());
            i += 1;
            continue;
        }
        if args[i] == "--" {
            literal = true;
            i += 1;
            continue;
        }
        if values.contains(&args[i].as_str()) {
            i += 2;
            continue;
        }
        if !args[i].starts_with("--") {
            result.push(args[i].clone());
        }
        i += 1;
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_arguments_fail_before_any_runtime_lookup() {
        for (c, a) in [
            ("workspace", vec!["--unknown"]),
            ("route", vec!["p", "text", "--tier", "medium"]),
            ("collaborate", vec!["enqueue", "--id", "a"]),
            ("tui_bridge", vec![]),
            ("collect_workflow", vec!["--unknown"]),
        ] {
            let args = a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
            let e = prepare(c, &args).unwrap_err();
            assert_eq!(e.downcast_ref::<CliError>().unwrap().code, 2);
        }
    }
    #[test]
    fn equals_form_and_last_value_are_preserved() {
        let a = vec![
            "--tiers=low".into(),
            "--tiers".into(),
            "high".into(),
            "name".into(),
            "folder".into(),
        ];
        let a = prepare("workspace", &a).unwrap().unwrap();
        assert_eq!(option(&a, "--tiers"), Some("high".into()));
        assert_eq!(positionals(&a, &["--tiers"]), vec!["name", "folder"]);
    }
    #[test]
    fn original_argparse_long_prefix_and_negative_value_contracts() {
        let a = prepare(
            "route",
            &strings(&["project", "message", "--fr=source", "--ti", "high"]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(option(&a, "--from").as_deref(), Some("source"));
        assert_eq!(option(&a, "--tier").as_deref(), Some("high"));
        let a = prepare("workspace", &strings(&["name", "folder", "--by", "-3"]))
            .unwrap()
            .unwrap();
        assert_eq!(option(&a, "--by").as_deref(), Some("-3"));
        assert!(prepare(
            "workspace",
            &strings(&["name", "folder", "--by", "-hithere"])
        )
        .is_err());
    }
}
