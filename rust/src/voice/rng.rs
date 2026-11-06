//! The three fixed NumPy PCG64 streams used by the original voice experiments.
//! Ziggurat tables are separately attributed; fixed initial states are captured
//! from NumPy 2.3.0 SeedSequence so these tools reproduce their original trials.
mod tables {
    include!("rng_tables.rs");
}
use tables::*;
pub struct Rng {
    state: u128,
    inc: u128,
    cached: Option<u32>,
}
impl Rng {
    pub fn new(seed: u64) -> Self {
        let (state, inc) = match seed {
            3 => (
                323726261719206589602543583274561722519,
                222003063171874261427395693950637096479,
            ),
            7 => (
                208745520555909116978795849195383758904,
                261136684632268670825940853076396136793,
            ),
            11 => (
                142231634183583599241308901332361415022,
                7937318808080196428804369945471644491,
            ),
            _ => panic!("voice experiments only use fixed seeds 3, 7 and 11"),
        };
        Self {
            state,
            inc,
            cached: None,
        }
    }
    pub fn u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(((2549297995355413924u128) << 64) | 4865540595714422341)
            .wrapping_add(self.inc);
        ((self.state >> 64) as u64 ^ (self.state as u64)).rotate_right((self.state >> 122) as u32)
    }
    fn u32(&mut self) -> u32 {
        if let Some(n) = self.cached.take() {
            return n;
        }
        let n = self.u64();
        self.cached = Some((n >> 32) as u32);
        n as u32
    }
    fn uniform(&mut self) -> f64 {
        (self.u64() >> 11) as f64 * (1. / 9007199254740992.)
    }
    pub fn normal(&mut self) -> f64 {
        loop {
            let r = self.u64();
            let idx = (r & 255) as usize;
            let r = r >> 8;
            let abs = (r >> 1) & 0x000fffffffffffff;
            let mut x = abs as f64 * WI_DOUBLE[idx];
            if r & 1 != 0 {
                x = -x;
            }
            if abs < KI_DOUBLE[idx] {
                return x;
            }
            if idx == 0 {
                loop {
                    let xx = -ZIGGURAT_NOR_INV_R * (-self.uniform()).ln_1p();
                    let yy = -(-self.uniform()).ln_1p();
                    if yy + yy > xx * xx {
                        return if (abs >> 8) & 1 != 0 {
                            -(ZIGGURAT_NOR_R + xx)
                        } else {
                            ZIGGURAT_NOR_R + xx
                        };
                    }
                }
            } else if (FI_DOUBLE[idx - 1] - FI_DOUBLE[idx]) * self.uniform() + FI_DOUBLE[idx]
                < (-0.5 * x * x).exp()
            {
                return x;
            }
        }
    }
    pub fn integer(&mut self, high: usize) -> usize {
        assert!(high > 0 && high <= u32::MAX as usize);
        let range = high as u32;
        loop {
            let product = self.u32() as u64 * range as u64;
            let low = product as u32;
            if low < range {
                let threshold = range.wrapping_neg() % range;
                if low < threshold {
                    continue;
                }
            }
            return (product >> 32) as usize;
        }
    }
    fn interval(&mut self, max: usize) -> usize {
        if max == 0 {
            return 0;
        }
        let mut mask = max;
        for shift in [1, 2, 4, 8, 16, 32] {
            mask |= mask >> shift;
        }
        loop {
            let n = (self.u32() as usize) & mask;
            if n <= max {
                return n;
            }
        }
    }
    pub fn permutation(&mut self, n: usize) -> Vec<usize> {
        let mut result: Vec<_> = (0..n).collect();
        for i in (1..n).rev() {
            let j = self.interval(i);
            result.swap(i, j);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn frozen_numpy_random_streams_match() {
        let fixtures: Value = serde_json::from_str(include_str!("rng-fixtures.json")).unwrap();
        for seed in [3, 7, 11] {
            let mut rng = Rng::new(seed);
            for n in fixtures[seed.to_string()]["normal"].as_array().unwrap() {
                let expected = n.as_f64().unwrap();
                let got = rng.normal();
                assert!(
                    (got - expected).abs() < 1e-14,
                    "seed={seed}: {got} != {expected}"
                );
            }
            let mut rng = Rng::new(seed);
            for n in fixtures[seed.to_string()]["integers"].as_array().unwrap() {
                assert_eq!(rng.integer(10000), n.as_u64().unwrap() as usize);
            }
            let mut rng = Rng::new(seed);
            assert_eq!(
                rng.permutation(100),
                fixtures[seed.to_string()]["permutation"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as usize)
                    .collect::<Vec<_>>()
            );
        }
    }
}
