//! Help captured from the unchanged baseline argparse parsers (CPython 3.12).
//! Only the former script program name is translated to the native invocation.
use crate::common::Result;
use std::io::Write;

pub fn show(command: &str, args: &[String]) -> Result<bool> {
    let snapshots: serde_json::Value = serde_json::from_str(include_str!("cli-help.json"))?;
    let key = if command == "collaborate" {
        args.first()
            .filter(|a| !a.starts_with('-'))
            .map(|a| format!("{command} {a}"))
            .unwrap_or_else(|| command.to_owned())
    } else {
        command.to_owned()
    };
    let alias = match command {
        "install_voice" => "voice_install",
        "install_session_sleep" => "install_space_cleanup",
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
    let mut stdout = std::io::stdout().lock();
    if cfg!(windows) {
        stdout.write_all(text.replace('\n', "\r\n").as_bytes())?;
    } else {
        stdout.write_all(text.as_bytes())?;
    }
    Ok(true)
}
