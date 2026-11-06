//! Actual WebKit integration, entirely in a scratch app home.
//! CI supplies the pinned public Mermaid library through HERDR_TEST_MERMAID_JS.
#![cfg(target_os = "macos")]
use herdr_theme::documents::{common::*, install, render};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn invoke(home: &Path, command_name: &str, args: &[&str]) -> Value {
    let output = timeout_output(
        command(env!("CARGO_BIN_EXE_herdr-theme"))
            .arg(command_name)
            .args(args)
            .env("HERDR_APP_HOME", home),
        75,
    )
    .unwrap();
    assert!(
        output.status.success(),
        "{command_name}: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn image_record(home: &Path, page: &Value) -> (Vec<u8>, std::time::SystemTime) {
    let path = home.join(s(&page["path"]));
    let (width, height) = render::png_size(&path).unwrap();
    assert_eq!(width as f64, page["width"].as_f64().unwrap() * 2.0);
    assert_eq!(height as f64, page["height"].as_f64().unwrap() * 2.0);
    (
        fs::read(&path).unwrap(),
        fs::metadata(path).unwrap().modified().unwrap(),
    )
}
fn original_live_render(html: &str) -> Value {
    let temp = tempfile::tempdir().unwrap();
    let binary = temp.path().join("render-html");
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    install::compile_swift(&repo.join("scripts/render_html.swift"), &binary, true).unwrap();
    let doc = temp.path().join("page.html");
    fs::write(&doc, html).unwrap();
    let output = timeout_output(
        command(&binary)
            .arg(&doc)
            .arg(temp.path().join("out/tile"))
            .args(["dark", "600"]),
        60,
    )
    .unwrap();
    assert!(
        output.status.success(),
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn test_short_page_is_as_tall_as_its_content() {
    let data = original_live_render("<p style=\"margin:0;height:150px\">짧은 문서</p>");
    assert_eq!(
        arr(&data["tiles"])
            .iter()
            .map(|t| (t["width"].as_f64().unwrap(), t["height"].as_f64().unwrap()))
            .collect::<Vec<_>>(),
        vec![(600., 168.)]
    );
}
#[test]
fn test_viewport_height_sections_and_late_script_content_are_measured_once() {
    let data = original_live_render("<!doctype html><body style=\"margin:0\"><div style=\"height:100vh\"></div><div style=\"height:3000px\"></div><div id=late></div><script>setTimeout(()=>{late.style.height=\"500px\"},700)</script></body>");
    let heights = arr(&data["tiles"])
        .iter()
        .map(|t| t["height"].as_f64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(heights.iter().sum::<f64>(), 4700.);
    assert_eq!(heights, vec![2000., 2000., 700.]);
    assert_eq!(data["truncated"], false);
}
#[test]
#[ignore = "CI opt-in: actual macOS Swift/WebKit renderers, scratch only"]
fn actual_webkit_renderers_match_native_cache_and_dimension_contracts() {
    assert_eq!(
        std::env::var("HERDR_RENDER_LIVE").as_deref(),
        Ok("1"),
        "explicit HERDR_RENDER_LIVE=1 required"
    );
    let mermaid = PathBuf::from(
        std::env::var_os("HERDR_TEST_MERMAID_JS")
            .expect("CI must supply the pinned public Mermaid library"),
    );
    assert!(mermaid.is_file());
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("app");
    let tools = home.join("data/sixfold/doc-tabs");
    fs::create_dir_all(tools.join("mermaid")).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    install::compile_swift(
        &repo.join("scripts/render_html.swift"),
        &tools.join("render-html"),
        true,
    )
    .unwrap();
    install::compile_swift(
        &repo.join("scripts/render_mermaid.swift"),
        &tools.join("render-mermaid"),
        true,
    )
    .unwrap();
    copy_file(&mermaid, tools.join("mermaid/mermaid.min.js")).unwrap();
    let doc = temp.path().join("public-report.html");
    fs::write(&doc,"<!doctype html><meta charset='utf-8'><style>html,body{margin:0;padding:0}</style><body><div style='height:150px'>Deterministic public report</div></body>").unwrap();
    let doc_arg = doc.to_str().unwrap();
    let first = invoke(
        &home,
        "render_html",
        &["--doc", doc_arg, "--theme", "dark", "--width", "797"],
    );
    assert_eq!(first["width"], 760);
    assert_eq!(first["truncated"], false);
    assert_eq!(first["interactive"], json!([]));
    assert_eq!(arr(&first["pages"]).len(), 1);
    assert_eq!(first["pages"][0]["width"], json!(760.0));
    assert_eq!(first["pages"][0]["height"], json!(150.0));
    let original_image = image_record(&home, &first["pages"][0]);
    let same = invoke(
        &home,
        "render_html",
        &["--doc", doc_arg, "--theme", "dark", "--width", "770"],
    );
    assert_eq!(same, first);
    assert_eq!(
        image_record(&home, &same["pages"][0]),
        original_image,
        "same width bucket reuses the PNG without rewriting it"
    );
    let narrow = invoke(
        &home,
        "render_html",
        &["--doc", doc_arg, "--theme", "dark", "--width", "100"],
    );
    assert_eq!(narrow["width"], 320);
    assert_ne!(narrow["pages"][0]["path"], first["pages"][0]["path"]);
    image_record(&home, &narrow["pages"][0]);
    fs::write(&doc,"<!doctype html><body style='margin:0'><div style='height:100vh'></div><div style='height:3000px'></div><div id='late'></div><script>setTimeout(()=>late.style.height='500px',700)</script></body>").unwrap();
    let tall = invoke(
        &home,
        "render_html",
        &["--doc", doc_arg, "--theme", "light", "--width", "600"],
    );
    assert_eq!(
        arr(&tall["pages"])
            .iter()
            .map(|p| p["height"].as_f64().unwrap())
            .collect::<Vec<_>>(),
        vec![2000.0, 2000.0, 700.0]
    );
    assert_eq!(tall["truncated"], false);
    for page in arr(&tall["pages"]) {
        image_record(&home, &page);
    }
    // Exact original LiveRendererTests short-page fixture, including the
    // default eight-pixel body margins above and below its 150px content.
    fs::write(&doc, "<p style=\"margin:0;height:150px\">짧은 문서</p>").unwrap();
    let short = invoke(
        &home,
        "render_html",
        &["--doc", doc_arg, "--theme", "dark", "--width", "600"],
    );
    assert_eq!(
        arr(&short["pages"])
            .iter()
            .map(|p| (p["width"].as_f64().unwrap(), p["height"].as_f64().unwrap()))
            .collect::<Vec<_>>(),
        vec![(600., 168.)]
    );
    let diagram = temp.path().join("public-diagram.md");
    fs::write(&diagram,"```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n").unwrap();
    let diagram_arg = diagram.to_str().unwrap();
    let first = invoke(
        &home,
        "render_mermaid",
        &[
            "--doc",
            diagram_arg,
            "--theme",
            "dark",
            "--background",
            "#112233",
        ],
    );
    assert_eq!(
        arr(&first["diagrams"]).len(),
        1,
        "duplicate code renders once"
    );
    assert!(first["diagrams"][0]["error"].is_null(), "{first}");
    assert!(first["diagrams"][0]["width"].as_f64().unwrap() > 0.0);
    assert!(first["diagrams"][0]["height"].as_f64().unwrap() > 0.0);
    let original = image_record(&home, &first["diagrams"][0]);
    let same = invoke(
        &home,
        "render_mermaid",
        &[
            "--doc",
            diagram_arg,
            "--theme",
            "dark",
            "--background",
            "#112233",
        ],
    );
    assert_eq!(same, first);
    assert_eq!(
        image_record(&home, &same["diagrams"][0]),
        original,
        "cached diagram PNG is unchanged"
    );
    let light = invoke(
        &home,
        "render_mermaid",
        &[
            "--doc",
            diagram_arg,
            "--theme",
            "light",
            "--background",
            "#ffffff",
        ],
    );
    assert_ne!(light["diagrams"][0]["path"], first["diagrams"][0]["path"]);
    image_record(&home, &light["diagrams"][0]);
    if let Some(path) = std::env::var_os("HERDR_RENDER_EVIDENCE") {
        atomic_json(PathBuf::from(path),&json!({
            "passed":true,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"scratchOnly":true,
            "realSwiftWebKit":true,"htmlWidthBucket":760,"htmlShortHeight":150,
            "htmlLateViewportTiles":arr(&tall["pages"]).iter().map(|p|p["height"].clone()).collect::<Vec<_>>(),
            "htmlCacheReuseVerified":true,"htmlWidthInvalidationVerified":true,
            "mermaidDark":first,"mermaidLight":light,"mermaidCacheReuseVerified":true
        })).unwrap();
    }
}
