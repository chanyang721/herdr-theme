//! CLI validation happens before a helper can read credentials, launch tools or write files.
use super::common::*;
pub fn normalize(command: &str, args: &[String]) -> Result<Vec<String>> {
    let (options, flags, minimum, maximum): (&[&str], &[&str], usize, usize) = match command {
        "collect_docs" => (&["--config", "--output", "--pins"], &[], 0, 0),
        "doc_routing" => (&["--routing"], &[], 0, 0),
        "resolve_doc_pins" => (
            &[
                "--config",
                "--space",
                "--routing",
                "--pin",
                "--pin-id",
                "--unpin",
            ],
            &[],
            0,
            0,
        ),
        "open_doc_tab" => (&["--space"], &["--no-show"], 1, 1),
        "open_document" => (&[], &[], 1, 1),
        "seed_workspace_pins" => (&["--home"], &["--ensure-spaces"], 0, 0),
        "set_workspace_icon" => (&["--background"], &["--tint"], 2, 2),
        "render_html" => (&["--doc", "--theme", "--width"], &[], 0, 0),
        "render_mermaid" => (&["--doc", "--theme", "--background"], &[], 0, 0),
        "media_image" => (&[], &[], 2, 2),
        "desktop" => (&[], &[], 2, 2),
        "install" => (
            &["--home", "--repo", "--workspace-mods-source"],
            &["--update", "--without-workspace-mods"],
            0,
            0,
        ),
        "install_doc_tabs" => (
            &["--home", "--repo", "--mermaid"],
            &["--install", "--ensure-tabs"],
            0,
            0,
        ),
        "install_preview" => (&["--source", "--layout"], &["--markdown-only"], 0, 0),
        "update_install" => (
            &[
                "--home",
                "--repo",
                "--cli",
                "--workspace-mods-source",
                "--verify-timeout",
                "--observer-home",
            ],
            &["--without-workspace-mods", "--allow-unhealthy-before"],
            0,
            usize::MAX,
        ),
        "install_session_sleep" | "install_space_cleanup" => (
            &["--home", "--source"],
            &[
                "--install",
                "--enable-apply",
                "--refresh",
                "--user-approved",
            ],
            0,
            0,
        ),
        "install_voice" => (
            &["--home", "--source"],
            &["--enroll", "--check", "--no-start"],
            0,
            1,
        ),
        "pinned_agent_usage" => (
            &["--store", "--hc", "--since-claude", "--since-codex"],
            &["--meta"],
            0,
            0,
        ),
        "pinned_scan_insights" => (&["--store", "--collector", "--timeout"], &[], 0, 0),
        "pinned_plan_usage" => (&["--shape-file"], &[], 0, usize::MAX),
        "pinned_codex_resets" => (&[], &["--use"], 0, 0),
        // These wrappers already have their original source-specific parser.
        "pinned_cli_status" | "pinned_mcp_status" => return Ok(args.to_vec()),
        _ => return Ok(args.to_vec()),
    };
    let mut output = vec![];
    let mut index = 0;
    let mut positional_count = 0;
    let mut ended = false;
    while index < args.len() {
        let arg = &args[index];
        if ended {
            output.push(arg.clone());
            positional_count += 1;
            index += 1;
            continue;
        }
        if arg == "--" {
            ended = true;
            output.push(arg.clone());
            index += 1;
            continue;
        }
        if arg.starts_with('-') && arg != "-" {
            let (key, inline) = arg
                .split_once('=')
                .map(|(k, v)| (k, Some(v)))
                .unwrap_or((arg.as_str(), None));
            let key = crate::common::long_option(key, options, flags)?;
            if flags.contains(&key) {
                if inline.is_some() {
                    return crate::common::usage(format!(
                        "argument {key}: ignored explicit argument"
                    ));
                }
                output.push(key.into());
                index += 1;
                continue;
            }
            if !options.contains(&key) {
                return crate::common::usage(format!("unrecognized arguments: {arg}"));
            }
            let mut value = if let Some(value) = inline {
                value.to_owned()
            } else {
                index += 1;
                let Some(value) = args.get(index) else {
                    return crate::common::usage(format!("argument {key}: expected one argument"));
                };
                if value.starts_with('-')
                    && value != "-"
                    && crate::python_unicode::decimal_ascii(value)
                        .parse::<f64>()
                        .is_err()
                {
                    return crate::common::usage(format!("argument {key}: expected one argument"));
                }
                value.clone()
            };
            if command == "render_html" && key == "--width" {
                value = super::render::width_bucket(&value)?.to_string();
            }
            if inline.is_some() {
                output.push(format!("{key}={value}"));
            } else {
                output.extend([key.to_owned(), value]);
            }
        } else {
            positional_count += 1;
            output.push(arg.clone())
        }
        index += 1;
    }
    if positional_count < minimum {
        return crate::common::usage(format!("{command}: required positional argument missing"));
    }
    if positional_count > maximum {
        return crate::common::usage(format!("{command}: unrecognized positional arguments"));
    }
    if command == "resolve_doc_pins" {
        required(&output, "--space")?;
        if ["--pin", "--pin-id", "--unpin"]
            .iter()
            .filter(|flag| has(&output, flag))
            .count()
            > 1
        {
            return crate::common::usage("--pin, --pin-id and --unpin are mutually exclusive");
        }
    }
    if command == "render_html" || command == "render_mermaid" {
        required(&output, "--doc")?;
        if let Some(theme) = option(&output, "--theme") {
            if !["dark", "light"].contains(&theme.as_str()) {
                return crate::common::usage("argument --theme: invalid choice");
            }
        }
        if let Some(width) = option(&output, "--width") {
            if width.parse::<i64>().is_err() {
                return crate::common::usage("argument --width: invalid int value");
            }
        }
    }
    if command == "desktop" {
        let positions = positionals(&output, &[]);
        if !["open", "browser", "editor", "copy-file", "copy-text"].contains(&positions[0].as_str())
        {
            return crate::common::usage("argument action: invalid choice");
        }
    }
    if command == "update_install" {
        if let Some(timeout) = option(&output, "--verify-timeout") {
            let Ok(timeout) = timeout.parse::<f64>() else {
                return crate::common::usage("argument --verify-timeout: invalid float value");
            };
            if timeout < 1.5 {
                return crate::common::usage("--verify-timeout must be at least 1.5 seconds");
            }
        }
    }
    if command == "install_doc_tabs" && has(&output, "--install") && has(&output, "--ensure-tabs") {
        return crate::common::usage("--install and --ensure-tabs are mutually exclusive");
    }
    if ["install_space_cleanup", "install_session_sleep"].contains(&command)
        && has(&output, "--user-approved")
        && !has(&output, "--enable-apply")
    {
        return crate::common::usage("--user-approved only goes with --enable-apply");
    }
    if command == "pinned_scan_insights" {
        required(&output, "--store")?;
        if let Some(timeout) = option(&output, "--timeout") {
            if timeout.parse::<f64>().is_err() {
                return crate::common::usage("argument --timeout: invalid float value");
            }
        }
    }
    if command == "pinned_plan_usage" {
        let providers = positionals(&output, flags);
        if providers.iter().any(|p| p != "codex" && p != "claude") {
            return crate::common::usage("providers must be codex or claude");
        }
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn flags_rejected_before_mutation() {
        for (command, args) in [
            ("install", argv(&["--updtae"])),
            ("install_doc_tabs", argv(&["--install", "--ensure-tabs"])),
            ("render_html", argv(&["--doc", "a", "--width", "bad"])),
            ("resolve_doc_pins", argv(&[])),
        ] {
            let error = normalize(command, &args).unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<crate::common::CliError>()
                    .unwrap()
                    .code,
                2
            )
        }
    }
    #[test]
    fn equals_options_and_positional_separator_preserved() {
        let args = normalize(
            "open_doc_tab",
            &argv(&["--space=Demo", "--", "--local-report.md"]),
        )
        .unwrap();
        assert_eq!(option(&args, "--space"), Some("Demo".into()));
        assert_eq!(
            positionals(&args, &["--no-show"]),
            vec!["--local-report.md"]
        );
    }
    #[test]
    fn original_argparse_width_unicode_integer_and_clamp_contracts() {
        let source: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/python-width.json")).unwrap();
        for row in source["cases"].as_array().unwrap() {
            let value = row["value"].as_str().unwrap();
            let mut args = argv(&["--doc", "fixture.html"]);
            if row["inline"] == true {
                args.push(format!("--width={value}"));
            } else {
                args.extend(argv(&["--width", value]));
            }
            let result = normalize("render_html", &args);
            if let Some(width) = row["width"].as_i64() {
                let parsed = result.unwrap();
                assert_eq!(
                    option(&parsed, "--width").unwrap().parse::<i64>().unwrap(),
                    width,
                    "{row}"
                );
            } else {
                let error = result.unwrap_err();
                assert_eq!(
                    error
                        .downcast_ref::<crate::common::CliError>()
                        .unwrap()
                        .code,
                    2,
                    "{row}"
                );
            }
        }
    }
}
