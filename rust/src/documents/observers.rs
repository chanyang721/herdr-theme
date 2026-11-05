use super::{common::*, install};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Clone, Copy)]
pub struct Spec {
    pub job: &'static str,
    pub config: &'static str,
    pub example: &'static str,
    pub state: &'static str,
    pub command: &'static str,
    pub pins: bool,
}
pub const CLEANUP: Spec = Spec {
    job: "close-finished-spaces",
    config: "close-finished-spaces.json",
    example: "config/close-finished-spaces.example.json",
    state: "close-finished-spaces-state.json",
    command: "close_finished_spaces",
    pins: true,
};
pub const SLEEP: Spec = Spec {
    job: "sleep-idle-sessions",
    config: "sleep-idle-sessions.json",
    example: "config/sleep-idle-sessions.example.json",
    state: "sleep-idle-sessions-state.json",
    command: "sleep_idle_sessions",
    pins: false,
};
pub fn write_changed(path: &Path, content: &[u8]) -> Result<bool> {
    if fs::read(path).ok().as_deref() == Some(content) {
        return Ok(false);
    }
    if path.exists() {
        copy_file(
            path,
            path.with_file_name(format!(
                "{}.before-{}",
                filename(path),
                chrono::Local::now().format("%Y%m%d%H%M%S")
            )),
        )?
    }
    atomic_bytes(path, content)?;
    chmod(path, 0o600)?;
    Ok(true)
}
fn base(home: &Path, site: &Value) -> PathBuf {
    expand_home(s(&site["state_dir"]), home)
}
fn label(site: &Value, spec: Spec) -> String {
    format!("{}.{}", s(&site["label_prefix"]), spec.job)
}
pub fn detect_harness(home: &Path) -> Option<Value> {
    let data =
        read_json(home.join(".config/herdr-app/data/sixfold/harness-local/config.json")).ok()?;
    if let Some(argv) = data["command"].as_array().filter(|argv| {
        !argv.is_empty()
            && argv
                .iter()
                .all(|arg| arg.as_str().is_some_and(|s| !s.is_empty()))
    }) {
        return Some(json!({"command":argv}));
    }
    let repo = Path::new(s(&data["repo_path"]));
    let script = repo.join("runtime/harness.py");
    if !script.is_file() {
        return None;
    }
    let venv = home.join(".local/share/herdr-harness/venv/bin/python");
    Some(
        json!({"python":if venv.exists(){venv.to_string_lossy().into_owned()}else{data["python"].as_str().unwrap_or(if cfg!(windows){"py"}else{"python3"}).to_owned()},"script":script}),
    )
}
pub fn source_commit(source: &Path) -> (Option<String>, Option<String>) {
    let get = |args: &[&str]| -> Result<String> {
        Ok(String::from_utf8_lossy(
            &checked(command("git").arg("-C").arg(source).args(args))?.stdout,
        )
        .trim()
        .to_owned())
    };
    let Ok(commit) = get(&["rev-parse", "HEAD"]) else {
        return (None, Some("source is not a git checkout".into()));
    };
    let Ok(dirty) = get(&["status", "--porcelain", "--", "scripts", "rust", "config"]) else {
        return (None, Some("source is not a git checkout".into()));
    };
    if !dirty.is_empty() {
        (None, Some("source scripts have uncommitted changes".into()))
    } else {
        (Some(commit), None)
    }
}
pub fn review_findings(text: &str) -> Vec<String> {
    Regex::new(r"(?m)^\s*-\s*\*\*(P\d)\s*[—-]\s*([^*]+?)\s*:?\*\*")
        .unwrap()
        .captures_iter(text)
        .map(|c| c[2].trim().to_owned())
        .collect()
}
pub fn review_approval(home: &Path, source: &Path, commit: Option<&str>) -> Value {
    let commit = if let Some(commit) = commit {
        commit.to_owned()
    } else {
        let (commit, why) = source_commit(source);
        let Some(commit) = commit else {
            return json!({"ok":false,"why":why});
        };
        commit
    };
    let local = home.join(".config/herdr-app/data/sixfold/harness-local");
    let local_config = read_json(local.join("config.json")).ok();
    let mut records = vec![];
    if let Some(config) = &local_config {
        let repo = PathBuf::from(s(&config["repo_path"]));
        for entry in walkdir::WalkDir::new(repo.join("records"))
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if suffix(entry.path()) == ".json" {
                if let Ok(record) = read_json(entry.path()) {
                    records.push(record);
                }
            }
        }
    }
    review_policy(&commit, &local, local_config.as_ref(), &records, |path| {
        fs::read_to_string(path).ok()
    })
}
fn review_policy(
    commit: &str,
    local: &Path,
    local_config: Option<&Value>,
    records: &[Value],
    read_review: impl Fn(&Path) -> Option<String>,
) -> Value {
    let short = &commit[..commit.len().min(7)];
    if local_config.is_none() {
        return json!({"ok":false,"why":"harness not configured","commit":commit});
    }
    let mut reports = HashSet::new();
    let mut verdicts = vec![];
    for record in records {
        if record["type"] == "report" && record["summary"].to_string().contains(short) {
            reports.insert(record["report_id"].clone().to_string());
        } else if record["type"] == "verdict" {
            verdicts.push(record.clone())
        }
    }
    verdicts.retain(|v| reports.contains(&v["target_report_id"].to_string()));
    verdicts.sort_by_key(|v| s(&v["id"]).to_owned());
    let Some(verdict) = verdicts.last() else {
        return json!({"ok":false,"why":format!("no harness review verdict for commit {short}"),"commit":commit});
    };
    let path = Regex::new(r"harness-local/reviews/(\S+?\.md)")
        .unwrap()
        .captures(s(&verdict["note"]))
        .map(|c| {
            local
                .join("reviews")
                .join(&c[1])
                .components()
                .collect::<PathBuf>()
        });
    let mut evidence = json!({"commit":commit,"verdict_id":verdict["id"],"value":verdict["value"],"review_file":path,"report_id":verdict["target_report_id"]});
    let Some(text) = path.as_ref().and_then(|p| read_review(p)) else {
        evidence["ok"] = json!(false);
        evidence["why"] = json!("review file missing");
        return evidence;
    };
    if !text.contains(short) {
        evidence["ok"] = json!(false);
        evidence["why"] = json!(format!("review file does not name commit {short}"));
        return evidence;
    }
    let (ok, why) = match s(&verdict["value"]) {
        "PASS" => (true, "PASS".to_owned()),
        "CONDITIONAL" => {
            let findings = review_findings(&text);
            let pattern = Regex::new("(?i)설치|실동작|실제 동작|실제 앱|install|live").unwrap();
            let okay = !findings.is_empty() && findings.iter().all(|f| pattern.is_match(f));
            evidence["findings"] = json!(findings);
            (
                okay,
                if okay {
                    "CONDITIONAL: only install/live checks remain"
                } else {
                    "CONDITIONAL with other findings"
                }
                .into(),
            )
        }
        other => (false, format!("verdict {other}")),
    };
    evidence["ok"] = json!(ok);
    evidence["why"] = json!(why);
    evidence
}
/// A deterministic transport snapshot for exact policy-oracle tests. The same
/// policy implementation is used by the filesystem-backed public helper.
pub fn review_approval_snapshot(
    home: &Path,
    commit: &str,
    local_config: Option<&Value>,
    records: &[Value],
    reviews: &Value,
) -> Value {
    let local = home.join(".config/herdr-app/data/sixfold/harness-local");
    review_policy(commit, &local, local_config, records, |path| {
        let relative = path
            .strip_prefix(local.join("reviews"))
            .ok()?
            .to_string_lossy()
            .replace('\\', "/");
        reviews.get(&relative)?.as_str().map(str::to_owned)
    })
}
pub fn install_observer(
    home: &Path,
    source: &Path,
    spec: Spec,
    apply: bool,
    user_approved: bool,
    execute: bool,
) -> Result<Value> {
    let site = site_config(Some(home), None);
    let base = base(home, &site);
    let label = label(&site, spec);
    let config_path = base.join(spec.config);
    let binary = std::env::current_exe()?;
    let bytes = fs::read(&binary)?;
    let code_hash = hash(&bytes);
    let mut config = if config_path.exists() {
        read_json(&config_path)?
    } else {
        read_json(source.join(spec.example))?
    };
    if !config_path.exists() && spec.pins {
        let pins = home.join(".config/herdr-app/data/sixfold/workspace-pins.local.json");
        if pins.exists() {
            config["fixed_spaces"] = read_json(pins)?["spaces"].clone()
        }
    }
    if config["harness"].is_null() {
        if let Some(harness) = detect_harness(home) {
            config["harness"] = harness
        }
    }
    if apply {
        let state = read_json(base.join(spec.state))?;
        let trial = &state["trial"];
        let current = state["observer_sha256"] == code_hash
            && trial["error_count"].as_i64().unwrap_or(0) == 0
            && now() - state["last_at"].as_f64().unwrap_or(0.) <= 660.;
        if user_approved {
            if !current || trial["samples"].as_i64().unwrap_or(0) < 1 {
                return Err(
                    "one recorded dry-run of the current code is required before apply".into(),
                );
            }
            config["user_approved_apply"] = json!(true)
        } else if !current
            || trial["samples"].as_i64().unwrap_or(0) < 7
            || now() - trial["started_at"].as_f64().unwrap_or_else(now) < 1800.
        {
            return Err(
                "30-minute live dry-run with current code and 7 healthy samples is required".into(),
            );
        }
        config["reviewed_dry_run_at"] = json!(now());
        config["reviewed_observer_sha256"] = json!(code_hash)
    }
    let destination = base.join(install::native_name());
    let mode = if apply { "--apply" } else { "--dry-run" };
    let plist_path = home
        .join("Library/LaunchAgents")
        .join(format!("{label}.plist"));
    let plist = json!({"Label":label,"ProgramArguments":[destination,spec.command,"--config",config_path,mode],"StartInterval":300,"RunAtLoad":true,"ProcessType":"Background","WorkingDirectory":base,"EnvironmentVariables":{"HOME":home,"PATH":format!("{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",home.display())},"StandardOutPath":base.join(format!("{}.stdout.log",spec.job)),"StandardErrorPath":base.join(format!("{}.stderr.log",spec.job))});
    let mut result = json!({"label":label,"mode":mode,"script":destination,"plist":plist_path,"execute":execute,"observer_sha256":code_hash,"harness":!config["harness"].is_null()});
    if !execute {
        return Ok(result);
    }
    write_changed(&destination, &bytes)?;
    chmod(&destination, 0o755)?;
    let mut encoded = serde_json::to_vec_pretty(&config)?;
    encoded.push(b'\n');
    write_changed(&config_path, &encoded)?;
    let mut plist_bytes = vec![];
    let plist_value: plist::Value = serde_json::from_value(plist)?;
    plist_value.to_writer_xml(&mut plist_bytes)?;
    let changed = write_changed(&plist_path, &plist_bytes)?;
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0;
    let service = format!("gui/{uid}/{label}");
    let loaded = command("launchctl")
        .args(["print", &service])
        .output()?
        .status
        .success();
    if loaded && changed {
        checked(command("launchctl").args(["bootout", &service]))?;
    }
    if !loaded || changed {
        checked(
            command("launchctl")
                .args(["bootstrap", &format!("gui/{uid}")])
                .arg(&plist_path),
        )?;
        checked(command("launchctl").args(["kickstart", &service]))?;
    }
    result["loaded"] = json!(command("launchctl")
        .args(["print", &service])
        .output()?
        .status
        .success());
    Ok(result)
}
pub fn refresh(home: &Path, source: &Path) -> Result<Value> {
    let site = site_config(Some(home), None);
    let base = base(home, &site);
    let binary = base.join(install::native_name());
    let mut registered = vec![];
    let mut reinstall = vec![];
    for spec in [CLEANUP, SLEEP] {
        let path = home
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", label(&site, spec)));
        if !path.exists() {
            continue;
        }
        let plist = plist::Value::from_file(&path).ok();
        let dictionary = plist.as_ref().and_then(plist::Value::as_dictionary);
        let argv = dictionary
            .and_then(|d| d.get("ProgramArguments"))
            .and_then(plist::Value::as_array);
        let program = argv
            .and_then(|a| a.first())
            .and_then(plist::Value::as_string)
            .map(PathBuf::from);
        let program = program.and_then(|p| {
            if p.is_absolute() {
                Some(p)
            } else {
                dictionary
                    .and_then(|d| d.get("WorkingDirectory"))
                    .and_then(plist::Value::as_string)
                    .map(|cwd| Path::new(cwd).join(p))
            }
        });
        let command = argv
            .and_then(|a| a.get(1))
            .and_then(plist::Value::as_string)
            .map(|s| s.replace('-', "_"));
        if binary.is_file()
            && program.is_some_and(|p| resolved(p) == resolved(&binary))
            && command.as_deref() == Some(spec.command)
        {
            registered.push(spec)
        } else {
            reinstall.push(json!({"job":spec.job,"plist":path,"reason":"LaunchAgent does not invoke the managed native observer; run --install to migrate it"}));
        }
    }
    if registered.is_empty() {
        let mut result = json!({"refreshed":[],"why":"no registered native observer copy (first install or Python migration goes through --install)"});
        if !reinstall.is_empty() {
            result["reinstallRequired"] = json!(reinstall);
        }
        return Ok(result);
    }
    let mut locks = vec![];
    for spec in &registered {
        let path = base.join(spec.state).with_extension("lock");
        let mut locked = None;
        for _ in 0..120 {
            match lock(&path, true) {
                Ok(file) => {
                    locked = Some(file);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_secs(1)),
            }
        }
        locks.push(locked.ok_or_else(|| {
            format!(
                "{} is still running after 2 minutes; nothing replaced",
                spec.job
            )
        })?)
    }
    let before = fs::read(&binary).ok().map(hash);
    let bytes = fs::read(std::env::current_exe()?)?;
    let after = hash(&bytes);
    let changed = write_changed(&binary, &bytes)?;
    chmod(&binary, 0o755)?;
    let mut result = json!({"refreshed":registered.iter().map(|s|s.job).collect::<Vec<_>>(),"changed":if changed{vec![install::native_name()]}else{vec![]},"observers":{}});
    if !reinstall.is_empty() {
        result["reinstallRequired"] = json!(reinstall);
    }
    let mut approval = None;
    for spec in registered {
        let config_path = base.join(spec.config);
        let mut config = json_or(&config_path, json!({}));
        let carried = config["user_approved_apply"] == true
            && before.is_some()
            && config["reviewed_observer_sha256"].as_str() == before.as_deref()
            && before.as_deref() != Some(&after);
        let mut policy = Value::Null;
        if carried {
            config["reviewed_observer_sha256"] = json!(after);
            atomic_json(&config_path, &config)?;
        } else if config.as_object().is_some_and(|c| !c.is_empty())
            && config["reviewed_observer_sha256"] != after
        {
            let approval = approval.get_or_insert_with(|| review_approval(home, source, None));
            policy = approval.clone();
            if approval["ok"] == true {
                config["reviewed_observer_sha256"] = json!(after);
                let mut reviewed = json!({"actor":"auto-policy","at":chrono::Local::now().to_rfc3339(),"observer_sha256":after});
                for key in ["commit", "verdict_id", "value", "review_file", "report_id"] {
                    reviewed[key] = approval[key].clone()
                }
                config["reviewed_by_policy"] = reviewed;
                atomic_json(&config_path, &config)?;
            }
        }
        result["observers"][spec.job] = json!({"observer_sha256":after,"approval_carried":carried,"approval_policy":policy,"approved_for_this_copy":config["reviewed_observer_sha256"]==after})
    }
    drop(locks);
    Ok(result)
}
pub fn cli(args: &[String], sleep: bool) -> Result<()> {
    if has(args, "--user-approved") && !has(args, "--enable-apply") {
        return Err("--user-approved only goes with --enable-apply".into());
    }
    let home = option(args, "--home").map(expand).unwrap_or_else(user_home);
    let source = option(args, "--source")
        .map(expand)
        .unwrap_or_else(repo_default);
    let result = if has(args, "--refresh") {
        refresh(&home, &source)?
    } else {
        install_observer(
            &home,
            &source,
            if sleep { SLEEP } else { CLEANUP },
            has(args, "--enable-apply"),
            has(args, "--user-approved"),
            has(args, "--install"),
        )?
    };
    println!("{result}");
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_native_harness_command_does_not_require_python_checkout() {
        let home = tempfile::tempdir().unwrap();
        let path = home
            .path()
            .join(".config/herdr-app/data/sixfold/harness-local/config.json");
        atomic_json(
            &path,
            &json!({"command":["native-harness","--local"],"repo_path":"missing-checkout"}),
        )
        .unwrap();
        assert_eq!(
            detect_harness(home.path()),
            Some(json!({"command":["native-harness","--local"]}))
        );
        atomic_json(&path, &json!({"command":[],"repo_path":"missing-checkout"})).unwrap();
        assert!(detect_harness(home.path()).is_none());
        let repo = home.path().join("legacy");
        atomic_bytes(
            repo.join("runtime/harness.py"),
            b"# external legacy harness\n",
        )
        .unwrap();
        atomic_json(&path, &json!({"repo_path":repo,"python":"external-python"})).unwrap();
        let legacy = detect_harness(home.path()).unwrap();
        assert_eq!(legacy["python"], "external-python");
        assert_eq!(legacy["script"], json!(repo.join("runtime/harness.py")));
    }
    #[test]
    fn review_titles_parse_only_findings() {
        assert_eq!(
            review_findings("- **P2 — install check:**\nother\n- **P1 - data loss**"),
            vec!["install check", "data loss"]
        );
    }
    #[test]
    fn changed_files_get_backup_and_private_mode() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("config.json");
        assert!(write_changed(&path, b"a").unwrap());
        assert!(!write_changed(&path, b"a").unwrap());
        assert!(write_changed(&path, b"b").unwrap());
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 2);
    }
}
