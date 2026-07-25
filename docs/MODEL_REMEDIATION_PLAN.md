# Making the Habits, Intrusion & Future-Proofing Watchers Work Fully

**Audience:** the model team (`sentinel_fusion_ai`).
**Purpose:** the approach — root cause → target → concrete steps → acceptance test — to
take the three under-performing watchers from *"runs but doesn't really discriminate"*
to *"fully working."* This is a **plan, not a code change**. It cites the exact files
and lines that must change and the tests that prove it's fixed.
**Companion docs:** `Finspar-X-Bank-Simulator/docs/sentinel-demo-walkthrough.md` §7
(the measured symptoms) and `docs/finspark_export_spec.md` (the real-data source the
behaviour fix depends on).

---

## 0. TL;DR

| Watcher | Model | Symptom (measured) | Root cause | Shape of fix |
|---|---|---|---|---|
| **Habits** | `behaviour` (LightGBM) | Country doesn't move the score; normal logins flagged HIGH | `f_user_new_country` carries ~0 learned weight (RBA data has no clean per-user new-country→ATO signal); high band 0.1148 is too low | Give it data where new-country *for a user* correlates with account-takeover; retrain; raise the band |
| **Intrusion** | `cyber` (LightGBM) | Everything — even benign — scores `critical` | **Frozen** model with a **severity-derived leak** feature; trained attack-heavy; no cost-fitted bands | Unfreeze; drop the leak feature; retrain on a benign-realistic mix; fit bands |
| **Future-Proofing** | `quantum` (XGBoost) | Only `q_data_class` matters; algorithm & cert lifetime do nothing | (a) **Frozen**; (b) label is dominated by the data-class term; (c) **serving values don't match the trained vocabulary** | Fix the synthetic label to make all 3 factors independently move it; align serving↔train vocab; unfreeze, retrain, fit bands |

**The one sentence:** these are not bugs in the API or the bank — they are what the
models *learned* (or were frozen at). Fixing them means **fixing the training data and
labels, un-freezing, retraining, and re-calibrating the bands** — then proving it with
the contrast tests the demo already wants.

---

## 1. Why all three share one cause

The serving path is fine. Every symptom traces to **what the model was trained on**:

- The feature contract (`ml/feature_spec.py::MODEL_FEATURES`) shows the features are
  *present* — `f_user_new_country` is in `behaviour`, `q_key_exchange`/`q_cert_key_type`
  are in `quantum`. Having a feature ≠ the model having *learned to use it*.
- Two heads are explicitly **frozen** (`ml/feature_spec.py:178
  FROZEN_MODELS = {"cyber", "quantum"}`) — "byte-identical to v1 so the retrained corpus
  does not move these models." They were never re-fit against improved data.
- Bands are **fitted per model at cost-optimal thresholds** (`ml/fusion.py::fit_bands`,
  `ml/config.py::BAND_COST_RATIOS`). A model whose scores are compressed (cyber) or whose
  bands were never fitted (quantum falls back to 0.25/0.50/0.75) will mis-band.

So the destination for each is the same four-step arc — **data → unfreeze → retrain →
recalibrate → verify** — with a model-specific data fix at the front.

---

## 2. The universal fix pattern

Apply this spine to each watcher (details per-model in §3–§5):

1. **Fix the signal in the data.** Make the intended factor *independently correlate*
   with the label. If a factor is necessary-but-rare (quantum) or absent (behaviour
   new-country) or leaked (cyber), the model can't learn it honestly.
2. **Un-freeze** (cyber, quantum): remove from `FROZEN_MODELS` so the pipeline re-fits it.
   Note: this changes `CONTRACT_HASH` — intended, and the parity test
   (`tests/unit/test_feature_parity.py`) must be re-baselined.
3. **Retrain** through the existing pipeline (`ml/run_pipeline.py` / `ml/train.py`),
   which already does class weighting (`scale_pos_weight`), isotonic calibration
   (`fusion.fit_calibrator`) and band fitting (`fusion.fit_bands`).
4. **Recalibrate + re-fit bands** on a validation slice whose base rate matches reality
   (§6). This is what turns "compressed scores" into meaningful low/medium/high/critical.
5. **Verify with contrast tests** — the exact experiments in the walkthrough §7 become
   the acceptance criteria (benign→low, each factor moves the score).

