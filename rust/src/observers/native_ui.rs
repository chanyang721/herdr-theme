use super::*;
use std::collections::BTreeMap;
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for item in fs::read_dir(source)? {
        let item = item?;
        let dest = target.join(item.file_name());
        if item.file_type()?.is_dir() {
            copy_tree(&item.path(), &dest)?
        } else {
            fs::copy(item.path(), dest)?;
        }
    }
    Ok(())
}
struct Probe {
    base: PathBuf,
    vars: BTreeMap<String, String>,
}
impl Probe {
    fn run(&self, args: &[String]) -> Result<String> {
        let o = execute_with(args, 20., false, |c| {
            c.envs(&self.vars);
        })?;
        if o.code != 0 {
            return err(format!("{}{}", o.stdout, o.stderr));
        }
        Ok(o.stdout)
    }
    fn status(&self) -> Result<Value> {
        Ok(serde_json::from_str(
            &self.run(&strings(&["herdr-app", "status"]))?,
        )?)
    }
    fn launch(&self) -> Result<Value> {
        let mut args = strings(&["open", "-n", "-g", "-a", "/Applications/Herdr.app"]);
        for (k, v) in &self.vars {
            args.extend(["--env".into(), format!("{k}={v}")]);
        }
        let log = self.base.join("app.log").to_string_lossy().into_owned();
        args.extend(strings(&["--stdout", &log, "--stderr", &log]));
        let o = execute(&args, 20., false)?;
        if o.code != 0 {
            return err(o.stderr);
        }
        for _ in 0..100 {
            if let Ok(v) = self.status() {
                std::thread::sleep(Duration::from_secs(1));
                return Ok(v);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        err("launch timeout")
    }
    fn stop(&self) {
        let _ = self.run(&strings(&["herdr-app", "do", "app.quit"]));
        std::thread::sleep(Duration::from_millis(800));
    }
    fn shot(&self, name: &str) -> Result<String> {
        let p = self
            .base
            .join(format!("{name}.png"))
            .to_string_lossy()
            .into_owned();
        self.run(&strings(&["herdr-app", "shot", &p]))?;
        Ok(p)
    }
    fn swap(&self, main: &Path, text: &str) -> Result<()> {
        let next = self.base.join("next-main.js");
        fs::write(&next, text)?;
        fs::rename(next, main)?;
        std::thread::sleep(Duration::from_millis(700));
        Ok(())
    }
}
const FIXTURE_JS: &str = r#"
const fixturePanes=['working','blocked','idle','done','working','blocked'].map((status,i)=>({pane:'pane'+i,tab:'tab',terminal:'demo'+i,status,focused:i===4,title:status+' / 합성 세션',cwd:'/synthetic',program:{key:'codex',name:'Codex',agent:true}}));
const panes=()=>fixturePanes,spaces=()=>[{id:'space',name:'Share',active:true,machine:null,tabs:[{id:'tab',active:true,name:'합성자료',panes:6}]}],terminals=()=>fixturePanes.map(p=>({address:p.terminal,status:p.status,labels:{},program:p.program,cwd:p.cwd})),agents=()=>fixturePanes.map(p=>({...p,address:p.terminal,space:'space'})),focused=()=>({space:'space',tab:'tab',pane:'pane4',terminal:'demo4'});
"#;
fn json_file(p: &Path, v: &Value) -> Result<()> {
    fs::write(p, v.to_string())?;
    Ok(())
}
pub fn ui_reload(args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("macOS native regression probe in a disposable app/core. [--reloads 80] [--failed-reloads 0] [--install-smoke] [--repo DIR]");
        return Ok(());
    }
    validate_args(
        args,
        &["--reloads", "--failed-reloads", "--repo"],
        &["--install-smoke"],
    )?;
    let parse = |key: &str, default: usize| -> Result<usize> {
        args.iter()
            .position(|a| a == key)
            .and_then(|i| args.get(i + 1))
            .map(|v| {
                v.parse().map_err(|_| {
                    Box::new(crate::common::CliError {
                        code: 2,
                        message: format!("argument {key}: invalid integer value: {v:?}"),
                    }) as Box<dyn std::error::Error>
                })
            })
            .unwrap_or(Ok(default))
    };
    let reloads = parse("--reloads", 80)?;
    let failed = parse("--failed-reloads", 0)?;
    if reloads > 1000 || failed > 200 {
        return arg_error("--reloads must be 0..1000 and --failed-reloads 0..200");
    }
    let core = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join("herdr-core"))
        .find(|p| p.is_file())
        .ok_or_else(|| std::io::Error::other("herdr-core must be available on PATH"))?;
    let root = args
        .iter()
        .position(|a| a == "--repo")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_owned()
        });
    let directory = tempfile::Builder::new()
        .prefix("herdr-null-repro-")
        .tempdir_in("/tmp")?;
    let base = directory.keep();
    let app = base.join("app");
    let mods = app.join("mods/sixfold-desk");
    copy_tree(&root.join("mods/sixfold-desk"), &mods)?;
    for d in ["themes", "layouts", "data/sixfold"] {
        fs::create_dir_all(app.join(d))?;
    }
    for name in ["atom-one-dark", "sixfold-day", "sixfold-night", "win98"] {
        fs::copy(
            home().join(format!(".config/herdr-app/themes/{name}.json")),
            app.join(format!("themes/{name}.json")),
        )?;
    }
    let mut source = fs::read_to_string(mods.join("main.js"))?
        .replace("agents, panes, spaces, terminals, focused,", "");
    source.push_str(FIXTURE_JS);
    let main = mods.join("main.js");
    fs::write(&main, &source)?;
    json_file(
        &app.join("data/sixfold/workspace-pins.local.json"),
        &json!({"spaces":[{"id":"space","machine":null}]}),
    )?;
    json_file(
        &app.join("data/sixfold/project-alerts.json"),
        &json!({"items":[],"projects":["Share"]}),
    )?;
    let body = app.join("mods/qa-body");
    fs::create_dir_all(&body)?;
    fs::write(body.join("main.js"),"import {View,div} from 'gpui-kit';import {theme} from 'herdr';export default class extends View{render(){return div().p(12).text_color(theme().foreground).child('합성 검증 / 실제 세션 아님');}}")?;
    let head = |i: usize| json!({"id":format!("p{i}"),"type":"column","children":[{"id":format!("h{i}"),"type":"block","size":{"px":28},"content":{"mod":"sixfold-desk","props":{"role":"pane","pane":format!("pane{i}")}}},{"id":format!("b{i}"),"type":"block","background":"background","content":{"mod":"qa-body"}}]});
    let mut children = vec![
        json!({"id":"toolbar","type":"block","size":{"px":36},"content":{"mod":"sixfold-desk","props":{"role":"toolbar"}}}),
    ];
    children.extend((0..6).map(head));
    children.push(json!({"id":"footer","type":"block","size":{"px":28},"content":{"mod":"sixfold-desk","props":{"role":"footer"}}}));
    let mut layout = json!({"id":"root","type":"row","theme":"sixfold-night","children":[{"id":"sidebar","type":"block","size":{"px":300},"content":{"mod":"sixfold-desk","props":{"role":"sidebar"}}},{"id":"work","type":"column","children":children}]});
    let lp = app.join("layouts/qa.json");
    json_file(&lp, &layout)?;
    json_file(
        &app.join("shared.json"),
        &json!({"frame.welcomed":"skipped","layout":"qa","sixfold.language":"ko"}),
    )?;
    json_file(
        &app.join("update-notes.json"),
        &json!({"last_run":"0.1.12","presented":["0.1.12"]}),
    )?;
    json_file(
        &app.join("window.json"),
        &json!({"bounds":[40,40,1320,980]}),
    )?;
    json_file(
        &app.join("settings.json"),
        &json!({"telemetry":false,"sounds":{"enabled":false},"appearance":"dark","core":core.to_string_lossy(),"zoom":1}),
    )?;
    let vars: BTreeMap<String, String> = [
        ("HERDR_APP_HOME", app.to_string_lossy().into_owned()),
        (
            "XDG_STATE_HOME",
            base.join("s").to_string_lossy().into_owned(),
        ),
        (
            "XDG_CONFIG_HOME",
            base.join("c").to_string_lossy().into_owned(),
        ),
        ("HC_SESSION", "null-repro".into()),
        ("HERDR_TELEMETRY", "0".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    json_file(&base.join("env.json"), &json!(vars))?;
    let p = Probe {
        base: base.clone(),
        vars,
    };
    let mut receipt =
        json!({"base":base.to_string_lossy(),"fixture":true,"themes":[],"reloads":[]});
    println!("{}", base.display());
    let result = (|| -> Result<()> {
        p.launch()?;
        for name in ["atom-one-dark", "sixfold-day", "sixfold-night", "win98"] {
            layout["theme"] = json!(name);
            json_file(&lp, &layout)?;
            std::thread::sleep(Duration::from_millis(1200));
            let st = p.status()?;
            let shot = p.shot(name)?;
            receipt["themes"]
                .as_array_mut()
                .unwrap()
                .push(json!({"theme":name,"status":st,"shot":shot}));
            if truth(&st["errors"]) {
                return err(st.to_string());
            }
            println!("{}", json!({"theme":name,"errors":st["errors"]}));
        }
        p.swap(
            &main,
            &source.replace(
                "import { WORDS, counts,",
                "import { notYetInstalled, WORDS, counts,",
            ),
        )?;
        let st = p.status()?;
        receipt["partialInstall"] = st.clone();
        if !arr(&st["errors"])
            .iter()
            .any(|e| s(e).contains("Could not find export"))
        {
            return err(st.to_string());
        }
        p.shot("partial-install")?;
        println!("{}", json!({"partialInstallErrors":st["errors"]}));
        p.swap(&main, &source)?;
        receipt["restoredAfterPartial"] = p.status()?;
        if truth(&receipt["restoredAfterPartial"]["errors"]) {
            return err("restore errors");
        }
        println!(
            "{}",
            json!({"restoreErrors":receipt["restoredAfterPartial"]["errors"]})
        );
        p.stop();
        p.launch()?;
        receipt["coldBaseline"] = p.status()?;
        for i in 1..=reloads {
            p.swap(&main, &format!("{source}\n// reload generation {i}\n"))?;
            let st = p.status()?;
            let r = json!({"generation":i,"errors":st["errors"]});
            receipt["reloads"].as_array_mut().unwrap().push(r.clone());
            if truth(&st["errors"]) {
                println!("{r}");
                p.shot("stress-failure")?;
                break;
            }
            if i % 10 == 0 {
                println!("{r}")
            }
        }
        receipt["failedReloadCycles"] = json!([]);
        for i in 1..=failed {
            p.swap(
                &main,
                &source.replace(
                    "import { WORDS, counts,",
                    "import { notYetInstalled, WORDS, counts,",
                ),
            )?;
            let failed = p.status()?;
            p.swap(&main, &source)?;
            let restored = p.status()?;
            receipt["failedReloadCycles"].as_array_mut().unwrap().push(json!({"cycle":i,"failedErrors":failed["errors"],"restoredErrors":restored["errors"]}));
            if truth(&restored["errors"]) {
                println!(
                    "{}",
                    json!({"failedReloadCycle":i,"restoredErrors":restored["errors"]})
                );
                p.shot("failed-reload-stress")?;
                break;
            }
            if i % 10 == 0 {
                println!("{}", json!({"failedReloadCycle":i,"restoredErrors":[]}))
            }
        }
        receipt["freshCheck"] =
            json!(p.run(&strings(&["herdr-app", "check", &mods.to_string_lossy()]))?);
        p.stop();
        p.launch()?;
        receipt["cleanRestart"] = p.status()?;
        if truth(&receipt["cleanRestart"]["errors"]) {
            return err("restart errors");
        }
        p.shot("restart")?;
        println!(
            "{}",
            json!({"restartErrors":receipt["cleanRestart"]["errors"]})
        );
        if args.iter().any(|a| a == "--install-smoke") {
            let candidate = base.join("candidate");
            let source_dir = candidate.join("mods/sixfold-desk");
            fs::create_dir_all(&source_dir)?;
            fs::create_dir_all(candidate.join("layouts"))?;
            fs::write(
                source_dir.join("qa-dependency.js"),
                "export const qaVersion=()=>\"dependency ready\";",
            )?;
            receipt["installer"] = json!([]);
            let exe = std::env::current_exe()?.to_string_lossy().into_owned();
            for revision in [1, 2] {
                fs::write(
                    source_dir.join("main.js"),
                    format!(
                        "import {{qaVersion}} from './qa-dependency.js';\n{}",
                        source.replace(
                            "'HERDR THEME / WORKSPACE'",
                            &format!("'QA INSTALL V{revision} / '+qaVersion()")
                        )
                    ),
                )?;
                let result = p.run(&strings(&[
                    &exe,
                    "update-install",
                    "--repo",
                    &candidate.to_string_lossy(),
                    "--home",
                    &app.to_string_lossy(),
                    "mods/sixfold-desk/main.js",
                    "mods/sixfold-desk/qa-dependency.js",
                ]))?;
                let st = p.status()?;
                let shot = p.shot(&format!("installed-{revision}"))?;
                receipt["installer"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"revision":revision,"result":result,"status":st,"shot":shot}));
                if truth(&st["errors"]) {
                    return err(st.to_string());
                }
            }
            fs::write(
                source_dir.join("main.js"),
                format!("import {{stillMissing}} from './qa-dependency.js';\n{source}"),
            )?;
            let rejected = execute_with(
                &strings(&[
                    &exe,
                    "update-install",
                    "--repo",
                    &candidate.to_string_lossy(),
                    "--home",
                    &app.to_string_lossy(),
                    "mods/sixfold-desk/main.js",
                ]),
                20.,
                false,
                |c| {
                    c.envs(&p.vars);
                },
            )?;
            if rejected.code == 0 || !rejected.stderr.contains("Native check failed") {
                return err("partial installer candidate was not rejected");
            }
            if !fs::read_to_string(&main)?.contains("QA INSTALL V2") {
                return err("rejected install modified live source");
            }
            receipt["installerRejectedPartial"] =
                json!({"returncode":rejected.code,"stderr":rejected.stderr,"status":p.status()?});
            println!(
                "{}",
                json!({"installer":"two swaps passed; partial candidate rejected"})
            );
        }
        Ok(())
    })();
    p.stop();
    let _ = p.run(&strings(&[&core.to_string_lossy(), "server", "stop"]));
    fs::write(
        base.join("receipt.json"),
        serde_json::to_string_pretty(&receipt)?,
    )?;
    result
}
