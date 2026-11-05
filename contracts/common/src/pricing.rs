//! The attention-implied value of an UP token: the probability that a trend's index ends above
//! its series' opening index (UP pays 1 USDC then, DOWN otherwise; ties go DOWN).
//!
//! With probability q = exp(-lambda tau) the index does not change again before expiry, and UP
//! wins exactly when it is already above the opening. Otherwise the index diffuses in log terms
//! with variance rate sigma^2, and UP wins with probability N(ln(I / I0) / (sigma sqrt(tau))).
//! The result is bounded to [0.02, 0.98]. The market maker (apps/market-maker) quotes around the
//! same model, and `book` anchors session trades to it.

use crate::math::{exp_wad, isqrt, ln_wad, norm_cdf, UWAD, WAD};

/// Log-variance per second while the index moves: about 60% daily volatility (0.36 / day).
pub const VARIANCE_PER_SEC_WAD: u128 = 360_000_000_000_000_000 / 86_400;
/// Index changes per second: one every ten minutes.
pub const CHANGES_PER_SEC_WAD: u128 = UWAD / 600;
pub const MIN_PROBABILITY_WAD: u128 = 20_000_000_000_000_000;
pub const MAX_PROBABILITY_WAD: u128 = 980_000_000_000_000_000;

/// Probability (WAD) that UP wins, from the latest index and the opening index (both with the
/// registry's 6 decimals) and the seconds left to expiry.
pub fn up_probability_wad(index: u64, opening: u64, tau_secs: u64) -> u128 {
    let above: u128 = if index > opening { UWAD } else { 0 };
    let p = if tau_secs == 0 {
        above
    } else {
        let decay = (CHANGES_PER_SEC_WAD * tau_secs as u128).min(46 * UWAD) as i128;
        let stay = exp_wad(-decay) as u128;
        (stay * above + (UWAD - stay) * diffuse(index, opening, tau_secs)) / UWAD
    };
    p.clamp(MIN_PROBABILITY_WAD, MAX_PROBABILITY_WAD)
}

/// The same probability in USDC units (6 decimals): the fair price of one UP token.
pub fn fair_up_usdc(index: u64, opening: u64, tau_secs: u64) -> u128 {
    up_probability_wad(index, opening, tau_secs) / 1_000_000_000_000
}

/// N(ln(I / I0) / (sigma sqrt(tau))), with the limits of the log at a zero index.
fn diffuse(index: u64, opening: u64, tau_secs: u64) -> u128 {
    if opening == 0 {
        return if index == 0 { 0 } else { UWAD };
    }
    if index == 0 {
        return 0;
    }
    let ratio = index as i128 * WAD / opening as i128;
    let x = ln_wad(ratio);
    let sd = isqrt(VARIANCE_PER_SEC_WAD * tau_secs as u128 * UWAD) as i128;
    if sd == 0 {
        return if x > 0 { UWAD } else { 0 };
    }
    norm_cdf(x * WAD / sd) as u128
}

#[cfg(test)]
mod tests {
    use super::*;

    fn float_model(index: f64, opening: f64, tau: f64) -> f64 {
        let above = if index > opening { 1.0 } else { 0.0 };
        if tau == 0.0 {
            return above;
        }
        let stay = (-(tau / 600.0)).exp();
        let sd = (0.36 / 86_400.0 * tau).sqrt();
        let z = (index / opening).ln() / sd;
        let n = 0.5 * (1.0 + erf(z / std::f64::consts::SQRT_2));
        (stay * above + (1.0 - stay) * n).clamp(0.02, 0.98)
    }

    fn erf(x: f64) -> f64 {
        // Abramowitz and Stegun 7.1.26, as the contract uses it.
        let t = 1.0 / (1.0 + 0.3275911 * x.abs());
        let y = 1.0
            - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
                * t
                * (-x * x).exp();
        if x >= 0.0 {
            y
        } else {
            -y
        }
    }

    #[test]
    fn matches_the_float_model() {
        for (i, o, tau) in [
            (50.0, 50.0, 3600.0),
            (55.0, 50.0, 3600.0),
            (45.0, 50.0, 86_400.0),
            (72.4, 60.0, 600.0),
            (10.0, 90.0, 86_400.0 * 7.0),
            (90.0, 10.0, 60.0),
        ] {
            let got = up_probability_wad((i * 1e6) as u64, (o * 1e6) as u64, tau as u64) as f64 / 1e18;
            let want = float_model(i, o, tau);
            assert!((got - want).abs() < 1e-6, "p({i},{o},{tau}) = {got}, want {want}");
        }
    }

    #[test]
    fn bounds_and_expiry() {
        assert_eq!(up_probability_wad(60_000_000, 50_000_000, 0), MAX_PROBABILITY_WAD);
        assert_eq!(up_probability_wad(50_000_000, 50_000_000, 0), MIN_PROBABILITY_WAD);
        assert_eq!(fair_up_usdc(60_000_000, 50_000_000, 0), 980_000);
        let mid = fair_up_usdc(50_000_000, 50_000_000, 86_400);
        assert!((490_000..=510_000).contains(&mid), "at the money is near 0.5: {mid}");
    }
}
