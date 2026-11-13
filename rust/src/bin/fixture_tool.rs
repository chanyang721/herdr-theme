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
    let invoked_program = program.clone();
    if program == "workflow-gui-parent" && config["allowWorkflowConsole"] == true {
        if !argv.is_empty() {
            return Err("workflow GUI parent takes no fixture arguments".into());
        }
        let parent_console = has_console();
        let child = herdr_theme::automation::workflow::hc_with(&["ls", "--json"], |cmd| {
            herdr_theme::common::capture_cmd(cmd, 10.)
        })?;
        return herdr_theme::common::print(&json!({"parentConsole":parent_console,"child":child}));
    }
    if program == "hc" && config["allowWorkflowConsole"] == true {
        if argv != ["ls", "--json"] {
            return Err("workflow console fixture only accepts hc ls --json".into());
        }
        return herdr_theme::common::print(&json!({"console":has_console()}));
    }
    if program == "ego" && config["allowDesktopBrowser"] == true {
        let root = Path::new(&path).parent().ok_or("fixture parent missing")?;
        if argv.len() != 1 || !fs::canonicalize(&argv[0])?.starts_with(fs::canonicalize(root)?) {
            return Err("desktop fixture only accepts its scratch document".into());
        }
        fs::write(
            root.join("desktop-child.json"),
            json!({"has_console":has_console(),"args":argv}).to_string(),
        )?;
        return Ok(());
    }
    if program == "render-html" && config["allowHtmlRenderer"] == true {
        if argv.len() != 4 || !["dark", "light"].contains(&argv[2].as_str()) {
            return Err("HTML fixture requires doc,prefix,theme,width".into());
        }
        let doc = Path::new(&argv[0]);
        let root = Path::new(&path).parent().ok_or("fixture parent missing")?;
        if !fs::canonicalize(doc)?.starts_with(fs::canonicalize(root)?) {
            return Err("HTML fixture only reads its scratch document".into());
        }
        let prefix = Path::new(&argv[1]);
        if !prefix
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("html-"))
        {
            return Err("HTML fixture prefix refused".into());
        }
        let width: u32 = argv[3].parse()?;
        let runs = doc.with_extension("runs");
        let count: u32 = fs::read_to_string(&runs)
            .unwrap_or_else(|_| "0".into())
            .parse()?;
        fs::write(runs, (count + 1).to_string())?;
        for (number, height) in [2000u32, 300].into_iter().enumerate() {
            let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
            png.extend((width * 2).to_be_bytes());
            png.extend((height * 2).to_be_bytes());
            fs::write(format!("{}-{number}.png", prefix.display()), png)?;
        }
        println!(
            "{}",
            json!({"tiles":[{"width":width,"height":2000},{"width":width,"height":300}]})
        );
        return Ok(());
    }
    if program == "collaboration-intake-contract" && config["allowCollaborationIntake"] == true {
        let action = argv.get(1).map(String::as_str).unwrap_or("");
        let request: Value = serde_json::from_str(argv.get(3).ok_or("request missing")?)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(env::var("HERDR_TEST_CALL_LOG")?)?;
        writeln!(
            file,
            "{}",
            json!({"program":program,"action":action,"request":request,"actor":env::var("HC_TERMINAL_ID").ok()})
        )?;
        if action == "drain" {
            if let Some(delay) = config["intakeDrainDelayMs"].as_u64() {
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
        }
        if action == "status" && request.is_array() {
            if config["intakeStatusRefuse"] == true {
                return Err("status service unavailable".into());
            }
            let rows: Vec<Value> = request
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let released = config["intakeSettled"] == true
                        || config["intakeReleasedIds"]
                            .as_array()
                            .is_some_and(|ids| ids.contains(&r["id"]));
                    json!({"id":r["id"],"ownership_released":released})
                })
                .collect();
            return herdr_theme::common::print(&json!(rows));
        }
        if config["intakeRefuse"] == true {
            return Err("verified originating agent required".into());
        }
        if request["source"] != env::var("HC_TERMINAL_ID").unwrap_or_default() {
            return Err("origin mismatch".into());
        }
        let state = if action == "drain" {
            if config["intakeBlocked"] == true {
                "blocked"
            } else {
                "handed_off"
            }
        } else if action == "local" {
            "local_active"
        } else {
            "pending"
        };
        return herdr_theme::common::print(
            &json!({"state":state,"result":{"parts":[{"task_id":"fixture-task","address":"helper1","outcome":"sent"}]}}),
        );
    }
    if ["route-dispatch-contract", "route-candidates-contract"].contains(&program.as_str())
        && config["allowOriginalRoute"] == true
    {
        let spaces = config["spaces"]
            .as_array()
            .ok_or("original route spaces missing")?;
        let terminals = config["terminals"]
            .as_array()
            .ok_or("original route terminals missing")?;
        let request = &config["dispatchRequest"];
        let value = if program == "route-dispatch-contract" {
            herdr_theme::automation::routing::dispatch(request, spaces, terminals)?
        } else {
            let result = herdr_theme::automation::routing::candidates(
                spaces,
                terminals,
                request["source"].as_str().ok_or("source missing")?,
                request["project"].as_str().ok_or("project missing")?,
                request["tier"].as_str().unwrap_or("high"),
                config.get("sessionModels").unwrap_or(&Value::Null),
                config.get("tierMapping").unwrap_or(&Value::Null),
            )?;
            json!(result)
        };
        return herdr_theme::common::print(&value);
    }
    if config["allowVoice"] == true {
        if program == "voice-contract" {
            use herdr_theme::voice::{self, queue};
            let id = argv.get(1).map(String::as_str).unwrap_or("pane");
            let result: Result<Value, Box<dyn std::error::Error>> =
                match argv.first().map(String::as_str) {
                    Some("screen") => queue::screen(id).map(|v| json!(v)),
                    Some("send") => queue::send_keys(id, &["f8"]).map(|_| json!(true)),
                    Some("front") => queue::front_is_app().map(|v| json!(v)),
                    Some("session") => queue::session_of(&config["voicePane"]).map(|v| json!(v)),
                    Some("targets") => queue::targets().map(|v| json!(v)),
                    Some("panes") => queue::panes().map(|v| json!(v)),
                    Some("event") => queue::main_event(false).map(|_| json!(true)),
                    Some("listen") => queue::listen(id).map(|_| json!(true)),
                    Some("checked") => voice::checked_stdout(
                        config["voiceCommand"]
                            .as_str()
                            .ok_or("voice command missing")?,
                        &["checked"],
                        None,
                    )
                    .map(|v| json!(v)),
                    _ => return Err("unsupported voice-contract action".into()),
                };
            let reply = match result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"class":voice::error_class(error.as_ref())}),
            };
            return herdr_theme::common::print(&reply);
        }
        let log = env::var("HERDR_TEST_CALL_LOG")?;
        let mut file = OpenOptions::new().create(true).append(true).open(log)?;
        writeln!(file, "{}", json!({"program":invoked_program,"args":argv}))?;
        let responses = config["voiceResponses"]
            .as_array()
            .ok_or("voice response map missing")?;
        let response = responses
            .iter()
            .find(|r| r["program"] == invoked_program && r["args"] == json!(argv))
            .ok_or_else(|| {
                format!("unconfigured voice fixture argv: {invoked_program} {argv:?}")
            })?;
        let delay = response["delay_ms"].as_u64().unwrap_or(0);
        if delay > 6000 {
            return Err("voice fixture delay exceeds6s".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(delay));
        std::io::stdout().write_all(response["stdout"].as_str().unwrap_or("").as_bytes())?;
        std::io::stderr().write_all(response["stderr"].as_str().unwrap_or("").as_bytes())?;
        std::process::exit(response["code"].as_i64().unwrap_or(0) as i32);
    }
    if program == "herdr-core" && config["allowObserver"] == true {
        program = "hc".into();
    }
    if program == "process-contract" {
        return process_contract(&config, &argv, &path);
    }
    if program == "legacy-stdio-contract" {
        if config["allowLegacyText"] != true {
            return Err("legacy text fixture was not explicitly enabled".into());
        }
        let text = config["text"]
            .as_str()
            .ok_or("synthetic legacy text missing")?;
        if !["ASCII\n", "\u{ac00}\u{b098}\n", "\u{1f600}\n"].contains(&text) {
            return Err("legacy fixture text is not synthetic".into());
        }
        let result = (|| -> herdr_theme::legacy_text::Result<()> {
            herdr_theme::legacy_text::stdout(text)?;
            herdr_theme::legacy_text::stdout("second\n")?;
            herdr_theme::legacy_text::stderr(text)
        })();
        if let Err(error) = result {
            herdr_theme::legacy_text::error_line(&error.to_string())?;
            std::process::exit(1);
        }
        return Ok(());
    }
    if program == "workspace-api-contract" && config["allowDelayedReply"] == true {
        let reply = herdr_theme::common::call(
            "herdr-app",
            &herdr_theme::common::strings(&["do", "fixture", "{}"]),
        )?;
        return herdr_theme::common::print(&reply);
    }
    if program == "http-contract" && config["allowLoopbackHttps"] == true {
        let url = config["url"].as_str().ok_or("fixture HTTPS URL missing")?;
        if !url.starts_with("https://127.0.0.1:") {
            return Err("only explicit loopback HTTPS fixture is permitted".into());
        }
        let value = match herdr_theme::documents::pinned::plan::http(url, &[], None, false) {
            Ok(value) => value,
            Err(error) => {
                // Diagnostic detail is restricted to this explicitly enabled
                // loopback fixture; production provider errors stay private.
                let detail = herdr_theme::tls::blocking_builder()?
                    .build()?
                    .get(url)
                    .send()
                    .err();
                return Err(
                    format!("loopback HTTPS fixture: {error}; transport: {detail:?}").into(),
                );
            }
        };
        return herdr_theme::common::print(&value);
    }
    if program == "json-error-contract" {
        if config["allowProcessContract"] != true {
            return Err("process contract not enabled".into());
        }
        herdr_theme::common::print(&json!({"error":"synthetic process failure"}))?;
        return Err(Box::new(herdr_theme::common::CliError {
            code: 1,
            message: String::new(),
        }));
    }
    if program == "herdr" && config["allowWorkflow"] == true {
        if !matches!(argv.first().map(String::as_str), Some("pane")) {
            return Err("workflow fixture only permits pane reads".into());
        }
        println!("{}", config["workflowReply"]);
        std::process::exit(config["workflowExit"].as_i64().unwrap_or(0) as i32);
    }
    if !["hc", "herdr-app"].contains(&program.as_str()) {
        return Err("unsupported fixture tool name".into());
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
    let record = json!({"program":invoked_program,"args":argv,"actor":env::var("HC_TERMINAL_ID").ok(),"queue":queue,"ledger":ledger,"leases":leases,"has_console":has_console(),"rpc":rpc_request});
    let mut f = OpenOptions::new().create(true).append(true).open(log)?;
    writeln!(f, "{record}")?;
    drop(f);
    if config["allowDelayedReply"] == true {
        let millis = config["replyDelayMs"].as_u64().unwrap_or(0);
        if millis > 35_000 {
            return Err("fixture delay exceeds 35s".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(millis));
        if program == "herdr-app" {
            println!("{}", config["delayedReply"]);
            return Ok(());
        }
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
                            let id = if config["originalSeedIds"] == true {
                                format!("generated-{}", argv[3])
                            } else {
                                format!("created-{index}")
                            };
                            state["spaces"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!({"id":id,"name":argv[3],"machine":null}));
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
            if config["allowWorkspaceFocus"] == true
                && argv == ["label", "new-terminal", "sixfold.native-agent=claude"]
            {
                println!("{}", json!({"labeled":true}));
                return Ok(());
            }
            return Err("fixture label operation refused".into());
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
            let fact=config["get"].get(target).cloned().unwrap_or(json!({"address":target,"state":"live","status":{"state":config["getState"].as_str().unwrap_or("idle")}}));

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
