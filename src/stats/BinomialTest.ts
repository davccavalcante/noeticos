/**
 * Exact statistical tests used by the canary promotion logic: the binomial upper
 * tail, the Wilson score interval, Welch's t statistic, and the exact one-sided
 * Student t tail via the regularized incomplete beta function.
 *
 * All functions are pure, allocation-free, and depend on nothing but Math.
 *
 * References:
 * - Lanczos, C. (1964). A precision approximation of the gamma function. SIAM Journal
 *   on Numerical Analysis, Series B, 1, 86-96.
 * - Press, W. H., Teukolsky, S. A., Vetterling, W. T., Flannery, B. P. (2007).
 *   Numerical Recipes, 3rd edition, Sections 6.1 (gamma function) and 6.4
 *   (incomplete beta function, continued-fraction evaluation).
 * - Lentz, W. J. (1976). Generating Bessel functions in Mie scattering calculations
 *   using continued fractions. Applied Optics, 15(3), 668-671 (the modified Lentz
 *   recurrence used for the continued fraction).
 * - Abramowitz, M., Stegun, I. A. (1964). Handbook of Mathematical Functions,
 *   Sections 26.5 (incomplete beta function) and 26.7 (Student's t distribution,
 *   the identity P(T > t) = I_x(df/2, 1/2) / 2 with x = df / (df + t^2)).
 * - Wilson, E. B. (1927). Probable inference, the law of succession, and statistical
 *   inference. Journal of the American Statistical Association, 22(158), 209-212.
 * - Welch, B. L. (1947). The generalization of "Student's" problem when several
 *   different population variances are involved. Biometrika, 34(1-2), 28-35.
 * - Satterthwaite, F. E. (1946). An approximate distribution of estimates of variance
 *   components. Biometrics Bulletin, 2(6), 110-114.
 */

import { NoeticosError } from '../errors';

/** ln(2 * pi) / 2, the constant term of the Stirling-Lanczos expansion. */
const HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI);

/** Lanczos parameter g = 7 paired with the 9-term coefficient set below. */
const LANCZOS_G = 7;

/**
 * Lanczos coefficients for g = 7, n = 9, the set computed by Godfrey and used by
 * Numerical Recipes; relative error of the resulting gamma approximation is below
 * 2e-10 over the right half-plane, far inside double precision noise after the log.
 */
const LANCZOS_COEFFICIENTS: readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/**
 * Natural logarithm of the gamma function via the Lanczos approximation
 * (Lanczos 1964; Press et al. 2007, Section 6.1).
 *
 * For z >= 0.5 the sum is evaluated directly; for z < 0.5 the Euler reflection
 * formula Gamma(z) * Gamma(1 - z) = pi / sin(pi * z) is applied first so the series
 * is always evaluated in its accurate region. The binomial tail only calls this with
 * arguments >= 1, the reflection branch exists for robustness.
 */
function lgamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  }
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8] = LANCZOS_COEFFICIENTS;
  const x = z - 1;
  const series =
    c0 +
    c1 / (x + 1) +
    c2 / (x + 2) +
    c3 / (x + 3) +
    c4 / (x + 4) +
    c5 / (x + 5) +
    c6 / (x + 6) +
    c7 / (x + 7) +
    c8 / (x + 8);
  const base = x + LANCZOS_G + 0.5;
  return HALF_LOG_TWO_PI + (x + 0.5) * Math.log(base) - base + Math.log(series);
}

/** Magnitude guard of the modified Lentz recurrence, replaces exact zeros. */
const LENTZ_TINY = 1e-300;

/** Relative convergence threshold of the continued fraction, below double noise. */
const LENTZ_EPSILON = 3e-15;

/**
 * Iteration cap of the continued fraction. Convergence needs O(sqrt(max(a, b)))
 * iterations in the worst case; 300 covers degrees of freedom far beyond anything
 * the rollout judge can produce.
 */
const LENTZ_MAX_ITERATIONS = 300;

/**
 * Continued-fraction kernel of the regularized incomplete beta function, evaluated
 * with the modified Lentz recurrence (Lentz 1976; Press et al. 2007, Section 6.4).
 * Only called by {@link regularizedIncompleteBeta} in its convergent region
 * x < (a + 1) / (a + b + 2).
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < LENTZ_TINY) {
    d = LENTZ_TINY;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= LENTZ_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    const even = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + even * d;
    if (Math.abs(d) < LENTZ_TINY) {
      d = LENTZ_TINY;
    }
    c = 1 + even / c;
    if (Math.abs(c) < LENTZ_TINY) {
      c = LENTZ_TINY;
    }
    d = 1 / d;
    h *= d * c;
    const odd = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + odd * d;
    if (Math.abs(d) < LENTZ_TINY) {
      d = LENTZ_TINY;
    }
    c = 1 + odd / c;
    if (Math.abs(c) < LENTZ_TINY) {
      c = LENTZ_TINY;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < LENTZ_EPSILON) {
      break;
    }
  }
  return h;
}

/**
 * Regularized incomplete beta function I_x(a, b) (Abramowitz and Stegun 1964,
 * Section 26.5; Press et al. 2007, Section 6.4). The prefactor
 * x^a * (1 - x)^b / (a * B(a, b)) is computed in log space through the Lanczos
 * lgamma above, and the continued fraction is evaluated on whichever of I_x(a, b)
 * or its complement 1 - I_(1-x)(b, a) converges fast, the standard symmetry split
 * at x = (a + 1) / (a + b + 2).
 */
