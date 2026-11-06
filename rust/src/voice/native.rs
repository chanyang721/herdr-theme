//! Thin owned bindings to the published sherpa-onnx v2.0.1 C API and
//! PortAudio v19. The model files and detector settings match the Python gate.
//! Header: https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.1/sherpa-onnx/c-api/c-api.h
use super::{now, settings, Result};
use libloading::Library;
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    ptr, thread,
    time::Duration,
};
pub const SHERPA_VERSION: &str = "2.0.1";
/// Native counterpart of the old optional voice-interpreter presence check.
/// SDK presence, rather than model/device health, controls listener startup.
pub fn runtime_available() -> bool {
    std::env::var_os("HERDR_SHERPA_LIBRARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| settings::voice_home().join("native/lib/libsherpa-onnx-c-api.dylib"))
        .exists()
}
type Handle = *const c_void;
#[repr(C)]
struct EmbeddingConfig {
    model: *const c_char,
    threads: i32,
    debug: i32,
    provider: *const c_char,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Silero {
    model: *const c_char,
    threshold: f32,
    silence: f32,
    speech: f32,
    window: i32,
    max: f32,
}
#[repr(C)]
struct VadConfig {
    silero: Silero,
    rate: i32,
    threads: i32,
    provider: *const c_char,
    debug: i32,
    ten: Silero,
}
#[repr(C)]
struct Segment {
    start: i64,
    samples: *const f32,
    n: i32,
}
unsafe fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> Result<T> {
    Ok(*lib.get::<T>(name)?)
}
// A Windows system DLL with the same basename can precede PATH. Resolve the
// backend's own dependencies beside that exact backend, without changing the
// process-wide DLL policy or any installed/system library.
pub(super) unsafe fn open_backend(path: &Path) -> Result<Library> {
    #[cfg(windows)]
    {
        use libloading::os::windows::{
            Library as WindowsLibrary, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        };
        let absolute = path.canonicalize()?;
        Ok(WindowsLibrary::load_with_flags(
            absolute,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )?
        .into())
    }
    #[cfg(not(windows))]
    {
        Ok(Library::new(path)?)
    }
}
pub struct Engine {
    lib: Library,
    embedding: Handle,
    vad: Handle,
    dim: usize,
}
pub struct SpeechSegment {
    pub start: i64,
    pub samples: Vec<f32>,
}
pub fn abi_layout() -> serde_json::Value {
    serde_json::json!({"pointer_bytes":std::mem::size_of::<*const c_void>(),"embedding_config":{"size":std::mem::size_of::<EmbeddingConfig>(),"model":std::mem::offset_of!(EmbeddingConfig,model),"threads":std::mem::offset_of!(EmbeddingConfig,threads),"debug":std::mem::offset_of!(EmbeddingConfig,debug),"provider":std::mem::offset_of!(EmbeddingConfig,provider)},"vad_config":{"size":std::mem::size_of::<VadConfig>(),"silero":std::mem::offset_of!(VadConfig,silero),"rate":std::mem::offset_of!(VadConfig,rate),"threads":std::mem::offset_of!(VadConfig,threads),"provider":std::mem::offset_of!(VadConfig,provider),"debug":std::mem::offset_of!(VadConfig,debug),"ten":std::mem::offset_of!(VadConfig,ten)},"speech_segment":{"size":std::mem::size_of::<Segment>(),"start":std::mem::offset_of!(Segment,start),"samples":std::mem::offset_of!(Segment,samples),"n":std::mem::offset_of!(Segment,n)}})
}
impl Engine {
    pub fn vad_only(vad_model: &Path, threshold: f64) -> Result<Self> {
        unsafe {
            let path = std::env::var_os("HERDR_SHERPA_LIBRARY")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    settings::voice_home().join("native/lib/libsherpa-onnx-c-api.dylib")
                });
            let lib = open_backend(&path)?;
            let version = symbol::<unsafe extern "C" fn() -> *const c_char>(
                &lib,
                b"SherpaOnnxGetVersionStr\0",
            )?();
            if version.is_null() || CStr::from_ptr(version).to_str()? != SHERPA_VERSION {
                return Err(format!("sherpa-onnx ABI requires {SHERPA_VERSION}").into());
            }
            let model = CString::new(vad_model.to_string_lossy().as_bytes())?;
            let provider = CString::new("cpu")?;
            let cfg = VadConfig {
                silero: Silero {
                    model: model.as_ptr(),
                    threshold: threshold as f32,
                    silence: 0.3,
                    speech: 0.25,
                    window: 512,
                    max: 20.,
                },
                rate: 16000,
                threads: 1,
                provider: provider.as_ptr(),
                debug: 0,
                ten: std::mem::zeroed(),
            };
            let vad = symbol::<unsafe extern "C" fn(*const VadConfig, f32) -> Handle>(
                &lib,
                b"SherpaOnnxCreateVoiceActivityDetector\0",
            )?(&cfg, 60.);
            if vad.is_null() {
                return Err("Silero VAD model could not be loaded".into());
            }
            Ok(Self {
                lib,
                embedding: ptr::null(),
                vad,
                dim: 0,
            })
        }
    }
    pub fn load(model: &Path, vad_model: &Path, threshold: f64) -> Result<Self> {
        Self::load_with_vad(model, Some(vad_model), threshold)
    }
    pub fn embedding_only(model: &Path) -> Result<Self> {
        Self::load_with_vad(model, None, 0.35)
    }
    fn load_with_vad(model: &Path, vad_model: Option<&Path>, threshold: f64) -> Result<Self> {
        super::linalg::require()?;
        unsafe {
            let default = settings::voice_home().join("native/lib/libsherpa-onnx-c-api.dylib");
            let path = std::env::var_os("HERDR_SHERPA_LIBRARY")
                .map(std::path::PathBuf::from)
                .unwrap_or(default);
            let lib = open_backend(&path).map_err(|e| {
                format!(
                    "cannot load {}: {e}; run focusq voice-setup",
                    path.display()
                )
            })?;
            let version = symbol::<unsafe extern "C" fn() -> *const c_char>(
                &lib,
                b"SherpaOnnxGetVersionStr\0",
            )?();
            if version.is_null() || CStr::from_ptr(version).to_str()? != SHERPA_VERSION {
                return Err(format!("sherpa-onnx ABI requires {SHERPA_VERSION}").into());
            }
            let model = CString::new(model.to_string_lossy().as_bytes())?;
            let vad_model = vad_model
                .map(|path| CString::new(path.to_string_lossy().as_bytes()))
                .transpose()?;
            let provider = CString::new("cpu")?;
            let cfg = EmbeddingConfig {
                model: model.as_ptr(),
                threads: 2,
                debug: 0,
                provider: provider.as_ptr(),
            };
            let embedding = symbol::<unsafe extern "C" fn(*const EmbeddingConfig) -> Handle>(
                &lib,
                b"SherpaOnnxCreateSpeakerEmbeddingExtractor\0",
            )?(&cfg);
            if embedding.is_null() {
                return Err("speaker embedding model could not be loaded".into());
            }
            let dim = symbol::<unsafe extern "C" fn(Handle) -> i32>(
                &lib,
                b"SherpaOnnxSpeakerEmbeddingExtractorDim\0",
            )?(embedding);
            if dim <= 0 {
                symbol::<unsafe extern "C" fn(Handle)>(
                    &lib,
                    b"SherpaOnnxDestroySpeakerEmbeddingExtractor\0",
                )?(embedding);
                return Err("invalid embedding dimension".into());
            }
            let Some(vad_model) = vad_model else {
                return Ok(Self {
                    lib,
                    embedding,
                    vad: ptr::null(),
                    dim: dim as usize,
                });
            };
            let cfg = VadConfig {
                silero: Silero {
                    model: vad_model.as_ptr(),
                    threshold: threshold as f32,
                    silence: 0.3,
                    speech: 0.25,
                    window: 512,
                    max: 20.,
                },
                rate: 16000,
                threads: 1,
                provider: provider.as_ptr(),
                debug: 0,
                ten: std::mem::zeroed(),
            };
            let vad = symbol::<unsafe extern "C" fn(*const VadConfig, f32) -> Handle>(
                &lib,
                b"SherpaOnnxCreateVoiceActivityDetector\0",
            )?(&cfg, 60.);
            if vad.is_null() {
                symbol::<unsafe extern "C" fn(Handle)>(
                    &lib,
                    b"SherpaOnnxDestroySpeakerEmbeddingExtractor\0",
                )?(embedding);
                return Err("Silero VAD model could not be loaded".into());
            }
            Ok(Self {
                lib,
                embedding,
                vad,
                dim: dim as usize,
            })
        }
    }
    pub fn embed(&self, samples: &[f32]) -> Result<Vec<f64>> {
        unsafe {
            let create = symbol::<unsafe extern "C" fn(Handle) -> Handle>(
                &self.lib,
                b"SherpaOnnxSpeakerEmbeddingExtractorCreateStream\0",
            )?;
            let accept = symbol::<unsafe extern "C" fn(Handle, i32, *const f32, i32)>(
                &self.lib,
                b"SherpaOnnxOnlineStreamAcceptWaveform\0",
            )?;
            let finish = symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxOnlineStreamInputFinished\0",
            )?;
            let destroy = symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxDestroyOnlineStream\0",
            )?;
            let compute = symbol::<unsafe extern "C" fn(Handle, Handle) -> *const f32>(
                &self.lib,
                b"SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding\0",
            )?;
            let free = symbol::<unsafe extern "C" fn(*const f32)>(
                &self.lib,
                b"SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding\0",
            )?;
            let stream = create(self.embedding);
            if stream.is_null() {
                return Err("embedding stream allocation failed".into());
            }
            accept(
                stream,
                16000,
                samples.as_ptr(),
                i32::try_from(samples.len())?,
            );
            finish(stream);
            let vector = compute(self.embedding, stream);
            let result = if vector.is_null() {
                Err("embedding computation failed".into())
            } else {
                let mut v: Vec<f64> = std::slice::from_raw_parts(vector, self.dim)
                    .iter()
                    .map(|n| *n as f64)
                    .collect();
                free(vector);
                super::gate::normalize(&mut v)?;
                Ok(v)
            };
            destroy(stream);
            result
        }
    }
    pub fn accept(&self, block: &[f32]) -> Result<()> {
        unsafe {
            symbol::<unsafe extern "C" fn(Handle, *const f32, i32)>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorAcceptWaveform\0",
            )?(self.vad, block.as_ptr(), i32::try_from(block.len())?);
        }
        Ok(())
    }
    pub fn speaking(&self) -> Result<bool> {
        unsafe {
            Ok(symbol::<unsafe extern "C" fn(Handle) -> i32>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorDetected\0",
            )?(self.vad)
                != 0)
        }
    }
    pub fn flush(&self) -> Result<()> {
        unsafe {
            symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorFlush\0",
            )?(self.vad);
        }
        Ok(())
    }
    pub fn reset(&self) -> Result<()> {
        unsafe {
            symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorReset\0",
            )?(self.vad);
        }
        Ok(())
    }
    pub fn take(&self) -> Result<Option<Vec<f32>>> {
        Ok(self.take_segment()?.map(|s| s.samples))
    }
    pub fn take_segment(&self) -> Result<Option<SpeechSegment>> {
        unsafe {
            if symbol::<unsafe extern "C" fn(Handle) -> i32>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorEmpty\0",
            )?(self.vad)
                != 0
            {
                return Ok(None);
            }
            let front = symbol::<unsafe extern "C" fn(Handle) -> *const Segment>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorFront\0",
            )?(self.vad);
            if front.is_null() {
                return Err("VAD returned a null segment".into());
            }
            let segment = &*front;
            let start = segment.start;
            let samples = if segment.n <= 0 || segment.samples.is_null() {
                vec![]
            } else {
                std::slice::from_raw_parts(segment.samples, segment.n as usize).to_vec()
            };
            symbol::<unsafe extern "C" fn(*const Segment)>(
                &self.lib,
                b"SherpaOnnxDestroySpeechSegment\0",
            )?(front);
            symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxVoiceActivityDetectorPop\0",
            )?(self.vad);
            Ok(Some(SpeechSegment { start, samples }))
        }
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            if let Ok(f) = symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxDestroyVoiceActivityDetector\0",
            ) {
                f(self.vad);
            }
            if let Ok(f) = symbol::<unsafe extern "C" fn(Handle)>(
                &self.lib,
                b"SherpaOnnxDestroySpeakerEmbeddingExtractor\0",
            ) {
                if !self.embedding.is_null() {
                    f(self.embedding);
                }
            }
        }
    }
}

