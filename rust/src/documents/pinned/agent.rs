use super::sessions::{family, find_executable, Resolver};
use crate::documents::common::*;
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
const FIELDS: &[&str] = &["input", "output", "cacheRead", "cacheWrite"];
const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub fn token_count(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|n| *n <= MAX_SAFE)
        .ok_or_else(|| "invalid_store".into())
}
pub fn weighted(row: &Value, kind: &str) -> f64 {
    let output_weight = if kind == "claude" { 5u128 } else { 8u128 };
    // Python keeps the first input/output terms integral until cacheRead's
    // fractional weight enters the sum; retain that conversion point.
    let initial =
        if let (Some(input), Some(output)) = (row["input"].as_u64(), row["output"].as_u64()) {
            (input as u128 + output as u128 * output_weight) as f64
        } else {
            row["input"].as_f64().unwrap_or(0.)
                + row["output"].as_f64().unwrap_or(0.) * output_weight as f64
        };
    initial
        + row["cacheRead"].as_f64().unwrap_or(0.) * 0.1
        + row["cacheWrite"].as_f64().unwrap_or(0.) * if kind == "claude" { 1.25 } else { 1. }
}
pub fn week_start(today: chrono::NaiveDate) -> String {
    (today - chrono::Duration::days(6)).to_string()
}
pub fn aggregate(store: &Value, since: &Value) -> Result<BTreeMap<(String, String), Value>> {
    if store["version"] != 1 || !store["files"].is_object() {
        return Err("invalid_store".into());
    }
    let fallback = week_start(chrono::Local::now().date_naive());
    let mut totals: BTreeMap<(String, String), Value> = BTreeMap::new();
    for file in store["files"].as_object().unwrap().values() {
        let rows = file["rows"].as_array().ok_or("invalid_store")?;
        for row in rows {
            if !row.is_object() {
                return Err("invalid_store".into());
            }
            let kind = s(&row["harness"]);
            if !["claude", "codex"].contains(&kind) {
                continue;
            }
            let prefix = format!("{kind}:");
            let session = row["session"]
                .as_str()
                .and_then(|s| s.strip_prefix(&prefix))
                .ok_or("invalid_store")?;
            let record=totals.entry((kind.into(),session.into())).or_insert_with(||json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"models":[],"week":0.0}));
            for field in FIELDS {
                let amount = token_count(&record[*field])?
                    .checked_add(token_count(&row[*field])?)
                    .filter(|n| *n <= MAX_SAFE)
                    .ok_or("invalid_store")?;
                record[*field] = json!(amount)
            }
            let start = if since.is_object() {
                since[kind].as_str()
            } else {
                since.as_str()
            }
            .filter(|s| !s.is_empty())
            .unwrap_or(&fallback);
            if row["day"].as_str().is_some_and(|d| d >= start) {
                record["week"] = json!(record["week"].as_f64().unwrap_or(0.) + weighted(row, kind))
            }
            if let Some(model) = row["model"]
                .as_str()
                .filter(|m| !m.is_empty() && m.chars().count() <= 128)
            {
                let models = record["models"].as_array_mut().unwrap();
                if !models.contains(&json!(model)) {
                    models.push(json!(model))
                }
            }
        }
    }
    for record in totals.values_mut() {
        let total = FIELDS
            .iter()
            .map(|f| record[*f].as_u64().unwrap())
            .sum::<u64>();
        if total > MAX_SAFE {
            return Err("invalid_store".into());
        }
        record["total"] = json!(total);
        record["models"]
            .as_array_mut()
            .unwrap()
            .sort_by(|a, b| s(a).cmp(s(b)));
    }
    Ok(totals)
}
pub fn unknown(terminal: &Value, reason: &str) -> Value {
    let mut entry = json!({"terminal":terminal["address"],"agent":family(s(&terminal["agent"])),"known":false,"input":null,"output":null,"cacheRead":null,"cacheWrite":null,"total":null,"models":[],"reason":reason});
    if terminal["sleepSession"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        entry["sleeping"] = json!(true)
    }
    entry
}
pub fn collect(store_path: &Path, resolver: &mut Resolver, since: &Value, meta: bool) -> Value {
    let mut result = json!({"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"storeUpdatedAt":null,"agents":[]});
    let live = match resolver.live_agents() {
        Ok(v) => v,
        Err(_) => {
            result["error"] = json!("live_agents_unavailable");
            return result;
        }
    };
    let mut week_totals: BTreeMap<String, f64> = BTreeMap::new();
    let mut totals = BTreeMap::new();
    match read_json(store_path).and_then(|store| {
        let aggregated = aggregate(&store, since)?;
        Ok((store, aggregated))
    }) {
        Ok((store, aggregated)) => {
            totals = aggregated;
            for ((kind, _), record) in &totals {
                *week_totals.entry(kind.clone()).or_default() +=
                    record["week"].as_f64().unwrap_or(0.)
            }
            if let Some(time) = store["lastScanAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            {
                result["storeUpdatedAt"] =
                    json!(time.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true))
            }
        }
        Err(_) => {
            result["error"] = json!(if store_path.exists() {
                "store_unavailable"
            } else {
                "store_missing"
            })
        }
    }
    let mut seen = HashSet::new();
    for terminal in live {
        let address = s(&terminal["address"]);
        if !seen.insert(address.to_owned()) {
            continue;
        }
        let session = match resolver.identify(&terminal) {
            Ok(s) => s,
            Err(error) => {
                let reason = result["error"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| error.to_string());
                result["agents"]
                    .as_array_mut()
                    .unwrap()
                    .push(unknown(&terminal, &reason));
                continue;
            }
        };
        if let Some(error) = result["error"].as_str() {
            let entry = unknown(&terminal, error);
            result["agents"].as_array_mut().unwrap().push(entry);
            continue;
        }
        let Some(session) = session else {
            result["agents"]
                .as_array_mut()
                .unwrap()
                .push(unknown(&terminal, "session_unconfirmed"));
            continue;
        };
        let kind = family(s(&terminal["agent"]));
        let settings = if meta {
            session_meta(kind, &session, None, None)
        } else {
            None
        };
        let Some(record) = totals.get(&(kind.into(), session)) else {
            let mut entry = unknown(&terminal, "session_not_indexed");
            if let Some(settings) = settings {
                entry["meta"] = settings
            }
            result["agents"].as_array_mut().unwrap().push(entry);
            continue;
        };
        let total = week_totals.get(kind).copied().unwrap_or(0.);
        let share = if total > 0. {
            format!(
                "{:.1}",
                100. * record["week"].as_f64().unwrap_or(0.) / total
            )
            .parse::<f64>()
            .ok()
        } else {
            None
        };
        let mut entry = json!({"terminal":address,"agent":kind,"known":true,"models":record["models"],"weekShare":share});
        for field in ["input", "output", "cacheRead", "cacheWrite", "total"] {
            entry[field] = record[field].clone()
        }
        if terminal["sleepSession"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            entry["sleeping"] = json!(true)
        }
        if let Some(settings) = settings {
            entry["meta"] = settings
        }
        result["agents"].as_array_mut().unwrap().push(entry)
    }
    result
}
pub fn model_name(model: &Value) -> Option<String> {
    let model = model
        .as_str()
        .filter(|s| !s.is_empty() && s.chars().count() <= 80)?;
    let text = Regex::new(r"-\d{8}$")
        .unwrap()
        .replace(model, "")
        .replace("[1m]", " 1M");
    if let Some(c) = Regex::new(r"^claude-([a-z]+)-(\d+)(?:-(\d+))?( 1M)?$")
        .unwrap()
        .captures(&text)
    {
        let mut chars = c[1].chars();
        let family = chars
            .next()
            .unwrap()
            .to_uppercase()
            .chain(chars)
            .collect::<String>();
        return Some(format!(
            "{family} {}{}{}",
            &c[2],
            c.get(3)
                .map(|m| format!(".{}", m.as_str()))
                .unwrap_or_default(),
            c.get(4).map(|m| m.as_str()).unwrap_or("")
        ));
    }
    if let Some(rest) = text.strip_prefix("gpt-") {
        let pieces = rest
            .split('-')
            .map(|part| {
                if part.chars().all(char::is_alphabetic) {
                    let mut c = part.chars();
                    c.next()
                        .map(|first| {
                            first
                                .to_uppercase()
                                .chain(c.flat_map(char::to_lowercase))
                                .collect()
                        })
                        .unwrap_or_default()
                } else {
                    part.to_owned()
                }
            })
            .collect::<Vec<_>>();
        return Some(format!("GPT-{}", pieces.join("-")));
    }
    Some(text)
}
pub fn choice(value: &Value, allowed: Option<&[&str]>) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty() && s.chars().count() <= 40 && allowed.map_or(true, |a| a.contains(s))
        })
        .map(str::to_owned)
}
pub fn permission_level(label: &str) -> &'static str {
    if ["YOLO", "bypassPermissions", "dontAsk"].contains(&label) {
        "full"
    } else if ["auto", "acceptEdits"].contains(&label) || label.starts_with("never") {
        "auto"
    } else {
        "ask"
    }
}
fn speed(tier: &str) -> Option<&'static str> {
    match tier {
        "standard" | "default" => Some("표준"),
        "fast" | "priority" => Some("빠름"),
        "flex" => Some("flex"),
        _ => None,
    }
}
fn tail_records(path: &Path, mut record: impl FnMut(Value) -> bool) -> Result<()> {
    let mut end = fs::metadata(path)?.len();
    let (mut span, mut read) = (512 * 1024u64, 0u64);
    const MAX: u64 = 32 * 1024 * 1024;
    while end > 0 && read < MAX {
        let start = end.saturating_sub(span);
        let mut stream = fs::File::open(path)?;
        stream.seek(SeekFrom::Start(start))?;
        let mut chunk = vec![0u8; (end - start) as usize];
        stream.read_exact(&mut chunk)?;
        read += chunk.len() as u64;
        if start > 0 {
            let Some(cut) = chunk.iter().position(|b| *b == b'\n') else {
                span *= 4;
                continue;
            };
            chunk = chunk[cut + 1..].to_vec();
            end = start + cut as u64 + 1
        } else {
            end = 0
        }
        for raw in chunk.split(|b| *b == b'\n').rev() {
            if let Ok(value) = serde_json::from_slice::<Value>(raw) {
                if value.is_object() && record(value) {
                    return Ok(());
                }
            }
        }
        span = MAX.min(span * 4)
    }
    Ok(())
}
pub fn claude_meta(path: &Path) -> Result<Value> {
    let mut found = json!({});
    tail_records(path, |record| {
        let kind = s(&record["type"]);
        if found.get("permission").is_none() && ["permission-mode", "user"].contains(&kind) {
            if let Some(mode) = choice(
                &record["permissionMode"],
                Some(&[
                    "auto",
                    "default",
                    "plan",
                    "acceptEdits",
                    "bypassPermissions",
                    "dontAsk",
                ]),
            ) {
                found["permission"] = json!(mode)
            }
        }
        if found.get("model").is_none() && kind == "assistant" && record["isSidechain"] != true {
            if let Some(model) =
                choice(&record["message"]["model"], None).filter(|m| m != "<synthetic>")
            {
                found["model"] = json!(model);
                found["speed"] = json!(speed(s(&record["message"]["usage"]["speed"])));
                found["effort"] = json!(choice(&record["effort"], None));
            }
        }
        found.get("model").is_some() && found.get("permission").is_some()
    })?;
    Ok(found)
}
pub fn sandbox_of(settings: &Value) -> Option<String> {
    if let Some(value) = choice(&settings["sandbox_policy"]["type"], None) {
        return Some(value);
    }
    if let Some(value) = choice(&settings["active_permission_profile"]["id"], None) {
        return Some(value.trim_start_matches(':').to_owned());
    }
    if settings["permission_profile"]["type"] == "disabled" {
        return Some("danger-full-access".into());
    }
    None
}
pub fn codex_meta(path: &Path) -> Result<Value> {
    let mut found = json!({});
    tail_records(path, |record| {
        let payload = &record["payload"];
        let settings = if record["type"] == "turn_context" {
            Some(payload)
        } else if payload["type"] == "thread_settings_applied"
            && payload["thread_settings"].is_object()
        {
            Some(&payload["thread_settings"])
        } else {
            None
        };
        if let Some(settings) = settings {
            for (key, value) in [
                ("model", choice(&settings["model"], None)),
                (
                    "effort",
                    choice(&settings["effort"], None)
                        .or_else(|| choice(&settings["reasoning_effort"], None)),
                ),
                ("approval", choice(&settings["approval_policy"], None)),
                ("tier", choice(&settings["service_tier"], None)),
            ] {
                if found.get(key).is_none() {
                    if let Some(value) = value {
                        found[key] = json!(value)
                    }
                }
            }
            if found.get("sandbox").is_none() {
                if let Some(value) = sandbox_of(settings) {
                    found["sandbox"] = json!(value)
                }
            }
        }
        ["model", "approval", "sandbox", "tier"]
            .iter()
            .all(|k| found.get(k).is_some())
    })?;
    if found["model"].is_null() {
        return Ok(json!({}));
    }
    let approval = s(&found["approval"]);
    let sandbox = s(&found["sandbox"]);
    let permission = if approval == "never" && sandbox == "danger-full-access" {
        Some("YOLO".into())
    } else {
        let parts = [
            approval.to_owned(),
            sandbox.replace("workspace-write", "workspace"),
        ]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
        if parts.is_empty() {
            None
        } else {
            Some(parts.join("·"))
        }
    };
    Ok(
        json!({"model":found["model"],"effort":found["effort"],"speed":speed(s(&found["tier"])),"permission":permission}),
    )
}
pub fn transcript(kind: &str, session: &str, claude: &Path, codex: &Path) -> Option<PathBuf> {
    if !Regex::new(r"^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$")
        .unwrap()
        .is_match(session)
    {
        return None;
    }
    let (root, depth) = if kind == "claude" {
        (claude.join("projects"), 2)
    } else {
        (codex.join("sessions"), 4)
    };
    let mut matches = walkdir::WalkDir::new(root)
        .min_depth(depth)
        .max_depth(depth)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let name = filename(e.path());
            let matching = if kind == "claude" {
                name == format!("{session}.jsonl")
            } else {
                name.starts_with("rollout-")
                    && name.ends_with(&format!("-{}.jsonl", session.to_lowercase()))
            };
            matching.then(|| e.path().to_owned())
        })
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        matches.pop()
    } else {
        None
    }
}
pub fn session_meta(
    kind: &str,
    session: &str,
    claude: Option<&Path>,
    codex: Option<&Path>,
) -> Option<Value> {
    let claude = claude.map(Path::to_owned).unwrap_or_else(|| {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| user_home().join(".claude"))
    });
    let codex = codex.map(Path::to_owned).unwrap_or_else(|| {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| user_home().join(".codex"))
    });
    let path = transcript(kind, session, &claude, &codex)?;
    let found = if kind == "claude" {
        claude_meta(&path)
    } else {
        codex_meta(&path)
    }
    .ok()?;
    if found["model"].is_null() {
        return None;
    }
    let permission = found["permission"].as_str();
    Some(
        json!({"agent":kind,"model":found["model"],"modelName":model_name(&found["model"]),"speed":found["speed"],"effort":found["effort"],"permission":permission,"level":permission.filter(|p|!p.is_empty()).map(permission_level)}),
    )
}
pub fn collect_cli(args: &[String]) -> Result<()> {
    let store = option(args, "--store")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_home().join("data/insights/insights.json"));
    let mut since = json!({});
    for (kind, flag) in [("claude", "--since-claude"), ("codex", "--since-codex")] {
        if let Some(day) = option(args, flag)
            .filter(|d| d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-')
        {
            since[kind] = json!(day)
        }
    }
    let mut resolver = Resolver::new(option(args, "--hc").as_deref());
    println!(
        "{}",
        collect(&store, &mut resolver, &since, has(args, "--meta"))
    );
    Ok(())
}
pub fn version(path: &str) -> Vec<i64> {
    Regex::new(r"v(\d+)\.(\d+)\.(\d+)")
        .unwrap()
        .captures(path)
        .map(|c| (1..=3).map(|i| c[i].parse().unwrap_or(-1)).collect())
        .unwrap_or(vec![-1])
}
pub fn find_node() -> Option<PathBuf> {
    if let Some(node) = find_executable("node") {
        return Some(node);
    }
    let nvm = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".nvm"));
    let mut installed = walkdir::WalkDir::new(nvm.join("versions/node"))
        .min_depth(3)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && filename(e.path()) == "node"
                && e.path().parent().is_some_and(|p| filename(p) == "bin")
        })
        .map(|e| e.path().to_owned())
        .collect::<Vec<_>>();
    installed.sort_by_key(|p| version(&p.to_string_lossy()));
    let alias = text(nvm.join("alias/default"))
        .unwrap_or_default()
        .trim()
        .trim_start_matches('v')
        .to_owned();
    let matching = if !alias.is_empty() && Regex::new(r"^[\d.]+$").unwrap().is_match(&alias) {
        installed
            .iter()
            .filter(|p| {
                p.parent()
                    .and_then(Path::parent)
                    .map(filename)
                    .is_some_and(|v| {
                        format!("{}.", v.trim_start_matches('v')).starts_with(&format!("{alias}."))
                    })
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    if let Some(chosen) = matching.last().or_else(|| installed.last()) {
        return Some(chosen.clone());
    }
    for candidate in [
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into()))
            .join("nodejs/node.exe"),
        PathBuf::from(std::env::var("NVM_SYMLINK").unwrap_or_else(|_| r"C:\nvm4w\nodejs".into()))
            .join("node.exe"),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
pub fn scan_cli(args: &[String]) -> Result<()> {
    let store = required(args, "--store")?;
    let collector = option(args, "--collector")
        .map(PathBuf::from)
        .unwrap_or_else(|| app_home().join("mods/insights/collector.mjs"));
    if !collector.is_file() {
        println!(
            "{}",
            json!({"ok":false,"error":"Insights 수집기가 설치되지 않았습니다."})
        );
        return exit_without_diagnostic(1);
    }
    let Some(node) = find_node() else {
        println!("{}", json!({"ok":false,"error":"node를 찾지 못했습니다."}));
        return exit_without_diagnostic(1);
    };
    let timeout = option(args, "--timeout")
        .unwrap_or_else(|| "60".into())
        .parse::<f64>()?;
    let result = timeout_output(
        command(node)
            .arg(collector)
            .args(["snapshot", "--store", &store]),
        timeout.ceil() as u64,
    );
    match result {
        Err(error) => {
            let error = if error.to_string() == "command timeout" {
                format!(
                    "Insights 수집이 {}초 안에 끝나지 않았습니다.",
                    timeout as i64
                )
            } else {
                format!("node 실행 실패: {error}")
            };
            println!("{}", json!({"ok":false,"error":error}));
            exit_without_diagnostic(1)
        }
        Ok(output) if !output.status.success() => {
            let detail = String::from_utf8_lossy(&output.stderr)
                .trim()
                .lines()
                .last()
                .unwrap_or("")
                .chars()
                .take(200)
                .collect::<String>();
            let message = format!(
                "Insights 수집 실패({}){}",
                output.status.code().unwrap_or(-1),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            );
            println!("{}", json!({"ok":false,"error":message}));
            exit_without_diagnostic(1)
        }
        Ok(_) => {
            println!("{}", json!({"ok":true}));
            Ok(())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn store_rejects_bad_counts_and_never_double_counts_views() {
        let store = json!({"version":1,"files":{"a":{"rows":[{"harness":"claude","session":"claude:s","input":1,"output":2,"cacheRead":3,"cacheWrite":4,"day":"2026-11-06","model":"opus"}]}}});
        let result = aggregate(&store, &json!("2026-11-01")).unwrap();
        assert_eq!(result[&("claude".into(), "s".into())]["total"], 10);
        assert!(token_count(&json!(true)).is_err());
        assert!(token_count(&json!(MAX_SAFE + 1)).is_err());
    }
    #[test]
    fn display_metadata_uses_agent_settings_only() {
        assert_eq!(
            model_name(&json!("claude-opus-5-5-20261101")),
            Some("Opus 5.5".into())
        );
        assert_eq!(
            model_name(&json!("gpt-6.1-sol")),
            Some("GPT-6.1-Sol".into())
        );
        assert_eq!(permission_level("never·workspace"), "auto");
        assert_eq!(
            sandbox_of(&json!({"permission_profile":{"type":"disabled"}})),
            Some("danger-full-access".into())
        );
    }
}
