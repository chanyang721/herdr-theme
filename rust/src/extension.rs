//! Extension commands: a command this binary does not know is looked up as a separate
//! executable named `herdr-theme-<command>`, first beside this binary, then on PATH,
//! and run with the remaining arguments (the same convention as `git <name>`).
//! Nothing is installed or configured by the theme; without such an executable the
//! command fails as unknown.
use crate::common::*;
use std::path::{Path, PathBuf};
const PREFIX: &str = "herdr-theme-";
fn valid(name: &str) -> bool {
    crate::python_unicode::regex(r"^[a-z][a-z0-9-]{0,47}$").is_match(name)
}
fn file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{PREFIX}{name}.exe")
    } else {
        format!("{PREFIX}{name}")
    }
}
fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
/// The extension executable for `name`, if one is installed.
pub fn find(name: &str, beside: Option<&Path>, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    if !valid(name) {
        return None;
    }
    let file = file_name(name);
    beside
        .map(|dir| dir.join(&file))
        .into_iter()
        .chain(path.into_iter().flat_map(std::env::split_paths).map(|dir| dir.join(&file)))
        .find(|candidate| executable(candidate))
}
pub fn run(invoked: &str, command: &str, args: &[String]) -> Result<()> {
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let path = std::env::var_os("PATH");
    let Some(program) = find(invoked, beside.as_deref(), path.as_deref()) else {
        return Err(format!("unknown command: {command}").into());
    };
    let mut child = std::process::Command::new(&program);
    child.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(child.exec().into())
    }
    #[cfg(not(unix))]
    {
        std::process::exit(child.status()?.code().unwrap_or(1));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_beside_then_path_and_refuses_odd_names() {
        let temp = tempfile::tempdir().unwrap();
        let (beside, other) = (temp.path().join("a"), temp.path().join("b"));
        std::fs::create_dir_all(&beside).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        for dir in [&beside, &other] {
            let file = dir.join(file_name("demo"));
            std::fs::write(&file, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let path = std::env::join_paths([&other]).unwrap();
        assert_eq!(
            find("demo", Some(&beside), Some(&path)),
            Some(beside.join(file_name("demo")))
        );
        assert_eq!(
            find("demo", None, Some(&path)),
            Some(other.join(file_name("demo")))
        );
        assert_eq!(find("missing", Some(&beside), Some(&path)), None);
        for odd in ["../demo", "Demo", "", "demo/x", "-demo"] {
            assert_eq!(find(odd, Some(&beside), Some(&path)), None, "{odd}");
        }
    }
}
