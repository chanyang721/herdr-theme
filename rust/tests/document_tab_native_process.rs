//! Generated tab props pass through the actual JS dispatcher to the native CLI.
use herdr_theme::documents::{common::*, install};
use serde_json::{json, Value};
use std::{fs, process::Command};
#[test]
fn newly_created_document_tab_commands_execute_the_real_native_program() {
    let temp = tempfile::tempdir().unwrap();
    let app = temp.path().join("app");
    let binary = app.join("scripts/sixfold").join(install::native_name());
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::hard_link(env!("CARGO_BIN_EXE_herdr-theme"), &binary)
        .or_else(|_| fs::copy(env!("CARGO_BIN_EXE_herdr-theme"), &binary).map(|_| ()))
        .unwrap();
    let (document, added) = install::ensure_document_tabs(
        &json!({"spaces":[{"id":"test-space","name":"Test","tabs":[]}]}),
        &app,
    );
    assert_eq!(added.len(), 1);
    let props = &document["spaces"][0]["tabs"][0]["root"]["content"]["props"];
    assert!(props.get("resolverScript").is_none());
    assert!(props.get("installerScript").is_none());
    let config = app.join("data/sixfold/project-docs-pins.json");
    atomic_json(
        &config,
        &json!({"version":1,"spaces":{"test-space":{"name":"Test","folders":[],"pins":[]}}}),
    )
    .unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("mods/project-docs-tabs/main.js");
    let script = r#"import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const [source,app,pins,propsJSON]=process.argv.slice(1),p=JSON.parse(propsJSON);
const text=fs.readFileSync(source,'utf8');
const start=text.indexOf('const windows ='),end=text.indexOf('const readable =');
if(start<0||end<start)throw Error('actual helper section missing');
const exec=(program,args)=>{const out=spawnSync(program,args,{encoding:'utf8',windowsHide:true,env:{...process.env,HERDR_APP_HOME:app}});if(out.error)throw out.error;return {program,args,code:out.status,stdout:out.stdout,stderr:out.stderr};};
const helpers=new Function('appHome','exec','hostWindow',text.slice(start,end)+';return {helper,invoke};')(()=>app,exec,()=>({platform:process.platform==='win32'?'windows':process.platform==='darwin'?'macos':'linux'}));
const resolver=helpers.invoke(helpers.helper(p,'resolver','resolve_doc_pins'),['--config',pins,'--space','test-space']);
const installer=helpers.invoke(helpers.helper(p,'installer','install_doc_tabs'),['--help']);
console.log(JSON.stringify({resolver,installer}));
"#;
    let out = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(source)
        .arg(&app)
        .arg(&config)
        .arg(props.to_string())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    for (name, stem) in [
        ("resolver", "resolve_doc_pins"),
        ("installer", "install_doc_tabs"),
    ] {
        assert_eq!(receipt[name]["program"], json!(binary));
        assert_eq!(receipt[name]["args"][0], stem);
        assert_eq!(receipt[name]["code"], 0, "{}", receipt[name]);
        assert_eq!(receipt[name]["stderr"], "");
    }
    let result: Value =
        serde_json::from_str(receipt["resolver"]["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(result["spaceId"], "test-space");
    assert!(result["documents"].is_array());
    assert!(receipt["installer"]["stdout"]
        .as_str()
        .unwrap()
        .contains("usage: herdr-theme install_doc_tabs"));
}
