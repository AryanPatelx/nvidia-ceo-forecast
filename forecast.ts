// Quantile fan from pooled, vol-normalised empirical moves. Pure function of the case.

export interface CaseMarket {
  id: string;
  name: string;
  prices: number[];
}

export interface Case {
  horizon_minutes: number;
  markets: CaseMarket[];
}

// ---- tunables ----
export const P = {
  stride: 3,          // sample every k-th origin minute for the empirical pool
  shortWin: 240,       // local activity window (minutes) for s_t
  recentWin: 360,     // recency emphasis for per-market blend
  perMktW: 0.5,       // (legacy) weight on per-market quantile vs pooled
  medW: 0.1,          // per-market weight for the median
  tailW: 0.3,         // per-market weight for the outer quantiles
  tailHiX: 1,         // x threshold above which tailHiAdd is added to tailW (1 = off)
  tailHiAdd: 0,       // extra per-market weight for leaders' tails
  floorS: 0.0004,     // floor on local scale
  hExp: 0.5,          // horizon exponent (0.5 = sqrt)
  hGrow: 0,         // extra widening: s(h) = s * h^hExp * (1 + hGrow*h/240)
  reversion: 0,     // median pull toward recent mean
  revL: 60,
  revK: 60,           // recent-mean window
  boardPull: 0,     // board-sum reversion strength
  boardTarget: 1.05,
  poolHalf: 0,        // recency half-life (minutes) for pooled origins; 0 = none
  mktHalf: 0,         // recency half-life for per-market origins; 0 = none
  // drift terms (price units at h=240 unless noted), each shaped by (1 - exp(-h/tau))
  kBoard: 0,          // x (S - target) at h=240
  kBoardRel: -2,       // proportional board pull: x * (S/target - 1) at h=240
  kSpike: -0.15,          // x - min(last 6h), reversion down
  kSlopeUp: 0,        // slope360 > 0 reverts
  kSlopeDn: 0,        // slope360 < 0 continues
  kMomUp: 0,          // slope60 > 0 reverts
  kMomDn: 0,          // slope60 < 0 continues
  tauBoard: 300,
  tauSpike: 90,
  tauSlope: 120,
  tauMom: 90,
  spikeMin: 0.005,    // spike threshold
  slopeSat: 0.02,     // saturation for slope360
  momSat: 0.01,       // saturation for slope60
  zMax: 12,           // winsorize pooled z per origin
  sCap: 0.008,        // cap on the blended local scale
  poolX: 0.03,           // split pooled fans by origin level: big (x > poolX) vs small (1 = off)
  relCap: 0,          // level-relative cap: sCap = max(sCap, relCap * x)
  mktWin: 720,       // per-market fan window (minutes of history used)
  overlapStride: 1,   // 1 = per-market origins stride >= h/2 (near-independent windows)
};

export const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

