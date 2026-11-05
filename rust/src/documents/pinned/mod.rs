//! Python-free adapters for the exact Workspace Mods release bundled by this theme.
pub mod agent;
pub mod plan;
pub mod sessions;
pub mod status;
use super::common::*;
pub fn run(command: &str, args: &[String]) -> Result<()> {
    match command {
        "pinned_agent_usage" => agent::collect_cli(args),
        "pinned_scan_insights" => agent::scan_cli(args),
        "pinned_plan_usage" => plan::usage_cli(args),
        "pinned_codex_resets" => plan::resets_cli(args),
        "pinned_cli_status" => status::cli_status(args),
        "pinned_mcp_status" => status::mcp_status(args),
        _ => Err(format!("Unknown pinned helper {command}").into()),
    }
}
