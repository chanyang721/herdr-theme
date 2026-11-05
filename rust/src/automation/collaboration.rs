use super::{routing, tiers};
use crate::common::*;
use crate::locking::FileLock;
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs::OpenOptions, io::Write, path::PathBuf};
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
    let tier = tiers::tier_name(option(args, "--tier").as_deref())?;
    let _lock = locked()?;
    let mut ledger = load()?;
    if let Some(existing) = ledger["tasks"].get(&id) {
        authorized(existing, &who, "source")?;
        if existing["text"] != text
            || existing["mode"] != mode
            || existing["owns"] != owns
            || existing["batch"] != batch
            || existing["tier"].as_str().unwrap_or("high") != tier
        {
            return Err("기존 ID를 다른 작업에 재사용할 수 없습니다.".into());
        }
        return Ok(existing.clone());
    }
    if ledger["reports"].get(format!("{who}:{batch}")).is_some() {
        return Err("이미 보고한 batch에는 작업을 추가할 수 없습니다.".into());
    }
    let mut task = json!({"id":id,"source":who,"space":space["id"],"project":space["name"],"text":text,"mode":mode,"owns":owns,"created":now(),"batch":batch,"tier":tier,"state":"pending","events":[]});
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
fn instruction(task: &Value, token: &str) -> Result<String> {
    let exe = std::env::current_exe()?.to_string_lossy().into_owned();
    let command = format!("{} collaborate", shell_words::quote(&exe));
    let safety = if task["mode"] == "read-only" {
        "읽기 전용: 파일/설정/저장소 변경 금지.".into()
    } else {
        format!(
            "별도 worktree 사용 필수. 소유 파일 영역: {}. 다른 세션의 작업 폴더 수정 금지.",
            s(&task["owns"])
        )
    };
    let id = s(&task["id"]);
    Ok(format!("[과부하 협업 {id}] 원 세션 {}, 프로젝트 {}\n{safety}\n{}\n\n실행 전에 수락 기록: {command} accept {} --lease {token}\n수락 명령이 실패하면 실행하지 마세요. 같은 작업 재분배 금지.\n완료 기록: {command} complete {} --lease {token} --result \"직접 확인한 결과\"\nhc로 개별 완료 회신하지 마세요. 결과는 원 세션이 모아 한 번만 보고합니다. Share 보고 금지.",s(&task["source"]),s(&task["project"]),s(&task["text"]),shell_words::quote(id),shell_words::quote(id)))
}
fn receiver(target: &str, facts: &Value, reserved: &BTreeSet<String>) -> Result<bool> {
    let fact = &facts[target];
    if reserved.contains(target)
        || fact["state"] != "live"
        || !["idle", "done"].contains(&routing::state(fact))
        || s(&fact["agent"]).is_empty()
    {
        return Ok(false);
    }
    let (code, current) = routing::call_args(&strings(&["hc", "get", target, "--json"]), None)?;
    if code != 0 || current["state"] != "live" || routing::state(&current) != "idle" {
        return Ok(false);
    }
    let (code, screen) = routing::call_args(&strings(&["hc", "read", target, "--json"]), None)?;
    Ok(code == 0 && routing::receiver_available(s(&screen["text"])))
}
const OWNED: &[&str] = &["local_active", "sending", "sent", "accepted", "uncertain"];
fn drain() -> Result<Value> {
    let cfg = config()?;
    if cfg["enabled"] == false {
        return Ok(json!([]));
    }
    let _lock = locked()?;
    let mut ledger = load()?;
    let mut tasks: Vec<_> = ledger["tasks"]
        .as_object()
        .unwrap()
        .values()
        .cloned()
        .collect();
    if !tasks.iter().any(|t| t["state"] == "pending") {
        return Ok(json!([]));
    }
    let (spaces, facts) = snapshot()?;
    let mut reserved: BTreeSet<String> = tasks
        .iter()
        .filter(|t| {
            ["sending", "sent", "accepted", "uncertain"].contains(&s(&t["state"]))
                && !s(&t["target"]).is_empty()
        })
        .map(|t| s(&t["target"]).into())
        .collect();
    let mut ownership: Vec<_> = tasks
        .iter()
        .filter(|t| OWNED.contains(&s(&t["state"])))
        .cloned()
        .collect();
    let mut pressure = json!({});
    for t in &tasks {
        pressure[s(&t["source"])] = thresholds(&tasks, s(&t["source"]), &cfg, now());
    }
    let models = tiers::session_models();
    let mapping = tiers::mapping(&site());
    tasks.sort_by(|a, b| {
        a["created"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&b["created"].as_f64().unwrap_or(0.))
    });
    let mut results = vec![];
    for mut task in tasks {
        let source = s(&task["source"]).to_string();
        if task["state"] != "pending"
            || pressure[&source]["overloaded"] != true
            || ownership_conflict(&task, &ownership)
        {
            continue;
        }
        let Ok(space) = space_for(&spaces, &source) else {
            continue;
        };
        if space["id"] != task["space"] || facts[&source]["state"] != "live" {
            continue;
        }
        let mut peers = vec![];
        for tab in list(&space["tabs"]) {
            for t in list(&tab["terminals"]) {
                let address = s(&t["terminal"]);
                if address != source {
                    if let Some(rank) = tiers::rank(
                        task["tier"].as_str().unwrap_or("high"),
                        tiers::tier_of(s(&facts[address]["agent"]), &models[address], &mapping),
                    )? {
                        peers.push((rank, peers.len(), address.to_string()));
                    }
                }
            }
        }
        peers.sort();
        for (_, _, target) in peers {
            if !receiver(&target, &facts, &reserved)? {
                continue;
            }
            let id = s(&task["id"]).to_string();
            let token = uuid::Uuid::new_v4().simple().to_string();
            let path = lease_path(&id)?;
            if path.exists() {
                event(
                    &mut task,
                    "uncertain",
                    json!({"reason":"orphan lease exists; do not resend"}),
                );
                ledger["tasks"][&id] = task.clone();
                save(&ledger)?;
                break;
            }
            std::fs::create_dir_all(path.parent().unwrap())?;
            let lease = json!({"id":id,"source":source,"target":target,"token":token,"created":now(),"mode":task["mode"],"owns":task["owns"]});
            let mut f = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)?;
            private(&path)?;
            serde_json::to_writer(&mut f, &lease)?;
            f.flush()?;
            f.sync_all()?;
            drop(f);
            task["target"] = target.clone().into();
            task["lease"] = token.clone().into();
            event(&mut task, "sending", json!({"pressure":pressure[&source]}));
            ledger["tasks"][&id] = task.clone();
            save(&ledger)?;
            let (code, result) = routing::call_args(
                &strings(&[
                    "hc",
                    "send",
                    &target,
                    "--json",
                    "--if",
                    "idle",
                    &instruction(&task, &token)?,
                ]),
                Some(&source),
            )
            .unwrap_or_else(|e| (1, json!({"error":e.to_string()})));
            let code = if code == 0 && result.get("error").is_some() {
                1
            } else {
                code
            };
            if code != 0
                && ["status_mismatch", "blocked", "finished", "not_found"]
                    .contains(&s(&result["error"]["kind"]))
            {
                std::fs::remove_file(&path)?;
                task.as_object_mut().unwrap().remove("lease");
                task.as_object_mut().unwrap().remove("target");
                event(&mut task, "pending", json!({"rejected":result}));
            } else {
                event(
                    &mut task,
                    if code != 0 { "uncertain" } else { "sent" },
                    json!({"delivery":result}),
                );
                reserved.insert(target.clone());
                ownership.push(task.clone());
            }
            ledger["tasks"][&id] = task.clone();
            save(&ledger)?;
            results.push(json!({"id":id,"target":target,"state":task["state"]}));
            break;
        }
    }
    Ok(json!(results))
}
fn transition(action: &str, args: &[String]) -> Result<Value> {
    let id = args
        .get(1)
        .filter(|v| !v.starts_with('-'))
        .ok_or("task id required")?;
    let who = actor(args)?;
    let _lock = locked()?;
    let mut ledger = load()?;
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
            .filter(|t| OWNED.contains(&s(&t["state"])))
            .cloned()
            .collect::<Vec<_>>();
        if ownership_conflict(&task, &others) {
            return Err("이미 진행 중인 작업과 파일 소유 영역이 겹칩니다.".into());
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
    let action = if flag(args, "--drain") {
        "drain"
    } else {
        args.first().map(String::as_str).unwrap_or("")
    };
    let value = match action {
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
            load()?
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
