use super::{catalog::*, common::*, routing};
use chrono::{Duration, Local, NaiveDate};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
pub fn documents(
    folders: &[Value],
    warnings: &mut Vec<String>,
    include_archived: bool,
) -> Vec<Value> {
    let mut found: BTreeMap<String, Value> = BTreeMap::new();
    for entry in folders {
        let root = expand(if entry.is_string() {
            s(entry)
        } else {
            s(&entry["path"])
        });
        // The generic code stays for existing readers; the detailed one names the
        // folder and tells a missing path from a denied one (e.g. macOS privacy).
        let detail = match fs::metadata(&root) {
            Ok(meta) if meta.is_dir() => match fs::read_dir(&root) {
                Ok(_) => None,
                Err(error) => Some(source_problem(&error)),
            },
            Ok(_) => Some("source_not_dir"),
            Err(error) => Some(source_problem(&error)),
        };
        if let Some(code) = detail {
            warnings.push("source_unavailable".into());
            warnings.push(format!("{code}:{}", root.display()));
            continue;
        }
        // `source_empty` means the whole folder was read and nothing matched; a
        // subtree that failed to read may hold the documents, so it never says so.
        let mut matched = 0usize;
        let mut complete = true;
        let filters = if entry["match"].is_string() {
            vec![fold(s(&entry["match"]))]
        } else {
            arr(&entry["match"])
                .iter()
                .map(|v| fold(s(v)))
                .collect::<Vec<_>>()
        };
        let mut walk = walkdir::WalkDir::new(&root).follow_links(false);
        if let Some(depth) = entry["depth"].as_u64().filter(|x| *x > 0) {
            walk = walk.max_depth(depth as usize)
        }
        for next in walk.into_iter().filter_entry(|e| {
            e.depth() == 0
                || !e.file_type().is_dir()
                || !e.file_name().to_string_lossy().starts_with('.')
        }) {
            let entry = match next {
                Ok(x) => x,
                Err(error) => {
                    complete = false;
                    warnings.push("source_unavailable".into());
                    if let (Some(path), Some(io)) = (error.path(), error.io_error()) {
                        warnings.push(format!("{}:{}", source_problem(io), path.display()));
                    }
                    continue;
                }
            };
            let path = entry.path();
            let name = filename(path);
            if !entry.file_type().is_file()
                || symlink(path)
                || !EXTENSIONS.contains(&suffix(path).as_str())
                || name.to_lowercase() == "latest.md"
            {
                continue;
            }
            // `match` terms test the path below the source folder, the same rule
            // `herdr-doc` uses to pick a space, so `보고서/프로젝트/세부/가이드.md`
            // belongs to a `프로젝트` rule even when the file name omits it.
            let relative = path.strip_prefix(&root).unwrap_or(path);
            if !filters.is_empty()
                && !filters
                    .iter()
                    .any(|t| fold(&relative.to_string_lossy()).contains(t))
            {
                continue;
            }
            matched += 1;
            let archived = is_archived(path);
            if archived && !include_archived {
                continue;
            }
            let Ok(meta) = fs::metadata(path) else {
                continue;
            };
            let source = resolved(path);
            found.insert(source.to_string_lossy().into_owned(),json!({"path":source,"name":name,"mtime":mtime(path),"size":meta.len(),"archived":archived,"folder":source.parent(),"sourceRoot":resolved(&root),"relativePath":relative}));
        }
        if matched == 0 && complete {
            warnings.push(format!("source_empty:{}", root.display()));
        }
    }
    let mut values = found.into_values().collect::<Vec<_>>();
    values.sort_by(|a, b| {
        b["mtime"]
            .as_u64()
            .cmp(&a["mtime"].as_u64())
            .then_with(|| s(&a["path"]).cmp(s(&b["path"])))
    });
    values
}
fn source_problem(error: &std::io::Error) -> &'static str {
    match error.kind() {
        std::io::ErrorKind::NotFound => "source_missing",
        std::io::ErrorKind::PermissionDenied => "source_denied",
        _ => "source_unreadable",
    }
}
pub fn owned_links(folder: &Path, items: &[Value]) -> Result<Option<String>> {
    fs::create_dir_all(folder)?;
    let manifest = folder.join(".herdr-document-links.json");
    let previous = match read_json(&manifest) {
        Ok(value) => {
            if value["owner"] != "herdr-project-docs-v1" || !value["links"].is_object() {
                return Ok(Some("manifest_conflict".into()));
            }
            value["links"].clone()
        }
        Err(_) if manifest.exists() => return Ok(Some("manifest_conflict".into())),
        Err(_) => json!({}),
    };
    let mut retained = json!({});
    for (name, source) in previous.as_object().unwrap() {
        if filename(name) != *name || !source.is_string() {
            continue;
        }
        let link = folder.join(name);
        if !symlink(&link) || fs::read_link(&link).ok().as_ref() != Some(&PathBuf::from(s(source)))
        {
            continue;
        }
        if Path::new(s(source)).exists() {
            retained[name] = source.clone()
        } else {
            let _ = fs::remove_file(link);
        }
    }
    for item in items {
        let source = s(&item["path"]);
        if retained
            .as_object()
            .unwrap()
            .values()
            .any(|v| s(v) == source)
        {
            continue;
        }
        let base = s(&item["name"]);
        let mut name = base.to_owned();
        if lexists(folder.join(&name)) {
            name = format!(
                "{}-{}",
                &hash(source)[..12],
                base.chars().take(180).collect::<String>()
            )
        }
        let target = folder.join(&name);
        if create_link(Path::new(source), &target).is_ok() {
            retained[&name] = json!(source)
        }
    }
    atomic_json(
        manifest,
        &json!({"owner":"herdr-project-docs-v1","links":retained}),
    )?;
    Ok(None)
}
pub fn collect(config: &Path, index: &Path, pins: Option<&Path>) -> Result<Value> {
    let data = if config.exists() {
        read_json(config)?
    } else {
        json!({"version":1,"spaces":{}})
    };
    if data["version"] != 1 || !data["spaces"].is_object() {
        return Err("Expected version:1 and spaces mapping".into());
    }
    let mut output = json!({"version":1,"spaces":{}});
    for (space, settings) in data["spaces"].as_object().unwrap() {
        let folders = settings["folders"]
            .as_array()
            .ok_or("folders must be an array")?;
        let site = site_config(None, None);
        let target = settings["target"]
            .as_str()
            .map(expand)
            .unwrap_or_else(|| expand(s(&site["projects_dir"])).join(space));
        let mut warnings = vec![];
        let items = documents(folders, &mut warnings, true);
        let current = items
            .iter()
            .filter(|x| !x["archived"].as_bool().unwrap_or(false))
            .cloned()
            .collect::<Vec<_>>();
        if let Some(problem) = owned_links(&target, &current)? {
            warnings.push(problem)
        }
        let mut result = json!({"folder":resolved(&target),"files":items});
        warnings.sort();
        warnings.dedup();
        if !warnings.is_empty() {
            result["warning"] = json!(warnings.join(","))
        }
        output["spaces"][space] = result
    }
    let rules = pins.map(|p| json_or(p, json!({}))).unwrap_or(json!({}));
    if let Some(spaces) = rules["spaces"].as_object() {
        for (space, settings) in spaces {
            if output["spaces"].get(space).is_some()
                || output["spaces"].get(s(&settings["name"])).is_some()
                || !settings["folders"].is_array()
            {
                continue;
            }
            let mut warnings = vec![];
            let items = documents(&arr(&settings["folders"]), &mut warnings, true);
            let mut result = json!({"folder":"","files":items});
            warnings.sort();
            warnings.dedup();
            if !warnings.is_empty() {
                result["warning"] = json!(warnings.join(","))
            }
            output["spaces"][space] = result
        }
    }
    atomic_json(index, &output)?;
    Ok(output)
}
pub fn collect_cli(args: &[String]) -> Result<()> {
    let base = app_home().join("data/sixfold");
    let config = option(args, "--config")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.join("project-docs.json"));
    let output = option(args, "--output")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.join("project-docs-index.json"));
    let pins = option(args, "--pins")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.join("project-docs-pins.json"));
    if !config.exists() && !pins.exists() {
        return Ok(());
    }
    let _guard = lock(output.with_extension("lock"), false)?;
    let result = collect(&config, &output, Some(&pins))?;
    crate::common::print(
        &(json!({"spaces":result["spaces"].as_object().unwrap().len(),"documents":result["spaces"].as_object().unwrap().values().map(|x|arr(&x["files"]).len()).sum::<usize>()})),
    )?;
    Ok(())
}
pub fn checked_path(value: &str, root: Option<&str>) -> Result<PathBuf> {
    let path = expand(value);
    if !path.is_absolute() || is_archived(&path) || !EXTENSIONS.contains(&suffix(&path).as_str()) {
        return Err("unsupported_path".into());
    }
    if symlink(&path) {
        return Err("symlink_excluded".into());
    }
    if let Some(root) = root {
        let root = expand(root);
        if symlink(&root) || !resolved(&path).starts_with(resolved(&root)) {
            return Err("outside_root".into());
        }
        let relative = absolute(&path)
            .strip_prefix(absolute(&root))
            .map_err(|_| "outside_root")?
            .to_owned();
        let mut cursor = root;
        for component in relative.components() {
            cursor.push(component);
            if symlink(&cursor) {
                return Err("symlink_excluded".into());
            }
        }
    }
    Ok(path)
}
pub fn scan(folders: &[Value], warnings: &mut Vec<String>) -> Vec<Value> {
    let mut approved = vec![];
    for entry in folders {
        let root = expand(if entry.is_string() {
            s(entry)
        } else {
            s(&entry["path"])
        });
        if !root.is_absolute() || symlink(&root) || is_archived(&root) {
            warnings.push(format!("source_excluded:{}", root.display()));
            continue;
        }
        approved.push(entry.clone())
    }
    documents(&approved, warnings, false)
        .into_iter()
        .filter(|item| checked_path(s(&item["path"]), item["sourceRoot"].as_str()).is_ok())
        .collect()
}
pub fn identity(root: &str, topic: &str) -> String {
    format!(
        "topic-{}",
        &hash(format!(
            "{}\0{}",
            resolved(expand(root)).display(),
            nfc(topic)
        ))[..16]
    )
}
#[cfg(test)]
fn rule_document(
    rule: &Value,
    cache: &mut HashMap<String, Vec<Value>>,
    warnings: &mut Vec<String>,
    day: NaiveDate,
) -> Value {
    rule_document_with_probe(rule, cache, warnings, day, &pin_is_file)
}
fn pin_is_file(path: &Path) -> Result<bool> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
fn rule_document_with_probe(
    rule: &Value,
    cache: &mut HashMap<String, Vec<Value>>,
    warnings: &mut Vec<String>,
    day: NaiveDate,
    file_probe: &dyn Fn(&Path) -> Result<bool>,
) -> Value {
    let mut base = json!({"pinned":true,"path":null,"status":"missing"});
    for key in ["id", "label", "kind"] {
        if let Some(v) = rule.get(key) {
            base[key] = v.clone()
        }
    }
    let result = (|| -> Result<()> {
        if rule["kind"].as_str().unwrap_or("file") == "file" {
            let raw = rule["path"].as_str().ok_or("path")?;
            let fallback = expand(raw)
                .parent()
                .unwrap_or(Path::new("/"))
                .to_string_lossy()
                .into_owned();
            let path = checked_path(raw, Some(rule["root"].as_str().unwrap_or(&fallback)))?;
            base["path"] = json!(path);
            base["name"] = json!(filename(&path));
            base["root"] = json!(path.parent());
            if file_probe(&path)? {
                base["mtime"] = json!(mtime(&path));
                base["status"] = json!("ok")
            } else {
                base["error"] = json!("file_missing")
            }
            return Ok(());
        }
        if rule["kind"] != "latest" {
            return Err("unknown_pin_kind".into());
        }
        let root = expand(rule["root"].as_str().ok_or("root")?)
            .to_string_lossy()
            .into_owned();
        let topic = nfc(rule["topic"].as_str().ok_or("topic")?);
        base["root"] = json!(root);
        base["topic"] = json!(topic);
        let candidates = cache
            .entry(root.clone())
            .or_insert_with(|| scan(&[json!(root)], warnings));
        let depth = if rule["recursive"] == false {
            Some(1)
        } else {
            rule["depth"].as_u64()
        };
        let mut matches = vec![];
        for item in candidates {
            let relative = Path::new(s(&item["path"]))
                .strip_prefix(resolved(expand(&root)))
                .unwrap_or(Path::new(""));
            if depth.is_some_and(|n| relative.components().count() > n as usize) {
                continue;
            }
            let (stamp, candidate) = dated_topic(s(&item["name"]));
            if candidate == topic {
                if let Some(stamp) = stamp.filter(|d| *d <= day) {
                    matches.push((stamp, item.clone()))
                }
            }
        }
        let Some(newest) = matches.iter().map(|(d, _)| *d).max() else {
            base["error"] = json!("topic_missing");
            return Ok(());
        };
        let matches = matches
            .iter()
            .filter(|(d, _)| *d == newest)
            .map(|(_, i)| i)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            base["status"] = json!("conflict");
            base["error"] = json!("same_date_conflict");
            base["candidates"] = json!(matches
                .iter()
                .map(|i| i["path"].clone())
                .collect::<Vec<_>>());
            return Ok(());
        }
        for (k, v) in matches[0].as_object().unwrap() {
            base[k] = v.clone()
        }
        base["status"] = json!("ok");
        base["root"] = json!(root);
        base["topic"] = json!(topic);
        base["date"] = json!(newest.to_string());
        Ok(())
    })();
    if let Err(error) = result {
        base["status"] = json!("error");
        base["error"] = json!(error.to_string())
    }
    base
}
pub fn resolve(config: &Value, space: &str, day: NaiveDate) -> Result<Value> {
    resolve_with_file_probe(config, space, day, &pin_is_file)
}
/// The original permission-error test injects Path.is_file; production keeps
/// the same fallible metadata operation rather than suppressing access errors.
pub fn resolve_with_file_probe(
    config: &Value,
    space: &str,
    day: NaiveDate,
    file_probe: &dyn Fn(&Path) -> Result<bool>,
) -> Result<Value> {
    if config["version"] != 1 || !config["spaces"].is_object() {
        return Err("Expected version:1 and spaces mapping".into());
    }
    let settings = config["spaces"]
        .get(space)
        .ok_or_else(|| format!("Unknown space: {space}"))?;
    let pins = arr(&settings["pins"]);
    let ids = pins
        .iter()
        .map(|p| p["id"].clone().to_string())
        .collect::<HashSet<_>>();
    if ids.len() != pins.len() {
        return Err("Duplicate pin IDs".into());
    }
    let mut warnings = vec![];
    let mut cache = HashMap::new();
    let mut selected = pins
        .iter()
        .map(|p| rule_document_with_probe(p, &mut cache, &mut warnings, day, file_probe))
        .collect::<Vec<_>>();
    let days = settings["recent"]["days"].as_i64().unwrap_or(14).max(0);
    let limit = settings["recent"]["limit"]
        .as_i64()
        .unwrap_or(6)
        .clamp(0, 12) as usize;
    let keywords = settings["recent"]["keywords"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            vec![
                json!("결정"),
                json!("확인요청"),
                json!("확인 요청"),
                json!("회신"),
                json!("질의"),
                json!("검토결과"),
                json!("검토 결과"),
            ]
        })
        .iter()
        .map(|v| fold(s(v)))
        .collect::<Vec<_>>();
    let excluded = arr(&settings["excluded"]);
    let mut groups: BTreeMap<String, Vec<(NaiveDate, Value, String, Option<NaiveDate>)>> =
        BTreeMap::new();
    for item in scan(&arr(&settings["folders"]), &mut warnings) {
        let (stamp, topic) = dated_topic(s(&item["name"]));
        if !keywords.iter().any(|t| fold(s(&item["name"])).contains(t)) {
            continue;
        }
        let effective = stamp.unwrap_or_else(|| modified(item["mtime"].as_u64().unwrap_or(0)));
        if days == 0 || effective < day - Duration::days((days - 1).max(0)) || effective > day {
            continue;
        }
        let root = s(&item["folder"]);
        let id = identity(root, &topic);
        if excluded.contains(&json!(id)) {
            continue;
        }
        if pins.iter().any(|p| {
            p["path"] == item["path"]
                || (p["kind"] == "latest"
                    && nfc(s(&p["topic"])) == topic
                    && Path::new(s(&item["path"])).starts_with(resolved(expand(s(&p["root"])))))
        }) {
            continue;
        }
        groups
            .entry(id)
            .or_default()
            .push((effective, item, topic, stamp))
    }
    let mut candidates = vec![];
    for (id, values) in groups {
        let newest = values.iter().map(|v| v.0).max().unwrap();
        let mut latest = values.iter().filter(|v| v.0 == newest).collect::<Vec<_>>();
        latest.sort_by_key(|v| s(&v.1["path"]));
        let (_, item, topic, stamp) = latest[0];
        let mut entry = item.clone();
        entry["id"] = json!(id);
        entry["label"] = json!(stem(topic));
        entry["kind"] = json!(if stamp.is_some() { "latest" } else { "file" });
        entry["topic"] = json!(topic);
        entry["root"] = item["folder"].clone();
        entry["pinned"] = json!(false);
        entry["date"] = json!(newest.to_string());
        entry["status"] = json!("ok");
        if latest.len() > 1 {
            entry["path"] = Value::Null;
            entry["status"] = json!("conflict");
            entry["error"] = json!("same_date_conflict");
            entry["candidates"] = json!(latest
                .iter()
                .map(|v| v.1["path"].clone())
                .collect::<Vec<_>>())
        }
        candidates.push(entry)
    }
    candidates.sort_by_key(|i| {
        std::cmp::Reverse((
            s(&i["date"]).to_owned(),
            i["mtime"].as_u64().unwrap_or(0),
            s(&i["id"]).to_owned(),
        ))
    });
    selected.extend(candidates.into_iter().take(limit));
    let mut roots = arr(&settings["folders"])
        .iter()
        .map(|e| {
            expand(if e.is_string() { s(e) } else { s(&e["path"]) })
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    for pin in &pins {
        roots.push(
            expand(pin["root"].as_str().map(str::to_owned).unwrap_or_else(|| {
                Path::new(pin["path"].as_str().unwrap_or("/"))
                    .parent()
                    .unwrap_or(Path::new("/"))
                    .to_string_lossy()
                    .into_owned()
            }))
            .to_string_lossy()
            .into_owned(),
        )
    }
    roots.sort();
    roots.dedup();
    warnings.sort();
    warnings.dedup();
    Ok(
        json!({"version":1,"spaceId":space,"name":settings["name"].as_str().unwrap_or(space),"checkedAt":Local::now().to_rfc3339(),"documents":selected,"warnings":warnings,"watchRoots":roots}),
    )
}
pub fn catalog(
    config: &Value,
    space: &str,
    day: NaiveDate,
    app: &Path,
    routing: &Value,
) -> Result<Value> {
    let base = resolve(config, space, day)?;
    let settings = &config["spaces"][space];
    let kinds = kinds_for(config, settings);
    let days = settings["recent"]["highlightDays"].as_i64().unwrap_or(7);
    let mut warnings = arr(&base["warnings"])
        .iter()
        .map(|w| s(w).to_owned())
        .collect::<Vec<_>>();
    let approved = arr(&settings["folders"])
        .into_iter()
        .filter(|entry| {
            let root = expand(if entry.is_string() {
                s(entry)
            } else {
                s(&entry["path"])
            });
            root.is_absolute() && !symlink(&root) && !is_archived(root)
        })
        .collect::<Vec<_>>();
    let mut pins = arr(&base["documents"])
        .into_iter()
        .filter(|d| d["pinned"] == true)
        .collect::<Vec<_>>();
    let mut scanned = documents(&approved, &mut warnings, true);
    for item in routing::routed(routing, s(&settings["name"]), &mut warnings) {
        if !scanned.iter().any(|i| i["path"] == item["path"]) {
            scanned.push(item)
        }
    }
    let mut rows = build(&scanned, &pins, &kinds, day, days);
    for pin in &mut pins {
        if let Some(index) = rows
            .iter()
            .position(|r| !pin["path"].is_null() && r["path"] == pin["path"])
        {
            let row = rows.remove(index);
            for key in ["kind", "family", "date", "modified", "recent", "folder"] {
                pin[key] = row[key].clone()
            }
            pin["versions"] = row.get("versions").cloned().unwrap_or(json!([]));
            for other in &mut rows {
                if other["head"] == row["id"] {
                    other["head"] = pin["id"].clone()
                }
            }
        } else if !pin["name"].is_null() {
            pin["kind"] = json!(classify(s(&pin["name"]), "", &kinds));
            if let Some(ms) = pin["mtime"].as_u64() {
                let (stamp, _) = document_date(s(&pin["name"]), Path::new(""), ms);
                pin["date"] = json!(stamp.to_string());
                pin["recent"] =
                    json!(day - Duration::days((days - 1).max(0)) <= stamp && stamp <= day)
            }
        }
        if pin["kind"].is_null() {
            pin["kind"] = json!("other")
        }
    }
    for row in &mut rows {
        if row["state"] == "latest" {
            if let Some(pin) = pins
                .iter()
                .find(|p| !p["family"].is_null() && p["family"] == row["family"])
            {
                row["state"] = json!("previous");
                row["head"] = pin["id"].clone()
            }
        }
    }
    rows.sort_by_key(|r| {
        std::cmp::Reverse((
            r["mtime"].as_u64().unwrap_or(0),
            s(&r["date"]).to_owned(),
            s(&r["id"]).to_owned(),
        ))
    });
    let view = local_view(space, app, &settings["localViews"]);
    let root = view
        .as_ref()
        .and_then(|v| v["root"].as_str())
        .map(PathBuf::from);
    let (mut view_rows, sections) = if let Some(root) = &root {
        let known = pins
            .iter()
            .chain(rows.iter())
            .filter_map(|d| d["path"].as_str().map(|p| (p.to_owned(), d["id"].clone())))
            .collect();
        local_view_documents(root, &known, view.as_ref().unwrap())
    } else {
        (vec![], vec![])
    };
    let display = [
        "report",
        "reply",
        "decision",
        "status",
        "structure",
        "account",
        "record",
    ];
    let mut order = kinds.clone();
    order.sort_by_key(|k| {
        display
            .iter()
            .position(|x| *x == s(&k["id"]))
            .unwrap_or(display.len())
    });
    let mut kinds_output = order
        .iter()
        .map(|k| json!({"id":k["id"],"label":k["label"]}))
        .collect::<Vec<_>>();
    kinds_output.push(json!({"id":"other","label":"기타"}));
    let mut watch = arr(&base["watchRoots"])
        .iter()
        .map(|p| s(p).to_owned())
        .collect::<Vec<_>>();
    watch.extend(routing::roots(routing, s(&settings["name"])));
    if let Some(root) = &root {
        watch.push(root.to_string_lossy().into_owned())
    }
    watch.sort();
    watch.dedup();
    warnings.sort();
    warnings.dedup();
    pins.extend(rows);
    pins.append(&mut view_rows);
    Ok(
        json!({"version":2,"spaceId":space,"name":base["name"],"checkedAt":base["checkedAt"],"documents":pins,"warnings":warnings,"watchRoots":watch,"kinds":kinds_output,"recentDays":days,"localViews":view.map(|mut view| {view["sections"] = json!(sections); view})}),
    )
}
pub fn mutate(
    config: &mut Value,
    space: &str,
    pin_path: Option<&str>,
    unpin: Option<&str>,
    pin_id: Option<&str>,
) -> Result<()> {
    let selected = resolve(config, space, today())?;
    let mut path = pin_path.map(str::to_owned);
    let settings = &mut config["spaces"][space];
    if settings["pins"].is_null() {
        settings["pins"] = json!([])
    }
    if settings["excluded"].is_null() {
        settings["excluded"] = json!([])
    }
    if let Some(id) = unpin {
        if let Some(item) = arr(&selected["documents"])
            .iter()
            .find(|d| s(&d["id"]) == id)
            .cloned()
        {
            if !s(&item["root"]).is_empty() && !s(&item["name"]).is_empty() {
                let (_, topic) = dated_topic(s(&item["name"]));
                let root = item["path"]
                    .as_str()
                    .and_then(|p| Path::new(p).parent())
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| s(&item["root"]).to_owned());
                let auto_id = json!(identity(&root, &topic));
                if !arr(&settings["excluded"]).contains(&auto_id) {
                    settings["excluded"].as_array_mut().unwrap().push(auto_id)
                }
            }
        }
        settings["pins"] = json!(arr(&settings["pins"])
            .into_iter()
            .filter(|p| s(&p["id"]) != id)
            .collect::<Vec<_>>());
        if !arr(&settings["excluded"]).contains(&json!(id)) {
            settings["excluded"].as_array_mut().unwrap().push(json!(id))
        }
        return Ok(());
    }
    if let Some(id) = pin_id {
        let item = arr(&selected["documents"])
            .into_iter()
            .find(|d| s(&d["id"]) == id && d["status"] == "ok")
            .ok_or("Document is unavailable")?;
        path = item["path"].as_str().map(str::to_owned)
    }
    let path = checked_path(path.as_deref().ok_or("Document is unavailable")?, None)?;
    if !path.is_file() {
        return Err("Document is unavailable".into());
    }
    let (stamp, topic) = dated_topic(&filename(&path));
    let root = path.parent().unwrap().to_string_lossy().into_owned();
    let id = identity(&root, &topic);
    let mut rule =
        json!({"id":id,"label":stem(&topic),"kind":if stamp.is_some(){"latest"}else{"file"}});
    if stamp.is_some() {
        rule["root"] = json!(root);
        rule["topic"] = json!(topic);
        rule["recursive"] = json!(false)
    } else {
        rule["path"] = json!(path)
    }
    let mut pins = arr(&settings["pins"]);
    pins.retain(|p| p["id"] != id);
    pins.push(rule);
    settings["pins"] = json!(pins);
    settings["excluded"] = json!(arr(&settings["excluded"])
        .into_iter()
        .filter(|e| *e != id)
        .collect::<Vec<_>>());
    Ok(())
}
pub fn cli(args: &[String]) -> Result<()> {
    let path = option(args, "--config")
        .map(expand)
        .unwrap_or_else(|| app_home().join("data/sixfold/project-docs-pins.json"));
    let space = required(args, "--space")?;
    let actions = ["--pin", "--pin-id", "--unpin"]
        .iter()
        .filter(|k| option(args, k).is_some_and(|value| !value.is_empty()))
        .count();
    if actions > 1 {
        return Err("pin actions are mutually exclusive".into());
    }
    let _guard = if actions > 0 {
        Some(lock(path.with_extension("lock"), false)?)
    } else {
        None
    };
    let mut config = read_json(&path)?;
    if actions > 0 {
        mutate(
            &mut config,
            &space,
            option(args, "--pin").as_deref(),
            option(args, "--unpin").as_deref(),
            option(args, "--pin-id").as_deref(),
        )?;
        atomic_json(&path, &config)?;
    }
    let routing_path = option(args, "--routing").map(expand).unwrap_or_else(|| {
        path.parent()
            .unwrap()
            .join("project-docs-routing.local.json")
    });
    let routing = routing::load(&routing_path).unwrap_or(json!({}));
    crate::common::print(&(catalog(&config, &space, today(), &app_home(), &routing)?))?;
    Ok(())
}
pub fn choose_space(
    config: &Value,
    file: &Path,
    wanted: Option<&str>,
    live: Option<&HashSet<String>>,
) -> Result<Option<String>> {
    let mut best = None;
    let Some(spaces) = config["spaces"].as_object() else {
        return Ok(None);
    };
    for (id, settings) in spaces {
        if live.is_some_and(|l| !l.contains(id)) {
            continue;
        }
        if let Some(wanted) = wanted {
            if wanted == id || wanted == s(&settings["name"]) {
                return Ok(Some(id.clone()));
            }
            continue;
        }
        for entry in arr(&settings["folders"]) {
            let root = resolved(expand(if entry.is_string() {
                s(&entry)
            } else {
                s(&entry["path"])
            }));
            let Ok(relative) = file.strip_prefix(&root) else {
                continue;
            };
            let keywords = if entry.is_string() {
                vec![]
            } else {
                arr(&entry["match"])
            };
            if !keywords.is_empty()
                && !keywords
                    .iter()
                    .any(|w| fold(&relative.to_string_lossy()).contains(&fold(s(w))))
            {
                continue;
            }
            let score = (root.components().count(), !keywords.is_empty());
            if best.as_ref().map_or(true, |(old, _)| score > *old) {
                best = Some((score, id.clone()))
            }
        }
        if arr(&settings["pins"]).iter().any(|p| {
            p["path"]
                .as_str()
                .is_some_and(|p| resolved(expand(p)) == file)
        }) {
            return Ok(Some(id.clone()));
        }
    }
    if let Some(wanted) = wanted {
        return Err(format!("Unknown space: {wanted}").into());
    }
    Ok(best.map(|(_, id)| id))
}
fn docs_tab(listing: &Value, space: &str) -> Option<String> {
    arr(&listing["spaces"])
        .iter()
        .find(|s_| s(&s_["id"]) == space)
        .and_then(|space| {
            arr(&space["tabs"]).into_iter().find_map(|t| {
                t["id"]
                    .as_str()
                    .filter(|id| id.starts_with("sf-docs-tab-"))
                    .map(str::to_owned)
            })
        })
}
pub fn open_tab(args: &[String]) -> Result<()> {
    let file = positionals(args, &["--no-show"])
        .first()
        .map(expand)
        .ok_or("file required")?
        .canonicalize()?;
    let file = resolved(file);
    if !file.is_file() {
        return Err("select a file".into());
    }
    let app = app_home();
    if !app.join("mods/project-docs-tabs/main.js").exists() {
        return Err(
            "install the document tabs first: herdr-theme install-doc-tabs --install".into(),
        );
    }
    let config = read_json(app.join("data/sixfold/project-docs-pins.json"))?;
    let listing = cli_json("herdr-app", &["ls"])?;
    let live = arr(&listing["spaces"])
        .iter()
        .filter_map(|space| {
            let id = s(&space["id"]);
            docs_tab(&listing, id).map(|_| id.to_owned())
        })
        .collect();
    let space = choose_space(
        &config,
        &file,
        option(args, "--space").as_deref(),
        Some(&live),
    )?
    .unwrap_or_else(|| {
        cli_json("herdr-app", &["status"])
            .ok()
            .map(|x| s(&x["space"]).to_owned())
            .unwrap_or_default()
    });
    let tab = docs_tab(&listing, &space).ok_or_else(|| {
        format!("No 문서 tab in space {space}; run herdr-theme install-doc-tabs --install")
    })?;
    let path = app.join("data/sixfold/project-docs-open.json");
    let _guard = lock(path.with_extension("lock"), false)?;
    let mut requests = json_or(&path, json!({}))["requests"].clone();
    if !requests.is_object() {
        requests = json!({})
    }
    requests[&space] = json!({"path":file,"at":now_ms()});
    replace_named_text(
        &path,
        &crate::common::json_text(&json!({"version":2,"requests":requests}), false),
    )?;
    if !has(args, "--no-show") {
        checked(command("herdr-app").args(["do", "tab.select", "--id", &tab]))?;
    }
    crate::common::print(
        &(json!({"space":space,"tab":tab,"file":file,"shown":!has(args,"--no-show")})),
    )?;
    Ok(())
}
pub fn open_document(args: &[String]) -> Result<()> {
    let positions = positionals(args, &[]);
    let file = positions.first().ok_or("file required")?.as_str();
    let file = resolved(Path::new(file).canonicalize()?);
    if !file.is_file() {
        return crate::common::usage("select a file");
    }
    let app = app_home();
    for name in [
        "sixfold-files",
        "sixfold-docs",
        "files-plus",
        "preview-plus",
    ] {
        if !app.join("mods").join(name).join("main.js").exists() {
            return crate::common::usage("run herdr-theme install-preview first");
        }
    }
    let status = cli_json("herdr-app", &["status"])?;
    replace_named_text(
        &app.join("data/sixfold/preview-open.json"),
        &crate::common::json_text(
            &json!({"space":status["space"],"file":file,"root":file.parent()}),
            true,
        ),
    )?;
    for (cmd, params) in [
        (
            "layout.select",
            json!({"stack":"panel-body","child":"files"}),
        ),
        (
            "layout.select",
            json!({"stack":"files","child":"files-plus-tree"}),
        ),
        ("layout.show", json!({"id":"panel"})),
    ] {
        checked(command("herdr-app").args(["do", cmd, &crate::common::json_text(&params, true)]))?;
    }
    std::thread::sleep(std::time::Duration::from_millis(150));
    checked(command("herdr-app").args(["do", "sixfold-files.open"]))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_excludes_symlink_archives_and_latest() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("one.md"), "x").unwrap();
        fs::write(t.path().join("latest.md"), "x").unwrap();
        fs::create_dir(t.path().join("archive")).unwrap();
        fs::write(t.path().join("archive/two.md"), "x").unwrap();
        let mut w = vec![];
        assert_eq!(documents(&[json!(t.path())], &mut w, false).len(), 1);
        assert_eq!(documents(&[json!(t.path())], &mut w, true).len(), 2);
    }
    #[test]
    fn missing_and_conflicting_latest_are_explicit() {
        let t = tempfile::tempdir().unwrap();
        let rule = json!({"id":"a","kind":"latest","root":t.path(),"topic":"reply.md"});
        let mut cache = HashMap::new();
        assert_eq!(
            rule_document(&rule, &mut cache, &mut vec![], today())["error"],
            "topic_missing"
        );
    }
    #[test]
    fn folder_specificity_selects_owner() {
        let root = absolute("documents");
        let config =
            json!({"spaces":{"a":{"folders":[root]},"b":{"folders":[root.join("project")]}}});
        assert_eq!(
            choose_space(&config, &root.join("project/report.md"), None, None).unwrap(),
            Some("b".into())
        );
    }
}
