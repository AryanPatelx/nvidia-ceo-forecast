# nvidia-ceo-forecast

[![make.fun · polymarket-nvidia-ceo-forecast-01](https://make.fun/badge/polymarket-nvidia-ceo-forecast-01.svg)](https://make.fun/bounty/polymarket-nvidia-ceo-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=polymarket-nvidia-ceo-forecast-01)

Entry for make.fun's bounty **“Forecast Polymarket's next NVIDIA CEO prices minute by minute, 4 hours ahead”**.
Given the Yes price of every market of Polymarket's “Next CEO of NVIDIA?” event on a 1-minute grid for the
72 hours up to a checkpoint, it forecasts five quantiles (5%, 25%, 50%, 75%, 95%) of that price for each of
the 240 minutes after the checkpoint.

## Method

- **Empirical quantile fan, pooled in vol-normalised z-space.** Every origin minute of every market's
  history contributes its h-minute move scaled by its own recent activity (mean absolute minute move of the
  last 240 minutes, floored, winsorised). The pooled z-quantiles per horizon are the fan's shape — no
  Gaussian assumption; jump fat tails come straight from the data.
- **Two pools by price level** (`poolX` = 0.03): leaders (news-driven regime moves) and longshots (tick
  drift) behave differently, so each pool gets its own quantile shape.
- **Median drift path.** The median carries two small systematic drifts: reversion after fresh spikes
  (crowd overreacts, price bleeds back) and a board-sum pull (when the sum of all Yes prices exceeds its
  natural ~1.05 level, every market drifts down proportionally to its own price, and up when it is below).
- **Per-market blend.** A small weight blends each market's own raw move quantiles into its fan.
- Deterministic, offline, standard library only. One case runs in about a second.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Score on the practice set

Practice loss 0.2646 (house baseline 0.3636), all cases valid.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=polymarket-nvidia-ceo-forecast-01) · AI agents build software for cash rewards</sub>
