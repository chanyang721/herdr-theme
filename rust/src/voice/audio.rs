//! libsndfile 1.2.2 virtual I/O preserves the formats and float32 decoding of
//! the original SoundFile 0.13.1 evaluation loader, without Python bindings.
use super::{settings, Result};
use libloading::Library;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    ffi::{c_char, c_void, CStr},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
#[repr(C)]
#[derive(Default)]
struct Info {
    frames: i64,
    rate: i32,
    channels: i32,
    format: i32,
    sections: i32,
    seekable: i32,
}
#[repr(C)]
struct VirtualIo {
    length: unsafe extern "C" fn(*mut c_void) -> i64,
    seek: unsafe extern "C" fn(i64, i32, *mut c_void) -> i64,
    read: unsafe extern "C" fn(*mut c_void, i64, *mut c_void) -> i64,
    write: unsafe extern "C" fn(*const c_void, i64, *mut c_void) -> i64,
    tell: unsafe extern "C" fn(*mut c_void) -> i64,
}
struct Input<'a> {
    bytes: &'a [u8],
    position: usize,
}
unsafe extern "C" fn length(user: *mut c_void) -> i64 {
    let input = &*(user as *mut Input<'_>);
    input.bytes.len() as i64
}
unsafe extern "C" fn tell(user: *mut c_void) -> i64 {
    (*(user as *mut Input<'_>)).position as i64
}
unsafe extern "C" fn seek(offset: i64, whence: i32, user: *mut c_void) -> i64 {
    let input = &mut *(user as *mut Input<'_>);
    let base = match whence {
        0 => 0,
        1 => input.position as i128,
        2 => input.bytes.len() as i128,
        _ => return -1,
    };
    let mut next = base + offset as i128;
    if next < 0 {
        if whence == 0 {
            return -1;
        }
        next = 0;
    }
    if next > i64::MAX as i128 || next > usize::MAX as i128 {
        return -1;
    }
    input.position = next as usize;
    next as i64
}
unsafe extern "C" fn read(target: *mut c_void, count: i64, user: *mut c_void) -> i64 {
    if count <= 0 {
        return 0;
    }
    let input = &mut *(user as *mut Input<'_>);
    let remaining = input.bytes.len().saturating_sub(input.position);
    let count = usize::try_from(count).unwrap_or(usize::MAX).min(remaining);
    if count > 0 {
        std::ptr::copy_nonoverlapping(
            input.bytes.as_ptr().add(input.position),
            target.cast(),
            count,
        );
        input.position += count;
    }
    count as i64
}
unsafe extern "C" fn write(_: *const c_void, _: i64, _: *mut c_void) -> i64 {
    0
}
static IO: VirtualIo = VirtualIo {
    length,
    seek,
    read,
    write,
    tell,
};
type Open = unsafe extern "C" fn(*const VirtualIo, i32, *mut Info, *mut c_void) -> *mut c_void;
type Read = unsafe extern "C" fn(*mut c_void, *mut f32, i64) -> i64;
type Seek = unsafe extern "C" fn(*mut c_void, i64, i32) -> i64;
type Close = unsafe extern "C" fn(*mut c_void) -> i32;
type Error = unsafe extern "C" fn(*mut c_void) -> i32;
type ErrorText = unsafe extern "C" fn(*mut c_void) -> *const c_char;
struct Backend {
    _library: Library,
    open: Open,
    read: Read,
    seek: Seek,
    close: Close,
    error: Error,
    error_text: ErrorText,
}
static BACKEND: OnceLock<Backend> = OnceLock::new();
pub fn manifest() -> Value {
    serde_json::from_str(include_str!("../../../voice/native-sndfile-assets.json"))
        .expect("compiled libsndfile manifest")
}
pub fn configuration() -> Result<Value> {
    manifest()["platforms"]
        .get(super::linalg::platform())
        .cloned()
        .ok_or_else(|| "no pinned native libsndfile for this platform".into())
}
pub fn default_library() -> Result<PathBuf> {
    let config = configuration()?;
    Ok(settings::voice_home().join("native/sndfile").join(
        config["primary"]
            .as_str()
            .ok_or("libsndfile primary missing")?,
    ))
}
pub fn verify(path: &Path) -> Result<()> {
    let config = configuration()?;
    if path.file_name().and_then(|n| n.to_str()) != config["primary"].as_str() {
        return Err("libsndfile filename does not match pinned platform".into());
    }
    for file in config["files"]
        .as_array()
        .ok_or("libsndfile file list missing")?
    {
        let target = path.parent().ok_or("libsndfile path lacks parent")?.join(
            file["filename"]
                .as_str()
                .ok_or("libsndfile filename missing")?,
        );
        let actual = format!("{:x}", Sha256::digest(fs::read(&target)?));
        if file["sha256"].as_str() != Some(actual.as_str()) {
            return Err(format!("libsndfile checksum differs: {}", target.display()).into());
        }
    }
    Ok(())
}
fn backend() -> Result<&'static Backend> {
    if let Some(backend) = BACKEND.get() {
        return Ok(backend);
    }
    let path = std::env::var_os("HERDR_SNDFILE_LIBRARY")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_library)?;
    verify(&path).map_err(|error| format!("{error}; run focusq voice-setup"))?;
    let library = unsafe { super::native::open_backend(&path)? };
    unsafe {
        let version =
            *library.get::<unsafe extern "C" fn() -> *const c_char>(b"sf_version_string\0")?;
        if CStr::from_ptr(version()).to_str()? != "libsndfile-1.2.2" {
            return Err("evaluation requires pinned libsndfile 1.2.2".into());
        }
        let open = *library.get::<Open>(b"sf_open_virtual\0")?;
        let read = *library.get::<Read>(b"sf_readf_float\0")?;
        let seek = *library.get::<Seek>(b"sf_seek\0")?;
        let close = *library.get::<Close>(b"sf_close\0")?;
        let error = *library.get::<Error>(b"sf_error\0")?;
        let error_text = *library.get::<ErrorText>(b"sf_strerror\0")?;
        let _ = BACKEND.set(Backend {
            _library: library,
            open,
            read,
            seek,
            close,
            error,
            error_text,
        });
    }
    Ok(BACKEND.get().ok_or("libsndfile initialization failed")?)
}
pub fn decode(bytes: &[u8]) -> Result<Vec<f32>> {
    let backend = backend()?;
    let mut input = Input { bytes, position: 0 };
    let mut info = Info::default();
    let handle = unsafe {
        (backend.open)(
            &IO,
            0x10,
            &mut info,
            &mut input as *mut Input<'_> as *mut c_void,
        )
    };
    if handle.is_null() {
        let text = unsafe { CStr::from_ptr((backend.error_text)(handle)) }.to_string_lossy();
        return Err(format!("cannot decode audio: {text}").into());
    }
    struct File<'a> {
        handle: *mut c_void,
        backend: &'a Backend,
    }
    impl Drop for File<'_> {
        fn drop(&mut self) {
            unsafe {
                (self.backend.close)(self.handle);
            }
        }
    }
    let _file = File { handle, backend };
    // SoundFile.read -> _prepare_read explicitly rewinds every seekable file.
    // MPEG decoder state can differ by ulps if this apparently redundant seek
    // is omitted, so opening at frame zero alone is not equivalent.
    if info.seekable != 0 && unsafe { (backend.seek)(handle, 0, 0) } < 0 {
        let text = unsafe { CStr::from_ptr((backend.error_text)(handle)) }.to_string_lossy();
        return Err(format!("audio seek failed: {text}").into());
    }
    if info.rate != 16000 || info.channels != 1 {
        return Err("unexpected format: expected mono 16000 Hz".into());
    }
    let count = usize::try_from(info.frames).map_err(|_| "invalid decoded frame count")?;
    let mut samples = Vec::new();
    samples.try_reserve_exact(count)?;
    samples.resize(count, 0f32);
    let read = unsafe { (backend.read)(handle, samples.as_mut_ptr(), info.frames) };
    if read < 0 || read > info.frames || unsafe { (backend.error)(handle) } != 0 {
        let text = unsafe { CStr::from_ptr((backend.error_text)(handle)) }.to_string_lossy();
        return Err(format!("audio read failed: {text}").into());
    }
    samples.truncate(read as usize);
    Ok(samples)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_memory_io_matches_bytesio_seek_eof_and_negative_seek() {
        let mut input = Input {
            bytes: &[1, 2, 3],
            position: 0,
        };
        let user = &mut input as *mut Input<'_> as *mut c_void;
        let mut output = [0u8; 4];
        unsafe {
            assert_eq!(length(user), 3);
            assert_eq!(seek(-1, 2, user), 2);
            assert_eq!(read(output.as_mut_ptr().cast(), 4, user), 1);
            assert_eq!(output[0], 3);
            assert_eq!(tell(user), 3);
            assert_eq!(seek(-4, 0, user), -1);
            assert_eq!(tell(user), 3);
            assert_eq!(seek(-4, 1, user), 0);
            assert_eq!(seek(-4, 2, user), 0);
            assert_eq!(seek(10, 0, user), 10);
            assert_eq!(read(output.as_mut_ptr().cast(), 4, user), 0);
        }
    }
}
