//! The microphone state each pane header shows (sixfold-desk `mic.js`).
//!
//! One small record, `<app home>/data/sixfold/voice-mic.json`, rewritten only when a
//! pane's state, its reason, or the last dropped dictation changes:
//!
//! ```json
//! {"schema":1,
//!  "panes":{"app:t3":{"agent":"claude","state":"recording","since":1731200000000}},
//!  "dropped":{"pane":"app:t3","cause":"other","chars":12,"at":1731200004000}}
//! ```
//!
//! `state` is `recording`, `paused` (reason `headset`, `front` or `muted`) or `off`
//! (reason `not_ready` or `key_ignored`). A pane with no entry has no microphone
//! watcher. `dropped.cause` is `other` (another person's voice), `unknown` (the voice
//! was not judged) or `headset` (own voice on a non-headset input).
use super::*;
use std::path::PathBuf;

/// How long a dropped dictation stays in the record before the watcher clears it.
pub const DROP_SHOWN: f64 = 8.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mic {
    Recording,
    Paused(&'static str),
    Off(&'static str),
}
impl Mic {
    pub fn parts(self) -> (&'static str, Option<&'static str>) {
        match self {
            Mic::Recording => ("recording", None),
            Mic::Paused(reason) => ("paused", Some(reason)),
            Mic::Off(reason) => ("off", Some(reason)),
        }
    }
}

/// What a watcher tells the record. `None` removes the pane.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    State(Option<Mic>),
    Dropped { cause: &'static str, chars: usize },
    ClearDropped,
}

pub fn path() -> PathBuf {
    settings::app_home().join("data/sixfold/voice-mic.json")
}

fn base(record: &Value) -> Value {
    let mut next = if record.is_object() {
        record.clone()
    } else {
        json!({})
    };
    next["schema"] = json!(1);
    if !next["panes"].is_object() {
        next["panes"] = json!({});
    }
    next
}

/// Apply one change for `pane`. Returns the new record, or `None` when nothing a
/// viewer can see would change (so the file is not rewritten).
pub fn apply(
    record: &Value,
    pane: &str,
    agent: &str,
    change: &Change,
    at_ms: f64,
) -> Option<Value> {
    let mut next = base(record);
    match change {
        Change::State(None) => {
            let panes = next["panes"].as_object_mut().unwrap();
            let removed = panes.remove(pane).is_some();
            let dropped = next["dropped"]["pane"] == pane;
            if dropped {
                next.as_object_mut().unwrap().remove("dropped");
            }
            if !removed && !dropped {
                return None;
            }
        }
        Change::State(Some(mic)) => {
            let (state, reason) = mic.parts();
            let old = &record["panes"][pane];
            if old["state"] == state && old["reason"].as_str() == reason && old["agent"] == agent {
                return None;
            }
            let mut entry = json!({"agent":agent,"state":state,"since":at_ms.round()});
            if let Some(reason) = reason {
                entry["reason"] = json!(reason);
            }
            next["panes"][pane] = entry;
        }
        Change::Dropped { cause, chars } => {
            next["dropped"] = json!({"pane":pane,"cause":cause,"chars":chars,"at":at_ms.round()});
        }
        Change::ClearDropped => {
            if record["dropped"]["pane"] != pane {
                return None;
            }
            next.as_object_mut().unwrap().remove("dropped");
        }
    }
    Some(next)
}

/// Replace every entry of `agent` with `states` (the Codex guard sees all its panes at once).
pub fn replace_agent(
    record: &Value,
    agent: &str,
    states: &BTreeMap<String, Mic>,
    at_ms: f64,
) -> Option<Value> {
    let mut next = base(record);
    let mut changed = false;
    let stale: Vec<String> = next["panes"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(id, e)| e["agent"] == agent && !states.contains_key(*id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        next["panes"].as_object_mut().unwrap().remove(&id);
        changed = true;
    }
    for (id, mic) in states {
        if let Some(updated) = apply(&next, id, agent, &Change::State(Some(*mic)), at_ms) {
            next = updated;
            changed = true;
        }
    }
    changed.then_some(next)
}

/// Drop entries whose watcher is gone, so a crashed watcher never leaves a pane "recording".
pub fn prune<F: Fn(&str, &Value) -> bool>(record: &Value, agent: &str, alive: F) -> Option<Value> {
    let mut next = base(record);
    let dead: Vec<String> = next["panes"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(id, e)| e["agent"] == agent && !alive(id, e))
        .map(|(id, _)| id.clone())
        .collect();
    if dead.is_empty() {
        return None;
    }
    for id in &dead {
        next["panes"].as_object_mut().unwrap().remove(id);
        if next["dropped"]["pane"] == id.as_str() {
            next.as_object_mut().unwrap().remove("dropped");
        }
    }
    Some(next)
}

/// Read, change and write the record under one lock; the file is untouched when nothing changed.
pub fn update<F: FnOnce(&Value) -> Option<Value>>(change: F) -> Result<()> {
    let dir = settings::state_dir();
    fs::create_dir_all(&dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("voice-mic.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    let target = path();
    if let Some(next) = change(&settings::read_file(&target)) {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        super::super::replace_json(&target, &target.with_extension("json.tmp"), &next)?;
    }
    Ok(())
}

pub fn publish(pane: &str, agent: &str, change: Change) {
    let at = now() * 1000.;
    if let Err(e) = update(|record| apply(record, pane, agent, &change, at)) {
        log(&format!("mic state not written for {pane}: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_visible_change_rewrites_the_record() {
        let one = apply(
            &json!({}),
            "a",
            "claude",
            &Change::State(Some(Mic::Recording)),
            1000.,
        )
        .unwrap();
        assert_eq!(
            one["panes"]["a"],
            json!({"agent":"claude","state":"recording","since":1000.})
        );
        assert_eq!(
            apply(
                &one,
                "a",
                "claude",
                &Change::State(Some(Mic::Recording)),
                2000.
            ),
            None
        );
        let paused = apply(
            &one,
            "a",
            "claude",
            &Change::State(Some(Mic::Paused("headset"))),
            3000.,
        )
        .unwrap();
        assert_eq!(paused["panes"]["a"]["reason"], "headset");
        assert_eq!(
            apply(
                &paused,
                "a",
                "claude",
                &Change::State(Some(Mic::Paused("headset"))),
                4000.
            ),
            None
        );
        assert!(apply(
            &paused,
            "a",
            "claude",
            &Change::State(Some(Mic::Paused("front"))),
            4000.
        )
        .is_some());
        let gone = apply(&paused, "a", "claude", &Change::State(None), 5000.).unwrap();
        assert_eq!(gone["panes"], json!({}));
        assert_eq!(
            apply(&gone, "a", "claude", &Change::State(None), 6000.),
            None
        );
    }
    #[test]
    fn a_drop_is_kept_until_its_pane_clears_it() {
        let rec = apply(
            &json!({}),
            "a",
            "claude",
            &Change::State(Some(Mic::Recording)),
            1.,
        )
        .unwrap();
        let dropped = apply(
            &rec,
            "a",
            "claude",
            &Change::Dropped {
                cause: "other",
                chars: 7,
            },
            2.,
        )
        .unwrap();
        assert_eq!(
            dropped["dropped"],
            json!({"pane":"a","cause":"other","chars":7,"at":2.})
        );
        assert_eq!(
            apply(&dropped, "b", "claude", &Change::ClearDropped, 3.),
            None,
            "another pane leaves it"
        );
        assert!(apply(&dropped, "a", "claude", &Change::ClearDropped, 3.)
            .unwrap()
            .get("dropped")
            .is_none());
        assert!(apply(&dropped, "a", "claude", &Change::State(None), 3.)
            .unwrap()
            .get("dropped")
            .is_none());
    }
    #[test]
    fn codex_entries_are_replaced_together_and_dead_watchers_pruned() {
        let rec = apply(
            &json!({}),
            "c1",
            "claude",
            &Change::State(Some(Mic::Recording)),
            1.,
        )
        .unwrap();
        let states = BTreeMap::from([("x1".to_owned(), Mic::Paused("muted"))]);
        let with = replace_agent(&rec, "codex", &states, 2.).unwrap();
        assert_eq!(with["panes"]["x1"]["state"], "paused");
        assert_eq!(
            with["panes"]["c1"]["state"], "recording",
            "Claude entries stay"
        );
        assert_eq!(replace_agent(&with, "codex", &states, 3.), None);
        let none = replace_agent(&with, "codex", &BTreeMap::new(), 4.).unwrap();
        assert!(none["panes"].get("x1").is_none());
        assert_eq!(prune(&none, "claude", |_, _| true), None);
        assert_eq!(
            prune(&none, "claude", |_, _| false).unwrap()["panes"],
            json!({})
        );
    }
}
