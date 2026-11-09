# Commission-app: activation-fraud scoring

## 1. What this is

Field agents earn a commission each time they sign up a new customer for a
mobile money service, and the platform holds that commission in escrow. This
project is a system that decides what happens to each held commission: pay it
out automatically (auto-release), hold it for a person to check (review), or
refuse it (reject). It decides twice for every sign-up: once the moment the
agent submits it, and again seven days later, when the platform can see
whether the customer actually used the service. Everything in it is built and
tested on made-up data, because no real records with confirmed fraud were
available.

## 2. Status

| Part | State |
|---|---|
| Synthetic data generator and its checks | Complete |
| Fraud-scoring models (submission-time and seven-day) | Complete |
| Decision bands derived from a cost matrix | Complete |
| Scoring service (HTTP interface, stored decisions, plain-language reasons) | Complete |
| Reproduction script and results index | Complete |
| Written report (capstone write-up) | In progress |
| Expert plausibility review of the synthetic data assumptions | Outstanding; nobody with domain experience has yet checked whether the generated behaviour is realistic |

Nothing here has been validated against real agents, real customers or real
fraud. See section 9 before drawing any conclusion from the results.

## 3. How it works

**What the system looks at.** Only recorded behaviour: when a job was assigned,
accepted and submitted; which device and network it came from; where the agent
was; how new the SIM card was; how many activations the agent and the device
have recently made; and, at the seven-day decision, how the customer used the
service during the first week. It is never shown whether an activation was
really fraudulent, and it never sees any hidden variable from the data
generator (`docs/data_dictionary.md`, section 5).

**Two decision points.** The submission-time decision uses only what is known
at submission. The hold-close decision, seven days later, adds the customer's
first week of activity. The two are separate models and can disagree. This
matters because an activation released at submission has already been paid by
the time the second decision is made.

**Three bands.** At each decision point the model gives a probability that the
activation is fraudulent. A probability at or below the lower threshold is
auto-released, one above the upper threshold is rejected, and anything between
goes to a human reviewer.

**Where the thresholds come from.** They are not picked by eye. Every kind of
mistake is given a cost in units of one agent commission: paying out a fraud,
refusing an honest agent, delaying an honest agent in review, and the reviewer's
time. The two thresholds are the pair that give the lowest total expected cost
over the whole dataset. Refusing an honest agent is deliberately priced as
worse than paying out one fraud; that is a stated value judgement, not a
measurement (`config/costs.yaml`).

**Why the data is synthetic.** A model needs many examples of fraud with a
certain answer attached, and no real data of that kind existed for this
project. A generator (`src/generator/`) invents the agents, customers and
activations from rules written down in `config/generator.yaml`, and every rule
there says whether its value comes from the specification, published
literature, an industry partner or an assumption. Almost all are assumptions.

**Agents have honesty types.** Honest agents never commit fraud. Opportunistic
agents commit it occasionally, more often close to a payout deadline.
Systematic agents work at high volume and sometimes belong to a coordinated
ring.

**Four fraud patterns.** Ghost activations (a customer who does not exist or
never agreed), SIM farming (bulk enrolment of freshly registered SIMs from a few
devices and places), collusion (a real customer who agrees to be signed up for
a share of the commission and never uses the service), and payout-cycle gaming
(timing ordinary work around the payout calendar).

**Every fraud signature has an honest counterpart.** For each pattern the
generator also produces honest activations that look similar: a team sharing
one sign-up tablet on a market day resembles SIM farming; a genuine customer
who signs up and never uses the service resembles a ghost. Without this, the
model would only learn to spot a quirk of how the data was built. A dedicated
audit checks for any signature with no honest counterpart, on four different
random generations, and counts it as a defect only if it is missing in all four
(`docs/data_dictionary.md`, section 7).

## 4. Key results

Every figure below is read from the committed file named beside it. If a value
here disagrees with its file, the file is right and this table is stale.
"Across seeds" means the mean over four independently generated datasets
(seeds 7, 42, 101 and 2024), with the spread between seeds in brackets.

