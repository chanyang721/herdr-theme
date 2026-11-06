//! Native implementations of the optional macOS voice plugin. All subprocesses
//! below are system/Herdr tools; no interpreter is used by installed entry points.
// Python's text stdout uses the platform newline and reports write failures.
macro_rules! voice_println {
    ($($value:tt)*) => {crate::legacy_text::print_line(&format!($($value)*))?};
}
pub mod audio;
pub mod cli;
pub mod evaluate;
pub mod gate;
pub mod install;
mod iso;
pub mod linalg;
pub mod native;
pub mod policy;
pub mod probe;
pub mod queue;
pub mod recovery;
mod rng;
pub mod settings;
use serde_json::Value;
use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;
#[derive(Debug)]
pub struct Exit(pub i32);
impl fmt::Display for Exit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "voice command exited {}", self.0)
    }
}
impl Error for Exit {}
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn round(v: f64, d: i32) -> f64 {
    // Python rounds the actual binary value to decimal places. Multiplying by
    // 10^d first can erase the side of a tie (e.g. round(2.675, 2) is 2.67).
    if d >= 0 {
        if d > 308 || !v.is_finite() {
            return v;
        }
        return format!("{:.*}", d as usize, v).parse().unwrap_or(v);
    }
    let n = 10f64.powi(d);
    (v * n).round_ties_even() / n
}
pub fn mtime(path: &Path) -> Option<f64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64())
}
pub fn json_pretty_sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), json_pretty_sorted(&map[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(json_pretty_sorted).collect()),
        value => value.clone(),
    }
}
pub fn write_json_direct(
    path: &Path,
    value: &Value,
    ensure_ascii: bool,
    pretty: bool,
    newline: bool,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = if pretty {
        crate::common::json_pretty(value, ensure_ascii)
    } else {
        crate::common::json_text(value, ensure_ascii)
    };
    if newline {
        text.push('\n');
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(&crate::legacy_text::encode_default(
        &crate::legacy_text::platform_newlines(&text),
        crate::legacy_text::ErrorPolicy::Strict,
    )?)?;
    Ok(())
}
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    // focusq.edit uses open('w'): retain the symlink, inode, mode and metadata.
    write_json_direct(path, value, false, true, true)
}
pub fn replace_json(path: &Path, temporary: &Path, value: &Value) -> Result<()> {
    write_json_direct(temporary, value, true, false, false)?;
    fs::rename(temporary, path)?;
    Ok(())
}
pub fn append_json(path: &Path, value: &Value) -> Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let text = crate::common::json_text(value, true) + "\n";
    file.write_all(&crate::legacy_text::encode_default(
        &crate::legacy_text::platform_newlines(&text),
        crate::legacy_text::ErrorPolicy::Strict,
    )?)?;
    Ok(())
}
#[derive(Debug)]
pub struct ProcessTimeout;
impl fmt::Display for ProcessTimeout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "command timed out")
    }
}
impl Error for ProcessTimeout {}
#[derive(Debug)]
pub struct ProcessFailure {
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}
impl fmt::Display for ProcessFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {}",
            self.command,
            if self.stderr.trim().is_empty() {
                self.stdout.trim()
            } else {
                self.stderr.trim()
            }
        )
    }
}
impl Error for ProcessFailure {}
pub struct ProcessOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_bytes: Vec<u8>,
}
pub fn capture(command: &str, args: &[&str], timeout: Option<f64>) -> Result<ProcessOutput> {
    capture_streams(command, args, timeout, false, false, false)
}
fn capture_streams(
    command: &str,
    args: &[&str],
    timeout: Option<f64>,
    inherit_stdout: bool,
    inherit_stderr: bool,
    binary_stdout: bool,
) -> Result<ProcessOutput> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(if inherit_stdout {
            Stdio::inherit()
        } else {
            Stdio::piped()
        })
        .stderr(if inherit_stderr {
            Stdio::inherit()
        } else {
            Stdio::piped()
        })
        .spawn()?;
    let reader = child.stdout.take().map(|mut out| {
        thread::spawn(move || {
            let mut bytes = vec![];
            let _ = out.read_to_end(&mut bytes);
            bytes
        })
    });
    let errors = child.stderr.take().map(|mut err| {
        thread::spawn(move || {
            let mut bytes = vec![];
            let _ = err.read_to_end(&mut bytes);
            bytes
        })
    });
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if timeout.is_some_and(|seconds| started.elapsed().as_secs_f64() > seconds) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessTimeout.into());
        }
        thread::sleep(Duration::from_millis(20));
    };
    let decode = |bytes: &[u8]| -> Result<String> {
        Ok(crate::legacy_text::universal_newlines(
            &crate::legacy_text::decode_default(bytes, crate::legacy_text::ErrorPolicy::Strict)?,
        ))
    };
    let stdout_bytes = reader
        .map(|r| r.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr_bytes = errors
        .map(|r| r.join().unwrap_or_default())
        .unwrap_or_default();
    Ok(ProcessOutput {
        code: status.code().unwrap_or(1),
        stdout: if binary_stdout {
            String::new()
        } else {
            decode(&stdout_bytes)?
        },
        stderr: decode(&stderr_bytes)?,
        stdout_bytes,
    })
}
/// subprocess.check_output inherits stderr while capturing stdout.
pub fn checked_stdout(command: &str, args: &[&str], timeout: Option<f64>) -> Result<String> {
    let result = capture_streams(command, args, timeout, false, true, false)?;
    if result.code != 0 {
        return Err(ProcessFailure {
            command: command.into(),
            stdout: result.stdout,
            stderr: String::new(),
            code: result.code,
        }
        .into());
    }
    Ok(result.stdout)
}
pub fn checked_json_bytes(command: &str, args: &[&str]) -> Result<Value> {
    let result = capture_streams(command, args, None, false, true, true)?;
    if result.code != 0 {
        return Err(ProcessFailure {
            command: command.into(),
            stdout: String::new(),
            stderr: String::new(),
            code: result.code,
        }
        .into());
    }
    crate::json_bytes::loads(&result.stdout_bytes)
}
/// subprocess.run(check=True) leaves both output streams inherited.
pub fn checked_inherit(command: &str, args: &[&str]) -> Result<()> {
    let result = capture_streams(command, args, None, true, true, false)?;
    if result.code != 0 {
        return Err(ProcessFailure {
            command: command.into(),
            stdout: String::new(),
            stderr: String::new(),
            code: result.code,
        }
        .into());
    }
    Ok(())
}
pub fn checked_output(command: &str, args: &[&str], timeout: Option<f64>) -> Result<String> {
    let result = capture(command, args, timeout)?;
    if result.code != 0 {
        return Err(ProcessFailure {
            command: command.into(),
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code,
        }
        .into());
    }
    Ok(result.stdout)
}
pub fn output(command: &str, args: &[&str], timeout: f64) -> Result<String> {
    checked_output(command, args, Some(timeout))
}
pub fn output_unchecked(command: &str, args: &[&str], timeout: f64) -> Result<String> {
    Ok(capture(command, args, Some(timeout))?.stdout)
}
pub fn json_output(command: &str, args: &[&str], timeout: f64) -> Result<Value> {
    Ok(serde_json::from_str(&output(command, args, timeout)?)?)
}
pub fn json_unchecked(command: &str, args: &[&str], timeout: f64) -> Result<Value> {
    Ok(serde_json::from_str(&output_unchecked(
        command, args, timeout,
    )?)?)
}
pub fn output_unbounded(command: &str, args: &[&str], _legacy_timeout: f64) -> Result<String> {
    checked_output(command, args, None)
}
pub fn error_class(error: &(dyn Error + 'static)) -> &'static str {
    if let Some(error) = error.downcast_ref::<crate::legacy_text::TextError>() {
        error.python_class()
    } else if error.is::<ProcessTimeout>() {
        "TimeoutExpired"
    } else if error.is::<ProcessFailure>() {
        "CalledProcessError"
    } else if error.is::<serde_json::Error>() {
        "JSONDecodeError"
    } else if let Some(error) = error.downcast_ref::<std::io::Error>() {
        match error.kind() {
            std::io::ErrorKind::NotFound => "FileNotFoundError",
            std::io::ErrorKind::PermissionDenied => "PermissionError",
            _ => "OSError",
        }
    } else if error.is::<rusqlite::Error>() {
        "OperationalError"
    } else {
        "ValueError"
    }
}
pub fn alive(path: &Path) -> bool {
    let Some(pid) = fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
        .filter(|p| *p > 0)
    else {
        return false;
    };
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}
pub fn launch(command: &str, args: &[&str]) -> Result<()> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()?;
    Ok(())
}
pub fn self_launch(command: &str, args: &[&str]) -> Result<()> {
    let exe = std::env::current_exe()?;
    let mut all = vec![command];
    all.extend_from_slice(args);
    launch(exe.to_str().ok_or("non-UTF8 executable path")?, &all)
}
pub fn self_launch_logged(command: &str, args: &[&str], stderr: &Path) -> Result<()> {
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(OpenOptions::new().create(true).append(true).open(stderr)?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()?;
    Ok(())
}
pub fn run(command: &str, args: &[String]) -> Result<()> {
    match command.trim_end_matches(".py") {
        "voice_submit_hook" => policy::submit_hook(),
        "voice_probe" => linalg::with_reference(|| probe::run(args)),
        "voice_model_probe" => evaluate::model_probe(args),
        "voice_settings" => {
            voice_println!("{}", settings::load());
            Ok(())
        }
        "voicegate" => gate::run(args),
        "focus_queue" => queue::run(args),
        "codex_focus" => queue::codex_run(args),
        "voice_recovery" => recovery::serve(),
        "focusq" => install::focusq(args),
        "voice_install" => install::run(args),
        "install_codex_focus" => install::codex_install(args),
        "voice_check_other_device" | "check_other_device" => evaluate::crosscheck(),
        "voice_replay_policy" | "replay_voice_policy" => evaluate::replay(args),
        "voice_check_settings" | "check_voice_settings" => evaluate::check_settings(args),
        "voice_eval_vad" | "eval_voice_vad" => evaluate::vad(args),
        "voice_eval_models" | "eval_voice_models" => evaluate::models(args),
        "voice_eval_gate_chain" | "eval_gate_chain" => evaluate::chain(args),
        other => Err(format!("unknown voice command: {other}").into()),
    }
}
#[cfg(test)]
mod review_tests {
    use super::*;
    #[test]
    fn config_write_keeps_existing_inode_links_and_private_mode() {
        let sandbox = tempfile::tempdir().unwrap();
        let target = sandbox.path().join("settings.json");
        let alias = sandbox.path().join("linked.json");
        fs::write(&target, b"{}").unwrap();
        fs::hard_link(&target, &alias).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        }
        write_json(&alias, &serde_json::json!({"voice":true})).unwrap();
        assert_eq!(fs::read(&target).unwrap(), fs::read(&alias).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[cfg(unix)]
    #[test]
    fn config_write_follows_symlink_but_atomic_state_replaces_it() {
        let sandbox = tempfile::tempdir().unwrap();
        let target = sandbox.path().join("actual.json");
        let alias = sandbox.path().join("linked.json");
        fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        write_json(&alias, &serde_json::json!({"a":1})).unwrap();
        assert!(fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&target).unwrap()).unwrap()["a"],
            1
        );
        replace_json(
            &alias,
            &sandbox.path().join("state.tmp"),
            &serde_json::json!({"b":2}),
        )
        .unwrap();
        assert!(!fs::symlink_metadata(&alias)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&target).unwrap()).unwrap()["a"],
            1
        );
    }
    #[test]
    fn recovery_error_class_excludes_private_command_output() {
        let error = ProcessFailure {
            command: "herdr".into(),
            stdout: "private stdout".into(),
            stderr: "private stderr".into(),
            code: 7,
        };
        assert_eq!(error_class(&error), "CalledProcessError");
        assert_eq!(error_class(&ProcessTimeout), "TimeoutExpired");
    }
}
