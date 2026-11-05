//! The reduction backend is part of voice behavior: an ulp at the judging
//! threshold changes a decision. Use the exact native ILP64 OpenBLAS carried
//! by the pinned reference NumPy wheel, without loading any Python module.
use super::{settings, Result};
use libloading::Library;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    ffi::{c_char, CStr},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
type Dot = unsafe extern "C" fn(i64, *const f64, i64, *const f64, i64) -> f64;
type Gemv = unsafe extern "C" fn(
    i32,
    i32,
    i64,
    i64,
    f64,
    *const f64,
    i64,
    *const f64,
    i64,
    f64,
    *mut f64,
    i64,
);
type Gemm = unsafe extern "C" fn(
    i32,
    i32,
    i32,
    i64,
    i64,
    i64,
    f64,
    *const f64,
    i64,
    *const f64,
    i64,
    f64,
    *mut f64,
    i64,
);
type Syrk = unsafe extern "C" fn(i32, i32, i32, i64, i64, f64, *const f64, i64, f64, *mut f64, i64);
struct Backend {
    _library: Library,
    dot: Dot,
    gemv: Gemv,
    gemm: Gemm,
    syrk: Syrk,
}
static BACKEND: OnceLock<Backend> = OnceLock::new();
thread_local! {static REFERENCE:Cell<bool>=const{Cell::new(cfg!(test))};}
pub fn manifest() -> Value {
    serde_json::from_str(include_str!("../../../voice/native-blas-assets.json"))
        .expect("compiled native BLAS manifest")
}
pub fn platform() -> String {
    format!(
        "{}-{}",
        match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        },
        match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        }
    )
}
pub fn configuration() -> Result<Value> {
    let m = manifest();
    m["platforms"]
        .get(platform())
        .cloned()
        .ok_or_else(|| format!("no pinned native BLAS for {}", platform()).into())
}
pub fn default_library() -> Result<PathBuf> {
    let c = configuration()?;
    Ok(settings::voice_home()
        .join("native/blas")
        .join(c["primary"].as_str().ok_or("native BLAS primary missing")?))
}
pub fn verify(path: &Path) -> Result<()> {
    let config = configuration()?;
    let primary = config["primary"]
        .as_str()
        .ok_or("native BLAS primary missing")?;
    if path.file_name().and_then(|n| n.to_str()) != Some(primary) {
        return Err("native BLAS filename does not match the pinned platform artifact".into());
    }
    let folder = path.parent().ok_or("native BLAS path lacks parent")?;
    for file in config["files"]
        .as_array()
        .ok_or("native BLAS file list missing")?
    {
        let target = folder.join(
            file["filename"]
                .as_str()
                .ok_or("native BLAS filename missing")?,
        );
        let hash = format!(
            "{:x}",
            Sha256::digest(fs::read(&target).map_err(|e| format!(
                "native BLAS is not ready ({}): {e}; run focusq voice-setup",
                target.display()
            ))?)
        );
        if file["sha256"].as_str() != Some(hash.as_str()) {
            return Err(format!("native BLAS checksum differs: {}", target.display()).into());
        }
    }
    Ok(())
}
pub fn require() -> Result<()> {
    if BACKEND.get().is_some() {
        return Ok(());
    }
    let path = std::env::var_os("HERDR_BLAS_LIBRARY")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_library)?;
    verify(&path)?;
    let lib = unsafe { super::native::open_backend(&path)? };
    unsafe {
        let config =
            *lib.get::<unsafe extern "C" fn() -> *const c_char>(b"scipy_openblas_get_config64_\0")?;
        let description = CStr::from_ptr(config()).to_str()?;
        if !description.starts_with("OpenBLAS 0.3.29 ") || !description.contains("USE64BITINT") {
            return Err("native voice requires pinned OpenBLAS 0.3.29 ILP64".into());
        }
        let dot = *lib.get::<Dot>(b"scipy_cblas_ddot64_\0")?;
        let gemv = *lib.get::<Gemv>(b"scipy_cblas_dgemv64_\0")?;
        let gemm = *lib.get::<Gemm>(b"scipy_cblas_dgemm64_\0")?;
        let syrk = *lib.get::<Syrk>(b"scipy_cblas_dsyrk64_\0")?;
        let _ = BACKEND.set(Backend {
            _library: lib,
            dot,
            gemv,
            gemm,
            syrk,
        });
    }
    Ok(())
}
fn reference() -> bool {
    REFERENCE.with(Cell::get)
}
pub fn with_reference<T>(action: impl FnOnce() -> T) -> T {
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            REFERENCE.with(|v| v.set(self.0));
        }
    }
    let _reset = Reset(REFERENCE.with(|v| v.replace(true)));
    action()
}
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    assert_eq!(a.len(), b.len(), "voice vector dimension mismatch");
    if let Some(backend) = BACKEND.get() {
        unsafe { (backend.dot)(a.len() as i64, a.as_ptr(), 1, b.as_ptr(), 1) }
    } else {
        assert!(
            reference(),
            "exact native BLAS was not initialized for voice decisions"
        );
        a.iter().zip(b).map(|(a, b)| a * b).sum()
    }
}
pub fn matvec(rows: &[Vec<f64>], vector: &[f64]) -> Vec<f64> {
    if rows.is_empty() {
        return vec![];
    }
    assert!(rows.iter().all(|r| r.len() == vector.len()));
    if rows.len() == 1 {
        return vec![dot(&rows[0], vector)];
    }
    if let Some(backend) = BACKEND.get() {
        let data: Vec<_> = rows.iter().flatten().copied().collect();
        let mut result = vec![0.; rows.len()];
        unsafe {
            (backend.gemv)(
                102,
                112,
                vector.len() as i64,
                rows.len() as i64,
                1.,
                data.as_ptr(),
                vector.len() as i64,
                vector.as_ptr(),
                1,
                0.,
                result.as_mut_ptr(),
                1,
            );
        }
        result
    } else {
        assert!(
            reference(),
            "exact native BLAS was not initialized for matrix-vector voice decisions"
        );
        rows.iter().map(|r| dot(r, vector)).collect()
    }
}
pub fn gram(left: &[Vec<f64>], right: &[Vec<f64>]) -> Vec<Vec<f64>> {
    if left.is_empty() {
        return vec![];
    }
    if right.is_empty() {
        return vec![vec![]; left.len()];
    }
    if left.len() == 1 {
        return vec![matvec(right, &left[0])];
    }
    if right.len() == 1 {
        return matvec(left, &right[0])
            .into_iter()
            .map(|n| vec![n])
            .collect();
    }
    let depth = left[0].len();
    assert!(left.iter().chain(right).all(|r| r.len() == depth));
    if let Some(backend) = BACKEND.get() {
        let a: Vec<_> = left.iter().flatten().copied().collect();
        let b: Vec<_> = right.iter().flatten().copied().collect();
        let mut result = vec![0.; left.len() * right.len()];
        unsafe {
            (backend.gemm)(
                101,
                111,
                112,
                left.len() as i64,
                right.len() as i64,
                depth as i64,
                1.,
                a.as_ptr(),
                depth as i64,
                b.as_ptr(),
                depth as i64,
                0.,
                result.as_mut_ptr(),
                right.len() as i64,
            );
        }
        result.chunks(right.len()).map(|r| r.to_vec()).collect()
    } else {
        assert!(
            reference(),
            "exact native BLAS was not initialized for matrix voice decisions"
        );
        left.iter()
            .map(|a| right.iter().map(|b| dot(a, b)).collect())
            .collect()
    }
}
pub fn self_gram(rows: &[Vec<f64>]) -> Vec<Vec<f64>> {
    if rows.len() <= 1 {
        return gram(rows, rows);
    }
    let depth = rows[0].len();
    assert!(rows.iter().all(|r| r.len() == depth));
    if let Some(backend) = BACKEND.get() {
        let data: Vec<_> = rows.iter().flatten().copied().collect();
        let mut result = vec![0.; rows.len() * rows.len()];
        unsafe {
            (backend.syrk)(
                101,
                121,
                111,
                rows.len() as i64,
                depth as i64,
                1.,
                data.as_ptr(),
                depth as i64,
                0.,
                result.as_mut_ptr(),
                rows.len() as i64,
            );
        }
        for i in 0..rows.len() {
            for j in i + 1..rows.len() {
                result[j * rows.len() + i] = result[i * rows.len() + j];
            }
        }
        result.chunks(rows.len()).map(|r| r.to_vec()).collect()
    } else {
        gram(rows, rows)
    }
}
/// NumPy's contiguous float64 sum reduction order (not a BLAS operation).
pub fn sum(values: &[f64]) -> f64 {
    if values.len() < 8 {
        return values.iter().fold(-0., |a, b| a + b);
    }
    if values.len() <= 128 {
        let mut r = [0.; 8];
        r.copy_from_slice(&values[..8]);
        let end = values.len() - values.len() % 8;
        for i in (8..end).step_by(8) {
            for j in 0..8 {
                r[j] += values[i + j];
            }
        }
        let mut result = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
        for n in &values[end..] {
            result += n;
        }
        result
    } else {
        let half = (values.len() / 2) / 8 * 8;
        sum(&values[..half]) + sum(&values[half..])
    }
}
pub fn mean(rows: &[Vec<f64>]) -> Result<Vec<f64>> {
    let first = rows.first().ok_or("empty vector mean")?;
    let mut result = vec![0.; first.len()];
    for row in rows {
        if row.len() != result.len() {
            return Err("vector mean dimension mismatch".into());
        }
        for (r, v) in result.iter_mut().zip(row) {
            *r += v;
        }
    }
    for r in &mut result {
        *r /= rows.len() as f64;
    }
    Ok(result)
}
pub fn probe(input: &Value) -> Result<Value> {
    let rows = input["rows"]
        .as_array()
        .ok_or("matrix rows missing")?
        .iter()
        .map(super::gate::vector)
        .collect::<Vec<_>>();
    let right = input["right"]
        .as_array()
        .ok_or("right matrix missing")?
        .iter()
        .map(super::gate::vector)
        .collect::<Vec<_>>();
    let vector = super::gate::vector(&input["vector"]);
    let weights = super::gate::vector(&input["weights"]);
    let threshold = input["threshold"]
        .as_f64()
        .ok_or("matrix threshold missing")?;
    if rows.is_empty()
        || vector.is_empty()
        || rows.iter().chain(&right).any(|r| r.len() != vector.len())
    {
        return Err("invalid matrix probe dimensions".into());
    }
    let matvec = matvec(&rows, &vector);
    let cross = gram(&rows, &right);
    let gram = self_gram(&rows);
    Ok(
        serde_json::json!({"matvec":matvec,"gram":gram,"cross":cross,"near":gram.iter().map(|row|row.iter().map(|s|*s>=threshold).collect::<Vec<_>>()).collect::<Vec<_>>(),"kept":matvec.iter().map(|s|*s>=threshold).collect::<Vec<_>>(),"mean":mean(&rows)?,"centre":super::gate::build(&rows,&weights,threshold)?}),
    )
}