| What | Value | Source |
|---|---|---|
| Ranking quality of the seven-day model (PR-AUC, 1.0 is perfect) | 0.712 (0.034) across seeds | `outputs/multiseed_results_summary.csv`, row `t7_none` |
| Ranking quality of the submission-time model (PR-AUC) | 0.628 (0.042) across seeds | same file, row `t0_none` |
| Share of fraud found at 90% precision, seven-day / submission-time | 0.424 / 0.328 | same file, `recall_at_p90_mean` |
| Seven-day model: released / reviewed / rejected | 93.7% / 3.0% / 3.3% of activations | `outputs/band_operating_point.csv` |
| Seven-day model: rejections that were truly fraud | 91.0% | same file, `reject_precision` |
| Seven-day model: fraud caught by rejection | 41.3% | same file, `reject_recall` |
| Seven-day model: fraud that is nonetheless auto-released | 39.7% | same file, `released_fraud_share_of_all_fraud` |
| Submission-time model: fraud auto-released | 51.6% | `outputs/band_operating_point_t0.csv`, `released_fraud_share_of_all_fraud` |
| Expected cost per activation, chosen bands vs paying everything | 0.106 vs 0.182 commissions | `outputs/band_operating_point.csv`, `outputs/band_baselines.csv` |
| Two models put an activation in the same band | 95.6% of activations | `outputs/disagreement_transition_summary.csv` (sum of the three matching rows) |
| Released at submission, then rejected at hold-close | 0.172% of activations; two thirds of those were fraud | `outputs/disagreement_release_then_reject_summary.csv` |

What the model does badly:

| What | Value | Source |
|---|---|---|
| Fraud found at 90% precision: SIM farming | 0.832 | `outputs/typology_recall_summary.csv` |
| Fraud found at 90% precision: collusion | 0.123 | same file |
| Genuine work refused, honest agents vs systematic agents | 0.127% vs 1.469% | `outputs/fairness_bands_by_honesty.csv` |
| Genuine work auto-released, honest vs systematic agents | 99.1% vs 90.8% | same file |
| Commission value at which the review band disappears | empty at KSh 40 or below, open from KSh 50; the assumed value is KSh 81.34 | `outputs/commission_collapse_point.csv` |

The per-pattern rows come from the single-seed cross-validation of the
SMOTE variant (`xgb_t7_smote`), not from the deployed model, and their spread
is fold-to-fold. Fold-to-fold spread understates the real uncertainty, because
the folds are ordered by agent size and are not interchangeable. Read them as
a ranking of which patterns are hard, not as precise rates. The complete map of
every reported number to its file is `docs/results_index.md`.

## 5. Quick start

**You need first:** Python 3.14 (developed and tested on 3.14.3; other versions
are untested) and git. The steps below were run from a clean copy of the
repository on Windows 11. On Windows, clone close to the drive root, for
example `C:\src`: in testing, installing into a deeply nested folder failed with
"filename too long".

Install (several minutes, mostly the dependency download):

```
git clone https://github.com/Brown-Wangeci/commission-app.git
cd commission-app
python -m venv .venv
.venv\Scripts\Activate.ps1          # Windows PowerShell
# .venv\Scripts\activate.bat        # Windows cmd
# source .venv/bin/activate         # macOS or Linux
pip install -r requirements.txt
```

The data and the trained models are not stored in git, so build them once
(a couple of minutes in total):

```
python -m src.generator.run
python -m src.serve.artifact
python -m src.serve.artifact t0_none t0_none-isotonic-v1
```

Start the service and leave it running in this terminal. It prints
`Uvicorn running on http://127.0.0.1:8000` when it is ready:

```
python -m src.serve.app
```

In a second terminal (activate the virtual environment again), send one
activation to both decision points:

```
python scripts/score_example.py
```

It scores `act_0001185` twice, at submission and at hold-close, prints the band,
probability and the top three reasons each time, then asks the service for the
stored history. For this activation you should see it auto-released at
submission and sent to review at hold-close. That is the case where the payout
has already been made before the second decision. Pass another activation id to
try a different one, for example `python scripts/score_example.py act_0000005`,
an ordinary genuine sign-up that is released both times. The expected bands for
five such activations are asserted in `tests/test_curated_records.py`, with the
records and their true labels in `tests/fixtures/curated_records.json`. That test
records the generator config hash the records were picked from and fails with a
clear message if `data/` was generated from a different config.

The service's own interactive documentation is at
`http://127.0.0.1:8000/docs` while it runs. Stop the service (Ctrl+C) before
running the tests with `python -m pytest -q`, which finish in well under a minute and
reset the stored-decisions database.

The service has no authentication and is a prototype, not something to expose
to a network.

## 6. Reproducing the results

`scripts/reproduce_all.py` re-runs the whole pipeline in dependency order,
times each step, and rewrites every file under `outputs/`.

```
python scripts/reproduce_all.py --list-stages      # names of the stages
python scripts/reproduce_all.py --dry-run          # print the plan, run nothing
python scripts/reproduce_all.py                    # everything
python scripts/reproduce_all.py --stage figures    # one stage
python scripts/reproduce_all.py --stage bands --stage figures
python scripts/reproduce_all.py --seed 101         # different seed for the single dataset
python scripts/reproduce_all.py --tolerance 0.05   # looser comparison, default 0.02
```

