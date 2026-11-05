//! Upgrade only pointers whose exact paths identify a helper owned by this theme.
//! A custom script with the same basename or parent-folder names stays external.
use super::{common::*, install};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
#[derive(Clone, Copy)]
pub struct Config {
    pub relative: &'static str,
    pub command: &'static str,
    pub source: &'static str,
    pub installed: Option<&'static str>,
}
pub const CONFIGS: &[Config] = &[
    Config {
        relative: "data/sixfold/routing.json",
        command: "route",
        source: "scripts/route.py",
        installed: Some("scripts/sixfold/route.py"),
    },
    Config {
        relative: "data/sixfold/collaboration.json",
        command: "collaborate",
        source: "scripts/collaborate.py",
        installed: Some("scripts/sixfold/collaborate.py"),
    },
    Config {
        relative: "data/sixfold/voice-integration.json",
        command: "focus_queue",
        source: "voice/focus_queue.py",
        installed: None,
    },
];
fn lexical(path: &Path) -> PathBuf {
    let absolute = absolute(path);
    let mut result = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            part => result.push(part),
        }
    }
    result
}
fn identity(path: &Path) -> String {
    let text = lexical(path).to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}
pub fn rewrite(value: &Value, repo: &Path, app: &Path, spec: Config) -> Option<Value> {
    let script = value["script"].as_str()?;
    let actual = identity(&expand(script));
    // Callers may supply Windows short-name roots while old configs use the
    // canonical long spelling, or vice versa. Only those explicit known-root
    // aliases are owned; do not resolve arbitrary external script pointers.
    let sources = [repo.to_owned(), resolved(repo)];
    let apps = [app.to_owned(), resolved(app)];
    let owned = sources
        .iter()
        .any(|root| actual == identity(&root.join(spec.source)))
        || spec
            .installed
            .is_some_and(|path| apps.iter().any(|root| actual == identity(&root.join(path))));
    if !owned {
        return None;
    }
    let mut result = value.clone();
    let object = result.as_object_mut()?;
    object.remove("script");
    let existing = object.get("command").filter(|v| match v {
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Null | Value::Bool(false) => false,
        _ => true,
    });
    if existing.is_none() {
        object.insert(
            "command".into(),
            json!([
                lexical(&app.join("scripts/sixfold").join(install::native_name())),
                spec.command
            ]),
        );
    }
    Some(result)
}
pub fn rewrite_bytes(bytes: &[u8], repo: &Path, app: &Path, spec: Config) -> Option<Vec<u8>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let changed = rewrite(&value, repo, app, spec)?;
    let mut bytes = serde_json::to_vec_pretty(&changed).ok()?;
    bytes.push(b'\n');
    Some(bytes)
}
pub struct Planned {
    pub path: PathBuf,
    pub original: Vec<u8>,
    pub replacement: Vec<u8>,
    permissions: fs::Permissions,
}
pub fn prepare(repo: &Path, app: &Path) -> Result<Vec<Planned>> {
    let mut plans = vec![];
    for spec in CONFIGS {
        let path = app.join(spec.relative);
        let Ok(original) = fs::read(&path) else {
            continue;
        };
        let Some(replacement) = rewrite_bytes(&original, repo, app, *spec) else {
            continue;
        };
        super::update::check_target(&path, app)?;
        plans.push(Planned {
            permissions: fs::metadata(&path)?.permissions(),
            path,
            original,
            replacement,
        })
    }
    Ok(plans)
}
pub fn apply(plans: Vec<Planned>) -> Result<()> {
    for plan in plans {
        if fs::read(&plan.path)? != plan.original {
            return Err(format!(
                "Configuration changed concurrently; preserved: {}",
                plan.path.display()
            )
            .into());
        }
        atomic_bytes(&plan.path, &plan.replacement)?;
        fs::set_permissions(&plan.path, plan.permissions)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_owned_paths_only_and_native_commands_preserved() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let app = root.path().join("app");
        let spec = CONFIGS[0];
        for path in [
            repo.join("scripts/route.py"),
            app.join("scripts/sixfold/route.py"),
            repo.join("scripts/unused/../route.py"),
        ] {
            let before = json!({"script":path,"enabled":true,"custom":{"kept":1}});
            let after = rewrite(&before, &repo, &app, spec).unwrap();
            assert!(after.get("script").is_none());
            assert_eq!(after["command"][1], "route");
            assert_eq!(after["custom"], before["custom"])
        }
        for path in [
            root.path().join("custom/scripts/route.py"),
            root.path().join("custom/scripts/sixfold/route.py"),
            root.path().join("custom/route.py"),
        ] {
            assert!(rewrite(&json!({"script":path}), &repo, &app, spec).is_none())
        }
        let native = json!({"command":["my-native-helper","route"],"enabled":false});
        assert!(rewrite(&native, &repo, &app, spec).is_none());
        let both = json!({"command":["my-native-helper","route"],"script":repo.join("scripts/route.py"),"enabled":false});
        let after = rewrite(&both, &repo, &app, spec).unwrap();
        assert_eq!(after["command"], both["command"]);
        assert_eq!(after["enabled"], false);
        assert!(after.get("script").is_none());
    }
}
