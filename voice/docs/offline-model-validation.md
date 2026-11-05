# Offline native voice model equivalence

`voice_model_probe` accepts explicit model, VAD model, WAV and C-library paths. It reads mono 16 kHz PCM16 audio and returns the whole-file normalized embedding, each VAD segment's exact start/sample count/waveform and normalized embedding, and C-ABI structure sizes/offsets. It opens no microphone, asks no app for focus, installs no plugin and reads no personal voice state.

```sh
herdr-theme voice_model_probe --model speaker.onnx --vad silero.onnx \
  --audio speech.wav --library /explicit/path/libsherpa-onnx-c-api.dylib \
  --blas /explicit/path/libscipy_openblas64_.dylib \
  --threshold 0.35 --gain 10
```

The portable differential runner downloads and validates the fixed public baseline source at `8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8`, or accepts `--oracle-dir` containing that exact original `voicegate.py`. It executes the original `extractor`, `vad` and `embed` function bodies selected from the untouched AST. The reference lives only in a disposable validation directory. An ephemeral Python 3.12 environment installs checksum-pinned sherpa-onnx 2.0.1, its 2.0.1 native core and NumPy 2.3.0 wheels. No Python source file or interpreter is added to the product runtime, and the installer excludes this external validation runner and its assets.

`voice/tests/model-probe-assets.json` pins source/header/model/audio/archive hashes and exact wheel URLs/hashes for macOS ARM64, macOS x64, Linux x64 and Windows x64. The speech fixture comes from a fixed `csukuangfj/sr-data` commit; the audio itself is not committed. The source/header hash checks and a direct C-API probe verify the FFI layout/symbols separately from Rust compilation. Each full validation case then compares the Rust executable to the original Python implementation under the same model files and backend version.

```sh
# Requires Node 22+ and Python 3.12; this command does not build Rust.
node voice/tests/native-model-differential.mjs \
  --binary rust/target/debug/herdr-theme --python python3 \
  --work-dir .migration-oracle/voice-model-differential
```

On Windows, pass the `.exe` binary and either `--python` with a Python 3.12 executable or omit it to use `py -3.12`. Explicit `--model`, `--vad`, `--audio` and `--library` inputs are supported; the report records their actual SHA-256 hashes. Downloads and wheels are verified before use; cached files with different hashes and partially created native/oracle environments are rejected. Use a new validation directory to recover from an interrupted preparation.

Two configurations are tested: the shipped sensitivity/gain (`0.35`, `10`) and the historical comparison setting (`0.5`, `1`). Segment count, start indices, sample counts and every waveform sample's float32 bits must match exactly. Embeddings must have maximum absolute difference at most `1e-12`, cosine at least `1-1e-12` and unit norm within `1e-12`. Each configuration also checks twelve exact original `judge` decisions: audio just below/at/above one second and the complete clip, with thresholds equal to the original measured score and its adjacent float64 values. A matrix corpus built from the real embeddings checks matrix/vector scores, self and cross similarity, means and the original three-step voiceprint build. Matrix results must differ by at most `1e-12`; every threshold mask must match exactly. The comparator rejects any changed decision or mask even when its numeric difference fits the tolerance. These limits are declared by the comparator; tests reject embedding drift, shifted segments, wrong ABI offsets and wrong versions.

The work directory retains complete baseline/C-API/Rust JSON outputs plus `model-differential-summary.json`. A full run exits nonzero for any setup/comparison error and reports `status: pass` only after Rust comparison. `--oracle-only` is a diagnostic that deliberately reports `reference-only-incomplete` and cannot establish Rust parity.

## CI wiring

After the existing single-job Rust build, use Node 22 and Python 3.12 to run:

```sh
node --test voice/tests/native-model-differential.test.mjs
node voice/tests/native-model-differential.mjs --binary "$HERDR_THEME_BIN" \
  --python python --work-dir .migration-oracle/voice-model-differential
```

Set `HERDR_THEME_BIN` to the executable from that job, including `.exe` on Windows. Run on both Mac architectures as well as the existing Windows/Linux jobs; record the reported architecture instead of assuming it from a moving runner label. Upload the validation directory's JSON reports on success and failure. The isolated oracle environment and downloaded model/library files are test inputs, and must not be included in release/runtime artifacts. `voice/tests/native-install.test.mjs` remains a separate isolated macOS installer test; it starts no LaunchAgent.

## Recorded evidence and remaining gates

`voice/tests/fixtures/model-c-api-windows-x64.json` records a Windows x64 diagnostic: both configurations produced two speech segments; the direct C API matched the original Python embeddings exactly (maximum absolute difference zero, cosine one), with exact segment starts/counts, waveform bits and all twenty-four boundary decisions. This validates the pinned C API's mapping and ownership operations independently of a Rust compiler/linker issue. Its status is explicitly `reference-only-incomplete`: the Rust executable was not run in that diagnostic.

Required Rust executable comparisons and CI results on each requested platform remain acceptance gates until their reports are collected. Offline model parity also does not establish actual CoreAudio/default-device switching, microphone permission, physical-key timing, app focus races or live dictation acceptance. Those require separate macOS observations and must not be inferred from this probe. No live installation, service restart or microphone access is performed by these checks.

`voice/tests/fixtures/model-native-windows-x64.json` records the full Windows x64 Rust comparison after matching the native reduction backend. Both configurations passed with zero difference for all whole-file and segment embeddings, exact VAD indices/counts/waveform bits, and all twenty-four exact judge decisions. Matrix/vector scores, self and cross similarities, means and the original voiceprint build centre also matched with zero difference; all threshold masks matched exactly. The report pins the tested executable and every input by SHA-256. This closes that recorded Windows offline model check; other platform CI and the separate OS observations remain acceptance work.

The final recorded executable has SHA-256 `87d3a959fc3d2d8aaf93ac5f0ea4821962dd20f764bc32202f3f356471b493d5`. Every native comparison child ran with PATH empty and explicit native-library paths. Python ran only in the separate external oracle environment. `voice/tests/fixtures/voice-native-windows-x64.json` collects the matching model, full evaluation, audio-format and Parquet-type report hashes, with the remaining platform/live acceptance gates.
