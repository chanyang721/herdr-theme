//! Compatible helper locks: on Windows the reserved byte is beyond JSON metadata.
pub trait FileLock {
    fn lock_exclusive(&self) -> std::io::Result<()>;
    fn try_lock_exclusive(&self) -> std::io::Result<()>;
}
impl FileLock for std::fs::File {
    fn lock_exclusive(&self) -> std::io::Result<()> {
        lock(self, false)
    }
    fn try_lock_exclusive(&self) -> std::io::Result<()> {
        lock(self, true)
    }
}
pub fn lock(file: &std::fs::File, nonblocking: bool) -> std::io::Result<()> {
    #[cfg(not(windows))]
    {
        if nonblocking {
            fs2::FileExt::try_lock_exclusive(file)
        } else {
            fs2::FileExt::lock_exclusive(file)
        }
    }
    #[cfg(windows)]
    {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            internal_high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut c_void,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn LockFileEx(
                handle: *mut c_void,
                flags: u32,
                reserved: u32,
                low: u32,
                high: u32,
                overlap: *mut Overlapped,
            ) -> i32;
        }
        let mut overlapped = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 1 << 30,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        if unsafe {
            LockFileEx(
                file.as_raw_handle(),
                2 | if nonblocking { 1 } else { 0 },
                0,
                1,
                0,
                &mut overlapped,
            )
        } != 0
        {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if nonblocking && matches!(error.raw_os_error(), Some(32 | 33 | 36)) {
            Err(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "Sixfold helper lock is held",
            ))
        } else {
            Err(error)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_excludes_another_writer_without_obscuring_metadata() {
        use std::io::Write;
        let mut first = tempfile::NamedTempFile::new().unwrap();
        first.write_all(b"{\"owner\":\"fixture\"}").unwrap();
        FileLock::lock_exclusive(first.as_file()).unwrap();
        let second = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(first.path())
            .unwrap();
        assert!(FileLock::try_lock_exclusive(&second).is_err());
        assert_eq!(
            std::fs::read_to_string(first.path()).unwrap(),
            "{\"owner\":\"fixture\"}"
        );
        assert_eq!(first.as_file().metadata().unwrap().len(), 19);
    }
}