#[repr(C)]
struct DeviceInfo {
    version: i32,
    name: *const c_char,
    host: i32,
    inputs: i32,
    outputs: i32,
    input_low: f64,
    output_low: f64,
    input_high: f64,
    output_high: f64,
    rate: f64,
}
pub struct Microphone {
    lib: Library,
    stream: *mut c_void,
    pub name: String,
}
impl Microphone {
    pub fn default_name() -> Result<String> {
        unsafe {
            let mut paths = vec![];
            if let Some(path) = std::env::var_os("HERDR_PORTAUDIO_LIBRARY") {
                paths.push(std::path::PathBuf::from(path));
            }
            paths.extend(
                [
                    "/opt/homebrew/lib/libportaudio.dylib",
                    "/usr/local/lib/libportaudio.dylib",
                    "libportaudio.dylib",
                ]
                .into_iter()
                .map(std::path::PathBuf::from),
            );
            let mut found = None;
            for path in paths {
                if let Ok(lib) = Library::new(path) {
                    found = Some(lib);
                    break;
                }
            }
            let lib = found.ok_or("PortAudio is not installed; run focusq voice-setup")?;
            if symbol::<unsafe extern "C" fn() -> i32>(&lib, b"Pa_Initialize\0")?() < 0 {
                return Err("PortAudio initialization failed".into());
            }
            let result = (|| -> Result<String> {
                let device =
                    symbol::<unsafe extern "C" fn() -> i32>(&lib, b"Pa_GetDefaultInputDevice\0")?();
                if device < 0 {
                    return Err("no default microphone".into());
                }
                let info = symbol::<unsafe extern "C" fn(i32) -> *const DeviceInfo>(
                    &lib,
                    b"Pa_GetDeviceInfo\0",
                )?(device);
                if info.is_null() {
                    return Err("microphone metadata unavailable".into());
                }
                Ok(CStr::from_ptr((*info).name).to_string_lossy().into_owned())
            })();
            symbol::<unsafe extern "C" fn() -> i32>(&lib, b"Pa_Terminate\0")?();
            result
        }
    }
    pub fn open() -> Result<Self> {
        unsafe {
            let configured = std::env::var_os("HERDR_PORTAUDIO_LIBRARY");
            let mut paths = vec![];
            if let Some(path) = configured {
                paths.push(std::path::PathBuf::from(path));
            }
            paths.extend(
                [
                    "/opt/homebrew/lib/libportaudio.dylib",
                    "/usr/local/lib/libportaudio.dylib",
                    "libportaudio.dylib",
                ]
                .into_iter()
                .map(std::path::PathBuf::from),
            );
            let mut found = None;
            for path in paths {
                if let Ok(lib) = Library::new(path) {
                    found = Some(lib);
                    break;
                }
            }
            let lib = found.ok_or("PortAudio is not installed; run focusq voice-setup")?;
            let init = symbol::<unsafe extern "C" fn() -> i32>(&lib, b"Pa_Initialize\0")?();
            if init < 0 {
                return Err(format!("PortAudio initialization failed: {init}").into());
            }
            let result = (|| -> Result<_> {
                let device =
                    symbol::<unsafe extern "C" fn() -> i32>(&lib, b"Pa_GetDefaultInputDevice\0")?();
                if device < 0 {
                    return Err("no default microphone".into());
                }
                let info = symbol::<unsafe extern "C" fn(i32) -> *const DeviceInfo>(
                    &lib,
                    b"Pa_GetDeviceInfo\0",
                )?(device);
                if info.is_null() {
                    return Err("microphone metadata unavailable".into());
                }
                let name = CStr::from_ptr((*info).name).to_string_lossy().into_owned();
                let mut stream = ptr::null_mut();
                let status = symbol::<
                    unsafe extern "C" fn(
                        *mut *mut c_void,
                        i32,
                        i32,
                        libc::c_ulong,
                        f64,
                        libc::c_ulong,
                        *const c_void,
                        *mut c_void,
                    ) -> i32,
                >(&lib, b"Pa_OpenDefaultStream\0")?(
                    &mut stream,
                    1,
                    0,
                    1,
                    16000.,
                    512,
                    ptr::null(),
                    ptr::null_mut(),
                );
                if status < 0 {
                    return Err(format!("microphone open failed: {status}").into());
                }
                let status = symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(
                    &lib,
                    b"Pa_StartStream\0",
                )?(stream);
                if status < 0 {
                    symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(&lib, b"Pa_CloseStream\0")?(
                        stream,
                    );
                    return Err(format!("microphone start failed: {status}").into());
                }
                Ok((stream, name))
            })();
            match result {
                Ok((stream, name)) => Ok(Self { lib, stream, name }),
                Err(e) => {
                    symbol::<unsafe extern "C" fn() -> i32>(&lib, b"Pa_Terminate\0")?();
                    Err(e)
                }
            }
        }
    }
    pub fn block(&self) -> Result<Vec<f32>> {
        unsafe {
            let available = symbol::<unsafe extern "C" fn(*mut c_void) -> libc::c_long>(
                &self.lib,
                b"Pa_GetStreamReadAvailable\0",
            )?;
            let deadline = now() + 5.;
            loop {
                let n = available(self.stream);
                if n < 0 {
                    return Err(format!("microphone stalled: {n}").into());
                }
                if n >= 512 {
                    break;
                }
                if now() >= deadline {
                    return Err("microphone timed out".into());
                }
                thread::sleep(Duration::from_millis(5));
            }
            let mut block = vec![0f32; 512];
            let status = symbol::<
                unsafe extern "C" fn(*mut c_void, *mut c_void, libc::c_ulong) -> i32,
            >(&self.lib, b"Pa_ReadStream\0")?(
                self.stream, block.as_mut_ptr().cast(), 512
            );
            if status < 0 && status != -9981 {
                return Err(format!("microphone read failed: {status}").into());
            }
            Ok(block)
        }
    }
}
impl Drop for Microphone {
    fn drop(&mut self) {
        unsafe {
            if let Ok(f) =
                symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(&self.lib, b"Pa_StopStream\0")
            {
                f(self.stream);
            }
            if let Ok(f) =
                symbol::<unsafe extern "C" fn(*mut c_void) -> i32>(&self.lib, b"Pa_CloseStream\0")
            {
                f(self.stream);
            }
            if let Ok(f) = symbol::<unsafe extern "C" fn() -> i32>(&self.lib, b"Pa_Terminate\0") {
                f();
            }
        }
    }
}
