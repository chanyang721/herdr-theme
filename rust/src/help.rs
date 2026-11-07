//! Help captured from the unchanged baseline argparse parsers (CPython 3.12).
//! Only the former script program name is translated to the native invocation.
use crate::common::Result;
use std::io::Write;

/// These original entrypoints retained Python's locale/stdio configuration;
/// the other workspace/document collectors explicitly reconfigured UTF-8.
pub fn default_stdio(command: &str) -> bool {
    command.starts_with("voice_")
        || matches!(
            command,
            "install_voice"
                | "focusq"
                | "focus_queue"
                | "codex_focus"
                | "install_codex_focus"
                | "voicegate"
                | "check_other_device"
                | "check_voice_settings"
                | "replay_voice_policy"
                | "eval_voice_vad"
                | "eval_voice_models"
                | "eval_gate_chain"
                | "doc_routing"
                | "native_collaboration"
                | "native_doc_tabs"
                | "native_ui_reload"
        )
}
pub fn write_error(command: &str, text: &str) -> Result<()> {
    if default_stdio(command) {
        crate::legacy_text::error_line(text)
    } else {
        crate::common::error_line(text)
    }
}

pub fn error_text(command: &str, args: &[String], message: &str) -> String {
    if message.starts_with("usage:") {
        return message.to_owned();
    }
    let snapshots: serde_json::Value =
        serde_json::from_str(include_str!("cli-help.json")).expect("help snapshots");
    let key = if command == "collaborate" && !message.starts_with("unrecognized arguments:") {
        args.iter()
            .find(|a| !a.starts_with('-'))
            .map(|a| format!("{command} {a}"))
            .unwrap_or_else(|| command.into())
    } else {
        command.into()
    };
    let (key, text) = if let Some(text) = snapshots.get(&key).and_then(|v| v.as_str()) {
        (key, text)
    } else if let Some(text) = snapshots.get(command).and_then(|v| v.as_str()) {
        (command.to_string(), text)
    } else {
        return message.to_owned();
    };
    let usage = text.split("\n\n").next().unwrap_or("");
    format!("{usage}\nherdr-theme {key}: error: {message}")
}

pub fn show(command: &str, args: &[String]) -> Result<bool> {
    let snapshots: serde_json::Value = serde_json::from_str(include_str!("cli-help.json"))?;
    let key = if command == "collaborate" {
        args.iter()
            .find(|a| !a.starts_with('-'))
            .map(|a| format!("{command} {a}"))
            .unwrap_or_else(|| command.to_owned())
    } else {
        command.to_owned()
    };
    let alias = match command {
        "install_voice" => "voice_install",
        _ => command,
    };
    let Some(text) = snapshots
        .get(&key)
        .or_else(|| snapshots.get(alias))
        .and_then(|v| v.as_str())
    else {
        return Ok(false);
    };
    let text = if alias != command {
        text.replace(
            &format!("herdr-theme {alias}"),
            &format!("herdr-theme {command}"),
        )
    } else {
        text.to_owned()
    };
    if default_stdio(command) {
        crate::legacy_text::stdout(&text)?;
        return Ok(true);
    }
    let mut stdout = std::io::stdout().lock();
    if cfg!(windows) {
        stdout.write_all(text.replace('\n', "\r\n").as_bytes())?;
    } else {
        stdout.write_all(text.as_bytes())?;
    }
    Ok(true)
}