Stages run in the order below whatever order the flags are given in. Before
running anything, the script checks for input files that git does not carry
(the generated dataset in `data/`, and the four-seed predictions in
`outputs/`). If one is missing and no earlier selected stage will write it, the
script exits with status 2, names the file and prints the command that creates
it, for example `python scripts/reproduce_all.py --stage multiseed`.

| Stage | What it does | Wall-clock time | Source of the time |
|---|---|---|---|
| `generate` | Builds the single seed-42 dataset used for training and the service | unverified, roughly seconds | none: one informal measurement, not recorded in any file |
| `diagnostics` | Dataset checks and the honest-counterpart audit, on four seeds | unverified, roughly minutes | none: earlier measurement carried over from the previous README, no source file |
| `train` | Single-seed cross-validated models and the resampling comparison | unverified, several hours | none: earlier measurement carried over from the previous README, no source file |
| `multiseed` | The four-seed run behind every headline number | 1795 s | `outputs/reproduce_manifest.json`, `stage_seconds` |
| `calibrate` | Checks that probabilities mean what they say | 4.1 s | same |
| `bands` | Cost matrix, thresholds, fairness, explanations, model disagreement | 47.3 s | same |
| `figures` | Charts | 9.1 s | same |

`outputs/reproduce_manifest.json` records only the latest invocation of the
script, so it currently covers only the last four stages. The times for
`generate`, `diagnostics` and `train` have no committed source, and no total is
given for a full run. Regenerating the manifest with a full
`python scripts/reproduce_all.py` run would replace the unverified rows with
recorded ones.
**What it verifies.** Before running, it reads a fixed set of headline numbers
from the results files already on disk: PR-AUC by model, both models' band
thresholds and expected cost, recall by fraud pattern, and the fairness table.
After running, it compares the new values with the old ones and exits with an
error, naming each number, if any moved by more than the tolerance. It does not
run the tests and does not rebuild the served model files.

Two files are not byte-identical on a rerun, and this is expected: the
resampling sweep moves at the fifth or sixth significant digit from
floating-point ordering. See `docs/results_index.md`, "Known stale or
conflicting values".

**What a fresh clone can run.** `figures` works on its own (it reads the
committed results files). `generate`, `diagnostics` and `multiseed` need no
earlier stage, `train` needs `generate`, and `calibrate` and `bands` need
`multiseed`, because the four-seed predictions they read are not committed.
After a cost change on a fresh clone, run `multiseed`, `calibrate`, `bands` and
`figures` together in one command.
## 7. Repository layout

| Directory | What is there | Who cares |
|---|---|---|
| `config/` | Every tunable number, each with a source tag; see section 8 | Anyone changing an assumption |
| `src/generator/` | The synthetic data generator and the feature calculations | Developer; supervisor for the data assumptions |
| `src/train/` | Model training, cross-validation, resampling comparison, the four-seed run | Developer |
| `src/eval/` | Metrics, calibration, cost and band optimisation, fairness, explanations, figures | Developer; supervisor for how results are made |
| `src/serve/` | The scoring service, model loading, plain-language reasons, stored decisions | Developer; anyone integrating with it |
| `scripts/` | `reproduce_all.py`, `smoke_test_service.py`, `score_example.py` | Anyone running or demonstrating the project |
| `tests/` | Automated tests, including the five curated records in `tests/fixtures/` | Developer |
| `outputs/` | Every committed results table and manifest; large files here are not committed | Supervisor for results; developer for provenance |
| `artifacts/` | The two served models; only their `manifest.json` files are committed | Developer |
| `data/` | The generated dataset; empty in git, filled by `python -m src.generator.run` | Developer |
| `docs/` | Model card, results index, data dictionary, Phase 4 change log | Supervisor and developer |
| `notebooks/` | The four numbered notebooks that present the results | Supervisor |

`CLAUDE.md` at the top level holds the working rules for this project (no
hardcoded parameters, no feature that separates the classes on its own, grouped
and time-ordered splits, fixed seeds).

## 8. Configuration

| File | What it controls |
|---|---|
| `config/generator.yaml` | The synthetic world: population, honest behaviour, the four fraud patterns, honest lookalikes, feature windows and the data seed |
| `config/model.yaml` | How models are evaluated and trained: splits, the four seeds, model settings, calibration and the settings of the band search |
| `config/costs.yaml` | The cost matrix, the reviewer wage and time, the assumed value of a commission and the review staffing |
| `config/serving.yaml` | The served model versions, the probability clip, host and port, and how many reasons are returned |
| `config/reason_phrases.yaml` | The plain-language sentence for each feature, used in the reasons |