---

## 3. Habits Watcher — `behaviour`

### 3.1 Root cause (evidence)
- `ml/feature_spec.py:161-168` — the raw `country` categorical was **deliberately
  removed**: it was the #1 SHAP feature (0.755) but that was *RBA corpus construction*
  (label rate 0.78 for US vs 0.10 for NO), not a real account-takeover signal, "and a
  single-country bank sees one constant value."
- The derived binary `f_user_new_country` is still a feature (via `USER_F_SERVABLE`,
  `feature_spec.py:114`), **but it never appears in the top SHAP attributions** because
  the training source (`notebooks/src/07_rba_logins.py`) is **IP-attack / ATO labeled at
  the row level**, with no clean *per-user sequence where a country change precedes a
  takeover*. The model has nothing to learn "new country ⇒ risk" from.
- Score is instead driven by `f_user_secs_since_last` and time features; and the fitted
  **high band is 0.1148** (walkthrough §7 table), low enough that an ordinary home login
  scores `high`.

### 3.2 Target
A login from a **country this user has never used**, close in time to a domestic login
(impossible travel), scores materially higher than the same user's normal login; a
normal home login scores `low`.

### 3.3 Approach
1. **Get sequence-correct, country-labeled training data.** The right source already
   exists on paper: the **FinSpark export** (`docs/finspark_export_spec.md`) supplies
   *complete per-customer login sequences with `country` and an
   `account_takeover` label*. Load it through `notebooks/src/15_finspark.py` into the
   behaviour slice so `f_user_new_country` is computed over real user histories where a
   new-country login is genuinely the takeover.
   - Interim, if the export isn't ready: **augment** the RBA slice
     (`07_rba_logins.py`) with a synthetic minority of ATO sequences — a user with N
     domestic logins, then a login from a new country flagged `is_account_takeover=1` —
     so the feature gains honest signal without waiting on the export.
