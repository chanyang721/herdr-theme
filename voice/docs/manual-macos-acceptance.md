# Manual macOS voice acceptance

Status: **UNVERIFIED until an operator completes this checklist on a physical Mac.** An ignored test, successful CI build, offline audio replay, or simulated device cannot establish microphone, CoreGraphics, foreground-app, or live dictation acceptance. This checklist does not waive any outstanding platform requirement.

## Identify the exact candidate

Use a disposable macOS account with no production Herdr/Claude/Codex sessions. Record the public reviewed commit as `REVIEWED_SHA` (40 hexadecimal characters), review/CI URLs, artifact download URL, archive SHA-256, executable SHA-256, signing/quarantine facts, `sw_vers`, `uname -m`, executable architecture, Rosetta use, audio-device model/connection, and CLI/app versions. Record each tested architecture separately; one Mac does not prove another architecture.

Use the artifact from the push run for the reviewed commit. GitHub's surrounding artifact ZIP contains `native.tar.gz` and `native.tar.gz.sha256`; verify the latter and extract the tar to preserve executable permissions. In the disposable account's terminal, substitute the reviewed values and downloaded artifact paths:

```sh
REVIEWED_SHA='<reviewed 40-character commit>'
ARTIFACT_DIR='/absolute/path/to/extracted/native-artifact'
ARTIFACT_ARCHIVE='/absolute/path/to/downloaded/native.tar.gz'
BIN="$ARTIFACT_DIR/herdr-theme"
shasum -a 256 "$ARTIFACT_ARCHIVE" "$BIN"
file "$BIN"
sw_vers
uname -m
"$BIN" --help
```

Compare the archive/executable digests with the receipt for that exact reviewed commit before continuing. An artifact from another commit is not acceptance evidence. If building locally instead, use a clean checkout of `REVIEWED_SHA`, record `git rev-parse HEAD`, `git status --porcelain`, toolchain versions and the complete build result, then run `CARGO_BUILD_JOBS=1 cargo build --manifest-path rust/Cargo.toml --release`. Hash its resulting executable and retain that build's runtime-library/model digest manifest. Dirty or untraceable source is a blocked candidate.

The artifact's `artifact-receipt.json` records `source_commit`, `source_tree`, platform, architecture and every packaged file hash. Confirm `source_commit` equals `REVIEWED_SHA`; a pull-request merge-preview artifact can name a different commit and must not silently substitute for the reviewed candidate. Retain the successful four-platform CI URLs separately from the physical-device receipt.

## Isolate state and prepare native assets

Do not run an installer, `focusq setup/install/enable/uninstall`, `voice_install`, `voice-setup`, a LaunchAgent command, or a production app restart for these checks. Start only disposable test sessions using their normal supported launch procedure. Do not change another account's voice settings or stop another account's processes.

The gate's model directory is derived from the account home, not `HERDR_PLUGIN_STATE_DIR`. Therefore a temporary state directory alone is insufficient: use the disposable account for these commands. Keep its actual home unchanged. Record the account's initial default input/output, app focus, voice permissions, selected panes, mute/recording state and existing test processes before starting.

```sh
RUN_DIR="$(mktemp -d -t herdr-voice-acceptance)"
TEST_HOME="$HOME" # actual home of the disposable account; do not redefine HOME
VOICE_ASSETS="$TEST_HOME/.local/share/herdr-focus-queue"
mkdir -p "$RUN_DIR/app/data/sixfold" "$RUN_DIR/state" "$RUN_DIR/evidence"
export HERDR_APP_HOME="$RUN_DIR/app"
export HERDR_PLUGIN_STATE_DIR="$RUN_DIR/state"
export HERDR_VOICE_SETTINGS="$RUN_DIR/app/data/sixfold/voice.local.json"
printf '%s\n' '{"auto_send_devices":[],"devices":{}}' > "$HERDR_VOICE_SETTINGS"
```

Provision the **already verified native artifact's** models and runtime assets locally in this disposable account, retaining their supplied relative layout under `VOICE_ASSETS`. Do not copy a production voiceprint or run a setup command as a shortcut. Required gate models are `models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` and `models/silero_vad.onnx`. Sherpa's C API must match the pinned version in the reviewed source. Record the architecture and digests of its dependent libraries, PortAudio, the exact pinned BLAS assets in `voice/native-blas-assets.json`, and any decoder assets required by the reviewed artifact. This is asset preparation, not plugin installation.

For nondefault library locations, these existing native overrides take absolute filenames:

