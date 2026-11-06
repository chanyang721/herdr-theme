mod observer_sources;
use sha2::{Digest, Sha256};

fn observer_digest(paths: impl IntoIterator<Item = &'static str>) -> String {
    let mut digest = Sha256::new();
    for path in paths {
        println!("cargo:rerun-if-changed={path}");
        let source = std::fs::read_to_string(path).expect("observer production source");
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(observer_sources::production_source(&source).as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}
fn main() {
    println!("cargo:rerun-if-changed=observer_sources.rs");
    println!(
        "cargo:rustc-env=HERDR_CLEANUP_SOURCE_SHA256={}",
        observer_digest(observer_sources::COMMON.iter().copied())
    );
    println!(
        "cargo:rustc-env=HERDR_SLEEP_SOURCE_SHA256={}",
        observer_digest(
            observer_sources::COMMON
                .iter()
                .chain(observer_sources::SLEEP)
                .copied()
        )
    );
    println!("cargo:rerun-if-changed=vendor/pocketfft/convolve.cpp");
    println!("cargo:rerun-if-changed=vendor/pocketfft/pocketfft_hdronly.h");
    cc::Build::new()
        .cpp(true)
        .file("vendor/pocketfft/convolve.cpp")
        .std("c++11")
        .define("POCKETFFT_CACHE_SIZE", "16")
        .define("POCKETFFT_NO_MULTITHREADING", None)
        .flag_if_supported("-ffp-contract=off")
        .flag_if_supported("/fp:precise")
        .compile("herdr_pocketfft");
}
