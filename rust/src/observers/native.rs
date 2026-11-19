//! Manual native integration probes. Every mutation targets a disposable app/core.
pub use super::native_ui::ui_reload;
use super::*;
use std::collections::BTreeMap;
struct Environment {
    vars: BTreeMap<String, String>,
    timeout: Option<f64>,
}
impl Environment {
    fn with_identity(values: &Value, clear_caller: bool) -> Self {
        let mut vars: BTreeMap<_, _> = std::env::vars().collect();
        if let Some(o) = values.as_object() {
            for (k, v) in o {
                vars.insert(k.clone(), s(v).into());
            }
        }
        if clear_caller {
            vars.remove("HC_TERMINAL_ID");
            vars.remove("HERDR_PANE_ID");
        }
        Self {
            vars,
            timeout: Some(20.),
        }
    }
    fn run(&self, argv: &[String], actor: Option<&str>, check: bool) -> Result<Output> {
        let configure = |c: &mut Command| {
            c.env_clear().envs(&self.vars);
            if let Some(a) = actor {
                c.env("HC_TERMINAL_ID", a);
            }
        };
        let o = if let Some(timeout) = self.timeout {
            execute_with(argv, timeout, false, configure)?
        } else {
            execute_unbounded_with(argv, false, configure)?
        };
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
}
fn check(condition: bool, message: impl Into<String>) -> Result<()> {
    if condition {
        Ok(())
    } else {
        err(message)
    }
}
fn write(path: &Path, t: &str) -> Result<()> {
    fs::write(path, crate::common::text_bytes(t))?;
    Ok(())
}
fn json_write(path: &Path, v: &Value) -> Result<()> {
    write(path, &crate::common::json_text(v, true))
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
    let mut env = Environment::with_identity(&vars, false);
    env.timeout = None;
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
    execute_unbounded(&command, false)?;
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
        &crate::common::json_pretty(&json!(receipts), true),
    )?;
    crate::common::print(
        &json!({"passed":receipts.len(),"receipt":base.join("receipt.json").to_string_lossy()}),
    )?;
    Ok(())
}
pub fn fixture_inventory(args: &[String]) -> Result<()> {
    let p = args
        .first()
        .cloned()
        .or_else(|| std::env::var("FIXTURE_INVENTORY").ok())
        .ok_or_else(|| std::io::Error::other("inventory file missing"))?;
    crate::common::print_line(&fs::read_to_string(p)?)?;
    Ok(())
}
