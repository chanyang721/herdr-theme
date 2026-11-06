use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn exit_without_diagnostic<T>(code: i32) -> Result<T> {
    Err(Box::new(crate::common::CliError {
        code,
        message: String::new(),
    }))
}
pub fn nfc(s: &str) -> String {
    s.nfc().collect()
}
pub fn fold(s: &str) -> String {
    super::casefold::casefold(&nfc(s))
}
pub fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}
pub fn user_home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
pub fn app_home() -> PathBuf {
    std::env::var_os("HERDR_APP_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".config/herdr-app"))
}
pub fn expand(s: impl AsRef<str>) -> PathBuf {
    expand_home(s, user_home())
}
pub fn expand_home(s: impl AsRef<str>, home: impl AsRef<Path>) -> PathBuf {
    let s = s.as_ref();
    if s == "~" {
        home.as_ref().to_owned()
    } else if let Some(t) = s.strip_prefix("~/") {
        home.as_ref().join(t)
    } else {
        PathBuf::from(s)
    }
}
pub fn absolute(p: impl AsRef<Path>) -> PathBuf {
    let p = p.as_ref();
    if p.is_absolute() {
        p.to_owned()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}
pub fn resolved(p: impl AsRef<Path>) -> PathBuf {
    // Path.resolve(strict=False) also resolves existing parent links and `..`
    // when the final document is missing. A lexical prefix check alone is unsafe.
    fn ordinary(path: PathBuf) -> PathBuf {
        #[cfg(windows)]
        {
            let text = path.to_string_lossy();
            if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            return PathBuf::from(text.trim_start_matches(r"\\?\"));
        }
        #[cfg(not(windows))]
        {
            path
        }
    }
    let absolute = absolute(p);
    let mut result = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            part => {
                result.push(part);
                if let Ok(canonical) = result.canonicalize() {
                    result = ordinary(canonical);
                }
            }
        }
    }
    result
}
pub fn text(p: impl AsRef<Path>) -> Result<String> {
    Ok(fs::read_to_string(p)?)
}
pub fn read_json(p: impl AsRef<Path>) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(p)?)?)
}
pub fn json_or(p: impl AsRef<Path>, default: Value) -> Value {
    read_json(p).unwrap_or(default)
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn now() -> f64 {
    now_ms() as f64 / 1000.0
}
pub fn mtime(p: impl AsRef<Path>) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|x| x.duration_since(UNIX_EPOCH).ok())
        .map(|x| x.as_millis() as u64)
        .unwrap_or(0)
}
pub fn symlink(p: impl AsRef<Path>) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}
pub fn lexists(p: impl AsRef<Path>) -> bool {
    fs::symlink_metadata(p).is_ok()
}
pub fn suffix(p: impl AsRef<Path>) -> String {
    p.as_ref()
        .extension()
        .map(|x| format!(".{}", x.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}
pub fn filename(p: impl AsRef<Path>) -> String {
    p.as_ref()
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
pub fn stem(p: impl AsRef<Path>) -> String {
    p.as_ref()
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
pub fn option(args: &[String], key: &str) -> Option<String> {
    let end = args.iter().position(|a| a == "--").unwrap_or(args.len());
    let mut found = None;
    for (index, arg) in args[..end].iter().enumerate() {
        if arg == key {
            found = args.get(index + 1).cloned()
        } else if let Some(value) = arg.strip_prefix(&format!("{key}=")) {
            found = Some(value.to_owned())
        }
    }
    found
}
pub fn has(args: &[String], key: &str) -> bool {
    args.iter()
        .take_while(|a| a.as_str() != "--")
        .any(|a| a == key || a.starts_with(&format!("{key}=")))
}
pub fn required(args: &[String], key: &str) -> Result<String> {
    if let Some(value) = option(args, key) {
        Ok(value)
    } else {
        crate::common::usage(format!("the following arguments are required: {key}"))
    }
}
pub fn positionals(args: &[String], flags: &[&str]) -> Vec<String> {
    let mut result = vec![];
    let mut skip = false;
    let mut ended = false;
    for arg in args {
        if ended {
            result.push(arg.clone());
            continue;
        }
        if skip {
            skip = false;
            continue;
        }
        if arg == "--" {
            ended = true;
            continue;
        }
        if arg.starts_with("--") {
            if !flags.contains(&arg.as_str()) {
                skip = !arg.contains('=')
            }
        } else {
            result.push(arg.clone())
        }
    }
    result
}
pub fn atomic_bytes(path: impl AsRef<Path>, data: &[u8]) -> Result<bool> {
    atomic_bytes_mode(path, data, None)
}
pub fn atomic_bytes_mode(
    path: impl AsRef<Path>,
    data: &[u8],
    permissions: Option<u32>,
) -> Result<bool> {
    let path = path.as_ref();
    if fs::read(path).ok().as_deref() == Some(data) {
        if let Some(mode) = permissions {
            chmod(path, mode)?;
        }
        return Ok(false);
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(".{}-", filename(path)))
        .tempfile_in(parent)?;
    temporary.write_all(data)?;
    temporary.as_file().sync_all()?;
    if let Some(mode) = permissions {
        chmod(temporary.path(), mode)?;
    }
    persist_replacing(temporary, path)?;
    Ok(true)
}
fn persist_retry(
    mut temporary: tempfile::NamedTempFile,
    path: &Path,
) -> std::result::Result<(), tempfile::PersistError> {
    for attempt in 0..25 {
        match temporary.persist(path) {
            Ok(_) => return Ok(()),
            Err(error)
                if error.error.kind() == std::io::ErrorKind::PermissionDenied && attempt < 24 =>
            {
                temporary = error.file;
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}
fn retry_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    for attempt in 0..25 {
        match fs::rename(source, destination) {
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && attempt < 24 => {
                std::thread::sleep(Duration::from_millis(40));
            }
            result => return result,
        }
    }
    unreachable!()
}
fn persist_replacing(temporary: tempfile::NamedTempFile, path: &Path) -> Result<()> {
    match temporary.persist(path) {
        Ok(_) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            if error.error.kind() == std::io::ErrorKind::PermissionDenied
                && path.extension().is_some_and(|extension| {
                    extension.to_string_lossy().eq_ignore_ascii_case("exe")
                })
                && path.is_file()
            {
                // Windows permits a mapped image to be renamed, but refuses an
                // overwrite. Keep its bytes under a unique name until its users
                // exit; helpers already running continue using that same image.
                let parent = path.parent().unwrap_or(Path::new("."));
                let aside = tempfile::Builder::new()
                    .prefix(&format!(".{}.replaced-", filename(path)))
                    .tempfile_in(parent)?
                    .into_temp_path();
                fs::remove_file(&aside)?;
                retry_rename(path, &aside)?;
                let aside = aside.keep()?;
                match persist_retry(error.file, path) {
                    Ok(()) => {
                        // Delete only this exact owned aside if no process maps
                        // it. Never infer ownership of unrelated prefix files.
                        let _ = fs::remove_file(&aside);
                        return Ok(());
                    }
                    Err(install_error) => {
                        if path.exists() {
                            return Err(format!("Executable replacement failed: {}; original retained at {} because destination appeared concurrently", install_error.error, aside.display()).into());
                        }
                        if let Err(restore_error) = retry_rename(&aside, path) {
                            return Err(format!("Executable replacement failed: {}; restoring original failed: {restore_error}; original retained at {}", install_error.error, aside.display()).into());
                        }
                        return Err(install_error.error.into());
                    }
                }
            }
            Err(error.error.into())
        }
    }
}
pub fn remove_installed_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            if error.kind() == std::io::ErrorKind::PermissionDenied
                && path.extension().is_some_and(|extension| {
                    extension.to_string_lossy().eq_ignore_ascii_case("exe")
                })
            {
                let aside = tempfile::Builder::new()
                    .prefix(&format!(".{}.replaced-", filename(path)))
                    .tempfile_in(path.parent().unwrap_or(Path::new(".")))?
                    .into_temp_path();
                fs::remove_file(&aside)?;
                retry_rename(path, &aside)?;
                let aside = aside.keep()?;
                let _ = fs::remove_file(aside);
                return Ok(());
            }
            Err(error.into())
        }
    }
}
/// Direct write semantics used only where the original helper used write_text:
/// follow existing symlinks and retain the target's permissions.
pub fn write_following(path: impl AsRef<Path>, data: &[u8]) -> Result<()> {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
    fs::write(path, data)?;
    Ok(())
}
pub fn text_bytes(text: &str) -> Vec<u8> {
    crate::common::text_bytes(text)
}
pub fn replace_named_text(path: &Path, text: &str) -> Result<()> {
    let temporary = path.with_extension("tmp");
    write_following(&temporary, &text_bytes(text))?;
    retry_rename(&temporary, path)?;
    Ok(())
}
pub fn atomic_json(path: impl AsRef<Path>, value: &Value) -> Result<bool> {
    let path = path.as_ref();
    let text = crate::common::json_pretty(value, false) + "\n";
    match fs::read_to_string(path) {
        Ok(previous) if previous.replace("\r\n", "\n").replace('\r', "\n") == text => {
            return Ok(false)
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    atomic_bytes(path, &text_bytes(&text))
}
pub fn chmod(path: impl AsRef<Path>, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}
pub fn copy_file(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> Result<()> {
    let src = src.as_ref();
    let dst = dst.as_ref();
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?
    }
    fs::copy(src, dst)?;
    let meta = fs::metadata(src)?;
    filetime::set_file_times(
        dst,
        filetime::FileTime::from_last_access_time(&meta),
        filetime::FileTime::from_last_modification_time(&meta),
    )?;
    Ok(())
}
pub fn copy_tree(src: impl AsRef<Path>, dst: impl AsRef<Path>, skip: &[&str]) -> Result<()> {
    copy_tree_mode(src, dst, skip, false)
}
pub fn copy_tree_links(src: impl AsRef<Path>, dst: impl AsRef<Path>, skip: &[&str]) -> Result<()> {
    copy_tree_mode(src, dst, skip, true)
}
fn copy_tree_mode(
    src: impl AsRef<Path>,
    dst: impl AsRef<Path>,
    skip: &[&str],
    preserve_links: bool,
) -> Result<()> {
    let src = src.as_ref();
    let dst = dst.as_ref();
    fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src)
        .follow_links(!preserve_links)
        .into_iter()
        .filter_entry(|e| !skip.contains(&e.file_name().to_string_lossy().as_ref()))
    {
        let e = entry?;
        if e.path() == src {
            continue;
        }
        let out = dst.join(e.path().strip_prefix(src)?);
        if preserve_links && e.path_is_symlink() {
            let target = fs::read_link(e.path())?;
            #[cfg(windows)]
            if e.path().is_dir() {
                std::os::windows::fs::symlink_dir(&target, &out)?;
                continue;
            }
            create_link(&target, &out)?
        } else if e.file_type().is_dir() {
            fs::create_dir_all(out)?
        } else {
            copy_file(e.path(), out)?
        }
    }
    Ok(())
}
pub fn create_link(source: &Path, target: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)?
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(source, target)?
    }
    Ok(())
}
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}
pub fn checked(cmd: &mut Command) -> Result<Output> {
    let output = cmd.output()?;
    if !output.status.success() {
        return Err(format!(
            "command failed ({}): {} {}",
            output.status,
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(output)
}
pub fn timeout_output(cmd: &mut Command, seconds: u64) -> Result<Output> {
    timeout_output_f64(cmd, seconds as f64)
}
pub fn timeout_output_f64(cmd: &mut Command, seconds: f64) -> Result<Output> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let a = std::thread::spawn(move || {
        let mut b = vec![];
        let mut stream = stdout;
        let _ = stream.read_to_end(&mut b);
        b
    });
    let b = std::thread::spawn(move || {
        let mut b = vec![];
        let mut stream = stderr;
        let _ = stream.read_to_end(&mut b);
        b
    });
    let begin = std::time::Instant::now();
    let status = loop {
        if super::update::cancellation::requested() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = a.join();
            let _ = b.join();
            return Err(super::update::cancellation::interruption());
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if begin.elapsed().as_secs_f64() >= seconds {
            let _ = child.kill();
            let _ = child.wait();
            let _ = a.join();
            let _ = b.join();
            return Err("command timeout".into());
        }
        std::thread::sleep(Duration::from_millis(20))
    };
    Ok(Output {
        status,
        stdout: a.join().unwrap_or_default(),
        stderr: b.join().unwrap_or_default(),
    })
}
pub fn cli_json(program: &str, args: &[&str]) -> Result<Value> {
    let out = checked(command(program).args(args))?;
    if out.stdout.iter().all(|b| b.is_ascii_whitespace()) {
        Ok(json!({}))
    } else {
        Ok(serde_json::from_slice(&out.stdout)?)
    }
}
pub fn core_call(method: &str, params: Value) -> Result<Value> {
    let mut process = command("hc")
        .arg("connect")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let result = (|| -> Result<Value> {
        let request = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        writeln!(process.stdin.as_mut().unwrap(), "{request}")?;
        process.stdin.as_mut().unwrap().flush()?;
        let stdout = process.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let mut line = String::new();
            let _ = std::io::BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| format!("timeout: {method}"))?;
        let reply: Value = serde_json::from_str(&line)?;
        if !reply["error"].is_null() {
            Err(reply["error"].to_string().into())
        } else {
            Ok(reply["result"].clone())
        }
    })();
    drop(process.stdin.take());
    let begin = std::time::Instant::now();
    while process.try_wait()?.is_none() {
        if begin.elapsed() >= Duration::from_secs(2) {
            let _ = process.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(10))
    }
    let _ = process.wait();
    result
}
pub fn lock(path: impl AsRef<Path>, nonblocking: bool) -> Result<fs::File> {
    let p = path.as_ref();
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(p)?;
    crate::locking::lock(&file, nonblocking)?;
    Ok(file)
}
pub fn site_config(home: Option<&Path>, app: Option<&Path>) -> Value {
    let home = home.map(Path::to_owned).unwrap_or_else(user_home);
    let app = app.map(Path::to_owned).unwrap_or_else(|| {
        if home == user_home() {
            app_home()
        } else {
            home.join(".config/herdr-app")
        }
    });
    let mut base = json!({"label_prefix":"local.herdr-sixfold","state_dir":"~/Library/Application Support/HerdrSixfold","reports_dir":"~/Documents/HerdrReports","projects_dir":"~/Documents/HerdrProjects","hub_space_ids":[],"project_aliases":{},"fixed_space_names":["Share"],"doc_tabs":{}});
    if let Ok(value) = read_json(app.join("data/sixfold/site.local.json")) {
        if let Some(map) = value.as_object() {
            for (k, v) in map {
                base[k] = v.clone()
            }
        }
    }
    base
}
pub fn is_hub(space: &Value, site: &Value) -> bool {
    arr(&site["hub_space_ids"]).contains(&space["id"])
        || ["share", "공통", "common"].contains(&fold(s(&space["name"])).as_str())
}
fn runtime_repository(executable: &Path, directory: &Path) -> Option<PathBuf> {
    executable
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .chain(directory.ancestors())
        .find(|root| {
            root.join("workspace-mods.lock.json").is_file()
                && root.join("keys.json").is_file()
                && root.join("mods").is_dir()
                && root.join("layouts").is_dir()
        })
        .map(Path::to_owned)
}
pub fn source_repository() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("HERDR_THEME_REPO") {
        return Some(expand(path.to_string_lossy()));
    }
    runtime_repository(
        &std::env::current_exe().ok()?,
        &std::env::current_dir().ok()?,
    )
}
pub fn repo_default() -> PathBuf {
    source_repository().unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_owned))
            .unwrap_or_else(|| PathBuf::from("."))
    })
}
#[cfg(test)]
mod runtime_and_write_tests {
    use super::*;
    #[test]
    fn atomic_json_preserves_original_universal_newline_noop_and_decode_errors() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let corpus: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/documents-atomic-text-original.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("out.json");
            fs::write(
                &path,
                STANDARD
                    .decode(case["input_base64"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
            let result = atomic_json(&path, &case["value"]);
            if case["expected"]["error"].is_null() {
                assert_eq!(
                    result.unwrap(),
                    case["expected"]["changed"].as_bool().unwrap()
                )
            } else {
                assert!(result.is_err())
            }
            assert_eq!(
                fs::read(&path).unwrap(),
                STANDARD
                    .decode(case["expected"]["output_base64"].as_str().unwrap())
                    .unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        }
    }
    #[test]
    fn repository_follows_runtime_location_and_rejects_installed_app_assets() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("source");
        fs::create_dir_all(repo.join("mods")).unwrap();
        fs::create_dir_all(repo.join("layouts")).unwrap();
        fs::write(repo.join("keys.json"), b"{}").unwrap();
        fs::write(repo.join("workspace-mods.lock.json"), b"{}").unwrap();
        assert_eq!(
            runtime_repository(&repo.join("rust/target/release/herdr-theme"), temp.path()),
            Some(repo.clone())
        );
        let app = temp.path().join("app");
        fs::create_dir_all(app.join("mods")).unwrap();
        fs::create_dir_all(app.join("layouts")).unwrap();
        fs::write(app.join("keys.json"), b"{}").unwrap();
        assert_eq!(
            runtime_repository(&app.join("scripts/sixfold/herdr-theme"), temp.path()),
            None
        );
        assert_eq!(
            runtime_repository(&app.join("scripts/sixfold/herdr-theme"), &repo.join("docs")),
            Some(repo)
        );
    }
    #[cfg(unix)]
    #[test]
    fn source_specific_writes_preserve_direct_links_and_replace_atomic_links_privately() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link.json");
        fs::write(&target, b"original").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&target, &link).unwrap();
        write_following(&link, b"direct").unwrap();
        assert!(symlink_metadata_is_link(&link));
        assert_eq!(fs::read(&target).unwrap(), b"direct");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        atomic_json(&link, &json!({"key":"private"})).unwrap();
        assert!(!symlink_metadata_is_link(&link));
        assert_eq!(fs::read(&target).unwrap(), b"direct");
        assert_eq!(
            fs::metadata(&link).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fn symlink_metadata_is_link(path: &Path) -> bool {
            fs::symlink_metadata(path).unwrap().file_type().is_symlink()
        }
    }
}
