use super::{routing, tiers};
use crate::common::*;
use crate::locking::FileLock;
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs::OpenOptions, path::PathBuf};
fn valid_id(id: &str) -> bool {
    regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
        .unwrap()
        .is_match(id)
}
fn lease_path(id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err("작업 ID 형식 오류".into());
    }
    Ok(data()
        .join("collaboration-leases")
        .join(format!("{id}.json")))
}
fn config() -> Result<Value> {
    let mut cfg = json!({"enabled":true,"pending_count":2,"oldest_seconds":600,"active_count":3,"exclude_spaces":["share","공통","common"]});
    let path = data().join("collaboration.json");
    if path.exists() {
        let v = read_json(path)?;
        let obj = v
            .as_object()
            .ok_or("collaboration.json은 객체여야 합니다.")?;
        cfg.as_object_mut().unwrap().extend(obj.clone());
    }
    if !cfg["enabled"].is_boolean() {
        return Err("enabled는 boolean이어야 합니다.".into());
    }
    let exclude = cfg["exclude_spaces"]
        .as_array()
        .ok_or("exclude_spaces는 문자열 배열이어야 합니다.")?;
    if exclude.iter().any(|v| !v.is_string()) {
        return Err("exclude_spaces는 문자열 배열이어야 합니다.".into());
    }
    let mut merged: BTreeSet<String> = ["share", "공통", "common"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    merged.extend(exclude.iter().map(|v| casefold(s(v))));
    merged.extend(
        list(&site()["hub_space_ids"])
            .iter()
            .map(|v| s(v).to_string()),
    );
    cfg["exclude_spaces"] = json!(merged);
    for k in ["pending_count", "oldest_seconds", "active_count"] {
        if cfg[k].as_i64().is_none_or(|n| n < 1) {
            return Err(format!("invalid {k}").into());
        }
    }
    Ok(cfg)
}
fn load() -> Result<Value> {
    let path = data().join("collaboration-tasks.json");
    let value = if path.exists() {
        read_json(path)?
    } else {
        json!({"version":1,"tasks":{}})
    };
    if value["version"] != 1 || !value["tasks"].is_object() {
        return Err("손상된 협업 원장: 자동 초기화하지 않습니다.".into());
    }
    Ok(value)
}
fn save(ledger: &Value) -> Result<()> {
    atomic(data().join("collaboration-tasks.json"), ledger)
}
fn locked() -> Result<std::fs::File> {
    std::fs::create_dir_all(data())?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(data().join("collaboration.lock"))?;
    lock.lock_exclusive()?;
    Ok(lock)
}
fn event(task: &mut Value, state: &str, facts: Value) {
    task["state"] = state.into();
    if !task["events"].is_array() {
        task["events"] = json!([]);
    }
    let mut e = json!({"state":state,"at":now()});
    if let Some(f) = facts.as_object() {
        e.as_object_mut().unwrap().extend(f.clone());
    }
    task["events"].as_array_mut().unwrap().push(e);
}
fn actor(args: &[String]) -> Result<String> {
    let explicit = option(args, "--from").filter(|value| !value.is_empty());
    let current = std::env::var("HC_TERMINAL_ID")
        .ok()
        .filter(|value| !value.is_empty());
    if current.is_some() && explicit.is_some() && current != explicit {
        return Err("--from과 실제 HC_TERMINAL_ID가 다릅니다.".into());
    }
    current
        .or(explicit)
        .ok_or_else(|| "HC_TERMINAL_ID 또는 --from이 필요합니다.".into())
}
fn authorized(task: &Value, who: &str, role: &str) -> Result<()> {
    if task[role] != who {
        Err(format!("{role} 세션만 이 작업 상태를 바꿀 수 있습니다.").into())
    } else {
        Ok(())
    }
}
fn snapshot() -> Result<(Vec<Value>, Value)> {
    let (spaces, live) = routing::snapshot()?;
    let mut facts = json!({});
    for f in live {
        let address = s(&f["address"]).to_string();
        facts[&address] = f;
    }
    Ok((spaces, facts))
}
fn space_for(spaces: &[Value], who: &str) -> Result<Value> {
    let matches: Vec<_> = spaces
        .iter()
        .filter(|sp| {
            list(&sp["tabs"])
                .iter()
                .any(|tab| list(&tab["terminals"]).iter().any(|t| t["terminal"] == who))
        })
        .collect();
    if matches.len() != 1 {
        return Err("세션의 프로젝트 공간을 하나로 확인하지 못했습니다.".into());
    }
    let space = matches[0];
    let cfg = config()?;
    if list(&cfg["exclude_spaces"])
        .iter()
        .any(|x| s(x) == casefold(s(&space["name"])) || x == &space["id"])
    {
        return Err("Share 공간에서는 과부하 협업을 받거나 보내지 않습니다.".into());
    }
    Ok(space.clone())
}
fn required(args: &[String], name: &str) -> Result<String> {
    option(args, name).ok_or_else(|| format!("{name} is required").into())
}
// The executable prefix is installed/configured explicitly, never a guessed home path.
fn intake_request(task: &Value) -> Value {
    let mut value = json!({});
    for key in [
        "id", "source", "space", "text", "mode", "owns", "batch", "tier", "repo",
    ] {
        if let Some(v) = task.get(key) {
            value[key] = v.clone();
        }
    }
    value
}
fn intake(action: &str, task: &Value) -> Result<Value> {
    intake_payload(action, &intake_request(task))
}
fn intake_payload(action: &str, request: &Value) -> Result<Value> {
    let payload = serde_json::to_vec(request)?;
    if payload.len() > 2 * 1024 * 1024 {
        return Err("collaboration request exceeds 2 MiB".into());
    }
    let cfg = config()?;
    let prefix = cfg["harness_command"].as_array().ok_or(
        "collaboration.json harness_command must name the installed harness executable prefix",
    )?;
    if prefix.is_empty()
        || prefix
            .iter()
            .any(|v| v.as_str().is_none_or(|s| s.is_empty()))
    {
        return Err("invalid harness_command".into());
    }
    let mut argv: Vec<String> = prefix.iter().map(|v| s(v).to_string()).collect();
    argv.extend([
        "collaboration-intake".into(),
        action.into(),
        "--request-stdin".into(),
    ]);
    // Never inject the stored source as HC_TERMINAL_ID. Engine verifies actual ancestry.
    // A drain may wait for a newly started receiver. Keep ordinary status and
    // registration reads bounded without cancelling a valid longer dispatch.
    let timeout = if action == "drain" { 180. } else { 30. };
    let (code, result) = routing::call_args_stdin(&argv, None, timeout, payload)?;
    if code != 0 || result.get("error").is_some() {
        return Err(format!("harness intake refused: {result}").into());
    }
    Ok(result)
}
fn enqueue(args: &[String]) -> Result<Value> {
    let who = actor(args)?;
    let (spaces, live) = snapshot()?;
    let space = space_for(&spaces, &who)?;
    if live[&who]["state"] != "live" {
        return Err("실행 중인 발신 세션이 아닙니다.".into());
    }
    let id = required(args, "--id")?;
    if !valid_id(&id) {
        return Err("작업 ID 형식 오류".into());
    }
    let text = required(args, "--text")?;
    let mode = required(args, "--mode")?;
    if !["read-only", "worktree"].contains(&mode.as_str()) {
        return Err("invalid mode".into());
    }
    let owns = option(args, "--owns").unwrap_or_default();
    if mode == "worktree" && owns.is_empty() {
        return Err("worktree 작업은 --owns 파일 영역을 반드시 명시하세요.".into());
    }
    if owns.split(',').any(|p| {
        let p = p.trim().replace('\\', "/");
        p.starts_with('/') || p.split('/').any(|n| n == "..")
    }) {
        return Err("--owns는 .. 없는 저장소 상대 경로를 쉼표로 구분해 쓰세요.".into());
    }
    let batch = option(args, "--batch").unwrap_or(id.clone());
    let repo = option(args, "--repo");
    let tier = tiers::tier_name(option(args, "--tier").as_deref())?;
    let _lock = locked()?;
    let mut ledger = load()?;
    if let Some(existing) = ledger["tasks"].get(&id) {
        authorized(existing, &who, "source")?;
        if existing["text"] != text
            || existing["mode"] != mode
            || existing["owns"] != owns
            || existing["batch"] != batch
            || existing.get("repo").and_then(Value::as_str) != repo.as_deref()
            || existing["tier"].as_str().unwrap_or("high") != tier
        {
            return Err("기존 ID를 다른 작업에 재사용할 수 없습니다.".into());
        }
        if existing.get("harness_intake").is_none() {
            return Err("legacy request has no verified intake; reconcile its delivery before registering new work".into());
        }
        intake("enqueue", existing)?;
        return Ok(existing.clone());
    }
    if ledger["reports"].get(format!("{who}:{batch}")).is_some() {
        return Err("이미 보고한 batch에는 작업을 추가할 수 없습니다.".into());
    }
    let mut task = json!({"id":id,"source":who,"space":space["id"],"project":space["name"],"text":text,"mode":mode,"owns":owns,"created":now(),"batch":batch,"tier":tier,"state":"pending","events":[]});
    if let Some(repo) = repo {
        task["repo"] = repo.into();
    }
    let receipt = intake("enqueue", &task)?;
    task["harness_intake"] = receipt;
    event(
        &mut task,
        "pending",
        json!({"evidence":"explicit source declaration"}),
    );
    ledger["tasks"][&id] = task.clone();
    save(&ledger)?;
    Ok(task)
}
pub fn thresholds(tasks: &[Value], source: &str, cfg: &Value, at: f64) -> Value {
    let pending: Vec<_> = tasks
        .iter()
        .filter(|t| t["source"] == source && t["state"] == "pending")
        .collect();
    let active = tasks
        .iter()
        .filter(|t| t["source"] == source && t["state"] == "local_active")
        .count();
    let oldest = pending
        .iter()
        .map(|t| at - t["created"].as_f64().unwrap_or(at))
        .fold(0., f64::max);
    json!({"overloaded":pending.len()>=cfg["pending_count"].as_u64().unwrap_or(2)as usize||oldest>=cfg["oldest_seconds"].as_f64().unwrap_or(600.)||active>=cfg["active_count"].as_u64().unwrap_or(3)as usize,"pending":pending.len(),"oldest_seconds":oldest,"active":active,"evidence":"collaboration-tasks.json explicit task states"})
}
fn prefixes(owns: &str) -> Vec<String> {
    let mut result = vec![];
    for p in owns.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let p = p.replace('\\', "/");
        let p = p.strip_prefix("./").unwrap_or(&p);
        let ix = p.find(['*', '?', '[']);
        let mut prefix = p[..ix.unwrap_or(p.len())].to_string();
        if ix.is_some() && !prefix.ends_with('/') {
            prefix = prefix
                .rsplit_once('/')
                .map(|(p, _)| p)
                .unwrap_or("")
                .to_string();
        }
        result.push(prefix.trim_end_matches('/').into());
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}
pub fn ownership_conflict(task: &Value, others: &[Value]) -> bool {
    if task["mode"] == "read-only" {
        return false;
    }
    for other in others {
        if other["id"] == task["id"]
            || other["space"] != task["space"]
            || other["mode"] == "read-only"
        {
            continue;
        }
        for left in prefixes(s(&task["owns"])) {
            for right in prefixes(s(&other["owns"])) {
                if left.is_empty()
                    || right.is_empty()
                    || left == right
                    || left.starts_with(&format!("{right}/"))
                    || right.starts_with(&format!("{left}/"))
                {
                    return true;
                }
            }
        }
    }
    false
}
const OWNED: &[&str] = &[
    "local_active",
    "sending",
    "sent",
    "accepted",
    "uncertain",
    "harness_managed",
];
fn is_owned(task: &Value) -> bool {
    OWNED.contains(&s(&task["state"]))
        && !(task["state"] == "harness_managed"
            && task["harness_projection"]["ownership_released"] == true)
}
fn release_confirmed(ledger: &mut Value) -> bool {
    let mut changed = false;
    for task in ledger["tasks"].as_object_mut().unwrap().values_mut() {
        if task["state"] == "harness_managed"
            && task["harness_projection"]["ownership_released"] == true
        {
            event(task, "harness_released", json!({"ownership_released":true}));
            task["blocked_reason"] = Value::Null;
            changed = true;
        }
    }
    changed
}
fn refresh_harness(ledger: &mut Value, force: bool) -> Result<()> {
    // Persist an earlier confirmed release before any new process can fail.
    // This also retires released entries saved by versions that kept querying
    // them forever. Terminal releases no longer grow the status request.
    if release_confirmed(ledger) {
        save(ledger)?;
    }
    let requests: Vec<Value> = ledger["tasks"]
        .as_object()
        .unwrap()
        .values()
        .filter(|t| t["state"] == "harness_managed")
        .map(intake_request)
        .collect();
    if requests.is_empty()
        || (!force && now() - ledger["harness_checked_at"].as_f64().unwrap_or(0.) < 60.)
    {
        return Ok(());
    }
    // One batch / one engine records read, not one scan per task on the UI's 2s timer.
    let projections = intake_payload("status", &json!(requests));
    for task in ledger["tasks"].as_object_mut().unwrap().values_mut() {
        if task["state"] == "harness_managed" {
            task["harness_projection"] = json!({"ownership_released":false,"reason":"status unavailable; ownership retained"});
        }
    }
    match projections {
        Ok(rows) if rows.is_array() => {
            for row in rows.as_array().unwrap() {
                if let Some(task) = ledger["tasks"].get_mut(s(&row["id"])) {
                    if task["state"] == "harness_managed" {
                        task["harness_projection"] = row.clone();
                    }
                }
            }
        }
        _ => {}
    }
    release_confirmed(ledger);
    ledger["harness_checked_at"] = json!(now());
    save(ledger)
}
/// Stable model-tier order used by both the original helper and the live drain.
pub fn tier_order(
    addresses: &[String],
    tier: Option<&str>,
    facts: &Value,
    models: &Value,
    mapping: &Value,
) -> Result<Vec<String>> {
    let mut peers = vec![];
    for address in addresses {
        if let Some(rank) = tiers::rank(
            tier.unwrap_or("high"),
            tiers::tier_of(s(&facts[address]["agent"]), &models[address], mapping),
        )? {
            peers.push((rank, peers.len(), address.clone()));
        }
    }
    peers.sort();
    Ok(peers.into_iter().map(|(_, _, address)| address).collect())
}
fn drain() -> Result<Value> {
    let cfg = config()?;
    if cfg["enabled"] == false {
        return Ok(json!([]));
    }
    let _lock = locked()?;
    let mut ledger = load()?;
    refresh_harness(&mut ledger, false)?;
    let tasks: Vec<Value> = ledger["tasks"]
        .as_object()
        .unwrap()
        .values()
        .cloned()
        .collect();
    let current = std::env::var("HC_TERMINAL_ID").unwrap_or_default();
    let mut results = vec![];
    for mut task in tasks.clone() {
        if !["pending", "sending", "sent", "uncertain"].contains(&s(&task["state"])) {
            continue;
        }
        let id = s(&task["id"]).to_string();
        let reason;
        if task.get("harness_intake").is_none() {
            reason =
                "legacy delivery/intake is unverified; reconcile before re-enqueue".to_string();
        } else if task["state"] != "pending" || lease_path(&id)?.exists() {
            reason = "existing lease/delivery requires reconciliation; not resent".to_string();
        } else if ownership_conflict(
            &task,
            &tasks
                .iter()
                .filter(|t| is_owned(t))
                .cloned()
                .collect::<Vec<_>>(),
        ) {
            reason = "existing legacy/harness writer owns this area; reconcile or wait".to_string();
        } else if current != s(&task["source"]) {
            reason =
                "originating agent must run drain; UI timer cannot dispatch as another session"
                    .to_string();
        } else if thresholds(&tasks, s(&task["source"]), &cfg, now())["overloaded"] != true {
            continue;
        } else {
            match intake("drain", &task) {
                Ok(receipt) => {
                    let state = s(&receipt["state"]).to_string();
                    task["harness_intake"] = receipt;
                    if ["handed_off", "sending", "uncertain", "reconcile_required"]
                        .contains(&state.as_str())
                    {
                        event(&mut task, "harness_managed", json!({"intake_state":state}));
                    }
                    task["blocked_reason"] = if state == "blocked" {
                        json!("harness dry-run blocked; originating session may retry")
                    } else {
                        Value::Null
                    };
                    ledger["tasks"][&id] = task.clone();
                    save(&ledger)?;
                    results.push(
                        json!({"id":id,"state":task["state"],"harness":task["harness_intake"]}),
                    );
                    continue;
                }
                Err(error) => {
                    reason = error.to_string();
                }
            }
        }
        // UI reads do not append events or rewrite an unchanged ledger every two seconds.
        if task["blocked_reason"] != reason {
            task["blocked_reason"] = reason.clone().into();
            ledger["tasks"][&id] = task;
            save(&ledger)?;
        }
        results.push(json!({"id":id,"reason":reason}));
    }
    Ok(json!(results))
}
fn transition(action: &str, args: &[String]) -> Result<Value> {
    let positional = super::cli::positionals(args, &["--from", "--lease", "--result"]);
    let id = positional.get(1).ok_or("task id required")?;
    let who = actor(args)?;
    let _lock = locked()?;
    let mut ledger = load()?;
    if action == "start" {
        refresh_harness(&mut ledger, true)?;
    }
    let mut task = ledger["tasks"]
        .get(id)
        .cloned()
        .ok_or("알 수 없는 작업 ID")?;
    if action == "start" {
        authorized(&task, &who, "source")?;
        if task["state"] == "local_active" {
            return Ok(task);
        }
        if task["state"] != "pending" || lease_path(id)?.exists() {
            return Err("임대된 작업은 원 세션에서 실행할 수 없습니다.".into());
        }
        let others = ledger["tasks"]
            .as_object()
            .unwrap()
            .values()
            .filter(|t| is_owned(t))
            .cloned()
            .collect::<Vec<_>>();
        if ownership_conflict(&task, &others) {
            return Err("이미 진행 중인 작업과 파일 소유 영역이 겹칩니다.".into());
        }
        if task.get("harness_intake").is_some() {
            task["harness_intake"] = intake("local", &task)?;
        }
        event(&mut task, "local_active", json!({}));
    } else if ["accept", "complete"].contains(&action) && task["state"] != "local_active" {
        authorized(&task, &who, "target")?;
        let lease = required(args, "--lease")?;
        if lease.is_empty() || task["lease"] != lease {
            return Err("임대 토큰 불일치".into());
        }
        let mut persisted = read_json(lease_path(id)?)?;
        if persisted["token"] != lease || persisted["target"] != who {
            return Err("임대 파일 불일치".into());
        }
        if action == "accept" {
            if task["state"] == "accepted" {
                return Ok(task);
            }
            if !["sent", "uncertain", "sending"].contains(&s(&task["state"])) {
                return Err("수락 가능한 상태가 아닙니다.".into());
            }
            let (spaces, _) = snapshot()?;
            if space_for(&spaces, &who)?["id"] != task["space"] {
                return Err("수신 세션이 원 프로젝트 공간에서 이동했습니다.".into());
            }
            event(&mut task, "accepted", json!({"actor":who}));
            persisted["accepted_at"] = now().into();
            atomic(lease_path(id)?, &persisted)?;
        } else {
            if task["state"] == "completed" {
                return Ok(task);
            }
            if task["state"] != "accepted" {
                return Err("수락 전에 완료할 수 없습니다.".into());
            }
            event(&mut task, "completed", json!({"actor":who}));
            task["result"] = required(args, "--result")?.into();
        }
    } else if action == "complete" {
        authorized(&task, &who, "source")?;
        event(&mut task, "completed", json!({"actor":who}));
        task["result"] = required(args, "--result")?.into();
    } else {
        return Err("지원하지 않는 상태 전환".into());
    }
    ledger["tasks"][id] = task.clone();
    save(&ledger)?;
    Ok(task)
}
fn report(args: &[String]) -> Result<Value> {
    let who = actor(args)?;
    let batch = required(args, "--batch")?;
    let _lock = locked()?;
    let mut ledger = load()?;
    let tasks: Vec<_> = ledger["tasks"]
        .as_object()
        .unwrap()
        .values()
        .filter(|t| t["source"] == who && t["batch"] == batch)
        .collect();
    if tasks
        .iter()
        .any(|t| ["harness_managed", "harness_released"].contains(&s(&t["state"])))
    {
        return Ok(
            json!({"state":"harness_managed","reason":"use harness inbox/report routing; this receipt is not completion or acceptance", "tasks":tasks.iter().map(|t| json!({"id":t["id"],"harness_intake":t["harness_intake"]})).collect::<Vec<_>>()}),
        );
    }
    if tasks.is_empty() || tasks.iter().any(|t| t["state"] != "completed") {
        return Err("이 batch의 모든 작업이 완료돼야 보고할 수 있습니다.".into());
    }
    let key = format!("{who}:{batch}");
    if let Some(previous) = ledger["reports"].get(&key) {
        return Ok(
            json!({"state":"already_reported","source":who,"batch":batch,"at":previous["at"]}),
        );
    }
    let text = tasks
        .iter()
        .map(|t| format!("{}: {}", s(&t["id"]), s(&t["result"])))
        .collect::<Vec<_>>()
        .join("\n");
    let value = json!({"state":"reported","source":who,"batch":batch,"at":now(),"text":text});
    if !ledger["reports"].is_object() {
        ledger["reports"] = json!({});
    }
    ledger["reports"][&key] = value.clone();
    save(&ledger)?;
    Ok(value)
}
pub fn run(args: &[String]) -> Result<()> {
    let positionals = super::cli::positionals(
        args,
        &[
            "--id", "--text", "--mode", "--owns", "--batch", "--from", "--tier", "--lease",
            "--result", "--repo",
        ],
    );
    let action = positionals.first().map(String::as_str).unwrap_or("");
    let action = if action == "enable" {
        "enable"
    } else if flag(args, "--drain") {
        "drain"
    } else {
        action
    };
    let value = match action {
        "capabilities" => json!({"harness_intake_protocol": 1}),
        "enable" => {
            let _lock = locked()?;
            let mut cfg = config()?;
            let exe = std::env::current_exe()?.to_string_lossy().into_owned();
            cfg["script"] = exe.clone().into();
            cfg["command"] = json!([exe, "collaborate"]);
            cfg["enabled"] = true.into();
            atomic(data().join("collaboration.json"), &cfg)?;
            json!({"enabled":true,"config":data().join("collaboration.json")})
        }
        "status" => {
            let _lock = locked()?;
            let mut ledger = load()?;
            refresh_harness(&mut ledger, true)?;
            ledger
        }
        "enqueue" => enqueue(args)?,
        "drain" => drain()?,
        "start" | "accept" | "complete" => transition(action, args)?,
        "report" => report(args)?,
        _ => return Err("명령을 지정하세요.".into()),
    };
    print(&value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_uses_path_boundaries_and_wildcard_prefix() {
        let t = json!({"id":"a","space":"s","mode":"worktree","owns":"src/feat*"});
        assert!(ownership_conflict(
            &t,
            &[json!({"id":"b","space":"s","mode":"worktree","owns":"src/feature.rs"})]
        ));
        assert!(!ownership_conflict(
            &t,
            &[json!({"id":"b","space":"s","mode":"worktree","owns":"tests/a.rs"})]
        ));
    }
    #[test]
    fn thresholds_independent() {
        let cfg = json!({"pending_count":2,"active_count":3,"oldest_seconds":600});
        let tasks = vec![json!({"source":"a","state":"pending","created":10})];
        assert_eq!(thresholds(&tasks, "a", &cfg, 100.)["overloaded"], false);
        assert_eq!(thresholds(&tasks, "a", &cfg, 611.)["overloaded"], true);
        assert!(!valid_id("../a"));
    }
}
