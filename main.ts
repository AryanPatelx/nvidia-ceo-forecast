// make.fun entry: polymarket-nvidia-ceo-forecast-01
// Forecasts the Yes price of every market of Polymarket's "Next CEO of NVIDIA?" event for the 240
// minutes after each checkpoint, as five quantiles per minute (5/25/50/75/95%).
//
// Method: the fan around the current price comes from empirical quantiles of realised moves, pooled
// across all markets of the case in a vol-normalised z-space (each origin scaled by its own recent
// activity), split by price level (leaders behave differently from longshots). The median adds a
// small drift path: reversion after fresh spikes and a board-sum pull (when the sum of all Yes
// prices is inflated, every market bleeds toward its share of the target board). Per-market raw
// move quantiles are blended in with a small weight.
//
// Everything is computed from the case's own prices: offline, deterministic, no model calls.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecastCase, QUANTILES } from './forecast.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  }
  const fc = forecastCase(c);
  const forecasts = c.markets.map((m) => {
    const q = fc.get(m.id);
    if (!q || q.length !== c.horizon_minutes) throw new Error(`${file}: no forecast for ${m.id}`);
    return { id: m.id, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
