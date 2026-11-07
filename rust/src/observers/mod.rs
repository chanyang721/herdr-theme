//! Local process utilities and explicit disposable integration probes.
pub mod native;
mod native_ui;
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
    f.write_all(&crate::common::text_bytes(&format!(
        "{}\n",
        crate::common::json_pretty(v, false)
    )))?;
    f.as_file().sync_all()?;
    f.persist(p)?;
    Ok(())
}
/// Original note/ticket write_text follows a destination symlink, then chmods
/// that same target. State snapshots use `save` and deliberately replace it.
pub fn save_direct(p: &Path, v: &Value) -> Result<()> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d)?;
    }
    fs::write(
        p,
        crate::common::text_bytes(&format!("{}\n", crate::common::json_pretty(v, false))),
    )?;
    private(p)
}
pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
pub fn fingerprint(v: &Value) -> String {
    fingerprint_ascii(v, true)
}
pub fn fingerprint_ascii(v: &Value, ensure_ascii: bool) -> String {
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
    hash(crate::common::json_text(&canonical(v), ensure_ascii))
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
    let v = crate::python_unicode::split_lines(t);
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
    execute_policy(argv, Some(timeout), clean_caller, configure)
}
pub fn execute_unbounded_with(
    argv: &[String],
    clean_caller: bool,
    configure: impl FnOnce(&mut Command),
) -> Result<Output> {
    execute_policy(argv, None, clean_caller, configure)
}
pub fn execute_unbounded(argv: &[String], clean_caller: bool) -> Result<Output> {
    execute_unbounded_with(argv, clean_caller, |_| {})
}
fn execute_policy(
    argv: &[String],
    timeout: Option<f64>,
    clean_caller: bool,
    configure: impl FnOnce(&mut Command),
) -> Result<Output> {
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
    let end = timeout.map(|seconds| Instant::now() + Duration::from_secs_f64(seconds));
    let status = loop {
        if let Some(v) = child.try_wait()? {
            break v;
        }
        if end.is_some_and(|end| Instant::now() >= end) {
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
pub fn normalize_args(args: &[String], values: &[&str], flags: &[&str]) -> Result<Vec<String>> {
    normalize_args_with(args, values, flags, |_, _| Ok(()))
}
pub fn normalize_args_with(
    args: &[String],
    values: &[&str],
    flags: &[&str],
    validate_value: impl Fn(&str, &str) -> Result<()>,
) -> Result<Vec<String>> {
    let mut ordered = vec!["--help", "-h"];
    for option in [
        "--config",
        "--state",
        "--log",
        "--report-dir",
        "--data",
        "--dry-run",
        "--apply",
        "--only-space",
        "--now",
        "--app",
        "--core",
        "--reloads",
        "--failed-reloads",
        "--install-smoke",
        "--repo",
    ] {
        if values.contains(&option) || flags.contains(&option) {
            ordered.push(option);
        }
    }
    for option in values.iter().chain(flags) {
        if !ordered.contains(option) {
            ordered.push(option);
        }
    }
    let resolve = |key: &str| -> Result<String> {
        if key == "--" || !key.starts_with("--") || ordered.contains(&key) {
            return Ok(key.to_owned());
        }
        let candidates = ordered
            .iter()
            .filter(|option| option.starts_with(key))
            .copied()
            .collect::<Vec<_>>();
        match candidates.as_slice() {
            [name] => Ok((*name).to_owned()),
            [] => Ok(key.to_owned()),
            _ => arg_error(format!(
                "ambiguous option: {key} could match {}",
                candidates.join(", ")
            )),
        }
    };
    let mut out = vec![];
    let mut unknown = vec![];
    let mut mode: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let (key, inline) = args[i]
            .split_once('=')
            .map(|(k, v)| (k, Some(v)))
            .unwrap_or((&args[i], None));
        let key = resolve(key)?;
        let key = key.as_str();
        if values.contains(&key) {
            let value = if let Some(value) = inline {
                value.to_owned()
            } else {
                i += 1;
                args.get(i)
                    .filter(|value| {
                        !value.starts_with('-')
                            || value.as_str() == "-"
                            || crate::python_unicode::regex(r"^-(?:\d+|\d*\.\d+)$").is_match(value)
                    })
                    .cloned()
                    .ok_or_else(|| {
                        Box::new(crate::common::CliError {
                            code: 2,
                            message: format!("argument {key}: expected one argument"),
                        }) as Box<dyn Error>
                    })?
            };
            validate_value(key, &value)?;
            out.extend([key.to_owned(), value]);
        } else if matches!(key, "--help" | "-h") && inline.is_none() {
            out.push("--help".into());
            return Ok(out);
        } else if flags.contains(&key) && inline.is_none() {
            if matches!(key, "--apply" | "--dry-run") {
                if let Some(previous) = &mode {
                    if previous != key {
                        return arg_error(format!(
                            "argument {key}: not allowed with argument {previous}"
                        ));
                    }
                }
                mode = Some(key.to_owned());
            }
            out.push(key.to_owned());
        } else if flags.contains(&key) || matches!(key, "--help" | "-h") {
            let display = if matches!(key, "--help" | "-h") {
                "-h/--help"
            } else {
                key
            };
            return arg_error(format!(
                "argument {display}: ignored explicit argument {}",
                crate::automation::format::repr(&json!(inline.unwrap()))
            ));
        } else if key == "--" {
            unknown.extend(args[i..].iter().cloned());
            break;
        } else {
            unknown.push(args[i].clone());
        }
        i += 1;
    }
    if unknown.is_empty() {
        Ok(out)
    } else {
        arg_error(format!("unrecognized arguments: {}", unknown.join(" ")))
    }
}
pub fn machine_id(value: &Value) -> String {
    match &value["core"]["id"] {
        Value::String(id) => id.clone(),
        other => crate::automation::format::repr(other),
    }
}
fn value_option(key: &str) -> bool {
    [
        "--config",
        "--state",
        "--log",
        "--report-dir",
        "--app",
        "--core",
        "--only-space",
        "--data",
        "--reloads",
        "--failed-reloads",
        "--repo",
    ]
    .contains(&key)
}
fn argument_positions(args: &[String]) -> Vec<usize> {
    let (mut indices, mut i) = (vec![], 0);
    while i < args.len() {
        indices.push(i);
        i += if value_option(&args[i]) { 2 } else { 1 };
    }
    indices
}
pub fn option_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    argument_positions(args)
        .into_iter()
        .rev()
        .find(|i| args[*i] == key)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}
pub fn has_flag(args: &[String], key: &str) -> bool {
    argument_positions(args).into_iter().any(|i| args[i] == key)
}
pub fn apply_mode(args: &[String]) -> Result<bool> {
    let mut seen: Option<&str> = None;
    for index in argument_positions(args) {
        let option = args[index].as_str();
        if matches!(option, "--apply" | "--dry-run") {
            if let Some(previous) = seen {
                if previous != option {
                    return arg_error(format!(
                        "argument {option}: not allowed with argument {previous}"
                    ));
                }
            }
            seen = Some(option);
        }
    }
    Ok(seen == Some("--apply"))
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

pub fn run(command: &str, args: &[String]) -> Result<()> {
    match command.replace('_', "-").as_str() {
        "native-collaboration" => native::collaboration(args),
        "native-doc-tabs" => native::doc_tabs(args),
        "native-ui-reload" => native::ui_reload(args),
        "native-protocol-worker" => native::protocol_worker(args),
        "native-fixture-inventory" => native::fixture_inventory(args),
        _ => err(format!("unknown local probe: {command}")),
    }
}
