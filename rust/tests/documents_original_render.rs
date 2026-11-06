//! Original render_html wrapper assertions with the original fake renderer's
//! output, implemented by an explicitly enabled native subprocess fixture.
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};
struct Renderer {
    _temp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    doc: PathBuf,
    binary: PathBuf,
    schema: PathBuf,
}
impl Renderer {
    fn new(installed: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let home = root.join("app");
        let tools = home.join("data/sixfold/doc-tabs");
        fs::create_dir_all(&tools).unwrap();
        let binary = tools.join("render-html");
        if installed {
            fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), &binary).unwrap();
        }
        let schema = root.join("fixture.json");
        fs::write(&schema, json!({"allowHtmlRenderer":true}).to_string()).unwrap();
        let doc = root.join("report.html");
        fs::write(&doc, "<html><body>표</body></html>").unwrap();
        Self {
            _temp: temp,
            root,
            home,
            doc,
            binary,
            schema,
        }
    }
    fn run(&self, width: &str) -> (i32, Value) {
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-theme"))
            .args(["render_html", "--doc"])
            .arg(&self.doc)
            .args(["--theme", "dark", "--width", width])
            .env("HERDR_APP_HOME", &self.home)
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HOME", &self.root)
            .env("USERPROFILE", &self.root)
            .output()
            .unwrap();
        assert!(
            out.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        (
            out.status.code().unwrap(),
            serde_json::from_slice(&out.stdout).unwrap(),
        )
    }
    fn runs(&self) -> String {
        fs::read_to_string(self.doc.with_extension("runs")).unwrap()
    }
}
#[test]
fn test_missing_renderer_reports_install_notice() {
    let f = Renderer::new(false);
    assert!(!f.binary.exists());
    let (code, data) = f.run("960");
    assert_eq!(code, 1);
    assert!(data["error"]
        .as_str()
        .unwrap()
        .contains("설치되지 않았습니다"));
}
#[test]
fn test_tiles_are_cached_until_the_file_changes() {
    let f = Renderer::new(true);
    let (code, data) = f.run("960");
    assert_eq!(code, 0);
    assert_eq!(
        data["pages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p["width"].as_f64().unwrap(), p["height"].as_f64().unwrap()))
            .collect::<Vec<_>>(),
        vec![(960., 2000.), (960., 300.)]
    );
    assert!(data["pages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| f.home.join(p["path"].as_str().unwrap()).exists()));
    f.run("960");
    assert_eq!(f.runs(), "1");
    fs::write(&f.doc, "<html>바뀜</html>").unwrap();
    f.run("960");
    assert_eq!(f.runs(), "2");
}
#[test]
fn test_width_snaps_to_40px_steps_and_each_step_is_cached() {
    let f = Renderer::new(true);
    let (_, data) = f.run("797");
    assert_eq!(data["width"], 760);
    assert_eq!(data["pages"][0]["width"].as_f64(), Some(760.));
    f.run("770");
    assert_eq!(f.runs(), "1");
    let (_, data) = f.run("100");
    assert_eq!(data["width"], 320);
    assert_eq!(f.runs(), "2");
}
#[test]
fn test_static_page_is_not_interactive_but_controls_are() {
    let f = Renderer::new(true);
    let (_, data) = f.run("960");
    assert_eq!(data["interactive"], json!([]));
    assert_eq!(data["truncated"], false);
    fs::write(&f.doc,"<p>표</p><details><summary>더</summary></details><script>b.addEventListener(\"click\",f)</script>").unwrap();
    let (_, data) = f.run("960");
    assert_eq!(data["interactive"], json!(["스크립트 이벤트", "펼침 영역"]));
}
#[cfg(windows)]
#[test]
fn test_browser_reuses_ego_profile_and_hides_console() {
    use herdr_theme::documents::{common::resolved, render::windows_desktop_command};
    let temp = tempfile::tempdir().unwrap();
    let document = temp.path().join("한글 보고서.html");
    fs::write(&document, "<p>document</p>").unwrap();
    let document = resolved(document.canonicalize().unwrap());
    let program_files = temp.path().join("Program Files");
    let executable = program_files.join("Citro Labs/ego lite/Application/ego.exe");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), &executable).unwrap();
    let schema = temp.path().join("fixture.json");
    fs::write(&schema, json!({"allowDesktopBrowser":true}).to_string()).unwrap();
    let mut cmd = windows_desktop_command(
        "browser",
        &document,
        &|key| {
            if key == "ProgramFiles" {
                program_files.to_string_lossy().into_owned()
            } else {
                temp.path().join("Local").to_string_lossy().into_owned()
            }
        },
        &|path| path.file_name().is_some_and(|name| name == "ego.exe") || path.is_file(),
    )
    .unwrap();
    assert_eq!(
        std::path::Path::new(cmd.get_program()).file_name().unwrap(),
        "ego.exe"
    );
    assert_eq!(
        cmd.get_args().collect::<Vec<_>>(),
        vec![document.as_os_str()]
    );
    // Execute the inspected command against the explicit native fixture rather
    // than a browser. This checks CREATE_NO_WINDOW on the actual launch path.
    let status = cmd.env("HERDR_TEST_FIXTURE", &schema).status().unwrap();
    assert!(status.success());
    let child: Value =
        serde_json::from_slice(&fs::read(temp.path().join("desktop-child.json")).unwrap()).unwrap();
    assert_eq!(child, json!({"has_console":false,"args":[document]}));
}
