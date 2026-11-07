fn main() {
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
