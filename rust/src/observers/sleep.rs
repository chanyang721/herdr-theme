use super::*;
use std::collections::{BTreeMap, BTreeSet};
pub const VISIBLE: &str = "shown on screen (visible tab)";
pub const NOT_SHELL: &str = "terminal program is not a shell: the pane would not survive /exit";
pub fn blockers(i: &Value) -> Vec<String> {
    arr(&i["reasons"])
        .iter()
        .map(|r| s(r).to_owned())
        .filter(|r| r != VISIBLE && r != NOT_SHELL)
        .collect()
}
pub fn pane_of(snap: &Value) -> BTreeMap<String, (Value, Value)> {
    let mut out = BTreeMap::new();
    for space in arr(&snap["spaces"]) {
        for tab in arr(&space["tabs"]) {
            for t in arr(&tab["terminals"]) {
                out.insert(s(&t["terminal"]).into(), (space.clone(), tab["id"].clone()));
            }
        }
    }
    out
}
pub fn pane_entry(snap: &Value, address: &str) -> Value {
    for space in arr(&snap["spaces"]) {
        for tab in arr(&space["tabs"]) {
            for t in arr(&tab["terminals"]) {
                if t["terminal"] == address {
                    return t;
                }
            }
        }
    }
    json!({})
}
pub fn pane_id(t: &Value) -> String {
    for k in ["pane", "pane_id", "id"] {
        if truth(&t[k]) {
            return s(&t[k]).into();
        }
    }
    String::new()
}
pub fn space_panes(snap: &Value, space_id: &str) -> Vec<(String, Value)> {
    arr(&snap["spaces"])
        .iter()
        .filter(|s| s["id"] == space_id)
        .flat_map(|s| arr(&s["tabs"]))
        .flat_map(|tab| {
            arr(&tab["terminals"])
                .into_iter()
                .map(move |t| (s(&t["terminal"]).into(), tab["id"].clone()))
        })
        .collect()
}
pub fn close_blocker(
    i: &Value,
    snap: &Value,
    tab: &Value,
    closed: &BTreeSet<String>,
) -> Option<String> {
    let panes: Vec<_> = space_panes(snap, s(&i["space_id"]))
        .into_iter()
        .filter(|(a, _)| !closed.contains(a))
        .collect();
    let address = s(&i["address"]);
    if !panes.iter().any(|(a, _)| a != address) {
        return Some("last pane in its space".into());
    }
    if !panes.iter().any(|(a, t)| t == tab && a != address) {
        return Some("last pane in its tab".into());
    }
    if pane_id(&pane_entry(snap, address)).is_empty() {
        return Some("pane id unavailable".into());
    }
    None
}
pub fn focused_terminal(snap: &Value) -> String {
    let pane = s(&snap["status"]["focused_pane"]);
    if !pane.is_empty() {
        for (a, _) in pane_of(snap) {
            let entry = pane_entry(snap, &a);
            if ["pane", "id", "pane_id"].iter().any(|k| entry[*k] == pane) {
                return a;
            }
        }
    }
    String::new()
}
pub fn in_float(address: &str, status: &Value) -> bool {
    let shown = json!([status["floats"], status["overlays"]]).to_string();
    let escaped = regex::escape(address);
    let pattern = format!(r"(?:^|[^\w/]){}(?:$|[^\w])", escaped);
    re(&pattern).is_match(&shown)
}
pub fn on_screen(address: &str, space: &Value, tab: &Value, status: &Value) -> bool {
    space["id"] == status["space"] && (tab.is_null() || tab == &status["tab"])
        || in_float(address, status)
}
pub fn inspect(
    address: &str,
    space: &Value,
    snap: &Value,
    a: &mut dyn Adapter,
    c: &Value,
    tab: &Value,
) -> Result<Value> {
    let status = &snap["status"];
    let t = &snap["terminals"][address];
    let mut i =
        json!({"address":address,"space_id":space["id"],"space_name":space["name"],"reasons":[]});
    if !arr(&spaces::focus(status)).iter().all(truth) || truth(&status["errors"]) {
        spaces::push(&mut i, "app focus/health unverified")
    }
    if arr(&c["exclude_addresses"]).iter().any(|x| x == address) {
        spaces::push(&mut i, "excluded address")
    }
    if on_screen(address, space, tab, status) {
        spaces::push(&mut i, VISIBLE)
    }
    if in_float(address, status) {
        spaces::push(&mut i, "shown in a float or overlay")
    }
    if focused_terminal(snap) == address {
        spaces::push(&mut i, "focused pane")
    }
    if !space["machine"].is_null() {
        spaces::push(&mut i, "remote process/input evidence unavailable")
    }
    if truth(&snap["lookup_errors"][address]) {
        spaces::push(
            &mut i,
            format!("lookup failed: {}", s(&snap["lookup_errors"][address])),
        );
        return Ok(i);
    }
    if t.is_null() {
        spaces::push(&mut i, "terminal evidence unavailable");
        return Ok(i);
    }
    if truth(&t["labels"]["sixfold.sleep"]) {
        i["asleep"] = json!(true);
        spaces::push(&mut i, "already asleep");
        return Ok(i);
    }
    let app = s(&t["status"]["app"]);
    let state = s(&t["status"]["state"]);
    for k in ["title", "cwd", "status_ms", "turn"] {
        i[k] = t[k].clone()
    }
    i["app"] = json!(app);
    let argv = arr(&t["argv"]);
    let shell = Path::new(argv.first().map(s).unwrap_or(""))
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    if !sessions::SHELLS.contains(&shell.as_ref()) {
        spaces::push(&mut i, NOT_SHELL)
    }
    if !truth(&t["reported"])
        || !sessions::AGENTS.contains(&app)
        || !["done", "idle"].contains(&state)
    {
        spaces::push(
            &mut i,
            if state == "blocked" {
                "user decision pending (blocked agent)"
            } else {
                "not a confirmed idle/done agent"
            },
        );
        return Ok(i);
    }
    if !blockers(&i).is_empty() {
        return Ok(i);
    }
    if truth(&pane_entry(snap, address)["sub_agents"]) {
        spaces::push(&mut i, "subagents shown in the pane")
    }
    if snap["terminals"].as_object().is_some_and(|o| {
        o.values()
            .any(|t| t["parent"] == address && t["state"] == "live")
    }) {
        spaces::push(&mut i, "live subagent terminals")
    }
    let (valid, why, pids) = sessions::process_evidence(t, &snap["processes"]);
    if !valid {
        spaces::push(&mut i, why)
    }
    let mapping = a.session_mapping(t, c);
    let why = mapping
        .as_ref()
        .err()
        .map(|e| e.to_string())
        .unwrap_or_default();
    let child = if mapping.is_err() && why.contains("inherited child session") {
        a.child(t)?
    } else {
        Value::Null
    };
    if mapping.is_err() && child.is_null() {
        spaces::push(&mut i, why);
        return Ok(i);
    }
    let m = mapping.unwrap_or(child.clone());
    i["session_id"] = m["session_id"].clone();
    i["argv"] = t["foreground"]["argv"].clone();
    let (jobs_ok, jobs_reason, jobs_fp) = if !child.is_null() {
        i["no_resume"] = json!(true);
        (valid, why, "no-transcript".into())
    } else {
        a.backend(t, c, valid)
    };
    if !jobs_ok {
        spaces::push(&mut i, jobs_reason)
    }
    let text = a.screen(address)?;
    if spaces::background_running(&text) {
        spaces::push(
            &mut i,
            "in progress: a monitor or background shell is still running",
        )
    } else if spaces::decision_pending(&text) {
        spaces::push(&mut i, "user decision pending")
    }
    if re(r"(?i)(?:🎙|🎤|\bListening\b|\brecording\b|녹음\s*중|받아쓰는\s*중|음성\s*입력\s*중)")
        .is_match(&tail(&text, 6))
    {
        spaces::push(&mut i, "voice input active")
    }
    if !spaces::empty_prompt(&text, app) {
        if spaces::claude_suggestion(&text, app, a, address) {
            i["prompt_suggestion"] = json!(true)
        } else {
            spaces::push(&mut i, "input not empty")
        }
    }
    i["screen_tail"] = json!(take(&tail(&text, 12), 2000));
    i["fingerprint"] = json!(fingerprint(&json!([
        address,
        t["pid"],
        t["status_ms"],
        t["turn"],
        pids,
        jobs_fp,
        i["session_id"],
        hash(text.as_bytes())
    ])));
    Ok(i)
}
pub fn note(i: &Value, dir: &Path, at: f64) -> Result<String> {
    let dt = chrono::DateTime::from_timestamp(at as i64, 0)
        .ok_or_else(|| std::io::Error::other("invalid time"))?
        .with_timezone(&chrono::Local);
    let p = dir.join(format!(
        "{}-{}-{}.json",
        dt.format("%Y%m%d"),
        s(&i["address"]),
        take(s(&i["session_id"]), 8)
    ));
    let mut v = json!({});
    for k in [
        "address",
        "space_name",
        "space_id",
        "app",
        "session_id",
        "title",
        "cwd",
        "git",
        "screen_tail",
        "harness",
        "argv",
        "close_report",
    ] {
        v[k] = i[k].clone()
    }
    v["at"] = json!(dt.to_rfc3339());
    save(&p, &v)?;
    Ok(p.to_string_lossy().into_owned())
}
pub fn ticket(i: &Value, dir: &Path, config: Option<&Path>) -> Result<PathBuf> {
    let p = dir.join(format!("{}.json", s(&i["address"])));
    let argv: Vec<_> = arr(&i["argv"]).iter().map(|v| s(v).to_owned()).collect();
    let argv = if truth(&i["no_resume"]) {
        sessions::new_session_argv(s(&i["app"]), &argv)?
    } else {
        sessions::resume_argv(s(&i["app"]), &argv, s(&i["session_id"]))?
    };
    let mut v = json!({"address":i["address"],"app":i["app"],"session_id":i["session_id"],"cwd":i["cwd"],"argv":argv,"new_session":truth(&i["no_resume"]),"title":i["title"].as_str().unwrap_or(""),"space_id":i["space_id"],"space_name":i["space_name"]});
    if let Some(c) = config {
        v["config"] = json!(c.to_string_lossy())
    }
    save(&p, &v)?;
    Ok(p)
}
fn shell_quote(t: &str) -> String {
    if !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c))
    {
        t.into()
    } else {
        format!("'{}'", t.replace('\'', "'\"'\"'"))
    }
}
pub fn wait_for_shell(a: &mut dyn Adapter, address: &str, attempts: usize) -> Result<bool> {
    for _ in 0..attempts {
        a.wait(1.);
        let t = a.terminal(address)?;
        let fg = &t["foreground"];
        let argv = arr(&fg["argv"]);
        let name = Path::new(argv.first().map(s).unwrap_or(""))
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        if sessions::SHELLS.contains(&name.as_ref()) || sessions::SHELLS.contains(&s(&fg["name"])) {
            return Ok(true);
        }
    }
    Ok(false)
}
pub fn sleep_one(
    i: &mut Value,
    a: &mut dyn Adapter,
    c: &Value,
    paths: &Value,
    at: f64,
) -> Result<String> {
    i["git"] = a.git(s(&i["cwd"]));
    match a.park(
        c,
        i,
        "suspended",
        false,
        "idle session suspended to free memory",
    ) {
        Ok(d) => i["harness"] = d,
        Err(e) => {
            spaces::push(i, format!("harness record failed: {e}"));
            return Ok("keep".into());
        }
    }
    i["note"] = json!(note(i, Path::new(s(&paths["notes"])), at)?);
    let config = paths["config"].as_str().map(Path::new);
    let path = ticket(i, Path::new(s(&paths["tickets"])), config)?;
    let address = s(&i["address"]).to_owned();
    let mut keys = "/exit".chars().map(|c| c.to_string()).collect::<Vec<_>>();
    keys.push("enter".into());
    a.keys(&address, &keys)?;
    if !wait_for_shell(a, &address, 20)? {
        let _ = a.park(
            c,
            i,
            "resumed",
            false,
            "sleep aborted: the agent did not exit",
        );
        return err(format!(
            "{address}: agent did not exit after /exit; further sleeps stopped"
        ));
    }
    let exe = if truth(&paths["stub"]) {
        s(&paths["stub"]).to_string()
    } else {
        std::env::current_exe()?.to_string_lossy().into_owned()
    };
    a.type_line(
        &address,
        &format!(
            "{} session-sleep-stub {}",
            shell_quote(&exe),
            shell_quote(&path.to_string_lossy())
        ),
    )?;
    let title = take(s(&i["title"]), 60);
    let mut labels = json!({"sixfold.sleep":format!("{}:{}",sessions::provider(s(&i["app"])),s(&i["session_id"])),"sixfold.title":if title.is_empty(){"절전".into()}else{format!("절전 · {title}")}});
    if truth(&i["no_resume"]) {
        labels["sixfold.sleep.new"] = json!("1")
    }
    a.label(&address, &labels)?;
    Ok("slept".into())
}
pub fn pane_present(snap: &Value, address: &str, pane: &str) -> bool {
    pane_of(snap).contains_key(address)
        || arr(&snap["spaces"])
            .iter()
            .flat_map(|s| arr(&s["tabs"]))
            .flat_map(|t| arr(&t["terminals"]))
            .any(|t| pane_id(&t) == pane)
}
pub fn close_recheck(
    i: &Value,
    a: &mut dyn Adapter,
    c: &Value,
    closed: &BTreeSet<String>,
) -> Result<Vec<String>> {
    let snap = a.snapshot()?;
    let where_ = pane_of(&snap);
    let Some((space, tab)) = where_.get(s(&i["address"])) else {
        return Ok(vec!["pane moved or closed".into()]);
    };
    let latest = inspect(s(&i["address"]), space, &snap, a, c, tab)?;
    let mut why = blockers(&latest);
    if latest["fingerprint"] != i["fingerprint"] {
        why.push("evidence changed".into())
    }
    if space["id"] != i["space_id"] {
        why.push("pane moved to another space".into())
    }
    if let Some(b) = close_blocker(&latest, &snap, tab, closed) {
        why.push(b)
    }
    if pane_id(&pane_entry(&snap, s(&i["address"]))) != pane_id(&i["_pane"]) {
        why.push("pane id changed".into())
    }
    Ok(why)
}
pub fn settle_pending(
    entries: &[Value],
    a: &mut dyn Adapter,
    c: &Value,
    snap: &Value,
    apply: bool,
) -> Vec<Value> {
    let mut left = vec![];
    for e in entries {
        if !apply {
            left.push(e.clone());
            continue;
        }
        let present = e["pending"] == "unconfirmed"
            && pane_present(snap, s(&e["address"]), s(&e["_pane_id"]));
        let (event, reason) = if present {
            ("close_aborted", "pane.close did not close the pane")
        } else {
            ("closed", "pane closed (record retried)")
        };
        if a.park(c, e, event, false, reason).is_err() {
            left.push(e.clone());
        }
    }
    left
}
fn aborted(i: &mut Value, a: &mut dyn Adapter, c: &Value, why: &str) {
    i["harness_abort"] = json!(match a.park(
        c,
        i,
        "close_aborted",
        false,
        &take(&format!("pane close failed: {why}"), 200)
    ) {
        Ok(d) => s(&d).to_string(),
        Err(e) => format!("close_aborted not recorded: {e}"),
    });
}
pub fn close_one(
    i: &mut Value,
    a: &mut dyn Adapter,
    c: &Value,
    paths: &Value,
    at: f64,
    snap: &Value,
    closed: &BTreeSet<String>,
) -> Result<(String, Option<Value>)> {
    let address = s(&i["address"]).to_owned();
    i["_pane"] = pane_entry(snap, &address);
    let pane = pane_id(&i["_pane"]);
    i["git"] = a.git(s(&i["cwd"]));
    match a.park(
        c,
        i,
        "close_requested",
        false,
        "finished harness session: pane closed",
    ) {
        Ok(d) => i["harness"] = d,
        Err(e) => {
            spaces::push(i, format!("harness record failed: {e}"));
            return Ok(("keep".into(), None));
        }
    }
    i["note"] = json!(note(i, Path::new(s(&paths["notes"])), at)?);
    let why = close_recheck(i, a, c, closed)
        .unwrap_or_else(|e| vec![format!("lookup failed: {}", take(&e.to_string(), 120))]);
    if !why.is_empty() {
        let why = why.join("; ");
        aborted(i, a, c, &format!("recheck: {why}"));
        spaces::push(i, format!("recheck before close: {why}"));
        return Ok(("keep".into(), None));
    }
    i["_pane_id"] = json!(pane);
    let failure = a.close_pane(&pane).err().map(|e| take(&e.to_string(), 120));
    let mut after = None;
    for _ in 0..3 {
        match a.snapshot() {
            Ok(s) => {
                after = Some(s);
                break;
            }
            Err(_) => a.wait(1.),
        }
    }
    let Some(after) = after else {
        spaces::push(
            i,
            format!(
                "pane.close outcome unknown (layout unreadable); settled next cycle{}",
                failure
                    .as_ref()
                    .map(|f| format!(" (pane.close: {f})"))
                    .unwrap_or_default()
            ),
        );
        return Ok(("close_unconfirmed".into(), None));
    };
    if pane_present(&after, &address, &pane) {
        aborted(
            i,
            a,
            c,
            &failure
                .as_ref()
                .map(|f| format!("pane.close: {f}"))
                .unwrap_or("pane still present after pane.close".into()),
        );
        return err(format!(
            "{address}: pane still present after pane.close{}; further actions stopped",
            failure.map(|f| format!(" ({f})")).unwrap_or_default()
        ));
    }
    let mut detail = String::new();
    for _ in 0..2 {
        match a.park(c, i, "closed", false, "pane closed") {
            Ok(_) => return Ok(("closed".into(), Some(after))),
            Err(e) => detail = e.to_string(),
        }
    }
    spaces::push(
        i,
        format!("pane closed but the harness closed record failed: {detail}"),
    );
    Ok(("closed_unrecorded".into(), Some(after)))
}
pub fn cycle(
    a: &mut dyn Adapter,
    c: &Value,
    state: &mut Value,
    at: f64,
    apply: bool,
    paths: &Value,
) -> Result<Value> {
    let snap = a.snapshot().map_err(|e| {
        std::io::Error::other(format!(
            "SKIP:app/core lookup failed: {}",
            take(&e.to_string(), 200)
        ))
    })?;
    let previous = state["sessions"].clone();
    let gap = at - num(&state["last_at"], at);
    let fresh = gap >= 0. && gap <= num(&c["max_sample_gap_seconds"], 660.);
    let trial = sessions::trial_of(state, at, fresh);
    let approved = truth(&c["user_approved_apply"])
        && c["reviewed_observer_sha256"] == state["observer_sha256"];
    let ready =
        approved && num(&trial["samples"], 0.) >= 2. && num(&trial["error_count"], 0.) == 0.;
    let idle = num(&c["idle_seconds"], 1200.);
    let report_cfg = &c["close_report"];
    let report_on = report_cfg["enabled"] != false;
    let close_on = report_on && c["close_finished_panes"] != false;
    let collect_after = if report_on {
        num(&report_cfg["collect_after_seconds"], idle)
    } else {
        idle
    };
    let threshold = idle.min(collect_after);
    let mut reports = if state["reports"].is_object() {
        state["reports"].clone()
    } else {
        json!({})
    };
    let panes = pane_of(&snap);
    reports
        .as_object_mut()
        .unwrap()
        .retain(|k, _| panes.contains_key(k));
    let settle = num(&report_cfg["settle_seconds"], 120.);
    let (mut results, mut tracking, mut acted, mut closed) =
        (vec![], json!({}), 0., BTreeSet::new());
    let mut pending = settle_pending(&arr(&state["unrecorded_closes"]), a, c, &snap, apply);
    state["unrecorded_closes"] = json!(pending);
    let mut stop = if pending.is_empty() {
        None
    } else {
        Some(format!(
            "{} closed pane(s) still without a harness record; retried next cycle",
            pending.len()
        ))
    };
    for (address, (space, tab)) in panes {
        let mut i=inspect(&address,&space,&snap,a,c,&tab).unwrap_or_else(|e|json!({"address":address,"space_id":space["id"],"space_name":space["name"],"reasons":[format!("lookup failed: {}",take(&e.to_string(),160))]}));
        let old = &previous[&address];
        let safe = blockers(&i).is_empty();
        let sleepable = !truth(&i["reasons"]);
        let same = fresh && safe && old["fingerprint"] == i["fingerprint"];
        let since = if same { num(&old["since"], at) } else { at };
        let quiet = at - since;
        i["quiet_seconds"] = json!(quiet.round_ties_even() as i64);
        i["action"] = json!(if truth(&i["asleep"]) {
            "asleep"
        } else {
            "keep"
        });
        if safe && (!sleepable && !report_on) {
        } else if safe {
            tracking[&address] = json!({"since":since,"fingerprint":i["fingerprint"]});
            let status_age = (at * 1000. - num(&i["status_ms"], at * 1000.)) / 1000.;
            let asked = reports[&address].clone();
            let answering = asked["session_id"] == i["session_id"]
                && !truth(&asked["failed_at"])
                && quiet >= settle
                && status_age >= settle;
            let idle_ok =
                (quiet >= idle && status_age >= idle) || (answering && asked["idle_ok"] != false);
            let collect =
                report_on && (answering || (quiet >= collect_after && status_age >= collect_after));
            i["close_if_finished"] =
                json!(close_on && close_blocker(&i, &snap, &tab, &closed).is_none());
            if !idle_ok && !collect {
                spaces::push(
                    &mut i,
                    format!(
                        "unchanged for {} of {} minutes",
                        (quiet.min(status_age) / 60.).floor(),
                        (threshold / 60.).floor()
                    ),
                );
            } else if !apply {
                let known = asked["session_id"] == i["session_id"] && truth(&asked["report"]);
                i["action"] = json!(if idle_ok && truth(&i["close_if_finished"]) && known {
                    "would_close"
                } else if idle_ok && sleepable {
                    "would_sleep"
                } else if report_on {
                    "would_collect_report"
                } else {
                    "keep"
                });
                if i["action"] == "would_close" || i["action"] == "would_sleep" {
                    let mut check = i.clone();
                    check["git"] = a.git(s(&i["cwd"]));
                    i["harness_check"] = match a.park(c, &check, "suspended", true, "") {
                        Ok(d) => json!([true, d]),
                        Err(e) => json!([false, e.to_string()]),
                    };
                }
            } else if !ready {
                spaces::push(
                    &mut i,
                    "apply not approved for this observer code (one recorded dry-run first)",
                )
            } else if acted >= num(&c["max_per_cycle"], 4.) {
                spaces::push(&mut i, "per-cycle limit reached")
            } else if let Some(reason) = &stop {
                spaces::push(&mut i, reason.clone())
            } else {
                let checked = (|| -> Result<(Value, Option<(Value, Value)>, Option<Value>)> {
                    let check = a.snapshot()?;
                    let where_ = pane_of(&check).get(&address).cloned();
                    let latest = where_
                        .as_ref()
                        .map(|(sp, tab)| inspect(&address, sp, &check, a, c, tab))
                        .transpose()?;
                    Ok((check, where_, latest))
                })();
                match checked {
                    Err(e) => {
                        spaces::push(
                            &mut i,
                            format!("recheck lookup failed: {}", take(&e.to_string(), 160)),
                        );
                        spaces::push(&mut i, "pane moved or closed before sleep");
                        stop = Some("a recheck lookup failed; next cycle".into())
                    }
                    Ok((check, where_, latest)) => {
                        if let Some(latest) = latest {
                            if !blockers(&latest).is_empty() {
                                spaces::push(
                                    &mut i,
                                    format!("recheck: {}", blockers(&latest).join("; ")),
                                )
                            } else if latest["fingerprint"] != i["fingerprint"] {
                                spaces::push(&mut i, "evidence changed before sleep")
                            } else {
                                let before = spaces::focus(&check["status"]);
                                let sleepable = !truth(&latest["reasons"]);
                                let why_not_close = if close_on {
                                    close_blocker(&latest, &check, &where_.unwrap().1, &closed)
                                } else {
                                    Some("close_finished_panes off".into())
                                };
                                let may_close = idle_ok && why_not_close.is_none();
                                let may_sleep = idle_ok && sleepable;
                                let kept = !may_close && !may_sleep;
                                let (decision, detail) = if kept
                                    && asked["session_id"] == i["session_id"]
                                    && truth(&asked["failed_at"])
                                    && asked["turn"] == i["turn"]
                                {
                                    (
                                        "failed".into(),
                                        json!(
                                            "no close report for this turn: kept, not asked again"
                                        ),
                                    )
                                } else {
                                    sessions::report_gate(&mut reports, &i, a, c, at)?
                                };
                                if ["requested", "ready"].contains(&decision.as_str())
                                    && reports[&address].is_object()
                                    && reports[&address].get("idle_ok").is_none()
                                {
                                    reports[&address]["idle_ok"] =
                                        json!(quiet >= idle && status_age >= idle)
                                }
                                let mut after = None;
                                if decision == "ready" {
                                    i["close_report"] = detail["report_id"].clone();
                                    i["report_task_id"] = detail["task_id"].clone();
                                }
                                if decision == "ready" && may_close {
                                    let (action, snapshot) =
                                        close_one(&mut i, a, c, paths, at, &check, &closed)?;
                                    i["action"] = json!(action);
                                    after = snapshot;
                                } else if ["ready", "off"].contains(&decision.as_str()) && may_sleep
                                {
                                    if decision == "ready" && close_on {
                                        if let Some(why) = &why_not_close {
                                            spaces::push(
                                                &mut i,
                                                format!("{why}: slept instead of closed"),
                                            );
                                        }
                                    }
                                    i["action"] = json!(sleep_one(&mut i, a, c, paths, at)?);
                                } else if decision == "ready" {
                                    i["action"] = json!("reported");
                                    let mut why = vec![];
                                    if close_on {
                                        if let Some(why_) = why_not_close {
                                            why.push(why_)
                                        }
                                    }
                                    why.extend(
                                        arr(&latest["reasons"]).iter().map(|r| s(r).to_string()),
                                    );
                                    if !idle_ok {
                                        why.push("not idle long enough to close or sleep".into())
                                    }
                                    spaces::push(
                                        &mut i,
                                        format!("close report collected; kept: {}", why.join("; ")),
                                    );
                                } else if decision == "off" {
                                    for why in arr(&latest["reasons"]) {
                                        spaces::push(&mut i, s(&why));
                                    }
                                } else {
                                    i["action"] = json!(if decision == "requested" {
                                        "report_requested"
                                    } else {
                                        "keep"
                                    });
                                    spaces::push(
                                        &mut i,
                                        match decision.as_str() {
                                            "requested" => {
                                                "asked the session for its close report".into()
                                            }
                                            "waiting" => {
                                                "waiting for the session close report".into()
                                            }
                                            _ => s(&detail).to_owned(),
                                        },
                                    );
                                }
                                if i["action"] == "closed_unrecorded"
                                    || i["action"] == "close_unconfirmed"
                                {
                                    let mut entry = i.clone();
                                    entry.as_object_mut().unwrap().remove("_pane");
                                    entry.as_object_mut().unwrap().remove("screen_tail");
                                    entry["pending"] =
                                        json!(if i["action"] == "closed_unrecorded" {
                                            "unrecorded"
                                        } else {
                                            "unconfirmed"
                                        });
                                    pending.push(entry);
                                    state["unrecorded_closes"] = json!(pending);
                                    stop=Some("a close is still owed its harness record; settled next cycle".into())
                                }
                                if i["action"] == "close_unconfirmed" {
                                    i.as_object_mut().unwrap().remove("_pane");
                                    i.as_object_mut().unwrap().remove("_pane_id");
                                    results.push(i);
                                    break;
                                }
                                if ["slept", "closed", "closed_unrecorded"]
                                    .contains(&s(&i["action"]))
                                {
                                    acted += 1.;
                                    tracking.as_object_mut().unwrap().remove(&address);
                                    reports.as_object_mut().unwrap().remove(&address);
                                    if i["action"] != "slept" {
                                        closed.insert(address.clone());
                                    }
                                    let after = match after {
                                        Some(v) => v,
                                        None => a.snapshot()?,
                                    };
                                    if focused_terminal(&after) == address {
                                        return err(
                                            "focus moved to the slept pane; further sleeps stopped",
                                        );
                                    }
                                    if spaces::focus(&after["status"]) != before {
                                        stop = Some(
                                            "focus moved during the previous sleep; next cycle"
                                                .into(),
                                        );
                                        i["focus_moved"] = json!(true)
                                    }
                                }
                            }
                        } else {
                            spaces::push(&mut i, "pane moved or closed before sleep")
                        }
                    }
                }
            }
        }
        if let Some(o) = i.as_object_mut() {
            for k in ["argv", "_pane", "_pane_id"] {
                o.remove(k);
            }
        }
        results.push(i);
    }
    state["last_at"] = json!(at);
    state["sessions"] = tracking;
    state["trial"] = trial.clone();
    state["reports"] = reports;
    state["unrecorded_closes"] = json!(pending);
    Ok(
        json!({"at":local_iso(at),"mode":if apply{"apply"}else{"dry-run"},"trial":trial,"apply_ready":ready,"focus":spaces::focus(&snap["status"]),"results":results}),
    )
}
pub fn main(args: &[String]) -> Result<()> {
    use crate::locking::FileLock;
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        crate::help::show("sleep_idle_sessions", args)?;
        return Ok(());
    }
    validate_args(
        args,
        &["--config", "--state", "--log", "--data", "--app", "--core"],
        &["--dry-run", "--apply"],
    )?;
    let base = spaces::state_dir();
    let config_path = spaces::option(args, "--config", &base.join("sleep-idle-sessions.json"));
    let c = load(&config_path, Value::Null)?;
    if !c.is_object() {
        return arg_error("configuration required (see config/sleep-idle-sessions.example.json)");
    }
    if num(&c["idle_seconds"], 1200.) < 300. {
        return arg_error("idle_seconds must be at least 300");
    }
    let apply = args.iter().any(|a| a == "--apply");
    if apply && args.iter().any(|a| a == "--dry-run") {
        return arg_error("--apply and --dry-run are mutually exclusive");
    }
    let state_path = spaces::option(
        args,
        "--state",
        &base.join("sleep-idle-sessions-state.json"),
    );
    fs::create_dir_all(state_path.parent().unwrap_or(Path::new(".")))?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(state_path.with_extension("lock"))?;
    if lock.try_lock_exclusive().is_err() {
        crate::common::print(
            &json!({"action":"skip","reason":"another sleep observer is running"}),
        )?;
        return Ok(());
    }
    let mut st = load(&state_path, json!({}))?;
    let hash = spaces::observer_hash()?;
    if st["observer_sha256"] != hash {
        st = json!({"observer_sha256":hash})
    }
    let app = spaces::option(args, "--app", Path::new("herdr-app"))
        .to_string_lossy()
        .into_owned();
    let core = spaces::option(args, "--core", Path::new("hc"))
        .to_string_lossy()
        .into_owned();
    let data = spaces::option(args, "--data", &base.join("session-sleep"));
    let paths = json!({"notes":data.join("notes").to_string_lossy(),"tickets":data.join("tickets").to_string_lossy(),"stub":std::env::current_exe()?.to_string_lossy(),"config":config_path.to_string_lossy()});
    let mut a = Live { app, core };
    let observation = match cycle(&mut a, &c, &mut st, now(), apply, &paths) {
        Ok(v) => {
            sessions::settle_trial(&mut st, &c, true);
            v
        }
        Err(e) if e.to_string().starts_with("SKIP:") => {
            json!({"at":local_iso(now()),"mode":if apply{"apply"}else{"dry-run"},"skipped":e.to_string().trim_start_matches("SKIP:"),"results":[]})
        }
        Err(e) => {
            sessions::settle_trial(&mut st, &c, false);
            json!({"at":local_iso(now()),"mode":if apply{"apply"}else{"dry-run"},"error":e.to_string(),"results":[]})
        }
    };
    spaces::finish(
        &state_path,
        &spaces::option(args, "--log", &base.join("sleep-idle-sessions.jsonl")),
        &st,
        &observation,
        true,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_tab_keeps_one() {
        let snap = json!({"spaces":[{"id":"s","tabs":[{"id":"a","terminals":[{"terminal":"t1","pane":"p1"}]},{"id":"b","terminals":[{"terminal":"t2","pane":"p2"}]}]}]});
        let i = json!({"space_id":"s","address":"t1"});
        assert_eq!(
            close_blocker(&i, &snap, &json!("a"), &BTreeSet::new()),
            Some("last pane in its tab".into())
        );
    }
    #[test]
    fn shown_tab_blocks_sleep_only() {
        let i = json!({"reasons":[VISIBLE,NOT_SHELL]});
        assert!(blockers(&i).is_empty());
        let i = json!({"reasons":[VISIBLE,"focused pane"]});
        assert_eq!(blockers(&i), vec!["focused pane"]);
    }
    #[test]
    fn float_matches_address_boundary() {
        assert!(in_float("t1", &json!({"floats":{"terminal":"t1"}})));
        assert!(!in_float("t1", &json!({"floats":{"terminal":"other/t1"}})));
    }
}
