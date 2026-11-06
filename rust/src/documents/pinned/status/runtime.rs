use super::*;
use base64::Engine;
pub fn parse_claude(text: &str) -> Value {
    let mut rows = vec![];
    let mut seen = BTreeSet::new();
    let line = re(r"^(?P<name>[^\s].*?): .* - (?P<mark>[✔✘!⏸]) (?P<text>.*)$");
    for raw in py::split_lines(text) {
        if let Some(m) = line.captures(py::trim(raw)) {
            let name = &m["name"];
            if !seen.insert(name.to_owned()) {
                continue;
            }
            let state = match &m["mark"] {
                "✔" => "connected",
                "!" => "needs_auth",
                "✘" => "failed",
                "⏸" => "pending",
                _ => "unknown",
            };
            rows.push(json!({"agent":"claude","name":name,"state":state,"reason":clean_reason(&m["text"])}));
        }
    }
    json!(rows)
}
pub fn parse_codex(text: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(if text.is_empty() { "[]" } else { text })
        .map_err(|_| std::io::Error::other("Codex 목록을 읽을 수 없음"))?;
    let Some(rows) = v.as_array() else {
        return err("Codex 목록 형식이 다름");
    };
    let mut out = vec![];
    for row in rows {
        if !row.is_object() || !row["name"].is_string() || row["enabled"] == false {
            continue;
        }
        let auth = row["auth_status"].as_str().unwrap_or("unknown");
        if auth == "not_logged_in" {
            out.push(json!({"agent":"codex","name":row["name"],"state":"needs_auth","reason":"Codex: 로그인 필요"}));
        } else {
            let label = match auth {
                "o_auth" => "OAuth 로그인됨",
                "bearer_token" => "토큰 설정됨",
                "unsupported" => "인증 없음",
                _ => "인증 상태 미확인",
            };
            out.push(json!({"agent":"codex","name":row["name"],"state":"unknown","reason":format!("Codex: 설정됨, 연결은 확인하지 않음 ({label})")}));
        }
    }
    Ok(json!(out))
}
fn claude_sessions() -> Vec<i64> {
    #[cfg(windows)]
    {
        return vec![];
    }
    #[cfg(not(windows))]
    {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".claude"))
            .join("sessions");
        let mut paths = fs::read_dir(root)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "json"))
            .collect::<Vec<_>>();
        paths.sort();
        let mut starts = vec![];
        for path in paths.into_iter().take(200) {
            let v = load(path, Value::Null).unwrap_or(Value::Null);
            let (pid, start) = (
                v["pid"].as_i64().unwrap_or(0),
                v["startedAt"].as_i64().unwrap_or(0),
            );
            if pid <= 0 || start <= 0 {
                continue;
            }
            if unsafe { libc::kill(pid as libc::pid_t, 0) } < 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                continue;
            }
            starts.push(start);
        }
        starts
    }
}
fn mcp_collect(codex: bool, timeout: f64, runner: &Runner<'_>) -> Value {
    let (mut servers, mut errors) = (vec![], json!({}));
    match runner("claude", &strings(&["mcp", "list"]), timeout) {
        Ok((_, out, _)) => servers.extend(arr(&parse_claude(&out))),
        Err(e) => errors["claude"] = json!(clean_reason(&e.to_string())),
    }
    if codex {
        match runner("codex", &strings(&["mcp", "list", "--json"]), timeout)
            .and_then(|(_, out, _)| parse_codex(&out))
        {
            Ok(v) => servers.extend(arr(&v)),
            Err(e) => errors["codex"] = json!(clean_reason(&e.to_string())),
        }
    }
    json!({"updated":clock() as i64,"servers":servers,"errors":errors,"claude_sessions":claude_sessions()})
}
fn sign_in_files(
    c: &Value,
    home: &Path,
    env: &BTreeMap<String, String>,
) -> BTreeMap<String, (Vec<PathBuf>, Vec<PathBuf>)> {
    let mut out = BTreeMap::new();
    if truth(&c["aws"]) {
        let files = [
            ("AWS_CONFIG_FILE", ".aws/config"),
            ("AWS_SHARED_CREDENTIALS_FILE", ".aws/credentials"),
        ]
        .into_iter()
        .map(|(e, p)| {
            env.get(e)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(p))
        })
        .collect();
        out.insert(
            "aws".into(),
            (
                files,
                vec![home.join(".aws/sso/cache"), home.join(".aws/login/cache")],
            ),
        );
    }
    if truth(&c["github"]) {
        let base = env
            .get("GH_CONFIG_DIR")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(windows) && env.get("APPDATA").is_some_and(|v| !v.is_empty()) {
                    PathBuf::from(&env["APPDATA"]).join("GitHub CLI")
                } else {
                    home.join(".config/gh")
                }
            });
        out.insert("github".into(), (vec![base.join("hosts.yml")], vec![]));
    }
    if truth(&c["kubectl"]) {
        let mut paths = env
            .get("KUBECONFIG")
            .map(|v| {
                v.split(if cfg!(windows) { ';' } else { ':' })
                    .filter(|p| !p.is_empty())
                    .take(8)
                    .map(PathBuf::from)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if paths.is_empty() {
            paths.push(home.join(".kube/config"))
        }
        out.insert("kubectl".into(), (paths, vec![]));
    }
    if truth(&c["salesforce"]) {
        out.insert(
            "salesforce".into(),
            (vec![], vec![home.join(".sfdx"), home.join(".sf")]),
        );
    }
    out
}
fn stamps(c: &Value, home: &Path, env: &BTreeMap<String, String>) -> Value {
    let mut out = json!({});
    for (kind, (mut files, folders)) in sign_in_files(c, home, env) {
        for folder in folders {
            let mut matches = fs::read_dir(folder)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|e| e == "json"))
                .collect::<Vec<_>>();
            matches.sort();
            files.extend(matches.into_iter().take(200));
        }
        let mut rows = vec![];
        for path in files {
            if let Ok(metadata) = fs::metadata(&path) {
                if let Ok(modified) = metadata
                    .modified()
                    .and_then(|m| m.duration_since(UNIX_EPOCH).map_err(std::io::Error::other))
                {
                    rows.push(format!(
                        "{}\0{}\0{}",
                        path.display(),
                        metadata.len(),
                        modified.as_nanos()
                    ));
                }
            }
        }
        rows.sort();
        out[&kind] = json!(take(&hash(rows.join("\n")), 16));
    }
    out
}
fn cached(path: &Path, key: &str) -> Option<Value> {
    let value = load(path, Value::Null).ok()?;
    if value.is_object() && value[key].is_array() {
        Some(value)
    } else {
        None
    }
}
// These two pinned collectors explicitly used msvcrt byte zero rather than
// Sixfold's metadata-compatible reserved byte; retain that separate protocol.
fn status_lock(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(not(windows))]
    {
        fs2::FileExt::try_lock_exclusive(file)
    }
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            internal_high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut c_void,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn LockFileEx(
                handle: *mut c_void,
                flags: u32,
                reserved: u32,
                low: u32,
                high: u32,
                overlap: *mut Overlapped,
            ) -> i32;
        }
        let mut overlap = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        if unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlap) } != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}
