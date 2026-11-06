use super::{gate, native, output_unbounded as output, settings, write_json, Exit, Result};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
};
const ID: &str = "local.focus-queue";
fn no_start() -> bool {
    env::var("HERDR_VOICE_NO_START").ok().as_deref() == Some("1")
}
fn root() -> Result<PathBuf> {
    if let Some(path) = env::var_os("HERDR_VOICE_ROOT") {
        return Ok(PathBuf::from(path));
    }
    let exe = env::current_exe()?;
    let parent = exe.parent().ok_or("executable lacks parent")?;
    if parent.join("herdr-plugin.toml").is_file() {
        return Ok(parent.to_path_buf());
    }
    let checkout = crate::documents::common::source_repository()
        .map(|repo| repo.join("voice"))
        .unwrap_or_else(|| parent.to_path_buf());
    if checkout.join("herdr-plugin.toml").is_file() {
        Ok(checkout)
    } else {
        Ok(parent.to_path_buf())
    }
}
fn executable(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "herdr-theme.exe"
    } else {
        "herdr-theme"
    })
}
fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}
fn hook(root: &Path) -> String {
    format!("{} voice_submit_hook", quote(&executable(root)))
}
pub fn label(home: &Path) -> String {
    let value = settings::read_file(&home.join(".config/herdr-app/data/sixfold/site.local.json"));
    let prefix = value["label_prefix"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("local.herdr-sixfold");
    format!("{prefix}.herdr-codex-focus")
}
fn integration() -> PathBuf {
    settings::app_home().join("data/sixfold/voice-integration.json")
}
fn claude(name: &str) -> PathBuf {
    settings::home().join(".claude").join(name)
}
fn edit<F: FnOnce(&mut Value)>(path: &Path, change: F) -> Result<bool> {
    let mut value = if path.exists() {
        serde_json::from_str(&crate::legacy_text::read(
            path,
            crate::legacy_text::ErrorPolicy::Strict,
        )?)?
    } else {
        json!({})
    };
    let before = value.clone();
    change(&mut value);
    if value == before {
        return Ok(false);
    }
    if path.exists() {
        let backup = PathBuf::from(format!(
            "{}.focusq-{}.bak",
            path.display(),
            chrono::Local::now().format("%Y%m%d%H%M%S")
        ));
        crate::documents::common::copy_file(path, backup)?;
    }
    write_json(path, &value)?;
    Ok(true)
}
fn entries(value: &mut Value) -> &mut Vec<Value> {
    if !value["hooks"].is_object() {
        value["hooks"] = json!({});
    }
    if !value["hooks"]["UserPromptSubmit"].is_array() {
        value["hooks"]["UserPromptSubmit"] = json!([]);
    }
    value["hooks"]["UserPromptSubmit"].as_array_mut().unwrap()
}
fn is_ours(command: &str) -> bool {
    command.trim_end().ends_with("/voice_submit_hook.py")
        || command.trim_end().ends_with(" voice_submit_hook")
}
fn set_hook(value: &mut Value, root: &Path) {
    let desired = hook(root);
    let entries = entries(value);
    for entry in entries.iter_mut() {
        if let Some(hooks) = entry["hooks"].as_array_mut() {
            hooks.retain(|h| {
                let c = h["command"].as_str().unwrap_or("");
                !is_ours(c) || c == desired
            });
        }
    }
    entries.retain(|e| {
        e["hooks"]
            .as_array()
            .map(|h| !h.is_empty())
            .unwrap_or(false)
    });
    if !entries
        .iter()
        .flat_map(|e| e["hooks"].as_array().into_iter().flatten())
        .any(|h| h["command"] == desired)
    {
        entries.push(json!({"hooks":[{"type":"command","command":desired}]}));
    }
}
fn remove_hook(value: &mut Value, root: &Path) {
    let desired = hook(root);
    entries(value).retain(|e| {
        !e["hooks"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|h| h["command"] == desired)
    });
}
fn set_voice(value: &mut Value) {
    value["voiceEnabled"] = json!(true);
    if !value["voice"].is_object() {
        value["voice"] = json!({});
    }
    value["voice"]["enabled"] = json!(true);
    value["voice"]["mode"] = json!("tap");
    if value.get("language").is_none() {
        value["language"] = json!("korean");
    }
}
fn chat_bindings(value: &mut Value) -> &mut Value {
    if !value["bindings"].is_array() {
        value["bindings"] = json!([]);
    }
    let blocks = value["bindings"].as_array_mut().unwrap();
    let index = blocks
        .iter()
        .position(|b| b["context"] == "Chat")
        .unwrap_or_else(|| {
            blocks.push(json!({"context":"Chat","bindings":{}}));
            blocks.len() - 1
        });
    if !blocks[index]["bindings"].is_object() {
        blocks[index]["bindings"] = json!({});
    }
    &mut blocks[index]["bindings"]
}
fn herdr(args: &[&str]) -> Result<Value> {
    let Some(binary) = crate::common::find_executable("herdr") else {
        return Err("herdr is not installed: brew install herdr".into());
    };
    let response = super::capture(&binary.to_string_lossy(), args, None)?;
    if response.code != 0 {
        return Err(format!(
            "herdr {} failed: {}",
            args.join(" "),
            if response.stderr.trim().is_empty() {
                response.stdout.trim()
            } else {
                response.stderr.trim()
            }
        )
        .into());
    }
    let value: Value = serde_json::from_str(&response.stdout).unwrap_or_else(|_| json!({}));
    Ok(value.get("result").cloned().unwrap_or_else(|| json!({})))
}
fn plugin() -> Result<Option<Value>> {
    Ok(herdr(&["plugin", "list", "--json"])?["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["plugin_id"] == ID)
        .cloned())
}
fn linked(root: &Path, p: Option<&Value>) -> bool {
    p.and_then(|p| p["manifest_path"].as_str())
        .and_then(|p| Path::new(p).parent())
        .and_then(|p| p.canonicalize().ok())
        == root.canonicalize().ok()
}
pub fn write_codex_agent(home: &Path, root: &Path, start: bool) -> Result<PathBuf> {
    let binary = executable(root);
    if !binary.is_file() {
        return Err(format!("{} is missing", binary.display()).into());
    }
    let state = home.join(".local/state/herdr/plugins/local.focus-queue");
    fs::create_dir_all(&state)?;
    let agents = home.join("Library/LaunchAgents");
    fs::create_dir_all(&agents)?;
    let name = label(home);
    let path = agents.join(format!("{name}.plist"));
    let value = json!({"Label":name,"ProgramArguments":[binary.to_string_lossy(),"codex_focus","--serve"],"RunAtLoad":true,"KeepAlive":true,"ThrottleInterval":5,"EnvironmentVariables":{"PATH":format!("{}:/opt/homebrew/bin:/usr/bin:/bin",home.join(".local/bin").display()),"HERDR_PLUGIN_STATE_DIR":state.to_string_lossy()},"StandardOutPath":state.join("codex-focus-monitor.log").to_string_lossy(),"StandardErrorPath":state.join("codex-focus-monitor.log").to_string_lossy()});
    let temp = path.with_extension("tmp");
    let mut bytes = vec![];
    plist::to_writer_xml(&mut bytes, &value)?;
    fs::write(&temp, bytes)?;
    fs::rename(temp, &path)?;
    if start {
        #[cfg(unix)]
        let uid = unsafe { libc::getuid() };
        #[cfg(not(unix))]
        let uid = 0;
        let domain = format!("gui/{uid}");
        super::capture("launchctl", &["bootout", &format!("{domain}/{name}")], None)?;
        super::checked_inherit(
            "launchctl",
            &["bootstrap", &domain, &path.to_string_lossy()],
        )?;
    }
    voice_println!(
        "Codex focus guard installed: {}; manual mute preserved; no voice connection toggled",
        path.display()
    );
    Ok(path)
}
pub fn codex_install(args: &[String]) -> Result<()> {
    let Some(args) = parse_options(
        args,
        &["--target-home"],
        &["--no-start", "--uninstall"],
        "install_codex_focus",
    )?
    else {
        return Ok(());
    };
    let args = &args;
    let home = option(args, "--target-home")
        .map(PathBuf::from)
        .unwrap_or_else(settings::home);
    let start = !option_flag(args, "--no-start");
    if crate::documents::common::resolved(&home)
        != crate::documents::common::resolved(settings::home())
        && start
    {
        return crate::common::usage("an isolated target home requires --no-start");
    }
    if option_flag(args, "--uninstall") {
        if start {
            #[cfg(unix)]
            let uid = unsafe { libc::getuid() };
            #[cfg(not(unix))]
            let uid = 0;
            super::capture(
                "launchctl",
                &["bootout", &format!("gui/{uid}/{}", label(&home))],
                None,
            )?;
        }
        let _ = fs::remove_file(
            home.join("Library/LaunchAgents")
                .join(format!("{}.plist", label(&home))),
        );
        Ok(())
    } else {
        write_codex_agent(&home, &root()?, start)?;
        Ok(())
    }
}
fn install_at(root: &Path) -> Result<()> {
    let binary = executable(root);
    let current = env::current_exe()?;
    if binary.canonicalize().ok() != Some(current.canonicalize()?) {
        if fs::symlink_metadata(&binary)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("refusing to replace a symlinked voice executable".into());
        }
        fs::create_dir_all(root)?;
        let stage = root.join(format!(".herdr-theme-{}.tmp", std::process::id()));
        fs::copy(&current, &stage)?;
        fs::rename(&stage, &binary)?;
    }
    let current = plugin()?;
    let settings = settings::read_file(&claude("settings.json"));
    let commands: Vec<_> = settings["hooks"]["UserPromptSubmit"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|e| e["hooks"].as_array().into_iter().flatten())
        .filter_map(|h| h["command"].as_str())
        .collect();
    let want_hook = current.is_none() || commands.iter().any(|c| is_ours(c));
    if current.is_some() && !linked(root, current.as_ref()) {
        herdr(&["plugin", "unlink", ID])?;
    }
    if !linked(root, plugin()?.as_ref()) {
        herdr(&["plugin", "link", &root.to_string_lossy()])?;
    }
    if plugin()?.map(|p| p["enabled"] != true).unwrap_or(true) {
        herdr(&["plugin", "enable", ID])?;
    }
    edit(&claude("settings.json"), set_voice)?;
    if want_hook {
        edit(&claude("settings.json"), |v| set_hook(v, root))?;
    } else {
        voice_println!("submit hook left off as before: focusq voice-hook adds it");
    }
    edit(&claude("keybindings.json"), |v| {
        chat_bindings(v)["f8"] = json!("voice:pushToTalk")
    })?;
    edit(&integration(), |v| {
        v["command"] = json!(executable(root).to_string_lossy());
        v["args"] = json!(["focus_queue"]);
        v["script"] = json!(executable(root).to_string_lossy());
    })?;
    write_codex_agent(&settings::home(), root, !no_start())?;
    voice_println!(
        "installed from {}: plugin linked and enabled, Claude Code voice on F8 (tap mode)",
        root.display()
    );
    if no_start() {
        voice_println!("voice check not set up (HERDR_VOICE_NO_START)");
    } else {
        voice_setup()?;
    }
    voice_println!("restart running Claude Code sessions to pick up the F8 voice key");
    Ok(())
}
fn check(root: &Path) -> Result<bool> {
    let mut problems = vec![];
    let current = plugin()?;
    if !linked(root, current.as_ref()) {
        problems.push(format!(
            "herdr plugin: {}",
            current
                .as_ref()
                .and_then(|p| p["manifest_path"].as_str())
                .unwrap_or("not linked")
        ));
    }
    let value = settings::read_file(&claude("settings.json"));
    let commands: Vec<_> = value["hooks"]["UserPromptSubmit"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|e| e["hooks"].as_array().into_iter().flatten())
        .filter_map(|h| h["command"].as_str())
        .collect();
    let desired = hook(root);
    if commands.iter().any(|c| is_ours(c) && *c != desired) {
        problems.push(format!("Claude submit hook: {commands:?}"));
    } else if !commands.contains(&desired.as_str()) {
        voice_println!("note - Claude submit hook is off (focusq voice-hook adds it)");
    }
    let integration = settings::read_file(&integration());
    if integration["command"] != executable(root).to_string_lossy().as_ref()
        || integration["args"] != json!(["focus_queue"])
    {
        problems.push(format!("app focus routing: {integration}"));
    }
    let path = settings::home()
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", label(&settings::home())));
    let agent = plist::Value::from_file(path).ok();
    let arguments = agent
        .as_ref()
        .and_then(|p| p.as_dictionary())
        .and_then(|d| d.get("ProgramArguments"))
        .and_then(|v| v.as_array());
    if !arguments
        .map(|a| {
            a.first().and_then(plist::Value::as_string)
                == Some(executable(root).to_string_lossy().as_ref())
                && a.get(1).and_then(plist::Value::as_string) == Some("codex_focus")
        })
        .unwrap_or(false)
    {
        problems.push(format!("Codex focus LaunchAgent: {arguments:?}"));
    }
    for p in &problems {
        voice_println!("not this copy - {p}");
    }
    if problems.is_empty() {
        voice_println!("all voice entry points run {}", root.display());
    }
    Ok(problems.is_empty())
}
fn uninstall(root: &Path) -> Result<()> {
    codex_install(&["--uninstall".into()])?;
    if plugin()?.is_some() {
        herdr(&["plugin", "unlink", ID])?;
    }
    edit(&claude("keybindings.json"), |v| {
        chat_bindings(v).as_object_mut().unwrap().remove("f8");
    })?;
    edit(&claude("settings.json"), |v| remove_hook(v, root))?;
    voice_println!("uninstalled: plugin unlinked, F8 voice binding and submit hook removed (voice settings kept)");
    Ok(())
}
fn status() -> Result<()> {
    match plugin()? {
        None => voice_println!("not installed: run focusq install"),
        Some(p) => voice_println!(
            "{}  {}",
            if p["enabled"] == true {
                "enabled"
            } else {
                "disabled"
            },
            p["manifest_path"].as_str().unwrap_or("")
        ),
    }
    Ok(())
}
pub fn voice_setup() -> Result<()> {
    let voice = settings::voice_home();
    let models = voice.join("models");
    fs::create_dir_all(&models)?;
    if !Path::new("/opt/homebrew/lib/libportaudio.dylib").exists()
        && !Path::new("/usr/local/lib/libportaudio.dylib").exists()
        && env::var_os("HERDR_PORTAUDIO_LIBRARY").is_none()
    {
        output("brew", &["install", "portaudio"], 600.)?;
    }
    let native = voice.join("native");
    if !native.join("lib/libsherpa-onnx-c-api.dylib").exists() {
        let archive = voice.join("sherpa-native.tar.bz2.part");
        let url=format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/v{}/sherpa-onnx-v{}-osx-universal2-shared-no-tts-lib.tar.bz2",native::SHERPA_VERSION,native::SHERPA_VERSION);
        output(
            "curl",
            &[
                "-fsSL",
                "--retry",
                "2",
                "-o",
                &archive.to_string_lossy(),
                &url,
            ],
            600.,
        )?;
        use sha2::{Digest, Sha256};
        let actual = format!("{:x}", Sha256::digest(fs::read(&archive)?));
        if actual != "242b0593a033456e9344a76a11713d1c55da794d0e37eabf6acabaf7beeb2b36" {
            return Err("sherpa native archive checksum mismatch".into());
        }
        let stage = tempfile::Builder::new()
            .prefix(".native-stage-")
            .tempdir_in(&voice)?;
        output(
            "tar",
            &[
                "-xjf",
                &archive.to_string_lossy(),
                "-C",
                &stage.path().to_string_lossy(),
                "--strip-components=1",
            ],
            120.,
        )?;
        if !stage
            .path()
            .join("lib/libsherpa-onnx-c-api.dylib")
            .is_file()
        {
            return Err("sherpa native archive lacks C API library".into());
        }
        if native.exists() {
            return Err(
                "partial native installation exists; preserve it and repair explicitly".into(),
            );
        }
        let stage = stage.keep();
        fs::rename(&stage, &native)?;
        fs::remove_file(&archive)?;
    }
    for(model,url)in[(gate::EMBEDDING_MODEL,format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{}",gate::EMBEDDING_MODEL)),("silero_vad.onnx","https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx".into())]{let target=models.join(model);if !target.exists(){let partial=target.with_extension("onnx.part");output("curl",&["-fsSL","--retry","2","-o",&partial.to_string_lossy(),&url],600.)?;fs::rename(partial,target)?;}}
    install_blas()?;
    install_sndfile()?;
    voice_println!(
        "voice check ready in {}: your voice is learned from the dictations you send",
        voice.display()
    );
    Ok(())
}
fn install_blas() -> Result<()> {
    install_native_archive(
        "blas",
        super::linalg::configuration()?,
        super::linalg::verify,
    )
}
fn install_sndfile() -> Result<()> {
    install_native_archive(
        "sndfile",
        super::audio::configuration()?,
        super::audio::verify,
    )?;
    fs::write(
        settings::voice_home().join("native/sndfile/provenance.json"),
        serde_json::to_vec_pretty(&super::audio::manifest())?,
    )?;
    Ok(())
}
fn install_native_archive(
    kind: &str,
    config: Value,
    verify: fn(&Path) -> Result<()>,
) -> Result<()> {
    let target = settings::voice_home().join("native").join(kind);
    let primary = config["primary"]
        .as_str()
        .ok_or("native voice primary missing")?;
    if target.exists() {
        return verify(&target.join(primary));
    }
    let stage = tempfile::Builder::new()
        .prefix(&format!(".{kind}-stage-"))
        .tempdir_in(settings::voice_home())?;
    let wheel = &config["wheel"];
    let carrier = stage.path().join(
        wheel["filename"]
            .as_str()
            .ok_or("native voice carrier missing")?,
    );
    output(
        "curl",
        &[
            "-fsSL",
            "--retry",
            "2",
            "-o",
            &carrier.to_string_lossy(),
            wheel["url"].as_str().ok_or("native voice URL missing")?,
        ],
        600.,
    )?;
    use sha2::{Digest, Sha256};
    let actual = format!("{:x}", Sha256::digest(fs::read(&carrier)?));
    if wheel["sha256"].as_str() != Some(actual.as_str()) {
        return Err("native voice carrier checksum mismatch".into());
    }
    let extracted = stage.path().join(kind);
    fs::create_dir(&extracted)?;
    let mut args = vec!["-j".to_owned(), carrier.to_string_lossy().into_owned()];
    for item in config["files"]
        .as_array()
        .ok_or("native voice file list missing")?
    {
        args.push(
            item["entry"]
                .as_str()
                .ok_or("native voice archive entry missing")?
                .to_owned(),
        );
    }
    args.extend(["-d".to_owned(), extracted.to_string_lossy().into_owned()]);
    output(
        "unzip",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        120.,
    )?;
    verify(&extracted.join(primary))?;
    fs::rename(extracted, target)?;
    Ok(())
}
fn stop_gate() -> Result<()> {
    let pid = settings::state_dir().join("voicegate.pid");
    if !super::alive(&pid) {
        return Ok(());
    }
    if let Some(pid) = fs::read_to_string(pid)
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|p| *p > 0)
    {
        // A stale PID file must never terminate a different process.
        let command =
            output("ps", &["-p", &pid.to_string(), "-o", "command="], 5.).unwrap_or_default();
        let own = std::env::current_exe()?.to_string_lossy().into_owned();
        let installed = settings::voice_home().join("plugin");
        let native = executable(&installed).to_string_lossy().into_owned();
        let legacy = installed
            .join("voicegate.py")
            .to_string_lossy()
            .into_owned();
        let expected = ((command.contains(&own) || command.contains(&native))
            && command.contains("voicegate serve"))
            || command.contains(&(legacy + " serve"));
        if !expected {
            return Err("voice gate PID identity is unknown; refusing to terminate it".into());
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline = super::now() + 2.;
        while super::now() < deadline {
            #[cfg(unix)]
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    Ok(())
}
fn voice_off() -> Result<()> {
    stop_gate()?;
    let dir = settings::state_dir();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if (name.starts_with("voiceprint") && name.ends_with(".json"))
                || (name.starts_with("voice-pool") && name.ends_with(".jsonl"))
                || ["voice-segments.jsonl", "voice-confirmed.jsonl"].contains(&name.as_str())
            {
                fs::remove_file(entry.path())?;
            }
        }
    }
    voice_println!("voiceprint removed: it is learned again from the dictations you send");
    Ok(())
}
pub fn focusq(args: &[String]) -> Result<()> {
    let command = args.first().map(String::as_str).unwrap_or("status");
    let root = root()?;
    match command {
        "setup" => {
            if crate::common::find_executable("herdr").is_none() {
                if crate::common::find_executable("brew").is_none() {
                    return Err(
                        "herdr is not installed and Homebrew is missing: https://brew.sh".into(),
                    );
                }
                super::checked_inherit("brew", &["install", "herdr"])?;
            }
            install_at(&root)?;
            if settings::state_dir().join("voiceprint.json").exists() {
                voice_println!(
                    "voice: already learned on this machine; it keeps learning from what you send"
                );
            } else if args.iter().any(|a| a == "--enroll") {
                voice_println!(
                    "\n목소리를 학습합니다. 에이전트가 없는 셸 pane 에서 실행 중이어야 합니다."
                );
                gate::run(&["enroll".into()])?;
                voice_println!(
                    "voice: voiceprint saved; it keeps learning from the dictations you send"
                );
            } else {
                voice_println!("voice: learned on this machine from the dictations you send. After about 30 s of them your");
                voice_println!("       voice is sent without the send word and other voices are not (./focusq setup --enroll to start now)");
            }
            Ok(())
        }
        "install" => install_at(&root),
        "check" => {
            if check(&root)? {
                Ok(())
            } else {
                Err(Exit(1).into())
            }
        }
        "uninstall" => uninstall(&root),
        "status" => status(),
        "enable" | "disable" => {
            if plugin()?.is_none() {
                return Err("not installed: run ./focusq install".into());
            }
            herdr(&["plugin", command, ID])?;
            status()
        }
        "voice-setup" => {
            voice_setup()?;
            voice_println!("now run ./focusq voice-enroll");
            Ok(())
        }
        "voice-enroll" => {
            let mut a = vec!["enroll".into()];
            a.extend(args.iter().skip(1).cloned());
            run_voicegate(&a)
        }
        "voice-test" => run_voicegate(&["tail".into()]),
        "voice-hook" => {
            let changed = edit(&claude("settings.json"), |v| set_hook(v, &root))?;
            voice_println!(
                "submit hook {} {}: {}",
                if changed { "added to" } else { "already in" },
                claude("settings.json").display(),
                hook(&root)
            );
            Ok(())
        }
        "voice-restart" => {
            require_voice_runtime()?;
            stop_gate()?;
            super::self_launch("voicegate", &["serve"])?;
            Ok(())
        }
        "voice-off" => voice_off(),
        "voice-crosscheck" => {
            require_voice_runtime()?;
            super::evaluate::crosscheck()
        }
        _ => Err(include_str!("help/focusq.txt").trim_end().into()),
    }
}
fn require_voice_runtime() -> Result<()> {
    if !native::runtime_available() {
        return Err("run ./focusq voice-setup first".into());
    }
    Ok(())
}
fn run_voicegate(args: &[String]) -> Result<()> {
    require_voice_runtime()?;
    stop_gate()?;
    gate::run(args)
}
fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    super::cli::value(args, name, &["--home", "--source", "--target-home"])
}

fn option_flag(args: &[String], name: &str) -> bool {
    super::cli::flag(args, name, &["--home", "--source", "--target-home"])
}

fn skip(name: &str) -> bool {
    [
        "__pycache__",
        ".DS_Store",
        ".git",
        "native-model-differential.mjs",
        "native-model-differential.test.mjs",
        "model-probe-assets.json",
        "native-eval-differential.mjs",
        "native-eval-differential.test.mjs",
        "eval-probe-assets.json",
        "native-audio-differential.mjs",
        "native-audio-differential.test.mjs",
        "native-dataset-differential.mjs",
        "native-dataset-differential.test.mjs",
        "model-c-api-windows-x64.json",
    ]
    .contains(&name)
        || name.ends_with(".pyc")
        || name.ends_with(".py")
}
fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip(&name) {
            continue;
        }
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
fn same_tree(a: &Path, b: &Path) -> Result<bool> {
    fn files(root: &Path) -> Result<std::collections::BTreeMap<PathBuf, (Vec<u8>, u32)>> {
        let mut map = std::collections::BTreeMap::new();
        for entry in walkdir::WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| !skip(&e.file_name().to_string_lossy()))
        {
            let entry = entry?;
            if entry.file_type().is_file() {
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    entry.metadata()?.permissions().mode() & 0o777
                };
                #[cfg(not(unix))]
                let mode = 0;
                map.insert(
                    entry.path().strip_prefix(root)?.to_path_buf(),
                    (fs::read(entry.path())?, mode),
                );
            }
        }
        Ok(map)
    }
    Ok(files(a)? == files(b)?)
}
#[cfg(target_os = "macos")]
fn swap(a: &Path, b: &Path) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let a = std::ffi::CString::new(a.as_os_str().as_bytes())?;
    let b = std::ffi::CString::new(b.as_os_str().as_bytes())?;
    unsafe extern "C" {
        fn renamex_np(a: *const libc::c_char, b: *const libc::c_char, flags: u32) -> i32;
    }
    if unsafe { renamex_np(a.as_ptr(), b.as_ptr(), 2) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn swap(_: &Path, _: &Path) -> Result<()> {
    Err("atomic directory exchange requires macOS".into())
}
pub fn place(source: &Path, target: &Path) -> Result<bool> {
    let parent = target.parent().ok_or("plugin target lacks parent")?;
    fs::create_dir_all(parent)?;
    let stage = tempfile::Builder::new()
        .prefix(".plugin-stage-")
        .tempdir_in(parent)?;
    let new = stage.path().join("plugin");
    copy_tree(source, &new)?;
    fs::copy(env::current_exe()?, executable(&new))?;
    let notices = new.join("native-licenses");
    fs::create_dir_all(&notices)?;
    for (name, bytes) in crate::notices::files() {
        fs::write(notices.join(name), bytes)?;
    }
    fs::write(
        new.join("focusq"),
        "#!/bin/sh\nexec \"$(dirname \"$0\")/herdr-theme\" focusq \"$@\"\n",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(new.join("focusq"), fs::Permissions::from_mode(0o755))?;
    }
    fs::write(new.join("herdr-plugin.toml"),"id = \"local.focus-queue\"\nname = \"Focus Queue\"\nversion = \"0.3.0\"\nmin_herdr_version = \"0.9.0\"\ndescription = \"Focus panes that finish, but wait while the focused pane is waiting for your input; voice follows focus\"\nplatforms = [\"macos\"]\n[[events]]\non = \"pane.agent_status_changed\"\ncommand = [\"./herdr-theme\", \"focus_queue\"]\n[[events]]\non = \"pane.focused\"\ncommand = [\"./herdr-theme\", \"focus_queue\"]\n")?;
    if fs::symlink_metadata(target)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Not a plugin folder, refusing to replace: {}",
            target.display()
        )
        .into());
    }
    if target.is_dir() {
        if same_tree(&new, target)? {
            return Ok(false);
        }
        swap(&new, target)?;
    } else if target.exists() {
        return Err(format!(
            "Not a plugin folder, refusing to replace: {}",
            target.display()
        )
        .into());
    } else {
        fs::rename(new, target)?;
    }
    Ok(true)
}
pub fn run(args: &[String]) -> Result<()> {
    let Some(args) = parse_options(
        args,
        &["--home", "--source"],
        &["--enroll", "--check", "--no-start"],
        "voice_install",
    )?
    else {
        return Ok(());
    };
    let args = &args;
    if !cfg!(target_os = "macos") {
        crate::legacy_text::error_line("Voice plugin skipped: macOS only.")?;
        return Ok(());
    }
    let old_home = settings::home();
    let cwd = env::current_dir()?;
    let home = voice_install_home(option(args, "--home"), &old_home, &cwd);
    let isolated = home != voice_install_home(None, &old_home, &cwd);
    if isolated {
        env::set_var("HOME", &home);
        if env::var_os("HERDR_APP_HOME").is_none() {
            env::set_var("HERDR_APP_HOME", home.join(".config/herdr-app"));
        }
    }
    if isolated || option_flag(args, "--no-start") {
        env::set_var("HERDR_VOICE_NO_START", "1");
    }
    let target = home.join(".local/share/herdr-focus-queue/plugin");
    if option_flag(args, "--check") {
        if !target.join("focusq").is_file() {
            crate::legacy_text::print_line(&format!(
                "not this copy - voice plugin not installed at {}",
                target.display()
            ))?;
            return Err(Exit(1).into());
        }
        return if check(&target)? {
            Ok(())
        } else {
            Err(Exit(1).into())
        };
    }
    let source = if let Some(source) = option(args, "--source") {
        PathBuf::from(source)
    } else if let Some(repo) = crate::documents::common::source_repository() {
        repo.join("voice")
    } else {
        let candidate = root()?;
        if candidate.join("herdr-plugin.toml").is_file() {
            candidate
        } else {
            return Err("voice source not found; supply --source VOICE_DIRECTORY".into());
        }
    };
    let changed = place(&source, &target)?;
    voice_println!(
        "voice plugin {}: {}",
        if changed {
            "updated"
        } else {
            "already current"
        },
        target.display()
    );
    install_at(&target)?;
    if option_flag(args, "--enroll") {
        run_voicegate(&["enroll".into()])?;
    }
    if check(&target)? {
        Ok(())
    } else {
        Err(Exit(1).into())
    }
}
fn voice_install_home(argument: Option<&str>, old_home: &Path, cwd: &Path) -> PathBuf {
    let expanded = argument
        .map(|s| crate::documents::common::expand_home(s, old_home))
        .unwrap_or_else(|| old_home.to_path_buf());
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    crate::documents::common::resolved(absolute)
}
fn parse_options(
    args: &[String],
    values: &[&str],
    flags: &[&str],
    command: &str,
) -> Result<Option<Vec<String>>> {
    let result = super::cli::parse(args, values, flags)?;
    if result.help {
        crate::help::show(command, &["--help".into()])?;
        return Ok(None);
    }
    super::cli::unknown(&result.unknown)?;
    Ok(Some(result.normalized))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voice_home_expands_quoted_tilde_before_any_home_change() {
        let sandbox = tempfile::tempdir().unwrap();
        let old = sandbox.path().join("old-home");
        let cwd = sandbox.path().join("workspace");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir(&cwd).unwrap();
        let expected = old
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned();
        assert_eq!(
            voice_install_home(Some("~"), &old, &cwd),
            PathBuf::from(&expected)
        );
        assert_eq!(
            voice_install_home(None, &old, &cwd),
            PathBuf::from(&expected)
        );
        assert_eq!(
            voice_install_home(Some("~/nested/../target"), &old, &cwd),
            PathBuf::from(expected).join("target")
        );
        assert!(!old.join("target").exists());
    }
    #[test]
    fn voice_home_resolves_nonexistent_relative_path_without_installing() {
        let sandbox = tempfile::tempdir().unwrap();
        let old = sandbox.path().join("old-home");
        let cwd = sandbox.path().join("workspace");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir(&cwd).unwrap();
        let expected = cwd
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned();
        let target = voice_install_home(Some("new/../new-home"), &old, &cwd);
        assert_eq!(target, PathBuf::from(expected).join("new-home"));
        assert!(target.is_absolute());
        assert!(!target.exists());
        assert!(!cwd.join("new").exists());
        assert!(!old.join(".claude").exists());
    }
    #[test]
    fn codex_agent_install_is_sandboxed_and_native() {
        let sandbox = tempfile::tempdir().unwrap();
        let home = sandbox.path().join("home");
        let root = sandbox.path().join("plugin");
        fs::create_dir_all(&root).unwrap();
        fs::write(executable(&root), b"native fixture").unwrap();
        let path = write_codex_agent(&home, &root, false).unwrap();
        let value = plist::Value::from_file(&path).unwrap();
        let dict = value.as_dictionary().unwrap();
        let args = dict["ProgramArguments"].as_array().unwrap();
        assert_eq!(
            args[0].as_string(),
            Some(executable(&root).to_string_lossy().as_ref())
        );
        assert_eq!(args[1].as_string(), Some("codex_focus"));
        assert_eq!(args[2].as_string(), Some("--serve"));
        assert_eq!(
            dict["Label"].as_string(),
            Some("local.herdr-sixfold.herdr-codex-focus")
        );
        assert!(!home.join(".config").exists());
        assert!(!home.join(".codex").exists());
        assert!(!home.join(".claude").exists());
    }
    #[test]
    fn plugin_copy_contains_only_native_entrypoints_and_is_repeatable() {
        let sandbox = tempfile::tempdir().unwrap();
        let source = sandbox.path().join("source");
        let target = sandbox.path().join("installed/plugin");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("README.md"), "voice docs").unwrap();
        fs::write(
            source.join("voicegate.py"),
            "raise RuntimeError('must never ship')",
        )
        .unwrap();
        fs::write(source.join("focusq"), "old source wrapper").unwrap();
        assert!(place(&source, &target).unwrap());
        assert!(!target.join("voicegate.py").exists());
        assert!(executable(&target).is_file());
        for (name, bytes) in crate::notices::files() {
            assert_eq!(
                fs::read(target.join("native-licenses").join(name)).unwrap(),
                *bytes
            );
        }
        assert!(fs::read_to_string(target.join("focusq"))
            .unwrap()
            .contains("herdr-theme\" focusq"));
        let manifest = fs::read_to_string(target.join("herdr-plugin.toml")).unwrap();
        assert!(!manifest.contains("python"));
        assert_eq!(
            manifest
                .matches("command = [\"./herdr-theme\", \"focus_queue\"]")
                .count(),
            2
        );
        assert!(!place(&source, &target).unwrap());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn plugin_update_uses_real_atomic_exchange() {
        let sandbox = tempfile::tempdir().unwrap();
        let source = sandbox.path().join("source");
        let target = sandbox.path().join("installed/plugin");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("README.md"), "before").unwrap();
        assert!(place(&source, &target).unwrap());
        fs::write(source.join("README.md"), "after").unwrap();
        assert!(place(&source, &target).unwrap());
        assert_eq!(
            fs::read_to_string(target.join("README.md")).unwrap(),
            "after"
        );
    }
    #[test]
    fn hooks_relocate_once_without_touching_other_hooks() {
        let root = Path::new("/new/plugin");
        let mut value = json!({"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/usr/bin/python3 /old/voice_submit_hook.py"},{"type":"command","command":"other-hook"}]}]}});
        set_hook(&mut value, root);
        set_hook(&mut value, root);
        let commands: Vec<_> = value["hooks"]["UserPromptSubmit"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|e| e["hooks"].as_array().unwrap())
            .filter_map(|h| h["command"].as_str())
            .collect();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0], "other-hook");
        assert_eq!(commands[1], hook(root));
    }
    #[test]
    fn voice_settings_keep_existing_preferences() {
        let mut v = json!({"language":"english","voice":{"something":1}});
        set_voice(&mut v);
        assert_eq!(v["language"], "english");
        assert_eq!(v["voice"]["something"], 1);
        assert_eq!(v["voice"]["mode"], "tap");
    }
}
