use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
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
    let path = path.as_ref();
    let parent = path.parent().ok_or("output has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    private(temporary.path())?;
    serde_json::to_writer_pretty(&mut temporary, value)?;
    temporary.write_all(b"\n")?;
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
pub fn capture_cmd(mut cmd: Command, timeout: f64) -> Result<(i32, String, String)> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    // Drain both streams while waiting so a full pipe never deadlocks the process.
    let stdout = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let stderr = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let status = match child.wait_timeout(Duration::from_secs_f64(timeout))? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program} timed out after {timeout}s").into());
        }
    };
    Ok((
        status.code().unwrap_or(1),
        String::from_utf8_lossy(&stdout.join().unwrap_or_default()).into_owned(),
        String::from_utf8_lossy(&stderr.join().unwrap_or_default()).into_owned(),
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
    Ok(serde_json::from_str(&output(program, args, 30.)?)?)
}
pub fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}
pub fn print(value: &Value) -> Result<()> {
    print_line(&serde_json::to_string(value)?)
}
pub fn print_line(text: &str) -> Result<()> {
    let mut out = std::io::stdout().lock();
    out.write_all(text.as_bytes())?;
    out.write_all(if cfg!(windows) { b"\r\n" } else { b"\n" })?;
    Ok(())
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
