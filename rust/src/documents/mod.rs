//! Native document, desktop and installation helpers.
pub mod arguments;
pub mod casefold;
pub mod catalog;
pub mod common;
pub mod install;
pub mod migration;
pub mod observers;
pub mod pinned;
pub mod pins;
pub mod render;
pub mod routing;
pub mod update;
use common::*;

pub fn run(command: &str, args: &[String]) -> Result<()> {
    if has(args, "--help") || has(args, "-h") {
        if !crate::help::show(command, args)? {
            println!("herdr-theme {command} [arguments]");
        }
        return Ok(());
    }
    let normalized = arguments::normalize(command, args)?;
    let args = normalized.as_slice();
    if command.starts_with("pinned_") {
        return pinned::run(command, args);
    }
    match command.replace('-', "_").as_str() {
        "doc_catalog" | "site_config" | "workspace_mods" | "file_lock" => Ok(()),
        "collect_docs" => pins::collect_cli(args),
        "doc_routing" => routing::cli(args),
        "resolve_doc_pins" => pins::cli(args),
        "open_doc_tab" => pins::open_tab(args),
        "open_document" => pins::open_document(args),
        "seed_workspace_pins" => install::seed_workspace_pins(args),
        "set_workspace_icon" => install::set_workspace_icon(args),
        "render_html" => render::html_cli(args),
        "render_mermaid" => render::mermaid_cli(args),
        "media_image" => render::media_cli(args),
        "desktop" => render::desktop_cli(args),
        "install" => install::cli(args),
        "install_doc_tabs" => install::tabs_cli(args),
        "install_preview" => install::preview_cli(args),
        "update_install" => update::cli(args).map_err(|error| {
            if error.downcast_ref::<crate::common::CliError>().is_some() {
                error
            } else {
                format!("Install failed: {error}").into()
            }
        }),
        "install_session_sleep" => observers::cli(args, true),
        "install_space_cleanup" => observers::cli(args, false),
        "install_voice" => {
            let mut args = args.to_vec();
            if args.first().is_some_and(|s| !s.starts_with('-')) {
                let old = args.remove(0);
                println!(
                    "Ignoring {old}: the voice plugin is installed from {}",
                    repo_default().join("voice").display()
                );
            }
            if option(&args, "--source").is_none() {
                args.extend([
                    "--source".into(),
                    repo_default().join("voice").to_string_lossy().into_owned(),
                ]);
            }
            crate::voice::run("voice_install", &args)
        }
        other => Err(format!("Unknown document command: {other}").into()),
    }
}
