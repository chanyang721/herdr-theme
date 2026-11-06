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
pub fn harness_root(space: &str, app: &Path, override_root: Option<&str>) -> Option<PathBuf> {
    if let Some(root) = override_root {
        let root = expand(root);
        return root.is_dir().then_some(root);
    }
    let base = app.join("data/sixfold/harness-local/views/workspaces");
    let index = read_json(base.join("index.json")).ok()?;
    for entry in arr(&index["workspaces"]) {
        if s(&entry["space_id"]) == space && entry["machine_name"].is_null() {
            let name = s(&entry["workspace_id"]);
            if !name.is_empty() && !name.contains('/') && !name.starts_with('.') {
                let root = base.join(name);
                if root.is_dir() {
                    return Some(root);
                }
            }
        }
    }
    None
}
fn harness_label(name: &str) -> String {
    match fold(name).as_str() {
        "readme.md" => "한눈에 보기",
        "context.md" => "컨텍스트",
        "goal.md" => "목표",
        "constraints.md" => "제약",
        "environment.md" => "환경",
        "decisions.md" => "결정 요약",
        "next.md" => "남은 일",
        "escalation.md" => "막힘",
        "brain.md" => "승인된 기억",
        "pending.md" => "승인 대기 기억",
        _ => return label_of(name, None),
    }
    .into()
}
pub fn harness(root: &Path, known: &HashMap<String, Value>) -> (Vec<Value>, Vec<Value>) {
    let hardlinks = json_or(root.join(".hardlinks.json"), json!({}));
    let mut rows = vec![];
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
    {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_file()
            || !(EXTENSIONS.contains(&suffix(path).as_str()) || suffix(path) == ".txt")
        {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap();
        let parts = relative
            .iter()
            .map(|x| x.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let top = if parts.len() > 1 {
            parts[0].as_str()
        } else {
            ""
        };
        let mut target = resolved(path);
        if let Some(source) =
            hardlinks[relative.to_string_lossy().replace('\\', "/")]["source"].as_str()
        {
            let original = Path::new(source);
            if original.is_file() && same_file::is_same_file(path, original).unwrap_or(false) {
                target = resolved(original)
            }
        }
        let (section, mut group) = match top {
            "" | "context" => {
                if parts.len() > 2 || fold(&filename(path)) == "tree.json" {
                    continue;
                }
                ("status", String::new())
            }
            "history" => {
                let month = parts
                    .iter()
                    .skip(1)
                    .take(parts.len().saturating_sub(2))
                    .find(|p| rx(r"^\d{4}-\d{2}$").is_match(p))
                    .cloned()
                    .or_else(|| {
                        parts
                            .iter()
                            .rev()
                            .find_map(|p| parse_date(p).map(|d| d.format("%Y-%m").to_string()))
                    })
                    .unwrap_or_else(|| "날짜 없음".into());
                ("history", month)
            }
            "decisions" => ("decisions", String::new()),
            "docs" => (
                "docs",
                if parts.len() > 2 {
                    parts[1].clone()
                } else {
                    String::new()
                },
            ),
            "brain" => ("brain", String::new()),
            _ => continue,
        };
        let mut row = json!({"id":format!("harness-{}",&hash(nfc(&relative.to_string_lossy()))[..16]),"path":target,"name":filename(path),"label":harness_label(&filename(path)),"section":section,"group":group,"status":"ok","pinned":false,"harness":true,"mtime":mtime(&target),"size":fs::metadata(&target).map(|m|m.len()).unwrap_or(0),"relative":relative});
        if let Some(stamp) = parts.iter().rev().find_map(|p| parse_date(p)) {
            row["date"] = json!(stamp.to_string())
        }
        if let Some(alias) = known.get(&target.to_string_lossy().into_owned()) {
            row["aliasOf"] = alias.clone()
        }
        if section == "docs" && parts.len() > 3 {
            row["bundle"] = json!(relative.parent().unwrap());
            row["label"] = json!(label_of(
                &format!("{}{}", parts[parts.len() - 2], suffix(path)),
                None
            ))
        }
        rows.push(row)
    }
    let mut bundles: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(bundle) = row["bundle"].as_str() {
            bundles.entry(bundle.to_owned()).or_default().push(i)
        }
    }
    for members in bundles.values_mut() {
        members.sort_by(|a, b| {
            let key = |i: usize| {
                (
                    s(&rows[i]["date"]).to_owned(),
                    rows[i]["mtime"].as_u64().unwrap_or(0),
                    s(&rows[i]["name"]).to_owned(),
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
            rows[*i]["label"] = json!(label_of(s(&rows[*i]["name"]), None))
        }
    }
    let mut sections = vec![];
    for (section, label) in [
        ("status", "현황"),
        ("history", "기록"),
        ("decisions", "결정"),
        ("docs", "주제 문서"),
        ("brain", "기억"),
    ] {
        let mut members = rows
            .iter()
            .filter(|r| r["section"] == section)
            .collect::<Vec<_>>();
        if section == "status" {
            let order = [
                "readme.md",
                "context.md",
                "goal.md",
                "constraints.md",
                "environment.md",
                "decisions.md",
                "next.md",
                "escalation.md",
            ];
            members.sort_by_key(|r| {
                (
                    order
                        .iter()
                        .position(|n| *n == fold(s(&r["name"])))
                        .unwrap_or(order.len()),
                    s(&r["relative"]).to_owned(),
                )
            })
        } else if section == "history" || section == "decisions" {
            members.sort_by_key(|r| {
                std::cmp::Reverse((
                    s(&r["group"]).to_owned(),
                    s(&r["date"]).to_owned(),
                    s(&r["relative"]).to_owned(),
                ))
            })
        } else {
            members.sort_by_key(|r| (s(&r["group"]).to_owned(), fold(s(&r["label"]))))
        }
        if members.is_empty() {
            continue;
        }
        let mut groups: Vec<Value> = vec![];
        for member in members {
            if groups.last().map(|g| &g["label"]) != Some(&member["group"]) {
                groups.push(json!({"label":member["group"],"ids":[]}))
            }
            groups.last_mut().unwrap()["ids"]
                .as_array_mut()
                .unwrap()
                .push(member["id"].clone())
        }
        sections.push(json!({"id":section,"label":label,"groups":groups}))
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
