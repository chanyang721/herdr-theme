//! Argument validation happens before any app, queue or filesystem mutation.
use crate::common::*;
fn parse(args: &[String], values: &[&str], flags: &[&str]) -> Result<(Vec<String>, Vec<String>)> {
    let (mut normalized, mut positional) = (vec![], vec![]);
    let mut i = 0;
    let mut literal = false;
    while i < args.len() {
        let a = &args[i];
        if literal {
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
        if a.starts_with('-') && a != "-" {
            let (key, inline) = a
                .split_once('=')
                .map(|(a, b)| (a, Some(b)))
                .unwrap_or((a.as_str(), None));
            let key = long_option(key, values, flags)?;
            if values.contains(&key) {
                let value = if let Some(v) = inline {
                    v.to_string()
                } else {
                    i += 1;
                    args.get(i)
                        .filter(|v| {
                            !v.starts_with('-') || v.as_str() == "-" || v.parse::<f64>().is_ok()
                        })
                        .cloned()
                        .ok_or_else(|| -> Box<dyn std::error::Error> {
                            Box::new(CliError {
                                code: 2,
                                message: format!("argument {key}: expected one argument"),
                            })
                        })?
                };
                normalized.extend([key.into(), value]);
            } else if flags.contains(&key) && inline.is_none() {
                normalized.push(key.into());
            } else {
                return usage(format!("unrecognized arguments: {a}"));
            }
        } else {
            normalized.push(a.clone());
            positional.push(a.clone());
        }
        i += 1;
    }
    Ok((normalized, positional))
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
    for key in keys {
        if option(args, key).is_none() {
            return usage(format!("the following argument is required: {key}"));
        }
    }
    Ok(())
}
fn choices(value: Option<String>, key: &str, choices: &[&str]) -> Result<()> {
    if let Some(v) = value {
        if !choices.contains(&v.as_str()) {
            return usage(format!(
                "argument {key}: invalid choice: {v} (choose from {})",
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
    if flag(args, "--help") || flag(args, "-h") {
        if !crate::help::show(command, args)? {
            println!("usage: herdr-theme {command} [options]");
        }
        return Ok(None);
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
    let (normalized, pos) = parse(args, values, flags)?;
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
        parse(args, allowed, &["--drain"])?;
    }
    match command {
        "workspace" => {
            count(&pos, 2, 2)?;
            if flag(&normalized, "--agents") && flag(&normalized, "--shells") {
                return usage("argument --shells: not allowed with argument --agents");
            }
        }
        "route" => {
            count(
                &pos,
                if flag(&normalized, "--enable") || flag(&normalized, "--drain") {
                    0
                } else {
                    2
                },
                2,
            )?;
            choices(
                option(&normalized, "--tier"),
                "--tier",
                &super::tiers::TIERS,
            )?;
        }
        "demo_agent" => {
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
                "start" | "accept" => count(&pos, 2, 2)?,
                "complete" => {
                    count(&pos, 2, 2)?;
                    required(&normalized, &["--result"])?;
                }
                "report" => {
                    count(&pos, 1, 1)?;
                    required(&normalized, &["--batch"])?;
                }
                _ => return usage("a collaboration command is required"),
            }
        }
        _ => {}
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