2. **Keep `f_user_new_country` in `USER_F_SERVABLE`** (it's already there); do **not**
   re-introduce raw `country` (that was the spurious feature). Optionally add a
   `f_user_country_secs_since_seen`-style feature if impossible-travel timing is wanted
   as an explicit signal.
3. **Retrain** the behaviour head (`BEHAVIOUR_MODEL = "lgbm_supervised"`,
   `ml/config.py`) on the corrected slice.
4. **Re-fit the band** (§6). The current high edge (0.1148) must rise so a normal login
   lands `low`/`medium`.

### 3.4 Acceptance test (becomes `02-habits-watcher.spec.ts`'s un-`fixme`)
- Two fresh users, one domestic prior login each; a second login one second later — the
  **new-country** login scores strictly higher than the **domestic** one, across ≥5
  seeded repetitions (kills the timing-noise flakiness in walkthrough §7.4).
- `f_user_new_country` appears in the top-5 SHAP features for the new-country login.
- A normal home login scores **not** `high`.

---

## 4. Intrusion Watcher — `cyber`

### 4.1 Root cause (evidence)
- `ml/feature_spec.py:152-159` — **frozen**, "byte-identical to v1," and it "retains
  `f_device_past_hisev_count` and its **severity-derived leak** — documented, not fixed,
  because cyber is off the bank's money path." A severity-derived feature is a label
  proxy → the model leans on it and over-fires.
- Trained on intrusion corpora (`01_unsw_nb15.py`, `02_beth.py`, `03_cicids2017.py`)
  that are **attack-heavy**; with no reality-matched benign baseline and no cost-fitted
  bands, the score distribution saturates near the top. Measured: benign 800 B/443 →
  `0.9961 critical`; even a warmed host stays critical (walkthrough §7.2).

### 4.2 Target
Benign traffic (normal ports, small transfers, ordinary duration) scores `low`;
exfiltration / C2 patterns score `critical`. A judge can flip a port or byte-count and
watch the verdict change.

### 4.3 Approach
1. **Un-freeze:** remove `"cyber"` from `FROZEN_MODELS` (`feature_spec.py:178`).
2. **Remove the leak:** drop `f_device_past_hisev_count` (severity-derived) from the
   `cyber` feature list (`MODEL_FEATURES["cyber"]`, and `DEVICE_STATEFUL_F` usage for
   this head). `severity` must never reach a model as an input (it's already excluded
   from fraud/behaviour — apply the same rule here).
3. **Rebalance the corpus:** ensure a **realistic benign majority** in the cyber slice —
   down-sample attacks or up-sample benign flows from the same datasets (CICIDS2017 has
   labeled BENIGN flows; use them). Train with `scale_pos_weight` reflecting the true
   base rate rather than the corpus's inflated attack rate.
4. **Retrain + calibrate + fit bands** (§6). The goal is a *spread* distribution so the
   cost-optimal `cyber` bands (currently `medium≥0.0069, high≥0.1559, critical≥0.1837`)
   sit above a real benign cluster.

### 4.4 Acceptance test (un-`fixme` `03-intrusion-watcher.spec.ts`)
- Malicious preset (9 MB out → port 4444) → `critical`.
- Benign (≤2 KB out, port 443/80/53, normal duration) → `low` or `medium`, **never
  `critical`**.
- Same event with only `dst_port`/`bytes_out` changed flips the verdict (proves it's
  learned, not a port blocklist).

---

## 5. Future-Proofing Watcher — `quantum`

### 5.1 Root cause (evidence)
Two compounding causes:
- **Label dominated by one term.** `notebooks/src/10_quantum_synth.py:76`:
  ```python
  label_hndl = (~pqc_safe) & long_secret & (bulk_transfer | legacy_tls | weak_key)
  ```
  `long_secret` (data_class ∈ pii/financial/state_secret) is a **necessary** condition
  present in *every* positive, while the OR-group is rare (`bulk_transfer` ~5%,
  `legacy_tls` ~1.8%, `weak_key` ~1.2%). The model learns the cheap approximation
  **label ≈ long_secret** and gives `key_exchange`/cert-lifetime little weight.
- **Serving↔training vocabulary mismatch.** Training encodes `key_exchange` as
  `x25519_mlkem768 / rsa_kex / ecdhe_p256 …` and `cert_key_type` as `rsa_2048 / ecdsa_p256
  …` with a **frozen ordinal vocabulary** (`ml/features.py:17`). The bank/console sends
  `q_key_exchange: "RSA-2048"`, `q_cert_key_type: "Kyber"/"RSA"` — **none of which match
  the trained categories**, so at serving those features encode to the unknown bucket and
  carry **no signal**. Only `data_class` partially matches (`internal` → low).
- **No fitted bands:** quantum falls back to the round `0.25/0.50/0.75`
  (walkthrough §7 table), so even a corrected score won't band as intended.

### 5.2 Target
Risk moves with **all three** factors: quantum-breakable key exchange × long-lived
confidentiality data × certificate weakness/lifetime. Rotating to a PQC key exchange, or
shortening a certificate on secret data, **lowers** the score.

### 5.3 Approach
1. **Fix the synthetic label** (`10_quantum_synth.py`): make each factor independently
   move the target. Two options:
   - **Graded/soft label** — a risk *score* from a weighted Mosca-style formula
     (`w1·(non-PQC) + w2·(data sensitivity) + w3·(cert lifetime beyond 2033) +
     w4·(weak key)`), so algorithm and lifetime each shift it even when data is secret; or
   - **Balanced hard label** — raise the incidence of the OR-group among secret-data rows
     (and add secret-data-but-PQC-safe negatives) so `key_exchange` and lifetime become
     discriminative rather than swamped.
   Keep the rule interpretable and documented (it already is).
2. **Align the vocabulary end to end.** Standardize the category strings so training and
   serving agree — either normalize `q_key_exchange`/`q_cert_key_type`/`q_data_class` at
   the `/score` boundary (`service/normalize.py`) to the trained tokens (`RSA-2048 →
   rsa_2048`, `Kyber → x25519_mlkem768`, `secret → state_secret`), **or** retrain on the
   serving vocabulary. Do one; document which is canonical. Add a contract check so an
   unknown category is surfaced, not silently zeroed.
3. **Un-freeze:** remove `"quantum"` from `FROZEN_MODELS`.
4. **Retrain + calibrate + fit bands** (§6) — quantum currently has *no* fitted bands, so
   this step is mandatory, not optional.

### 5.4 Acceptance test (the `04-quantum-watcher.spec.ts` matrix, made to pass)
Holding data_class = secret:
- PQC key exchange (`x25519_mlkem768`) scores **lower** than non-PQC (RSA/ECDHE).
- Short cert (90 d) scores **lower** than long (3650 d).
- data_class internal/public → `low` regardless.
And the serving inputs the console sends map to the trained categories (no unknown bucket).

---

## 6. Recalibration & banding (shared, do last for each)

After each retrain, the head must be **calibrated then banded** — this is the step that
makes the risk levels meaningful and is where the demo's "why 0.044 is high" story comes
from:

1. `fusion.fit_calibrator(model_key, s_val, y_val)` — isotonic, maps raw model output to
   a calibrated probability comparable across heads.
2. `fusion.fit_bands(model_key, risk, y, weights)` — cost-optimal edges at
   `BAND_COST_RATIOS = {medium:60, high:20, critical:5}` (`ml/config.py:110`), fitted on a
   validation slice **whose base rate matches production** (or population-weighted). This
   is what fixes: cyber's saturation, quantum's missing bands, and behaviour's too-low
   high edge.
3. Re-run `ml/benchmark.py` to confirm the new bands don't wreck precision/recall.
4. **Persist** the refreshed `models/fusion_engine.joblib` and bump `model_version`;
   `contract_hash` changes automatically when features change.

> **Assert on the band, never the raw number** — a retrain moves every edge. All demo
> specs already do this; keep it that way.

---

## 7. Verification harness (reuse what exists)

The proof that a fix landed is that the walkthrough's `test.fixme` specs flip to passing:
- `03-intrusion-watcher.spec.ts` — benign→low contrast un-skipped.
- `04-quantum-watcher.spec.ts` — algorithm & lifetime levers un-skipped.
- `02-habits-watcher.spec.ts` — country-raises-risk un-skipped.

Plus the model-side guarantees:
- `tests/unit/test_feature_parity.py` re-baselined after any feature-list change.
- `ml/benchmark.py` shows no regression on the untouched heads (`fraud_payment`,
  `fraud_application`).
- The bank's fail-open guards (`sentinel-demo-walkthrough.md` §6.2) still prove the demo
  hits the ML model, not the heuristic.

---

## 8. Sequencing & effort

| Order | Watcher | Why this order | Relative effort |
|---|---|---|---|
| 1 | **Quantum** | Fully synthetic data we own end-to-end; label + vocab are self-contained — fastest honest win | **S–M** |
| 2 | **Cyber** | Real datasets already downloaded; fix is remove-leak + rebalance + refit | **M** |
| 3 | **Behaviour** | Best fix depends on the FinSpark export (real sequences); can be interim-augmented but the durable fix is data we don't have yet | **M–L** |

All three converge on the same retrain+recalibrate machinery, so doing them in one
pipeline pass amortizes the calibration/banding work.

---

## 9. Guardrails (do not regress what works)

- **Don't touch `fraud_payment` / `fraud_application`** — Money + the fusion Command
  Center are the two fully-working pieces (walkthrough §7.1). Un-freezing cyber/quantum
  and retraining behaviour must leave those bundles byte-stable (verify via `benchmark`).
- **`severity` is never a model input** — the cyber leak is the one place this rule is
  currently broken; fixing cyber means honoring it everywhere.
- **Vocabulary is a contract** — if you normalize at `/score` instead of retraining on
  serving tokens, make the mapping explicit and tested; an unknown category must raise,
  not silently zero.
- **Re-baseline `contract_hash` and the parity test deliberately** — a changed hash is
  the intended signal that the feature set moved, not a failure to paper over.
- **Feature-store learning** — after a behaviour retrain, flush the model's Redis store
  before re-measuring (`redis-cli FLUSHALL`), or old per-user state masks the change.

---

## 10. Definition of done

For each of the three watchers:
1. Its `test.fixme` contrast spec is un-skipped and **passes** ≥2 consecutive runs.
2. The demo console's contrast beat works live (benign→low; each factor moves the score).
3. `benchmark.py` shows the other heads unchanged and this head improved.
4. Band edges are fitted (no 0.25/0.50/0.75 fallback for quantum) and documented.
5. The `sentinel-demo-walkthrough.md` §7 "what the models actually do" section can be
   rewritten from ⚠️/🔴 to ✅ — measured, not asserted.
