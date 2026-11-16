# Hosted versus local scoring model, same requests

Measured 2026-11-15. Each T0 request was built once by the app
(`buildScoreRequest`) from the seeded Neon data. The identical body was sent to
the local service (repository `artifacts/`, built 2026-09-16 on Windows,
Python 3.14.3) and to the Render service (artifacts rebuilt by its build
command on Linux; its Python version is not recorded).

Both report `t0_none-isotonic-v1` and the same thresholds: release 0.301471,
reject 0.729167. The generator config hash of the local artifacts
(`e42117cd...`) equals the hash of the current `config/generator.yaml`, so
the local artifacts are not stale.

| Activation | Local band | Local probability | Render band | Render probability | Difference | Features identical | Raw local | Raw Render |
|---|---|---|---|---|---|---|---|---|
| LF-000048 | review | 0.398438 | review | 0.375000 | -0.023438 | no | 0.418675 | 0.437303 |
| LF-000050 | review | 0.493976 | review | 0.596154 | +0.102178 | yes | 0.515387 | 0.564922 |
| LF-000052 | auto_release | 0.133929 | auto_release | 0.139610 | +0.005682 | yes | 0.172149 | 0.169726 |
| LF-000053 | reject | 0.747368 | reject | 0.730769 | -0.016599 | yes | 0.651131 | 0.708846 |
| LF-000054 | reject | 0.747368 | **review** | 0.724771 | -0.022598 | yes | 0.646521 | 0.689263 |
| LF-000056 | auto_release | 0.240143 | auto_release | 0.198653 | -0.041490 | no | 0.234428 | 0.236561 |
| LF-000057 | auto_release | 0.001000 | auto_release | 0.001000 | 0.000000 | yes | 0.002689 | 0.002665 |
| LF-000060 | auto_release | 0.005112 | auto_release | 0.005068 | -0.000045 | yes | 0.008322 | 0.006951 |

Raw scores differ even where the feature vectors are identical. The two
services therefore hold different trained models under the same version
label. One of the eight requests (LF-000054) gets a different band.

## What is established about the cause

Experiments on 2026-11-15, each run in an isolated `git worktree` of `main`
so that the repository's own `data/` and `artifacts/` were never written.

| Question | Result | How it was measured |
|---|---|---|
| Are the local artifacts reproducible from the code? | **Yes.** On the same Windows machine (Python 3.14.3, 12 cores, the pinned requirements), regenerating the dataset and rebuilding both artifacts gave all six dataset tables with identical content. `model.json` and `calibrator.pkl` were byte-identical for both T7 and T0. The manifests differ only in timestamps and in wording added by later code. | `python -m src.generator.run`, then both `python -m src.serve.artifact` commands, compared table by table (`DataFrame.equals`) and by SHA-256. |
| Does the XGBoost thread count change the model? | **Yes.** With only `xgboost.n_jobs` changed from `-1` (all 12 cores) to `1`, both models differ from the first tree on. T7 tree 0 `base_weights[0]` was -0.0008781446 against -0.002052274. Training seed (1778582849), chosen hyperparameters and dataset were the same. | Same worktree, `config/model.yaml` edited there only. |
| Settings involved | `tree_method: "hist"` and `n_jobs: -1` in `config/model.yaml`. `-1` means "all CPUs the machine has", so the thread count, and with it the model, depends on the build machine. | Read from `config/model.yaml` and `src/train/models.py`. |
| Library versions | Pinned in `requirements.txt` (numpy 2.5.3, pandas 3.0.5, scikit-learn 1.9.1, xgboost 3.4.1). The local environment matches the pins. Render installs from the same file. | `requirements.txt`; versions printed by the local venv. |
| Was the Render dataset identical to the local one? | **Not measured.** Render's build output is not accessible from here. | |
| Render's Python version | **3.14.3, the same patch as the local build.** So the Python version did not cause the difference. | The Render build log line `Installing Python version 3.14.3...`, read by the project owner on 2026-11-15. |
| Render's CPU count | **Not recorded.** | |
| Does Linux differ from Windows at the same thread count? | **Not measured.** A Linux build was prepared (WSL Ubuntu 24.04, Python 3.14.3 and 3.14.10 via a throwaway `uv`) but was not run. | |

So the build is reproducible on one machine but depends on how many threads
train it. A machine with a different core count, such as Render's instance,
trains a different model from the same data, seed and hyperparameters.
The Python version is ruled out, since Render used 3.14.3 as the local build did.
Whether the platform adds a further difference at the same thread count was
not measured.

After the redeploy, the published artifacts give identical scores on Render
and locally: `model-match-after-redeploy.md`.

The remedy taken is to stop rebuilding on the server. The Render build now
downloads the published local artifacts (`scoring-artifacts-v1`) and checks
their SHA-256 (render.yaml).
