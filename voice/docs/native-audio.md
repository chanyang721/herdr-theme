# Native evaluation audio decoding

The original Parquet loader calls SoundFile on encoded bytes and checks for a 16 kHz sample rate. Its valid mono inputs include AIFF, AU, CAF and other libsndfile formats in addition to WAV and FLAC. The native loader uses libsndfile 1.2.2 virtual I/O and `sf_readf_float`, preserving that decoder and its float32 normalization. It does not narrow the input contract to the formats supported by a different decoder.

`voice/native-sndfile-assets.json` pins the SoundFile 0.13.1 carrier wheels and each native library/COPYING checksum for Windows x64, Linux x64 and both Mac architectures. The installer extracts only that native library and its native COPYING text into `~/.local/share/herdr-focus-queue/native/sndfile`, writes the source archive URL/hash and carrier provenance alongside them, and removes the staging archive. No Python bindings, interpreter, pip environment or virtual environment are installed. The corresponding libsndfile 1.2.2 source archive is pinned in the manifest. `HERDR_SNDFILE_LIBRARY` selects an explicit copy of the same verified native distribution for offline tests.

Decoder handles close on success and error. The memory callbacks preserve BytesIO seeking and EOF behavior. Before reading, each seekable handle is explicitly rewound to frame zero, matching the original top-level SoundFile read API's `_prepare_read` step. Omitting that seek changed 4,354 decoded MP3 sample bits by up to `5.960464477539063e-8` in the recorded Windows failure. The unchanged original API with an explicit rewind matched every bit. The wrapper source entry and SHA-256 are recorded in the native asset manifest; the wrapper itself is validation-only. The evaluation pipeline rejects non-16 kHz inputs and stereo input, whose two-dimensional arrays also fail the original embedding pipeline; stereo is never flattened into an apparently successful result.

```sh
node voice/tests/native-audio-differential.mjs \
  --binary rust/target/debug/herdr-theme \
  --work-dir .migration-oracle/voice-model-differential
node voice/tests/native-dataset-differential.mjs \
  --binary rust/target/debug/herdr-theme \
  --work-dir .migration-oracle/voice-model-differential
```

These external validation commands stage the same pinned native library separately from the disposable Python reference. The audio comparison encodes a small slice of the pinned public recording into every format that its in-memory encoder can write, then requires every decoded float32 bit to match the original. MP3 uses a deterministic longer repetition to provide complete MPEG frames. AIFF, AU, CAF, FLAC, MP3, OGG, WAV, WAVEX, W64, NIST, MAT4 and MAT5 are mandatory successful cases. Each format has its own isolated working directory: an SD2 encoder's resource-fork side effect must not change another format's detection. Encoder limitations and original rejected inputs are recorded explicitly. Wrong-rate, stereo and invalid containers must fail.

The Parquet comparison executes the untouched original `load` function on signed and unsigned 8/16/32/64-bit IDs and string IDs, including IDs above `i64::MAX`, first-seen speaker order, filtered short speakers, sorted file traversal and the forty-clip cap. Native numeric keys use `i128` internally so unsigned values retain Python's natural integer ordering. IDs in the comparison output are decimal strings to avoid JavaScript integer precision loss.

Reports remain under the work directory's `audio/` and `dataset/` folders. These checks neither load a speaker model nor open a microphone. A successful source build or the earlier WAV evaluation does not establish this broader decoder/ID coverage; native comparison reports are required on each supported platform.

The recorded Windows x64 reports are `voice/tests/fixtures/audio-native-windows-x64.json` and `dataset-native-windows-x64.json`. The tested executable has SHA-256 `87d3a959fc3d2d8aaf93ac5f0ea4821962dd20f764bc32202f3f356471b493d5`. With the native child process's PATH empty, all twenty-two readable formats, including MP3 after the explicit rewind, matched every float32 sample bit; six rejected inputs matched; all nine Parquet ID types matched exactly. Other platforms and live macOS acceptance remain separate gates.
