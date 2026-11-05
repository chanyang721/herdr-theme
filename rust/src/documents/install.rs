use super::{catalog::*, common::*, pins};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};
const GENERATED: &[&str] = &["gpui-kit.d.ts", "herdr.d.ts", "jsconfig.json", ".DS_Store"];
pub fn source_payload(source: &Path, relative: &Path) -> Result<Vec<u8>> {
    let bytes = fs::read(source)?;
    let rel = relative.to_string_lossy().replace('\\', "/");
    if rel == "mods/system-metrics/main.js" {
        let text = String::from_utf8(bytes)?;
        let pattern = regex::Regex::new(
            r#"exec\(\s*['"]python3?['"]\s*,\s*\[\s*`\$\{appHome\(\)\}/mods/system-metrics/sample\.py`\s*\]\s*\)"#,
        )?;
        let replacement = r#"exec(`${appHome()}/scripts/sixfold/herdr-theme${/^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome())?'.exe':''}`,['pinned_system_metrics'])"#;
        let text = pattern
            .replace_all(&text, regex::NoExpand(replacement))
            .into_owned();
        if text.contains("sample.py") {
            return Err(
                "Pinned system metrics Python invocation could not be adapted safely".into(),
            );
        }
        Ok(text.into_bytes())
    } else if suffix(relative) == ".js"
        && [
            "mods/agent-usage/",
            "mods/plan-usage/",
            "mods/cli-status/",
            "mods/mcp-status/",
        ]
        .iter()
        .any(|p| rel.starts_with(p))
    {
        let mut text = String::from_utf8(bytes)?;
        let pattern = regex::Regex::new(r#"exec\(\s*['"]python3?['"]\s*,\s*"#)?;
        if pattern.is_match(&text) {
            text = pattern
                .replace_all(&text, "sixfoldNativeHelper(")
                .into_owned();
            for (path, command) in [
                ("agent-usage/collect.py", "pinned_agent_usage"),
                ("agent-usage/scan_insights.py", "pinned_scan_insights"),
                ("plan-usage/usage.py", "pinned_plan_usage"),
                ("plan-usage/resets.py", "pinned_codex_resets"),
                ("cli-status/status.py", "pinned_cli_status"),
                ("mcp-status/status.py", "pinned_mcp_status"),
            ] {
                text = text.replace(
                    &format!("`${{appHome()}}/mods/{path}`"),
                    &format!("'{command}'"),
                );
            }
            if regex::Regex::new(r#"/mods/[^`'"\s]+\.py"#)?.is_match(&text) {
                return Err(format!("Unadapted pinned Python helper in {rel}").into());
            }
            text.push_str(r#"
function sixfoldNativeHelper(args) { return exec(`${appHome()}/scripts/sixfold/herdr-theme${/^(?:[A-Za-z]:[\\/]|\\\\)/.test(appHome())?'.exe':''}`, args); }
"#);
        }
        Ok(text.into_bytes())
    } else {
        Ok(bytes)
    }
}
pub fn native_name() -> &'static str {
    if cfg!(windows) {
        "herdr-theme.exe"
    } else {
        "herdr-theme"
    }
}
pub fn install_binary(app: &Path) -> Result<()> {
    let src = std::env::current_exe()?;
    let dst = app.join("scripts/sixfold").join(native_name());
    if resolved(&src) != resolved(&dst) {
        atomic_bytes(&dst, &fs::read(src)?)?;
        chmod(dst, 0o755)?
    }
    install_notices(app)
}
pub fn install_notices(app: &Path) -> Result<()> {
    for (name, bytes) in crate::notices::files() {
        atomic_bytes(
            app.join("scripts/sixfold/native-licenses").join(name),
            bytes,
        )?;
    }
    Ok(())
}
pub fn read_pin(repo: &Path) -> Result<Value> {
    let pin = read_json(repo.join("workspace-mods.lock.json"))?;
    let commit = s(&pin["commit"]);
    if commit.len() != 40
        || !commit
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err("workspace-mods.lock.json: commit must be a full 40-character hash".into());
    }
    let mods = pin["mods"]
        .as_object()
        .filter(|x| !x.is_empty())
        .ok_or("workspace-mods.lock.json: mods must name each mod and its folder in the release")?;
    for (name, folder) in mods {
        let path = Path::new(s(folder));
        if path.is_absolute()
            || path.components().any(|x| x.as_os_str() == "..")
            || filename(name) != *name
            || name.is_empty()
        {
            return Err(
                format!("workspace-mods.lock.json: unsafe mod entry {name:?}: {folder:?}").into(),
            );
        }
    }
    Ok(pin)
}
fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    Ok(
        String::from_utf8_lossy(&checked(command("git").arg("-C").arg(cwd).args(args))?.stdout)
            .trim()
            .to_owned(),
    )
}
pub fn checkout(pin: &Value, source: Option<&Path>) -> Result<PathBuf> {
    let commit = s(&pin["commit"]);
    let root = source.map(Path::to_owned).unwrap_or_else(|| {
        user_home()
            .join(".local/share/herdr-sixfold/vendor/herdr-workspace-mods")
            .join(&commit[..12])
    });
    if source.is_none() && !root.join(".git").exists() {
        let parent = root.parent().unwrap();
        fs::create_dir_all(parent)?;
        let stage = tempfile::Builder::new()
            .prefix(".tmp-")
            .tempdir_in(parent)?;
        checked(
            command("git")
                .args([
                    "clone",
                    "--filter=blob:none",
                    "--no-checkout",
                    s(&pin["repository"]),
                ])
                .arg(stage.path()),
        )?;
        git(stage.path(), &["fetch", "--depth", "1", "origin", commit])?;
        git(stage.path(), &["checkout", "--detach", commit])?;
        if let Err(error) = fs::rename(stage.path(), &root) {
            if !root.join(".git").exists() {
                return Err(error.into());
            }
        }
    }
    let head = git(&root, &["rev-parse", "HEAD"])?;
    if head != commit {
        return Err(format!(
            "{} is at {}, not the pinned {}",
            root.display(),
            &head[..head.len().min(12)],
            &commit[..12]
        )
        .into());
    }
    if !git(&root, &["status", "--porcelain"])?.is_empty() {
        return Err(format!(
            "{} has local changes; refusing to install from it",
            root.display()
        )
        .into());
    }
    Ok(root)
}
pub fn pinned_files(
    repo: &Path,
    source: Option<&Path>,
) -> Result<(Value, PathBuf, Vec<(PathBuf, PathBuf)>)> {
    let pin = read_pin(repo)?;
    let root = checkout(&pin, source)?;
    let mut files = vec![];
    for (name, folder) in pin["mods"].as_object().unwrap() {
        let folder = s(folder);
        let tracked = git(
            &root,
            &[
                "ls-tree",
                "-r",
                "--name-only",
                s(&pin["commit"]),
                "--",
                folder,
            ],
        )?;
        if !tracked
            .lines()
            .any(|line| line == format!("{folder}/mod.json"))
        {
            return Err(format!("Pinned release has no mod at {folder}").into());
        }
        for line in tracked.lines() {
            let rel = Path::new(line).strip_prefix(folder)?;
            let path = root.join(line);
            if ([
                "system-metrics",
                "agent-usage",
                "plan-usage",
                "cli-status",
                "mcp-status",
            ]
            .contains(&name.as_str())
                && suffix(&path) == ".py")
                || !path.is_file()
                || symlink(&path)
                || GENERATED.contains(&filename(&path).as_str())
                || rel.components().any(|p| {
                    ["__pycache__", ".cache", "node_modules"]
                        .contains(&p.as_os_str().to_string_lossy().as_ref())
                })
            {
                continue;
            }
            files.push((path, Path::new("mods").join(name).join(rel)))
        }
    }
    Ok((pin, root, files))
}
pub fn record(app: &Path, pin: &Value) -> Result<()> {
    let mods = pin["mods"].as_object().unwrap().keys().collect::<Vec<_>>();
    atomic_json(
        app.join("data/sixfold/workspace-mods.json"),
        &json!({"repository":pin["repository"],"tag":pin["tag"],"commit":pin["commit"],"mods":mods}),
    )?;
    Ok(())
}
fn has_files(node: &Value) -> bool {
    node["id"] == "files" || arr(&node["children"]).iter().any(has_files)
}
pub fn has_files_layout(app: &Path) -> Option<String> {
    let mut paths = fs::read_dir(app.join("layouts"))
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| suffix(p) == ".json")
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .find_map(|p| read_json(&p).ok().filter(has_files).map(|_| stem(p)))
}
pub fn base_install(
    repo: &Path,
    app: &Path,
    update: bool,
    extra: &[(PathBuf, PathBuf)],
) -> Result<()> {
    let configuration_migrations = super::migration::prepare(repo, app)?;
    let manifest_path = app.join("data/sixfold/install-manifest.json");
    let mut manifest = if manifest_path.exists() {
        read_json(&manifest_path)?
    } else {
        json!({})
    };
    if !manifest.is_object() {
        return Err("Invalid install manifest".into());
    }
    let mut files = vec![];
    for folder in ["layouts", "themes", "mods"] {
        for entry in walkdir::WalkDir::new(repo.join(folder)).sort_by_file_name() {
            let entry = entry?;
            if entry.file_type().is_file() && !GENERATED.contains(&filename(entry.path()).as_str())
            {
                let rel = entry.path().strip_prefix(repo)?;
                let dst = app.join(rel);
                if folder == "themes"
                    && ["atom-one-dark.json", "win98.json"]
                        .contains(&filename(entry.path()).as_str())
                    && dst.exists()
                {
                    continue;
                }
                files.push((entry.path().to_owned(), dst));
            }
        }
    }
    for (src, rel) in extra {
        files.push((src.clone(), app.join(rel)))
    }
    let binary = std::env::current_exe()?;
    files.push((binary, app.join("scripts/sixfold").join(native_name())));
    let keyfile = app.join("keys.json");
    let original = if keyfile.exists() {
        text(&keyfile)?
    } else {
        "{}".into()
    };
    let mut existing: Value = serde_json::from_str(&original)?;
    if !existing.is_object() {
        return Err("keys.json must be an object".into());
    }
    let fragment = read_json(repo.join("keys.json"))?;
    if !update {
        for (name, _) in crate::notices::files() {
            let target = app.join("scripts/sixfold/native-licenses").join(name);
            if target.exists() {
                return Err(format!(
                    "Already exists; refusing to overwrite: {}",
                    target.display()
                )
                .into());
            }
        }
        for (_, dst) in &files {
            if dst.exists() {
                return Err(
                    format!("Already exists; refusing to overwrite: {}", dst.display()).into(),
                );
            }
        }
        for section in fragment.as_object().unwrap().keys() {
            if existing.get(section).is_some() {
                return Err(format!("Key section already exists: {section}").into());
            }
        }
    }
    for (k, v) in fragment.as_object().unwrap() {
        if existing.get(k).is_none() {
            existing[k] = v.clone()
        }
    }
    let mut selected = vec![];
    for (src, dst) in files {
        let rel = dst.strip_prefix(app)?.to_string_lossy().replace('\\', "/");
        if update
            && dst.exists()
            && (rel.starts_with("layouts/") || rel.starts_with("themes/"))
            && manifest[&rel] != hash(fs::read(&dst)?)
        {
            continue;
        }
        manifest[&rel] = json!(hash(source_payload(&src, Path::new(&rel))?));
        selected.push((src, dst))
    }
    fs::create_dir_all(app)?;
    let stage = tempfile::Builder::new()
        .prefix(".sixfold-install-")
        .tempdir_in(app)?;
    let mods = selected
        .iter()
        .filter_map(|(_, dst)| {
            dst.strip_prefix(app.join("mods"))
                .ok()
                .and_then(|p| p.iter().next())
                .map(|x| x.to_string_lossy().into_owned())
        })
        .collect::<BTreeSet<_>>();
    for name in mods {
        let target = app.join("mods").join(&name);
        let pairs = selected
            .iter()
            .filter(|(_, dst)| dst.starts_with(&target))
            .collect::<Vec<_>>();
        if pairs
            .iter()
            .all(|(src, dst)| fs::read(src).ok() == fs::read(dst).ok())
        {
            continue;
        }
        let staged = stage.path().join(&name);
        if target.exists() {
            copy_tree(&target, &staged, &[])?
        } else {
            fs::create_dir_all(&staged)?
        }
        for (src, dst) in pairs {
            atomic_bytes(
                staged.join(dst.strip_prefix(&target)?),
                &source_payload(src, dst.strip_prefix(app)?)?,
            )?;
        }
        fs::create_dir_all(target.parent().unwrap())?;
        let previous = stage.path().join(format!("{name}.previous"));
        if target.exists() {
            fs::rename(&target, &previous)?
        }
        if let Err(error) = fs::rename(&staged, &target) {
            if previous.exists() {
                fs::rename(&previous, &target)?
            }
            return Err(error.into());
        }
    }
    for (src, dst) in selected {
        if dst.starts_with(app.join("mods")) {
            continue;
        }
        atomic_bytes(&dst, &fs::read(src)?)?;
        if filename(&dst) == native_name() {
            chmod(&dst, 0o755)?
        }
    }
    let old: Value = serde_json::from_str(&original)?;
    if old != existing {
        let backup = app.join("keys.json.before-sixfold");
        if keyfile.exists() && !backup.exists() {
            atomic_bytes(&backup, original.as_bytes())?;
        }
        atomic_json(&keyfile, &existing)?;
    }
    install_notices(app)?;
    for (name, bytes) in crate::notices::files() {
        manifest[format!("scripts/sixfold/native-licenses/{name}")] = json!(hash(bytes));
    }
    atomic_json(&manifest_path, &manifest)?;
    super::migration::apply(configuration_migrations)?;
    Ok(())
}
pub fn cli(args: &[String]) -> Result<()> {
    let repo = option(args, "--repo")
        .map(expand)
        .unwrap_or_else(repo_default);
    let app = option(args, "--home").map(expand).unwrap_or_else(app_home);
    let release = if !has(args, "--without-workspace-mods") {
        Some(pinned_files(
            &repo,
            option(args, "--workspace-mods-source")
                .map(expand)
                .as_deref(),
        )?)
    } else {
        None
    };
    base_install(
        &repo,
        &app,
        has(args, "--update"),
        release.as_ref().map(|x| x.2.as_slice()).unwrap_or(&[]),
    )?;
    println!("Installed Herdr Theme in {}", app.display());
    if let Some((pin, checkout, _)) = release {
        record(&app, &pin)?;
        println!(
            "With Herdr Workspace Mods {}: {}",
            pin["tag"].as_str().unwrap_or(&s(&pin["commit"])[..12]),
            pin["mods"]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        );
        if !app.join("mods/sixfold-docs").exists() && !app.join("mods/sixfold-files").exists() {
            if let Some(layout) = has_files_layout(&app) {
                let mut preview_args = vec!["--layout".into(), layout];
                if !cfg!(target_os = "macos") {
                    preview_args.push("--markdown-only".into())
                }
                if let Err(error) = preview_from_pinned(&checkout, &app, &preview_args) {
                    eprintln!("Document viewer was not installed ({error}); the rest of the install is done.")
                }
            } else {
                println!(
                    "Document viewer: no layout with a Files panel yet (start Herdr once). Later:"
                );
                println!(
                    "  HERDR_APP_HOME={:?} herdr-theme install-preview --layout '<layout>'",
                    app
                )
            }
        }
    }
    println!(
        "herdr-app check {}",
        app.join("mods/sixfold-desk").display()
    );
    println!("herdr-app do layout.switch --name sixfold");
    Ok(())
}
pub fn seed_workspace_pins(args: &[String]) -> Result<()> {
    let app = option(args, "--home").map(expand).unwrap_or_else(app_home);
    let target = app.join("data/sixfold/workspace-pins.local.json");
    if target.exists() {
        println!("Preserved existing workspace pins");
        return Ok(());
    }
    fs::create_dir_all(target.parent().unwrap())?;
    let lock_path = target.parent().unwrap().join("workspace-pins-seed.lock");
    fs::create_dir(&lock_path).map_err(|_| {
        format!(
            "Another workspace seed is running; check {}",
            lock_path.display()
        )
    })?;
    let result = (|| -> Result<bool> {
        if target.exists() {
            return Ok(false);
        }
        let executable = std::env::var("HERDR_APP_BIN").unwrap_or_else(|_| "herdr-app".into());
        let call = |argv: &[&str]| -> Result<Value> {
            let output = checked(command(&executable).args(argv).env("HERDR_APP_HOME", &app))?;
            if output.stdout.is_empty() {
                Ok(json!({}))
            } else {
                Ok(serde_json::from_slice(&output.stdout)?)
            }
        };
        let spaces = |value: Value| -> Result<Vec<Value>> {
            value["spaces"]
                .as_array()
                .cloned()
                .ok_or_else(|| "herdr-app ls did not return a spaces array".into())
        };
        let mut available = spaces(call(&["ls"])?)?;
        let mut original = None;
        let mut pins = vec![];
        for name in arr(&site_config(None, Some(&app))["fixed_space_names"]) {
            let name = s(&name);
            let matching = |list: &[Value]| {
                list.iter()
                    .filter(|space| {
                        space["machine"].is_null()
                            && fold(s(&space["name"])) == fold(name)
                            && space["id"].as_str().is_some_and(|s| !s.is_empty())
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            };
            let mut matches = matching(&available);
            if matches.is_empty() {
                if !has(args, "--ensure-spaces") {
                    return Err(format!(
                        "Missing workspace {name}; use --ensure-spaces to create it"
                    )
                    .into());
                }
                if original.is_none() {
                    original = Some(call(&["status"])?)
                }
                let created = call(&["do", "space.new", "--name", name, "--machine", ""]);
                let original = original.as_ref().unwrap();
                if let Some(space) = original["space"].as_str().filter(|s| !s.is_empty()) {
                    call(&["do", "space.select", "--id", space])?;
                }
                if let Some(pane) = original["focused_pane"].as_str().filter(|s| !s.is_empty()) {
                    call(&["do", "pane.focus", "--pane", pane])?;
                }
                created?;
                available = spaces(call(&["ls"])?)?;
                matches = matching(&available);
                if matches.is_empty() {
                    return Err(
                        format!("Created workspace {name} is absent from herdr-app ls").into(),
                    );
                }
            }
            pins.push(json!({"id":matches[0]["id"],"machine":null}))
        }
        let mut output = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let mut bytes = serde_json::to_vec_pretty(&json!({"spaces":pins}))?;
        bytes.push(b'\n');
        output.write_all(&bytes)?;
        Ok(true)
    })();
    let _ = fs::remove_dir(&lock_path);
    println!(
        "{}",
        if result? {
            "Seeded workspace pins"
        } else {
            "Preserved existing workspace pins"
        }
    );
    Ok(())
}
pub fn set_workspace_icon(args: &[String]) -> Result<()> {
    let values = positionals(args, &["--tint"]);
    let workspace = values.first().ok_or("workspace required")?;
    let source = resolved(Path::new(values.get(1).ok_or("image required")?).canonicalize()?);
    let ext = suffix(&source);
    if ![".svg", ".png", ".jpg", ".jpeg", ".webp"].contains(&ext.as_str()) {
        return crate::common::usage("use SVG, PNG, JPEG or WebP");
    }
    let data = app_home().join("data/sixfold");
    let name = format!("{}{}", &hash(fs::read(&source)?)[..16], ext);
    let target = data.join("icons").join(&name);
    if source != resolved(&target) {
        copy_file(&source, &target)?
    }
    let path = data.join("workspace-icons.json");
    let mut icons = if path.exists() {
        read_json(&path)?
    } else {
        json!({})
    };
    icons[workspace] =
        json!({"path":format!("data/sixfold/icons/{name}"),"tint":has(args,"--tint")});
    if let Some(background) = option(args, "--background").filter(|s| !s.is_empty()) {
        icons[workspace]["background"] = json!(background)
    }
    atomic_bytes(&path, icon_json(&icons).as_bytes())?;
    chmod(path, 0o600)?;
    println!("Updated local icon: {workspace}");
    Ok(())
}
// json.dumps(ensure_ascii=False) uses spaces after commas/colons and no final LF.
// Existing unrelated icon settings retain their original JSON value and order.
fn icon_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(icon_json).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(items) => format!(
            "{{{}}}",
            items
                .iter()
                .map(|(k, v)| format!("{}: {}", serde_json::to_string(k).unwrap(), icon_json(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Number(n) if n.is_f64() => crate::automation::format::repr(value),
        _ => serde_json::to_string(value).unwrap(),
    }
}
fn readable(path: &Path) -> bool {
    !symlink(path) && !is_archived(path) && fs::read_to_string(path).is_ok()
}
pub fn file_pin(path: &Path, label: Option<&str>) -> Option<Value> {
    let path = absolute(path);
    if !readable(&path) {
        return None;
    }
    let name = nfc(&filename(&path));
    let regex = regex::Regex::new(r"^(?:\d{8}|\d{4}-\d{2}-\d{2})[_ -]+(.+)$").unwrap();
    let topic = regex.captures(&name).map(|c| c[1].to_owned());
    let mut value = json!({"id":format!("pin-{}",&hash(path.to_string_lossy().as_bytes())[..16]),"label":label.map(str::to_owned).unwrap_or_else(||topic.clone().unwrap_or_else(||stem(&path)))});
    if let Some(topic) = topic {
        value["kind"] = json!("latest");
        value["root"] = json!(path.parent());
        value["topic"] = json!(topic);
        value["recursive"] = json!(false)
    } else {
        value["kind"] = json!("file");
        value["path"] = json!(path)
    }
    Some(value)
}
pub fn seed_space(space: &Value, project: &Value, repo: &Path, user: &Path, site: &Value) -> Value {
    let name = s(&space["name"]);
    let settings = project["spaces"]
        .get(s(&space["id"]))
        .or_else(|| project["spaces"].get(name))
        .cloned()
        .unwrap_or(json!({}));
    let mut folders = arr(&settings["folders"]);
    let mut sources: Vec<(PathBuf, Option<String>)> = vec![];
    if let Some(local) = site["doc_tabs"].get(name).filter(|v| v.is_object()) {
        for item in arr(&local["sources"]) {
            sources.push((
                expand_home(s(&item["path"]), user),
                item["label"].as_str().map(str::to_owned),
            ))
        }
        for item in arr(&local["topics"]) {
            let root = expand_home(s(&item["root"]), user);
            let mut matches = fs::read_dir(root)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    suffix(p) == ".md"
                        && nfc(&filename(p)).ends_with(s(&item["suffix"]))
                        && readable(p)
                })
                .collect::<Vec<_>>();
            matches.sort_by_key(|p| nfc(&filename(p)));
            if let Some(path) = matches.pop() {
                sources.push((path, item["label"].as_str().map(str::to_owned)))
            }
        }
        if folders.is_empty() {
            folders = arr(&local["folders"])
                .into_iter()
                .map(|mut e| {
                    if e.is_string() {
                        json!(expand_home(s(&e), user))
                    } else {
                        e["path"] = json!(expand_home(s(&e["path"]), user));
                        e
                    }
                })
                .collect()
        }
    } else if name == "Herdr" {
        sources = vec![
            (repo.join("README.ko.md"), Some("Herdr 사용 안내".into())),
            (
                repo.join("docs/project-documents.md"),
                Some("문서 관리".into()),
            ),
        ];
        if folders.is_empty() {
            folders.push(json!(repo.join("docs")))
        }
    } else if name == "Voice" {
        let folder = PathBuf::from(s(&space["folder"]));
        sources.push((folder.join("README.md"), Some("음성·포커스 대기열".into())));
        if folders.is_empty() && folder.is_absolute() {
            folders.push(json!(folder))
        }
    } else if is_hub(space, site) {
        sources = vec![
            (
                repo.join("COMMON_ROUTING.md"),
                Some("프로젝트 작업 전달".into()),
            ),
            (repo.join("README.ko.md"), Some("Herdr 사용 안내".into())),
        ];
        if folders.is_empty() {
            folders.push(json!(repo.join("docs")))
        }
    } else {
        let folder = PathBuf::from(s(&space["folder"]));
        if folder.is_absolute() {
            sources.push((folder.join("README.md"), Some("프로젝트 안내".into())));
            if folder.join("docs").is_dir() && folders.is_empty() {
                folders.push(json!(folder.join("docs")))
            }
        }
    }
    let pins = sources
        .iter()
        .filter_map(|(p, l)| file_pin(p, l.as_deref()))
        .collect::<Vec<_>>();
    json!({"name":name,"folders":folders,"pins":pins,"recent":{"days":14,"limit":6,"keywords":["결정","확인요청","확인 요청","회신","질의","검토결과","decision","reply"]},"excluded":[]})
}
pub fn seed_config(
    document: &Value,
    existing: &Value,
    project: &Value,
    repo: &Path,
    user: &Path,
    site: &Value,
) -> Result<Value> {
    let mut output = existing.clone();
    if output["version"] != 1 || !output["spaces"].is_object() {
        return Err("Expected pins version:1 and spaces mapping".into());
    }
    for space in arr(&document["spaces"]) {
        let id = s(&space["id"]);
        if space["machine"].is_null() && !id.contains('/') && output["spaces"].get(id).is_none() {
            output["spaces"][id] = seed_space(&space, project, repo, user, site)
        }
    }
    Ok(output)
}
fn node_has_mod(node: &Value, name: &str) -> bool {
    node["content"]["mod"] == name || arr(&node["children"]).iter().any(|n| node_has_mod(n, name))
}
pub fn ensure_document_tabs(document: &Value, app: &Path) -> (Value, Vec<Value>) {
    let mut result = document.clone();
    let mut added = vec![];
    if let Some(spaces) = result.get_mut("spaces").and_then(Value::as_array_mut) {
        for space in spaces {
            let id = s(&space["id"]).to_owned();
            if !space["machine"].is_null()
                || id.contains('/')
                || arr(&space["tabs"])
                    .iter()
                    .any(|tab| node_has_mod(&tab["root"], "project-docs-tabs"))
            {
                continue;
            }
            let token = hash(&id)[..24].to_owned();
            let binary = app.join("scripts/sixfold").join(native_name());
            let tab = json!({"id":format!("sf-docs-tab-{token}"),"name":"문서","root":{"id":format!("sf-docs-pane-{token}"),"type":"block","content":{"mod":"project-docs-tabs","props":{"spaceId":id,"resolverScript":binary,"installerScript":binary}}}});
            if !space["tabs"].is_array() {
                space["tabs"] = json!([])
            }
            space["tabs"].as_array_mut().unwrap().push(tab.clone());
            added.push(
                json!({"spaceId":id,"name":space["name"].as_str().unwrap_or(""),"tab":tab["id"]}),
            )
        }
    }
    (result, added)
}
pub fn compile_swift(source: &Path, output: &Path, optimize: bool) -> Result<()> {
    let mut sdks = vec![
        PathBuf::from("/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"),
        PathBuf::from("/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"),
    ];
    if let Ok(found) = command("xcrun").arg("--show-sdk-path").output() {
        if found.status.success() {
            sdks.push(PathBuf::from(String::from_utf8_lossy(&found.stdout).trim()))
        }
    }
    let mut errors = vec![];
    let mut seen = BTreeSet::new();
    for sdk in sdks {
        if !sdk.exists() || !seen.insert(sdk.clone()) {
            continue;
        }
        let mut command = command("swiftc");
        if optimize {
            command.arg("-O");
        }
        let out = command
            .arg("-sdk")
            .arg(sdk)
            .arg(source)
            .arg("-o")
            .arg(output)
            .output()?;
        if out.status.success() {
            return Ok(());
        }
        errors.push(String::from_utf8_lossy(&out.stderr).into_owned())
    }
    let detail = errors
        .join("\n")
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Err(format!(
        "A compatible macOS Swift SDK is required for {}.\n{detail}",
        filename(output)
    )
    .into())
}
pub fn copy_feature(repo: &Path, app: &Path) -> Result<()> {
    let source = repo.join("mods/project-docs-tabs");
    checked(command("herdr-app").arg("check").arg(&source))?;
    let tabs = repo.join("mods/sixfold-tabs/main.js");
    if tabs.exists() {
        checked(
            command("herdr-app")
                .arg("check")
                .arg(tabs.parent().unwrap()),
        )?;
    }
    copy_tree(
        source,
        app.join("mods/project-docs-tabs"),
        &[".cache", "gpui-kit.d.ts", "herdr.d.ts", "jsconfig.json"],
    )?;
    if tabs.exists() {
        copy_file(tabs, app.join("mods/sixfold-tabs/main.js"))?
    }
    install_binary(app)?;
    if cfg!(target_os = "macos") {
        let tools = app.join("data/sixfold/doc-tabs");
        fs::create_dir_all(&tools)?;
        if let Err(error) = compile_swift(
            &repo.join("scripts/render_html.swift"),
            &tools.join("render-html"),
            true,
        ) {
            eprintln!(
                "HTML renderer skipped: {}",
                error.to_string().chars().take(300).collect::<String>()
            )
        }
    }
    Ok(())
}
pub fn install_mermaid(repo: &Path, app: &Path, library: &Path) -> Result<()> {
    let library = expand(library.to_string_lossy()).canonicalize()?;
    if filename(&library) != "mermaid.min.js" {
        return Err("Pass the mermaid package file dist/mermaid.min.js".into());
    }
    let tools = app.join("data/sixfold/doc-tabs");
    copy_file(&library, tools.join("mermaid/mermaid.min.js"))?;
    if let Some(parent) = library.parent().and_then(Path::parent) {
        let notice = parent.join("LICENSE");
        if notice.exists() {
            copy_file(notice, tools.join("mermaid/LICENSE"))?
        }
    }
    compile_swift(
        &repo.join("scripts/render_mermaid.swift"),
        &tools.join("render-mermaid"),
        true,
    )
}
pub fn tabs_cli(args: &[String]) -> Result<()> {
    if has(args, "--install") && has(args, "--ensure-tabs") {
        return Err("--install and --ensure-tabs are mutually exclusive".into());
    }
    let app = absolute(option(args, "--home").map(expand).unwrap_or_else(app_home));
    let repo = option(args, "--repo")
        .map(expand)
        .unwrap_or_else(repo_default);
    if let Some(library) = option(args, "--mermaid") {
        install_mermaid(&repo, &app, &expand(library))?;
        if !has(args, "--install") && !has(args, "--ensure-tabs") {
            println!("{}", json!({"mermaid":true}));
            return Ok(());
        }
    }
    let snapshot = core_call("doc.get", json!({"name":"herdr-app"}))?;
    let (_, added) = ensure_document_tabs(&snapshot["value"], &app);
    if !has(args, "--install") && !has(args, "--ensure-tabs") {
        println!("{}", json!({"dryRun":true,"added":added}));
        return Ok(());
    }
    let data = app.join("data/sixfold");
    let _guard = lock(data.join("doc-tabs-install.lock"), false)?;
    let before = cli_json("herdr-app", &["status"])?;
    if has(args, "--install") {
        copy_feature(&repo, &app)?;
        let config = data.join("project-docs-pins.json");
        let project = json_or(data.join("project-docs.json"), json!({}));
        let _guard = lock(config.with_extension("lock"), false)?;
        let existing = json_or(&config, json!({"version":1,"spaces":{}}));
        atomic_json(
            &config,
            &seed_config(
                &snapshot["value"],
                &existing,
                &project,
                &repo,
                &user_home(),
                &site_config(None, Some(&app)),
            )?,
        )?;
    } else if !app.join("mods/project-docs-tabs/main.js").exists() {
        return Err("Install the checked document mod before ensuring tabs".into());
    }
    let mut added = vec![];
    for attempt in 0..3 {
        let snapshot = core_call("doc.get", json!({"name":"herdr-app"}))?;
        let (planned, current) = ensure_document_tabs(&snapshot["value"], &app);
        added = current;
        if added.is_empty() {
            break;
        }
        match core_call(
            "doc.set",
            json!({"name":"herdr-app","version":snapshot["version"],"value":planned}),
        ) {
            Ok(_) => break,
            Err(error) if attempt == 2 => return Err(error),
            Err(_) => {}
        }
    }
    if !added.is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(400))
    }
    let after = cli_json("herdr-app", &["status"])?;
    let keys = ["space", "tab", "focused_pane"];
    let mut first = json!({});
    let mut last = json!({});
    for key in keys {
        first[key] = before[key].clone();
        last[key] = after[key].clone()
    }
    println!(
        "{}",
        json!({"added":added,"focusBefore":first,"focusAfter":last,"focusUnchanged":keys.iter().all(|k|before[*k]==after[*k])})
    );
    Ok(())
}
pub fn replace_files(node: &mut Value, stack: &Value) -> bool {
    if node["id"] == "files" {
        for k in ["content", "type", "children", "active"] {
            node.as_object_mut().unwrap().remove(k);
        }
        for (k, v) in stack.as_object().unwrap() {
            node[k] = v.clone()
        }
        return true;
    }
    if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
        for child in children {
            if replace_files(child, stack) {
                return true;
            }
        }
    }
    false
}
pub fn preview_cli(args: &[String]) -> Result<()> {
    let app = app_home();
    preview_install(&repo_default(), &app, args, None)
}
pub fn preview_from_pinned(checkout: &Path, app: &Path, args: &[String]) -> Result<()> {
    let root = checkout.join("document-viewer");
    if !root.is_dir() {
        return Err("Pinned document viewer source missing".into());
    }
    preview_install(&root, app, args, Some(&root))
}
pub fn preview_install(
    repo: &Path,
    app: &Path,
    args: &[String],
    pinned: Option<&Path>,
) -> Result<()> {
    let layout = option(args, "--layout").unwrap_or_else(|| "sixfold".into());
    if filename(&layout) != layout || layout == "." || layout == ".." {
        return Err("use a personal layout name".into());
    }
    let layout_path = app.join("layouts").join(format!("{layout}.json"));
    let mut doc = read_json(&layout_path)?;
    if !has_files(&doc) {
        return Err(
            "Choose a personal layout with a Files panel before installing. No files were changed."
                .into(),
        );
    }
    let names = [
        "preview-plus",
        "files-plus",
        "sixfold-docs",
        "sixfold-files",
    ];
    for name in names {
        if app.join("mods").join(name).exists() {
            return Err(
                format!("Preserving existing mod; inspect it before updating: {name}").into(),
            );
        }
    }
    let upstream = option(args, "--source")
        .map(expand)
        .unwrap_or_else(|| user_home().join(".local/share/herdr-sixfold/vendor/herdr-mods"));
    const COMMIT: &str = "089d87d6c5651f9950c68d10612cd8462058b83b";
    const REPOSITORY: &str = "https://github.com/linziyanleo/herdr-mods";
    if !upstream.exists() {
        fs::create_dir_all(upstream.parent().unwrap())?;
        checked(
            command("git")
                .args(["clone", "--filter=blob:none", "--no-checkout", REPOSITORY])
                .arg(&upstream),
        )?;
        git(&upstream, &["fetch", "--depth", "1", "origin", COMMIT])?;
        git(&upstream, &["checkout", "--detach", COMMIT])?;
    }
    if git(&upstream, &["rev-parse", "HEAD"])? != COMMIT {
        return Err(
            "Upstream checkout differs from the reviewed commit; no files installed.".into(),
        );
    }
    if !git(&upstream, &["status", "--porcelain"])?.is_empty() {
        return Err("Upstream has local changes; no files installed.".into());
    }
    let data = app.join("data/sixfold");
    fs::create_dir_all(&data)?;
    let renderer = data.join("html-preview/render-html");
    fs::create_dir_all(renderer.parent().unwrap())?;
    let stage = tempfile::Builder::new()
        .prefix("preview-setup-")
        .tempdir_in(&data)?;
    if cfg!(target_os = "macos") && !has(args, "--markdown-only") {
        compile_swift(
            &repo.join("scripts/render_html.swift"),
            &stage.path().join("render-html"),
            false,
        )?
    }
    for name in ["preview-plus", "files-plus"] {
        copy_tree(
            upstream.join(name).join("mods").join(name),
            stage.path().join(name),
            &[".cache", "gpui-kit.d.ts", "jsconfig.json"],
        )?;
        copy_tree(
            upstream.join(name).join("licenses"),
            stage.path().join(name).join("licenses"),
            &[],
        )?;
        let manifest = stage.path().join(name).join("mod.json");
        let mut metadata = read_json(&manifest)?;
        metadata["place"] = json!("none");
        atomic_json(manifest, &metadata)?;
    }
    for (name, base) in [
        ("sixfold-docs", "preview-plus"),
        ("sixfold-files", "files-plus"),
    ] {
        copy_tree(
            if repo.join("mods").join(name).is_dir() {
                repo.join("mods").join(name)
            } else {
                repo.join("extras/preview/mods").join(name)
            },
            stage.path().join(name),
            &[],
        )?;
        copy_tree(
            upstream.join(base).join("mods").join(base),
            stage.path().join(name).join("upstream"),
            &[".cache", "gpui-kit.d.ts", "jsconfig.json"],
        )?;
        copy_tree(
            upstream.join(base).join("licenses"),
            stage.path().join(name).join("licenses"),
            &[],
        )?
    }
    for name in names {
        checked(
            command("herdr-app")
                .arg("check")
                .arg(stage.path().join(name)),
        )?;
    }
    let mut installed = vec![];
    for name in names {
        let destination = app.join("mods").join(name);
        fs::create_dir_all(destination.parent().unwrap())?;
        if let Err(error) = fs::rename(stage.path().join(name), &destination) {
            for name in installed {
                fs::remove_dir_all(app.join("mods").join(name))?
            }
            return Err(error.into());
        }
        installed.push(name)
    }
    if stage.path().join("render-html").exists() {
        copy_file(
            stage.path().join("render-html"),
            renderer.with_extension("next"),
        )?;
        fs::rename(renderer.with_extension("next"), &renderer)?
    }
    let stack = json!({"id":"files","type":"stack","active":"files-plus-tree","children":[{"id":"files-plus-tree","type":"block","content":{"mod":"sixfold-files","props":{"previewStack":"files"}}},{"id":"preview-plus","type":"block","content":{"mod":"sixfold-docs","props":{"previewStack":"files"}}}]});
    if !replace_files(&mut doc, &stack) {
        return Err(
            "Files block not found; mod files are installed but layout was preserved.".into(),
        );
    }
    copy_file(
        &layout_path,
        layout_path.with_file_name(format!("sixfold.before-preview-{}.backup", now() as u64)),
    )?;
    atomic_json(layout_path, &doc)?;
    atomic_json(
        data.join("preview-install.json"),
        &json!({"repository":REPOSITORY,"commit":COMMIT,"mods":names,"html":renderer.exists()}),
    )?;
    println!(
        "Installed live Markdown preview and local HTML rendering. Existing panes are preserved."
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seed_does_not_replace_existing_rules() {
        let document =
            json!({"spaces":[{"id":"a","name":"Test"},{"id":"remote/a","machine":"remote"}]});
        let existing = json!({"version":1,"spaces":{"a":{"pins":[{"id":"mine"}]}}});
        assert_eq!(
            seed_config(
                &document,
                &existing,
                &json!({}),
                Path::new("/repo"),
                Path::new("/user"),
                &json!({})
            )
            .unwrap(),
            existing
        );
    }
    #[test]
    fn tabs_keep_focus_fields_and_avoid_duplicate() {
        let doc = json!({"spaces":[{"id":"a","name":"A","tabs":[]}],"selected":"a"});
        let (next, added) = ensure_document_tabs(&doc, Path::new("/app"));
        assert_eq!(added.len(), 1);
        assert_eq!(next["selected"], "a");
        assert!(ensure_document_tabs(&next, Path::new("/app")).1.is_empty());
    }
    #[test]
    fn pin_paths_must_be_safe() {
        let t = tempfile::tempdir().unwrap();
        atomic_json(
            t.path().join("workspace-mods.lock.json"),
            &json!({"commit":"a".repeat(40),"mods":{"bad":"../outside"}}),
        )
        .unwrap();
        assert!(read_pin(t.path()).is_err());
    }
}
