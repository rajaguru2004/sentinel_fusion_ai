# %% [markdown]
# # FinSpark — Bank Simulator Export
#
# | | |
# |---|---|
# | **Source** | FinSpark banking simulator (NestJS), per `docs/finspark_export_spec.md` |
# | **Format** | newline-delimited JSON, `data/raw/financial/finspark/*.jsonl` |
# | **Labels** | `label.value` (0/1/-1) with `label.confirmedAt` |
# | **Why it matters** | The only source in the corpus shaped like the production distribution, and the only one that can supply `nameMismatch`, beneficiary ageing and real confirmation timestamps. |
#
# This is both a **training corpus** and the **calibration authority**: thresholds
# and risk bands fitted on public data do not transfer to the bank's base rate.
#
# If no real export is present, `notebooks/finspark_gen.py` writes a
# spec-conformant synthetic file so the whole path stays exercised. Synthetic
# input is tagged `source_dataset="finspark_synth"` and is never silently mixed
# with real bank traffic.

# %%
import sys
sys.path.insert(0, "..")
import glob
import json

import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, save_clean, save_unified_part

D = RAW / "financial" / "finspark"
files = sorted(glob.glob(str(D / "*.jsonl")))
print(f"{len(files)} export file(s)")
if not files:
    raise SystemExit(
        "no FinSpark export found. Either drop the bank's export into "
        f"{D} or generate a spec-conformant one:\n"
        "    python notebooks/finspark_gen.py")

# %%
rows = []
for f in files:
    with open(f) as fh:
        rows.extend(json.loads(line) for line in fh if line.strip())
raw = pd.json_normalize(rows)
print(raw.shape)
raw.head(3)

# %% [markdown]
# ## Validation on receipt
#
# The spec's acceptance rules, asserted rather than assumed. A malformed export
# should fail loudly here, not surface later as an unexplained metric change.

# %%
SYNTHETIC = bool(raw.get("synthetic", pd.Series([False])).fillna(False).any())
source = "finspark_synth" if SYNTHETIC else "finspark"
print(f"source_dataset = {source}")

raw["event_time"] = pd.to_datetime(raw["eventTime"], utc=True, errors="raise")
assert raw["eventId"].is_unique, "duplicate eventId in export"
assert raw["event_time"].notna().all(), "unparseable eventTime"

pay = raw[raw["eventType"] == "payment_initiation"]
lab = pd.to_numeric(raw["label.value"], errors="coerce")
fraud_rate = float((lab[raw["eventType"] == "payment_initiation"] == 1).mean())
print(f"payments={len(pay):,}  fraud_rate={fraud_rate:.4%}")
assert 0.0005 <= fraud_rate <= 0.02, (
    f"payment fraud rate {fraud_rate:.4%} outside the 0.05%-2% the spec allows — "
    "do NOT pre-balance the classes; the true base rate is what calibration needs")

per_customer = raw.groupby("userId").size()
print(f"customers={len(per_customer):,}  median events/customer={per_customer.median():.0f}")
assert per_customer.median() >= 50, (
    "median events per customer too low — export WHOLE customer sequences; "
    "subsampling a customer is what made the v1 history features dead")

# confirmedAt must not precede its own event
if "label.confirmedAt" in raw.columns:
    conf = pd.to_datetime(raw["label.confirmedAt"], utc=True, errors="coerce")
    bad = conf.notna() & (conf < raw["event_time"])
    assert not bad.any(), f"{int(bad.sum())} labels confirmed before their event"
    share = float(conf[lab == 1].notna().mean()) if (lab == 1).any() else 0.0
    print(f"frauds with confirmedAt: {share:.1%}")
else:
    conf = pd.Series(pd.NaT, index=raw.index)
    print("WARNING: no label.confirmedAt — the offline label replay will fall "
          "back to the synthetic lag (LABEL_LAG_S / LABEL_CONFIRM_RATE)")

# %% [markdown]
# ## Leak check
#
# The automated version of the guard that would have caught v1's `severity`.
# Anything the bank sends that reproduces the target is a rule verdict leaking
# into the feature set, not a signal.

# %%
from prep_utils import assert_no_label_alias  # noqa: E402

_probe = raw.copy()
_probe["label"] = lab.fillna(-1).astype("int8")
_skip = ("eventId", "eventTime", "label", "userId", "deviceId")
_cols = [c for c in _probe.columns if not c.startswith(_skip)]
assert_no_label_alias(_probe[[*_cols, "label"]])
print("no label alias in the export")

# %% [markdown]
# ## Map to the canonical banking schema
#
# Straight field mapping — the canonical schema was *defined* from this contract
# (docs/canonical_schema.md), so there is nothing to invent here.