fn clipboard(text: &str) -> Result<()> {
    let mut payload = Some(text.to_owned());
    let argv: Vec<String>;
    if cfg!(windows) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let script=format!("$ErrorActionPreference='Stop';Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))");
        let utf16: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let command = base64::engine::general_purpose::STANDARD.encode(utf16);
        argv = strings(&[
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &command,
        ]);
        payload = None;
    } else if cfg!(target_os = "macos") {
        argv = strings(&["/usr/bin/pbcopy"]);
    } else {
        let tool = program("wl-copy", false)
            .or_else(|| program("xclip", false))
            .ok_or_else(|| std::io::Error::other("클립보드 명령을 찾을 수 없음"))?;
        argv = if tool.file_name().unwrap_or_default() == "wl-copy" {
            vec![tool.to_string_lossy().into_owned()]
        } else {
            strings(&[&tool.to_string_lossy(), "-selection", "clipboard"])
        };
    }
    let mut command = crate::common::command(&argv[0]);
    command
        .args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let Some(text) = payload {
        child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("clipboard stdin unavailable"))?
            .write_all(text.as_bytes())?;
    } else {
        drop(child.stdin.take());
    }
    use wait_timeout::ChildExt;
    match child.wait_timeout(Duration::from_secs(10))? {
        Some(s) if s.success() => Ok(()),
        Some(s) => err(format!("clipboard exited {}", s.code().unwrap_or(1))),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            err("clipboard timed out")
        }
    }
}
fn option(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .cloned()
}
fn number(args: &[String], key: &str, default: &str) -> Result<f64> {
    let value = option(args, key).unwrap_or(default.into());
    value.parse().map_err(|_| {
        Box::new(crate::common::CliError {
            code: 2,
            message: format!("argument {key}: invalid float value: {value:?}"),
        }) as Box<dyn std::error::Error>
    })
}
pub fn cli_status(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        crate::common::print_line("Sign-in state of account CLIs as JSON. --data DIR [--config FILE] [--stamps] [--max-age 200] [--timeout 15] | --copy TEXT")?;
        return Ok(());
    }
    crate::observers::validate_args(
        args,
        &["--data", "--config", "--max-age", "--timeout", "--copy"],
        &["--stamps"],
    )?;
    let max_age = number(args, "--max-age", "200")?;
    let timeout = number(args, "--timeout", "15")?;
    if let Some(text) = option(args, "--copy") {
        clipboard(&text)?;
        crate::common::print(&json!({"copied":true}))?;
        return Ok(());
    }
    let Some(data) = option(args, "--data") else {
        return crate::observers::arg_error("--data is required for status checks");
    };
    let data = PathBuf::from(data);
    let c = read_config(option(args, "--config").as_deref());
    let env: BTreeMap<_, _> = std::env::vars().collect();
    let last = cached(&data.join("last.json"), "items");
    let stamp = stamps(&c, &home(), &env);
    if args.iter().any(|a| a == "--stamps") {
        let changed = if last.as_ref().is_none_or(|last| last["config"] != c) {
            vec!["config".to_string()]
        } else {
            stamp
                .as_object()
                .unwrap()
                .iter()
                .filter(|(k, v)| last.as_ref().unwrap()["stamps"][*k] != **v)
                .map(|(k, _)| k.clone())
                .collect()
        };
        crate::common::print(&json!({"changed":changed}))?;
        return Ok(());
    }
    if let Some(mut last) = last.clone() {
        if last["config"] == c
            && clock() - num(&last["updated"], 0.) < max_age
            && last["stamps"] == stamp
        {
            last["cached"] = json!(true);
            crate::common::print(&last)?;
            return Ok(());
        }
    }
    fs::create_dir_all(&data)?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(data.join("run.lock"))?;
    if status_lock(&lock).is_err() {
        let mut last = last.unwrap_or(json!({"items":[],"errors":{}}));
        last["busy"] = json!(true);
        crate::common::print(&last)?;
        return Ok(());
    }
    let mut result = cli_collect(&c, timeout, &cli_run, clock());
    result["updated"] = json!(clock() as i64);
    result["config"] = c.clone();
    result["stamps"] = stamps(&c, &home(), &env);
    save(&data.join("last.json"), &result)?;
    crate::common::print(&result)?;
    Ok(())
}
pub fn mcp_status(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        crate::common::print_line("MCP server connection states as JSON. --data DIR [--codex] [--max-age 150] [--timeout 40] | --copy TEXT")?;
        return Ok(());
    }
    crate::observers::validate_args(
        args,
        &["--data", "--max-age", "--timeout", "--copy"],
        &["--codex"],
    )?;
    let max_age = number(args, "--max-age", "150")?;
    let timeout = number(args, "--timeout", "40")?;
    if let Some(text) = option(args, "--copy") {
        clipboard(&text)?;
        crate::common::print(&json!({"copied":true}))?;
        return Ok(());
    }
    let Some(data) = option(args, "--data") else {
        return crate::observers::arg_error("--data is required for status checks");
    };
    let data = PathBuf::from(data);
    let codex = args.iter().any(|a| a == "--codex");
    let last = cached(&data.join("last.json"), "servers");
    if let Some(mut last) = last.clone() {
        if last["codex"] == codex && clock() - num(&last["updated"], 0.) < max_age {
            last["cached"] = json!(true);
            crate::common::print(&last)?;
            return Ok(());
        }
    }
    fs::create_dir_all(&data)?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(data.join("run.lock"))?;
    if status_lock(&lock).is_err() {
        let mut last = last.unwrap_or(json!({"servers":[],"errors":{}}));
        last["busy"] = json!(true);
        crate::common::print(&last)?;
        return Ok(());
    }
    let mut result = mcp_collect(codex, timeout, &mcp_run);
    result["codex"] = json!(codex);
    save(&data.join("last.json"), &result)?;
    crate::common::print(&result)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_never_leave_reasons() {
        let r=clean_reason("Bearer abcdefghijklmnopqrstuvwxyz token=secret https://x.test?token=a /home/alice/project");
        assert!(!r.contains("abcdefghijklmnopqrstuvwxyz"));
        assert!(!r.contains("secret"));
        assert!(!r.contains("alice"));
        assert!(!r.contains("x.test"));
    }
    #[test]
    fn codex_configuration_is_never_connected() {
        let rows = parse_codex(
            r#"[{"name":"s","auth_status":"o_auth"},{"name":"n","auth_status":"not_logged_in"}]"#,
        )
        .unwrap();
        assert_eq!(rows[0]["state"], "unknown");
        assert_eq!(rows[1]["state"], "needs_auth");
    }
    #[test]
    fn default_config_is_allowlisted() {
        let c = config_value(
            &json!({"aws":{"profiles":["safe","bad name","../../x"]},"github":null,"salesforce":{"orgs":["alias","user@example.com"]}}),
        );
        assert_eq!(c["aws"]["profiles"], json!(["safe"]));
        assert_eq!(c["github"], true);
        assert_eq!(c["salesforce"]["orgs"], json!(["alias"]));
    }
}
