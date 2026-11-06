//! Remaining assertions from the unchanged original voice unittest methods.
//! Inject only the subprocess/device metadata boundaries patched by those tests.
use herdr_theme::voice::{gate, policy, queue, recovery, settings, Result};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};
fn put(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}
struct Window {
    bundle: &'static str,
    status: Value,
    all: Value,
}
impl Window {
    fn new() -> Self {
        Self {
            bundle: "bundleid=dev.herdr.app",
            status: json!({"focused_pane":"p4","agent":"t4"}),
            all: json!({"terminals":[{"address":"t4","agent":"codex","status":"idle"},{"address":"t9","agent":"claude-code","status":"idle"}]}),
        }
    }
    fn ask(&mut self) -> Option<Value> {
        queue::asked_focus_with(self).unwrap()
    }
}
impl queue::WindowBackend for Window {
    fn clock(&self) -> f64 {
        100.
    }
    fn front(&mut self, _: bool) -> Result<bool> {
        Ok(queue::bundle_is_app(self.bundle))
    }
    fn app(&mut self, args: &[&str], _: bool) -> Result<Value> {
        match args {
            ["status"] => Ok(self.status.clone()),
            ["ls"] => Ok(
                json!({"spaces":[{"tabs":[{"terminals":[{"terminal":"t4","pane":"p4"},{"terminal":"t9","pane":"p9"}]},{"terminals":[]}]}]}),
            ),
            _ => panic!("unexpected app query {args:?}"),
        }
    }
    fn core(&mut self, args: &[&str], _: bool) -> Result<Value> {
        match args {
            ["ls", "--json"] => Ok(self.all.clone()),
            ["ls", "--json", "--label", "sixfold.source-session=default"] => {
                Ok(json!({"terminals":[{"address":"t4"}]}))
            }
            ["get", id] => Ok(
                json!({"labels":if *id=="t4"{json!({"sixfold.source-pane":"w8:p11"})}else{json!({})}}),
            ),
            _ => panic!("unexpected core query {args:?}"),
        }
    }
    fn tui(&mut self) -> Result<Value> {
        Ok(json!({"result":{"panes":[{"pane_id":"p","agent":"codex"}]}}))
    }
}
mod stale_heartbeat_tests {
    use super::*;
    fn current(focused: bool) -> BTreeMap<String, Value> {
        BTreeMap::from([("w8:p11".into(), json!({"agent":"codex","focused":focused}))])
    }
    #[test]
    fn test_stale_heartbeat_asks_the_window_instead_of_trusting_tui_focus() {
        let mut b = Window::new();
        b.status = json!({"focused_pane":"p9","agent":"t4"});
        let result = queue::project(current(true), b.ask().as_ref());
        assert_eq!(result["w8:p11"]["focused"], false);
        assert_eq!(result["app:t9"]["focused"], true);
        assert!(!result.contains_key("app:t4"));
    }
    #[test]
    fn test_stale_heartbeat_follows_a_bridged_focus_to_its_tui_pane() {
        let result = queue::project(current(false), Window::new().ask().as_ref());
        assert_eq!(result["w8:p11"]["focused"], true);
    }
    #[test]
    fn test_unknown_window_focus_leaves_no_tui_microphone_live() {
        let mut b = Window::new();
        b.status = json!({"focused_pane":null,"agent":null});
        let result = queue::project(current(true), b.ask().as_ref());
        assert!(!result.values().any(|p| p["focused"] == true));
    }
    #[test]
    fn test_docs_tab_focus_does_not_fall_back_to_the_last_agent() {
        let mut b = Window::new();
        b.status = json!({"focused_pane":"sf-docs-pane-1","agent":"t4"});
        let result = queue::project(current(false), b.ask().as_ref());
        assert!(!result.values().any(|p| p["focused"] == true));
    }
    #[test]
    fn test_app_in_background_keeps_tui_focus() {
        let mut b = Window::new();
        b.bundle = "bundleid=other.app";
        assert!(b.ask().is_none());
    }
}
mod mapping_tests {
    use super::*;
    #[test]
    fn test_window_focus_is_mapped_to_source_pane_without_sidebar() {
        assert_eq!(
            queue::selected_with(&mut Window::new()),
            Some("w8:p11".into())
        );
    }
    #[test]
    fn test_unknown_front_app_is_never_permission_to_listen() {
        let mut b = Window::new();
        b.bundle = "unknown";
        assert_eq!(queue::selected_with(&mut b), None);
    }
    #[test]
    fn test_iterm_front_does_not_identify_which_window_is_focused() {
        let mut b = Window::new();
        b.bundle = "bundleid=\"com.googlecode.iterm2\"";
        assert_eq!(queue::selected_with(&mut b), None);
    }
    #[test]
    fn test_bridge_is_not_a_second_microphone() {
        let mut b = Window::new();
        b.all = json!({"terminals":[{"address":"t4","agent":"codex"},{"address":"t8","agent":"codex"}]});
        let actual = queue::targets_with(&mut b)
            .unwrap()
            .into_keys()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            actual,
            ["p".to_owned(), "app:t8".to_owned()].into_iter().collect()
        );
    }
}
mod device_tests {
    use super::*;
    #[test]
    fn test_only_a_headset_records_and_sends() {
        let cfg = json!({"auto_send_devices":["example headset"]});
        assert!(policy::headset("Example Headset Pro", &cfg));
        assert!(!policy::headset("Built-in Microphone", &cfg));
        assert!(!policy::headset("", &cfg));
    }
    #[test]
    fn test_the_default_input_is_read_without_opening_it() {
        let _: String = policy::default_input_with(|| None);
    }
}
mod settings_tests {
    use super::*;
    #[test]
    fn test_no_file_means_general_defaults_and_no_auto_send_microphone() {
        let d = tempfile::tempdir().unwrap();
        let cfg = settings::load_at(&d.path().join("voice.local.json"));
        assert_eq!(cfg["auto_send_devices"], json!([]));
        assert_eq!(cfg["vad_gain"], settings::defaults()["vad_gain"]);
        assert!(!policy::headset("Any Headset", &cfg));
    }
    #[test]
    fn test_the_persons_file_overrides_defaults() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("voice.local.json");
        put(
            &path,
            &json!({"auto_send_devices":["My Headset"],"vad_gain":4,"devices":{"my-headset":{"threshold":0.45}}}),
        );
        let cfg = settings::load_at(&path);
        assert!(policy::headset("my headset (bluetooth)", &cfg));
        assert!(!policy::headset("Built-in Microphone", &cfg));
        assert_eq!(cfg["vad_gain"], 4.0);
        assert_eq!(settings::threshold_in(&cfg, "my-headset"), Some(0.45));
        assert_eq!(settings::threshold_in(&cfg, "other"), None);
    }
    #[test]
    fn test_a_broken_file_falls_back_to_defaults() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("voice.local.json");
        fs::write(&path, "{not json").unwrap();
        assert_eq!(settings::load_at(&path)["auto_send_devices"], json!([]));
    }
    #[test]
    fn test_update_keeps_other_keys_and_writes_atomically() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("voice.local.json");
        put(&path, &json!({"auto_send_devices":["A"]}));
        settings::update_at(&path, |data| {
            data["devices"] = json!({"a":{"vad_gain":2.0}});
        })
        .unwrap();
        assert_eq!(
            settings::read_file(&path),
            json!({"auto_send_devices":["A"],"devices":{"a":{"vad_gain":2.0}}})
        );
        assert_eq!(
            fs::read_dir(d.path())
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>(),
            vec![std::ffi::OsString::from("voice.local.json")]
        );
    }
    #[test]
    fn test_default_path_is_beside_the_app_data() {
        assert_eq!(
            settings::path_for(None, Path::new("/tmp/app-home")),
            Path::new("/tmp/app-home/data/sixfold/voice.local.json")
        );
    }
}
mod calibration_tests {
    use super::*;
    #[test]
    fn test_a_headset_is_allowed_to_send_and_gets_a_gain_for_its_level() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("voice.local.json");
        let (_, gain, headset) =
            gate::calibrate_at("Example Headset", &[-40., -39., -38.], false, &path).unwrap();
        assert!(headset);
        assert_eq!(gain, 10.0);
        let data = settings::read_file(&path);
        assert_eq!(data["auto_send_devices"], json!(["Example Headset"]));
        assert_eq!(data["devices"]["example-headset"]["speech_db"], -39.0);
        gate::calibrate_at("Example Headset", &[-39.], false, &path).unwrap();
        assert_eq!(
            settings::read_file(&path)["auto_send_devices"],
            json!(["Example Headset"])
        );
    }
    #[test]
    fn test_a_builtin_microphone_is_calibrated_but_not_allowed_to_send() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("voice.local.json");
        let (_, gain, headset) =
            gate::calibrate_at("Example Headset", &[-80.], true, &path).unwrap();
        assert!(!headset);
        assert_eq!(gain, 30.);
        assert!(!settings::read_file(&path)["auto_send_devices"]
            .as_array()
            .unwrap()
            .contains(&json!("Example Headset")));
    }
    #[test]
    fn test_a_threshold_set_for_the_microphone_wins_over_the_voiceprint() {
        let d = tempfile::tempdir().unwrap();
        let print = d.path().join("voiceprint-example-headset.json");
        put(&print, &json!({"vector":[1.,0.],"threshold":0.4}));
        let files = gate::Files {
            dir: d.path().to_owned(),
            print,
            pool: d.path().join("pool.jsonl"),
            device: "example-headset".into(),
            gain: 10.,
        };
        assert_eq!(
            files.load_with_settings(&settings::defaults()).unwrap().1,
            0.4
        );
        let path = d.path().join("voice.local.json");
        put(
            &path,
            &json!({"devices":{"example-headset":{"threshold":0.45}}}),
        );
        assert_eq!(
            files
                .load_with_settings(&settings::load_at(&path))
                .unwrap()
                .1,
            0.45
        );
    }
}
const ERROR:&str="Voice conversation failed: voice audio session stopped unexpectedly\n\n› Ask Codex to do anything\n\nGPT-6.1-Sol medium\n? for shortcuts";
fn record() -> Value {
    json!({"seen":true,"failure":{"id":30,"ts":100,"pid":"123"},"absent_since":100})
}
mod recovery_policy_tests {
    use super::*;
    #[test]
    fn test_healthy_muted_and_listening_calls_are_never_toggled() {
        for state in ["voice ● listening", "voice ◌ muted"] {
            let text = ERROR.replace("\n\n›", &format!("\n{state}  f9 mute  /voice stop\n\n›"));
            assert!(!recovery::eligible(&record(), &text, true, 110., false));
        }
    }
    #[test]
    fn test_missing_footer_without_failure_evidence_is_not_a_disconnect() {
        let mut r = record();
        r.as_object_mut().unwrap().remove("failure");
        assert!(!recovery::eligible(&r, ERROR, true, 110., false));
        assert!(!recovery::eligible(
            &record(),
            &ERROR.replace(
                "Voice conversation failed: voice audio session stopped unexpectedly",
                ""
            ),
            true,
            110.,
            false
        ));
    }
    #[test]
    fn test_restart_and_rate_limits_prevent_repeated_voice_toggles() {
        for (field, value) in [
            ("seen", json!(false)),
            ("attempted", json!(30)),
            ("absent_since", json!(109)),
            ("attempts", json!([90])),
        ] {
            let mut r = record();
            r[field] = value;
            assert!(!recovery::eligible(&r, ERROR, true, 110., false));
        }
        let mut r = record();
        r["attempts"] = json!([20, 30, 40]);
        assert!(!recovery::eligible(&r, ERROR, true, 110., false));
    }
}
fn devices() -> Value {
    json!({"SPAudioDataType":[{"_items":[{"_name":"Mic","coreaudio_default_audio_input_device":"spaudio_yes","coreaudio_device_input":1,"coreaudio_device_srate":48000},{"_name":"Speakers","coreaudio_default_audio_output_device":"spaudio_yes","coreaudio_device_output":2,"coreaudio_device_srate":48000}]}]})
}
mod device_recovery_tests {
    use super::*;
    #[test]
    fn test_audio_table_comments_preserve_the_configured_device() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("config.toml");
        fs::write(
            &path,
            "[audio] # selected devices\nmicrophone = \"Absent headset\"\nspeaker = 'Speakers'\n",
        )
        .unwrap();
        let selection = recovery::audio_selection(&fs::read_to_string(&path).unwrap());
        assert_eq!(
            selection,
            Some(json!({"microphone":"Absent headset","speaker":"Speakers"}))
        );
        assert!(recovery::device_signature(&devices(), selection.as_ref()).is_none());
        fs::write(&path, "audio = { microphone = \"Absent headset\" }\n").unwrap();
        assert!(recovery::audio_selection(&fs::read_to_string(path).unwrap()).is_none());
    }
    #[test]
    fn test_device_failure_requires_a_ready_stable_device_gate() {
        let mut r = record();
        r["failure"]["kind"] = json!("device");
        assert!(!recovery::eligible(&r, ERROR, true, 110., false));
        assert!(recovery::eligible(&r, ERROR, true, 110., true));
        assert!(!recovery::eligible(&r, ERROR, false, 110., true));
    }
    #[test]
    fn test_default_devices_need_nonzero_channels_and_supported_rates() {
        assert_eq!(
            recovery::device_signature(&devices(), Some(&json!({}))),
            Some(json!([["Mic", 1, 48000.0], ["Speakers", 2, 48000.0]]))
        );
        for (field, value) in [("coreaudio_device_input", 0), ("coreaudio_device_srate", 0)] {
            let mut invalid = devices();
            invalid["SPAudioDataType"][0]["_items"][0][field] = json!(value);
            assert!(recovery::device_signature(&invalid, Some(&json!({}))).is_none());
        }
        assert!(
            recovery::device_signature(&json!({"SPAudioDataType":[]}), Some(&json!({}))).is_none()
        );
    }
    #[test]
    fn test_device_change_or_removal_resets_the_stability_window() {
        let mut state = json!({});
        let signature = json!([["Mic", 1, 48000], ["Speakers", 2, 48000]]);
        assert!(!recovery::stable_devices(
            &mut state,
            Some(signature.clone()),
            100.
        ));
        assert!(!recovery::stable_devices(
            &mut state,
            Some(signature.clone()),
            102.
        ));
        assert!(recovery::stable_devices(
            &mut state,
            Some(signature.clone()),
            103.
        ));
        assert!(!recovery::stable_devices(&mut state, None, 104.));
        assert!(!recovery::stable_devices(&mut state, Some(signature), 105.));
        assert!(!recovery::stable_devices(
            &mut state,
            Some(json!([["Mic", 1, 16000], ["Speakers", 2, 48000]])),
            109.
        ));
    }
    #[test]
    fn test_hidden_error_caption_needs_independent_closed_actor_evidence() {
        let mut r = record();
        r["failure"]["kind"] = json!("device");
        r["failure"]["confirmed"] = json!(true);
        let plain = ERROR.replace(
            "Voice conversation failed: voice audio session stopped unexpectedly",
            "",
        );
        assert!(recovery::eligible(&r, &plain, true, 110., true));
        r["failure"].as_object_mut().unwrap().remove("confirmed");
        assert!(!recovery::eligible(&r, &plain, true, 110., true));
    }
}
