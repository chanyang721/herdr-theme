fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" {
        println!("herdr-theme <command> [arguments]\nNative Sixfold workspace, documents, lifecycle and voice tools.");
        return;
    }
    let command = args.remove(0).replace('-', "_");
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        match herdr_theme::help::show(&command, &args) {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    let result = match command.as_str() {
        "doc_routing"
        | "collect_docs"
        | "resolve_doc_pins"
        | "seed_workspace_pins"
        | "open_doc_tab"
        | "open_document"
        | "render_html"
        | "render_mermaid"
        | "desktop"
        | "install"
        | "install_doc_tabs"
        | "install_preview"
        | "install_session_sleep"
        | "install_space_cleanup"
        | "install_voice"
        | "update_install"
        | "set_workspace_icon"
        | "media_image" => herdr_theme::documents::run(&command, &args),
        "pinned_system_metrics" => herdr_theme::automation::run(&command, &args),
        name if name.starts_with("pinned_") => herdr_theme::documents::run(&command, &args),
        "agent_sessions" | "space_job_evidence" | "model_tier" | "doc_catalog" | "site_config"
        | "file_lock" | "workspace_mods" | "app_backend" | "voice_policy" | "voice_settings" => {
            Ok(())
        }
        "close_finished_spaces" | "sleep_idle_sessions" | "session_sleep_stub" => {
            herdr_theme::observers::run(&command, &args)
        }
        name if name.starts_with("native_") => herdr_theme::observers::run(&command, &args),
        name if name.starts_with("voice_")
            || matches!(
                name,
                "focusq"
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
            ) =>
        {
            herdr_theme::voice::run(&command, &args)
        }
        _ => herdr_theme::automation::run(&command, &args),
    };
    if let Err(error) = result {
        if let Some(exit) = error.downcast_ref::<herdr_theme::voice::Exit>() {
            std::process::exit(exit.0);
        }
        if let Some(exit) = error.downcast_ref::<herdr_theme::common::CliError>() {
            if !exit.message.is_empty() {
                eprintln!("{}", exit.message);
            }
            std::process::exit(exit.code);
        }
        if matches!(command.as_str(), "route" | "collaborate") {
            println!("{}", serde_json::json!({"error":error.to_string()}));
        } else {
            eprintln!("{error}");
        }
        std::process::exit(1);
    }
}
