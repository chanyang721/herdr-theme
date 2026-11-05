use super::{common::*, install, observers, render::python_json};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
pub type Input = (PathBuf, Vec<u8>, u32);
fn mode(path: &Path) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o644)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        0o644
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8], permissions: u32) -> Result<()> {
    atomic_bytes(path, bytes)?;
    chmod(path, permissions)
}
pub fn rename_retry(source: &Path, target: &Path) -> Result<()> {
    for attempt in 0..25 {
        match fs::rename(source, target) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && attempt < 24 => {
                std::thread::sleep(Duration::from_millis(40))
            }
            Err(error) => return Err(error.into()),
        }
    }
    unreachable!()
}
pub fn exchange(left: &Path, right: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let aside = left.with_file_name(format!("{}.exchange-aside", filename(left)));
        if aside.exists() {
            return Err(
                format!("Exchange scratch path already exists: {}", aside.display()).into(),
            );
        }
        rename_retry(right, &aside)?;
        if let Err(error) = rename_retry(left, right) {
            rename_retry(&aside, right)?;
            return Err(error);
        }
        rename_retry(&aside, left)?;
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let left = std::ffi::CString::new(left.as_os_str().as_bytes())?;
        let right = std::ffi::CString::new(right.as_os_str().as_bytes())?;
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                left.as_ptr(),
                libc::AT_FDCWD,
                right.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(left.as_ptr(), right.as_ptr(), 2) };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        return Err(
            "Directory exchange requires macOS, Linux renameat2 or Windows; no unsafe fallback"
                .into(),
        );
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            if result != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(())
        }
    }
}
pub fn tree_digest(directory: &Path) -> Result<String> {
    let mut paths = walkdir::WalkDir::new(directory)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path() != directory)
        .map(|e| e.path().to_owned())
        .collect::<Vec<_>>();
    paths.sort();
    let mut entries = vec![];
    for item in paths {
        let relative = item.strip_prefix(directory)?;
        if relative
            .components()
            .any(|p| ["__pycache__", ".cache"].contains(&p.as_os_str().to_string_lossy().as_ref()))
        {
            continue;
        }
        if symlink(&item) {
            entries.push(json!([relative, "symlink", fs::read_link(&item)?]))
        } else if item.is_file() {
            entries.push(json!([relative, hash(fs::read(item)?)]))
        }
    }
    Ok(hash(python_json(&json!(entries))))
}
pub fn fill_missing(current: &Value, defaults: &Value) -> Result<Value> {
    if !current.is_object() || !defaults.is_object() {
        return Err("Portable JSON settings must be objects".into());
    }
    let mut output = current.clone();
    for (key, value) in defaults.as_object().unwrap() {
        if output.get(key).is_none() {
            output[key] = value.clone()
        } else if output[key].is_object() && value.is_object() {
            output[key] = fill_missing(&output[key], value)?
        }
    }
    Ok(output)
}
fn has_redirect(path: &Path) -> bool {
    if symlink(path) {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return fs::symlink_metadata(path)
            .map(|m| m.file_attributes() & 0x400 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        false
    }
}
pub(crate) fn check_target(target: &Path, home: &Path) -> Result<()> {
    let mut cursor = Some(target);
    while let Some(path) = cursor {
        if path == home.parent().unwrap_or(Path::new("/")) {
            break;
        }
        if has_redirect(path) {
            return Err(format!(
                "Symlink installation targets are refused: {}",
                target.display()
            )
            .into());
        }
        cursor = path.parent()
    }
    if target.exists() && !target.is_file() {
        return Err(format!("Not a regular installation target: {}", target.display()).into());
    }
    Ok(())
}
fn validate_json(value: &Value) -> Result<()> {
    if let Some(map) = value.as_object() {
        if value["mod"]
            .as_str()
            .is_some_and(|m| m.contains("recovery"))
        {
            return Err("Layouts must not reference recovery mod clones".into());
        }
        for child in map.values() {
            validate_json(child)?
        }
    } else if let Some(list) = value.as_array() {
        for child in list {
            validate_json(child)?
        }
    }
    Ok(())
}
pub fn input_files(repo: &Path, home: &Path, names: &[String]) -> Result<Vec<Input>> {
    let mut files: Vec<Input> = vec![];
    for name in names {
        let rel = Path::new(name);
        let parts = rel
            .components()
            .map(|p| p.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        if rel.is_absolute()
            || rel.components().any(|p| p == Component::ParentDir)
            || (parts.len() < 2 && name != "keys.json")
        {
            return Err(format!("Use explicit repository-relative file paths: {name}").into());
        }
        if ![
            "mods",
            "layouts",
            "themes",
            "scripts",
            "bin",
            "config",
            "keys.json",
        ]
        .contains(&parts[0].as_str())
            || parts.iter().any(|p| p.starts_with('.'))
        {
            return Err(format!("Unsupported installation target: {name}").into());
        }
        if parts[0] == "mods" && (parts.len() < 3 || parts[1].contains("recovery")) {
            return Err("Do not clone mod directories into recovery mods".into());
        }
        let mut source = repo.join(rel);
        let mut target_rel = rel.to_owned();
        if parts[0] == "scripts" {
            if suffix(&source) == ".py" || parts[1] == install::native_name() {
                source = std::env::current_exe()?;
                target_rel = Path::new("scripts/sixfold").join(install::native_name())
            } else {
                target_rel =
                    Path::new("scripts/sixfold").join(parts[1..].iter().collect::<PathBuf>())
            }
        } else if parts[0] == "bin" {
            target_rel = Path::new("bin/sixfold").join(parts[1..].iter().collect::<PathBuf>())
        } else if parts[0] == "config" {
            target_rel = match name.replace('\\', "/").as_str() {
                "config/templates/settings.json" => PathBuf::from("settings.json"),
                "config/templates/shared.json" => PathBuf::from("shared.json"),
                "config/templates/data/sixfold/collaboration.json" => {
                    PathBuf::from("data/sixfold/collaboration.json")
                }
                "config/templates/data/sixfold/project-docs-pins.json" => {
                    PathBuf::from("data/sixfold/project-docs-pins.json")
                }
                _ => {
                    return Err(
                        format!("Only portable config templates may be installed: {name}").into(),
                    )
                }
            }
        }
        let target = home.join(&target_rel);
        if !source.is_file()
            || symlink(&source)
            || (source != std::env::current_exe()?
                && !resolved(&source).starts_with(resolved(repo)))
        {
            return Err(format!("Not a regular repository file: {name}").into());
        }
        check_target(&target, home)?;
        let mut bytes = install::source_payload(&source, &target_rel)?;
        if suffix(&source) == ".json" {
            validate_json(&serde_json::from_slice(&bytes)?)?
        }
        if (parts[0] == "config" || name == "keys.json") && target.exists() {
            let current = read_json(&target)?;
            let defaults = serde_json::from_slice(&bytes)?;
            let seeded = fill_missing(&current, &defaults)?;
            if seeded != current {
                bytes = serde_json::to_vec_pretty(&seeded)?;
                bytes.push(b'\n')
            }
        }
        if !files.iter().any(|(p, _, _)| *p == target_rel) {
            files.push((target_rel, bytes, mode(&source)))
        }
    }
    Ok(files)
}
fn read_status(cli: &str, home: &Path) -> Result<Value> {
    let out = timeout_output(command(cli).arg("status").env("HERDR_APP_HOME", home), 15)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned().into());
    }
    let status: Value = serde_json::from_slice(&out.stdout)?;
    if !status.is_object() || !status["errors"].is_array() {
        return Err("status must contain an errors array".into());
    }
    Ok(status)
}
pub fn update(
    repo: &Path,
    home: &Path,
    names: &[String],
    cli: &str,
    verify_timeout: f64,
    allow_unhealthy_before: bool,
    extra: &[(PathBuf, PathBuf)],
) -> Result<PathBuf> {
    let configured_repo = absolute(repo);
    let configured_home = absolute(home);
    let repo = resolved(repo);
    let home = resolved(home);
    if !home.is_dir() {
        return Err("Existing app home required; use install for the initial install".into());
    }
    // update_install used its own offset-zero Windows lock, unlike file_lock's
    // reserved metadata byte. Keep it overlapping a still-running legacy updater.
    let lock_path = home.join("data/sixfold/install.lock");
    fs::create_dir_all(lock_path.parent().unwrap())?;
    let _guard = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    fs2::FileExt::try_lock_exclusive(&_guard)
        .map_err(|_| "Another installation holds the lock; do not copy files manually")?;
    let mut files = input_files(&repo, &home, names)?;
    for (src, rel) in extra {
        if !rel.starts_with("mods")
            || rel.components().count() < 3
            || rel.is_absolute()
            || rel.components().any(|p| p == Component::ParentDir)
        {
            return Err(format!("Unsupported Workspace Mods target: {}", rel.display()).into());
        }
        if !src.is_file() || symlink(src) {
            return Err(format!("Not a regular Workspace Mods file: {}", src.display()).into());
        }
        check_target(&home.join(rel), &home)?;
        if files.iter().any(|(r, _, _)| r == rel) {
            return Err(format!(
                "Listed files clash with the pinned Workspace Mods: {}",
                rel.display()
            )
            .into());
        }
        files.push((rel.clone(), install::source_payload(src, rel)?, mode(src)))
    }
    let mut migrated = false;
    for spec in super::migration::CONFIGS {
        let relative = PathBuf::from(spec.relative);
        let existing = files.iter().position(|(path, _, _)| *path == relative);
        let bytes = if let Some(index) = existing {
            Some(files[index].1.clone())
        } else {
            fs::read(home.join(&relative)).ok()
        };
        let Some(bytes) = bytes else { continue };
        let Some(payload) =
            super::migration::rewrite_bytes(&bytes, &configured_repo, &configured_home, *spec)
        else {
            continue;
        };
        check_target(&home.join(&relative), &home)?;
        if let Some(index) = existing {
            files[index].1 = payload;
        } else {
            files.push((relative.clone(), payload, mode(&home.join(&relative))));
        }
        migrated = true;
    }
    if migrated {
        let relative = Path::new("scripts/sixfold").join(install::native_name());
        if !files.iter().any(|(path, _, _)| *path == relative) {
            let source = std::env::current_exe()?;
            check_target(&home.join(&relative), &home)?;
            files.push((relative, fs::read(&source)?, mode(&source)));
        }
    }
    let native_relative = Path::new("scripts/sixfold").join(install::native_name());
    if files.iter().any(|(path, _, _)| *path == native_relative) {
        for (name, bytes) in crate::notices::files() {
            let relative = Path::new("scripts/sixfold/native-licenses").join(name);
            check_target(&home.join(&relative), &home)?;
            if let Some(index) = files.iter().position(|(path, _, _)| *path == relative) {
                files[index].1 = bytes.to_vec();
            } else {
                files.push((relative, bytes.to_vec(), 0o644));
            }
        }
    }
    let before = read_status(cli, &home)?;
    if !arr(&before["errors"]).is_empty() && !allow_unhealthy_before {
        return Err("App already reports errors; diagnose first or use --allow-unhealthy-before for an authorized repair".into());
    }
    files.retain(|(rel, payload, permission)| {
        fs::read(home.join(rel)).ok().as_deref() != Some(payload.as_slice())
            || mode(&home.join(rel)) != *permission
    });
    let backup = home.join("backups").join(format!(
        "sixfold-update-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S.%fZ")
    ));
    if files.is_empty() {
        if !arr(&before["errors"]).is_empty() {
            return Err("No changed files; the unhealthy app still requires diagnosis".into());
        }
        fs::create_dir_all(&backup)?;
        atomic_json(
            backup.join("receipt.json"),
            &json!({"phase":"unchanged","before":before,"files":[]}),
        )?;
        return Ok(backup);
    }
    fs::create_dir_all(home.join("backups"))?;
    let stage = tempfile::Builder::new()
        .prefix(".sixfold-install-stage-")
        .tempdir_in(home.join("backups"))?;
    let mods = files
        .iter()
        .filter(|(p, _, _)| p.starts_with("mods"))
        .map(|(p, _, _)| p.iter().nth(1).unwrap().to_string_lossy().into_owned())
        .collect::<BTreeSet<_>>();
    let mut initial: BTreeMap<String, Option<String>> = BTreeMap::new();
    for name in &mods {
        let installed = home.join("mods").join(name);
        initial.insert(
            name.clone(),
            if installed.exists() {
                Some(tree_digest(&installed)?)
            } else {
                None
            },
        );
        if installed.exists() {
            copy_tree_links(&installed, stage.path().join(name), &[])?
        } else {
            fs::create_dir_all(stage.path().join(name))?
        }
    }
    for name in &mods {
        if let Some(expected) = &initial[name] {
            if tree_digest(&stage.path().join(name))? != *expected {
                return Err(format!("Mod changed while staging: {name}").into());
            }
        }
    }
    for (rel, bytes, permission) in &files {
        if let Ok(rel) = rel.strip_prefix("mods") {
            atomic_write(&stage.path().join(rel), bytes, *permission)?
        }
    }
    for name in &mods {
        let output = timeout_output(
            command(cli)
                .arg("check")
                .arg(stage.path().join(name))
                .env("HERDR_APP_HOME", &home),
            30,
        )?;
        if !output.status.success() {
            return Err(format!(
                "Native check failed for {name}: {} {}",
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
    }
    fs::create_dir_all(&backup)?;
    for name in &mods {
        let installed = home.join("mods").join(name);
        if installed.exists() {
            copy_tree_links(installed, backup.join("mods").join(name), &[])?
        }
    }
    let mut originals: BTreeMap<PathBuf, Option<(Vec<u8>, u32)>> = BTreeMap::new();
    for (rel, _, _) in &files {
        let target = home.join(rel);
        let original = if target.exists() {
            Some((fs::read(&target)?, mode(&target)))
        } else {
            None
        };
        if let Some((bytes, permission)) = &original {
            if !rel.starts_with("mods") {
                atomic_write(&backup.join(rel), bytes, *permission)?
            }
        }
        originals.insert(rel.clone(), original);
    }
    let mut receipt = json!({"phase":"backed_up","source_worktree":repo,"pid":std::process::id(),"before":before,"files":files.iter().map(|x|&x.0).collect::<Vec<_>>(),"candidate_sha256":{},"original_sha256":{}});
    for (rel, bytes, _) in &files {
        receipt["candidate_sha256"][rel.to_string_lossy().as_ref()] = json!(hash(bytes));
        receipt["original_sha256"][rel.to_string_lossy().as_ref()] =
            json!(originals[rel].as_ref().map(|(bytes, _)| hash(bytes)))
    }
    let save = |receipt: &Value| atomic_json(backup.join("receipt.json"), receipt);
    save(&receipt)?;
    let candidate_mods = mods
        .iter()
        .map(|name| Ok((name.clone(), tree_digest(&stage.path().join(name))?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    let mut swapped = vec![];
    let mut written = vec![];
    let result = (|| -> Result<()> {
        for name in &mods {
            let target = home.join("mods").join(name);
            let current = if target.exists() {
                Some(tree_digest(&target)?)
            } else {
                None
            };
            if current != initial[name] {
                return Err(format!("Mod changed concurrently: {name}").into());
            }
            fs::create_dir_all(target.parent().unwrap())?;
            if target.exists() {
                exchange(&stage.path().join(name), &target)?
            } else {
                rename_retry(&stage.path().join(name), &target)?
            }
            swapped.push(name.clone())
        }
        for (rel, bytes, permission) in &files {
            if rel.starts_with("mods") {
                continue;
            }
            let target = home.join(rel);
            let current = fs::read(&target).ok();
            if current.as_deref() != originals[rel].as_ref().map(|x| x.0.as_slice()) {
                return Err(format!("Installation changed concurrently: {}", rel.display()).into());
            }
            atomic_write(&target, bytes, *permission)?;
            written.push(rel.clone())
        }
        receipt["phase"] = json!("installed_pending_verification");
        save(&receipt)?;
        let begin = Instant::now();
        let mut first_clean: Option<Instant> = None;
        let mut last_error = None;
        loop {
            match read_status(cli, &home) {
                Ok(after) => {
                    receipt["after"] = after.clone();
                    for name in &swapped {
                        let target = home.join("mods").join(name);
                        if !target.exists() || tree_digest(&target)? != candidate_mods[name] {
                            return Err(format!("Mod changed during verification: {name}").into());
                        }
                    }
                    for relative in &written {
                        let target = home.join(relative);
                        let expected = &files.iter().find(|x| &x.0 == relative).unwrap().1;
                        if fs::read(target).ok().as_deref() != Some(expected.as_slice()) {
                            return Err(format!(
                                "File changed during verification: {}",
                                relative.display()
                            )
                            .into());
                        }
                    }
                    let screen =
                        !swapped.is_empty() || written.iter().any(|p| !p.starts_with("scripts"));
                    if screen
                        && ["space", "tab", "focused_pane"]
                            .iter()
                            .any(|k| after[*k] != before[*k])
                    {
                        return Err("Workspace/tab/focus changed during installation; no focus commands were sent".into());
                    }
                    if arr(&after["errors"]).is_empty() {
                        if first_clean.is_some_and(|t| t.elapsed() >= Duration::from_secs(1)) {
                            break;
                        }
                        first_clean.get_or_insert_with(Instant::now);
                    } else {
                        first_clean = None;
                        last_error = Some(format!(
                            "App reports {} errors",
                            arr(&after["errors"]).len()
                        ))
                    }
                }
                Err(error) => {
                    first_clean = None;
                    last_error = Some(error.to_string())
                }
            }
            if begin.elapsed().as_secs_f64() >= verify_timeout {
                return Err(last_error
                    .unwrap_or_else(|| "App did not remain error-free during verification".into())
                    .into());
            }
            std::thread::sleep(Duration::from_millis(200))
        }
        receipt["phase"] = json!("verified");
        save(&receipt)?;
        Ok(())
    })();
    if let Err(error) = result {
        receipt["phase"] = json!("rolling_back");
        receipt["failure"] = json!(error.to_string());
        let mut conflicts = vec![];
        for name in swapped.iter().rev() {
            let target = home.join("mods").join(name);
            if !target.exists() || tree_digest(&target).ok().as_ref() != Some(&candidate_mods[name])
            {
                conflicts.push(format!("mods/{name}"));
                continue;
            }
            if initial[name].is_none() {
                rename_retry(&target, &stage.path().join(name))?
            } else {
                exchange(&stage.path().join(name), &target)?
            }
        }
        for rel in written.iter().rev() {
            let target = home.join(rel);
            let expected = &files.iter().find(|x| &x.0 == rel).unwrap().1;
            if fs::read(&target).ok().as_deref() != Some(expected.as_slice()) {
                conflicts.push(rel.to_string_lossy().into_owned());
                continue;
            }
            if let Some((bytes, permission)) = &originals[rel] {
                atomic_write(&target, bytes, *permission)?
            } else {
                fs::remove_file(&target)?
            }
        }
        receipt["phase"] = json!(if conflicts.is_empty() {
            "rolled_back"
        } else {
            "rollback_conflict"
        });
        receipt["rollback_conflicts"] = json!(conflicts);
        if let Ok(status) = read_status(cli, &home) {
            receipt["rollback_status"] = status
        }
        save(&receipt)?;
        return Err(format!(
            "{error}; {}; receipt: {}",
            s(&receipt["phase"]),
            backup.join("receipt.json").display()
        )
        .into());
    }
    Ok(backup)
}
pub fn cli(args: &[String]) -> Result<()> {
    let repo = option(args, "--repo")
        .map(expand)
        .unwrap_or_else(repo_default);
    let home = option(args, "--home").map(expand).unwrap_or_else(app_home);
    let cli = option(args, "--cli").unwrap_or_else(|| "herdr-app".into());
    let timeout = option(args, "--verify-timeout")
        .unwrap_or_else(|| "10".into())
        .parse::<f64>()?;
    if timeout < 1.5 {
        return Err("--verify-timeout must be at least 1.5 seconds".into());
    }
    if !repo.join("mods").is_dir() || !repo.join("layouts").is_dir() {
        return Err("Run from a source worktree, or pass --repo /path/to/reviewed-worktree".into());
    }
    let names = positionals(
        args,
        &["--without-workspace-mods", "--allow-unhealthy-before"],
    );
    let app_files = names
        .iter()
        .filter(|n| !Path::new(n).starts_with("voice"))
        .cloned()
        .collect::<Vec<_>>();
    let voice = app_files.len() != names.len();
    let release = if !has(args, "--without-workspace-mods") && (!app_files.is_empty() || !voice) {
        Some(install::pinned_files(
            &repo,
            option(args, "--workspace-mods-source")
                .map(expand)
                .as_deref(),
        )?)
    } else {
        None
    };
    let extra = release.as_ref().map(|x| x.2.as_slice()).unwrap_or(&[]);
    if app_files.is_empty() && extra.is_empty() && !voice {
        return crate::common::usage(
            "list files to install (or leave out --without-workspace-mods)",
        );
    }
    let backup = if !app_files.is_empty() || !extra.is_empty() {
        Some(update(
            &repo,
            &home,
            &app_files,
            &cli,
            timeout,
            has(args, "--allow-unhealthy-before"),
            extra,
        )?)
    } else {
        None
    };
    if let Some((pin, _, _)) = &release {
        install::record(&home, pin)?
    }
    if voice {
        checked(
            command(std::env::current_exe()?)
                .arg("voice-install")
                .arg("--source")
                .arg(repo.join("voice"))
                .env("HERDR_APP_HOME", &home),
        )?;
    }
    if app_files
        .iter()
        .any(|p| Path::new(p).starts_with("scripts"))
    {
        let observer_home = option(args, "--observer-home")
            .map(expand)
            .unwrap_or_else(user_home);
        let result = observers::refresh(&observer_home, &repo)?;
        println!("Observer copies: {result}")
    }
    if let Some(backup) = backup {
        println!(
            "Installed and verified errors=0; backup/receipt: {}",
            backup.display()
        )
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_config_keeps_user_values() {
        assert_eq!(
            fill_missing(
                &json!({"a":{"mine":1},"list":[1]}),
                &json!({"a":{"mine":2,"new":3},"list":[2]})
            )
            .unwrap(),
            json!({"a":{"mine":1,"new":3},"list":[1]})
        );
    }
    #[test]
    fn unsafe_target_and_recovery_mod_rejected() {
        let t = tempfile::tempdir().unwrap();
        assert!(input_files(t.path(), t.path(), &["../bad".into()]).is_err());
        assert!(validate_json(&json!({"content":{"mod":"foo-recovery"}})).is_err());
    }
    #[test]
    fn exchange_is_reversible() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        let b = t.path().join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(a.join("one"), "1").unwrap();
        fs::write(b.join("two"), "2").unwrap();
        exchange(&a, &b).unwrap();
        assert!(a.join("two").exists());
        exchange(&a, &b).unwrap();
        assert!(a.join("one").exists());
    }
}
