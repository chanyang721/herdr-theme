use super::*;
use std::collections::BTreeSet;
pub fn push(item: &mut Value, reason: impl Into<String>) {
    if !item["reasons"].is_array() {
        item["reasons"] = json!([])
    }
    item["reasons"]
        .as_array_mut()
        .unwrap()
        .push(json!(reason.into()));
}
pub fn focus(status: &Value) -> Value {
    json!([status["space"], status["tab"], status["focused_pane"]])
}
pub fn last_prompt_is_report_request(text: &str) -> bool {
    crate::python_unicode::split_lines(text)
        .into_iter()
        .filter(|l| crate::python_unicode::regex(r"^\s*[❯›>]\s+\S").is_match(l))
        .next_back()
        .is_some_and(|l| l.contains(sessions::REPORT_MARK))
}
pub fn decision_pending(text: &str) -> bool {
    let mut request = false;
    let mut lines = vec![];
    for l in crate::python_unicode::split_lines(text) {
        if l.contains(sessions::REPORT_MARK) {
            request = true;
            continue;
        }
        if request {
            if l.trim_start_matches(crate::python_unicode::is_space)
                .starts_with(['⏺', '•', '─'])
            {
                request = false
            } else {
                continue;
            }
        }
        if crate::python_unicode::regex(r"(?i)(?:Blocked|Allowed)\s+by\s+auto\s+mode|/perm[iİı]ss[iİı]ons\s+to\s+rev[iİı]ew|기억함|memory w[iİı]ndow").is_match(l){continue}
        lines.push(l)
    }
    let t = lines.join("\n");
    crate::python_unicode::regex(r"(?i)승인\s*대기|(?:사용자|직접|당신의?)\s*확인\s*필요|확인이\s*필요합니다|결정\s*대기|사용자.{0,12}(?:확인|승인).{0,8}(?:대기|기다)|awa[iİı]t[iİı]ng\s+(?:approval|conf[iİı]rmat[iİı]on)|wa[iİı]t[iİı]ng\s+for\s+(?:your|user)\s+(?:approval|conf[iİı]rmat[iİı]on)|allow\s+(?:once|always)").is_match(&t)
        || crate::python_unicode::sub(r"(?i)Do you want to (?:proceed|make th[iİı]s ed[iİı]t|create|run|allow)\b", &t, "") != t
        || crate::python_unicode::sub(r"(?i)❯\s*1\.\s*Yes\b", &t, "") != t
}
pub fn background_running(text: &str) -> bool {
    let text = tail(text, 8);
    crate::python_unicode::sub(
        r"(?i)\b\d+\s+(?:mon[iİı]tors?|shells?|background\s+(?:tasks?|shells?|jobs?))(?:\s+st[iİı]ll\s+runn[iİı]ng)?\b",
        &text,
        "",
    ) != text
}
pub fn empty_prompt(text: &str, agent: &str) -> bool {
    let marker = match agent {
        "codex" => '›',
        "claude" | "claude-code" => '❯',
        _ => return false,
    };
    let lines = crate::python_unicode::split_lines(text);
    let Some(i) = lines.iter().rposition(|l| {
        l.trim_start_matches(crate::python_unicode::is_space)
            .starts_with(marker)
    }) else {
        return false;
    };
    let v = crate::python_unicode::trim(lines[i]);
    let v = crate::python_unicode::trim(v.strip_prefix(marker).unwrap_or(v));
    let placeholders = [
        "",
        "Ask Codex to do anything",
        "Write tests for @filename",
        "Implement {feature}",
        "Find and fix a bug in @filename",
        "Explain this codebase",
        "Improve documentation in @filename",
        "Summarize recent commits",
        "Use /skills to list available skills",
    ];
    if !placeholders.contains(&v) {
        return false;
    }
    let footer = crate::python_unicode::regex(
        r"(?i)^(?:[─━═]{3,}$|GPT-|Claude|[←↳]|[▁▂▃▄▅▆▇█]|⚠|⏵|\?\s|\d+%\s+context|for agents|.*weekly l[iİı]m[iİı]t|.*auto mode|.*sh[iİı]ft\+tab|.*esc to [iİı]nterrupt)",
    );
    let bounded = crate::python_unicode::regex(r"(?i)^(?:vo[iİı]ce|m[iİı]c|codex|f\d+)");
    lines[i + 1..].iter().all(|l| {
        let line = crate::python_unicode::trim(l);
        line.is_empty()
            || footer.is_match(line)
            || bounded
                .find(line)
                .is_some_and(|m| crate::python_unicode::word_boundary(line, m.end()))
    })
}
pub fn claude_suggestion(text: &str, app: &str, a: &mut dyn Adapter, address: &str) -> bool {
    if sessions::provider(app) != "claude" {
        return false;
    }
    let mut lines: Vec<String> = crate::python_unicode::split_lines(text)
        .into_iter()
        .map(str::to_owned)
        .collect();
    let Some(i) = lines.iter().rposition(|l| {
        l.trim_start_matches(crate::python_unicode::is_space)
            .starts_with('❯')
    }) else {
        return false;
    };
    let value = crate::python_unicode::trim(&lines[i]);
    let value = crate::python_unicode::trim(value.strip_prefix('❯').unwrap_or(value)).to_owned();
    lines[i] = "❯".into();
    if value.is_empty() || !empty_prompt(&lines.join("\n"), app) {
        return false;
    }
    a.styled_screen(address)
        .map(|raw| sessions::suggestion_only(&value, &raw))
        .unwrap_or(false)
}
pub fn fixed(space: &Value, c: &Value) -> bool {
    arr(&c["fixed_names"])
        .iter()
        .any(|n| crate::common::casefold(s(n)) == crate::common::casefold(s(&space["name"])))
        || arr(&c["fixed_spaces"])
            .iter()
            .any(|i| i["id"] == space["id"] && i["machine"] == space["machine"])
}
pub fn slept_session(t: &Value, space: &Value) -> Value {
    let label = s(&t["labels"]["sixfold.sleep"]);
    let Some((provider, sid)) = label.split_once(':') else {
        return Value::Null;
    };
    let argv = arr(&t["foreground"]["argv"]);
    let stub = argv.iter().any(|a| {
        s(a).ends_with("session_sleep_stub.py")
            || s(a) == "session-sleep-stub"
            || s(a) == "session_sleep_stub"
    });
    if !stub || !["claude", "codex"].contains(&provider) || !re(r"^[0-9a-f-]{36}$").is_match(sid) {
        return Value::Null;
    }
    let mut v = json!({"address":t["address"],"app":if provider=="claude"{"claude-code"}else{"codex"},"session_id":sid,"space_id":space["id"],"space_name":space["name"],"title":t["labels"]["sixfold.title"],"cwd":t["cwd"],"turn":t["turn"],"slept":true});
    if truth(&t["labels"]["sixfold.sleep.new"]) {
        v["no_resume"] = json!(true)
    }
    v
}
pub fn inspect(space: &Value, snapshot: &Value, a: &mut dyn Adapter, c: &Value) -> Result<Value> {
    let mut i = json!({"id":space["id"],"name":space["name"],"reasons":[],"safe":false});
    let status = &snapshot["status"];
    if !arr(&focus(status)).iter().all(truth) || truth(&status["errors"]) {
        push(&mut i, "app focus/health unverified")
    }
    if fixed(space, c) {
        push(&mut i, "fixed workspace")
    }
    if space["id"] == status["space"] || truth(&space["active"]) {
        push(&mut i, "currently visible workspace")
    }
    if !space["machine"].is_null() {
        push(&mut i, "remote process/input evidence unavailable")
    }
    if truth(&i["reasons"]) {
        return Ok(i);
    }
    let addresses: BTreeSet<String> = arr(&space["tabs"])
        .iter()
        .flat_map(|tab| arr(&tab["terminals"]))
        .map(|t| s(&t["terminal"]).into())
        .collect();
    if addresses.is_empty() {
        push(&mut i, "no observable agent terminals")
    }
    let (mut evidence, mut screens, mut sessions_v, mut empty) = (vec![], vec![], vec![], vec![]);
    for address in &addresses {
        let t = &snapshot["terminals"][address];
        if truth(&snapshot["lookup_errors"][address]) {
            push(
                &mut i,
                format!(
                    "{address}: lookup failed: {}",
                    s(&snapshot["lookup_errors"][address])
                ),
            );
            continue;
        }
        if t.is_null() {
            push(&mut i, format!("{address}: terminal evidence unavailable"));
            continue;
        }
        let slept = slept_session(t, space);
        if !slept.is_null() {
            sessions_v.push(slept.clone());
            evidence.push(json!([address, t["pid"], "slept", slept["session_id"]]));
            continue;
        }
        let app = s(&t["status"]["app"]);
        let state = s(&t["status"]["state"]);
        if truth(&t["reported"]) && sessions::AGENTS.contains(&app) && state == "blocked" {
            push(
                &mut i,
                format!("{address}: user decision pending (blocked agent)"),
            )
        }
        if !truth(&t["reported"])
            || !sessions::AGENTS.contains(&app)
            || !["done", "idle"].contains(&state)
        {
            push(
                &mut i,
                format!("{address}: not a confirmed idle/done agent"),
            );
            continue;
        }
        let children = snapshot["terminals"].as_object().is_some_and(|o| {
            o.values()
                .any(|t| t["parent"] == *address && t["state"] == "live")
        });
        if children {
            push(&mut i, format!("{address}: live subagent terminals"))
        }
        let (valid, why, pids) = sessions::process_evidence(t, &snapshot["processes"]);
        if !valid {
            push(&mut i, format!("{address}: {why}"))
        }
        if valid && !children && a.empty(t, c) {
            let text = a.screen(address)?;
            if empty_prompt(&text, app) || claude_suggestion(&text, app, a, address) {
                empty.push(address.clone());
                evidence.push(json!([
                    address,
                    t["pid"],
                    "empty",
                    t["created_ms"],
                    hash(text.as_bytes())
                ]));
                continue;
            }
        }
        let (jobs_ok, jobs_reason, jobs_fp) = a.backend(t, c, valid);
        let child = if jobs_reason.contains("inherited child session") {
            a.child(t)?
        } else {
            Value::Null
        };
        if !(jobs_ok || !child.is_null() && valid) {
            push(&mut i, format!("{address}: {jobs_reason}"))
        }
        let text = a.screen(address)?;
        if background_running(&text) {
            push(
                &mut i,
                format!("{address}: in progress: a monitor or background shell is still running"),
            )
        } else if decision_pending(&text) {
            push(&mut i, format!("{address}: user decision pending"))
        }
        if !empty_prompt(&text, app) && !claude_suggestion(&text, app, a, address) {
            push(&mut i, format!("{address}: empty input unverified"))
        }
        let mapping = a.mapping(t, c).unwrap_or(Value::Null);
        let selected = if truth(&mapping["session_id"]) {
            mapping
        } else {
            child
        };
        if truth(&selected["session_id"]) {
            let mut session = json!({"address":address,"app":app,"session_id":selected["session_id"],"space_id":space["id"],"space_name":space["name"],"title":t["title"],"cwd":t["cwd"],"turn":t["turn"],"status_ms":t["status_ms"],"answered_report":last_prompt_is_report_request(&text)});
            if truth(&selected["no_resume"]) {
                session["no_resume"] = json!(true)
            }
            sessions_v.push(session);
        } else {
            push(
                &mut i,
                format!("{address}: session id unverified (harness record impossible)"),
            )
        }
        evidence.push(json!([
            address,
            t["pid"],
            t["status_ms"],
            t["turn"],
            pids,
            jobs_fp,
            hash(text.as_bytes())
        ]));
        screens.push(text);
    }
    let mut folders = BTreeSet::new();
    if let Some(o) = snapshot["terminals"].as_object() {
        for (address, t) in o {
            if addresses.contains(address) && truth(&t["cwd"]) {
                folders.insert(s(&t["cwd"]).to_string());
            }
        }
    }
    if truth(&space["folder"]) {
        folders.insert(s(&space["folder"]).to_string());
    }
    i["safe"] = json!(!truth(&i["reasons"]));
    i["fingerprint"] = json!(fingerprint(&json!(evidence)));
    i["answered_report"] =
        json!(!screens.is_empty() && screens.iter().all(|t| last_prompt_is_report_request(t)));
    i["folders"] = json!(folders);
    i["summary"] = json!(take(
        &screens
            .iter()
            .map(|t| tail(t, 8))
            .collect::<Vec<_>>()
            .join("\n"),
        2400
    ));
    i["sessions"] = json!(sessions_v);
    i["empty_panes"] = json!(empty);
    Ok(i)
}
pub fn close_gate_blockers(i: &Value, a: &mut dyn Adapter, c: &Value) -> Vec<String> {
    if c["close_gate"]["enabled"] == false {
        return vec![];
    }
    if !a.has_close_gate() {
        return vec!["close gate unavailable".into()];
    }
    let mut out = vec![];
    for session in arr(&i["sessions"]) {
        let address = s(&session["address"]);
        if !truth(&session["session_id"]) {
            out.push(format!("{address}: no session id for the harness gate"));
            continue;
        }
        if let Err(e) = a.close_gate(c, &session) {
            out.push(format!("{address}: {}", take(&e.to_string(), 300)))
        }
    }
    out
}
pub fn archive_of(
    space: &Value,
    parked: &[Value],
    snap: &Value,
    a: &mut dyn Adapter,
) -> Result<Value> {
    let machine = a.machine()?;
    let mut tabs = vec![];
    for tab in arr(&space["tabs"]) {
        let mut panes = vec![];
        for t in arr(&tab["terminals"]) {
            let address = s(&t["terminal"]);
            let session = parked
                .iter()
                .find(|i| i["address"] == address)
                .cloned()
                .unwrap_or(json!({}));
            let term = &snap["terminals"][address];
            let cwd = if truth(&session["cwd"]) {
                session["cwd"].clone()
            } else {
                term["cwd"].clone()
            };
            let git = if truth(&session["git"]) {
                session["git"].clone()
            } else {
                a.git(s(&cwd))
            };
            let mut pane = json!({"address":address,"agent":if truth(&session["app"]){session["app"].clone()}else{t["app"].clone()},"cwd":cwd,"last_state":if truth(&session["slept"]){json!("slept")}else{t["status"].clone()},"git":git});
            if truth(&session["no_resume"]) {
                pane["no_transcript"] = json!(true)
            } else if truth(&session["session_id"]) {
                pane["session_id"] = session["session_id"].clone()
            }
            if truth(&session["title"]) {
                pane["title"] = json!(take(s(&session["title"]), 120));
            }
            panes.push(pane);
        }
        tabs.push(json!({"name":tab["name"],"panes":panes}));
    }
    Ok(
        json!({"workspace_id":format!("{}-{}",machine,s(&space["id"]).split('/').next_back().unwrap_or("")),"name":space["name"],"space_id":space["id"],"folder":space["folder"],"tabs":tabs,"reason":"unused: every pane idle/done/slept and reported"}),
    )
}
pub fn git_info(folder: &str) -> Value {
    let mut v = json!({"folder":folder});
    for (key, args) in [
        ("branch", strings(&["branch", "--show-current"])),
        ("commits", strings(&["log", "-3", "--oneline"])),
        ("remaining_uncommitted", strings(&["status", "--short"])),
        ("worktrees", strings(&["worktree", "list", "--porcelain"])),
    ] {
        let mut argv = strings(&["git", "-C", folder]);
        argv.extend(args);
        v[key] = json!(match command(&argv, 12., false) {
            Ok(t) => take(t.trim(), 16000),
            Err(e) => format!("unverified: {e}"),
        });
    }
    v
}
pub fn record_space(i: &Value, dir: &Path, at: f64, terms: &[String]) -> Result<String> {
    let stamp = chrono::DateTime::from_timestamp(at as i64, 0)
        .ok_or_else(|| std::io::Error::other("invalid time"))?
        .with_timezone(&chrono::Local);
    let name = sessions::mask_text(s(&i["name"]), terms);
    let name = re(r#"[\\/:*?"<>|\x00-\x1f]"#)
        .replace_all(&name, "-")
        .replace(' ', "-");
    let name = take(&name, 90);
    let name = if name.is_empty() { "workspace" } else { &name };
    let p = dir.join(format!("{}_{name}.md", stamp.format("%Y%m%d")));
    fs::create_dir_all(dir)?;
    let line = format!(
        "\n- 자동 정리 시각: {} · space {}\n",
        stamp.to_rfc3339(),
        s(&i["id"])
    );
    if p.exists() {
        let mut f = OpenOptions::new().append(true).open(&p)?;
        f.write_all(&crate::common::text_bytes(&line))?;
    } else {
        let details: Vec<_> = arr(&i["folders"]).iter().map(|f| git_info(s(f))).collect();
        let body=format!("# {} 자동 정리 기록\n\n- 공간: {}\n{}\n마지막 화면 일부(관측 자료):\n\n{}\n\n폴더·브랜치·최근 커밋·남은 미커밋·worktree 목록(삭제하지 않음):\n\n```json\n{}\n```\n{}",s(&i["name"]),s(&i["id"]),if truth(&i["archive"]){format!("- 하네스 보관: {}\n",s(&i["archive"]))}else{String::new()},s(&i["summary"]).lines().map(|l|format!("> {l}")).collect::<Vec<_>>().join("\n"),crate::common::json_pretty(&json!(details), false),line);
        let mut f = OpenOptions::new().write(true).create_new(true).open(&p)?;
        f.write_all(&crate::common::text_bytes(&sessions::mask_text(
            &body, terms,
        )))?;
    }
    Ok(p.to_string_lossy().into_owned())
}
pub fn cycle(
    a: &mut dyn Adapter,
    c: &Value,
    state: &mut Value,
    now: f64,
    apply: bool,
    only: Option<&str>,
    report_dir: &Path,
) -> Result<Value> {
    let snap = a.snapshot().map_err(|e| {
        std::io::Error::other(format!(
            "SKIP:app/core lookup failed: {}",
            take(&e.to_string(), 200)
        ))
    })?;
    let previous = state["spaces"].clone();
    let gap = sessions::sample_gap(state, now);
    let fresh = gap >= 0. && gap <= num(&c["max_sample_gap_seconds"], 660.);
    let trial = sessions::trial_of(state, now, fresh);
    let approved = truth(&c["user_approved_apply"])
        && c["reviewed_observer_sha256"] == state["observer_sha256"];
    let trial_ok = ((now - num(&trial["started_at"], now) >= num(&c["trial_seconds"], 1800.)
        && num(&trial["samples"], 0.) >= 7.)
        || (approved && num(&trial["samples"], 0.) >= 2.))
        && num(&trial["error_count"], 0.) == 0.;
    let reviewed = approved
        || c["reviewed_dry_run_at"].is_number()
            && num(&c["reviewed_dry_run_at"], 0.)
                >= num(&trial["started_at"], now) + num(&c["trial_seconds"], 1800.)
            && c["reviewed_observer_sha256"] == state["observer_sha256"];
    let mut reports = if state["reports"].is_object() {
        state["reports"].clone()
    } else {
        json!({})
    };
    let mut tracking = json!({});
    let mut results = vec![];
    for space in arr(&snap["spaces"]) {
        if only.is_some_and(|id| !id.is_empty() && space["id"] != id) {
            continue;
        }
        let id = s(&space["id"]);
        let mut i=inspect(&space,&snap,a,c).unwrap_or_else(|e|json!({"id":id,"name":space["name"],"safe":false,"reasons":[format!("lookup failed: {}",take(&e.to_string(),160))]}));
        let old = &previous[id];
        if sessions::on_hold(&i) {
            push(&mut i, sessions::LOOKUP_HOLD);
            i["safe"] = json!(false);
            i["action"] = json!("keep");
            i["quiet_seconds"] = json!(if truth(&old["since"]) {
                now - num(&old["since"], now)
            } else {
                0.
            });
            if old.is_object() {
                tracking[id] = old.clone();
            }
            results.push(i);
            continue;
        }
        let same = fresh
            && truth(&i["safe"])
            && (old["fingerprint"] == i["fingerprint"]
                || truth(&old["since"])
                    && truth(&old["fingerprint"])
                    && truth(&i["answered_report"]));
        let since = if same { num(&old["since"], now) } else { now };
        let quiet = now - since;
        i["quiet_seconds"] = json!(quiet);
        i["action"] = json!("keep");
        tracking[id] = json!({"since":since,"fingerprint":i["fingerprint"],"decision_notified_at":num(&old["decision_notified_at"],0.)});
        let manual = truth(&c["_manual"]);
        if truth(&i["safe"]) && (quiet >= num(&c["idle_seconds"], 21600.) || manual) {
            i["action"] = json!("would_close");
            if apply && !truth(&c["space_close_enabled"]) && !manual {
                i["action"] = json!("keep");
                push(
                    &mut i,
                    "space close held: workspaces are kept until the person enables it",
                )
            } else if apply && !trial_ok && !manual {
                i["action"] = json!("keep");
                push(&mut i, "30-minute dry-run review not complete")
            } else if apply && !reviewed && !manual {
                i["action"] = json!("keep");
                push(&mut i, "dry-run review not recorded")
            } else if apply {
                let check = match a.snapshot() {
                    Ok(s) => s,
                    Err(e) => {
                        i["action"] = json!("keep");
                        push(
                            &mut i,
                            format!("recheck lookup failed: {}", take(&e.to_string(), 160)),
                        );
                        results.push(i);
                        continue;
                    }
                };
                let target = arr(&check["spaces"]).into_iter().find(|s| s["id"] == id);
                if target.is_none() {
                    i["action"] = json!("keep");
                    push(&mut i, "space changed before close")
                } else if check["status"]["space"] == id {
                    i["action"] = json!("keep");
                    push(&mut i, "the person is viewing this space")
                } else {
                    let target = target.unwrap();
                    let latest = inspect(&target, &check, a, c).unwrap_or_else(|e| {
                        let reason =
                            format!("recheck lookup failed: {}", take(&e.to_string(), 160));
                        push(&mut i, reason.clone());
                        json!({"safe":false,"reasons":[reason]})
                    });
                    if !truth(&latest["safe"]) || latest["fingerprint"] != i["fingerprint"] {
                        i["action"] = json!("keep");
                        push(&mut i, "evidence changed before close")
                    } else {
                        let mut waiting = vec![];
                        let mut sessions_v = arr(&i["sessions"]);
                        for session in &mut sessions_v {
                            if truth(&session["slept"]) {
                                continue;
                            }
                            let (decision, detail) =
                                sessions::report_gate(&mut reports, session, a, c, now)?;
                            if decision == "ready" {
                                session["report_task_id"] = detail["task_id"].clone()
                            } else if decision != "off" {
                                waiting.push(format!(
                                    "{}: {decision}{}",
                                    s(&session["address"]),
                                    if detail.is_string() {
                                        format!(" ({})", s(&detail))
                                    } else {
                                        String::new()
                                    }
                                ))
                            }
                        }
                        i["sessions"] = json!(sessions_v);
                        if !waiting.is_empty() {
                            i["action"] = json!("keep");
                            push(&mut i, format!("close report: {}", waiting.join("; ")));
                            results.push(i);
                            continue;
                        }
                        let held = close_gate_blockers(&i, a, c);
                        if !held.is_empty() {
                            i["action"] = json!("keep");
                            push(&mut i, format!("harness close gate: {}", held.join("; ")));
                            results.push(i);
                            continue;
                        }
                        let mut parked = vec![];
                        let mut records = vec![];
                        let mut refused = None;
                        for mut session in arr(&i["sessions"]) {
                            session["git"] = a.git(s(&session["cwd"]));
                            if !truth(&session["session_id"]) {
                                records.push(json!("no session id: archived only"));
                                parked.push(session);
                                continue;
                            }
                            match a.park(
                                c,
                                &session,
                                "close_requested",
                                false,
                                "space closed: idle and finished",
                            ) {
                                Ok(d) => {
                                    records.push(d);
                                    parked.push(session)
                                }
                                Err(e) => {
                                    refused = Some(format!("{}: {e}", s(&session["address"])));
                                    break;
                                }
                            }
                        }
                        i["harness"] = json!(records);
                        if refused.is_some() || parked.is_empty() {
                            i["action"] = json!("keep");
                            push(
                                &mut i,
                                format!(
                                    "harness record failed: {}",
                                    refused.unwrap_or("no session".into())
                                ),
                            );
                            results.push(i);
                            continue;
                        }
                        let archive = archive_of(&space, &parked, &check, a)
                            .and_then(|data| a.archive(c, &data));
                        match archive {
                            Ok(d) => i["archive"] = d,
                            Err(e) => {
                                i["action"] = json!("keep");
                                push(&mut i, format!("harness archive failed: {e}"));
                                results.push(i);
                                continue;
                            }
                        }
                        i["record"] =
                            json!(record_space(&i, report_dir, now, &sessions::denylist(c))?);
                        let before = a.snapshot()?["status"].clone();
                        if before["space"] == id {
                            i["action"] = json!("keep");
                            push(&mut i, "the person is viewing this space");
                            results.push(i);
                            continue;
                        }
                        let mut enabled = c.clone();
                        if manual {
                            enabled["space_close_enabled"] = json!(true)
                        }
                        a.close_space(id, &enabled)?;
                        let after = a.snapshot()?;
                        if arr(&after["spaces"]).iter().any(|s| s["id"] == id) {
                            return err("space.close not confirmed");
                        }
                        if focus(&after["status"]) != focus(&before) {
                            return err("focus changed after close; further cleanup stopped");
                        }
                        i["action"] = json!("closed");
                        tracking.as_object_mut().unwrap().remove(id);
                        for session in parked {
                            if truth(&session["session_id"]) {
                                // This is a best-effort final record after the
                                // confirmed close. Python ignores its (ok,
                                // detail) result; an error must not discard the
                                // completed cycle and its other observations.
                                let _ = a.park(c, &session, "closed", false, "space closed");
                            }
                        }
                    }
                }
            }
        } else if truth(&i["safe"]) {
            push(&mut i, "idle/output-stable observation window incomplete")
        }
        if i["action"] == "would_close" && !apply {
            let mut checks = vec![];
            for mut session in arr(&i["sessions"]) {
                session["git"] = a.git(s(&session["cwd"]));
                checks.push(match a.park(c, &session, "close_requested", true, "") {
                    Ok(d) => json!([true, d]),
                    Err(e) => json!([false, e.to_string()]),
                });
            }
            i["harness_check"] = json!(checks);
        }
        if apply
            && trial_ok
            && reviewed
            && arr(&i["reasons"])
                .iter()
                .any(|r| s(r).contains("user decision pending"))
            && truth(&c["notify_terminal"])
            && now - num(&old["decision_notified_at"], 0.) >= 86400.
        {
            a.request_report(s(&c["notify_terminal"]),&format!("[자동 정리 보류·사용자 결정 필요] {}: 승인/확인 대기 문구가 있어 공간을 유지했습니다. 직접 확인해 주세요.",s(&i["name"])))?;
            tracking[id]["decision_notified_at"] = json!(now);
        }
        results.push(i);
    }
    let live: BTreeSet<String> = arr(&snap["spaces"])
        .iter()
        .flat_map(|s| arr(&s["tabs"]))
        .flat_map(|t| arr(&t["terminals"]))
        .map(|t| s(&t["terminal"]).into())
        .collect();
    reports
        .as_object_mut()
        .unwrap()
        .retain(|k, _| live.contains(k));
    state["last_at"] = json!(now);
    state["spaces"] = tracking;
    state["trial"] = trial.clone();
    state["reports"] = reports;
    Ok(
        json!({"at":local_iso(now),"mode":if apply{"apply"}else{"dry-run"},"trial":trial,"trial_ready":trial_ok,"results":results,"focus":focus(&snap["status"])}),
    )
}
pub fn option(args: &[String], key: &str, default: &Path) -> PathBuf {
    option_value(args, key)
        .map(PathBuf::from)
        .unwrap_or_else(|| default.to_owned())
}
pub fn state_dir() -> PathBuf {
    let site =
        load(app_home().join("data/sixfold/site.local.json"), json!({})).unwrap_or(json!({}));
    expand(
        site["state_dir"]
            .as_str()
            .unwrap_or("~/Library/Application Support/HerdrSixfold"),
    )
}
pub fn observer_hash() -> Result<String> {
    Ok(env!("HERDR_CLEANUP_SOURCE_SHA256").to_owned())
}
pub fn report_dir(site: &Value, user_home: &Path) -> PathBuf {
    let value = site["reports_dir"]
        .as_str()
        .unwrap_or("~/Documents/HerdrReports");
    let folder = if value == "~" {
        user_home.to_owned()
    } else if let Some(rest) = value.strip_prefix("~/") {
        user_home.join(rest)
    } else {
        PathBuf::from(value)
    };
    folder.join("워크스페이스-기록")
}
pub fn finish(
    state_path: &Path,
    log: &Path,
    state: &Value,
    observation: &Value,
    sleep: bool,
) -> Result<()> {
    save(state_path, state)?;
    if let Some(p) = log.parent() {
        fs::create_dir_all(p)?;
    }
    if fs::metadata(log)
        .map(|m| m.len() > 8 * 1024 * 1024)
        .unwrap_or(false)
    {
        fs::rename(log, log.with_extension("previous.jsonl"))?;
    }
    let mut output = observation.clone();
    if sleep {
        for i in output["results"].as_array_mut().into_iter().flatten() {
            if let Some(o) = i.as_object_mut() {
                o.remove("screen_tail");
            }
        }
    }
    let mut f = OpenOptions::new().create(true).append(true).open(log)?;
    f.write_all(&crate::common::text_bytes(&format!(
        "{}\n",
        crate::common::json_text(&output, false)
    )))?;
    private(log)?;
    let mut brief = observation.clone();
    brief["results"] = json!(arr(&observation["results"])
        .iter()
        .map(|r| {
            let mut v = json!({});
            for key in if sleep {
                vec![
                    "address",
                    "space_name",
                    "action",
                    "reasons",
                    "quiet_seconds",
                ]
            } else {
                vec!["id", "name", "action", "reasons", "quiet_seconds"]
            } {
                v[key] = r[key].clone()
            }
            v
        })
        .collect::<Vec<_>>());
    crate::common::print(&brief)?;
    if observation.get("error").is_some() {
        return Err(Box::new(crate::common::CliError {
            code: 1,
            message: String::new(),
        }));
    }
    Ok(())
}
pub fn main(args: &[String]) -> Result<()> {
    use crate::locking::FileLock;
    let normalized = normalize_args(
        args,
        &[
            "--config",
            "--state",
            "--log",
            "--report-dir",
            "--app",
            "--core",
            "--only-space",
        ],
        &["--dry-run", "--apply", "--now"],
    )?;
    let args = normalized.as_slice();
    if has_flag(args, "--help") {
        crate::help::show("close_finished_spaces", args)?;
        return Ok(());
    }
    let apply = apply_mode(args)?;
    let base = state_dir();
    let config_path = option(args, "--config", &base.join("close-finished-spaces.json"));
    let mut c = load(config_path, Value::Null)?;
    if !c.is_object() || !(truth(&c["fixed_names"]) || truth(&c["fixed_spaces"])) {
        return arg_error("explicit fixed workspace configuration required");
    }
    if num(&c["idle_seconds"], 600.) <= 0. || num(&c["trial_seconds"], 1800.) < 1800. {
        return arg_error("idle_seconds must be positive; live trial minimum is 1800 seconds");
    }
    let only = option_value(args, "--only-space");
    let state_path = option(
        args,
        "--state",
        &base.join("close-finished-spaces-state.json"),
    );
    fs::create_dir_all(state_path.parent().unwrap_or(Path::new(".")))?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(state_path.with_extension("lock"))?;
    if lock.try_lock_exclusive().is_err() {
        crate::common::print(
            &json!({"action":"skip","reason":"another cleanup observer is running"}),
        )?;
        return Ok(());
    }
    if has_flag(args, "--now") {
        if !apply || !only.is_some_and(|value| !value.is_empty()) {
            return arg_error("--now needs --apply and --only-space");
        }
        c["_manual"] = json!(true)
    }
    let mut st = load(&state_path, json!({}))?;
    let hash = observer_hash()?;
    if st["observer_sha256"] != hash {
        st = json!({"observer_sha256":hash})
    }
    let default_app =
        crate::common::find_executable("herdr-app").unwrap_or_else(|| "herdr-app".into());
    let default_core = crate::common::find_executable("herdr-core")
        .or_else(|| crate::common::find_executable("hc"))
        .unwrap_or_else(|| "hc".into());
    let app = option(args, "--app", &default_app)
        .to_string_lossy()
        .into_owned();
    let core = option(args, "--core", &default_core)
        .to_string_lossy()
        .into_owned();
    let report = option(
        args,
        "--report-dir",
        &report_dir(&crate::common::site(), &home()),
    );
    let mut a = Live { app, core };
    let observation = match cycle(&mut a, &c, &mut st, now(), apply, only, &report) {
        Ok(v) => {
            sessions::settle_trial(&mut st, &c, true);
            v
        }
        Err(e) if e.to_string().starts_with("SKIP:") => {
            st["held_at"] = json!(now());
            json!({"at":local_iso(now()),"mode":if apply{"apply"}else{"dry-run"},"skipped":e.to_string().trim_start_matches("SKIP:"),"results":[]})
        }
        Err(e) => {
            sessions::settle_trial(&mut st, &c, false);
            json!({"at":local_iso(now()),"mode":if apply{"apply"}else{"dry-run"},"error":e.to_string(),"results":[]})
        }
    };
    finish(
        &state_path,
        &option(args, "--log", &base.join("close-finished-spaces.jsonl")),
        &st,
        &observation,
        false,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_input_and_footer() {
        assert!(empty_prompt("text\n›\nGPT-6\n? for shortcuts", "codex"));
        assert!(!empty_prompt("›\nwrapped typed text", "codex"));
        assert!(!empty_prompt("› write code", "codex"));
    }
    #[test]
    fn decisions_exclude_observer_and_auto_mode() {
        assert!(!decision_pending("Blocked by auto mode: awaiting approval"));
        assert!(!decision_pending("기억함 승인 대기"));
        assert!(decision_pending("Do you want to proceed?"));
        assert!(background_running("· 1 monitor still running"));
    }
    #[test]
    fn fixed_identity_is_machine_bound() {
        assert!(fixed(
            &json!({"name":"share"}),
            &json!({"fixed_names":["Share"]})
        ));
        assert!(!fixed(
            &json!({"id":"s","machine":"a"}),
            &json!({"fixed_spaces":[{"id":"s","machine":"b"}]})
        ));
    }
}
