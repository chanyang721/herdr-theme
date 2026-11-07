use super::common::*;
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
pub const EXTENSIONS: &[&str] = &[".md", ".html", ".htm", ".pdf", ".docx", ".xlsx"];
pub fn is_archived(path: impl AsRef<Path>) -> bool {
    let p = fold(&path.as_ref().to_string_lossy());
    ["archive", "아카이브", "보관", ".before-"]
        .iter()
        .any(|term| p.contains(term))
}
fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap()
}
pub fn today() -> NaiveDate {
    Local::now().date_naive()
}
pub fn modified(ms: u64) -> NaiveDate {
    Local
        .timestamp_millis_opt(ms as i64)
        .single()
        .unwrap_or_else(Local::now)
        .date_naive()
}
pub fn parse_date(text: &str) -> Option<NaiveDate> {
    let text = nfc(text);
    let re = rx(r"^(\d{8}|\d{4}-\d{2}-\d{2})(?:[_\- ]+|$)");
    let caps = re.captures(&text)?;
    NaiveDate::parse_from_str(
        &caps[1],
        if caps[1].contains('-') {
            "%Y-%m-%d"
        } else {
            "%Y%m%d"
        },
    )
    .ok()
}
pub fn strip_date(text: &str) -> String {
    let text = nfc(text);
    if parse_date(&text).is_some() {
        let re = rx(r"^(\d{8}|\d{4}-\d{2}-\d{2})(?:[_\- ]+|$)");
        if let Some(m) = re.find(&text) {
            if m.end() < text.len() {
                return text[m.end()..].to_owned();
            }
        }
    }
    text
}
pub fn dated_topic(name: &str) -> (Option<NaiveDate>, String) {
    let text = nfc(name);
    if let Some(date) = parse_date(&text) {
        let stripped = strip_date(&text);
        if stripped != text {
            return (Some(date), stripped);
        }
    }
    (None, text)
}
pub fn family_key(name: &str) -> (String, bool, Option<String>) {
    let mut name = stem(strip_date(name));
    let before_re = rx(r"(?i)[._\- ](?:v\d+[._\-])?before(?:[._\-].*)?$");
    let before = before_re.is_match(&name);
    name = before_re.replace(&name, "").into_owned();
    let copy = rx(r"(?i)\s*\((?:\d+|사본|copy)\)$");
    let version = rx(r"(?i)[._\- ]v\d+$");
    let variant_re =
        rx(r"(?i)[._\- ](최신본|수정본|공유본|revised|shared|최종|final|draft|초안|사본|copy)$");
    let mut variant = None;
    loop {
        let mut changed = copy.replace(&version.replace(&name, ""), "").into_owned();
        if let Some(caps) = variant_re.captures(&changed) {
            if variant.is_none() {
                variant = Some(fold(&caps[1]))
            }
            changed = changed[..caps.get(0).unwrap().start()].to_owned()
        }
        if changed == name || changed.is_empty() {
            break;
        }
        name = changed
    }
    (fold(&name).replace([' ', '-'], "_"), before, variant)
}
pub fn label_of(name: &str, prefix: Option<&str>) -> String {
    let mut name_stem = stem(strip_date(name));
    name_stem = rx(r"^(?:pin|topic)-[0-9a-f]{8,}-")
        .replace(&name_stem, "")
        .into_owned();
    if parse_date(&name_stem).is_some() {
        name_stem = stem(strip_date(&name_stem))
    }
    if let Some(prefix) = prefix {
        if fold(&name_stem).starts_with(prefix)
            && name_stem.chars().count() > prefix.chars().count() + 1
        {
            name_stem = name_stem
                .chars()
                .skip(prefix.chars().count())
                .collect::<String>()
                .trim_start_matches(['_', '-', ' '])
                .to_owned()
        }
    }
    if let Some(caps) = rx(r"[._\-]([0-9a-f]{7,40})$").captures(&name_stem) {
        let found = caps.get(0).unwrap();
        if caps[1].chars().any(|c| c.is_ascii_digit()) && found.start() > 0 {
            name_stem = format!("{} #{}", &name_stem[..found.start()], &caps[1][..6])
        }
    }
    let label = name_stem.replace('_', " ").trim().to_owned();
    if label.is_empty() {
        nfc(name)
    } else {
        label
    }
}
pub fn common_prefix(names: &[String]) -> Option<String> {
    let mut words: Vec<(String, usize)> = vec![];
    for name in names {
        let value = stem(strip_date(name));
        if let Some((first, _)) = value.split_once(['_', '-', ' ']) {
            if !first.is_empty() {
                let first = fold(first);
                if let Some((_, count)) = words.iter_mut().find(|(w, _)| w == &first) {
                    *count += 1
                } else {
                    words.push((first, 1))
                }
            }
        }
    }
    let best = words.into_iter().max_by_key(|(_, count)| *count)?;
    if best.1 >= 3 && best.1 as f64 >= names.len() as f64 * 0.6 {
        Some(best.0)
    } else {
        None
    }
}
pub fn default_kinds() -> Value {
    json!([
{"id":"reply","label":"회신안","terms":["회신","답변","reply","response","질의","문의"]},
{"id":"structure","label":"구조도","terms":["구조","architecture","아키텍처","설계","design","diagram","구성","spec","흐름","flow","microservice","integration","연동"]},
{"id":"status","label":"현황","terms":["현황","status","점검","진행","대기","태스크","task","todo","next"]},
{"id":"report","label":"보고서","terms":["보고서","report","견적","산정","범위","분석","검토","review","cost","estimate","비교","요약","summary","wbs","요구사항","분류","plan"]},
{"id":"decision","label":"결정","terms":["결정","decision","adr","확인요청","확인 요청","기준점","조건","착수","승인","계약"]},
{"id":"account","label":"계정·환경","terms":["계정","환경","account","env","북마크","bookmark","setup","설정","권한","deploy","배포","guide","가이드","readme"]},
{"id":"record","label":"기록","terms":["기록","log","history","회의","미팅","meeting","weekly","주간","메모","memo","notes","정리","rehearsal","리허설","test"]}])
}
pub fn kinds_for(config: &Value, settings: &Value) -> Vec<Value> {
    let custom = &settings["classify"]["kinds"];
    let fallback = &config["classify"]["kinds"];
    let kinds = if custom.as_array().is_some_and(|x| !x.is_empty()) {
        custom.clone()
    } else if fallback.as_array().is_some_and(|x| !x.is_empty()) {
        fallback.clone()
    } else {
        default_kinds()
    };
    arr(&kinds).into_iter().filter(|k|!s(&k["id"]).is_empty()).map(|k|json!({"id":k["id"],"label":k.get("label").unwrap_or(&k["id"]),"terms":arr(&k["terms"]).iter().map(|t|fold(s(t))).collect::<Vec<_>>()})).collect()
}
pub fn classify(name: &str, relative: &str, kinds: &[Value]) -> String {
    let mut texts = Path::new(relative)
        .components()
        .rev()
        .map(|p| fold(&strip_date(&p.as_os_str().to_string_lossy())))
        .collect::<Vec<_>>();
    texts.push(fold(&strip_date(name)));
    for text in texts {
        for kind in kinds {
            if arr(&kind["terms"])
                .iter()
                .any(|t| !s(t).is_empty() && text.contains(s(t)))
            {
                return s(&kind["id"]).to_owned();
            }
        }
    }
    "other".into()
}
pub fn document_date(name: &str, relative: &Path, mtime: u64) -> (NaiveDate, bool) {
    if let Some(date) = parse_date(name) {
        return (date, true);
    }
    if let Some(parent) = relative.parent() {
        for part in parent.components().rev() {
            if let Some(date) = parse_date(&part.as_os_str().to_string_lossy()) {
                return (date, true);
            }
        }
    }
    (modified(mtime), false)
}
fn variant_rank(v: &Value) -> i64 {
    match s(v) {
        "최종" | "final" => 3,
        "공유본" | "shared" | "최신본" => 2,
        "초안" | "draft" | "사본" | "copy" => 0,
        _ => 1,
    }
}
fn format_rank(v: &Value) -> i64 {
    match suffix(s(&v["path"])).as_str() {
        ".md" => 3,
        ".html" | ".htm" => 2,
        ".pdf" => 1,
        _ => 0,
    }
}
pub fn build(
    items: &[Value],
    pins: &[Value],
    kinds: &[Value],
    day: NaiveDate,
    recent_days: i64,
) -> Vec<Value> {
    let since = day - Duration::days((recent_days - 1).max(0));
    let prefix = common_prefix(
        &items
            .iter()
            .map(|i| s(&i["name"]).to_owned())
            .collect::<Vec<_>>(),
    );
    let pinned: HashSet<&str> = pins.iter().filter_map(|p| p["path"].as_str()).collect();
    let mut rows = vec![];
    let mut families: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for item in items {
        let name = s(&item["name"]);
        let relative = PathBuf::from(item["relativePath"].as_str().unwrap_or(name));
        let folder = relative
            .parent()
            .filter(|p| p.as_os_str() != "")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (stamp, dated) = document_date(name, &relative, item["mtime"].as_u64().unwrap_or(0));
        let (key, before, variant) = family_key(name);
        let mut kind = classify(name, &folder, kinds);
        if kind == "other" && !s(&item["title"]).is_empty() {
            kind = classify(s(&item["title"]), "", kinds)
        }
        let mut family = format!("{}\0{}", s(&item["sourceRoot"]), key);
        if !dated {
            family.push('\0');
            family.push_str(if folder.is_empty() { "." } else { &folder })
        }
        let family = format!("fam-{}", &hash(family)[..16]);
        let mut row = json!({"id":format!("doc-{}",&hash(nfc(s(&item["path"])))[..16]),"path":item["path"],"name":name,"label":label_of(name,prefix.as_deref()),"kind":kind,"family":family,"date":stamp.to_string(),"dated":dated,"recent":since<=stamp&&stamp<=day,"mtime":item["mtime"],"modified":modified(item["mtime"].as_u64().unwrap_or(0)).to_string(),"size":item["size"],"folder":folder,"pinned":false,"status":"ok","state":if item["archived"].as_bool().unwrap_or(false){"archived"}else{"latest"},"before":before,"variant":variant});
        if !item["routedFrom"].is_null() {
            row["routedFrom"] = item["routedFrom"].clone()
        }
        if row["state"] != "archived" {
            families.entry(family).or_default().push(rows.len())
        }
        rows.push(row)
    }
    for members in families.values_mut() {
        members.sort_by(|a, b| {
            let key = |i: usize| {
                let r = &rows[i];
                (
                    pinned.contains(s(&r["path"])),
                    !r["before"].as_bool().unwrap_or(false),
                    s(&r["date"]).to_owned(),
                    variant_rank(&r["variant"]),
                    -(s(&r["folder"]).matches('/').count() as i64)
                        - if s(&r["folder"]).is_empty() { 0 } else { 1 },
                    format_rank(r),
                    r["mtime"].as_u64().unwrap_or(0),
                )
            };
            key(*b).cmp(&key(*a))
        });
        let head = members[0];
        rows[head]["versions"] = json!(members[1..]
            .iter()
            .map(|i| rows[*i]["id"].clone())
            .collect::<Vec<_>>());
        for i in &members[1..] {
            rows[*i]["state"] = json!("previous");
            rows[*i]["head"] = rows[head]["id"].clone();
            rows[*i]["kind"] = rows[head]["kind"].clone()
        }
    }
    rows
}
fn relative_parts(value: &str) -> Option<Vec<&str>> {
    if value.is_empty() || value.contains(['\\', ':']) || value.starts_with('/') {
        return None;
    }
    let parts = value.split('/').filter(|p| *p != ".").collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty() || *part == "..") {
        return None;
    }
    Some(parts)
}
pub fn local_view(space: &str, app: &Path, override_config: &Value) -> Option<Value> {
    if let Some(root) = override_config["root"].as_str() {
        let root = expand(root);
        if !root.is_dir() {
            return None;
        }
        let mut value = override_config.clone();
        value["root"] = json!(resolved(root));
        return Some(value);
    }
    let base = app.join("data/sixfold/local-views/workspaces");
    let canonical_base = fs::canonicalize(&base).ok()?;
    let index = read_json(base.join("index.json")).ok()?;
    if index["schema"] != 1 {
        return None;
    }
    for entry in arr(&index["views"]) {
        if s(&entry["spaceId"]) != space {
            continue;
        }
        let Some(parts) = relative_parts(s(&entry["directory"])) else {
            continue;
        };
        let root = parts.iter().fold(base.clone(), |p, part| p.join(part));
        let Ok(root) = fs::canonicalize(root) else {
            continue;
        };
        if root.is_dir() && root.starts_with(&canonical_base) {
            let mut value = entry.clone();
            value["root"] = json!(root);
            return Some(value);
        }
    }
    None
}
pub fn local_view_documents(
    root: &Path,
    known: &HashMap<String, Value>,
    metadata: &Value,
) -> (Vec<Value>, Vec<Value>) {
    let mut definitions = arr(&metadata["sections"])
        .into_iter()
        .filter(|section| {
            !s(&section["id"]).is_empty()
                && !s(&section["label"]).is_empty()
                && relative_parts(section["directory"].as_str().unwrap_or(".")).is_some()
        })
        .collect::<Vec<_>>();
    let mut rows = vec![];
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
    {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !path.is_file()
            || !(EXTENSIONS.contains(&suffix(path).as_str()) || suffix(path) == ".txt")
        {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let mut target = resolved(path);
        if let Some(source) = metadata["sources"][&relative].as_str() {
            let source = Path::new(source);
            if source.is_file() && same_file::is_same_file(path, source).unwrap_or(false) {
                target = resolved(source);
            }
        }
        let selected = definitions
            .iter()
            .enumerate()
            .filter_map(|(i, definition)| {
                let parts = relative_parts(definition["directory"].as_str().unwrap_or("."))?;
                let prefix = parts.join("/");
                (prefix.is_empty() || relative.starts_with(&format!("{prefix}/")))
                    .then_some((i, prefix))
            })
            .max_by_key(|(_, prefix)| prefix.len());
        let (section, prefix, depth) = if let Some((index, prefix)) = selected {
            (
                s(&definitions[index]["id"]).to_owned(),
                prefix,
                definitions[index]["groupDepth"]
                    .as_u64()
                    .map(|x| x as usize),
            )
        } else {
            let folder = relative.split('/').collect::<Vec<_>>();
            let id = if folder.len() > 1 { folder[0] } else { "files" }.to_owned();
            if !definitions.iter().any(|d| s(&d["id"]) == id) {
                definitions
                    .push(json!({"id":id,"label":if folder.len()>1 {folder[0]} else {"Files"}}));
            }
            let prefix = if folder.len() > 1 { folder[0] } else { "" }.to_owned();
            (id, prefix, None)
        };
        let remainder = relative
            .strip_prefix(&prefix)
            .unwrap_or(&relative)
            .trim_start_matches('/');
        let mut folders = remainder.split('/').collect::<Vec<_>>();
        folders.pop();
        if let Some(depth) = depth {
            folders.truncate(depth);
        }
        let label = metadata["labels"][&relative]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| label_of(&filename(path), None));
        let mut row = json!({"id":format!("view-{}", &hash(nfc(&relative))[..16]),"path":target,"name":filename(path),"label":label,
            "section":section,"group":folders.join("/"),"status":"ok","pinned":false,"localView":true,
            "mtime":mtime(&target),"size":fs::metadata(&target).map(|m|m.len()).unwrap_or(0),"relative":relative});
        if let Some(date) = relative.split('/').rev().find_map(parse_date) {
            row["date"] = json!(date.to_string());
        }
        if let Some(alias) = known.get(&target.to_string_lossy().into_owned()) {
            row["aliasOf"] = alias.clone();
        }
        rows.push(row);
    }
    let mut families: BTreeMap<(String, String, String), Vec<usize>> = BTreeMap::new();
    for (index, row) in rows.iter().enumerate() {
        let relative = Path::new(s(&row["relative"]));
        families
            .entry((
                s(&row["section"]).into(),
                relative
                    .parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .into_owned(),
                family_key(s(&row["name"])).0,
            ))
            .or_default()
            .push(index);
    }
    for members in families.values_mut().filter(|m| m.len() > 1) {
        members.sort_by_key(|i| {
            std::cmp::Reverse((
                s(&rows[*i]["date"]).to_owned(),
                rows[*i]["mtime"].as_u64().unwrap_or(0),
                s(&rows[*i]["name"]).to_owned(),
            ))
        });
        let head = members[0];
        rows[head]["versions"] = json!(members[1..]
            .iter()
            .map(|i| rows[*i]["id"].clone())
            .collect::<Vec<_>>());
        for i in &members[1..] {
            rows[*i]["state"] = json!("previous");
            rows[*i]["head"] = rows[head]["id"].clone();
        }
    }
    let mut sections = vec![];
    for definition in definitions {
        let id = s(&definition["id"]);
        let mut members = rows
            .iter()
            .filter(|row| s(&row["section"]) == id)
            .collect::<Vec<_>>();
        let order = arr(&definition["order"]);
        members.sort_by_key(|row| {
            (
                order
                    .iter()
                    .position(|path| path == &row["relative"])
                    .unwrap_or(order.len()),
                std::cmp::Reverse((
                    s(&row["date"]).to_owned(),
                    row["mtime"].as_u64().unwrap_or(0),
                )),
                s(&row["relative"]).to_owned(),
            )
        });
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for row in members {
            groups
                .entry(s(&row["group"]).to_owned())
                .or_default()
                .push(row["id"].clone());
        }
        if !groups.is_empty() {
            sections.push(json!({"id":id,"label":definition["label"],"groups":groups.into_iter().rev().map(|(label, ids)|json!({"label":label,"ids":ids})).collect::<Vec<_>>()}));
        }
    }
    (rows, sections)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn families_remove_only_staged_suffixes() {
        assert_eq!(
            family_key("2026-11-05_plan_final_v2.md"),
            ("plan".into(), false, Some("final".into()))
        );
        assert_eq!(
            family_key("plan.v1-before-review.md"),
            ("plan".into(), true, None)
        );
        assert_eq!(
            label_of(
                "20261105_topic-abcdef012345-20261105_project_123abcd.md",
                None
            ),
            "project #123abc"
        );
    }
    #[test]
    fn dates_reject_invalid() {
        assert!(parse_date("20260230_report.md").is_none());
        assert_eq!(strip_date("20261105_report.md"), "report.md");
        assert_eq!(strip_date("20261105"), "20261105");
    }
    #[test]
    fn pinned_path_heads_family() {
        let items = vec![
            json!({"name":"20261104_report.md","path":"/old.md","sourceRoot":"/","mtime":0,"relativePath":"20261104_report.md"}),
            json!({"name":"20261105_report.md","path":"/new.md","sourceRoot":"/","mtime":1,"relativePath":"20261105_report.md"}),
        ];
        let rows = build(
            &items,
            &[json!({"path":"/old.md"})],
            &kinds_for(&json!({}), &json!({})),
            NaiveDate::from_ymd_opt(2026, 11, 5).unwrap(),
            7,
        );
        assert_eq!(rows[0]["state"], "latest");
        assert_eq!(rows[1]["head"], rows[0]["id"]);
    }
}
