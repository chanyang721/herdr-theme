//! Original icon CLI bytes and seed action/finally contracts, in disposable homes.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/documents-workspace-cli.json")).unwrap()
}
fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec())
        .unwrap()
        .replace("\r\n", "\n")
}
fn command(name: &str, original: bool) -> Command {
    if original {
        let mut c = Command::new(
            std::env::var_os("HERDR_THEME_ORACLE_PYTHON")
                .expect("external baseline Python required"),
        );
        let scripts = PathBuf::from(
            std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS")
                .expect("external baseline scripts required"),
        );
        c.args(["-X", "utf8"])
            .arg(scripts.join(format!("{name}.py")));
        c
    } else {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.arg(name);
        c
    }
}
fn icons(original: bool) {
    for case in corpus()["icon"].as_array().unwrap() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        let data = app.join("data/sixfold");
        fs::create_dir_all(&data).unwrap();
        let path = data.join("workspace-icons.json");
        fs::write(&path, case["existing"].to_string()).unwrap();
        let source = temp
            .path()
            .join(format!("icon{}", case["extension"].as_str().unwrap()));
        fs::write(&source, case["body"].as_str().unwrap()).unwrap();
        filetime::set_file_times(
            &source,
            filetime::FileTime::from_unix_time(946684800, 0),
            filetime::FileTime::from_unix_time(946684800, 0),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let out = command("set_workspace_icon", original)
            .arg(case["workspace"].as_str().unwrap())
            .arg(&source)
            .args(
                case["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap()),
            )
            .env("HERDR_APP_HOME", &app)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code().map(i64::from),
            case["expected"]["exit"].as_i64(),
            "{}: {}",
            case["name"],
            text(&out.stderr)
        );
        assert_eq!(
            text(&out.stdout),
            case["expected"]["stdout"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        let content = fs::read(&path).unwrap();
        if out.status.success() {
            assert!(out.stderr.is_empty());
            assert_eq!(
                content,
                case["expected"]["text"].as_str().unwrap().as_bytes(),
                "{}",
                case["name"]
            );
            assert!(!content.ends_with(b"\n"));
        } else {
            assert!(text(&out.stderr).contains("use SVG, PNG, JPEG or WebP"));
            // Rejection leaves the original configuration bytes untouched.
            assert_eq!(content, case["existing"].to_string().as_bytes());
        }
        let files = fs::read_dir(data.join("icons"))
            .map(|r| r.map(|f| f.unwrap().path()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert_eq!(
            files.len() as u64,
            case["expected"]["copied"].as_u64().unwrap()
        );
        for copied in files {
            assert_eq!(
                fs::read(&copied).unwrap(),
                case["body"].as_str().unwrap().as_bytes()
            );
            let metadata = fs::metadata(&copied).unwrap();
            assert_eq!(
                filetime::FileTime::from_last_modification_time(&metadata).unix_seconds(),
                case["expected"]["mtime"].as_i64().unwrap()
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
                assert_eq!(
                    fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        assert!(!path.with_extension("tmp").exists());
    }
}
struct Seed {
    _temp: tempfile::TempDir,
    app: PathBuf,
    tool: PathBuf,
    schema: PathBuf,
    log: PathBuf,
    state: PathBuf,
}
impl Seed {
    fn new(case: &Value) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        fs::create_dir_all(app.join("data/sixfold")).unwrap();
        fs::write(
            app.join("data/sixfold/site.local.json"),
            json!({"fixed_space_names":case["names"]}).to_string(),
        )
        .unwrap();
        let tool = temp.path().join(if cfg!(windows) {
            "herdr-app.exe"
        } else {
            "herdr-app"
        });
        fs::copy(env!("CARGO_BIN_EXE_herdr-theme-test-fixture"), &tool).unwrap();
        let schema = temp.path().join("fixture.json");
        fs::write(&schema,json!({"allowWorkspaceSeed":true,"spaces":case["spaces"],"seedStatus":case["status"],"seedFailCreate":case["fail"]}).to_string()).unwrap();
        let log = temp.path().join("calls.jsonl");
        let state = temp.path().join("seed-state.json");
        Self {
            _temp: temp,
            app,
            tool,
            schema,
            log,
            state,
        }
    }
    fn invoke(&self, original: bool) -> Output {
        command("seed_workspace_pins", original)
            .arg("--ensure-spaces")
            .env("HERDR_APP_HOME", &self.app)
            .env("HERDR_APP_BIN", &self.tool)
            .env("HERDR_TEST_FIXTURE", &self.schema)
            .env("HERDR_TEST_CALL_LOG", &self.log)
            .env("PYTHONUTF8", "1")
            .output()
            .unwrap()
    }
    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str::<Value>(s).unwrap()["args"].clone())
            .collect()
    }
}
fn read(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn seeds(original: bool) {
    for case in corpus()["seed"].as_array().unwrap() {
        let f = Seed::new(case);
        let out = f.invoke(original);
        assert_eq!(
            out.status.code().map(i64::from),
            case["expected"]["exit"].as_i64(),
            "{}: {}",
            case["name"],
            text(&out.stderr)
        );
        assert_eq!(
            json!(f.calls()),
            case["expected"]["calls"],
            "{}",
            case["name"]
        );
        assert_eq!(
            read(&f.state),
            case["expected"]["state"],
            "{}",
            case["name"]
        );
        let path = f.app.join("data/sixfold/workspace-pins.local.json");
        if case["expected"]["text"].is_null() {
            assert!(!path.exists());
            assert!(out.stdout.is_empty());
            assert!(!out.stderr.is_empty());
        } else {
            assert_eq!(
                text(&fs::read(&path).unwrap()),
                case["expected"]["text"].as_str().unwrap()
            );
            assert_eq!(text(&out.stdout), "Seeded workspace pins\n");
            assert!(out.stderr.is_empty());
            let calls = f.calls();
            let preserved = f.invoke(original);
            assert!(preserved.status.success());
            assert_eq!(
                text(&preserved.stdout),
                "Preserved existing workspace pins\n"
            );
            assert_eq!(f.calls(), calls, "existing pins must not contact the app");
        }
        assert!(!f.app.join("data/sixfold/workspace-pins-seed.lock").exists());
    }
}
#[test]
fn native_icons_match_original_cli_bytes_and_copy_metadata() {
    icons(false)
}
#[test]
fn native_seed_matches_original_action_order_and_error_finally_restore() {
    seeds(false)
}
#[test]
fn installed_pinned_javascript_dispatches_windows_unc_and_drive_homes() {
    let temp = tempfile::tempdir().unwrap();
    for (relative, helper, expected) in [
        (
            "mods/system-metrics/main.js",
            "system-metrics/sample.py",
            "pinned_system_metrics",
        ),
        (
            "mods/agent-usage/main.js",
            "agent-usage/collect.py",
            "pinned_agent_usage",
        ),
    ] {
        let source = temp.path().join("main.js");
        fs::write(
            &source,
            format!("globalThis.value = exec('python3', [`${{appHome()}}/mods/{helper}`]);"),
        )
        .unwrap();
        let adapted = String::from_utf8(
            herdr_theme::documents::install::source_payload(&source, Path::new(relative)).unwrap(),
        )
        .unwrap();
        let homes = [
            r"\\server\share\app",
            r"C:\fixture\app",
            "C:/fixture/app",
            "/fixture/app",
        ];
        let program = format!("const run = new Function('appHome','exec',{}); console.log(JSON.stringify({}.map(home=>run(()=>home,(...args)=>args))));", serde_json::to_string(&(adapted + "; return globalThis.value;")).unwrap(), serde_json::to_string(&homes).unwrap());
        let out = Command::new("node")
            .args(["-e", &program])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", text(&out.stderr));
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        for (index, home) in homes.iter().enumerate() {
            let suffix = if index < 3 { ".exe" } else { "" };
            assert_eq!(
                result[index],
                json!([
                    format!("{home}/scripts/sixfold/herdr-theme{suffix}"),
                    [expected]
                ]),
                "{relative}: {home}"
            );
        }
    }
}
#[test]
#[ignore = "manual comparison requires archived original scripts and an external Python executable"]
fn external_original_icon_and_seed_clis_match_frozen_contracts() {
    icons(true);
    seeds(true)
}
