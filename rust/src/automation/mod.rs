pub mod bridge;
pub mod cli;
pub mod collaboration;
#[cfg(test)]
mod contracts;
pub mod format;
pub mod metrics;
pub mod routing;
pub mod tiers;
pub mod workflow;
pub mod workspace_focus;
use crate::common::*;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    process::Stdio,
    time::Duration,
};

pub const AGENT_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "CODEX_THREAD_ID",
];
pub const PANE_MARKERS: &[&str] = &["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];
pub fn launch_argv(argv: Vec<String>) -> Result<Vec<String>> {
    launch_argv_on(argv, cfg!(windows))
}
fn launch_argv_on(argv: Vec<String>, windows: bool) -> Result<Vec<String>> {
    if argv.is_empty() || argv.iter().any(String::is_empty) {
        return Err("argv must be non-empty strings".into());
    }
    if windows {
        return Ok(argv);
    }
    let mut result = vec!["env".into()];
    for marker in AGENT_MARKERS.iter().chain(PANE_MARKERS) {
        result.extend(["-u".into(), marker.to_string()]);
    }
    result.extend(argv);
    Ok(result)
}
pub fn rpc(method: &str, params: Value) -> Result<Value> {
    let mut child = command("hc")
        .arg("connect")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let result = (|| {
        let input = child.stdin.as_mut().ok_or("missing RPC stdin")?;
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
        )?;
        input.flush()?;
        let output = child.stdout.take().ok_or("missing RPC stdout")?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let read = std::io::BufReader::new(output).read_line(&mut line);
            let _ = tx.send(read.map(|_| line));
        });
        let reply: Value = serde_json::from_str(
            &rx.recv_timeout(Duration::from_secs(10))
                .map_err(|_| format!("{method} timed out"))??,
        )?;
        if reply.get("error").is_some() {
            return Err(reply["error"].to_string().into());
        }
        Ok(reply["result"].clone())
    })();
    drop(child.stdin.take());
    use wait_timeout::ChildExt;
    if child
        .wait_timeout(Duration::from_secs(2))
        .ok()
        .flatten()
        .is_none()
    {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
pub fn balance(node: &mut Value) {
    let equal = matches!(s(&node["type"]), "row" | "column");
    if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
        for child in children {
            if equal {
                child["size"] = json!({"weight":1});
            }
            balance(child);
        }
    }
}
pub fn leaves(node: &Value) -> Vec<Value> {
    if node["content"]["terminal"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        vec![node.clone()]
    } else {
        list(&node["children"]).iter().flat_map(leaves).collect()
    }
}
pub fn balance_grids(document: &mut Value) -> Vec<String> {
    let mut changed = vec![];
    if let Some(spaces) = document.get_mut("spaces").and_then(Value::as_array_mut) {
        for space in spaces {
            let name = s(&space["name"]).to_string();
            if let Some(tabs) = space.get_mut("tabs").and_then(Value::as_array_mut) {
                for tab in tabs {
                    let mut cells = leaves(&tab["root"]);
                    if cells.len() != 6 {
                        continue;
                    }
                    for c in &mut cells {
                        c["size"] = json!({"weight":1});
                    }
                    tab["root"] = json!({"id":tab["root"]["id"],"type":"column","children":[
                {"id":format!("sf-row-{}",uuid::Uuid::new_v4().simple()),"type":"row","size":{"weight":1},"children":cells[..3]},
                {"id":format!("sf-row-{}",uuid::Uuid::new_v4().simple()),"type":"row","size":{"weight":1},"children":cells[3..]}]});
                    changed.push(format!("{name} / {}", s(&tab["name"])));
                }
            }
        }
    }
    changed
}
pub fn computers(status: &Value) -> Result<Vec<Value>> {
    if status["BackendState"] != "Running" {
        return Err("Tailscale is not running".into());
    }
    let mut rows = vec![];
    if let Some(peers) = status["Peer"].as_object() {
        for peer in peers.values() {
            if !["windows", "macOS", "linux", "iOS", "iPadOS", "android"].contains(&s(&peer["OS"]))
            {
                continue;
            }
            let dns = s(&peer["DNSName"]).split('.').next().unwrap_or("");
            let name = if dns.is_empty() {
                s(&peer["HostName"])
            } else {
                dns
            };
            if name.is_empty() {
                continue;
            }
            rows.push(json!({"name":name,"host":peer.get("HostName").unwrap_or(&Value::String(name.into())),"ips":peer["TailscaleIPs"].as_array().cloned().unwrap_or_default(),"os":peer["OS"],"online":peer["Online"].as_bool()}));
        }
    }
    rows.sort_by(|a, b| s(&a["name"]).cmp(s(&b["name"])));
    Ok(rows)
}
fn collect_computers() -> Result<()> {
    print_line(&json_text(
        &collect_computers_with(
            &mut || {
                find_executable("tailscale")
                    .or_else(|| {
                        [
                            "/usr/local/bin/tailscale",
                            "/opt/homebrew/bin/tailscale",
                            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                        ]
                        .into_iter()
                        .find(|p| std::path::Path::new(p).is_file())
                        .map(std::path::PathBuf::from)
                    })
                    .ok_or_else(|| "Tailscale CLI unavailable".into())
            },
            &mut |executable, args, timeout| output(executable, args, timeout),
        ),
        true,
    ))
}
fn collect_computers_with(
    locate: &mut dyn FnMut() -> Result<std::path::PathBuf>,
    run: &mut dyn FnMut(&str, &[String], f64) -> Result<String>,
) -> Value {
    let result = (|| {
        let executable = locate()?;
        let status = serde_json::from_str(&run(
            &executable.to_string_lossy(),
            &strings(&["status", "--json"]),
            8.,
        )?)?;
        computers(&status)
    })();
    match result {
        Ok(peers) => json!({"peers":peers,"error":null}),
        Err(_) => json!({"peers":[],"error":"Tailscale status unavailable"}),
    }
}
fn workspace(args: &[String]) -> Result<()> {
    let positional = cli::positionals(args, &["--tiers", "--by"]);
    if positional.len() != 2 {
        return Err("workspace <name> <folder> [--agents|--shells] [--tiers tier]".into());
    }
    let agents = !flag(args, "--shells");
    let tier_arg = option(args, "--tiers");
    let spaces = call("herdr-app", &strings(&["ls"]))?;
    if list(&spaces["spaces"])
        .iter()
        .any(|s| s["name"] == positional[0])
    {
        return Err("Workspace already exists; refusing to duplicate it.".into());
    }
    if tier_arg.is_some() && !agents {
        return Err("--tiers는 에이전트 칸에만 쓸 수 있습니다(--shells와 함께 쓰지 않음).".into());
    }
    let site = site();
    let tier = if agents {
        Some(tiers::pane_tier(&site, tier_arg.as_deref())?)
    } else {
        None
    };
    let mut spec = json!({"name":positional[0],"folder":positional[1],"tab":"개발"});
    let mut launched = vec![];
    if let Some(tier) = tier {
        let (used, entry) = tiers::model_for("claude", &tier, &tiers::mapping(&site))?;
        let entry = tiers::first_pane_entry(&site, &used, entry);
        launched.push(json!({"kind":"claude","tier":tier,"tier_used":used,"model":entry["model"],"effort":entry["effort"]}));
        let mut argv = vec!["claude".into()];
        argv.extend(tiers::flags("claude", &entry));
        spec["argv"] = json!(launch_argv(argv)?);
    }
    let before = workspace_focus::view();
    let mut new = Value::Null;
    let creation = (|| -> Result<Value> {
        new = call(
            "herdr-app",
            &vec!["do".into(), "space.new".into(), json_text(&spec, true)],
        )?;
        let mut first = None;
        for _ in 0..40 {
            let observed = call("herdr-app", &strings(&["ls"]))?;
            for space in list(&observed["spaces"]) {
                for tab in list(&space["tabs"]) {
                    if let Some(t) = list(&tab["terminals"])
                        .iter()
                        .find(|t| t["terminal"] == new["terminal"])
                    {
                        first = Some(t.clone());
                        new["space"] = space["id"].clone();
                        new["tab"] = tab["id"].clone();
                    }
                }
            }
            if first.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let first = first
            .ok_or("Terminal created but not yet visible; inspect herdr-app ls before retrying.")?;
        call(
            "herdr-app",
            &vec![
                "do".into(),
                "space.rename".into(),
                json_text(&json!({"id":new["space"],"name":positional[0]}), true),
            ],
        )?;
        Ok(first)
    })();
    workspace_focus::restore(before.as_ref(), &new);
    let first = creation?;
    if agents {
        checked_output(
            "hc",
            &vec![
                "label".into(),
                s(&first["terminal"]).into(),
                "sixfold.native-agent=claude".into(),
            ],
        )?;
        launched[0]["terminal"] = first["terminal"].clone();
        let path = data().join("space-tiers.json");
        let mut book = read_json(&path).unwrap_or(json!({}));
        book[s(&new["space"])] = json!({"name":positional[0],"by":option(args,"--by").or_else(||std::env::var("HC_TERMINAL_ID").ok()),"at":now() as i64,"panes":launched});
        atomic(path, &book)?;
    }
    let mut result = json!({"space":new["space"],"tab":new["tab"],"terminals":[first]});
    if agents {
        result["tiers"] = json!(launched);
    }
    print(&result)
}
fn agent_env(args: &[String]) -> Result<()> {
    if args.is_empty() {
        return usage("agent_env <program> [arguments]");
    }
    let mut cmd = std::process::Command::new(&args[0]);
    cmd.args(&args[1..]);
    for k in AGENT_MARKERS {
        cmd.env_remove(k);
    }
    if std::env::var_os("HC_TERMINAL_ID").is_some_and(|value| !value.is_empty()) {
        for k in PANE_MARKERS {
            cmd.env_remove(k);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        return Err(cmd.exec().into());
    }
    #[cfg(not(unix))]
    {
        std::process::exit(cmd.status()?.code().unwrap_or(1));
    }
}
pub fn run(command: &str, args: &[String]) -> Result<()> {
    let Some(normalized) = cli::prepare(command, args)? else {
        return Ok(());
    };
    let args = normalized.as_slice();
    match command {
        "agent_env" => agent_env(args),
        "workspace" => workspace(args),
        "collect_computers" => collect_computers(),
        "system_metrics" => system_metrics(),
        "demo_agent" => demo_agent(args),
        "pinned_system_metrics" => metrics::run(args),
        "route" => routing::run(args),
        "collaborate" => collaboration::run(args),
        "collect_workflow" => workflow::run(args),
        "tui_bridge" => bridge::run(args),
        "core_api" | "balance_grid" => {
            let mut snap = rpc("doc.get", json!({"name":"herdr-app"}))?;
            let changed = if command == "balance_grid" {
                balance_grids(&mut snap["value"])
            } else {
                if let Some(spaces) = snap["value"]
                    .get_mut("spaces")
                    .and_then(Value::as_array_mut)
                {
                    for space in spaces {
                        if let Some(tabs) = space.get_mut("tabs").and_then(Value::as_array_mut) {
                            for tab in tabs {
                                balance(&mut tab["root"]);
                            }
                        }
                    }
                }
                vec![]
            };
            let result = rpc(
                "doc.set",
                json!({"name":"herdr-app","version":snap["version"],"value":snap["value"]}),
            )?;
            if command == "balance_grid" {
                print_line(&format::repr(
                    &json!({"balanced":changed,"version":result["version"]}),
                ))
            } else {
                print_line(&format::repr(&result))
            }
        }
        _ => Err(format!("unknown command: {command}").into()),
    }
}
fn system_metrics() -> Result<()> {
    if !cfg!(target_os = "macos") {
        return print(&json!({"error":"System metrics currently supports macOS only"}));
    }
    let result = (|| {
        let top = output(
            "/usr/bin/top",
            &strings(&["-l", "2", "-s", "1", "-n", "0"]),
            6.,
        )?;
        let re = regex::Regex::new(r"CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle")?;
        let sample = re
            .captures_iter(&top)
            .last()
            .ok_or("CPU sample unavailable")?;
        let idle: f64 = sample[3].parse()?;
        let vm = output("/usr/bin/vm_stat", &[], 6.)?;
        let page: u64 = regex::Regex::new(r"page size of (\d+) bytes")?
            .captures(&vm)
            .ok_or("VM page size unavailable")?[1]
            .parse()?;
        let mut used = 0;
        for cap in regex::Regex::new(r"(?m)^([^:\n]+):\s+(\d+)\.")?.captures_iter(&vm) {
            if [
                "Pages active",
                "Pages wired down",
                "Pages occupied by compressor",
            ]
            .contains(&&cap[1])
            {
                used += cap[2].parse::<u64>()?;
            }
        }
        let total: u64 = output("/usr/sbin/sysctl", &strings(&["-n", "hw.memsize"]), 6.)?
            .trim()
            .parse()?;
        Ok::<_, Box<dyn std::error::Error>>(
            json!({"cpu":format!("{:.1}",100.-idle).parse::<f64>()?,"memory":used*page,"total":total,"memoryDefinition":"active + wired + compressed physical pages"}),
        )
    })();
    match result {
        Ok(v) => print(&v),
        Err(e) => print(&json!({"error":e.to_string()})),
    }
}
fn demo_agent(args: &[String]) -> Result<()> {
    let name = args.first().ok_or("demo_agent <name> <state>")?;
    let state = args.get(1).ok_or("demo state required")?;
    let (color, lines) = match state.as_str() {
        "working" => (
            94,
            [
                "Inspecting the next change…",
                "Running the focused checks",
                "Keeping the workspace responsive",
            ],
        ),
        "blocked" => (
            93,
            [
                "A decision is ready for review.",
                "Choose an option in this terminal.",
                "Focus stays where you left it.",
            ],
        ),
        "done" => (
            92,
            [
                "Focused checks passed.",
                "The change is ready to inspect.",
                "Waiting for your review.",
            ],
        ),
        "idle" => (
            96,
            [
                "Session ready.",
                "Settings remain attached to this terminal.",
                "Waiting for a task.",
            ],
        ),
        _ => return Err("invalid demo state".into()),
    };
    print!("\x1b[2J\x1b[H\x1b]0;DEMO / {name}\x07\x1b]7501;state={state}:app=sixfold-demo\x1b\\\x1b[1;{color}mDEMO / {name}\x1b[0m\n\nExample workspace · no real project data\n\n");
    for line in lines {
        println!("  {line}");
    }
    println!("\n\x1b[2mStatus fixture for the Sixfold preview\x1b[0m");
    std::io::stdout().flush()?;
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_launch_argv_unsets_every_marker_then_runs_the_program() {
        let argv = launch_argv_on(strings(&["claude", "--resume", "x"]), false).unwrap();
        assert_eq!(argv[0], "env");
        assert_eq!(
            &argv[argv.len() - 3..],
            strings(&["claude", "--resume", "x"])
        );
        let mut actual = argv[2..argv.len() - 3]
            .iter()
            .step_by(2)
            .cloned()
            .collect::<Vec<_>>();
        actual.sort();
        let mut expected = AGENT_MARKERS
            .iter()
            .chain(PANE_MARKERS)
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(actual, expected);
        assert!(launch_argv_on(vec![], false).is_err());
    }
    #[test]
    fn test_windows_keeps_the_plain_argv() {
        assert_eq!(
            launch_argv_on(strings(&["claude"]), true).unwrap(),
            strings(&["claude"])
        );
    }
    #[test]
    fn test_desktop_and_mobile_names_preserve_network_status() {
        let peers = computers(&json!({"BackendState":"Running","Peer":{
            "a":{"DNSName":"desktop-test.tail.example.","HostName":"DESKTOP-TEST","OS":"windows","Online":true},
            "b":{"HostName":"offline","OS":"linux","Online":false},
            "c":{"HostName":"phone","OS":"iOS","Online":true},
            "d":{"HostName":"tablet","OS":"iPadOS","Online":false},
            "e":{"HostName":"android","OS":"android"}
        }})).unwrap();
        assert_eq!(
            peers
                .iter()
                .map(|v| json!([v["name"], v["online"]]))
                .collect::<Vec<_>>(),
            vec![
                json!(["android", null]),
                json!(["desktop-test", true]),
                json!(["offline", false]),
                json!(["phone", true]),
                json!(["tablet", false])
            ]
        );
        assert!(computers(&json!({"BackendState":"Stopped"})).is_err());
    }
    #[test]
    fn test_only_local_status_is_executed_and_failure_is_explicit() {
        let mut calls = vec![];
        let output = collect_computers_with(
            &mut || Ok("/test/tailscale".into()),
            &mut |executable, argv, timeout| {
                calls.push((executable.to_owned(), argv.to_vec(), timeout));
                Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "tailscale timed out").into())
            },
        );
        assert!(!output["error"].as_str().unwrap().is_empty());
        assert_eq!(
            calls,
            vec![("/test/tailscale".into(), strings(&["status", "--json"]), 8.)]
        );
    }
    #[test]
    fn grid_preserves_identity_order() {
        let mut d = json!({"spaces":[{"name":"한글","tabs":[{"name":"개발","root":{"id":"r","type":"row","children":(0..6).map(|i|json!({"id":i,"content":{"terminal":format!("t{i}")}})).collect::<Vec<_>>()}}]}]});
        let old = leaves(&d["spaces"][0]["tabs"][0]["root"]);
        assert_eq!(balance_grids(&mut d), vec!["한글 / 개발"]);
        let new = leaves(&d["spaces"][0]["tabs"][0]["root"]);
        assert_eq!(
            old.iter().map(|v| &v["content"]).collect::<Vec<_>>(),
            new.iter().map(|v| &v["content"]).collect::<Vec<_>>()
        );
    }
    #[test]
    fn peers_filter_sort_and_do_not_claim_connection() {
        let p=computers(&json!({"BackendState":"Running","Peer":{"a":{"OS":"linux","DNSName":"z.test","Online":true},"b":{"OS":"windows","HostName":"a","Online":"yes"},"c":{"OS":"plan9","HostName":"bad"}}})).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0]["name"], "a");
        assert!(p[0]["online"].is_null());
        assert!(computers(&json!({"BackendState":"Stopped"})).is_err());
    }
}
