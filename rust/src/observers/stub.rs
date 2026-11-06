use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
static INTERRUPTED: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Relaxed);
}
pub fn message_of(data: &[u8]) -> String {
    let text = String::from_utf8_lossy(data)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("\x1b[200~", "")
        .replace("\x1b[201~", "");
    crate::python_unicode::trim(&text).to_owned()
}
pub fn launch(ticket: &Value) -> Vec<String> {
    let argv = arr(&ticket["argv"])
        .iter()
        .map(|x| s(x).to_owned())
        .collect::<Vec<_>>();
    if truth(&ticket["new_session"])
        || !truth(&ticket["session_id"])
        || argv.is_empty()
        || !["claude", "codex"].contains(
            &Path::new(&argv[0])
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        )
    {
        return argv;
    }
    let app = if truth(&ticket["app"]) {
        s(&ticket["app"])
    } else {
        Path::new(&argv[0])
            .file_name()
            .unwrap_or_default()
            .to_str()
            .unwrap_or("")
    };
    sessions::resume_argv(app, &argv, s(&ticket["session_id"])).unwrap_or(argv)
}
pub fn command_of(ticket: &Value, message: &str) -> Vec<String> {
    let mut a = launch(ticket);
    if !message.is_empty() {
        a.push(message.into())
    }
    a
}
pub fn shown(argv: &[String], limit: usize) -> String {
    let mut a = argv.to_vec();
    if let Some(first) = a.first_mut() {
        *first = Path::new(first)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }
    let t = crate::python_unicode::split_whitespace(&a.join(" ")).join(" ");
    if t.chars().count() <= limit {
        t
    } else {
        format!("{}…", take(&t, limit.saturating_sub(1)))
    }
}
pub fn clean_env() -> Vec<(String, String)> {
    let agent = [
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
    ];
    let pane = ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"];
    let hc = std::env::var_os("HC_TERMINAL_ID").is_some_and(|v| !v.is_empty());
    std::env::vars()
        .filter(|(k, _)| !agent.contains(&k.as_str()) && !(hc && pane.contains(&k.as_str())))
        .collect()
}
pub fn clear_labels(address: &str) {
    if address.is_empty() {
        return;
    }
    let _ = execute(
        &strings(&[
            "hc",
            "label",
            address,
            "sixfold.sleep=",
            "sixfold.title=",
            "sixfold.sleep.new=",
        ]),
        10.,
        false,
    );
}
pub fn record_resumed(ticket: &Value) {
    let path = if truth(&ticket["config"]) {
        PathBuf::from(s(&ticket["config"]))
    } else {
        spaces::state_dir().join("sleep-idle-sessions.json")
    };
    let _ = (|| -> Result<()> {
        let c = load(path, json!({}))?;
        let mut a = sessions::harness_command(&c)?;
        a.extend(strings(&[
            "park",
            s(&ticket["address"]),
            "--provider",
            sessions::provider(s(&ticket["app"])),
            "--session-id",
            s(&ticket["session_id"]),
            "--space-id",
            s(&ticket["space_id"]),
            "--event",
            "resumed",
            "--done",
            &format!(
                "{} {}: resumed from sleep",
                ticket["space_name"].as_str().unwrap_or("?"),
                s(&ticket["address"])
            ),
            "--mask",
        ]));
        let _ = execute(&a, 30., false)?;
        Ok(())
    })();
}
#[cfg(unix)]
struct Tty {
    saved: Option<libc::termios>,
    old_signal: libc::sighandler_t,
}
#[cfg(unix)]
impl Tty {
    fn new() -> Self {
        let mut saved = std::mem::MaybeUninit::<libc::termios>::uninit();
        let saved = if unsafe { libc::tcgetattr(0, saved.as_mut_ptr()) } == 0 {
            Some(unsafe { saved.assume_init() })
        } else {
            None
        };
        if let Some(mut attrs) = saved {
            attrs.c_iflag = (attrs.c_iflag | libc::ICRNL) & !(libc::IGNCR | libc::INLCR);
            attrs.c_lflag = (attrs.c_lflag | libc::ECHO | libc::ISIG) & !libc::ICANON;
            attrs.c_cc[libc::VMIN] = 1;
            attrs.c_cc[libc::VTIME] = 0;
            unsafe { libc::tcsetattr(0, libc::TCSANOW, &attrs) };
        }
        let old_signal = unsafe { libc::signal(libc::SIGINT, interrupt as libc::sighandler_t) };
        Self { saved, old_signal }
    }
}
#[cfg(unix)]
impl Drop for Tty {
    fn drop(&mut self) {
        if let Some(attrs) = self.saved {
            unsafe { libc::tcsetattr(0, libc::TCSANOW, &attrs) };
        }
        unsafe { libc::signal(libc::SIGINT, self.old_signal) };
    }
}
#[cfg(windows)]
mod win {
    use super::*;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    unsafe extern "system" fn handler(event: u32) -> i32 {
        if event == 0 || event == 1 {
            INTERRUPTED.store(true, Ordering::Relaxed);
            1
        } else {
            0
        }
    }
    pub struct Tty;
    impl Tty {
        pub fn new() -> Self {
            // Original tty_input imports termios and returns None on Windows:
            // preserve its console mode while retaining KeyboardInterrupt.
            unsafe { SetConsoleCtrlHandler(Some(handler), 1) };
            Self
        }
    }
    impl Drop for Tty {
        fn drop(&mut self) {
            unsafe { SetConsoleCtrlHandler(Some(handler), 0) };
        }
    }
}
pub fn read_message(settle: f64, limit: usize) -> Result<Vec<u8>> {
    let mut data = vec![];
    #[cfg(unix)]
    let mut last = Instant::now();
    #[cfg(windows)]
    let _ = settle;
    while data.len() < limit {
        if INTERRUPTED.load(Ordering::Relaxed) {
            return err("interrupted");
        }
        #[cfg(unix)]
        {
            let mut p = libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut p, 1, 100) };
            if ready < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e.into());
            }
            if ready == 0 {
                if data.last().is_some_and(|b| *b == b'\r' || *b == b'\n')
                    && last.elapsed().as_secs_f64() >= settle
                {
                    break;
                }
                continue;
            }
        }
        #[cfg(windows)]
        if data.last().is_some_and(|b| *b == b'\r' || *b == b'\n') {
            // Baseline CPython select.select([stdin_fd], ..., settle) is not a
            // Windows pipe/console operation. It raises before label changes,
            // a resumed record or agent exec; migration must not resume here.
            return Err(std::io::Error::from_raw_os_error(10093).into());
        }
        let mut bytes = [0u8; 4096];
        let n = std::io::stdin().read(&mut bytes)?;
        if n == 0 {
            break;
        }
        for byte in &bytes[..n] {
            if *byte == 0x7f || *byte == 0x08 {
                data.pop();
            } else {
                data.push(*byte);
            }
        }
        #[cfg(unix)]
        {
            last = Instant::now();
        }
    }
    Ok(data)
}
pub fn main(args: &[String]) -> Result<()> {
    let path = args
        .first()
        .ok_or_else(|| std::io::Error::other("ticket path required"))?;
    let mut ticket = load(path, Value::Null)?;
    if !ticket.is_object() {
        return err("invalid sleep ticket");
    }
    INTERRUPTED.store(false, Ordering::Relaxed);
    #[cfg(unix)]
    let tty = Tty::new();
    #[cfg(windows)]
    let tty = win::Tty::new();
    crate::common::print_line("")?;
    crate::common::print_line(
        format!(
            "  절전 중 — {} {} {}",
            s(&ticket["space_name"]),
            s(&ticket["address"]),
            s(&ticket["title"])
        )
        .trim_end_matches(crate::python_unicode::is_space),
    )?;
    crate::common::print_line(
        "  Enter: 이어 열기 · 메시지를 보내면 이어 열고 그대로 전달 · ctrl+c: 셸로 나가기",
    )?;
    crate::common::print_line(&format!("  직접 열기: {}", shown(&launch(&ticket), 72)))?;
    crate::common::print_line("")?;
    std::io::stdout().flush()?;
    let data = read_message(0.6, 64 * 1024);
    #[cfg(any(unix, windows))]
    drop(tty);
    let data = if INTERRUPTED.load(Ordering::Relaxed) {
        err("interrupted")
    } else {
        data
    };
    let data = match data {
        Ok(v) => v,
        Err(e) if e.to_string() == "interrupted" => {
            clear_labels(s(&ticket["address"]));
            return Err(Box::new(crate::voice::Exit(130)));
        }
        Err(e) => return Err(e),
    };
    if data.is_empty() {
        return Ok(());
    }
    let message = message_of(&data);
    if let Ok(new) = load(path, Value::Null) {
        if let Some(o) = new.as_object() {
            for (k, v) in o {
                ticket[k] = v.clone();
            }
        }
    }
    clear_labels(s(&ticket["address"]));
    record_resumed(&ticket);
    if truth(&ticket["cwd"]) && Path::new(s(&ticket["cwd"])).is_dir() {
        std::env::set_current_dir(s(&ticket["cwd"]))?
    }
    let argv = command_of(&ticket, &message);
    if argv.is_empty() {
        return err("empty agent command");
    }
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).env_clear().envs(clean_env());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        return Err(command.exec().into());
    }
    #[cfg(not(unix))]
    {
        let code = command.status()?.code().unwrap_or(1);
        if code != 0 {
            return Err(Box::new(crate::voice::Exit(code)));
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paste_and_bare_cr() {
        assert_eq!(
            message_of(b"\x1b[200~hello\r\nworld\x1b[201~\r"),
            "hello\nworld"
        );
    }
    #[test]
    fn old_ticket_prompt_is_not_replayed() {
        let t = json!({"app":"claude","session_id":"s","argv":["claude","--model","m","--resume","old","old prompt"]});
        assert_eq!(
            command_of(&t, "new message"),
            strings(&["claude", "--model", "m", "--resume", "s", "new message"])
        );
    }
    #[test]
    fn new_session_ticket_kept() {
        let t = json!({"new_session":true,"argv":["claude"]});
        assert_eq!(launch(&t), strings(&["claude"]));
    }
}
