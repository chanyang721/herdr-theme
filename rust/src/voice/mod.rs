//! Native implementations of the optional macOS voice plugin. All subprocesses
//! below are system/Herdr tools; no interpreter is used by installed entry points.
pub mod audio;
pub mod evaluate;
pub mod gate;
pub mod install;
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
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_file_name(format!(
        ".{}-{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let mut f = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let result = (|| -> Result<()> {
        serde_json::to_writer_pretty(&mut f, value)?;
        f.write_all(b"\n")?;
        f.sync_all()?;
        drop(f);
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if temp.exists() {
        let _ = fs::remove_file(temp);
    }
    result
}
pub fn append_json(path: &Path, value: &Value) -> Result<()> {
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut f, value)?;
    f.write_all(b"\n")?;
    Ok(())
}
pub fn output(command: &str, args: &[&str], timeout: f64) -> Result<String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        let mut bytes = vec![];
        let _ = out.read_to_end(&mut bytes);
        bytes
    });
    let errors = thread::spawn(move || {
        let mut bytes = vec![];
        let _ = err.read_to_end(&mut bytes);
        bytes
    });
    let deadline = now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{command} timed out").into());
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&errors.join().unwrap_or_default()).into_owned();
    if !status.success() {
        return Err(format!(
            "{command}: {}",
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        )
        .into());
    }
    Ok(stdout)
}
pub fn json_output(command: &str, args: &[&str], timeout: f64) -> Result<Value> {
    Ok(serde_json::from_str(&output(command, args, timeout)?)?)
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
            println!("{}", settings::load());
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
