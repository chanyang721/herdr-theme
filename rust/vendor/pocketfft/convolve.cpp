// C ABI for the exact PocketFFT revision used by SciPy 1.16.0.
// Upstream source, license and SHA-256 provenance are retained alongside this.
#include "pocketfft_hdronly.h"

extern "C" int herdr_fftconvolve_f32_f64(const float *samples, size_t count,
                                        const double *room, size_t tail,
                                        float *output) noexcept {
  try {
    if (!samples || !room || !output || !count || !tail) return 1;
    const size_t n = pocketfft::detail::util::good_size_real(count + tail - 1);
    const size_t bins = n / 2 + 1;
    std::vector<float> signal(n, 0);
    std::vector<double> impulse(n, 0), wet(n);
    std::copy(samples, samples + count, signal.begin());
    std::copy(room, room + tail, impulse.begin());
    std::vector<std::complex<float>> a(bins);
    std::vector<std::complex<double>> b(bins), product(bins);
    // fftconvolve transforms each operand at its own precision. In particular,
    // converting the float32 speech to float64 before rfft changes results.
    pocketfft::r2c<float>({n}, {sizeof(float)}, {sizeof(std::complex<float>)},
                         0, true, signal.data(), a.data(), 1.f, 1);
    pocketfft::r2c<double>({n}, {sizeof(double)}, {sizeof(std::complex<double>)},
                          0, true, impulse.data(), b.data(), 1., 1);
    for (size_t i = 0; i < bins; ++i) {
      const double ar = a[i].real(), ai = a[i].imag();
      const double br = b[i].real(), bi = b[i].imag();
      product[i] = {ar * br - ai * bi, ar * bi + ai * br};
    }
    pocketfft::c2r<double>({n}, {sizeof(std::complex<double>)}, {sizeof(double)},
                          0, false, product.data(), wet.data(), 1. / n, 1);
    for (size_t i = 0; i < count; ++i) output[i] = static_cast<float>(wet[i]);
    return 0;
  } catch (...) {
    return 1;
  }
}