# %%
def col(name, default=np.nan):
    return raw[name] if name in raw.columns else pd.Series(default, index=raw.index)


EVENT_TYPE = {"payment_initiation": "payment", "card_purchase": "card_txn",
              "login": "login", "beneficiary_add": "beneficiary",
              "beneficiary_activate": "beneficiary",
              "balance_check": "context", "statement_view": "context"}

u = pd.DataFrame({
    "event_id": source + "-" + raw["eventId"].astype(str),
    "event_time": raw["event_time"],
    "event_type": raw["eventType"].map(EVENT_TYPE).fillna("context"),
    "event_subtype": raw["eventType"],
    "user_id": raw["userId"].astype(str),
    "device_id": col("deviceId").astype("string"),
    "country": col("country"),
    "amount": pd.to_numeric(col("amount"), errors="coerce"),
    # v2 rule: severity is ex-ante triage and must never be a function of label.
    "severity": np.int8(0),
    "label": lab.fillna(-1).astype("Int8"),
    "label_confirmed_at": conf,
    "time_is_synthetic": SYNTHETIC,
    # --- canonical banking block ---
    "counterparty_id": col("counterparty.id").astype("string"),
    "counterparty_country": col("counterparty.country"),
    "counterparty_is_new": pd.to_numeric(col("counterparty.isNew"), errors="coerce"),
    "counterparty_age_s": pd.to_numeric(col("counterparty.ageSeconds"), errors="coerce"),
    "name_mismatch": pd.to_numeric(col("counterparty.nameMismatch"), errors="coerce"),
    "counterparty_balance_before": pd.to_numeric(col("counterparty.balanceBefore"), errors="coerce"),
    "counterparty_balance_after": pd.to_numeric(col("counterparty.balanceAfter"), errors="coerce"),
    "balance_before": pd.to_numeric(col("balanceBefore"), errors="coerce"),
    "balance_after": pd.to_numeric(col("balanceAfter"), errors="coerce"),
    "customer_age": pd.to_numeric(col("customer.age"), errors="coerce"),
    "account_age_s": pd.to_numeric(col("customer.accountAgeSeconds"), errors="coerce"),
    "income": pd.to_numeric(col("customer.income"), errors="coerce"),
    "email_is_free": pd.to_numeric(col("customer.emailIsFree"), errors="coerce"),
    "channel": col("channel"),
    "device_os": col("device.os"),
    "device_is_new": pd.to_numeric(col("device.isNew"), errors="coerce"),
    "session_length_s": pd.to_numeric(col("device.sessionLengthSeconds"), errors="coerce"),
    "is_foreign_request": pd.to_numeric(col("device.isForeignRequest"), errors="coerce"),
    "merchant_id": col("merchant.id").astype("string"),
    "merchant_category": col("merchant.category"),
    "geo_lat": pd.to_numeric(col("geo.lat"), errors="coerce"),
    "geo_lon": pd.to_numeric(col("geo.lon"), errors="coerce"),
    "currency": col("currency"),
    "payment_type": col("paymentType"),
    "is_credit": pd.to_numeric(col("isCredit"), errors="coerce"),
    # bank-computed block (§3.3)
    "bank_txn_count_1h": pd.to_numeric(col("bankComputed.txnCountLastHour"), errors="coerce"),
    "bank_amount_vs_user_mean": pd.to_numeric(col("bankComputed.amountVsUserMean"), errors="coerce"),
    "bank_beneficiary_age_s": pd.to_numeric(col("bankComputed.beneficiaryAgeMinutes"),
                                            errors="coerce") * 60.0,
    "bank_is_new_beneficiary": pd.to_numeric(col("bankComputed.isNewBeneficiary"), errors="coerce"),
})
for c in ("counterparty_is_new", "name_mismatch", "device_is_new",
          "is_foreign_request", "email_is_free", "is_credit",
          "bank_is_new_beneficiary"):
    u[c] = u[c].astype("Float64").round().astype("Int8")
u = u.sort_values(["event_time", "event_id"]).reset_index(drop=True)
print(u.shape)

# %%
covered = (u.notna().mean() * 100).round(1).sort_values(ascending=False)
print("canonical field coverage (%):")
print(covered[covered > 0].to_string())

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(u, source)
dataset_report(u, source, label_col="label",
               notes=("FinSpark bank simulator export. SYNTHETIC conformance data"
                      if SYNTHETIC else "FinSpark bank simulator export (real)."))

# %%
# label_confirmed_at is a first-class unified column (not an attribute): the
# offline label replay needs it, and burying real signal in the attributes JSON
# is exactly what silently discarded every other source's features in v1.
part = to_unified(u, source_dataset=source, event_domain="financial",
                  event_type="payment", label_type="fraud", attributes_cols=[])
save_unified_part(part, source)
part.head(3)
