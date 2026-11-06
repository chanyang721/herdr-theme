//! Notices accompany installed native binaries, including optional voice copies.
pub fn files() -> &'static [(&'static str, &'static [u8])] {
    &[
        (
            "pocketfft-LICENSE.md",
            include_bytes!("../vendor/pocketfft/LICENSE.md"),
        ),
        (
            "pocketfft-provenance.json",
            include_bytes!("../vendor/pocketfft/provenance.json"),
        ),
        ("numpy-LICENSE.txt", include_bytes!("../licenses/numpy.txt")),
    ]
}
