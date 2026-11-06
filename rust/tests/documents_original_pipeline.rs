//! Filesystem and CLI assertions from the unchanged test_docs.py,
//! test_doc_pins.py and test_doc_routing.py. No app/core service is invoked.
use chrono::NaiveDate;
use herdr_theme::documents::{common::*, pins, routing};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use unicode_normalization::UnicodeNormalization;
struct Temp {
    _temp: tempfile::TempDir,
    root: PathBuf,
}
impl Temp {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = resolved(temp.path());
        Self { _temp: temp, root }
    }
    fn file(&self, name: &str, text: &str) -> PathBuf {
        write(&self.root, name, text)
    }
}
fn write(root: &Path, name: &str, text: &str) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}
fn json_file(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}
fn at(path: &Path, seconds: i64) {
    filetime::set_file_mtime(path, filetime::FileTime::from_unix_time(seconds, 0)).unwrap();
}
fn docs(folders: &[Value], archived: bool) -> Vec<Value> {
    pins::documents(folders, &mut vec![], archived)
}
fn names(rows: &[Value]) -> Vec<String> {
    rows.iter().map(|row| s(&row["name"]).to_owned()).collect()
}
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .map(|e| e.unwrap())
        .filter(|e| e.file_type().is_file())
        .map(|e| (e.path().to_owned(), fs::read(e.path()).unwrap()))
        .collect()
}
#[cfg(unix)]
fn link(source: &Path, target: &Path) {
    std::os::unix::fs::symlink(source, target).unwrap();
}
fn native(config: &Path, space: &str, app: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
        .args(["resolve_doc_pins", "--config"])
        .arg(config)
        .args(["--space", space])
        .env("HERDR_APP_HOME", app)
        .env("HOME", app.parent().unwrap().join("user"))
        .env("USERPROFILE", app.parent().unwrap().join("user"))
        .output()
        .unwrap()
}

