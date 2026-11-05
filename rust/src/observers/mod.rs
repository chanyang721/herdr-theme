//! Conservative lifecycle observers. Evidence errors always keep a session alive.
#[cfg(test)]
mod contracts;
pub mod jobs;
pub mod native;
mod native_ui;
pub mod sessions;
pub mod sleep;
pub mod spaces;
pub mod stub;
use serde_json::{json, Value};
use std::{
    error::Error,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub fn err<T>(s: impl Into<String>) -> Result<T> {
    Err(std::io::Error::other(s.into()).into())
}
pub fn arg_error<T>(message: impl Into<String>) -> Result<T> {
    Err(Box::new(crate::common::CliError {
        code: 2,
        message: message.into(),
    }))
}
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
pub fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or(0.) != 0.,
        Value::String(x) => !x.is_empty(),
        Value::Array(x) => !x.is_empty(),
        Value::Object(x) => !x.is_empty(),
    }
}
pub fn num(v: &Value, d: f64) -> f64 {
    v.as_f64().unwrap_or(d)
}
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn home() -> PathBuf {
    crate::common::home()
}
pub fn expand(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    let t = p.to_string_lossy();
    if t == "~" {
        home()
    } else if t.starts_with("~/") {
        home().join(&t[2..])
    } else {
        p.to_owned()
    }
}
pub fn app_home() -> PathBuf {
    std::env::var_os("HERDR_APP_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config/herdr-app"))
}
pub fn load(p: impl AsRef<Path>, default: Value) -> Result<Value> {
    match fs::read(p) {
        Ok(x) => Ok(serde_json::from_slice(&x)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(e) => Err(e.into()),
    }
}
pub fn private(p: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(p, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
pub fn save(p: &Path, v: &Value) -> Result<()> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d)?;
    }
    let mut f = tempfile::NamedTempFile::new_in(p.parent().unwrap_or(Path::new(".")))?;
    private(f.path())?;
    writeln!(f, "{}", serde_json::to_string_pretty(v)?)?;
    f.as_file().sync_all()?;
    f.persist(p)?;
    Ok(())
}
pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
pub fn fingerprint(v: &Value) -> String {
    fn canonical(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                let mut out = serde_json::Map::new();
                let mut keys = o.keys().collect::<Vec<_>>();
                keys.sort();
                for k in keys {
                    out.insert(k.clone(), canonical(&o[k]));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
            _ => v.clone(),
        }
    }
    hash(serde_json::to_vec(&canonical(v)).unwrap_or_default())
}
pub fn iso(t: f64) -> String {
    chrono::DateTime::from_timestamp(t.floor() as i64, 0)
        .map(|v| v.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default()
}
pub fn local_iso(t: f64) -> String {
    let sec = t.floor() as i64;
    let micros = ((t - t.floor()) * 1_000_000.).round() as u32;
    chrono::DateTime::from_timestamp(sec, micros.min(999999) * 1000)
        .map(|v| {
            v.with_timezone(&chrono::Local).to_rfc3339_opts(
                if micros == 0 {
                    chrono::SecondsFormat::Secs
                } else {
                    chrono::SecondsFormat::Micros
                },
                false,
            )
        })
        .unwrap_or_default()
}
pub fn re(p: &str) -> regex::Regex {
    regex::Regex::new(p).expect("static expression")
}
pub fn tail(t: &str, n: usize) -> String {
    let v: Vec<_> = t.lines().collect();
    v[v.len().saturating_sub(n)..].join("\n")
}
pub fn take(t: &str, n: usize) -> String {
    t.chars().take(n).collect()
}
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}
pub fn execute(argv: &[String], timeout: f64, clean_caller: bool) -> Result<Output> {
    execute_with(argv, timeout, clean_caller, |_| {})
}
pub fn execute_with(
    argv: &[String],
    timeout: f64,
    clean_caller: bool,
    configure: impl FnOnce(&mut Command),
) -> Result<Output> {
    if !timeout.is_finite() || timeout < 0. {
        return err("command timed out");
    }
    if argv.is_empty() {
        return err("empty command");
    };
    let mut c = Command::new(&argv[0]);
    c.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if clean_caller {
        c.env_remove("HC_TERMINAL_ID").env_remove("HC_SCOPE");
    }
    configure(&mut c);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    let mut child = c.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let a = std::thread::spawn(move || {
        let mut r = stdout;
        let mut b = Vec::new();
        r.read_to_end(&mut b).map(|_| b)
    });
    let b = std::thread::spawn(move || {
        let mut r = stderr;
        let mut b = Vec::new();
        r.read_to_end(&mut b).map(|_| b)
    });
    let end = Instant::now() + Duration::from_secs_f64(timeout);
    let status = loop {
        if let Some(v) = child.try_wait()? {
            break v;
        }
        if Instant::now() >= end {
            let _ = child.kill();
            let _ = child.wait();
            return err(format!("command timed out: {}", argv[0]));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok(Output {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(
            &a.join()
                .map_err(|_| std::io::Error::other("reader failed"))??,
        )
        .into_owned(),
        stderr: String::from_utf8_lossy(
            &b.join()
                .map_err(|_| std::io::Error::other("reader failed"))??,
        )
        .into_owned(),
    })
}
pub fn command(argv: &[String], timeout: f64, clean: bool) -> Result<String> {
    let o = execute(argv, timeout, clean)?;
    if o.code != 0 {
        return err(format!(
            "{} {:?} exited {}: {}",
            Path::new(&argv[0])
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            argv.get(1),
            o.code,
            take(o.stderr.trim(), 180)
        ));
    }
    Ok(o.stdout)
}
pub fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}
pub fn validate_args(args: &[String], values: &[&str], flags: &[&str]) -> Result<()> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if values.contains(&a) {
            if i + 1 >= args.len() {
                return arg_error(format!("argument {a}: expected one argument"));
            }
            i += 2;
        } else if flags.contains(&a) {
            i += 1;
        } else {
            return arg_error(format!("unrecognized arguments: {}", args[i..].join(" ")));
        }
    }
    Ok(())
}
pub trait Adapter {
    fn snapshot(&mut self) -> Result<Value>;
    fn screen(&mut self, address: &str) -> Result<String>;
    fn styled_screen(&mut self, address: &str) -> Result<String>;
    fn terminal(&mut self, address: &str) -> Result<Value>;
    fn request_report(&mut self, address: &str, text: &str) -> Result<()>;
    fn keys(&mut self, address: &str, keys: &[String]) -> Result<()>;
    fn type_line(&mut self, address: &str, text: &str) -> Result<()> {
        self.request_report(address, text)
    }
    fn label(&mut self, address: &str, labels: &Value) -> Result<()>;
    fn close_pane(&mut self, pane: &str) -> Result<()>;
    fn close_space(&mut self, space: &str, config: &Value) -> Result<()>;
    fn close_status(&mut self, config: &Value, item: &Value, since: &str) -> Result<Value> {
        sessions::harness_close_status(config, item, since)
    }
    fn close_gate(&mut self, config: &Value, item: &Value) -> Result<Value> {
        sessions::harness_close_gate(config, item)
    }
    fn park(
        &mut self,
        config: &Value,
        item: &Value,
        event: &str,
        dry: bool,
        reason: &str,
    ) -> Result<Value> {
        sessions::harness_park(config, item, event, dry, reason)
    }
    fn archive(&mut self, config: &Value, data: &Value) -> Result<Value> {
        sessions::harness_archive(config, data)
    }
    fn mapping(&mut self, t: &Value, c: &Value) -> Result<Value> {
        if truth(&c["sessions"][s(&t["address"])]) {
            Ok(c["sessions"][s(&t["address"])].clone())
        } else {
            sessions::session_mapping(t, c)
        }
    }
    fn session_mapping(&mut self, t: &Value, c: &Value) -> Result<Value> {
        sessions::session_mapping(t, c)
    }
    fn child(&mut self, t: &Value) -> Result<Value> {
        sessions::child_session(t)
    }
    fn backend(&mut self, t: &Value, c: &Value, clean: bool) -> (bool, String, String) {
        match self.mapping(t, c) {
            Ok(m) => jobs::check_jobs(t, c, &m, clean),
            Err(e) => (
                false,
                format!("backend jobs unverified: {e}"),
                String::new(),
            ),
        }
    }
    fn git(&mut self, folder: &str) -> Value {
        sessions::git_brief(folder)
    }
    fn machine(&mut self) -> Result<String> {
        let v: Value = serde_json::from_str(&command(
            &strings(&["hc", "server", "status", "--json"]),
            12.,
            false,
        )?)?;
        Ok(s(&v["core"]["id"]).to_string())
    }
    fn wait(&mut self, seconds: f64) {
        std::thread::sleep(Duration::from_secs_f64(seconds));
    }
}
pub struct Live {
    pub app: String,
    pub core: String,
}
impl Adapter for Live {
    fn snapshot(&mut self) -> Result<Value> {
        let status: Value = serde_json::from_str(&command(
            &vec![self.app.clone(), "status".into()],
            12.,
            false,
        )?)?;
        let spaces: Value =
            serde_json::from_str(&command(&vec![self.app.clone(), "ls".into()], 12., false)?)?;
        let listing: Value = serde_json::from_str(&command(
            &vec![
                self.core.clone(),
                "ls".into(),
                "--all".into(),
                "--json".into(),
            ],
            12.,
            false,
        )?)?;
        let (mut terms, mut errors) = (json!({}), json!({}));
        for t in arr(&listing["terminals"]) {
            if t["state"] != "live" {
                continue;
            }
            let address = s(&t["address"]);
            match self.terminal(address) {
                Ok(t) => terms[address] = t,
                Err(e) => errors[address] = json!(take(&e.to_string(), 160)),
            }
        }
        Ok(
            json!({"status":status,"spaces":spaces["spaces"],"terminals":terms,"lookup_errors":errors,"processes":sessions::process_table()?}),
        )
    }
    fn screen(&mut self, address: &str) -> Result<String> {
        let v: Value = serde_json::from_str(&command(
            &vec![
                self.core.clone(),
                "read".into(),
                address.into(),
                "--json".into(),
                "--lines".into(),
                "0".into(),
            ],
            12.,
            false,
        )?)?;
        if !truth(&v["complete"]) || v["how"] != "screen" || !v["text"].is_string() {
            return err("complete visible screen unavailable");
        }
        Ok(s(&v["text"]).into())
    }
    fn styled_screen(&mut self, address: &str) -> Result<String> {
        sessions::styled_screen(&self.core, address, 3., 0.4)
    }
    fn terminal(&mut self, address: &str) -> Result<Value> {
        Ok(serde_json::from_str(&command(
            &vec![
                self.core.clone(),
                "get".into(),
                address.into(),
                "--json".into(),
            ],
            12.,
            false,
        )?)?)
    }
    fn request_report(&mut self, address: &str, text: &str) -> Result<()> {
        command(
            &vec![
                self.core.clone(),
                "send".into(),
                address.into(),
                text.into(),
            ],
            30.,
            true,
        )?;
        Ok(())
    }
    fn keys(&mut self, address: &str, keys: &[String]) -> Result<()> {
        let mut a = vec![self.core.clone(), "keys".into(), address.into()];
        a.extend_from_slice(keys);
        command(&a, 12., true)?;
        Ok(())
    }
    fn label(&mut self, address: &str, labels: &Value) -> Result<()> {
        let mut a = vec![self.core.clone(), "label".into(), address.into()];
        if let Some(o) = labels.as_object() {
            a.extend(o.iter().map(|(k, v)| format!("{k}={}", s(v))))
        }
        command(&a, 12., true)?;
        Ok(())
    }
    fn close_pane(&mut self, pane: &str) -> Result<()> {
        if pane.is_empty() {
            return err("pane.close refused: no pane id");
        }
        command(
            &vec![
                self.app.clone(),
                "do".into(),
                "pane.close".into(),
                json!({"pane":pane}).to_string(),
            ],
            60.,
            false,
        )?;
        Ok(())
    }
    fn close_space(&mut self, space: &str, c: &Value) -> Result<()> {
        if !truth(&c["space_close_enabled"]) {
            return err("space.close refused: workspaces are kept (space_close_enabled is off)");
        }
        command(
            &vec![
                self.app.clone(),
                "do".into(),
                "space.close".into(),
                json!({"id":space,"confirmed":true}).to_string(),
            ],
            12.,
            false,
        )?;
        Ok(())
    }
}
pub fn run(command: &str, args: &[String]) -> Result<()> {
    match command.replace('_', "-").as_str() {
        "agent-sessions" | "space-job-evidence" => Ok(()),
        "close-finished-spaces" => spaces::main(args),
        "sleep-idle-sessions" => sleep::main(args),
        "session-sleep-stub" => stub::main(args),
        "native-collaboration" => native::collaboration(args),
        "native-doc-tabs" => native::doc_tabs(args),
        "native-ui-reload" => native::ui_reload(args),
        "native-protocol-worker" => native::protocol_worker(args),
        "native-fixture-inventory" => native::fixture_inventory(args),
        _ => err(format!("unknown observer command: {command}")),
    }
}
