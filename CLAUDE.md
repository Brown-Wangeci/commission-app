# CLAUDE.md

Rules for working on the ML fraud-detection component of this capstone
project. These apply to every future session in this repository.

- Every generator parameter lives in `config/generator.yaml`. Modelling
  parameters (splitting, resampling, decision bands) live in
  `config/model.yaml`. Never hardcode a number inside a module. Each
  parameter gets a comment stating its source: "spec" (fixed by the project
  specification), "literature", "industry partner", or "assumption".
- No parameter that differs between legitimate and fraudulent activations
  may be a deterministic separator: no hard caps, no exact 0.0, no exact
  1.0. Every such parameter is a distribution with genuine spread and
  support that overlaps the other class. Bounds are permitted only as
  physical limits (a distance cannot be negative).
- Every fraud signature must have a legitimate counterpart that overlaps
  it. No feature may separate the classes cleanly on its own.
- A missing counterpart counts as real only if it is stable across
  realisations. The lookalike audit runs on every seed in
  `diagnostics.robustness_seeds`, and a signature is a defect only when it is
  flagged at every seed. A flag that appears at one seed and not others is
  noise and must not be fixed.
- Every reported number is a mean across those seeds, with the seed-level
  spread. Fold-level variation is secondary and understates uncertainty:
  `StratifiedGroupKFold` orders groups by size, so fold 0 always carries the
  heaviest agents and the folds are not exchangeable. Say so wherever a fold
  standard deviation appears.
- Never invent a statistic, empirical rate, or citation. If a value is
  needed and unknown, add it to config as an assumption and tell me.
- No feature may be computed from the label or from any hidden generator
  variable. Feature code sees only the observable event log.
- Features are split into two sets: T0 features, available the moment an
  activation is submitted, and T7 features, available seven days later.
- Train/test splits are grouped by agent AND ordered by time. Never random
  row splits.
- SMOTE or any resampling applies to the training split only, after
  splitting.
- Fixed random seed, recorded in a run manifest with the config hash.
- Short functions, type hints, plain readable code. No emoji anywhere.
- Work in phases. Stop at the end of each phase and wait for my review.
