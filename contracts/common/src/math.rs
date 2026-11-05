//! Fixed-point math on 18-decimal integers ("WAD", 1e18 is one) with explicit rounding.
//!
//! Contracts never use floats: every function here is exact integer arithmetic, rounds in the
//! direction its name says, and panics on overflow instead of wrapping.

pub const WAD: i128 = 1_000_000_000_000_000_000;
pub const UWAD: u128 = WAD as u128;
/// ln(2) in WAD.
const LN2: i128 = 693_147_180_559_945_309;

/// `a * b / d`, rounded down. Panics if `d` is zero or the result overflows.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> u128 {
    assert!(d != 0, "division by zero");
    match a.checked_mul(b) {
        Some(p) => p / d,
        None => wide_mul_div(a, b, d, false),
    }
}

/// `a * b / d`, rounded up. Panics if `d` is zero or the result overflows.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    assert!(d != 0, "division by zero");
    match a.checked_mul(b) {
        Some(p) => p.div_ceil(d),
        None => wide_mul_div(a, b, d, true),
    }
}

/// 256-bit intermediate product for `mul_div` when `a * b` does not fit in 128 bits.
fn wide_mul_div(a: u128, b: u128, d: u128, round_up: bool) -> u128 {
    // Split into 64-bit halves and multiply as (hi, lo) 128-bit words.
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & u64::MAX as u128) + (p10 & u64::MAX as u128);
    let lo = (p00 & u64::MAX as u128) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    assert!(hi < d, "mul_div overflow");
    // Long division of (hi, lo) by d, one bit at a time.
    let (mut q, mut r) = (0u128, hi);
    for i in (0..128).rev() {
        let carry = r >> 127;
        r = (r << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || r >= d {
            r = r.wrapping_sub(d);
            q |= 1;
        }
    }
    if round_up && r != 0 {
        q.checked_add(1).expect("mul_div overflow")
    } else {
        q
    }
}

/// Integer square root, rounded down.
pub fn isqrt(x: u128) -> u128 {
    if x < 2 {
        return x;
    }
    let mut r = 1u128 << ((128 - x.leading_zeros()).div_ceil(2));
    loop {
        let next = (r + x / r) / 2;
        if next >= r {
            return r;
        }
        r = next;
    }
}

/// e^x for `x` in WAD. Returns 0 below about -41.4 and panics when the result leaves the i128 WAD range
/// (about x > 46.5).
pub fn exp_wad(x: i128) -> i128 {
    if x < -41_446_531_673_892_822_312 {
        return 0;
    }
    assert!(x <= 47 * WAD, "exp overflow");
    // x = k ln2 + r with |r| <= ln2 / 2.
    let k = if x >= 0 { (x + LN2 / 2) / LN2 } else { (x - LN2 / 2) / LN2 };
    let r = x - k * LN2;
    // Taylor series for e^r.
    let mut term = WAD;
    let mut sum = WAD;
    for n in 1..=24 {
        term = term * r / WAD / n;
        if term == 0 {
            break;
        }
        sum += term;
    }
    if k >= 0 {
        sum.checked_shl(k as u32).filter(|v| v >> k == sum).expect("exp overflow")
    } else {
        sum >> (-k) as u32
    }
}

/// ln(x) for `x` in WAD, `x > 0`.
pub fn ln_wad(x: i128) -> i128 {
    assert!(x > 0, "ln of non-positive");
    // x = m * 2^k with m in [1, 2).
    let mut k: i128 = 0;
    let mut m = x;
    while m >= 2 * WAD {
        m >>= 1;
        k += 1;
    }
    while m < WAD {
        m <<= 1;
        k -= 1;
    }
    // ln(m) = 2 atanh(z), z = (m - 1) / (m + 1) in [0, 1/3].
    let z = (m - WAD) * WAD / (m + WAD);
    let z2 = z * z / WAD;
    let mut term = z;
    let mut sum = z;
    let mut n = 1i128;
    loop {
        term = term * z2 / WAD;
        n += 2;
        let add = term / n;
        if add == 0 {
            break;
        }
        sum += add;
    }
    k * LN2 + 2 * sum
}

/// Standard normal CDF at `z` (WAD), Abramowitz and Stegun 7.1.26 (error below 1.5e-7).
pub fn norm_cdf(z: i128) -> i128 {
    const P: i128 = 327_591_100_000_000_000;
    const A1: i128 = 254_829_592_000_000_000;
    const A2: i128 = -284_496_736_000_000_000;
    const A3: i128 = 1_421_413_741_000_000_000;
    const A4: i128 = -1_453_152_027_000_000_000;
    const A5: i128 = 1_061_405_429_000_000_000;
    const SQRT2: i128 = 1_414_213_562_373_095_049;
    const MAX_Z: i128 = 10 * WAD;
    if z >= MAX_Z {
        return WAD;
    }
    if z <= -MAX_Z {
        return 0;
    }
    let a = z.abs();
    let t = WAD * WAD / (WAD + P * a / SQRT2);
    let mut s = A4 + t * A5 / WAD;
    s = A3 + t * s / WAD;
    s = A2 + t * s / WAD;
    s = A1 + t * s / WAD;
    let poly = t * s / WAD;
    let erf = (WAD - poly * exp_wad(-(a * a / WAD / 2)) / WAD).max(0);
    if z >= 0 {
        (WAD + erf) / 2
    } else {
        (WAD - erf) / 2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(x: i128) -> f64 {
        x as f64 / 1e18
    }

    #[test]
    fn mul_div_rounds_both_ways() {
        assert_eq!(mul_div_floor(10, 10, 3), 33);
        assert_eq!(mul_div_ceil(10, 10, 3), 34);
        assert_eq!(mul_div_ceil(9, 10, 3), 30);
        // Wide path: (2^127) * 4 / 8 = 2^126.
        assert_eq!(mul_div_floor(1 << 127, 4, 8), 1 << 126);
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    }

    #[test]
    #[should_panic(expected = "mul_div overflow")]
    fn mul_div_overflow_panics() {
        mul_div_floor(u128::MAX, 2, 1);
    }

    #[test]
    fn sqrt_is_exact_floor() {
        for x in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 100, u128::MAX] {
            let r = isqrt(x);
            assert!(r * r <= x);
            assert!((r + 1).checked_mul(r + 1).is_none_or(|s| s > x));
        }
    }

    #[test]
    fn exp_and_ln_match_floats() {
        for x in [-40.0f64, -10.0, -1.0, -0.5, 0.0, 0.1, 1.0, 2.5, 10.0, 40.0] {
            let got = f(exp_wad((x * 1e18) as i128));
            assert!((got - x.exp()).abs() <= x.exp() * 1e-12 + 1e-17, "exp({x}) = {got}");
        }
        for x in [1e-12f64, 0.001, 0.5, 1.0, 1.5, 2.0, 100.0, 1e9] {
            let got = f(ln_wad((x * 1e18) as i128));
            assert!((got - x.ln()).abs() < 1e-12, "ln({x}) = {got}");
        }
    }

    #[test]
    fn norm_cdf_is_close() {
        for (z, want) in
            [(-3.0, 0.0013499), (-1.0, 0.1586553), (0.0, 0.5), (1.0, 0.8413447), (2.5, 0.9937903)]
        {
            let got = f(norm_cdf((z * 1e18) as i128));
            assert!((got - want).abs() < 2e-7, "N({z}) = {got}");
        }
        assert_eq!(norm_cdf(11 * WAD), WAD);
        assert_eq!(norm_cdf(-11 * WAD), 0);
    }
}
