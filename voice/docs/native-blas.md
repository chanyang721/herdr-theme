# Native linear algebra for voice equivalence

Floating-point reduction order affects voice decisions at a threshold. A scalar Rust sum initially differed from the original NumPy BLAS result by a few ulps: normalized embeddings were within `2.8e-17`, yet four of twelve adjacent-threshold model decisions changed. The fix preserves the reference backend rather than rounding scores, adding an epsilon or changing expected labels.

`voice/native-blas-assets.json` pins the exact native libraries carried by the selected NumPy 2.3.0 wheels, together with carrier and per-file SHA-256 hashes. All four selected platform wheels use **OpenBLAS 0.3.29 ILP64**. The selected legacy-compatible Mac ARM64/x64 wheels were inspected and use OpenBLAS, rather than Accelerate. The platform-specific libraries and their native dependencies are retained with the wheel's bundled license text.

The native installer uses a wheel only as a hash-verified distribution archive. It extracts the listed shared libraries and `LICENSE.txt` with the macOS archive tool into `~/.local/share/herdr-focus-queue/native/blas`. The carrier archive is removed with its staging directory. No Python modules, interpreter, pip environment or virtual environment are installed or invoked.

`rust/src/voice/linalg.rs` verifies the native files and backend ABI before inference. Normalization and individual scores use `scipy_cblas_ddot64_`; matrix/vector scores use the reference GEMV path; a matrix multiplied by its own transpose uses SYRK and triangle copying, as NumPy does; other score matrices use GEMM. Non-BLAS contiguous sums retain NumPy's reduction order, and vector means sum before dividing. The relevant original algorithms and thresholds are retained.

Missing or mismatched native libraries fail explicitly and direct the user to `focusq voice-setup`. The product voice path never substitutes approximate scalar decisions. Scalar calculations are available only to pure reference tests and the input/output-only `voice_probe` diagnostic; they do not drive microphone routing, enrollment or live gate decisions.

The explicit offline model command accepts `--blas` in addition to model, audio and sherpa C-library paths. The differential runner stages the verified native-only BLAS files separately from its disposable Python oracle. Its exact decision corpus and threshold masks, together with explicit matrix/vector, self/cross similarity and voiceprint-build comparisons, check the reduction paths used by the product. The recorded Windows comparison matched all those numeric results exactly. See [offline-model-validation.md](offline-model-validation.md) for the tests and outstanding platform evidence.

On Windows, the sherpa and BLAS libraries load their dependencies relative to their own verified library directories. This avoids selecting an unrelated same-named ONNX Runtime from the system directory. The process-wide DLL policy and system files are not changed.