function quantileSorted(sorted: number[], tau: number): number {
  if (sorted.length === 0) return NaN;
  const pos = tau * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function weightedQuantile(pairs: [number, number][], tau: number): number {
  // pairs: [value, weight]; pairs sorted by value
  if (pairs.length === 0) return NaN;
  let tot = 0;
  for (const [, w] of pairs) tot += w;
  const target = tau * tot;
  let acc = 0;
  for (let i = 0; i < pairs.length; i++) {
    acc += pairs[i][1];
    if (acc >= target) return pairs[i][0];
  }
  return pairs[pairs.length - 1][0];
}

const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** Robust local activity scale: mean |r| of the last `win` minutes, floored. */
function localScale(prices: number[], win: number, floor: number): number {
  const n = prices.length;
  const from = Math.max(1, n - win);
  let sum = 0, cnt = 0;
  for (let i = from; i < n; i++) {
    const r = Math.abs(prices[i] - prices[i - 1]);
    if (Number.isFinite(r)) { sum += r; cnt++; }
  }
  const mean = cnt > 0 ? sum / cnt : 0;
  return Math.max(mean * 1.25, floor);
}

/** Build pooled z-quantiles per horizon across all markets of the case. */
function pooledFans(markets: CaseMarket[], horizons: number[], nNow: number): number[][][][] {
  // pools[h][slot] = array of [z, weight]; slot 0 = small markets, 1 = big (x > poolX)
  const pools: [number, number][][][] = horizons.map(() => [[], []]);
  for (const m of markets) {
    const p = m.prices;
    const n = p.length;
    for (let t = P.shortWin; t + horizons[horizons.length - 1] < n; t += P.stride) {
      const s = localScale(p.slice(Math.max(0, t - P.shortWin), t + 1), P.shortWin, P.floorS);
      let w = 1;
      if (P.poolHalf > 0) {
        const age = nNow - (n - t); // minutes before the checkpoint of origin t
        w = Math.pow(0.5, age / P.poolHalf);
      }
      if (w < 1e-4) continue;
      for (let hi = 0; hi < horizons.length; hi++) {
        const h = horizons[hi];
        let z = (p[t + h] - p[t]) / s;
        if (!Number.isFinite(z)) continue;
        if (z > P.zMax) z = P.zMax; else if (z < -P.zMax) z = -P.zMax;
        const slot = p[t] > P.poolX ? 1 : 0;
        pools[hi][slot].push([z, w]);
      }
    }
  }
  return pools.map(slots => slots.map(pool => {
    pool.sort((a, b) => a[0] - b[0]);
    return QUANTILES.map(tau => weightedQuantile(pool, tau));
  }));
}

/** Per-market empirical quantiles of raw moves per horizon (its own history). */
function marketFan(p: number[], horizons: number[], nNow: number): number[][] {
  const rows = horizons.map(() => [NaN, NaN, NaN, NaN, NaN]);
  const n = p.length;
  const from = P.mktWin > 0 ? Math.max(0, n - P.mktWin) : 0;
  for (let hi = 0; hi < horizons.length; hi++) {
    const h = horizons[hi];
    const st = P.overlapStride ? Math.max(P.stride, Math.ceil(h / 2)) : P.stride;
    const pairs: [number, number][] = [];
    for (let t = from; t + h < n; t += st) {
      const d = p[t + h] - p[t];
      if (!Number.isFinite(d)) continue;
      let w = 1;
      if (P.mktHalf > 0) {
        const age = nNow - (n - t);
        w = Math.pow(0.5, age / P.mktHalf);
      }
      if (w < 1e-4) continue;
      pairs.push([d, w]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (let j = 0; j < 5; j++) rows[hi][j] = weightedQuantile(pairs, QUANTILES[j]);
  }
  return rows;
}

export function forecastCase(c: Case): Map<string, number[][]> {
  const H = c.horizon_minutes;
  const horizons: number[] = [];
  for (let h = 1; h <= H; h++) horizons.push(h);

  const nNowMax = Math.max(...c.markets.map(m => m.prices.length));
  const pooled = pooledFans(c.markets, horizons, nNowMax);

  // board sum at the checkpoint (markets present in the case)
  let S = 0;
  for (const m of c.markets) S += m.prices[m.prices.length - 1];

  const out = new Map<string, number[][]>();
  for (const m of c.markets) {
    const p = m.prices;
    const n = p.length;
    const x = p[n - 1];
    const s = localScale(p, P.shortWin, P.floorS);
    const sLong = localScale(p, n - 1, P.floorS);
    let sBlend = Math.max(s, Math.min(sLong, 2.5 * s)); // guard against ultra-calm last hour inside a wild day
    if (P.sCap > 0) sBlend = Math.min(sBlend, Math.max(P.sCap, P.relCap * x));

    const mf = marketFan(p, horizons, nNowMax);

    // recent mean as reversion target
    const from = Math.max(0, n - P.revK);
    let sum = 0; for (let i = from; i < n; i++) sum += p[i];
    const recent = sum / (n - from);

    // drift features at the checkpoint
    const from6h = Math.max(0, n - 360);
    let low6h = Infinity, slope360 = 0, slope60 = 0;
    for (let i = from6h; i < n; i++) if (p[i] < low6h) low6h = p[i];
    if (n - 360 >= 0) slope360 = x - p[n - 360];
    if (n - 60 >= 0) slope60 = x - p[n - 60];
    const sat = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
    slope360 = sat(slope360, P.slopeSat);
    slope60 = sat(slope60, P.momSat);
    const spike = Math.max(0, x - low6h);

    const rows: number[][] = [];
    for (let hi = 0; hi < horizons.length; hi++) {
      const h = horizons[hi];
      // pooled z-quantiles and per-market raw-move quantiles already carry the horizon scaling
      const row = [0, 0, 0, 0, 0];
      for (let j = 0; j < 5; j++) {
        const pooledZ = pooled[hi][x > P.poolX ? 1 : 0][j];
        const pm = mf[hi][j];
        let w = j === 2 ? P.medW : P.tailW;
        if (j !== 2 && x > P.tailHiX) w = Math.min(1, w + P.tailHiAdd);
        const emp = Number.isFinite(pm) ? w * pm + (1 - w) * pooledZ * sBlend : pooledZ * sBlend;
        row[j] = emp;
      }
      // additive drift path shared by every quantile
      const b = 1 - Math.exp(-h / P.tauBoard);
      const s = 1 - Math.exp(-h / P.tauSpike);
      const l = 1 - Math.exp(-h / P.tauSlope);
      const m = 1 - Math.exp(-h / P.tauMom);
      let drift = 0;
      drift += P.kBoard * (S - P.boardTarget) * b;
      if (P.kBoardRel !== 0) drift += P.kBoardRel * x * (S / P.boardTarget - 1) * b;
      if (spike > P.spikeMin) drift += P.kSpike * spike * s;
      if (x > P.poolX) {
        drift += (slope360 > 0 ? P.kSlopeUp : P.kSlopeDn) * slope360 * l;
        drift += (slope60 > 0 ? P.kMomUp : P.kMomDn) * slope60 * m;
      }
      for (let j = 0; j < 5; j++) row[j] += drift;
      for (let j = 0; j < 5; j++) row[j] = price6(x + row[j]);
      // enforce monotone
      for (let j = 1; j < 5; j++) if (row[j] < row[j - 1]) row[j] = row[j - 1];
      rows.push(row);
    }
    out.set(m.id, rows);
  }
  return out;
}
