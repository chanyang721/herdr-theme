use crate::common::*;
use serde_json::Value;
#[derive(Default, Debug)]
pub struct StreamBoundary {
    state: u8,
    utf8: u8,
}
impl StreamBoundary {
    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            match self.state {
                0 => {
                    if self.utf8 > 0 {
                        self.utf8 = if (0x80..0xc0).contains(&b) {
                            self.utf8 - 1
                        } else {
                            0
                        };
                        if self.utf8 > 0 || (0x80..0xc0).contains(&b) {
                            continue;
                        }
                    }
                    if b == 0x1b {
                        self.state = 1;
                    } else if (0xc0..0xe0).contains(&b) {
                        self.utf8 = 1;
                    } else if (0xe0..0xf0).contains(&b) {
                        self.utf8 = 2;
                    } else if (0xf0..0xf8).contains(&b) {
                        self.utf8 = 3;
                    }
                }
                1 => {
                    self.state = if b == 0x5b {
                        2
                    } else if [0x5d, 0x50, 0x58, 0x5e, 0x5f].contains(&b) {
                        3
                    } else if (0x20..0x30).contains(&b) {
                        1
                    } else {
                        0
                    };
                }
                2 => {
                    if (0x40..0x7f).contains(&b) {
                        self.state = 0;
                    } else if b == 0x1b {
                        self.state = 1;
                    }
                }
                3 => {
                    if b == 7 {
                        self.state = 0;
                    } else if b == 0x1b {
                        self.state = 4;
                    }
                }
                4 => self.state = if b == 0x5c { 0 } else { 3 },
                _ => unreachable!(),
            }
        }
    }
    pub fn safe(&self) -> bool {
        self.state == 0 && self.utf8 == 0
    }
}
pub fn status_report(pane: &Value) -> Vec<u8> {
    let state = s(&pane["agent_status"]);
    if !["working", "blocked", "done", "idle"].contains(&state) {
        return vec![];
    }
    let agent = pane["agent"]
        .as_str()
        .unwrap_or("agent")
        .chars()
        .filter(|c| crate::python_unicode::is_alphanumeric(*c) || "-_".contains(*c))
        .collect::<String>();
    format!("\x1b]7501;state={state}:app={agent}\x1b\\").into_bytes()
}
fn source(binary: &str, session: &str, pane: &str) -> Result<Value> {
    let out = output(
        binary,
        &strings(&["--session", session, "pane", "get", pane]),
        2.,
    )?;
    let data: Value = serde_json::from_str(&out)?;
    data["result"]
        .get("pane")
        .cloned()
        .ok_or_else(|| "source pane unavailable".into())
}
#[cfg(unix)]
mod unix {
    use super::*;
    use crate::locking::FileLock;
    use sha2::{Digest, Sha256};
    use std::{
        io::Write,
        os::fd::RawFd,
        sync::atomic::{AtomicBool, Ordering},
    };
    static STOP: AtomicBool = AtomicBool::new(false);
    static RESIZE: AtomicBool = AtomicBool::new(true);
    extern "C" fn stop(_: i32) {
        STOP.store(true, Ordering::Relaxed);
    }
    extern "C" fn resize(_: i32) {
        RESIZE.store(true, Ordering::Relaxed);
    }
    struct Terminal {
        old: libc::termios,
        master: RawFd,
        child: i32,
    }
    impl Drop for Terminal {
        fn drop(&mut self) {
            unsafe {
                libc::tcsetattr(0, libc::TCSADRAIN, &self.old);
                libc::close(self.master);
                libc::kill(self.child, libc::SIGHUP);
            }
        }
    }
    fn write(fd: RawFd, mut data: &[u8]) -> Result<()> {
        while !data.is_empty() {
            let n = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
            if n < 0 {
                let e = std::io::Error::last_os_error();
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e.into());
            }
            data = &data[n as usize..];
        }
        Ok(())
    }
    pub fn run(args: &[String]) -> Result<()> {
        let pane = option(args, "--pane").ok_or("--pane required")?;
        let session = option(args, "--session").unwrap_or("default".into());
        let binary = option(args, "--herdr").unwrap_or("herdr".into());
        if unsafe { libc::isatty(0) == 0 || libc::isatty(1) == 0 } {
            return Err("run this inside a Herdr app terminal".into());
        }
        let p = source(&binary, &session, &pane)?;
        let terminal = s(&p["terminal_id"]).to_string();
        if terminal.is_empty() {
            return Err("source terminal identity unavailable".into());
        }
        let dir = home().join(".local/state/herdr-sixfold");
        std::fs::create_dir_all(&dir)?;
        let id = format!(
            "{:x}",
            Sha256::digest(format!("{session}/{terminal}").as_bytes())
        );
        let mut lock = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(dir.join(format!("{}.lock", &id[..24])))?;
        if lock.try_lock_exclusive().is_err() {
            return Err("This source terminal already has a Sixfold bridge.".into());
        }
        lock.set_len(0)?;
        write!(lock, "{}", std::process::id())?;
        lock.flush()?;
        let mut old: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(0, &mut old) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut master = 0;
        let child = unsafe {
            libc::forkpty(
                &mut master,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if child < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if child == 0 {
            use std::os::unix::process::CommandExt;
            let _ = std::process::Command::new(&binary)
                .args([
                    "--session",
                    &session,
                    "terminal",
                    "attach",
                    &terminal,
                    "--takeover",
                ])
                .exec();
            unsafe {
                libc::_exit(127);
            }
        }
        let guard = Terminal { old, master, child };
        unsafe {
            libc::signal(libc::SIGWINCH, resize as usize);
            libc::signal(libc::SIGTERM, stop as usize);
            libc::signal(libc::SIGHUP, stop as usize);
            libc::signal(libc::SIGINT, stop as usize);
            let mut raw = old;
            libc::cfmakeraw(&mut raw);
            libc::tcsetattr(0, libc::TCSANOW, &raw);
        }
        let (mut last_report, mut last_title, mut next_check, mut boundary, mut pending) = (
            Vec::new(),
            String::new(),
            0.,
            StreamBoundary::default(),
            Vec::new(),
        );
        let mut buffer = [0u8; 65536];
        while !STOP.load(Ordering::Relaxed) {
            if RESIZE.swap(false, Ordering::Relaxed) {
                unsafe {
                    let mut size: libc::winsize = std::mem::zeroed();
                    if libc::ioctl(0, libc::TIOCGWINSZ, &mut size) == 0 {
                        libc::ioctl(master, libc::TIOCSWINSZ, &size);
                        libc::kill(child, libc::SIGWINCH);
                    }
                }
            }
            let mut polls = [
                libc::pollfd {
                    fd: 0,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: master,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let ready = unsafe { libc::poll(polls.as_mut_ptr(), 2, 100) };
            if ready < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if polls[1].revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                let n = unsafe { libc::read(master, buffer.as_mut_ptr().cast(), buffer.len()) };
                if n <= 0 {
                    break;
                }
                write(1, &buffer[..n as usize])?;
                boundary.feed(&buffer[..n as usize]);
            }
            if !pending.is_empty() && boundary.safe() {
                write(1, &pending)?;
                pending.clear();
            }
            if polls[0].revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                let n = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), buffer.len()) };
                if n <= 0 {
                    break;
                }
                write(master, &buffer[..n as usize])?;
            }
            if now() >= next_check {
                next_check = now() + 1.;
                let current = source(&binary, &session, &pane).and_then(|p| {
                    if p["terminal_id"] != terminal {
                        Err("source terminal changed".into())
                    } else {
                        Ok(p)
                    }
                });
                match current {
                    Ok(p) => {
                        let report = status_report(&p);
                        let title = s(&p["terminal_title_stripped"])
                            .chars()
                            .filter(|c| !c.is_control())
                            .collect::<String>();
                        if !title.is_empty() && title != last_title {
                            pending.extend(format!("\x1b]0;{title}\x07").as_bytes());
                            last_title = title;
                        }
                        if !report.is_empty() && report != last_report {
                            pending.extend(&report);
                            last_report = report;
                        }
                    }
                    Err(_) => {
                        let report = b"\x1b]7501;state=blocked:app=sixfold-bridge\x1b\\".to_vec();
                        if report != last_report {
                            pending.extend(&report);
                            last_report = report;
                        }
                    }
                }
            }
        }
        drop(guard);
        Ok(())
    }
}
pub fn run(args: &[String]) -> Result<()> {
    #[cfg(unix)]
    {
        unix::run(args)
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        Err("The TUI PTY bridge requires a POSIX terminal".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn after(chunks: &[&[u8]]) -> bool {
        let mut boundary = StreamBoundary::default();
        for chunk in chunks {
            boundary.feed(chunk);
        }
        boundary.safe()
    }
    #[test]
    fn test_split_mouse_mode_is_not_a_safe_injection_point() {
        assert!(!after(&[b"\x1b[?100"]));
        assert!(after(&[b"\x1b[?100", b"6h"]));
        assert!(!after(&[b"\x1b"]));
    }
    #[test]
    fn test_split_osc_and_string_terminators() {
        assert!(!after(&[b"\x1b]0;title"]));
        assert!(!after(&[b"\x1b]0;title\x1b"]));
        assert!(after(&[b"\x1b]0;title\x1b", b"\\"]));
        assert!(after(&[b"\x1b]0;title\x07"]));
        assert!(!after(&[b"\x1bP+q"]));
    }
    #[test]
    fn test_charset_designation_and_split_utf8() {
        assert!(!after(&[b"\x1b("]));
        assert!(after(&[b"\x1b(B"]));
        let text = "스크롤".as_bytes();
        assert!(!after(&[&text[..4]]));
        assert!(after(&[&text[..4], &text[4..]]));
        assert!(after(&[b"plain \x1b[31mred\x1b[0m"]));
    }
    #[test]
    fn split_csi_utf8_and_osc_never_accept_injection() {
        let mut b = StreamBoundary::default();
        b.feed(b"\x1b[?100");
        assert!(!b.safe());
        b.feed(b"6h");
        assert!(b.safe());
        let c = "한".as_bytes();
        b.feed(&c[..1]);
        assert!(!b.safe());
        b.feed(&c[1..]);
        assert!(b.safe());
        b.feed(b"\x1b]0;title\x1b");
        assert!(!b.safe());
        b.feed(b"\\");
        assert!(b.safe());
    }
    #[test]
    fn unknown_state_is_not_done() {
        assert!(status_report(&serde_json::json!({"agent_status":"lost"})).is_empty());
    }
}
