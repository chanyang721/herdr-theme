//! Embedded fallback contract: real valid images, bounded parsing, full-byte cache.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/media-image-baseline.json")).unwrap()
}
fn body(case: &Value) -> Vec<u8> {
    if let Some(encoded) = case["body"]["base64"].as_str() {
        STANDARD.decode(encoded).unwrap()
    } else {
        let mut bytes = b"<!--".to_vec();
        bytes.extend(std::iter::repeat_n(
            b'x',
            case["body"]["repeat_comment_bytes"].as_u64().unwrap() as usize,
        ));
        bytes.extend(case["body"]["tail"].as_str().unwrap().as_bytes());
        bytes
    }
}
fn stdout(out: &Output) -> String {
    String::from_utf8(out.stdout.clone())
        .unwrap()
        .replace("\r\n", "\n")
}
fn invoke(source: &str, cache: &Path, original: Option<&str>) -> Output {
    let mut command = if let Some(code) = original {
        let mut c = Command::new(
            std::env::var_os("HERDR_THEME_ORACLE_PYTHON")
                .expect("external baseline Python required"),
        );
        c.args(["-X", "utf8", "-c", code]);
        c
    } else {
        let mut c = Command::new(env!("CARGO_BIN_EXE_herdr-theme"));
        c.arg("media_image");
        c
    };
    let out = command.arg(source).arg(cache).output().unwrap();
    assert!(
        out.status.success(),
        "{source}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    out
}
fn exercise(original: Option<&str>) {
    for case in corpus()["cases"].as_array().unwrap() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join(case["name"].as_str().unwrap());
        let bytes = body(case);
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            case["source_sha256"].as_str().unwrap()
        );
        fs::write(&source, &bytes).unwrap();
        let time = filetime::FileTime::from_unix_time(946684800, 123456700);
        filetime::set_file_times(&source, time, time).unwrap();
        let mut spellings = vec![source.to_str().unwrap().to_owned()];
        if cfg!(windows) {
            spellings.push(source.to_str().unwrap().replace('\\', "/"));
        }
        for (index, sourcearg) in spellings.iter().enumerate() {
            let cache = temp.path().join(format!("cache-{index}"));
            let out = invoke(sourcearg, &cache, None);
            let actual: Value = serde_json::from_slice(&out.stdout).unwrap();
            let ext = sourcearg.rsplit('.').next().unwrap().to_lowercase();
            let signature = format!("{sourcearg}:946684800123456700:{}", bytes.len());
            let name = format!("{:x}.{ext}", Sha256::digest(signature.as_bytes()));
            let expected = json!({"path":format!("mods/project-docs-tabs/.cache/{name}"),"width":case["expected_dimensions"][0],"height":case["expected_dimensions"][1],"pages":1,"page":1,"signature":signature});
            assert_eq!(actual, expected, "{} literal path spelling", case["name"]);
            assert!(out.stdout.is_ascii(), "original json.dumps escapes Unicode");
            assert!(stdout(&out).starts_with("{\"path\": "));
            let cached = cache.join(&name);
            assert_eq!(
                fs::read(&cached).unwrap(),
                bytes,
                "full source copied even when parsing is bounded"
            );
            if let Some(code) = original {
                let old_cache = temp.path().join(format!("old-cache-{index}"));
                let old = invoke(sourcearg, &old_cache, Some(code));
                assert_eq!(
                    stdout(&out),
                    stdout(&old),
                    "{} exact original JSON stdout",
                    case["name"]
                );
                assert_eq!(fs::read(old_cache.join(&name)).unwrap(), bytes);
            }
            let retained_time = filetime::FileTime::from_unix_time(946684801, 0);
            filetime::set_file_mtime(&cached, retained_time).unwrap();
            let repeated = invoke(sourcearg, &cache, None);
            assert_eq!(out.stdout, repeated.stdout);
            assert_eq!(
                filetime::FileTime::from_last_modification_time(&fs::metadata(&cached).unwrap()),
                retained_time,
                "cache hit must not overwrite the image"
            );
            assert_eq!(
                fs::read_dir(&cache).unwrap().count(),
                1,
                "no temporary cache files survive"
            );
        }
        // A size change with the same timestamp must invalidate the signature.
        let mut changed = bytes.clone();
        changed.push(b' ');
        fs::write(&source, &changed).unwrap();
        filetime::set_file_times(&source, time, time).unwrap();
        let invalidated = invoke(source.to_str().unwrap(), &temp.path().join("cache-0"), None);
        let value: Value = serde_json::from_slice(&invalidated.stdout).unwrap();
        assert!(value["signature"]
            .as_str()
            .unwrap()
            .ends_with(&format!(":{}", changed.len())));
        assert_eq!(
            fs::read(
                temp.path().join("cache-0").join(
                    Path::new(value["path"].as_str().unwrap())
                        .file_name()
                        .unwrap()
                )
            )
            .unwrap(),
            changed
        );
        assert_eq!(
            fs::read_dir(temp.path().join("cache-0")).unwrap().count(),
            2
        );
    }
}
#[test]
fn native_json_matches_untouched_python_dumps_numbers_and_del() {
    for case in corpus()["serialization_cases"].as_array().unwrap() {
        assert_eq!(
            herdr_theme::documents::render::python_json(&case["value"]),
            case["expected"].as_str().unwrap()
        );
    }
}
#[test]
fn native_media_matches_frozen_original_dimensions_signatures_and_cache_bytes() {
    exercise(None)
}
#[test]
#[ignore = "manual comparison requires archived original embedded fallback and external Python"]
fn external_original_embedded_image_cli_matches_native_stdout_and_cache() {
    let scripts = std::path::PathBuf::from(
        std::env::var_os("HERDR_THEME_ORACLE_SCRIPTS").expect("archived baseline scripts required"),
    );
    let source = fs::read_to_string(
        scripts
            .parent()
            .unwrap()
            .join("mods/project-docs-tabs/vendor/media.js"),
    )
    .unwrap();
    let marker = "export const PYTHON_IMAGE = String.raw`";
    let code = source
        .split_once(marker)
        .unwrap()
        .1
        .split_once("`;")
        .unwrap()
        .0;
    assert_eq!(
        format!("{:x}", Sha256::digest(code.as_bytes())),
        corpus()["script_sha256"].as_str().unwrap()
    );
    exercise(Some(code));
}