function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const logPrefactor = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  if (x < (a + 1) / (a + b + 2)) {
    return (Math.exp(logPrefactor) * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (Math.exp(logPrefactor) * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Exact one-sided upper tail of the binomial distribution: P(X >= successes) for
 * X ~ Binomial(trials, p).
 *
 * Each term P(X = k) = C(trials, k) * p^k * (1 - p)^(trials - k) is computed in log
 * space as lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1) + k * ln(p) +
 * (n - k) * ln(1 - p), with ln(1 - p) via log1p for accuracy near p = 1, and the terms
 * are combined with a streaming log-sum-exp so the sum neither underflows nor
 * overflows even when every individual term is far below the smallest double.
 * Cost is O(trials - successes + 1) lgamma evaluations.
 *
 * Edge cases: successes <= 0 returns 1 (the whole distribution), successes > trials
 * returns 0 (an impossible count), p = 0 and p = 1 return their degenerate
 * point-mass tails.
 *
 * @param successes Observed success count, an integer.
 * @param trials Number of trials, a non-negative integer.
 * @param p Per-trial success probability in [0, 1].
 * @returns The tail probability, clamped to [0, 1].
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when arguments are out of domain.
 */
export function binomialUpperTail(successes: number, trials: number, p: number): number {
  if (!Number.isInteger(successes)) {
    throw NoeticosError.invalid(`binomialUpperTail requires integer successes, got ${successes}`);
  }
  if (!Number.isInteger(trials) || trials < 0) {
    throw NoeticosError.invalid(
      `binomialUpperTail requires a non-negative integer trials, got ${trials}`,
    );
  }
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw NoeticosError.invalid(`binomialUpperTail requires p in [0, 1], got ${p}`);
  }
  if (successes <= 0) {
    return 1;
  }
  if (successes > trials) {
    return 0;
  }
  if (p === 0) {
    return 0;
  }
  if (p === 1) {
    return 1;
  }
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  const logGammaTrials = lgamma(trials + 1);
  let maxLogTerm = Number.NEGATIVE_INFINITY;
  let scaledSum = 0;
  for (let k = successes; k <= trials; k += 1) {
    const logTerm =
      logGammaTrials - lgamma(k + 1) - lgamma(trials - k + 1) + k * logP + (trials - k) * logQ;
    if (logTerm > maxLogTerm) {
      scaledSum = scaledSum * Math.exp(maxLogTerm - logTerm) + 1;
      maxLogTerm = logTerm;
    } else {
      scaledSum += Math.exp(logTerm - maxLogTerm);
    }
  }
  return Math.min(1, Math.exp(maxLogTerm + Math.log(scaledSum)));
}

/**
 * Wilson score interval for a binomial proportion (Wilson 1927).
 *
 * Unlike the Wald interval, the Wilson interval never escapes [0, 1], behaves sanely
 * at 0 and trials successes, and keeps close to nominal coverage at the small canary
 * sample sizes NoeticOS works with. With phat = successes / trials and n = trials:
 *
 *   center = (phat + z^2 / (2n)) / (1 + z^2 / n)
 *   halfWidth = (z / (1 + z^2 / n)) * sqrt(phat * (1 - phat) / n + z^2 / (4 n^2))
 *
 * Zero trials carry no information, so the interval is the whole of [0, 1].
 *
 * @param successes Observed success count, an integer in [0, trials].
 * @param trials Number of trials, a non-negative integer.
 * @param z Two-sided standard normal critical value, for example 1.96 for 95 percent.
 * @returns Interval bounds, each clamped to [0, 1].
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when arguments are out of domain.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number,
): { lower: number; upper: number } {
  if (!Number.isInteger(trials) || trials < 0) {
    throw NoeticosError.invalid(
      `wilsonInterval requires a non-negative integer trials, got ${trials}`,
    );
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw NoeticosError.invalid(
      `wilsonInterval requires integer successes in [0, trials], got ${successes} of ${trials}`,
    );
  }
  if (!Number.isFinite(z) || z < 0) {
    throw NoeticosError.invalid(`wilsonInterval requires a non-negative finite z, got ${z}`);
  }
  if (trials === 0) {
    return { lower: 0, upper: 1 };
  }
  const phat = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (phat + zSquared / (2 * trials)) / denominator;
  const halfWidth =
    (z / denominator) * Math.sqrt((phat * (1 - phat)) / trials + zSquared / (4 * trials * trials));
  return {
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
  };
}

/**
 * Welch's t statistic for two independent samples with unequal variances
 * (Welch 1947), with degrees of freedom from the Welch-Satterthwaite equation
 * (Satterthwaite 1946):
 *
 *   t = (meanA - meanB) / sqrt(varA / nA + varB / nB)
 *   df = (varA / nA + varB / nB)^2 /
 *        ((varA / nA)^2 / (nA - 1) + (varB / nB)^2 / (nB - 1))
 *
 * Degenerate inputs, either sample with fewer than 2 observations or both variances
 * exactly 0, return the neutral { t: 0, df: 1 } so callers uniformly treat
 * "no evidence" and "not enough data" the same way. With the guard satisfied, df is
 * always at least min(nA, nB) - 1 >= 1, so the result is safe to feed into
 * {@link tTailAbove}.
 *
 * @param meanA Sample mean of group A.
 * @param varA Sample variance of group A, non-negative.
 * @param nA Sample size of group A.
 * @param meanB Sample mean of group B.
 * @param varB Sample variance of group B, non-negative.
 * @param nB Sample size of group B.
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when arguments are out of domain.
 */
export function welchT(
  meanA: number,
  varA: number,
  nA: number,
  meanB: number,
  varB: number,
  nB: number,
): { t: number; df: number } {
  if (!Number.isFinite(meanA) || !Number.isFinite(meanB)) {
    throw NoeticosError.invalid('welchT requires finite means');
  }
  if (!Number.isFinite(varA) || varA < 0 || !Number.isFinite(varB) || varB < 0) {
    throw NoeticosError.invalid('welchT requires non-negative finite variances');
  }
  if (!Number.isFinite(nA) || !Number.isFinite(nB)) {
    throw NoeticosError.invalid('welchT requires finite sample sizes');
  }
  if (nA < 2 || nB < 2 || (varA === 0 && varB === 0)) {
    return { t: 0, df: 1 };
  }
  const squaredErrorA = varA / nA;
  const squaredErrorB = varB / nB;
  const pooled = squaredErrorA + squaredErrorB;
  const t = (meanA - meanB) / Math.sqrt(pooled);
  const df =
    (pooled * pooled) /
    ((squaredErrorA * squaredErrorA) / (nA - 1) + (squaredErrorB * squaredErrorB) / (nB - 1));
  return { t, df };
}

/**
 * One-sided critical value of the Student t distribution: the smallest t with
 * tTailAbove(t, df) <= alpha.
 *
 * Solved by bisection over the exact tail of {@link tTailAbove}, which is strictly
 * decreasing in t, so the result inverts the exact CDF to full double precision
 * (80 halvings of the bracket).
 *
 * @param alpha Tail probability in (0, 1).
 * @param df Degrees of freedom, finite and strictly positive.
 * @returns The smallest t at which the exact tail drops to alpha, 0 when even
 *   t = 0 already satisfies it (alpha >= 0.5).
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when arguments are out of domain.
 */
export function tCriticalAbove(alpha: number, df: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw NoeticosError.invalid(`tCriticalAbove requires alpha in (0, 1), got ${alpha}`);
  }
  if (!Number.isFinite(df) || df <= 0) {
    throw NoeticosError.invalid(`tCriticalAbove requires finite df > 0, got ${df}`);
  }
  if (tTailAbove(0, df) <= alpha) {
    return 0;
  }
  let low = 0;
  let high = 1;
  while (tTailAbove(high, df) > alpha && high < 1e9) {
    high *= 2;
  }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    if (tTailAbove(mid, df) > alpha) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high;
}