```sh
export HERDR_SHERPA_LIBRARY="$VOICE_ASSETS/native/lib/libsherpa-onnx-c-api.dylib"
export HERDR_PORTAUDIO_LIBRARY='/absolute/path/to/verified/libportaudio.dylib'
export HERDR_BLAS_LIBRARY='/absolute/path/to/verified/pinned-blas-library.dylib'
"$BIN" voicegate default-input > "$RUN_DIR/evidence/default-input.txt"
```

Verify that `default-input.txt` names the input actually selected in macOS Sound settings. Missing/incompatible native assets or an unavailable input are **BLOCKED/FAIL**, not an invitation to use an arbitrary installed BLAS or bypass the check. Grant microphone/accessibility/input-monitoring permissions only to the disposable test application/account when required, and record the actual prompts and grants.

## Physical microphone and device changes

Run each case using both a headset and the built-in input where available. Use public test phrases, with a second consenting speaker for the negative case. Retain private voiceprints locally; publish only sanitized event/timing summaries.

1. Run `"$BIN" voicegate enroll 45` in the foreground, speak for at least the enrollment minimum, then run `"$BIN" voicegate tail`. Record device identity, enrollment outcome, segment durations, scores, judgments and processing latency. Confirm speech is detected from the selected physical device and the enrolled/other-speaker outcomes match the original policy under equivalent conditions. A successful command without audible physical input is insufficient. Stop `tail` with Control-C in its own terminal.
2. Start `"$BIN" voicegate serve > "$RUN_DIR/evidence/gate.stdout" 2> "$RUN_DIR/evidence/gate.stderr" &` and immediately record `GATE_PID=$!`. Retain this exact child PID and command line. Speak a marked phrase, switch the macOS default input, then speak another. Read `"$BIN" voicegate default-input` after the switch. Observe fresh `voice-segments.jsonl` records and the correct per-device profile/settings. The serve loop polls a changed input after 60 seconds relative to its last device check or speech marker; five seconds of all-zero blocks also reopens the stream. Record observed detection time rather than assuming an instantaneous switch.
3. Unplug the active USB/Bluetooth headset while speaking; also repeat while silent. Observe whether the reader exits/reopens, whether segment timestamps resume on the available default input, whether stale input is reused and whether duplicate gate processes appear. Reconnect and reselect it, then repeat. Record the physical disconnect/reconnect times, last old-device segment, first new-device segment and any errors. Native microphone availability polling has a timeout, but that alone does not prove a physical driver's blocking read or recovery behavior. An unrecovered stall, crash, wrong-device input, unbounded retry, or duplicate process fails this case.
4. Stop only this run's recorded child with `kill -TERM "$GATE_PID"` and `wait "$GATE_PID"`; inspect its exit result and state. Do not use process-name-wide termination. Before a later serve run, investigate any leftover pid/lock artifact against that exact stopped child; do not remove a lock belonging to a running process. Re-run the selected microphone case and confirm capture works again.

## Real F8, keyboard timing and focus races

These cases require disposable Claude/Codex sessions and a disposable Herdr/app/core endpoint. Before starting, prove that the `herdr`, `herdr-app`, `herdr-core`/`hc` binaries visible in `PATH` address only those test sessions. `HERDR_BIN_PATH` and `SIXFOLD_REAL_HC` can select the existing native endpoints; they do not by themselves isolate the service. `HERDR_APP_HOME` redirects settings, not every transport. If endpoint isolation cannot be demonstrated, mark these cases **BLOCKED** and stop; do not test against production panes.

In the disposable Claude configuration, use the existing documented F8 `voice:pushToTalk` binding and tap voice mode. Start fresh test CLI sessions so they read that configuration, without restarting production sessions. Run `"$BIN" focus_queue --app-focus` for a fresh disposable app-focus observation, or `"$BIN" focus_queue --listen "$TEST_PANE_ID"` for an already verified disposable pane identity. The listener may start its normal gate/listener children; record all run-owned child PIDs. Plugin installation is not needed for direct invocation. Supply events only from the disposable endpoint and do not synthesize a production pane identity.

Capture a screen recording with visible timestamps/keypresses plus the run's `focus-queue.log`, relevant state and sanitized pane-input receipts. CoreGraphics measures recent **real HID keydown** activity (`CGEventSourceSecondsSinceLastEventType`, state 1/event 10); F8/Escape/Enter are sent through the existing pane transport and do not replace physical keystrokes for this measurement. Offline JSON probes do not exercise either path. For the Codex row, `"$BIN" codex_focus --serve` starts the existing foreground guard; record its child identity and stop only that test guard at cleanup.