#[test]
#[cfg(unix)]
fn test_filter_extensions_and_latest_order_without_following_links() {
    let f = Temp::new();
    for name in [
        "PMO-old.md",
        "PMO-new.pdf",
        "PMO-sheet.xlsx",
        "PMO-word.docx",
        "other.md",
        "PMO.before-old.md",
        "latest.md",
        "PMO.txt",
    ] {
        f.file(name, "test");
    }
    at(&f.root.join("PMO-new.pdf"), 100);
    at(&f.root.join("PMO-old.md"), 90);
    link(&f.root.join("PMO-old.md"), &f.root.join("PMO-link.md"));
    let rows = docs(&[json!({"path":f.root,"match":["pmo"]})], false);
    assert_eq!(
        names(&rows).into_iter().collect::<BTreeSet<_>>(),
        [
            "PMO-old.md",
            "PMO-new.pdf",
            "PMO-sheet.xlsx",
            "PMO-word.docx"
        ]
        .map(str::to_owned)
        .into()
    );
    let names = names(&rows);
    assert!(
        names.iter().position(|n| n == "PMO-new.pdf")
            < names.iter().position(|n| n == "PMO-old.md")
    );
}
#[test]
#[cfg(unix)]
fn test_real_files_and_unowned_symlinks_are_never_replaced_or_deleted() {
    let f = Temp::new();
    let source = f.file("source/guide.md", "original");
    let target = f.root.join("project");
    write(&target, "guide.md", "user document");
    link(&f.root.join("missing"), &target.join("unowned.md"));
    assert_eq!(
        pins::owned_links(&target, &[json!({"path":source,"name":"guide.md"})]).unwrap(),
        None
    );
    let manifest = read_json(target.join(".herdr-document-links.json")).unwrap();
    let managed = manifest["links"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap();
    assert_ne!(managed, "guide.md");
    assert!(fs::symlink_metadata(target.join(managed))
        .unwrap()
        .file_type()
        .is_symlink());
    fs::remove_file(target.join(managed)).unwrap();
    fs::write(target.join(managed), "another user document").unwrap();
    fs::remove_file(source).unwrap();
    pins::owned_links(&target, &[]).unwrap();
    assert_eq!(
        fs::read_to_string(target.join("guide.md")).unwrap(),
        "user document"
    );
    assert_eq!(
        fs::read_to_string(target.join(managed)).unwrap(),
        "another user document"
    );
    assert!(fs::symlink_metadata(target.join("unowned.md"))
        .unwrap()
        .file_type()
        .is_symlink());
}
#[test]
#[cfg(unix)]
fn test_only_missing_sources_remove_owned_links_and_excluded_sources_stay() {
    let f = Temp::new();
    let target = f.root.join("out");
    let doc = f.file("guide.md", "original");
    pins::owned_links(&target, &[json!({"path":doc,"name":"guide.md"})]).unwrap();
    pins::owned_links(&target, &[]).unwrap();
    assert!(fs::symlink_metadata(target.join("guide.md"))
        .unwrap()
        .file_type()
        .is_symlink());
    fs::remove_file(doc).unwrap();
    pins::owned_links(&target, &[]).unwrap();
    assert!(fs::symlink_metadata(target.join("guide.md")).is_err());
}
#[test]
fn test_stable_index_and_manifest_conflict_preserve_user_files() {
    let f = Temp::new();
    f.file("source/guide.md", "guide");
    let manifest = f.file("target/.herdr-document-links.json", "user content");
    let config = f.root.join("config.json");
    json_file(
        &config,
        &json!({"version":1,"spaces":{"Demo":{"folders":[f.root.join("source")],"target":f.root.join("target")}}}),
    );
    let index = f.root.join("index.json");
    let result = pins::collect(&config, &index, None).unwrap();
    let before = fs::metadata(&index).unwrap().modified().unwrap();
    pins::collect(&config, &index, None).unwrap();
    assert_eq!(fs::metadata(index).unwrap().modified().unwrap(), before);
    assert_eq!(fs::read_to_string(manifest).unwrap(), "user content");
    assert_eq!(result["spaces"]["Demo"]["warning"], "manifest_conflict");
}
#[test]
fn test_inaccessible_or_missing_source_is_not_silently_reported_as_empty() {
    let f = Temp::new();
    let mut warnings = vec![];
    assert!(pins::documents(&[json!(f.root.join("missing"))], &mut warnings, false).is_empty());
    assert_eq!(warnings, vec!["source_unavailable"]);
}
#[test]
fn test_korean_filename_and_match_accept_both_nfc_and_nfd_without_renaming() {
    for file_nfd in [false, true] {
        for match_nfd in [false, true] {
            let f = Temp::new();
            let name = if file_nfd {
                "프로젝트비-보고서-PB.md".nfd().collect::<String>()
            } else {
                "프로젝트비-보고서-PB.md".into()
            };
            f.file(&name, "original document");
            let before = fs::read_dir(&f.root)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>();
            let term = if match_nfd {
                "프로젝트비".nfd().collect::<String>()
            } else {
                "프로젝트비".into()
            };
            let rows = docs(&[json!({"path":f.root,"match":[term]})], false);
            assert_eq!(rows.len(), 1);
            assert_eq!(
                s(&rows[0]["name"]).nfc().collect::<String>(),
                "프로젝트비-보고서-PB.md"
            );
            assert_eq!(
                fs::read_to_string(s(&rows[0]["path"])).unwrap(),
                "original document"
            );
            assert_eq!(
                fs::read_dir(&f.root)
                    .unwrap()
                    .map(|e| e.unwrap().file_name())
                    .collect::<Vec<_>>(),
                before
            );
            assert!(docs(&[json!({"path":f.root,"match":"다른프로젝트"})], false).is_empty());
        }
    }
}
#[test]
fn test_archive_classification_and_original_folder_structure() {
    let f = Temp::new();
    let source = f.root.join("source");
    let mut paths = vec![
        "current/guide.md".to_owned(),
        "Archive/old.pdf".into(),
        "ARCHIVE-backup/old.docx".into(),
        "아카이브/old.xlsx".into(),
        "보관함/old.md".into(),
        "current/guide.before-update.md".into(),
        "current/.before-guide.md".into(),
    ];
    paths.push("아카이브-한글/보고서.md".nfd().collect());
    for name in &paths {
        write(&source, name, name);
    }
    // The source uses str(relative_path), whose separator is a platform
    // transport. Keep its Windows spelling without changing any returned row.
    let current = Path::new("current")
        .join("guide.md")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        docs(&[json!(source)], false)
            .iter()
            .map(|r| s(&r["relativePath"]))
            .collect::<Vec<_>>(),
        vec![current.as_str()]
    );
    let rows = docs(&[json!(source)], true);
    assert_eq!(rows.len(), paths.len());
    for row in rows {
        assert_eq!(row["sourceRoot"], json!(source));
        assert_eq!(
            row["folder"],
            json!(Path::new(s(&row["path"])).parent().unwrap())
        );
        assert_eq!(row["archived"], json!(s(&row["relativePath"]) != current));
        let relative = s(&row["relativePath"]);
        // Input file bytes contain the original literal slash-delimited names;
        // on POSIX this is also exactly the original relativePath assertion.
        let expected = paths
            .iter()
            .find(|name| source.join(name) == source.join(relative))
            .unwrap();
        assert_eq!(
            fs::read_to_string(source.join(relative)).unwrap(),
            *expected
        );
    }
}
#[test]
fn test_archive_source_root_is_classified_and_index_keeps_it_without_new_links() {
    let f = Temp::new();
    let doc = f.file("보관/guide.md", "original");
    let source = doc.parent().unwrap();
    let config = f.root.join("config.json");
    json_file(
        &config,
        &json!({"version":1,"spaces":{"Demo":{"folders":[source],"target":f.root.join("target")}}}),
    );
    let original_config = fs::read(&config).unwrap();
    let original_doc = fs::read(&doc).unwrap();
    assert!(docs(&[json!(source)], false).is_empty());
    let output = pins::collect(&config, &f.root.join("index.json"), None).unwrap();
    let row = &output["spaces"]["Demo"]["files"][0];
    assert_eq!(row["archived"], true);
    assert_eq!(row["relativePath"], "guide.md");
    assert!(fs::symlink_metadata(f.root.join("target/guide.md")).is_err());
    assert_eq!(fs::read(config).unwrap(), original_config);
    assert_eq!(fs::read(doc).unwrap(), original_doc);
}
#[test]
fn test_spaces_with_only_doc_tab_rules_are_indexed_by_id_without_links() {
    let f = Temp::new();
    f.file("docs/guide.md", "x");
    let config = f.root.join("config.json");
    let rules = f.root.join("pins.json");
    json_file(
        &config,
        &json!({"version":1,"spaces":{"Demo":{"folders":[f.root.join("docs")],"target":f.root.join("target")}}}),
    );
    json_file(
        &rules,
        &json!({"version":1,"spaces":{"sp-demo":{"name":"Demo","folders":[f.root.join("docs")]},"sp-share":{"name":"Share","folders":[f.root.join("docs")]}}}),
    );
    let output = pins::collect(&config, &f.root.join("index.json"), Some(&rules)).unwrap();
    assert_eq!(
        output["spaces"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        ["Demo".to_owned(), "sp-share".into()].into()
    );
    assert_eq!(output["spaces"]["sp-share"]["files"][0]["name"], "guide.md");
    let mut names = fs::read_dir(&f.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        vec!["config.json", "docs", "index.json", "pins.json", "target"]
    );
}

struct Pins {
    temp: Temp,
    config: Value,
    day: NaiveDate,
}
impl Pins {
    fn new() -> Self {
        let temp = Temp::new();
        Self {
            config: json!({"version":1,"spaces":{"sp":{"name":"Demo","folders":[temp.root],"pins":[],"recent":{"limit":6,"days":14}}}}),
            temp,
            day: NaiveDate::from_ymd_opt(2026, 11, 2).unwrap(),
        }
    }
    fn file(&self, name: &str) -> PathBuf {
        self.temp.file(name, "original")
    }
    fn rows(&self) -> Vec<Value> {
        pins::resolve(&self.config, "sp", self.day).unwrap()["documents"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn latest(&mut self, topic: &str, root: Option<&Path>) {
        self.config["spaces"]["sp"]["pins"].as_array_mut().unwrap().push(json!({"id":"always","label":"구조","kind":"latest","root":root.unwrap_or(&self.temp.root),"topic":topic}));
    }
}
#[test]
fn test_latest_date_beats_mtime_and_preserves_topic_id() {
    let mut f = Pins::new();
    let old = f.file("20261029_프로젝트비_구조.md");
    let fresh = f.file("20261102_프로젝트비_구조.md");
    at(&old, 2_000_000_000);
    f.latest("프로젝트비_구조.md", None);
    assert_eq!(f.rows()[0]["path"], json!(fresh));
    assert_eq!(f.rows()[0]["id"], "always");
    let newest = f.temp.file("20261102_프로젝트비_구조.md", "updated");
    assert_eq!(f.rows()[0]["path"], json!(newest));
    assert_eq!(fs::read_to_string(old).unwrap(), "original");
}
#[test]
fn test_iso_dates_share_topic_with_compact_dates() {
    let mut f = Pins::new();
    f.file("20261029_pmo-회신.md");
    let fresh = f.file("2026-11-02-pmo-회신.md");
    f.file("2026-11-03-pmo-회신.md");
    f.latest("pmo-회신.md", None);
    assert_eq!(f.rows()[0]["path"], json!(fresh));
    assert_eq!(f.rows().len(), 1);
}
#[test]
fn test_nonrecursive_pin_ignores_shared_copy_collisions_and_follows_new_date() {
    let mut f = Pins::new();
    f.file("20261029_전체구조.md");
    f.file("shared/20261102_전체구조.md");
    f.file("other/20261102_전체구조.md");
    f.latest("전체구조.md", None);
    f.config["spaces"]["sp"]["pins"][0]["recursive"] = json!(false);
    assert_eq!(f.rows()[0]["name"], "20261029_전체구조.md");
    let fresh = f.file("20261102_전체구조.md");
    assert_eq!(f.rows()[0]["path"], json!(fresh));
    f.config["spaces"]["sp"]["pins"][0]
        .as_object_mut()
        .unwrap()
        .remove("recursive");
    f.config["spaces"]["sp"]["pins"][0]["depth"] = json!(1);
    assert_eq!(f.rows()[0]["path"], json!(fresh));
}
#[test]
#[cfg(unix)]
fn test_archives_symlinks_and_future_versions_are_excluded() {
    let mut f = Pins::new();
    let good = f.file("20261101_구조.md");
    for prefix in ["archive", "아카이브", "보관", ".before-v1"] {
        f.file(&format!("{prefix}/20261102_구조.md"));
    }
    f.file("20261103_구조.md");
    let outside = f.file("other/20261102_구조.md");
    let approved = f.temp.root.join("approved");
    f.latest("구조.md", Some(&approved));
    fs::create_dir(&approved).unwrap();
    fs::write(approved.join(good.file_name().unwrap()), "safe").unwrap();
    link(&outside, &approved.join(outside.file_name().unwrap()));
    link(outside.parent().unwrap(), &approved.join("nested"));
    assert_eq!(
        f.rows()[0]["path"],
        json!(approved.join(good.file_name().unwrap()))
    );
}
#[test]
fn test_same_date_collision_is_visible_and_missing_pin_is_retained() {
    let mut f = Pins::new();
    f.file("a/20261102_구조.md");
    f.file("b/20261102_구조.md");
    f.latest("구조.md", None);
    let row = f.rows()[0].clone();
    assert_eq!(row["status"], "conflict");
    assert!(row["path"].is_null());
    assert_eq!(row["candidates"].as_array().unwrap().len(), 2);
    f.config["spaces"]["sp"]["pins"].as_array_mut().unwrap().push(json!({"id":"gone","label":"missing","kind":"file","path":f.temp.root.join("missing.md")}));
    assert_eq!(f.rows()[1]["status"], "missing");
    assert_eq!(f.rows()[1]["id"], "gone");
}
#[test]
fn test_recent_fourteen_day_window_topic_grouping_limit_and_no_pin_duplicate() {
    let mut f = Pins::new();
    for day in 20..32 {
        f.file(&format!("202610{day}_확인요청-{day}.md"));
    }
    f.file("20261019_회신-old.md");
    f.file("20261029_회신-topic.md");
    let latest = f.file("20261102_회신-topic.md");
    f.file("20261103_회신-future.md");
    f.file("20261102_일반노트.md");
    f.file("archive/20261102_회신-archive.md");
    let rows = f.rows();
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0]["path"], json!(latest));
    assert_eq!(
        rows.iter()
            .filter(|r| r["topic"] == "회신-topic.md")
            .count(),
        1
    );
    f.latest("회신-topic.md", None);
    assert_eq!(f.rows().len(), 7);
    assert_eq!(
        f.rows()
            .iter()
            .filter(|r| r["topic"] == "회신-topic.md")
            .count(),
        1
    );
    f.config["spaces"]["sp"]["recent"]["limit"] = json!(12);
    let all = names(&f.rows());
    assert!(!all.contains(&"20261019_회신-old.md".into()));
    assert!(!all.contains(&"20261103_회신-future.md".into()));
}
#[test]
fn test_unicode_topic_and_recent_keyword_normalization() {
    let mut f = Pins::new();
    let target = f.file("20261102_프로젝트비_회신.md");
    f.latest("프로젝트비_회신.md", None);
    f.config["spaces"]["sp"]["pins"][0]["topic"] =
        json!("프로젝트비_회신.md".nfd().collect::<String>());
    assert_eq!(f.rows()[0]["path"], json!(target));
}
#[test]
fn test_missing_source_warning_is_not_an_empty_success() {
    let mut f = Pins::new();
    f.config["spaces"]["sp"]["folders"] = json!([f.temp.root.join("unavailable")]);
    let output = pins::resolve(&f.config, "sp", f.day).unwrap();
    assert!(output["warnings"]
        .as_array()
        .unwrap()
        .contains(&json!("source_unavailable")));
    assert_eq!(output["documents"], json!([]));
}
#[test]
#[cfg(unix)]
fn test_file_pin_rejects_archive_symlink_and_escape() {
    let mut f = Pins::new();
    let source = f.file("source.md");
    let linked = f.temp.root.join("linked.md");
    link(&source, &linked);
    let archive = f.file("archive/doc.md");
    for (path, root) in [
        (linked, f.temp.root.clone()),
        (source, f.temp.root.join("scope")),
        (archive, f.temp.root.clone()),
    ] {
        f.config["spaces"]["sp"]["pins"] =
            json!([{"id":"bad","label":"bad","kind":"file","path":path,"root":root}]);
        assert_eq!(f.rows()[0]["status"], "error");
    }
}
#[test]
fn test_pin_unpin_only_changes_rules_and_excludes_auto_topic() {
    let mut f = Pins::new();
    let path = f.file("20261102_회신-topic.md");
    let before = fs::read(&path).unwrap();
    pins::mutate(&mut f.config, "sp", path.to_str(), None, None).unwrap();
    let rows = f.rows();
    assert_eq!(rows[0]["pinned"], true);
    assert_eq!(rows[0]["kind"], "latest");
    pins::mutate(&mut f.config, "sp", None, rows[0]["id"].as_str(), None).unwrap();
    assert!(f.rows().is_empty());
    pins::mutate(&mut f.config, "sp", path.to_str(), None, None).unwrap();
    assert_eq!(f.rows().len(), 1);
    assert_eq!(fs::read(path).unwrap(), before);
}
#[test]
fn test_read_only_cli_never_writes_index_links_or_rules() {
    let f = Pins::new();
    f.file("20261102_회신-topic.md");
    let config = f.temp.root.join("rules.json");
    json_file(&config, &f.config);
    let before = snapshot(&f.temp.root);
    let result = native(&config, "sp", &f.temp.root.join("app"));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&result.stdout).unwrap()["spaceId"],
        "sp"
    );
    assert_eq!(before, snapshot(&f.temp.root));
    assert!(!config.with_extension("lock").exists());
}
#[test]
fn test_source_permission_failure_retains_pin() {
    let mut f = Pins::new();
    let target = f.file("struct.md");
    f.config["spaces"]["sp"]["pins"] =
        json!([{"id":"always","label":"structure","kind":"file","path":target}]);
    let result = pins::resolve_with_file_probe(&f.config, "sp", f.day, &|_| {
        Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied").into())
    })
    .unwrap();
    assert_eq!(result["documents"][0]["status"], "error");
}

