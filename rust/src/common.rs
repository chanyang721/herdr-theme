use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use wait_timeout::ChildExt;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Debug)]
pub struct CliError {
    pub code: i32,
    pub message: String,
}
impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for CliError {}
pub fn usage<T>(message: impl Into<String>) -> Result<T> {
    Err(Box::new(CliError {
        code: 2,
        message: message.into(),
    }))
}
/// argparse accepts an unambiguous prefix of a long option by default.
pub fn long_option<'a>(key: &'a str, values: &[&'a str], flags: &[&'a str]) -> Result<&'a str> {
    if !key.starts_with("--") || values.contains(&key) || flags.contains(&key) {
        return Ok(key);
    }
    let matches = values
        .iter()
        .chain(flags)
        .copied()
        .filter(|name| name.starts_with(key))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [name] => Ok(name),
        [] => Ok(key),
        _ => usage(format!(
            "ambiguous option: {key} could match {}",
            matches.join(", ")
        )),
    }
}
pub fn home() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            return profile.into();
        }
        if let Some(path) = std::env::var_os("HOMEPATH") {
            let mut drive = std::env::var_os("HOMEDRIVE").unwrap_or_default();
            drive.push(path);
            return drive.into();
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return home.into();
        }
    }
    dirs::home_dir().expect("home directory unavailable")
}
pub fn app_home() -> PathBuf {
    std::env::var_os("HERDR_APP_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config/herdr-app"))
}
pub fn data() -> PathBuf {
    app_home().join("data/sixfold")
}
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn read_json(path: impl AsRef<Path>) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
pub fn expand(path: &str) -> PathBuf {
    if path == "~" {
        home()
    } else if let Some(p) = path.strip_prefix("~/") {
        home().join(p)
    } else {
        PathBuf::from(path)
    }
}
pub fn private(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
pub fn atomic(path: impl AsRef<Path>, value: &Value) -> Result<()> {
    atomic_text(path, &json_pretty(value, false))
}
pub fn atomic_text(path: impl AsRef<Path>, text: &str) -> Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or("output has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    private(temporary.path())?;
    temporary.write_all(&text_bytes(text))?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}
pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
pub fn capture(program: &str, args: &[String], timeout: f64) -> Result<(i32, String, String)> {
    let mut cmd = command(program);
    cmd.args(args);
    capture_cmd(cmd, timeout)
}
pub fn capture_cmd(cmd: Command, timeout: f64) -> Result<(i32, String, String)> {
    capture_cmd_io(cmd, timeout, None)
}
pub fn capture_cmd_input(
    cmd: Command,
    timeout: f64,
    input: Vec<u8>,
) -> Result<(i32, String, String)> {
    capture_cmd_io(cmd, timeout, Some(input))
}
fn capture_cmd_io(
    mut cmd: Command,
    timeout: f64,
    input: Option<Vec<u8>>,
) -> Result<(i32, String, String)> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    let mut child = cmd
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let (out_tx, stdout) = mpsc::sync_channel(1);
    let (err_tx, stderr) = mpsc::sync_channel(1);
    // All three pipes progress concurrently: a child may fill its output before
    // reading a large request. Writing stdin on the waiting thread can deadlock.
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        let _ = out_tx.send(b);
    });
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        let _ = err_tx.send(b);
    });
    let stdin = input.map(|bytes| {
        let mut pipe = child.stdin.take().unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = pipe.write_all(&bytes);
            drop(pipe); // The child reads EOF before producing its reply.
            let _ = tx.send(result);
        });
        rx
    });
    let status = match child.wait_timeout(deadline.saturating_duration_since(Instant::now()))? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program} timed out after {timeout}s").into());
        }
    };
    fn receive<T>(
        rx: mpsc::Receiver<T>,
        deadline: Instant,
        program: &str,
        timeout: f64,
    ) -> Result<T> {
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| {
                format!("{program} timed out after {timeout}s while finishing pipes").into()
            })
    }
    let stdout = receive(stdout, deadline, &program, timeout)?;
    let stderr = receive(stderr, deadline, &program, timeout)?;
    if let Some(stdin) = stdin {
        let written = receive(stdin, deadline, &program, timeout)?;
        // An early CLI refusal can close stdin. Preserve that nonzero receipt,
        // while a success that did not accept the complete input is an error.
        if status.success() {
            written?;
        }
    }
    Ok((
        status.code().unwrap_or(1),
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}
pub fn output(program: &str, args: &[String], timeout: f64) -> Result<String> {
    let (code, out, err) = capture(program, args, timeout)?;
    if code != 0 {
        return Err(format!(
            "{program} exited {code}: {}",
            err.chars().take(180).collect::<String>()
        )
        .into());
    }
    Ok(out)
}
pub fn call(program: &str, args: &[String]) -> Result<Value> {
    // The workspace API used check_output without a timeout. Explicitly timed
    // callers use capture/output instead; do not impose a new global deadline.
    Ok(serde_json::from_str(&checked_output(program, args)?)?)
}
pub fn checked_output(program: &str, args: &[String]) -> Result<String> {
    let result = command(program).args(args).output()?;
    if !result.status.success() {
        return Err(format!(
            "{program} exited {}: {}",
            result.status.code().unwrap_or(1),
            String::from_utf8_lossy(&result.stderr)
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&result.stdout).into_owned())
}
pub fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
pub fn print(value: &Value) -> Result<()> {
    print_line(&json_text(value, false))
}
/// Python json.dumps' default separators, without changing object order.
/// Some original commands request ensure_ascii=False, others keep its default.
pub fn json_text(value: &Value, ensure_ascii: bool) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| json_text(v, ensure_ascii))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Object(items) => format!(
            "{{{}}}",
            items
                .iter()
                .map(|(k, v)| format!(
                    "{}: {}",
                    json_text(&Value::String(k.clone()), ensure_ascii),
                    json_text(v, ensure_ascii)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::String(text) => {
            let encoded = serde_json::to_string(text).expect("JSON string");
            if !ensure_ascii {
                return encoded;
            }
            let mut out = String::new();
            for c in encoded.chars() {
                if c as u32 >= 127 {
                    for unit in c.to_string().encode_utf16() {
                        out.push_str(&format!("\\u{unit:04x}"));
                    }
                } else {
                    out.push(c);
                }
            }
            out
        }
        Value::Number(n) if n.is_f64() => crate::automation::format::repr(value),
        _ => value.to_string(),
    }
}
pub fn print_line(text: &str) -> Result<()> {
    let mut out = std::io::stdout().lock();
    out.write_all(&text_bytes(text))?;
    out.write_all(if cfg!(windows) { b"\r\n" } else { b"\n" })?;
    Ok(())
}
pub fn error_line(text: &str) -> Result<()> {
    let mut out = std::io::stderr().lock();
    out.write_all(&text_bytes(text))?;
    out.write_all(if cfg!(windows) { b"\r\n" } else { b"\n" })?;
    Ok(())
}
pub fn text_bytes(text: &str) -> Vec<u8> {
    if cfg!(windows) {
        text.replace('\n', "\r\n").into_bytes()
    } else {
        text.as_bytes().to_vec()
    }
}
pub fn json_pretty(value: &Value, ensure_ascii: bool) -> String {
    fn format(value: &Value, ascii: bool, depth: usize) -> String {
        let (open, close, entries) = match value {
            Value::Array(items) if !items.is_empty() => (
                "[",
                "]",
                items
                    .iter()
                    .map(|v| format(v, ascii, depth + 1))
                    .collect::<Vec<_>>(),
            ),
            Value::Object(items) if !items.is_empty() => (
                "{",
                "}",
                items
                    .iter()
                    .map(|(k, v)| {
                        std::format!(
                            "{}: {}",
                            json_text(&Value::String(k.clone()), ascii),
                            format(v, ascii, depth + 1)
                        )
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => return json_text(value, ascii),
        };
        std::format!(
            "{open}\n{}{}\n{}{close}",
            "  ".repeat(depth + 1),
            entries.join(&std::format!(",\n{}", "  ".repeat(depth + 1))),
            "  ".repeat(depth)
        )
    }
    format(value, ensure_ascii, 0)
}
pub fn option(args: &[String], key: &str) -> Option<String> {
    let (mut found, mut i) = (None, 0);
    while i < args.len() {
        let a = &args[i];
        if a == "--" {
            break;
        }
        if let Some((name, value)) = a.split_once('=') {
            if name == key {
                found = Some(value.into());
            }
            i += 1;
            continue;
        }
        if a == key {
            found = args.get(i + 1).cloned();
            i += 2;
        } else if value_option(a) {
            i += 2;
        } else {
            i += 1;
        }
    }
    found
}
pub fn flag(args: &[String], key: &str) -> bool {
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--" {
            break;
        }
        if args[i] == key {
            return true;
        }
        if value_option(&args[i]) {
            i += 2;
        } else {
            i += 1;
        }
    }
    false
}
fn value_option(key: &str) -> bool {
    [
        "--id",
        "--text",
        "--mode",
        "--owns",
        "--batch",
        "--from",
        "--tier",
        "--lease",
        "--result",
        "--tiers",
        "--by",
        "--pane",
        "--session",
        "--herdr",
        "--machine",
    ]
    .contains(&key)
}
pub fn site() -> Value {
    let mut defaults = json!({"label_prefix":"local.herdr-sixfold","state_dir":"~/Library/Application Support/HerdrSixfold","reports_dir":"~/Documents/HerdrReports","projects_dir":"~/Documents/HerdrProjects","hub_space_ids":[],"project_aliases":{},"fixed_space_names":["Share"],"doc_tabs":{}});
    if let Ok(Value::Object(local)) = read_json(data().join("site.local.json")) {
        defaults.as_object_mut().unwrap().extend(local);
    }
    defaults
}
pub fn is_hub(space: &Value, site: &Value) -> bool {
    site["hub_space_ids"]
        .as_array()
        .is_some_and(|a| a.contains(&space["id"]))
        || ["share", "공통", "common"]
            .contains(&casefold(space["name"].as_str().unwrap_or("")).as_str())
}
pub fn list(value: &Value) -> &[Value] {
    value.as_array().map(|v| v.as_slice()).unwrap_or(&[])
}
pub fn s(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub fn casefold(text: &str) -> String {
    crate::documents::casefold::casefold(text)
}
pub fn find_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or(".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(str::to_string)
            .chain(std::iter::once(String::new()))
            .collect::<Vec<_>>()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if !candidate.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if candidate.metadata().ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_bytes_match_frozen_python_dumps() {
        let cases: Value =
            serde_json::from_str(include_str!("../tests/fixtures/python-json.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                json_text(&case["value"], true),
                case["ascii"].as_str().unwrap()
            );
            assert_eq!(
                json_text(&case["value"], false),
                case["unicode"].as_str().unwrap()
            );
            assert_eq!(
                json_pretty(&case["value"], true),
                case["pretty_ascii"].as_str().unwrap()
            );
            assert_eq!(
                json_pretty(&case["value"], false),
                case["pretty_unicode"].as_str().unwrap()
            );
        }
    }
}