/**
 * Exact one-sided upper tail of the Student t distribution: P(T >= t) for T with
 * `df` degrees of freedom.
 *
 * Uses the classical identity (Abramowitz and Stegun 1964, Section 26.7)
 *
 *   P(T >= t) = I_x(df / 2, 1 / 2) / 2   with   x = df / (df + t^2),   for t >= 0
 *
 * and symmetry P(T >= t) = 1 - P(T >= -t) for negative t, with the regularized
 * incomplete beta evaluated by continued fraction to double precision. A previous
 * release approximated this tail with a deflated normal tail documented as
 * conservative; it in fact underestimated the true tail by factors of 5 to 15 at
 * low degrees of freedom (for example reporting 0.19x the exact value at df = 7,
 * t = 3.0), silently overspending the promotion alpha. The exact tail restores the
 * documented guarantee: a promotion gate consuming this p spends exactly its alpha.
 *
 * @param t Welch t statistic, any finite number.
 * @param df Degrees of freedom, finite and strictly positive.
 * @returns The exact tail probability in [0, 1].
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when arguments are out of domain.
 */
export function tTailAbove(t: number, df: number): number {
  if (!Number.isFinite(t)) {
    throw NoeticosError.invalid(`tTailAbove requires a finite t, got ${t}`);
  }
  if (!Number.isFinite(df) || df <= 0) {
    throw NoeticosError.invalid(`tTailAbove requires finite df > 0, got ${df}`);
  }
  const x = df / (df + t * t);
  const halfTail = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
  const tail = t >= 0 ? halfTail : 1 - halfTail;
  return Math.min(1, Math.max(0, tail));
}
