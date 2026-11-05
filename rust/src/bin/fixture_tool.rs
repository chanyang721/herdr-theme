//! Native subprocess fixture used exclusively by integration tests. It has no
//! transport implementation and refuses to run without an explicit fixture file.
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{BufRead, Write},
    path::Path,
};
fn read(path: impl AsRef<Path>) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn rpc_reply(
    config: &Value,
    fixture_path: &str,
    request: &Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let failure = |code: i32, message: &str| json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}});
    if !config["rpc"].is_object() {
        return Ok(failure(-32601, "fixture RPC was not configured"));
    }
    if request["jsonrpc"] != "2.0" || !request["params"].is_object() {
        return Ok(failure(-32600, "invalid fixture request"));
    }
    if request["params"]["name"] != "herdr-app" {
        return Ok(failure(
            -32602,
            "only the fixture herdr-app document is permitted",
        ));
    }
    let state_path = Path::new(fixture_path)
        .parent()
        .ok_or("fixture parent missing")?
        .join("rpc-state.json");
    let mut state=read(&state_path).unwrap_or(json!({"version":config["rpc"]["version"].as_u64().unwrap_or(7),"value":config["rpc"]["document"]}));
    let result = match request["method"].as_str().unwrap_or("") {
        "doc.get" => state.clone(),
        "doc.set" => {
            if config["rpc"]["rejectSet"] == true {
                return Ok(failure(-32009, "fixture version conflict"));
            }
            if request["params"]["version"] != state["version"] {
                return Ok(failure(-32009, "fixture version conflict"));
            }
            if !request["params"]["value"].is_object() {
                return Ok(failure(-32602, "fixture document must be an object"));
            }
            state["version"] = json!(state["version"].as_u64().unwrap_or(7) + 1);
            state["value"] = request["params"]["value"].clone();
            json!({"version":state["version"]})
        }
        _ => return Ok(failure(-32601, "fixture method refused")),
    };
    fs::write(state_path, state.to_string())?;
    Ok(json!({"jsonrpc":"2.0","id":id,"result":result}))
}
fn has_console() -> bool {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetConsoleWindow() -> *mut std::ffi::c_void;
        }
        !unsafe { GetConsoleWindow() }.is_null()
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn process_contract(
    config: &Value,
    args: &[String],
    fixture_path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if config["allowProcessContract"] != true {
        return Err("process-contract fixture mode was not explicitly enabled".into());
    }
    let exit = args
        .first()
        .map(|s| s.parse::<i32>())
        .transpose()?
        .unwrap_or(0);
    if !(0..=125).contains(&exit) {
        return Err("fixture exit must be 0..125".into());
    }
    let mut markers = json!({});
    for key in [
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
        "HERDR_PANE_ID",
        "HERDR_TAB_ID",
        "HERDR_WORKSPACE_ID",
        "HC_TERMINAL_ID",
        "HERDR_TEST_PRESERVED",
    ] {
        if let Ok(value) = env::var(key) {
            markers[key] = json!(if value.starts_with("fixture-") || value.is_empty() {
                value
            } else {
                "<nonfixture>".into()
            });
        }
    }
    let expected = Path::new(fixture_path)
        .parent()
        .unwrap_or(Path::new("."))
        .join("workspace");
    let same_cwd = std::env::current_dir()
        .ok()
        .and_then(|p| fs::canonicalize(p).ok())
        .zip(fs::canonicalize(expected).ok())
        .is_some_and(|(a, b)| a == b);
    if config["allowPtyReceipt"] == true {
        print!("FIXTURE_AGENT ");
    }
    println!(
        "{}",
        json!({"markers":markers,"has_console":has_console(),"arguments":args.get(1..).unwrap_or_default(),"cwdMatchesFixture":same_cwd})
    );
    std::io::stdout().flush()?;
    std::process::exit(exit)
}
fn main() {
    if let Err(e) = run() {
        if let Some(exit) = e.downcast_ref::<herdr_theme::common::CliError>() {
            if !exit.message.is_empty() {
                eprintln!("{}", exit.message)
            }
            std::process::exit(exit.code)
        }
        eprintln!("fixture: {e}");
        std::process::exit(2)
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::var("HERDR_TEST_FIXTURE")
        .map_err(|_| "HERDR_TEST_FIXTURE is required; no real service is contacted")?;
    let config = read(&path).ok_or("fixture JSON unreadable")?;
    let mut argv = env::args().collect::<Vec<_>>();
    let mut program = Path::new(&argv.remove(0))
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if program == "herdr-theme-test-fixture" {
        if argv.is_empty() {
            return Err("fixture tool name required".into());
        }
        program = argv.remove(0);
    }
    if program == "process-contract" {
        return process_contract(&config, &argv, &path);
    }
    if program == "observer-error-contract" {
        if config["allowProcessContract"] != true {
            return Err("observer-error-contract was not explicitly enabled".into());
        }
        let parent = Path::new(&path).parent().ok_or("fixture parent missing")?;
        return herdr_theme::observers::spaces::finish(
            &parent.join("observer-state.json"),
            &parent.join("observer-log.jsonl"),
            &json!({}),
            &json!({"at":"2000-01-01T00:00:00+00:00","mode":"dry-run","error":"synthetic observer failure","results":[]}),
            false,
        );
    }
    if !["hc", "herdr-app", "observer-harness", "ps", "lsof"].contains(&program.as_str()) {
        return Err("unsupported fixture tool name".into());
    }
    if ["observer-harness", "ps", "lsof"].contains(&program.as_str())
        && config["allowObserver"] != true
    {
        return Err("observer-only fixture role was not explicitly enabled".into());
    }
    let command = argv.first().map(String::as_str).unwrap_or("");
    let rpc_request = if program == "hc" && command == "connect" {
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        Some(serde_json::from_str::<Value>(&line)?)
    } else {
        None
    };
    let log = env::var("HERDR_TEST_CALL_LOG")?;
    let previous = fs::read_to_string(&log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect::<Vec<_>>();
    let app_reads = previous
        .iter()
        .filter(|r| r["program"] == "herdr-app" && r["args"][0] == "ls")
        .count();
    let data = env::var("HERDR_APP_HOME")
        .map(|h| Path::new(&h).join("data/sixfold"))
        .unwrap_or_default();
    let queue = read(data.join("routing-queue.json")).unwrap_or(Value::Null);
    let ledger = read(data.join("collaboration-tasks.json")).unwrap_or(Value::Null);
    let leases = fs::read_dir(data.join("collaboration-leases"))
        .map(|r| {
            r.filter_map(|r| r.ok())
                .filter(|r| r.path().extension().is_some_and(|x| x == "json"))
                .count()
        })
        .unwrap_or(0);
    let record = json!({"program":program,"args":argv,"actor":env::var("HC_TERMINAL_ID").ok(),"queue":queue,"ledger":ledger,"leases":leases,"has_console":has_console(),"rpc":rpc_request});
    let mut f = OpenOptions::new().create(true).append(true).open(log)?;
    writeln!(f, "{record}")?;
    drop(f);
    if program == "observer-harness" {
        let parent = Path::new(&path).parent().ok_or("fixture parent missing")?;
        match command {
            "close-status" => {
                if config["observerScenario"] == "missing-report" {
                    println!("{}", json!({"ok":false}));
                } else {
                    println!(
                        "{}",
                        json!({"ok":true,"report_id":"fixture-report","task_id":"fixture-task"})
                    );
                }
            }
            "park" => {
                let event = argv
                    .iter()
                    .position(|a| a == "--event")
                    .and_then(|i| argv.get(i + 1))
                    .map(String::as_str)
                    .unwrap_or("");
                if ![
                    "close_requested",
                    "close_aborted",
                    "closed",
                    "suspended",
                    "resumed",
                ]
                .contains(&event)
                {
                    return Err("fixture park event refused".into());
                }
                if event == "close_requested" {
                    fs::write(parent.join("observer-parked.json"), "true")?;
                }
                println!("{}", json!({"id":"fixture-record"}));
            }
            _ => return Err("fixture harness action refused".into()),
        }
        return Ok(());
    }
    if program == "ps" {
        if argv.get(0).map(String::as_str) != Some("-axo") {
            return Err("fixture ps operation refused".into());
        }
        let column = argv.get(1).map(String::as_str).unwrap_or("");
        for row in config["observerProcesses"]
            .as_array()
            .ok_or("fixture process rows missing")?
        {
            match column {
                "pid=,ppid=,comm=" => println!(
                    "{} {} {}",
                    row["pid"].as_u64().ok_or("fixture pid missing")?,
                    row["parent"].as_u64().ok_or("fixture parent missing")?,
                    row["name"].as_str().ok_or("fixture name missing")?
                ),
                "pid=,args=" => println!(
                    "{} {}",
                    row["pid"].as_u64().ok_or("fixture pid missing")?,
                    row["args"].as_str().ok_or("fixture args missing")?
                ),
                _ => return Err("fixture ps columns refused".into()),
            }
        }
        return Ok(());
    }
    if program == "lsof" {
        if argv.first().map(String::as_str) != Some("-n")
            || argv.last().map(String::as_str) != Some("-Fn")
        {
            return Err("fixture lsof operation refused".into());
        }
        println!(
            "n{}",
            config["observerRollout"]
                .as_str()
                .ok_or("fixture rollout missing")?
        );
        return Ok(());
    }
    if program == "herdr-app" {
        if config["allowWorkspaceFocus"] == true {
            let parent = Path::new(&path).parent().ok_or("fixture parent missing")?;
            let state_path = parent.join("workspace-focus-state.json");
            let mut state = read(&state_path).unwrap_or_else(|| json!({"space":"old-space","tab":"old-tab","focused_pane":"old-pane","spaces":[{"id":"old-space","name":"Original","tabs":[{"id":"old-tab","terminals":[{"terminal":"old-terminal","pane":"old-pane"}]}]},{"id":"other-space","name":"Other","tabs":[{"id":"other-tab","terminals":[{"terminal":"other-terminal","pane":"other-pane"}]}]}]}));
            let mut reply = json!({});
            match command {
                "ls" => reply = json!({"spaces":state["spaces"]}),
                "status" => {
                    reply = json!({"space":state["space"],"tab":state["tab"],"focused_pane":state["focused_pane"]})
                }
                "do" if argv.len() == 3 => {
                    let parameter: Value = serde_json::from_str(&argv[2])?;
                    match argv[1].as_str() {
                        "space.new" => {
                            state["spaces"].as_array_mut().unwrap().push(json!({"id":"new-space","name":parameter["name"],"tabs":[{"id":"new-tab","terminals":[{"terminal":"new-terminal","pane":"new-pane"}]}]}));
                            state["space"] = json!("new-space");
                            state["tab"] = json!("new-tab");
                            state["focused_pane"] = json!("new-pane");
                            if config["workspaceFocusScenario"] == "named-concurrent-selection" {
                                state["spaces"][1]["tabs"].as_array_mut().unwrap().push(json!({"id":"concurrent-tab","terminals":[{"terminal":"concurrent-terminal","pane":"concurrent-pane"}]}));
                                state["space"] = json!("other-space");
                                state["tab"] = json!("concurrent-tab");
                                state["focused_pane"] = json!("concurrent-pane");
                            }
                            fs::write(&state_path, state.to_string())?;
                            if config["workspaceFocusScenario"] == "partial-create-error" {
                                eprintln!("synthetic partial workspace creation failure");
                                std::process::exit(1)
                            }
                            reply = json!({"space":"new-space","tab":"new-tab","pane":"new-pane","terminal":"new-terminal"});
                        }
                        "space.rename" => {}
                        "space.select" => state["space"] = parameter["id"].clone(),
                        "tab.select" => state["tab"] = parameter["id"].clone(),
                        "pane.focus" => state["focused_pane"] = parameter["pane"].clone(),
                        _ => return Err("workspace-focus fixture action refused".into()),
                    }
                }
                _ => return Err("workspace-focus fixture command refused".into()),
            }
            fs::write(state_path, state.to_string())?;
            println!("{reply}");
            return Ok(());
        }
        if config["allowWorkspaceSeed"] == true {
            let parent = Path::new(&path).parent().ok_or("fixture parent missing")?;
            let state_path = parent.join("seed-state.json");
            let mut state = read(&state_path).unwrap_or_else(|| json!({"spaces":config["spaces"],"space":config["seedStatus"]["space"],"focused_pane":config["seedStatus"]["focused_pane"]}));
            match command {
                "ls" => println!("{}", json!({"spaces":state["spaces"]})),
                "status" => println!(
                    "{}",
                    json!({"space":state["space"],"focused_pane":state["focused_pane"]})
                ),
                "do" => {
                    match argv.get(1).map(String::as_str) {
                        Some("space.new")
                            if argv.len() == 6
                                && argv[2] == "--name"
                                && argv[4] == "--machine"
                                && argv[5].is_empty() =>
                        {
                            // Creation changes focus even when it fails; the caller must
                            // execute its finally restoration through real subprocesses.
                            state["space"] = json!("new-selection");
                            state["focused_pane"] = json!("new-pane");
                            if config["seedFailCreate"] == true {
                                fs::write(&state_path, state.to_string())?;
                                eprintln!("synthetic workspace creation failure");
                                std::process::exit(1)
                            }
                            let index = state["spaces"]
                                .as_array()
                                .ok_or("seed spaces missing")?
                                .len();
                            state["spaces"].as_array_mut().unwrap().push(json!({"id":format!("created-{index}"),"name":argv[3],"machine":null}));
                        }
                        Some("space.select") if argv.len() == 4 && argv[2] == "--id" => {
                            state["space"] = json!(argv[3])
                        }
                        Some("pane.focus") if argv.len() == 4 && argv[2] == "--pane" => {
                            state["focused_pane"] = json!(argv[3])
                        }
                        _ => return Err("workspace-seed fixture action refused".into()),
                    }
                    println!("{{}}");
                }
                _ => return Err("workspace-seed fixture command refused".into()),
            }
            fs::write(state_path, state.to_string())?;
            return Ok(());
        }
        if command == "status" && config["allowObserver"] == true {
            println!("{}", config["observerStatus"]);
            return Ok(());
        }
        if command != "ls" {
            return Err("fixture herdr-app only supports ls".into());
        }
        if config["appFailAfter"]
            .as_u64()
            .is_some_and(|n| app_reads >= n as usize)
        {
            eprintln!("fixture app snapshot unavailable");
            std::process::exit(1)
        }
        println!("{}", json!({"spaces":config["spaces"]}));
        return Ok(());
    }
    match command {
        "label" => {
            if config["allowPtyReceipt"] != true
                || argv.get(1).map(String::as_str) != Some("fixture-stub")
                || argv.get(2..).unwrap_or_default()
                    != ["sixfold.sleep=", "sixfold.title=", "sixfold.sleep.new="]
            {
                return Err("fixture label operation refused".into());
            }
            let parent = Path::new(&path).parent().ok_or("fixture parent missing")?;
            fs::write(
                parent.join("cleared-labels.json"),
                json!({"sixfold.sleep":"","sixfold.title":"","sixfold.sleep.new":""}).to_string(),
            )?;
            println!("{}", json!({"labeled":true}));
        }
        "connect" => println!(
            "{}",
            rpc_reply(
                &config,
                &path,
                rpc_request.as_ref().ok_or("fixture RPC request missing")?
            )?
        ),
        "ls" => println!("{}", json!({"terminals":config["terminals"]})),
        "get" => {
            let target = argv.get(1).map(String::as_str).unwrap_or("");
            let mut fact=config["get"].get(target).cloned().unwrap_or(json!({"address":target,"state":"live","status":{"state":config["getState"].as_str().unwrap_or("idle")}}));
            if config["allowObserver"] == true
                && target == "fixture-target"
                && Path::new(&path)
                    .parent()
                    .unwrap()
                    .join("observer-parked.json")
                    .exists()
            {
                match config["observerScenario"].as_str().unwrap_or("") {
                    "working-after-park" => fact["status"]["state"] = json!("working"),
                    "identity-after-park" => {
                        fact["created_ms"] = json!(fact["created_ms"].as_u64().unwrap_or(0) + 1)
                    }
                    _ => {}
                }
            }
            println!("{fact}")
        }
        "read" => {
            let target = argv.get(1).map(String::as_str).unwrap_or("");
            let screen = config["screens"][target]
                .as_str()
                .or(config["screen"].as_str())
                .unwrap_or("완료했습니다.\n› Ask Codex to do anything");
            println!("{}", json!({"text":screen,"complete":true,"how":"screen"}))
        }
        "send" => {
            let target = argv.get(1).map(String::as_str).unwrap_or("");
            let mode = config["targetModes"][target]
                .as_str()
                .or(config["sendMode"].as_str())
                .unwrap_or("ok");
            match mode {
                "ok" => println!("{}", json!({"started":true,"turn":1})),
                "ambiguous" => {
                    println!("{}", json!({"error":{"kind":"connection_lost"}}));
                    std::process::exit(1)
                }
                "reject" => {
                    println!("{}", json!({"error":{"kind":"status_mismatch"}}));
                    std::process::exit(1)
                }
                "error_success" => println!("{}", json!({"error":{"kind":"connection_lost"}})),
                "crash" => std::process::exit(61),
                "malformed" => println!("unreadable receipt"),
                other => return Err(format!("unknown synthetic send mode: {other}").into()),
            }
        }
        other => return Err(format!("unsupported fixture hc command: {other}").into()),
    }
    Ok(())
}
