# %% [markdown]
# # Data Validation Report — Final Unified Dataset
#
# Checks: missing values, duplicates, invalid timestamps/labels, class imbalance,
# feature consistency, leakage risks. Emits `reports/validation_report.json` +
# `reports/validation_report.md` + EDA figures.

# %%
import sys, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import UNIFIED, REPORTS

df = pd.read_parquet(UNIFIED / "unified_events_engineered.parquet")
print(df.shape)
checks = {}

# %% [markdown]
# ## 1. Missing values

# %%
core_required = ["event_id", "event_time", "event_domain", "event_type",
                 "source_dataset", "severity", "label", "label_type"]
missing_core = {c: int(df[c].isna().sum()) for c in core_required}
checks["missing_core_required"] = missing_core
checks["missing_core_ok"] = all(v == 0 for v in missing_core.values())
missing_all = {c: round(float(df[c].isna().mean()), 4) for c in df.columns if df[c].isna().any()}
checks["missing_share_by_column"] = missing_all
print(json.dumps(missing_core, indent=2))

# %% [markdown]
# ## 2. Duplicates

# %%
checks["duplicate_event_ids"] = int(df["event_id"].duplicated().sum())
checks["duplicate_full_rows"] = int(df.drop(columns=["event_id"]).duplicated().sum())
checks["duplicates_ok"] = checks["duplicate_event_ids"] == 0
print(checks["duplicate_event_ids"], "dup ids;", checks["duplicate_full_rows"], "dup content rows")

# %% [markdown]
# ## 3. Timestamps

# %%
now = pd.Timestamp("2026-07-16", tz="UTC")
checks["invalid_timestamps"] = int(df["event_time"].isna().sum())
checks["future_timestamps"] = int((df["event_time"] > now).sum())
checks["pre_2010_timestamps"] = int((df["event_time"] < pd.Timestamp("2010-01-01", tz="UTC")).sum())
checks["temporally_sorted"] = bool(df["event_time"].is_monotonic_increasing)
checks["synthetic_time_share"] = round(float(df["time_is_synthetic"].mean()), 4)
print({k: checks[k] for k in ["invalid_timestamps", "future_timestamps", "temporally_sorted"]})

# %% [markdown]
# ## 4. Labels + class imbalance

# %%
checks["invalid_labels"] = int((~df["label"].isin([-1, 0, 1])).sum())
lbl = df[df["label"] >= 0]
checks["label_distribution"] = {str(k): int(v) for k, v in df["label"].value_counts().items()}
checks["positive_rate_labeled"] = round(float((lbl["label"] == 1).mean()), 5)
by_ds = lbl.groupby("source_dataset", observed=True)["label"].agg(["size", "mean"])
checks["positive_rate_by_dataset"] = {i: {"rows": int(r["size"]), "pos_rate": round(float(r["mean"]), 5)}
                                      for i, r in by_ds.iterrows()}
checks["severity_range_ok"] = bool(df["severity"].dropna().between(0, 4).all())
by_ds

# %% [markdown]
# ## 5. Feature consistency

# %%
issues = []
if (df["duration_s"].dropna() < 0).any():
    issues.append("negative duration_s")
if (df["amount"].dropna() < 0).any():
    issues.append("negative amount")
for c in ["bytes_in", "bytes_out"]:
    if (df[c].dropna() < 0).any():
        issues.append(f"negative {c}")
inf_cols = [c for c in df.select_dtypes(include=[np.number]).columns
            if np.isinf(df[c].dropna().to_numpy(dtype="float64", na_value=np.nan)).any()]
if inf_cols:
    issues.append(f"inf values in {inf_cols}")
checks["feature_consistency_issues"] = issues
print("consistency issues:", issues or "none")

# %% [markdown]
# ## 6. Leakage risk audit

# %%
leakage_notes = {
    "engineered_features": "All rolling/historical features use shift(1) — past-only; verified in 12_feature_engineering.",
    "synthetic_timestamps": "Datasets with synthetic times are flagged time_is_synthetic; do NOT use cross-dataset temporal joins on them.",
    "paysim_isFlaggedFraud": "Kept only inside attributes JSON; it is a rule output, treat as feature not label.",
    "quantum_synth": "Label is rule-derived from features by construction — model will learn the rule; use for pipeline validation, not as evidence of real-world quantum-risk predictive power.",
    "beth_sus": "sus kept in attributes; correlated with evil label — drop if predicting evil strictly.",
    "train_test_reuse": "UNSW/BETH official splits preserved in attributes.split for honest evaluation.",
}
checks["leakage_notes"] = leakage_notes
# quick correlation probe: engineered numeric features vs label on labeled rows
fcols = [c for c in df.columns if c.startswith("f_")]
num = lbl[fcols].select_dtypes(include=[np.number])
corr = num.apply(lambda s: s.corr(lbl["label"].astype("float64"))).abs().sort_values(ascending=False)
checks["top_feature_label_correlations"] = {k: round(float(v), 4) for k, v in corr.head(8).items() if pd.notna(v)}
corr.head(8)

# %% [markdown]
# ## 7. EDA figures + final report

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(2, 2, figsize=(14, 9))
df["event_domain"].value_counts().plot.bar(ax=axes[0, 0], title="events by domain (log)"); axes[0, 0].set_yscale("log")
df["source_dataset"].value_counts().plot.barh(ax=axes[0, 1], title="events by dataset (log)"); axes[0, 1].set_xscale("log")
lbl.groupby("event_domain", observed=True)["label"].mean().plot.bar(ax=axes[1, 0], title="positive rate by domain")
df.set_index("event_time").resample("W")["event_id"].count().plot(ax=axes[1, 1], title="events per week"); axes[1, 1].set_yscale("log")
plt.tight_layout(); plt.savefig(REPORTS / "unified_eda.png", dpi=110); plt.show()

# %%
checks["overall_pass"] = bool(
    checks["missing_core_ok"] and checks["duplicates_ok"]
    and checks["invalid_timestamps"] == 0 and checks["invalid_labels"] == 0
    and checks["severity_range_ok"] and not issues)
(REPORTS / "validation_report.json").write_text(json.dumps(checks, indent=2, default=str))

md = ["# Validation Report — Unified Dataset", "",
      f"- Rows: **{len(df):,}**, columns: **{df.shape[1]}**",
      f"- Overall pass: **{checks['overall_pass']}**",
      f"- Duplicate event_ids: {checks['duplicate_event_ids']}",
      f"- Invalid timestamps: {checks['invalid_timestamps']}; future: {checks['future_timestamps']}",
      f"- Invalid labels: {checks['invalid_labels']}",
      f"- Positive rate (labeled rows): {checks['positive_rate_labeled']}",
      f"- Synthetic-time share: {checks['synthetic_time_share']}",
      f"- Consistency issues: {issues or 'none'}", "",
      "## Positive rate by dataset", ""]
md += [f"- `{k}`: {v['pos_rate']} ({v['rows']:,} rows)" for k, v in checks["positive_rate_by_dataset"].items()]
md += ["", "## Leakage notes", ""] + [f"- **{k}**: {v}" for k, v in leakage_notes.items()]
(REPORTS / "validation_report.md").write_text("\n".join(md))
print("overall_pass =", checks["overall_pass"])
