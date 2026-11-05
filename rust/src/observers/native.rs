//! Manual native integration probes. Every mutation targets a disposable app/core.
pub use super::native_ui::ui_reload;
use super::*;
use std::collections::BTreeMap;
struct Environment {
    vars: BTreeMap<String, String>,
}
impl Environment {
    fn new(values: &Value) -> Self {
        let mut vars: BTreeMap<_, _> = std::env::vars().collect();
        if let Some(o) = values.as_object() {
            for (k, v) in o {
                vars.insert(k.clone(), s(v).into());
            }
        }
        vars.remove("HC_TERMINAL_ID");
        vars.remove("HERDR_PANE_ID");
        Self { vars }
    }
    fn run(&self, argv: &[String], actor: Option<&str>, check: bool) -> Result<Output> {
        let o = execute_with(argv, 20., false, |c| {
            c.env_clear().envs(&self.vars);
            if let Some(a) = actor {
                c.env("HC_TERMINAL_ID", a);
            }
        })?;
        if check && o.code != 0 {
            return err(format!(
                "{:?}: {}{}",
                argv.iter().take(4).collect::<Vec<_>>(),
                o.stderr,
                o.stdout
            ));
        }
        Ok(o)
    }
    fn value(&self, argv: &[String], actor: Option<&str>) -> Result<Value> {
        let o = self.run(argv, actor, true)?;
        Ok(serde_json::from_str(&o.stdout)?)
    }
}
fn exe() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}
fn repo(args: &[String]) -> PathBuf {
    args.iter()
        .position(|a| a == "--repo")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_owned()
        })
}
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}
fn check(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        err(message)
    }
}
fn write(path: &Path, t: &str) -> Result<()> {
    fs::write(path, t)?;
    Ok(())
}
fn json_write(path: &Path, v: &Value) -> Result<()> {
    write(path, &v.to_string())
}
fn wait(
    base: &Path,
    label: &str,
    receipts: &mut Vec<Value>,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(12) {
        if let Ok(state) = load(base.join("state.json"), Value::Null) {
            if predicate(&state) {
                receipts.push(json!({"case":label,"seconds":(start.elapsed().as_secs_f64()*1000.).round()/1000.}));
                return Ok(state);
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    err(label)
}
fn shot(env: &Environment, base: &Path, name: &str) -> Result<()> {
    env.run(
        &strings(&[
            "herdr-app",
            "shot",
            &base.join(format!("{name}.png")).to_string_lossy(),
        ]),
        None,
        true,
    )?;
    Ok(())
}
pub fn doc_tabs(args: &[String]) -> Result<()> {
    let path = args
        .first()
        .ok_or_else(|| std::io::Error::other("disposable session directory required"))?;
    let base = fs::canonicalize(path)?;
    let tmp = fs::canonicalize("/tmp")?;
    check(
        base.parent() == Some(tmp.as_path())
            && base
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with("docs-tabs-"),
        "Use only the disposable docs-tabs session",
    )?;
    let vars = load(base.join("env.json"), Value::Null)?;
    check(
        fs::canonicalize(s(&vars["HERDR_APP_HOME"]))? == base.join("app"),
        "Disposable app home required",
    )?;
    let env = Environment::new(&vars);
    let mut receipts = vec![];
    let source = base.join("project/table.md");
    let original = fs::read_to_string(&source)?;
    wait(
        &base,
        "initial native Markdown and image staging",
        &mut receipts,
        |s| s["blocks"] == 3 && !truth(&s["error"]),
    )?;
    shot(&env, &base, "native-table-image")?;
    let temporary = source.with_extension("next");
    write(&temporary, &format!("{original}\n\nATOMIC-SAVE-VERIFIED\n"))?;
    fs::rename(temporary, &source)?;
    wait(&base, "atomic rename reload", &mut receipts, |v| {
        s(&v["text"]).contains("ATOMIC-SAVE-VERIFIED")
    })?;
    fs::remove_file(&source)?;
    wait(
        &base,
        "missing source keeps last successful body",
        &mut receipts,
        |v| truth(&v["error"]) && s(&v["text"]).contains("ATOMIC-SAVE-VERIFIED"),
    )?;
    shot(&env, &base, "native-missing")?;
    write(&source, &original)?;
    wait(&base, "source restore recovers", &mut receipts, |v| {
        !truth(&v["error"]) && v["text"] == original
    })?;
    let first = base.join("project/20261101_결정요청.md");
    write(&first, "# 이전 결정 요청\n")?;
    let mut config = load(base.join("pins.json"), Value::Null)?;
    config["spaces"]["test"]["pins"].as_array_mut().ok_or_else(||std::io::Error::other("pins array required"))?.push(json!({"id":"latest","kind":"latest","label":"결정 요청","root":first.parent().unwrap().to_string_lossy(),"topic":"결정요청.md","recursive":false}));
    json_write(&base.join("pins.json"), &config)?;
    json_write(
        &base.join("command.json"),
        &json!({"sequence":SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() as u64,"refresh":true}),
    )?;
    wait(&base, "new topic tab appears", &mut receipts, |v| {
        arr(&v["documents"]).iter().any(|d| d["id"] == "latest")
    })?;
    json_write(
        &base.join("command.json"),
        &json!({"sequence":SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos() as u64,"select":"latest"}),
    )?;
    wait(&base, "select dated topic", &mut receipts, |v| {
        v["text"] == "# 이전 결정 요청\n"
    })?;
    let latest = first.parent().unwrap().join("20261102_결정요청.md");
    write(&latest, "# 최신 결정 요청\n")?;
    wait(&base, "new date follows stable topic", &mut receipts, |v| {
        v["text"] == "# 최신 결정 요청\n" && v["selected"] == "latest"
    })?;
    shot(&env, &base, "native-latest")?;
    let collision = first.parent().unwrap().join("2026-11-02_결정요청.md");
    write(&collision, "# 충돌\n")?;
    wait(
        &base,
        "same date conflict preserves successful body",
        &mut receipts,
        |v| v["error"] == "same_date_conflict" && v["text"] == "# 최신 결정 요청\n",
    )?;
    shot(&env, &base, "native-conflict")?;
    fs::remove_file(collision)?;
    wait(&base, "conflict removal recovers", &mut receipts, |v| {
        !truth(&v["error"]) && v["text"] == "# 최신 결정 요청\n"
    })?;
    write(&latest, &format!("# 긴 문서\n{}", "x".repeat(400001)))?;
    wait(
        &base,
        "large document is truncated explicitly",
        &mut receipts,
        |v| v["truncated"] == true,
    )?;
    write(&latest, "# 최신 결정 요청\n")?;
    let state = wait(&base, "restored latest", &mut receipts, |v| {
        !truth(&v["truncated"]) && v["text"] == "# 최신 결정 요청\n"
    })?;
    env.run(&strings(&["herdr-app", "do", "app.quit"]), None, true)?;
    let mut command = strings(&["/usr/bin/open", "-n", "-g", "-a", "/Applications/Herdr.app"]);
    if let Some(o) = vars.as_object() {
        for (k, v) in o {
            command.extend(["--env".into(), format!("{k}={}", s(v))]);
        }
    }
    command.extend(strings(&[
        "--stdout",
        &base.join("restart.log").to_string_lossy(),
        "--stderr",
        &base.join("restart.log").to_string_lossy(),
    ]));
    execute(&command, 20., false)?;
    wait(
        &base,
        "app restart restores selection and content",
        &mut receipts,
        |v| {
            v["selected"] == "latest" && num(&v["lastSuccess"], 0.) > num(&state["lastSuccess"], 0.)
        },
    )?;
    shot(&env, &base, "native-restarted")?;
    write(
        &base.join("receipt.json"),
        &serde_json::to_string_pretty(&receipts)?,
    )?;
    println!(
        "{}",
        json!({"passed":receipts.len(),"receipt":base.join("receipt.json").to_string_lossy()})
    );
    Ok(())
}
pub fn fixture_inventory(args: &[String]) -> Result<()> {
    let p = args
        .first()
        .cloned()
        .or_else(|| std::env::var("FIXTURE_INVENTORY").ok())
        .ok_or_else(|| std::io::Error::other("inventory file missing"))?;
    print!("{}", fs::read_to_string(p)?);
    Ok(())
}
pub fn protocol_worker(_args: &[String]) -> Result<()> {
    #[cfg(unix)]
    {
        let mut attrs = std::mem::MaybeUninit::<libc::termios>::uninit();
        if unsafe { libc::tcgetattr(0, attrs.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut attrs = unsafe { attrs.assume_init() };
        unsafe {
            libc::cfmakeraw(&mut attrs);
            libc::tcsetattr(0, libc::TCSANOW, &attrs)
        };
    }
    #[cfg(not(unix))]
    {
        return err("native protocol worker requires a POSIX PTY");
    }
    let emit = |state: &str| -> Result<()> {
        print!("\x1b]7501;state={state}:app=codex\x1b\\");
        std::io::stdout().flush()?;
        Ok(())
    };
    emit("idle")?;
    print!("\x1b[?2004h\r\n› Ask Codex to do anything");
    std::io::stdout().flush()?;
    let mut data = vec![];
    loop {
        let mut buf = [0u8; 65536];
        let n = std::io::stdin().read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        data.extend(&buf[..n]);
        let text = String::from_utf8_lossy(&data);
        if !text.contains("\x1b[201~") {
            continue;
        }
        let text = text
            .rsplit("\x1b[200~")
            .next()
            .unwrap_or("")
            .split("\x1b[201~")
            .next()
            .unwrap_or("")
            .to_string();
        data.clear();
        emit("working")?;
        let task = re(r"\[과부하 협업 ([^]]+)\]")
            .captures(&text)
            .map(|m| m[1].to_owned());
        let lease = re(r"--lease ([a-f0-9]+)")
            .captures(&text)
            .map(|m| m[1].to_owned());
        let (Some(task), Some(lease)) = (task, lease) else {
            continue;
        };
        let binary = std::env::var("COLLAB_BINARY")?;
        let accept = execute(
            &strings(&[&binary, "collaborate", "accept", &task, "--lease", &lease]),
            20.,
            false,
        )?;
        let mut result = json!({"id":task,"accepted":accept.code==0,"actor":std::env::var("HC_TERMINAL_ID").ok()});
        if accept.code == 0 {
            let count = fs::read_to_string(std::env::var("COUNT_FILE")?)?
                .lines()
                .count();
            let completed = execute(
                &strings(&[
                    &binary,
                    "collaborate",
                    "complete",
                    &task,
                    "--lease",
                    &lease,
                    "--result",
                    &format!("{count} lines"),
                ]),
                20.,
                false,
            )?;
            result["lines"] = json!(count);
            result["completed"] = json!(completed.code == 0);
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::var("WORKER_LOG")?)?;
        writeln!(f, "{result}")?;
        emit("idle")?;
        print!("\r\n완료했습니다.\r\n› Ask Codex to do anything");
        std::io::stdout().flush()?;
    }
}
pub fn collaboration(args: &[String]) -> Result<()> {
    #[cfg(not(unix))]
    {
        return err("native collaboration probe requires POSIX isolated hc and PTY support");
    }
    let output = args
        .first()
        .ok_or_else(|| std::io::Error::other("evidence output path required"))?;
    let root = repo(args);
    let directory = tempfile::Builder::new().prefix("hcc-").tempdir_in("/tmp")?;
    let base = directory.path();
    let tools = base.join("bin");
    fs::create_dir_all(&tools)?;
    fs::create_dir_all(base.join("run"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(base.join("run"), fs::Permissions::from_mode(0o700))?;
    }
    fs::create_dir_all(base.join("app"))?;
    let binary = exe()?;
    let mut env = Environment::new(
        &json!({"HC_SESSION":"c","XDG_STATE_HOME":base.join("state").to_string_lossy(),"XDG_CONFIG_HOME":base.join("config").to_string_lossy(),"XDG_RUNTIME_DIR":base.join("run").to_string_lossy(),"HERDR_APP_HOME":base.join("app").to_string_lossy(),"COLLAB_BINARY":binary,"COUNT_FILE":root.join("README.md").to_string_lossy(),"WORKER_LOG":base.join("receipts.jsonl").to_string_lossy(),"FIXTURE_INVENTORY":base.join("inventory.json").to_string_lossy()}),
    );
    let old_path = std::env::var_os("PATH").unwrap_or_default();
    let paths = std::env::join_paths(
        std::iter::once(tools.clone()).chain(std::env::split_paths(&old_path)),
    )?;
    env.vars
        .insert("PATH".into(), paths.to_string_lossy().into_owned());
    let inventory = tools.join("herdr-app");
    write(
        &inventory,
        &format!(
            "#!/bin/sh\nexec {} native-fixture-inventory \"$FIXTURE_INVENTORY\"\n",
            quote(&binary)
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&inventory, fs::Permissions::from_mode(0o755))?;
    }
    let mut addresses = vec![];
    let mut history = vec![];
    let result = (|| -> Result<()> {
        env.value(&strings(&["hc", "server", "start"]), None)?;
        for name in ["origin", "helper1", "helper2"] {
            let value = env.value(
                &strings(&[
                    "hc",
                    "run",
                    "--bg",
                    "--no-parent",
                    "--no-notify",
                    "--name",
                    name,
                    &binary,
                    "native-protocol-worker",
                ]),
                None,
            )?;
            let address = if truth(&value["address"]) {
                s(&value["address"])
            } else {
                s(&value["terminal"]["address"])
            };
            check(!address.is_empty(), format!("Unknown run result: {value}"))?;
            addresses.push(address.to_string());
        }
        json_write(
            &base.join("inventory.json"),
            &json!({"spaces":[{"id":"isolated-project","name":"IsolatedProject","tabs":[{"terminals":addresses.iter().map(|a|json!({"terminal":a})).collect::<Vec<_>>()}]}]}),
        )?;
        for a in &addresses {
            env.value(&strings(&["hc", "wait", a, "--timeout", "5"]), None)?;
            let fact = env.value(&strings(&["hc", "get", a]), None)?;
            check(
                fact["status"]["state"] == "idle",
                format!("Worker is not idle: {fact}"),
            )?;
        }
        let origin = addresses[0].clone();
        let cli = |args: Vec<String>, history: &mut Vec<Value>| -> Result<Value> {
            let mut command = strings(&[&binary, "collaborate"]);
            command.extend(args.clone());
            let value = env.value(&command, Some(&origin))?;
            history.push(json!({"argv":args,"result":value}));
            Ok(value)
        };
        for task in ["native-count-1", "native-count-2"] {
            cli(
                strings(&[
                    "enqueue",
                    "--id",
                    task,
                    "--batch",
                    "native-counts",
                    "--mode",
                    "read-only",
                    "--text",
                    "Read README.md and count its lines. No file modifications.",
                ]),
                &mut history,
            )?;
        }
        let delivered = cli(strings(&["drain"]), &mut history)?;
        check(arr(&delivered).len() == 2, format!("{delivered}"))?;
        for a in &addresses[1..] {
            env.value(&strings(&["hc", "wait", a, "--timeout", "10"]), None)?;
        }
        let ledger = cli(strings(&["status"]), &mut history)?;
        check(
            ledger["tasks"]
                .as_object()
                .is_some_and(|o| o.values().all(|t| t["state"] == "completed")),
            format!("{ledger}"),
        )?;
        check(
            arr(&cli(strings(&["drain"]), &mut history)?).is_empty(),
            "drain duplicated a delivery",
        )?;
        let first = cli(
            strings(&["report", "--batch", "native-counts"]),
            &mut history,
        )?;
        let second = cli(
            strings(&["report", "--batch", "native-counts"]),
            &mut history,
        )?;
        check(
            first["state"] == "reported" && second["state"] == "already_reported",
            "batch report not exactly once",
        )?;
        let receipts: Vec<Value> = fs::read_to_string(base.join("receipts.jsonl"))?
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        check(
            receipts.len() == 2
                && receipts
                    .iter()
                    .all(|r| truth(&r["accepted"]) && truth(&r["completed"])),
            format!("{receipts:?}"),
        )?;
        let evidence = json!({"kind":"real isolated hc; fixture workspace inventory; deterministic protocol workers","session":"c","addresses":addresses,"history":history,"worker_receipts":receipts,"expected_lines":fs::read_to_string(root.join("README.md"))?.lines().count(),"send_count":2,"duplicate_count":0,"origin_report_count":1});
        write(Path::new(output), &serde_json::to_string_pretty(&evidence)?)?;
        println!(
            "{}",
            json!({"evidence":output,"duplicate_count":0,"origin_report_count":1})
        );
        Ok(())
    })();
    for a in &addresses {
        let _ = env.run(&strings(&["hc", "kill", a]), None, false);
        let _ = env.run(&strings(&["hc", "rm", a]), None, false);
    }
    let stopped = env.run(
        &strings(&["hc", "server", "stop"]),
        None,
        !addresses.is_empty(),
    );
    result?;
    stopped?;
    Ok(())
}
