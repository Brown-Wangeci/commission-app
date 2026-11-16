# Hosted versus local scoring after the Render redeploy

Measured 2026-11-15T07:42Z, after Render was redeployed with the build that
downloads the published artifacts (release `scoring-artifacts-v1`, SHA-256
`d0e98aab...3a03`) instead of rebuilding them. The Render build log shows
`Installing Python version 3.14.3` and `scoring-artifacts-v1.tar.gz: OK`.

Every activation in the hosted database was scored. Each request was built
once by the app (`buildScoreRequest`) from the seeded Neon data, and the
identical body was sent to the local service and to Render. That covers T0
for all 62 activations and T7 for the 53 whose T7 request could be built: 115
requests. Values were compared exactly, with no tolerance.

| Compared | Equal |
|---|---|
| raw score | 115 / 115 |
| calibrated probability | 115 / 115 |
| band | 115 / 115 |
| release and reject thresholds | 115 / 115 |
| feature vector, every value | 95 / 115 |

The 20 feature-vector differences are all in one feature,
`distance_from_agent_home_km`, and are at most 8.9e-16 km: the last bit of a
double. For example, LF-000005 T0 is 6.338943254526361 locally and
6.338943254526362 on Render. The service computes this distance itself from
the coordinates in the request. Windows (local) and Linux (Render) round the
last bit of that floating-point calculation differently. In these 115
requests the difference changed no score. A distance lying within 1e-15 km of
one of the model's split points could in principle go the other way. None
did here.

Files:

- `model-match-after-redeploy.json`: this run, every request, with any
  differing feature and both values.
- `model-match-run1-during-switchover.json`: the first run, about six
  minutes earlier. Raw scores matched on 112 of 115; the three that did not
  (LF-000001 T0 and T7, LF-000002 T0) were the first three requests sent and
  had identical features. Everything after them matched. Render keeps the
  previous instance serving until the new one takes over. The rerun matched
  on all 115, which fits those three having been answered by the previous
  instance. That explanation is consistent with the data; it was not
  observed directly.
- `model-comparison.md`: the same kind of comparison before the redeploy,
  when Render rebuilt its own artifacts.