struct Routed {
    temp: Temp,
    reports: PathBuf,
    downloads: PathBuf,
    app: PathBuf,
    routing: Value,
    config: Value,
    day: NaiveDate,
}
impl Routed {
    fn new() -> Self {
        let temp = Temp::new();
        let reports = temp.root.join("reports");
        let downloads = temp.root.join("downloads");
        let app = temp.root.join("app");
        let routing_file = temp.root.join("project-docs-routing.local.json");
        json_file(
            &routing_file,
            &json!({"version":1,"fallback":"Share","sources":[{"path":reports},{"path":downloads,"depth":1,"requireMatch":true}],"spaces":{"Alpha":{"terms":["alpha","알파"]},"Beta":{"terms":["beta","베타"]}}}),
        );
        let routing = routing::load(&routing_file).unwrap();
        Self {
            temp,
            reports,
            downloads,
            app,
            routing,
            config: json!({"version":1,"spaces":{"sp-a":{"name":"Alpha","folders":[],"pins":[]},"sp-b":{"name":"Beta","folders":[],"pins":[]},"sp-s":{"name":"Share","folders":[],"pins":[]}}}),
            day: NaiveDate::from_ymd_opt(2026, 11, 5).unwrap(),
        }
    }
    fn file(&self, downloads: bool, name: &str, text: &str, mtime: Option<i64>) -> PathBuf {
        let path = write(
            if downloads {
                &self.downloads
            } else {
                &self.reports
            },
            name,
            text,
        );
        if let Some(stamp) = mtime {
            at(&path, stamp);
        }
        path
    }
    fn catalog(&self, space: &str) -> Value {
        pins::catalog(&self.config, space, self.day, &self.app, &self.routing).unwrap()
    }
    fn names(&self, space: &str) -> Vec<String> {
        self.catalog(space)["documents"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["harness"] != true && d["state"] != "previous")
            .map(|d| s(&d["name"]).to_owned())
            .collect()
    }
}
#[test]
fn test_name_title_and_body_words_pick_the_space() {
    let f = Routed::new();
    f.file(false, "20261105_알파_현황.md", "본문", None);
    f.file(
        false,
        "notes.html",
        "<html><head><title>Beta 견적</title></head><body>x</body></html>",
        None,
    );
    f.file(false, "memo.md", "# 메모\n\n이번 주 alpha 일정 정리", None);
    let mut names = f.names("sp-a");
    names.sort();
    assert_eq!(names, vec!["20261105_알파_현황.md", "memo.md"]);
    assert_eq!(f.names("sp-b"), vec!["notes.html"]);
}
#[test]
fn test_a_path_word_outweighs_a_body_mention_and_ties_go_to_the_fallback() {
    let f = Routed::new();
    f.file(false, "alpha/회신.md", "beta 쪽 문의도 참고", None);
    f.file(false, "공통_정리.md", "alpha 와 beta 모두", None);
    f.file(false, "일지.md", "아무 단어 없음", None);
    assert_eq!(f.names("sp-a"), vec!["회신.md"]);
    let mut names = f.names("sp-s");
    names.sort();
    assert_eq!(names, vec!["공통_정리.md", "일지.md"]);
}
#[test]
fn test_downloads_list_only_matching_documents_at_the_top_level() {
    let f = Routed::new();
    f.file(true, "ALPHA-비용-초안.html", "<title>초안</title>", None);
    f.file(true, "개인_계약서.pdf", "본문", None);
    f.file(true, "photo.png", "본문", None);
    f.file(true, "deep/alpha-old.md", "본문", None);
    assert_eq!(f.names("sp-a"), vec!["ALPHA-비용-초안.html"]);
    assert!(f.names("sp-s").is_empty());
}
#[test]
fn test_routed_files_are_not_moved_and_are_watched() {
    let f = Routed::new();
    let path = f.file(true, "alpha.md", "본문", None);
    let data = f.catalog("sp-a");
    let row = data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "alpha.md")
        .unwrap();
    assert_eq!(row["path"], json!(path));
    assert_eq!(row["routedFrom"], json!(f.downloads));
    assert!(path.is_file());
    assert!(data["watchRoots"]
        .as_array()
        .unwrap()
        .contains(&json!(f.downloads)));
    let no_routing = pins::catalog(&f.config, "sp-a", f.day, &f.app, &json!({})).unwrap();
    assert!(!no_routing["watchRoots"]
        .as_array()
        .unwrap()
        .contains(&json!(f.downloads)));
}
#[test]
fn test_newest_write_comes_first_whatever_the_name_date() {
    let f = Routed::new();
    f.file(false, "20261104_alpha_a.md", "본문", Some(1_700_000_000));
    f.file(false, "20261101_alpha_b.md", "본문", Some(1_700_000_500));
    f.file(false, "alpha_c.md", "본문", Some(1_700_000_100));
    assert_eq!(
        f.names("sp-a"),
        vec!["20261101_alpha_b.md", "alpha_c.md", "20261104_alpha_a.md"]
    );
}
#[test]
fn test_pins_and_folders_stay_and_a_file_is_listed_once() {
    let mut f = Routed::new();
    let pinned = f.file(false, "alpha_arch.md", "본문", None);
    let own = f.temp.root.join("alpha-docs");
    write(&own, "plan.md", "본문");
    f.config["spaces"]["sp-a"]["folders"] = json!([own,{"path":f.reports,"match":["alpha"]}]);
    f.config["spaces"]["sp-a"]["pins"] =
        json!([{"id":"p1","label":"구조","kind":"file","path":pinned}]);
    let data = f.catalog("sp-a");
    let rows = data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["harness"] != true)
        .collect::<Vec<_>>();
    assert_eq!(rows[0]["id"], "p1");
    assert_eq!(rows[0]["pinned"], true);
    let mut names = rows.iter().map(|d| s(&d["name"])).collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["alpha_arch.md", "plan.md"]);
}
#[test]
fn test_title_decides_the_kind_when_the_name_says_nothing() {
    let f = Routed::new();
    f.file(false, "alpha_x.md", "# 고객 회신안\n", None);
    let data = f.catalog("sp-a");
    let row = data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "alpha_x.md")
        .unwrap();
    assert_eq!(row["kind"], "reply");
}
#[test]
fn test_unknown_space_or_missing_file_routes_nothing() {
    let mut f = Routed::new();
    f.file(false, "alpha.md", "본문", None);
    f.config["spaces"]["sp-x"] = json!({"name":"Gamma","folders":[],"pins":[]});
    assert!(f.names("sp-x").is_empty());
    assert!(routing::load(&f.temp.root.join("missing.json")).is_none());
    assert!(routing::routed(&Value::Null, "Alpha", &mut vec![]).is_empty());
}
#[test]
fn test_cli_reads_the_routing_file_beside_the_rules() {
    let f = Routed::new();
    f.file(true, "alpha.md", "본문", None);
    let config = f.temp.root.join("project-docs-pins.json");
    json_file(&config, &f.config);
    let result = native(&config, "sp-a", &f.app);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let output: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(names(output["documents"].as_array().unwrap()).contains(&"alpha.md".into()));
}