Every value carries a comment giving its source (`spec`, `literature`,
`industry partner` or `assumption`).

**Warning: changing a cost parameter or a threshold invalidates the committed
results until `scripts/reproduce_all.py` is rerun.** The two decision
thresholds are not stored in any config file. They are computed from
`config/costs.yaml` by the `bands` stage, written to
`outputs/band_operating_point.csv` and `outputs/band_operating_point_t0.csv`,
and copied into each served model's `manifest.json` when it is built. After any
change to `config/costs.yaml`:

1. Rerun `python scripts/reproduce_all.py --stage bands --stage figures`
   (needs `outputs/multiseed_predictions.parquet`; see section 6).
2. Rebuild both served models with the two `python -m src.serve.artifact`
   commands from section 5, so the service picks up the new thresholds.
3. Update by hand `docs/model_card.md` and `docs/results_index.md`, which do
   not update themselves, and the table in section 4 of this file.

Editing a threshold directly in a CSV or a manifest breaks the link between the
thresholds and the costs that justify them. Changing `config/generator.yaml`
changes the data itself, so every stage must be rerun.

## 9. Limitations

- **All data is synthetic.** No real activation, agent or fraud case was used
  anywhere. The fraud rate, the mix of fraud patterns and every behaviour are
  set to make a defensible learning problem, not fitted to observed fraud, and
  almost every generator value is tagged as an assumption. The results say how
  the method behaves on this generated world, not how it would behave on a real
  platform.
- **The three-band design rests on an unsourced number.** The cost of a review
  is computed from the reviewer's wage and the shilling value of one
  commission, and that value (KSh 81.34) comes from the generator's assumed
  escrow amounts, not from an operator. The sweep in
  `outputs/commission_collapse_point.csv` shows the review band vanishing at
  about half that value, at which point the sensible design is two bands, not
  three. This is the one number to obtain before relying on the bands.
- **Genuine work by high-volume agents is held or refused more often.** The
  gap is about elevenfold for refusals (`outputs/fairness_bands_by_honesty.csv`).
  The cost-model correction lowered every group's refusal rate but did not
  close the gap. The patterns that make a busy agent efficient, such as shared
  devices and batches of accepted jobs, are also what a fraud ring looks like,
  and the model cannot tell the two explanations apart from behaviour alone.
- **Collusion is close to undetectable at submission.** A colluding customer is
  real and the meeting happened, so the submission looks ordinary. Recall for
  collusion is the lowest of the four patterns
  (`outputs/typology_recall_summary.csv`), and the customer-behaviour feature
  that best separates it from an honest customer who simply lapses is only
  slightly better than a coin flip (`outputs/collusion_overlap.csv`,
  `customer_active_days_7d`, `auc_vs_trial_lapse` about 0.59).
- **The two models can disagree, and a release at submission is money already
  paid.** They use different information, are scored at different times and have
  separately chosen thresholds. A submission-time release followed by a
  hold-close rejection identifies a fraud that has already been paid. It is
  rare but not zero (section 4). The service does not prevent it; `GET
  /explain/{activation_id}` returns both decisions in time order so a dispute
  review can see it.
- **Trailing-window features depend on the history the caller sends.** Counts
  such as recent activations by the same agent or device are computed from
  whatever recent history is supplied with the request, and the service does not
  check that it is complete. Incomplete history understates them.
- **Served models have no held-out score of their own.** Each is fitted on the
  full seed-42 dataset. The performance figures in section 4 come from a
  separate cross-validated run on four datasets (`docs/model_card.md`).

## 10. Where to read more

| Document | What it is for |
|---|---|
| `docs/model_card.md` | What each served model is, its settings, thresholds, cost matrix and full list of limitations |
| `docs/results_index.md` | Every reported number mapped to the file and phase that produced it |
| `docs/data_dictionary.md` | The label, the raw event fields, every feature, the four fraud patterns and their honest counterparts |
| `docs/change_log_phase4.md` | Two generator defects found and fixed in Phase 4, with predictions made before the fix and how they turned out |
| `notebooks/01_generation_checks.ipynb` | Checks on the generated dataset: class mix, single-feature separability, a plain baseline |
| `notebooks/02_model_results.ipynb` | Model comparison and what the Phase 4 generator fixes changed |
| `notebooks/03_calibration_bands_and_fairness.ipynb` | Calibration, the derivation of the bands, explanations and the fairness analysis |
| `notebooks/04_model_disagreement.ipynb` | How often the submission-time and hold-close models disagree, and what it costs |
