//! Pinned workspace-mods CLI/MCP status collectors. Secret-bearing command output is
//! reduced to explicitly allowlisted display fields before caching or printing.
use crate::documents::common::Result;
use crate::observers::{
    arr, err, execute_with, hash, home, load, num, s, save, strings, take, truth,
};
use crate::python_unicode::{self as py, regex as re};
use serde_json::{json, Value};
#[cfg(test)]
mod contracts;
mod runtime;
pub use runtime::{cli_status, mcp_status, parse_claude, parse_codex};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
type Reply = (i32, String, String);
type Runner<'a> = dyn Fn(&str, &[String], f64) -> Result<Reply> + Send + Sync + 'a;
const NAME: &str = r"^[\w.@+-]{1,64}$";
const ALIAS: &str = r"^[\w.+-]{1,40}$";
fn clock() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn config_value(value: &Value) -> Value {
    let mut c = json!({"aws":{"profiles":null},"github":true,"kubectl":true,"docker":true,"salesforce":{"orgs":null}});
    for kind in ["aws", "github", "kubectl", "docker", "salesforce"] {
        if let Some(v) = value.get(kind) {
            c[kind] = v.clone()
        }
    }
    for (kind, key, pattern) in [("aws", "profiles", NAME), ("salesforce", "orgs", ALIAS)] {
        if c[kind] == false {
            continue;
        }
        let names = c[kind][key].as_array().map(|a| {
            a.iter()
                .filter(|v| v.as_str().is_some_and(|n| re(pattern).is_match(n)))
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
        });
        c[kind] = json!({});
        c[kind][key] = json!(names);
    }
    for kind in ["github", "kubectl", "docker"] {
        c[kind] = json!(c[kind] != false)
    }
    c
}
fn read_config(path: Option<&str>) -> Value {
    let v = path
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(json!({}));
    config_value(&v)
}
fn trim_reason(t: &str, limit: usize) -> String {
    let t = py::sub(r"\s+", t, " ");
    let t = t.trim_matches([' ', '—', '-', ':']);
    if t.chars().count() > limit {
        format!("{}…", take(t, limit - 1))
    } else {
        t.into()
    }
}
pub fn mask(text: &str) -> String {
    let t = py::sub(r#"\barn:aws[\w-]*:[^\s"]*"#, text, "<ARN>");
    let t = py::sub(r"\b\d{8}(\d{4})\b", &t, "…$1");
    let t = py::sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://\S+", &t, "<주소>");
    let t = py::sub(r"\b[A-Za-z0-9_\-+/=]{24,}\b", &t, "<가림>");
    let t = py::sub(
        r"(/Users|/home|[A-Z]:\\Users)[/\\][^/\\\s]+",
        &t,
        "$1/<사용자>",
    );
    trim_reason(&t, 120)
}
pub fn clean_reason(text: &str) -> String {
    let t = py::sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://\S+", text, "<주소>");
    let t = py::sub(r"(?i)\b(bearer|bas[iİı]c)\s+\S+", &t, "$1 <가림>");
    let t = py::sub(
        r"(?i)\b([\w-]*(token|secret|password|passwd|ap[iİı][_-]?key|auth|cook[iİı]e|sess[iİı]on)[\w-]*)\s*[=:]\s*\S+",
        &t,
        "$1=<가림>",
    );
    let t = py::sub(r"\S*[?&][\w.-]+=\S*", &t, "<가림>");
    let t = py::sub(r"\b[A-Za-z0-9_\-+/=.]{24,}\b", &t, "<가림>");
    let t = py::sub(
        r"(/Users|/home|[A-Z]:\\Users)[/\\][^/\\\s]+",
        &t,
        "$1/<사용자>",
    );
    trim_reason(&t, 140)
}
fn program(name: &str, mcp: bool) -> Option<PathBuf> {
    let mut paths =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    paths.push(home().join(".local/bin"));
    if mcp {
        paths.push(home().join(".claude/local"));
    }
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if !mcp {
        paths.push(PathBuf::from(
            "/Applications/Docker.app/Contents/Resources/bin",
        ));
    }
    for p in paths {
        let raw = p.join(name);
        if raw.is_file() && executable(&raw) {
            return Some(raw);
        }
        #[cfg(windows)]
        for ext in std::env::var("PATHEXT")
            .unwrap_or(".COM;.EXE;.BAT;.CMD".into())
            .split(';')
        {
            let p = p.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}
fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
fn cli_run(name: &str, args: &[String], timeout: f64) -> Result<Reply> {
    let p = program(name, false).ok_or_else(|| std::io::Error::other(format!("MISSING:{name}")))?;
    let mut argv = vec![p.to_string_lossy().into_owned()];
    argv.extend_from_slice(args);
    match execute_with(&argv, timeout, false, |c| {
        c.current_dir(home());
    }) {
        Ok(o) => Ok((o.code, o.stdout, o.stderr)),
        Err(e) if e.to_string().contains("timed out") => Ok((
            124,
            String::new(),
            format!("{}초 안에 응답 없음", timeout as i64),
        )),
        Err(e) => Err(e),
    }
}
fn mcp_run(name: &str, args: &[String], timeout: f64) -> Result<Reply> {
    let p = program(name, true)
        .ok_or_else(|| std::io::Error::other(format!("{name} 명령을 찾을 수 없음")))?;
    let mut argv = vec![p.to_string_lossy().into_owned()];
    argv.extend_from_slice(args);
    let o = execute_with(&argv, timeout, false, |c| {
        c.current_dir(home());
    })
    .map_err(|e| {
        std::io::Error::other(if e.to_string().contains("timed out") {
            format!("{name} 응답이 {}초 안에 없음", timeout as i64)
        } else {
            e.to_string()
        })
    })?;
    if o.code != 0 {
        return err(format!("{name} 종료 코드 {}", o.code));
    }
    Ok((o.code, o.stdout, o.stderr))
}
pub fn aws_failure(stderr: &str) -> (String, String) {
    if re(r"(?i)NoCredent[iİı]als|Unable to locate credent[iİı]als|could not be found|prof[iİı]le .* not found")
        .is_match(stderr)
    {
        return ("none".into(), "자격 없음 — aws login 필요".into());
    }
    if re(r"(?i)exp[iİı]red|Exp[iİı]redToken|RequestExp[iİı]red|refresh fa[iİı]led|Token has exp[iİı]red")
        .is_match(stderr)
    {
        return ("expired".into(), "만료됨 — aws login 필요".into());
    }
    (
        "error".into(),
        mask(if py::trim(stderr).is_empty() {
            "확인 실패"
        } else {
            py::split_lines(stderr).last().copied().unwrap_or("")
        }),
    )
}
pub fn aws_profile(runner: &Runner<'_>, profile: &str, timeout: f64, now: f64) -> Result<Value> {
    let mut i = json!({"kind":"aws","name":profile,"state":"error","region":null,"account":null,"expires":null,"reason":null});
    let (code, out, _) = runner(
        "aws",
        &strings(&["configure", "get", "region", "--profile", profile]),
        timeout,
    )?;
    let region = py::trim(&out);
    if code == 0 && re(r"^[a-z]{2}(-[a-z]+)+-\d$").is_match(region) {
        i["region"] = json!(region)
    }
    let (code, out, stderr) = runner(
        "aws",
        &strings(&[
            "sts",
            "get-caller-identity",
            "--profile",
            profile,
            "--output",
            "json",
            "--cli-connect-timeout",
            "5",
            "--cli-read-timeout",
            &(timeout as i64).to_string(),
        ]),
        timeout + 5.,
    )?;
    if code != 0 {
        let (state, reason) = aws_failure(&stderr);
        i["state"] = json!(state);
        i["reason"] = json!(reason);
        return Ok(i);
    }
    if let Ok(v) = serde_json::from_str::<Value>(&out) {
        if v["Account"]
            .as_str()
            .is_some_and(|s| re(r"^\d{12}$").is_match(s))
        {
            i["account"] = json!(s(&v["Account"]).chars().skip(8).collect::<String>());
        }
    }
    i["state"] = json!("ok");
    let (code, out, _) = runner(
        "aws",
        &strings(&[
            "configure",
            "export-credentials",
            "--profile",
            profile,
            "--format",
            "process",
        ]),
        timeout,
    )?;
    if code == 0 {
        if let Ok(v) = serde_json::from_str::<Value>(&out) {
            if v["Expiration"]
                .as_str()
                .is_some_and(|s| re(r"^[\dT:.+Z-]{10,40}$").is_match(s))
            {
                i["expires"] = v["Expiration"].clone();
                let t = s(&v["Expiration"]);
                let timestamp = chrono::DateTime::parse_from_rfc3339(t)
                    .map(|d| d.timestamp() as f64)
                    .or_else(|_| {
                        chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S")
                            .map(|t| t.and_utc().timestamp() as f64)
                    });
                if timestamp.is_ok_and(|t| t <= now) {
                    i["state"] = json!("expired");
                    i["reason"] = json!("만료됨 — aws login 필요");
                }
            }
        }
    }
    Ok(i)
}
fn check_aws(runner: &Runner<'_>, config: &Value, timeout: f64, now: f64) -> Result<Value> {
    let names = if config["profiles"].is_null() {
        let (code, out, e) = runner("aws", &strings(&["configure", "list-profiles"]), timeout)?;
        if code != 0 {
            return Ok(
                json!([{"kind":"aws","name":"AWS","state":"error","reason":if mask(&e).is_empty(){"프로필 목록을 읽을 수 없음".into()}else{mask(&e)}}]),
            );
        }
        py::split_whitespace(&out)
            .into_iter()
            .filter(|n| re(NAME).is_match(n))
            .take(6)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    } else {
        arr(&config["profiles"])
            .iter()
            .map(|v| s(v).into())
            .collect()
    };
    if names.is_empty() {
        return Ok(json!([{"kind":"aws","name":"AWS","state":"none","reason":"프로필 없음"}]));
    }
    let mut all = vec![];
    for chunk in names.chunks(4) {
        let replies = std::thread::scope(|scope| {
            chunk
                .iter()
                .map(|name| {
                    scope.spawn(move || {
                        aws_profile(runner, name, timeout, now).map_err(|e| e.to_string())
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().unwrap_or_else(|_| Err("AWS worker failed".into())))
                .collect::<Vec<_>>()
        });
        for r in replies {
            all.push(r.map_err(std::io::Error::other)?);
        }
    }
    Ok(json!(all))
}
pub fn github(runner: &Runner<'_>, timeout: f64) -> Result<Value> {
    let (code, out, e) = runner(
        "gh",
        &strings(&["auth", "status", "--json", "hosts"]),
        timeout,
    )?;
    let v = serde_json::from_str::<Value>(&out).unwrap_or(Value::Null);
    let Some(hosts) = v["hosts"].as_object() else {
        let state = if code != 0 { "none" } else { "error" };
        return Ok(
            json!({"kind":"github","name":"GitHub","state":state,"reason":if state=="none"{"로그인 필요 — gh auth login".into()}else{let t=mask(&e);if t.is_empty(){"상태를 읽을 수 없음".into()}else{t}}}),
        );
    };
    let mut rows = vec![];
    for (host, accounts) in hosts {
        if !re(r"^[\w.-]{1,100}$").is_match(host) || !accounts.is_array() {
            continue;
        }
        let accounts = arr(accounts);
        let signed = accounts
            .iter()
            .filter(|a| a.is_object() && a["state"] == "success")
            .count();
        rows.push(json!({"host":host,"accounts":signed,"failed":accounts.len()-signed}));
    }
    let signed: u64 = rows
        .iter()
        .map(|r| r["accounts"].as_u64().unwrap_or(0))
        .sum();
    let failed: u64 = rows.iter().map(|r| r["failed"].as_u64().unwrap_or(0)).sum();
    Ok(
        json!({"kind":"github","name":"GitHub","state":if signed>0{"ok"}else{"none"},"hosts":rows,"reason":if signed==0{json!("로그인 필요 — gh auth login")}else if failed>0{json!("일부 계정 인증 실패 — gh auth status")}else{Value::Null}}),
    )
}
pub fn short_context(name: &str) -> String {
    let r = re(r"^arn:aws[\w-]*:eks:[\w-]+:\d+:cluster/(.+)$");
    take(
        &mask(
            r.captures(name)
                .as_ref()
                .map(|m| m.get(1).unwrap().as_str())
                .unwrap_or(name),
        ),
        60,
    )
}
fn kubectl(runner: &Runner<'_>, timeout: f64) -> Result<Value> {
    let (code, out, _) = runner("kubectl", &strings(&["config", "current-context"]), timeout)?;
    if code != 0 || py::trim(&out).is_empty() {
        Ok(
            json!({"kind":"kubectl","name":"kubectl","state":"none","context":null,"reason":"현재 컨텍스트 없음"}),
        )
    } else {
        Ok(
            json!({"kind":"kubectl","name":"kubectl","state":"ok","context":short_context(py::trim(&out)),"reason":null}),
        )
    }
}
fn docker(runner: &Runner<'_>, timeout: f64) -> Result<Value> {
    let (code, out, _) = runner(
        "docker",
        &strings(&["version", "--format", "{{.Server.Version}}"]),
        timeout,
    )?;
    if code == 0 && re(r"^[\w.+-]{1,40}$").is_match(py::trim(&out)) {
        Ok(
            json!({"kind":"docker","name":"Docker","state":"ok","version":py::trim(&out),"reason":null}),
        )
    } else {
        Ok(
            json!({"kind":"docker","name":"Docker","state":"none","version":null,"reason":"데몬 꺼짐"}),
        )
    }
}
pub fn org_type(v: &Value) -> &str {
    if truth(&v["isScratch"]) {
        "scratch"
    } else if truth(&v["isSandbox"]) {
        "sandbox"
    } else {
        "prod"
    }
}
pub fn domain_label(t: &str) -> Value {
    re(r"^https://([A-Za-z0-9-]{1,63})(\.[A-Za-z0-9.-]+)?/?$")
        .captures(t)
        .map(|m| json!(take(&m[1], 40)))
        .unwrap_or(Value::Null)
}
pub fn org_state(org: &Value) -> (String, Value) {
    if org["isExpired"] == true
        || ["expired", "deleted"].contains(&s(&org["status"]).to_lowercase().as_str())
    {
        return ("expired".into(), json!("만료된 org"));
    }
    let connected = s(&org["connectedStatus"]);
    if connected == "Connected" {
        return ("ok".into(), Value::Null);
    }
    if re(r"(?i)auth|exp[iİı]red|refresh|[iİı]nval[iİı]d_grant|sess[iİı]on|token")
        .is_match(connected)
    {
        return (
            "expired".into(),
            json!("로그인 만료 — sf org login web 필요"),
        );
    }
    if connected.is_empty() {
        return ("error".into(), json!("연결 상태를 알 수 없음"));
    }
    (
        "error".into(),
        json!(if mask(connected).is_empty() {
            "연결 확인 실패".into()
        } else {
            mask(connected)
        }),
    )
}
pub fn salesforce(runner: &Runner<'_>, config: &Value, timeout: f64, now: f64) -> Result<Value> {
    let (_, out, e) = runner("sf", &strings(&["org", "list", "--json"]), timeout)?;
    let data = serde_json::from_str::<Value>(&out).unwrap_or(Value::Null);
    let result = &data["result"];
    if !result.is_object() && !result.is_array() && !re(r"(?i)NoResults|No orgs").is_match(&e) {
        return Ok(
            json!([{"kind":"salesforce","name":"Salesforce","state":"error","reason":if mask(&e).is_empty(){"목록을 읽을 수 없음".into()}else{mask(&e)}}]),
        );
    }
    let mut items = vec![];
    let mut seen = BTreeSet::new();
    for group in [
        "nonScratchOrgs",
        "sandboxes",
        "scratchOrgs",
        "devHubs",
        "other",
    ] {
        for org in arr(&result[group]) {
            if !org.is_object() {
                continue;
            }
            let identity = if truth(&org["orgId"]) {
                org["orgId"].clone()
            } else {
                org["username"].clone()
            };
            if !seen.insert(identity.to_string()) {
                continue;
            }
            let alias = org["alias"].as_str().filter(|s| re(ALIAS).is_match(s));
            let id = org["orgId"]
                .as_str()
                .filter(|s| re(r"^[A-Za-z0-9]{15,18}$").is_match(s));
            let (state, reason) = org_state(&org);
            items.push(json!({"kind":"salesforce","name":alias.map(str::to_owned).unwrap_or_else(||id.map(|id|format!("org …{}",&id[id.len()-4..])).unwrap_or("org".into())),"alias":alias,"state":state,"reason":reason,"type":org_type(&org),"domain":domain_label(s(&org["instanceUrl"])),"org":id.map(|id|&id[id.len()-4..]),"default":org["isDefaultUsername"]==true,"devhub":org["isDefaultDevHubUsername"]==true,"checked":now as i64}));
        }
    }
    if let Some(wanted) = config["orgs"].as_array() {
        let by_alias: BTreeMap<String, Value> = items
            .iter()
            .filter(|i| truth(&i["alias"]))
            .map(|i| (s(&i["alias"]).into(), i.clone()))
            .collect();
        items=wanted.iter().map(|alias|by_alias.get(s(alias)).cloned().unwrap_or(json!({"kind":"salesforce","name":alias,"alias":alias,"state":"none","reason":"로그인 기록 없음 — sf org login web 필요","type":null,"domain":null,"org":null,"default":false,"devhub":false,"checked":now as i64}))).collect();
    } else {
        items.sort_by_key(|i| (!truth(&i["default"]), s(&i["name"]).to_string()));
        items.truncate(6);
    }
    if items.is_empty() {
        items.push(json!({"kind":"salesforce","name":"Salesforce","state":"none","reason":"로그인한 org 없음 — sf org login web"}));
    }
    Ok(json!(items))
}
fn cli_collect(c: &Value, timeout: f64, runner: &Runner<'_>, at: f64) -> Value {
    let mut kinds = vec![];
    for kind in ["aws", "github", "kubectl", "docker", "salesforce"] {
        if truth(&c[kind]) {
            kinds.push(kind)
        }
    }
    let replies = std::thread::scope(|scope| {
        kinds
            .iter()
            .map(|kind| {
                let kind = *kind;
                scope.spawn(move || {
                    let result = match kind {
                        "aws" => check_aws(runner, &c[kind], timeout, at),
                        "github" => github(runner, timeout),
                        "kubectl" => kubectl(runner, timeout),
                        "docker" => docker(runner, timeout),
                        _ => salesforce(runner, &c[kind], timeout, at),
                    };
                    (kind, result.map_err(|e| e.to_string()))
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap_or(("unknown", Err("worker failed".into()))))
            .collect::<Vec<_>>()
    });
    let (mut items, mut errors) = (vec![], json!({}));
    for (kind, result) in replies {
        match result {
            Ok(v) => {
                if v.is_array() {
                    items.extend(arr(&v))
                } else {
                    items.push(v)
                }
            }
            Err(e) if e.starts_with("MISSING:") => {}
            Err(e) => errors[kind] = json!(mask(&e)),
        }
    }
    json!({"updated":at as i64,"items":items,"errors":errors})
}
