use super::common::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path, process::Stdio};
fn rx(p: &str) -> Regex {
    Regex::new(p).unwrap()
}
pub fn python_json(value: &Value) -> String {
    match value {
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(python_json).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", python_json(&json!(k)), python_json(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::String(t) => {
            let encoded = serde_json::to_string(t).unwrap();
            let mut out = String::new();
            for c in encoded.chars() {
                if c as u32 >= 127 {
                    for u in c.to_string().encode_utf16() {
                        out.push_str(&format!("\\u{u:04x}"))
                    }
                } else {
                    out.push(c)
                }
            }
            out
        }
        Value::Number(n) if n.is_f64() => crate::automation::format::repr(value),
        _ => value.to_string(),
    }
}
pub fn mermaid_blocks(text: &str) -> Vec<String> {
    let lines = text.split('\n').collect::<Vec<_>>();
    let opening = rx(r"^( {0,3})(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*$");
    let mut result = vec![];
    let mut i = 0;
    while i < lines.len() {
        let Some(cap) = opening.captures(lines[i]) else {
            i += 1;
            continue;
        };
        let marker = cap[2].chars().next().unwrap();
        let closing = rx(&format!(
            r"^ {{0,3}}{}{{{},}}[ \t]*$",
            regex::escape(&marker.to_string()),
            cap[2].len()
        ));
        i += 1;
        let mut body = vec![];
        while i < lines.len() && !closing.is_match(lines[i]) {
            body.push(lines[i]);
            i += 1
        }
        if i < lines.len() {
            result.push(body.join("\n"))
        }
        i += 1
    }
    result
}
pub fn png_size(path: &Path) -> Result<(u32, u32)> {
    let mut header = [0u8; 24];
    fs::File::open(path)?.read_exact(&mut header)?;
    Ok((
        u32::from_be_bytes(header[16..20].try_into()?),
        u32::from_be_bytes(header[20..24].try_into()?),
    ))
}
pub fn interactive(text: &str) -> Vec<&'static str> {
    let mut text = rx(r"(?s)<!--.*?-->").replace_all(text, "").into_owned();
    for tag in ["pre", "code", "textarea"] {
        text = rx(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>"))
            .replace_all(&text, if tag == "textarea" { "<textarea>" } else { "" })
            .into_owned()
    }
    let mut result = vec![];
    for (label, pattern) in [
        (
            "클릭 이벤트",
            r"(?i)<[a-z][^>]*\son(?:click|change|input|submit|toggle|mouse\w+|key\w+)\s*=",
        ),
        (
            "스크립트 이벤트",
            r#"(?i)addEventListener\s*\(\s*["'](?:click|dblclick|change|input|submit|toggle|key\w+|mouse(?:down|up|enter|over)|pointer(?:down|up|enter|over)|touch\w+|focus)["']|\.on(?:click|change|input|submit)\s*="#,
        ),
        ("펼침 영역", r"(?i)<details\b"),
        (
            "팝업",
            r#"(?i)<dialog\b|\brole\s*=\s*["']?dialog|\bdata-(?:bs-)?toggle\s*=\s*["']?(?:modal|popover|tooltip|dropdown|collapse)|\.showModal\s*\(|\bwindow\.open\s*\("#,
        ),
        (
            "탭",
            r#"(?i)\brole\s*=\s*["']?tab(?:list)?\b|\bdata-(?:bs-)?toggle\s*=\s*["']?(?:tab|pill)"#,
        ),
    ] {
        if rx(pattern).is_match(&text) {
            result.push(label)
        }
    }
    let form = rx(r"(?i)<(?:form|select|textarea|button)\b").is_match(&text)
        || rx(r"(?is)<input\b[^>]*")
            .find_iter(&text)
            .any(|m| !rx(r#"(?i)\btype\s*=\s*["']?hidden"#).is_match(m.as_str()));
    if form {
        result.push("입력 양식")
    }
    if rx(r#"(?i)\bx-data\s*=|\bbootstrap(?:\.bundle)?(?:\.min)?\.js|\bjquery-ui\b|\balpine(?:js)?\b[^"']*\.js"#).is_match(&text){result.push("UI 라이브러리")}
    result
}
/// Original argparse `int`, followed by the renderer's bounded width bucket.
/// Validate the complete integer before clamping, including Unicode decimal
/// digits/underscores and CPython's default integer-conversion digit limit.
pub fn width_bucket(text: &str) -> Result<i64> {
    let text =
        crate::python_unicode::decimal_ascii(text.trim_matches(|c| {
            crate::python_unicode::is_space(c) && !matches!(c, '\u{1c}'..='\u{1f}')
        }));
    let (negative, digits) = if let Some(s) = text.strip_prefix('-') {
        (true, s)
    } else {
        (false, text.strip_prefix('+').unwrap_or(&text))
    };
    let mut number = 0i64;
    let mut count = 0;
    let mut previous_digit = false;
    for ch in digits.chars() {
        if ch.is_ascii_digit() {
            count += 1;
            number = (number * 10 + (ch as i64 - '0' as i64)).min(2040);
            previous_digit = true;
        } else if ch == '_' && previous_digit {
            previous_digit = false;
        } else {
            return crate::common::usage("argument --width: invalid int value");
        }
    }
    if !previous_digit || count > 4300 {
        return crate::common::usage("argument --width: invalid int value");
    }
    Ok(if negative {
        320
    } else {
        (number / 40 * 40).clamp(320, 2000)
    })
}
pub fn html_cli(args: &[String]) -> Result<()> {
    let doc = expand(required(args, "--doc")?);
    let theme = option(args, "--theme").unwrap_or_else(|| "dark".into());
    if theme != "dark" && theme != "light" {
        return Err("theme must be dark or light".into());
    }
    let width = width_bucket(&option(args, "--width").unwrap_or_else(|| "960".into()))?;
    let app = app_home();
    let binary = app.join("data/sixfold/doc-tabs/render-html");
    let cache = app.join("mods/project-docs-tabs/.cache");
    if !binary.exists() {
        println!(
            "{}",
            json!({"error":"HTML 렌더러가 설치되지 않았습니다. herdr-theme install-doc-tabs --install"})
        );
        return exit_without_diagnostic(1);
    }
    let body = fs::read(&doc)?;
    let meta = fs::metadata(&binary)?;
    let ns = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let key = hash(python_json(&json!([
        hash(&body),
        theme,
        width,
        meta.len(),
        ns as u64
    ])))[..24]
        .to_owned();
    let index = cache.join(format!("html-{key}.json"));
    if !index.exists() {
        let temp = tempfile::tempdir()?;
        let prefix = temp.path().join(format!("html-{key}"));
        let output = timeout_output(
            command(&binary)
                .arg(&doc)
                .arg(&prefix)
                .arg(&theme)
                .arg(width.to_string()),
            60,
        )?;
        let data:Value=serde_json::from_slice(&output.stdout).unwrap_or_else(|_|json!({"error":String::from_utf8_lossy(&output.stderr).trim().chars().rev().take(300).collect::<String>().chars().rev().collect::<String>()}));
        if !output.status.success() || !data["tiles"].is_array() {
            println!(
                "{}",
                json!({"error":data["error"].as_str().filter(|s|!s.is_empty()).unwrap_or("HTML 렌더링 실패")})
            );
            return exit_without_diagnostic(1);
        }
        fs::create_dir_all(&cache)?;
        for number in 0..arr(&data["tiles"]).len() {
            fs::rename(
                temp.path().join(format!("html-{key}-{number}.png")),
                cache.join(format!("html-{key}-{number}.png")),
            )?
        }
        atomic_json(
            &index,
            &json!({"tiles":arr(&data["tiles"]).len(),"truncated":data["truncated"].as_bool().unwrap_or(false)}),
        )?;
    }
    let saved = read_json(&index)?;
    let count = if saved.is_object() {
        saved["tiles"].as_u64()
    } else {
        saved.as_u64()
    }
    .ok_or("invalid tile index")?;
    let mut pages = vec![];
    for number in 0..count {
        let (w, h) = png_size(&cache.join(format!("html-{key}-{number}.png")))?;
        pages.push(json!({"path":format!("mods/project-docs-tabs/.cache/html-{key}-{number}.png"),"width":w as f64/2.0,"height":h as f64/2.0}))
    }
    println!(
        "{}",
        json!({"pages":pages,"width":width,"truncated":saved["truncated"].as_bool().unwrap_or(false),"interactive":interactive(&String::from_utf8_lossy(&body))})
    );
    Ok(())
}
pub fn mermaid_cli(args: &[String]) -> Result<()> {
    let doc = expand(required(args, "--doc")?);
    let theme = option(args, "--theme").unwrap_or_else(|| "dark".into());
    if !["dark", "light"].contains(&theme.as_str()) {
        return Err("theme must be dark or light".into());
    }
    let background = option(args, "--background").unwrap_or_else(|| "#ffffff".into());
    let app = app_home();
    let tools = app.join("data/sixfold/doc-tabs");
    let binary = tools.join("render-mermaid");
    let library = tools.join("mermaid/mermaid.min.js");
    let cache = app.join("mods/project-docs-tabs/.cache");
    let blocks = mermaid_blocks(&String::from_utf8_lossy(&fs::read(doc)?));
    if !blocks.is_empty() && !(binary.exists() && library.exists()) {
        println!(
            "{}",
            json!({"diagrams":[],"error":"Mermaid 렌더러가 설치되지 않았습니다. herdr-theme install-doc-tabs --install --mermaid <mermaid.min.js>"})
        );
        return Ok(());
    }
    let version = fs::metadata(&library).map(|m| m.len()).unwrap_or(0);
    let mut diagrams = vec![];
    let mut seen = std::collections::HashSet::new();
    for code in blocks {
        if !seen.insert(code.clone()) {
            continue;
        }
        let key = hash(python_json(&json!([code, theme, background, version])))[..24].to_owned();
        let name = format!("mermaid-{key}.png");
        let target = cache.join(&name);
        if !target.exists() {
            fs::create_dir_all(&cache)?;
            let temp = tempfile::tempdir()?;
            let source = temp.path().join("diagram.mmd");
            fs::write(&source, &code)?;
            let partial = temp.path().join(&name);
            let output = timeout_output(
                command(&binary)
                    .arg(&source)
                    .arg(&partial)
                    .arg(&library)
                    .arg(&theme)
                    .arg(&background),
                30,
            )?;
            if !output.status.success() || !partial.exists() {
                let data: Value = serde_json::from_slice(&output.stdout).unwrap_or(json!({}));
                let detail = data["error"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        String::from_utf8_lossy(&output.stderr)
                            .trim()
                            .chars()
                            .rev()
                            .take(300)
                            .collect::<String>()
                            .chars()
                            .rev()
                            .collect::<String>()
                    });
                diagrams.push(json!({"code":code,"error":if detail.is_empty(){"Mermaid 렌더링 실패"}else{&detail}}));
                continue;
            }
            fs::rename(partial, &target)?
        }
        let (w, h) = png_size(&target)?;
        diagrams.push(json!({"code":code,"path":format!("mods/project-docs-tabs/.cache/{name}"),"width":w as f64/2.0,"height":h as f64/2.0}))
    }
    println!("{}", json!({"diagrams":diagrams}));
    Ok(())
}
pub fn image_dimensions(data: &[u8], ext: &str) -> Result<(f64, f64)> {
    let pair = if ext == "svg" {
        let text = std::str::from_utf8(data)?.trim_start_matches('\u{feff}');
        let box_re = rx(r#"(?i)\bviewBox\s*=\s*[\x22\x27]([^\x22\x27]+)"#);
        let box_ = box_re
            .captures(text)
            .map(|c| {
                rx("[ ,]+")
                    .split(c[1].trim())
                    .map(|n| n.parse::<f64>())
                    .collect::<std::result::Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or(vec![0., 0., 300., 150.]);
        if box_.len() < 4 {
            return Err("Invalid SVG viewBox".into());
        }
        let dimension = |key: &str, fallback: f64| -> Result<f64> {
            Ok(rx(&format!(
                r#"(?i)\b{key}\s*=\s*[\x22\x27]([\d.]+)(?:px)?[\x22\x27]"#
            ))
            .captures(text)
            .map(|c| c[1].parse::<f64>())
            .transpose()?
            .unwrap_or(fallback))
        };
        (dimension("width", box_[2])?, dimension("height", box_[3])?)
    } else if data.starts_with(b"\x89PNG\r\n\x1a\n") && data.len() >= 24 {
        (
            u32::from_be_bytes(data[16..20].try_into()?) as f64,
            u32::from_be_bytes(data[20..24].try_into()?) as f64,
        )
    } else if data.starts_with(b"\xff\xd8") {
        let mut i = 2;
        let mut pair = None;
        while i < data.len() {
            if data[i] != 255 {
                i += 1;
                continue;
            }
            while i < data.len() && data[i] == 255 {
                i += 1
            }
            if i >= data.len() {
                break;
            }
            let marker = data[i];
            i += 1;
            if marker == 0xd8 || marker == 0xd9 || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            if i + 2 > data.len() {
                break;
            }
            let size = u16::from_be_bytes(data[i..i + 2].try_into()?) as usize;
            if [
                0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
            ]
            .contains(&marker)
            {
                if i + 7 > data.len() {
                    break;
                }
                pair = Some((
                    u16::from_be_bytes(data[i + 5..i + 7].try_into()?) as f64,
                    u16::from_be_bytes(data[i + 3..i + 5].try_into()?) as f64,
                ));
                break;
            }
            if size < 2 {
                return Err("Invalid JPEG".into());
            }
            i += size
        }
        pair.ok_or("Cannot read JPEG dimensions")?
    } else if data.len() >= 30 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        if &data[12..16] == b"VP8X" {
            let w = u32::from_le_bytes([data[24], data[25], data[26], 0]) + 1;
            let h = u32::from_le_bytes([data[27], data[28], data[29], 0]) + 1;
            (w as f64, h as f64)
        } else if &data[12..16] == b"VP8L" {
            let bits = u32::from_le_bytes(data[21..25].try_into()?);
            (
                ((bits & 0x3fff) + 1) as f64,
                (((bits >> 14) & 0x3fff) + 1) as f64,
            )
        } else {
            (
                (u16::from_le_bytes(data[26..28].try_into()?) & 0x3fff) as f64,
                (u16::from_le_bytes(data[28..30].try_into()?) & 0x3fff) as f64,
            )
        }
    } else {
        return Err("This image format cannot be decoded".into());
    };
    if !(pair.0 > 0. && pair.1 > 0.) {
        return Err("Invalid image dimensions".into());
    }
    Ok(pair)
}
pub fn image_dimensions_json(data: &[u8], ext: &str) -> Result<(Value, Value)> {
    let (width, height) = image_dimensions(data, ext)?;
    if ext != "svg" {
        return Ok((json!(width as u64), json!(height as u64)));
    }
    let text = std::str::from_utf8(data)?.trim_start_matches('\u{feff}');
    let viewbox = rx(r#"(?i)\bviewBox\s*=\s*[\x22\x27]([^\x22\x27]+)"#).is_match(text);
    let explicit = |key: &str| {
        rx(&format!(
            r#"(?i)\b{key}\s*=\s*[\x22\x27]([\d.]+)(?:px)?[\x22\x27]"#
        ))
        .is_match(text)
    };
    // SVG attributes/viewBox are parsed with float(); absent attributes use
    // the integer 300x150 fallback. Raster header dimensions are integers.
    Ok((
        if viewbox || explicit("width") {
            json!(width)
        } else {
            json!(300)
        },
        if viewbox || explicit("height") {
            json!(height)
        } else {
            json!(150)
        },
    ))
}
pub fn media_cli(args: &[String]) -> Result<()> {
    let positions = positionals(args, &[]);
    let source = positions.first().ok_or("source required")?;
    let cache = Path::new(positions.get(1).ok_or("cache required")?);
    let meta = fs::metadata(source)?;
    let signature = format!(
        "{}:{}:{}",
        source,
        meta.modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        meta.len()
    );
    let ext = source.rsplit('.').next().unwrap_or("").to_lowercase();
    let mut data = vec![];
    fs::File::open(source)?
        .take(1024 * 1024)
        .read_to_end(&mut data)?;
    let (w, h) = image_dimensions_json(&data, &ext)?;
    let name = format!("{}.{}", hash(&signature), ext);
    let destination = cache.join(&name);
    if !destination.exists() {
        atomic_bytes(&destination, &fs::read(source)?)?;
    }
    println!(
        "{}",
        python_json(
            &json!({"path":format!("mods/project-docs-tabs/.cache/{name}"),"width":w,"height":h,"pages":1,"page":1,"signature":signature})
        )
    );
    Ok(())
}
pub fn desktop_cli(args: &[String]) -> Result<()> {
    let positions = positionals(args, &[]);
    let action = positions.first().ok_or("action required")?;
    let path = expand(positions.get(1).ok_or("path required")?).canonicalize()?;
    let path = resolved(path);
    if !path.is_file() {
        return Err("Select a local file".into());
    }
    #[cfg(windows)]
    {
        if action.starts_with("copy-") {
            let value = STANDARD.encode(path.to_string_lossy().as_bytes());
            let mut source=format!("$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{value}'));");
            source.push_str(if action == "copy-file" {
                "Set-Clipboard -LiteralPath $p"
            } else {
                "Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath $p)"
            });
            let bytes = source
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            let output = timeout_output(
                command("powershell.exe").args([
                    "-STA",
                    "-NoProfile",
                    "-NonInteractive",
                    "-EncodedCommand",
                    &STANDARD.encode(bytes),
                ]),
                15,
            )?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
            }
            return Ok(());
        }
        if action == "open" {
            // os.startfile uses ShellExecute rather than Explorer's process
            // exit status, which may be nonzero even after opening the file.
            use std::ffi::c_void;
            #[link(name = "shell32")]
            extern "system" {
                fn ShellExecuteW(
                    window: *mut c_void,
                    operation: *const u16,
                    file: *const u16,
                    parameters: *const u16,
                    directory: *const u16,
                    show: i32,
                ) -> *mut c_void;
            }
            let file = path
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    file.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                )
            } as isize;
            if result <= 32 {
                return Err(
                    format!("Could not open local document (ShellExecute {result})").into(),
                );
            }
            return Ok(());
        }
        let candidates = if action == "browser" {
            ["ProgramFiles", "LOCALAPPDATA"]
                .iter()
                .map(|k| {
                    Path::new(&std::env::var(k).unwrap_or_default())
                        .join("Citro Labs/ego lite/Application/ego.exe")
                })
                .collect::<Vec<_>>()
        } else if action == "editor" {
            vec![
                Path::new(&std::env::var("LOCALAPPDATA").unwrap_or_default())
                    .join("Programs/Microsoft VS Code/Code.exe"),
                Path::new(&std::env::var("ProgramFiles").unwrap_or_default())
                    .join("Microsoft VS Code/Code.exe"),
            ]
        } else {
            return Err("Unsupported desktop action".into());
        };
        let executable = candidates
            .into_iter()
            .find(|p| p.is_file())
            .ok_or("Ego lite 또는 VS Code 실행 파일을 찾지 못했습니다.")?;
        let mut cmd = command(executable);
        if action == "editor" {
            cmd.arg("--reuse-window");
        }
        cmd.arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let mut cmd = if action == "editor" {
            let mut c = command("code");
            c.arg("--reuse-window");
            c
        } else if action == "open" || action == "browser" {
            command(if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            })
        } else {
            return Err("Clipboard action is not supported on this platform".into());
        };
        cmd.arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fences_require_matching_marker_and_close() {
        assert_eq!(
            mermaid_blocks("~~~mermaid\na-->b\n~~~\n```mermaid\nb-->c\n```"),
            vec!["a-->b", "b-->c"]
        );
        assert!(mermaid_blocks("```mermaid\na-->b").is_empty());
    }
    #[test]
    fn static_examples_not_interactive() {
        assert!(interactive("<!-- <button> --><pre><input></pre><input type='hidden'>").is_empty());
        assert_eq!(
            interactive(
                "<textarea>example <button></textarea><details><summary>x</summary></details>"
            ),
            vec!["펼침 영역", "입력 양식"]
        );
    }
    #[test]
    fn image_sizes_parse_without_decoder_dependency() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend(640u32.to_be_bytes());
        png.extend(480u32.to_be_bytes());
        assert_eq!(image_dimensions(&png, "png").unwrap(), (640., 480.));
        assert_eq!(
            image_dimensions_json(&png, "png").unwrap(),
            (json!(640), json!(480))
        );
        assert_eq!(
            image_dimensions_json(b"<svg>", "svg").unwrap(),
            (json!(300), json!(150))
        );
        assert_eq!(
            image_dimensions_json(b"<svg width='300px'>", "svg").unwrap(),
            (json!(300.0), json!(150))
        );
        assert_eq!(
            image_dimensions_json(b"<svg viewBox='0 0 300 150'>", "svg").unwrap(),
            (json!(300.0), json!(150.0))
        );
        assert_eq!(
            image_dimensions(b"<svg viewBox='0 0 120 90' width='240px'>", "svg").unwrap(),
            (240., 90.)
        );
        assert!(image_dimensions(b"bad", "png").is_err());
    }
    #[test]
    fn python_cache_json_is_ascii_and_spaced() {
        assert_eq!(
            python_json(&json!(["한", 1, "dark"])),
            "[\"\\ud55c\", 1, \"dark\"]"
        );
    }
}
