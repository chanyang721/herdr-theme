//! Original session-sleep subprocess contracts on actual disposable POSIX PTYs.
//! Uses native fixture executables only; no user terminal, app, core or agent.
#![cfg(unix)]
use serde_json::{json, Value};
use std::{
    ffi::CStr,
    fs::{self, File},
    io::{Read, Write},
    os::unix::{
        io::{AsRawFd, FromRawFd},
        process::CommandExt,
    },
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const SID: &str = "11111111-2222-3333-4444-555555555555";
static PTY_NAME: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Terminal {
    master: File,
    slave: File,
}
impl Terminal {
    fn new() -> Self {
        let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
        assert!(master >= 0, "{}", std::io::Error::last_os_error());
        let master = unsafe { File::from_raw_fd(master) };
        assert_eq!(
            unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
        assert_eq!(unsafe { libc::grantpt(master.as_raw_fd()) }, 0);
        assert_eq!(unsafe { libc::unlockpt(master.as_raw_fd()) }, 0);
        let name_guard = PTY_NAME.lock().unwrap();
        let name = unsafe { libc::ptsname(master.as_raw_fd()) };
        assert!(!name.is_null());
        let name = unsafe { CStr::from_ptr(name) }.to_owned();
        drop(name_guard);
        let slave = unsafe { libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY) };
        assert!(slave >= 0);
        let slave = unsafe { File::from_raw_fd(slave) };
        assert_eq!(
            unsafe { libc::fcntl(slave.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
            0
        );
        Self { master, slave }
    }
}
fn run(keys: &[u8], icrnl: bool) -> (Value, String, Vec<Value>) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let tools = root.join("bin");
    fs::create_dir_all(&tools).unwrap();
    fs::create_dir_all(root.join("workspace")).unwrap();
    for name in ["hc", "herdr-app", "herdr-core", "herdr"] {
        fs::copy(
            env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),
            tools.join(name),
        )
        .unwrap();
    }
    let config = root.join("fixture.json");
    fs::write(
        &config,
        json!({"allowProcessContract":true,"allowPtyReceipt":true}).to_string(),
    )
    .unwrap();
    let observer_config = root.join("observer.json");
    fs::write(&observer_config, "{\"harness\":{}}").unwrap();
    let ticket = root.join("ticket.json");
    fs::write(&ticket,json!({"address":"fixture-stub","app":"codex","session_id":SID,"space_id":"fixture-space","space_name":"Fixture Workspace","cwd":root.join("workspace").to_string_lossy(),"argv":[env!("CARGO_BIN_EXE_herdr-theme-test-fixture"),"process-contract","0","resume",SID],"config":observer_config.to_string_lossy(),"title":"synthetic stub"}).to_string()).unwrap();
    let log = root.join("calls.jsonl");
    let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let mut tty = Terminal::new();
    let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
    command
        .args(["session-sleep-stub"])
        .arg(&ticket)
        .current_dir(root)
        .env("PATH", path)
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("home"))
        .env("HERDR_APP_HOME", root.join("app"))
        .env("HERDR_TEST_FIXTURE", &config)
        .env("HERDR_TEST_CALL_LOG", &log)
        .env("HC_TERMINAL_ID", "fixture-stub")
        .env("CLAUDECODE", "fixture-parent")
        .env("CLAUDE_CODE_CHILD_SESSION", "fixture-parent")
        .env("HERDR_PANE_ID", "fixture-parent-pane")
        .stdin(Stdio::from(tty.slave.try_clone().unwrap()))
        .stdout(Stdio::from(tty.slave.try_clone().unwrap()))
        .stderr(Stdio::from(tty.slave.try_clone().unwrap()));
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut attrs = std::mem::MaybeUninit::<libc::termios>::uninit();
            if libc::tcgetattr(0, attrs.as_mut_ptr()) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut attrs = attrs.assume_init();
            if icrnl {
                attrs.c_iflag |= libc::ICRNL
            } else {
                attrs.c_iflag &= !libc::ICRNL
            }
            if libc::tcsetattr(0, libc::TCSANOW, &attrs) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().unwrap();
    drop(command);
    drop(tty.slave);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut output = vec![];
    let mut sent = false;
    let mut receipt = None;
    while Instant::now() < deadline {
        let mut poll = libc::pollfd {
            fd: tty.master.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        assert!(ready >= 0);
        if ready > 0 {
            let mut buf = [0u8; 65536];
            match tty.master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => output.extend_from_slice(&buf[..n]),
                Err(e) if e.raw_os_error() == Some(libc::EIO) => break,
                Err(e) => panic!("PTY read failed: {e}"),
            }
        }
        let text = String::from_utf8_lossy(&output);
        if !sent && text.contains("ctrl+c") {
            tty.master.write_all(keys).unwrap();
            sent = true;
        }
        if let Some((_, rest)) = text.split_once("FIXTURE_AGENT ") {
            if let Some(line) = rest.lines().next() {
                if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                    receipt = Some(v);
                    break;
                }
            }
        }
    }
    if receipt.is_none() {
        let _ = child.kill();
    }
    let wait_deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= wait_deadline {
            let _ = child.kill();
            break child.wait().unwrap();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let text = String::from_utf8_lossy(&output).into_owned();
    assert!(sent, "stub did not become ready: {text}");
    assert!(status.success(), "stub/agent failed: {status}: {text}");
    let receipt = receipt.unwrap_or_else(|| panic!("no agent handover within deadline: {text}"));
    assert!(!text.contains("^M"), "bare CR was not normalized: {text}");
    let calls = fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let labels: Value = serde_json::from_slice(
        &fs::read(root.join("cleared-labels.json")).expect("label clear was not acknowledged"),
    )
    .unwrap();
    assert_eq!(
        labels,
        json!({"sixfold.sleep":"","sixfold.title":"","sixfold.sleep.new":""})
    );
    (receipt, text, calls)
}
fn assert_handover(receipt: &Value, calls: &[Value], message: Option<&str>) {
    let mut args = vec![json!("resume"), json!(SID)];
    if let Some(message) = message {
        args.push(json!(message))
    }
    assert_eq!(receipt["arguments"], json!(args));
    assert_eq!(receipt["cwdMatchesFixture"], true);
    for key in ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "HERDR_PANE_ID"] {
        assert!(
            receipt["markers"].get(key).is_none(),
            "inherited marker survived: {key}"
        );
    }
    assert_eq!(receipt["markers"]["HC_TERMINAL_ID"], "fixture-stub");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["program"], "hc");
    assert_eq!(
        calls[0]["args"],
        json!([
            "label",
            "fixture-stub",
            "sixfold.sleep=",
            "sixfold.title=",
            "sixfold.sleep.new="
        ])
    );
}
#[test]
fn bare_cr_resumes_same_folder_clears_labels_and_identity() {
    let (receipt, _, calls) = run(b"\r", false);
    assert_handover(&receipt, &calls, None);
}
#[test]
fn wrapped_hc_paste_is_handed_to_agent_as_one_prompt() {
    let message = "<hc from=\"fixture-sender\">하네스 이어 열기 확인용입니다. 답만 하세요: OK</hc>";
    let keys = format!("\x1b[200~{message}\x1b[201~\r");
    let (receipt, _, calls) = run(keys.as_bytes(), false);
    assert_handover(&receipt, &calls, Some(message));
}
#[test]
fn long_korean_message_survives_canonical_line_limit() {
    let message = format!("<hc from=\"fixture-sender\">{}</hc>", "가".repeat(1500));
    let keys = format!("{message}\r");
    let (receipt, _, calls) = run(keys.as_bytes(), true);
    assert_handover(&receipt, &calls, Some(&message));
}
