use super::tiers;
use crate::common::*;
use crate::locking::FileLock;
use serde_json::{json, Value};
pub fn call_args(argv: &[String], source: Option<&str>) -> Result<(i32, Value)> {
    let mut cmd = command(&argv[0]);
    cmd.args(&argv[1..]);
    if let Some(source) = source {
        cmd.env("HC_TERMINAL_ID", source);
    }
    let (code, out, err) = capture_cmd(cmd, 30.)?;
    let text = if out.is_empty() { &err } else { &out };
    let parsed = serde_json::from_str(text).unwrap_or_else(
        |_| json!({"error":{"message":if err.trim().is_empty(){out.trim()}else{err.trim()}}}),
    );
    Ok((code, parsed))
}
pub fn snapshot() -> Result<(Vec<Value>, Vec<Value>)> {
    let (code, app) = call_args(&strings(&["herdr-app", "ls"]), None)?;
    if code != 0 {
        return Err("Herdr App 워크스페이스 목록을 읽지 못했습니다.".into());
    }
    let (code, core) = call_args(&strings(&["hc", "ls", "--json"]), None)?;
    if code != 0 {
        return Err("에이전트 상태를 읽지 못했습니다.".into());
    }
    Ok((
        list(&app["spaces"]).to_vec(),
        list(&core["terminals"]).to_vec(),
    ))
}
pub fn locate(spaces: &[Value], address: &str) -> Result<(Value, Value, usize)> {
    for space in spaces {
        for tab in list(&space["tabs"]) {
            for (i, t) in list(&tab["terminals"]).iter().enumerate() {
                if t["terminal"] == address {
                    return Ok((space.clone(), tab.clone(), i));
                }
            }
        }
    }
    Err(format!("발신 에이전트를 찾지 못했습니다: {address}").into())
}
pub fn candidates(
    spaces: &[Value],
    live: &[Value],
    source: &str,
    project: &str,
    tier: &str,
    models: &Value,
    mapping: &Value,
) -> Result<(String, Option<String>, Vec<String>)> {
    let (origin, _, slot) = locate(spaces, source)?;
    let site = site();
    if !is_hub(&origin, &site) {
        return Err("Share 워크스페이스에서만 프로젝트 작업을 전달합니다.".into());
    }
    let key = casefold(project);
    let key = site["project_aliases"]
        .as_object()
        .and_then(|a| {
            a.iter()
                .find(|(k, _)| casefold(k) == key)
                .map(|(_, v)| casefold(s(v)))
        })
        .unwrap_or(key);
    let targets: Vec<_> = spaces
        .iter()
        .filter(|sp| {
            casefold(s(&sp["name"])) == key
                || std::path::Path::new(s(&sp["folder"]))
                    .file_name()
                    .is_some_and(|n| casefold(&n.to_string_lossy()) == key)
        })
        .collect();
    if targets.len() != 1 || targets[0]["id"] == origin["id"] {
        return Err(format!("대상 프로젝트를 하나로 확인할 수 없습니다: {project}").into());
    }
    let target = targets[0];
    let tabs: Vec<_> = list(&target["tabs"])
        .iter()
        .filter(|t| t["active"] == true)
        .collect();
    if tabs.len() != 1 {
        return Err("대상 프로젝트의 활성 탭을 확인할 수 없습니다.".into());
    }
    let terminals = list(&tabs[0]["terminals"]);
    let preferred = terminals.get(slot).map(|t| s(&t["terminal"]).to_string());
    let source_kind = live
        .iter()
        .find(|t| t["address"] == source)
        .map(|t| tiers::family(s(&t["agent"])))
        .unwrap_or("");
    let mut ranked = vec![];
    for (i, t) in terminals.iter().enumerate() {
        let address = s(&t["terminal"]);
        let Some(fact) = live.iter().find(|f| f["address"] == address) else {
            continue;
        };
        if fact["state"] != "live" || state(fact) != "idle" || s(&fact["agent"]).is_empty() {
            continue;
        }
        if let Some(step) = tiers::rank(
            tier,
            tiers::tier_of(s(&fact["agent"]), &models[address], mapping),
        )? {
            ranked.push((
                (
                    step,
                    Some(address) != preferred.as_deref(),
                    tiers::family(s(&fact["agent"])) != source_kind,
                    i.abs_diff(slot),
                    i,
                ),
                address.to_string(),
            ));
        }
    }
    ranked.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((
        s(&target["name"]).into(),
        preferred,
        ranked.into_iter().map(|r| r.1).collect(),
    ))
}
pub fn state(fact: &Value) -> &str {
    fact["status"]
        .as_str()
        .unwrap_or_else(|| s(&fact["status"]["state"]))
}
pub fn receiver_available(text: &str) -> bool {
    let text = regex::Regex::new("\x1b\\[[0-9;?]*[A-Za-z]|\r")
        .unwrap()
        .replace_all(text, "");
    let lines: Vec<_> = text.lines().collect();
    let Some(i) = lines
        .iter()
        .rposition(|l| l.trim_start().starts_with(['❯', '›']))
    else {
        return false;
    };
    let row = lines[i].trim_start();
    let draft = row.chars().skip(1).collect::<String>();
    let draft = draft.trim_matches(|c| " ▁▂▃▄▅▆▇█".contains(c));
    if !draft.is_empty()
        && ![
            "Ask Codex to do anything",
            "Ask a follow-up question",
            "Try \"",
        ]
        .iter()
        .any(|p| draft.starts_with(p))
    {
        return false;
    }
    let footer = lines[i.saturating_sub(4)..].join("\n");
    if footer.contains("REC") || footer.contains("voice ● listening") {
        return false;
    }
    let time = regex::Regex::new(r"^[✻✽✶✳✢·]\s+.*\bfor\s+\d").unwrap();
    let line = lines[..i]
        .iter()
        .map(|l| l.trim())
        .filter(|l| {
            !l.is_empty()
                && !l.starts_with(['─', '━', '│', '┌', '└'])
                && !time.is_match(l)
                && ![
                    "Worked for ",
                    "Brewed for ",
                    "Sautéed for ",
                    "voice ",
                    "mic ▁",
                ]
                .iter()
                .any(|w| l.contains(w))
        })
        .last();
    !line.is_some_and(|l| l.ends_with(['?', '？']))
}
pub fn dispatch(request: &Value, spaces: &[Value], live: &[Value]) -> Result<Value> {
    let (project, preferred, ranked) = candidates(
        spaces,
        live,
        s(&request["source"]),
        s(&request["project"]),
        request["tier"].as_str().unwrap_or("high"),
        &tiers::session_models(),
        &tiers::mapping(&site()),
    )?;
    for target in ranked {
        let (code, observed) = call_args(&strings(&["hc", "get", &target]), None)?;
        if code != 0 || observed["state"] != "live" || state(&observed) != "idle" {
            continue;
        }
        let (code, screen) = call_args(&strings(&["hc", "read", &target, "--json"]), None)?;
        if code != 0 || !receiver_available(s(&screen["text"])) {
            continue;
        }
        let source = s(&request["source"]);
        let report = if request["reply"] == true {
            format!("이 작업의 결과 또는 막힌 점을 hc send {source} 명령으로 한 번 회신하세요.")
        } else {
            format!("여러 갈래 작업은 이 세션의 서브에이전트로 처리하고, 사용자가 직접 결정해야 할 일이 생겼을 때만 hc send {source}로 알리세요. 진행·완료 보고는 보내지 마세요.")
        };
        let text=format!("[Share 작업 전달 {}] {source} → {project} / {target}\n{}\n\n{report}\n다른 pane으로 재배분하지 마세요.",s(&request["id"]),s(&request["text"]));
        let (code, result) = call_args(
            &strings(&["hc", "send", &target, "--json", "--if", "idle", &text]),
            Some(source),
        )?;
        if code == 0 {
            return Ok(
                json!({"state":"sent","id":request["id"],"source":source,"tier":tiers::tier_name(request["tier"].as_str())?,"project":project,"preferred":preferred,"target":target,"fallback":Some(target.as_str())!=preferred.as_deref(),"result":result}),
            );
        }
        if !["status_mismatch", "blocked", "finished", "not_found"]
            .contains(&s(&result["error"]["kind"]))
        {
            return Err(
                format!("전달 결과 불명확, 중복 전송을 피하려고 중단합니다: {result}").into(),
            );
        }
    }
    Ok(
        json!({"state":"queued","id":request["id"],"source":request["source"],"project":project,"preferred":preferred,"reason":"모든 수신 pane이 작업 중이거나 확인 대기입니다."}),
    )
}
fn save_queue(pending: &[Value]) -> Result<()> {
    atomic_text(
        data().join("routing-queue.json"),
        &json_text(&json!({"requests":pending}), false),
    )
}
fn deliver(
    index: usize,
    pending: &mut Vec<Value>,
    spaces: &[Value],
    live: &[Value],
) -> Result<Value> {
    pending[index]["hold"] = true.into();
    pending[index]["error"] =
        "전달 시도 중 종료되면 결과를 직접 확인하세요. 자동 재전송하지 않습니다.".into();
    save_queue(pending)?;
    match dispatch(&pending[index], spaces, live) {
        Ok(result) => {
            if result["state"] == "queued" {
                pending[index].as_object_mut().unwrap().remove("hold");
                pending[index].as_object_mut().unwrap().remove("error");
            } else {
                pending.remove(index);
            }
            save_queue(pending)?;
            Ok(result)
        }
        Err(e) => {
            pending[index]["error"] = e.to_string().into();
            save_queue(pending)?;
            Err(e)
        }
    }
}
fn source(explicit: Option<String>) -> Result<String> {
    if let Some(s) = explicit.filter(|value| !value.is_empty()).or_else(|| {
        std::env::var("HC_TERMINAL_ID")
            .ok()
            .filter(|value| !value.is_empty())
    }) {
        return Ok(s);
    }
    if let Some(pane) = std::env::var("HERDR_PANE_ID")
        .ok()
        .filter(|value| !value.is_empty())
    {
        let mapping =
            read_json(home().join(".local/state/herdr-sixfold/migration-map.local.json"))?;
        if let Some(item) = list(&mapping["panes"]).iter().find(|p| p["source"] == pane) {
            return Ok(s(&item["terminal"]).into());
        }
    }
    Err("발신 위치가 없습니다. Share 세션에서 실행하거나 --from 실제터미널ID를 지정하세요.".into())
}
pub fn run(args: &[String]) -> Result<()> {
    let drain = flag(args, "--drain");
    std::fs::create_dir_all(data())?;
    if flag(args, "--enable") {
        let binary = std::env::current_exe()?.to_string_lossy().into_owned();
        atomic(
            data().join("routing.json"),
            &json!({"command":[binary,"route"],"script":binary}),
        )?;
        return print(&json!({"state":"enabled","script":binary}));
    }
    let positionals = super::cli::positionals(args, &["--from", "--tier"]);
    if !drain && positionals.len() != 2 {
        return Err("project 와 작업 메시지가 필요합니다.".into());
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(data().join("routing.lock"))?;
    if lock.try_lock_exclusive().is_err() {
        if drain {
            return Ok(());
        }
        return Err("다른 작업을 전달 중입니다. 전송하지 않았으니 잠시 후 다시 실행하세요.".into());
    }
    let path = data().join("routing-queue.json");
    let mut pending = if path.exists() {
        list(&read_json(&path)?["requests"]).to_vec()
    } else {
        vec![]
    };
    if drain && pending.is_empty() {
        return Ok(());
    }
    let (mut spaces, mut live) = snapshot()?;
    if drain {
        let mut index = 0;
        while index < pending.len() {
            if pending[index]["hold"] == true {
                index += 1;
                continue;
            }
            match deliver(index, &mut pending, &spaces, &live) {
                Ok(result) => {
                    print(&result)?;
                    if result["state"] == "sent" {
                        (spaces, live) = snapshot()?;
                    } else {
                        index += 1;
                    }
                }
                Err(_) => index += 1,
            }
        }
    } else {
        if pending.len() >= 64 {
            return Err("대기 요청 64건이 차 있어 새 요청을 넣지 않았습니다.".into());
        }
        let req = json!({"id":uuid::Uuid::new_v4().simple().to_string()[..10].to_owned(),"source":source(option(args,"--from"))?,"project":positionals[0],"text":positionals[1],"reply":flag(args,"--reply"),"tier":tiers::tier_name(option(args,"--tier").as_deref())?,"at":(now()*1000.)as i64});
        pending.push(req);
        let index = pending.len() - 1;
        print(&deliver(index, &mut pending, &spaces, &live)?)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composer_and_question_guards() {
        assert!(receiver_available("All done\n› Ask Codex to do anything"));
        for s in [
            "Proceed?\n❯ ",
            "Done\n❯ draft",
            "Done\n❯ \nvoice ● listening",
            "no prompt",
        ] {
            assert!(!receiver_available(s), "{s}");
        }
        assert!(receiver_available("old question?\nold answer\n❯ "));
    }
}
