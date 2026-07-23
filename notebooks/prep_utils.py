"""Shared preprocessing utilities for Sentinel Fusion AI Phase 1.

Every dataset notebook imports this. Keeps unified schema in ONE place.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
CLEAN = ROOT / "data" / "clean"
UNIFIED = ROOT / "data" / "unified"
REPORTS = ROOT / "reports"
for _d in (CLEAN, UNIFIED, REPORTS):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- schema ----
UNIFIED_COLUMNS: dict[str, str] = {
    "event_id": "string",
    "event_time": "datetime64[ns, UTC]",
    "event_domain": "category",
    "event_type": "category",
    "event_subtype": "category",
    "source_dataset": "category",
    "user_id": "string",
    "device_id": "string",
    "src_ip": "string",
    "dst_ip": "string",
    "src_port": "Int32",
    "dst_port": "Int32",
    "protocol": "category",
    "country": "category",
    "amount": "float64",
    "duration_s": "float64",
    "bytes_in": "float64",
    "bytes_out": "float64",
    "severity": "Int8",
    "label": "Int8",
    "label_type": "category",
    "attack_technique": "string",
    "time_is_synthetic": "bool",
    # When the label became KNOWN (FinSpark `label.confirmedAt`), not when the
    # event happened. Never a feature — it is the clock the offline builder uses
    # to replay f_user_past_malicious_rate as it would actually have arrived via
    # /feedback, instead of assuming labels are instant.
    "label_confirmed_at": "datetime64[ns, UTC]",

    # ---------------------------------------------------------- banking v2 ----
    # Canonical banking block (docs/canonical_schema.md). Rule: a column lives
    # here ONLY if the FinSpark simulator can supply it at scoring time. Anything
    # a single source uniquely has stays in `attributes` and never becomes a
    # model feature -- otherwise the model learns signals that vanish in prod.
    # All optional / NaN-safe.
    "counterparty_id": "string",
    "counterparty_country": "category",
    "counterparty_is_new": "Int8",
    "counterparty_age_s": "float64",
    "name_mismatch": "Int8",
    "balance_before": "float64",
    "balance_after": "float64",
    "counterparty_balance_before": "float64",
    "counterparty_balance_after": "float64",
    "customer_age": "float64",
    "account_age_s": "float64",
    "income": "float64",
    "channel": "category",
    "device_os": "category",
    "device_is_new": "Int8",
    "session_length_s": "float64",
    "is_foreign_request": "Int8",
    "email_is_free": "Int8",
    "merchant_id": "string",
    "merchant_category": "category",
    "geo_lat": "float64",
    "geo_lon": "float64",
    "counterparty_lat": "float64",
    "counterparty_lon": "float64",
    "currency": "category",
    "payment_type": "category",
    "is_credit": "Int8",
    # Bank-computed signals (BANK_INTEGRATION_IMPROVEMENTS.md §3.3). Trained as
    # independent features AND used as cold-store fallback seeds.
    "bank_txn_count_1h": "float64",
    "bank_amount_vs_user_mean": "float64",
    "bank_beneficiary_age_s": "float64",
    "bank_is_new_beneficiary": "Int8",

    # `attributes` stays LAST: it is the only column dropped from the compact
    # training corpus, so keeping it terminal makes that slice obvious.
    "attributes": "string",
}

# Columns the compact training corpus keeps. Everything except the lossless JSON
# blob -- the v1 bug was that the banking signals lived *inside* that blob and so
# were silently discarded before training (see docs/canonical_schema.md).
COMPACT_COLUMNS = [c for c in UNIFIED_COLUMNS if c != "attributes"]

DOMAINS = {"cyber", "financial", "behaviour", "threat_intel", "quantum"}
LABEL_TYPES = {"attack", "fraud", "insider", "account_takeover", "ioc", "quantum_risk", "none"}

CHANNELS = {"web", "mobile", "atm", "pos", "branch", "api"}
PAYMENT_TYPES = {"transfer", "cash_out", "cash_in", "debit", "payment", "card_purchase"}


def to_unified(df: pd.DataFrame, *, source_dataset: str, event_domain: str,
               event_type: str, label_type: str,
               attributes_cols: list[str] | None = None,
               label_alias_exempt: dict[str, str] | None = None) -> pd.DataFrame:
    """Map a cleaned dataframe onto the unified schema.

    Caller pre-populates any core columns it has (event_time, label, severity, ...).
    Everything in `attributes_cols` is packed lossless into the `attributes` JSON column.
    Missing core columns are added as NA. Column order + dtypes enforced.
    """
    assert event_domain in DOMAINS, event_domain
    assert label_type in LABEL_TYPES, label_type
    out = df.copy()

    if attributes_cols:
        keep = [c for c in attributes_cols if c in out.columns]
        out["attributes"] = out[keep].apply(
            lambda r: json.dumps({k: v for k, v in r.items() if pd.notna(v)},
                                 default=str, separators=(",", ":")), axis=1)
        out = out.drop(columns=keep)

    out["source_dataset"] = source_dataset
    out["event_domain"] = event_domain
    if "event_type" not in out.columns:
        out["event_type"] = event_type
    if "label_type" not in out.columns:
        out["label_type"] = label_type
    if "event_id" not in out.columns:
        out["event_id"] = [f"{source_dataset}-{i}" for i in range(len(out))]
    if "time_is_synthetic" not in out.columns:
        out["time_is_synthetic"] = False

    for col, dtype in UNIFIED_COLUMNS.items():
        if col not in out.columns:
            if dtype == "float64":
                out[col] = np.nan
            elif dtype == "datetime64[ns, UTC]":
                out[col] = pd.NaT
            else:
                out[col] = pd.NA
        try:
            if dtype == "float64":
                out[col] = pd.to_numeric(out[col], errors="raise").astype("float64")
            else:
                out[col] = out[col].astype(dtype)
        except (TypeError, ValueError):
            if dtype == "datetime64[ns, UTC]":
                out[col] = pd.to_datetime(out[col], utc=True, errors="coerce")
            elif dtype == "float64":
                out[col] = out[col].astype("Float64").astype("float64")
            else:
                raise
    out = out[list(UNIFIED_COLUMNS)]
    validate_unified(out, label_alias_exempt=label_alias_exempt)
    return out


def validate_unified(df: pd.DataFrame,
                     label_alias_exempt: dict[str, str] | None = None) -> None:
    assert list(df.columns) == list(UNIFIED_COLUMNS), "column order mismatch"
    assert df["event_id"].is_unique, "duplicate event_id"
    assert df["label"].dropna().isin([-1, 0, 1]).all(), "invalid label values"
    assert df["severity"].dropna().between(0, 4).all(), "severity out of range"
    assert df["event_domain"].isin(DOMAINS).all(), "bad domain"

    ch = df["channel"].dropna()
    assert ch.isin(CHANNELS).all(), f"bad channel(s): {sorted(set(ch) - CHANNELS)}"
    pt = df["payment_type"].dropna()
    assert pt.isin(PAYMENT_TYPES).all(), f"bad payment_type(s): {sorted(set(pt) - PAYMENT_TYPES)}"
    for c in ("counterparty_is_new", "name_mismatch", "device_is_new",
              "is_foreign_request", "email_is_free", "is_credit",
              "bank_is_new_beneficiary"):
        assert df[c].dropna().isin([0, 1]).all(), f"{c} must be 0/1"

    assert_no_label_alias(df, exempt=label_alias_exempt)


# Any column reproducing the label this closely is an alias, not a feature.
LABEL_ALIAS_MAX_AGREEMENT = 0.98


def assert_no_label_alias(df: pd.DataFrame,
                          max_agreement: float = LABEL_ALIAS_MAX_AGREEMENT,
                          exempt: dict[str, str] | None = None) -> None:
    """Reject columns that are (near-)deterministic functions of `label`.

    This is the check that would have caught the v1 `severity` bug: every
    financial loader set `severity = 3 if fraud else 0`, giving a perfect
    reproduction of the target. `severity` was dutifully excluded from every
    feature list -- but `f_device_past_hisev_count` is derived FROM it, so the
    leak reached the models anyway and became the top cyber feature (mean |SHAP|
    4.36). Catch it at the source instead.

    Scored by **balanced accuracy** of the best single-value split, not raw
    agreement. Raw agreement is useless under class imbalance: at a 0.5% fraud
    rate a *constant* column "agrees" with the label 99.5% of the time purely by
    predicting the majority class. Balanced accuracy is 0.5 for any constant and
    1.0 only for a genuine alias.

    Only low-cardinality columns are checked -- a continuous column is not an
    alias by value, and a leaky one shows up via its derived features instead.

    ``exempt`` maps column -> written justification, for the v1 sources whose
    models are deliberately frozen (see reports/ml/MODELS.md). It is a
    fail-closed escape hatch on purpose: a silent threshold relaxation would hide
    every future leak, whereas an exemption with a reason string is visible in
    code review and greppable.
    """
    exempt = exempt or {}
    for col, why in exempt.items():
        assert col in df.columns, f"exemption for unknown column {col!r}"
        assert why and why.strip(), f"exemption for {col!r} needs a justification"
    lab = df["label"]
    m = lab.isin([0, 1])
    if m.sum() < 100:                       # too few labeled rows to conclude
        return
    y = lab[m].astype("int8").to_numpy()
    if y.min() == y.max():                  # single-class slice: agreement is vacuous
        return
    pos, neg = y == 1, y == 0

    offenders = []
    never_checked = {"label", "label_type", "event_id", "event_time"}
    for col in df.columns:
        if col in never_checked or col in exempt:
            continue
        s = df.loc[m, col]
        ok = s.notna().to_numpy()
        if ok.sum() < 100:
            continue
        vals = s[ok]
        if vals.nunique() > 32 or vals.nunique() < 2:
            continue
        p, n = pos[ok], neg[ok]
        if not p.any() or not n.any():
            continue
        best = 0.0
        for v in vals.unique():
            hit = (vals == v).to_numpy()
            # balanced accuracy of "value == v predicts fraud", and its inverse
            tpr, fpr = hit[p].mean(), hit[n].mean()
            bal = 0.5 * (tpr + (1.0 - fpr))
            best = max(best, bal, 1.0 - bal)
        if best >= max_agreement:
            offenders.append((col, round(best, 4)))

    assert not offenders, (
        f"column(s) alias the label (balanced accuracy >= {max_agreement}): "
        f"{offenders}. A near-perfect function of the target must not enter the "
        "corpus -- even if excluded from FEATURES, derived features can leak it "
        "back in (see docs/canonical_schema.md). If this source's model is "
        "deliberately frozen, pass to_unified(..., label_alias_exempt={'col': "
        "'why'}) rather than relaxing the threshold.")


# ------------------------------------------------------------- reporting ----
def dataset_report(df: pd.DataFrame, name: str, *, label_col: str | None = None,
                   notes: str = "") -> dict:
    """Standard per-dataset stats blob. Saved to reports/<name>_stats.json."""
    rep = {
        "dataset": name,
        "rows": int(len(df)),
        "columns": int(df.shape[1]),
        "memory_mb": round(float(df.memory_usage(deep=True).sum()) / 1e6, 1),
        "duplicate_rows": int(df.duplicated().sum()),
        "missing_by_column": {c: int(v) for c, v in df.isna().sum().items() if v > 0},
        "dtypes": {c: str(t) for c, t in df.dtypes.items()},
        "notes": notes,
    }
    if label_col and label_col in df.columns:
        vc = df[label_col].value_counts(dropna=False)
        rep["label_distribution"] = {str(k): int(v) for k, v in vc.items()}
        if len(vc) > 1:
            rep["imbalance_ratio"] = round(float(vc.max() / vc.min()), 2)
    path = REPORTS / f"{name}_stats.json"
    path.write_text(json.dumps(rep, indent=2))
    print(f"report -> {path}")
    return rep


def numeric_summary(df: pd.DataFrame, name: str) -> pd.DataFrame:
    """describe() for numerics, persisted to reports/."""
    summ = df.select_dtypes(include=[np.number]).describe().T
    summ.to_csv(REPORTS / f"{name}_numeric_summary.csv")
    return summ


def iqr_outlier_share(s: pd.Series) -> float:
    q1, q3 = s.quantile([0.25, 0.75])
    iqr = q3 - q1
    if iqr == 0:
        return 0.0
    return float(((s < q1 - 1.5 * iqr) | (s > q3 + 1.5 * iqr)).mean())


def save_clean(df: pd.DataFrame, name: str) -> Path:
    p = CLEAN / f"{name}.parquet"
    df.to_parquet(p, index=False)
    print(f"clean -> {p} ({len(df):,} rows)")
    return p


def save_unified_part(df: pd.DataFrame, name: str) -> Path:
    p = UNIFIED / f"part_{name}.parquet"
    df.to_parquet(p, index=False)
    print(f"unified part -> {p} ({len(df):,} rows)")
    return p