| Case | Manual action | Required observation |
| --- | --- | --- |
| F8 activation | Focus an eligible empty Claude test pane; wait for stable focus; then leave and return. | One effective start/stop transition with the expected REC state, no key sent to another pane, no repeated toggle storm. Record send/ack/visible REC times and any ignored-key cooldown. |
| Recent typing | Type a marked draft, pause at both sides of the documented recent-key window, and then dictate a distinct continuation. Repeat using actual physical keys. | A typed draft is preserved and is not sent solely by automatic voice logic; dictated continuation follows the existing ownership/edit policy. CoreGraphics timestamps correlate with the real keystrokes. |
| Rapid focus | Alternate two disposable panes and a different foreground app, including visits shorter than 0.15 seconds and rapid switches while speech is active. Repeat at least ten times and record every transition. | Short incidental visits do not arm recording; recording/keys follow the correct pane and foreground state. No old-pane keystroke after identity changes; no lost user draft or cross-pane text. |
| In-flight owner dictation | Speak a unique complete phrase, switch panes immediately before/after the phrase ends and before the speaker judgment arrives. | The pending phrase is handled by the original owner/pending-judgment policy; text spoken after the switch is not appended or submitted as the previous pane's phrase. Record send/cancel/restore and acknowledgment, not merely requested keys. |
| Other/unknown speaker | Repeat with another consenting speaker, an utterance shorter than one second, and no enrollment for the selected device. | No unauthorized automatic submission. Cancel/keep/restore behavior and the bounded pending wait match the baseline. Explicit manual Enter remains distinguishable from automatic submission. |
| Interrupted connection | Disconnect input during in-flight dictation, reconnect, and move focus while the gate is recovering. | No stale judgment authorizes a new phrase; no unexpected submit or lost typed draft. Record recovery of the actual live footer/REC state, not just issuance of a command. |
| Codex focus | Start `/voice` manually in a disposable Codex session; move focus between two sessions and manually mute one. | F9 routing follows the existing break-before-make behavior; manual mute is preserved. No unsolicited `/voice` or Escape is issued to start/stop the connection. |

Use only test phrases which are harmless if submitted. Record the exact observed phrase destination, submission count, draft bytes, final focus and mute/REC state for every repetition. Any wrong-pane input, duplicate/unauthorized submit, missing restoration or unexplained timing difference is a failure, even if the process exits zero.

## Compare the untouched baseline

Where available, use a separately preserved checkout of baseline `8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8` and its original external Python/model environment, never a Python bridge inside the candidate. Hash the original sources and dependency lock/artifacts. Run the original `voicegate.py` commands and `focus_queue.py` entrypoints sequentially in a second disposable account/state with equivalent device, app/CLI versions, F8 configuration and public phrases. Never run both actors on the same panes or microphone simultaneously.

Compare action order, input ownership, screen/footer outcomes, error/recovery behavior and latency distributions. Physical recordings are not bit-identical; retain measured timing and the predeclared acceptance bounds, and explain any nondeterministic difference. For repeatable audio/model comparisons use the repository's frozen/offline model comparison separately; it does not replace the physical cases above. If the original environment cannot run, record that comparison as **UNVERIFIED** with the reason; do not invent baseline observations or broaden tolerances after a failure.

## Evidence, verdict and restoration

For each case retain: reviewed/source SHA, artifact and runtime/model digests, architecture/macOS, test CLI/app versions, device before/after, repetition number, start/end clock, run-owned process identity, exact manual actions, expected baseline behavior, observed input/submission/focus, evidence filenames and **PASS/FAIL/BLOCKED/UNVERIFIED**. Default every unexecuted case to UNVERIFIED. Publish a sanitized manifest and hashes; keep raw audio, voiceprints, account paths and transcripts private. A CI run may link this evidence but cannot assert that the physical device was exercised.

At the end stop and reap only recorded test-owned gate/listener/CLI children, inspect final recording/mute state, close disposable app sessions, and restore the original macOS default input/output and foreground selection. Restore any permissions/configuration changed in the disposable account according to the recorded before-state. Retain evidence before deleting scratch files; never remove another process's state or a production registration. Record restoration and any remaining process or changed state explicitly. Overall acceptance remains incomplete if any required case or architecture is unverified, blocked, failed, or lacks exact-artifact provenance.
