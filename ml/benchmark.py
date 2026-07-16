"""Benchmark harness — accuracy + latency + resource regression gate.

    python -m ml.benchmark                     # full run, print table, append history
    python -m ml.benchmark --check             # exit 1 on regression vs baseline
    python -m ml.benchmark --update-baseline   # promote current run to baseline
    python -m ml.benchmark --challenger B.joblib --model behaviour
                                               # candidate vs champion, exit 1 if losing

Baseline (`benchmarks/baselines/metrics_baseline.json`) is committed and is the
single source of truth for floors — quality-gate tests read the same file.
Schema per model: {metric: {"value": measured, "min": floor}} (or "max" cap).
History: one JSON line per model per run in benchmarks/history/bench_history.jsonl.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

import joblib
from sklearn.metrics import average_precision_score

from . import data as D
from . import features as F
from . import train as T
from .config import BENCH_DIR, DOMAIN_OF_MODEL, MODELS, SLA
from .evaluate import brier_score, compute_metrics, latency_benchmark
from .features import CategoryEncoder

BASELINE = BENCH_DIR / "baselines" / "metrics_baseline.json"
HISTORY = BENCH_DIR / "history" / "bench_history.jsonl"

# regression tolerances used when generating a baseline from a run
TOL = {"roc_auc": 0.005, "f1": 0.01, "precision": 0.02, "recall": 0.02}


def _git_sha() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return "unknown"


def _rss_mb() -> float:
    import psutil
    return psutil.Process().memory_info().rss / 1e6


def _eval_bundle(bundle: dict, df, split, key: str) -> dict:
    """Quality + latency + resources for one bundle on the shared test slice."""
    va = D.domain_slice(df, split, key, "val", labeled_only=True)
    te = D.domain_slice(df, split, key, "test", labeled_only=True)
    out = {}
    for part_name, part in (("val", va), ("test", te)):
        X, _ = F.build_matrix(part, key, CategoryEncoder(bundle["encoder_mapping"]))
        X = X[bundle["features"]]
        if bundle["medians"] is not None:
            X = F.impute(X, bundle["medians"])
        s = T.score(bundle["model"], X)
        y = part["label"].to_numpy()
        m = compute_metrics(y, s, bundle["threshold"])
        m["pr_auc"] = round(float(average_precision_score(y, s)), 4)
        out[part_name] = m
        if part_name == "test":
            p01 = (s - s.min()) / max(s.max() - s.min(), 1e-9)
            out["brier_raw01_test"] = round(brier_score(y, p01), 4)
            out["latency"] = latency_benchmark(bundle["model"], X)
    return out


def measure(models_dir=MODELS, df=None) -> dict:
    """Full benchmark of the deployed champions."""
    if df is None:
        df = D.load_engineered()
    split = D.temporal_split(df)
    rss0 = _rss_mb()

    t0 = time.perf_counter()
    from .predict import SentinelScorer
    scorer = SentinelScorer(models_dir)
    cold_start_ms = round((time.perf_counter() - t0) * 1e3, 1)

    results = {}
    for key in DOMAIN_OF_MODEL:
        t0 = time.perf_counter()
        bundle = joblib.load(models_dir / f"{key}_bundle.joblib")
        load_ms = round((time.perf_counter() - t0) * 1e3, 1)
        r = _eval_bundle(bundle, df, split, key)
        r["resources"] = {
            "model_size_bytes": (models_dir / f"{key}_bundle.joblib").stat().st_size,
            "bundle_load_ms": load_ms,
        }
        results[key] = r

    # fusion: score every test row through the real scorer path
    test_rows = df[split == "test"]
    t0 = time.perf_counter()
    fused = scorer.score_events(test_rows)
    fuse_secs = time.perf_counter() - t0
    lab = test_rows["label"]
    m = (lab >= 0) & fused["scored"]
    from sklearn.metrics import roc_auc_score
    results["fusion"] = {
        "cross_domain_roc_auc": round(float(
            roc_auc_score(lab[m], fused.loc[m, "risk_score"])), 4),
        "fuse_rows_per_sec": int(len(test_rows) / fuse_secs),
        "risk_level_distribution": fused["risk_level"].value_counts().to_dict(),
    }
    results["_run"] = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "git_sha": _git_sha(), "rows": int(len(df)),
        "cold_start_ms": cold_start_ms,
        "peak_rss_mb": round(_rss_mb() - rss0 + rss0, 0),
    }
    return results


def _flatten(results: dict, key: str) -> dict:
    """Metrics a baseline constrains, flat {name: value}."""
    if key == "fusion":
        return {"cross_domain_roc_auc": results["fusion"]["cross_domain_roc_auc"],
                "fuse_rows_per_sec": results["fusion"]["fuse_rows_per_sec"]}
    r = results[key]
    return {"roc_auc": r["test"]["roc_auc"], "f1": r["test"]["f1"],
            "precision": r["test"]["precision"], "recall": r["test"]["recall"],
            "pr_auc": r["test"]["pr_auc"],
            "single_row_ms_p50": r["latency"]["single_row_ms"]["p50"],
            "batch_rows_per_sec": r["latency"]["batch_rows_per_sec"]}


def make_baseline(results: dict) -> dict:
    base = {}
    for key in [*DOMAIN_OF_MODEL, "fusion"]:
        flat = _flatten(results, key)
        entry = {}
        for name, val in flat.items():
            spec = {"value": val}
            if name in TOL:
                spec["min"] = round(val - TOL[name], 4)
            elif name == "pr_auc":
                spec["min"] = round(val - 0.01, 4)
            elif name == "cross_domain_roc_auc":
                spec["min"] = round(val - 0.005, 4)
            elif name.endswith("rows_per_sec"):
                spec["min"] = int(min(val * 0.5, val - 1))  # 2x slowdown fails
            elif name == "single_row_ms_p50":
                cap = (SLA["iforest_single_row_ms_p50"] if key == "behaviour"
                       else SLA["gbm_single_row_ms_p50"])
                spec["max"] = cap
            entry[name] = spec
        base[key] = entry
    return base


def check(results: dict, baseline: dict) -> list[str]:
    failures = []
    for key, entry in baseline.items():
        flat = _flatten(results, key)
        for name, spec in entry.items():
            v = flat.get(name)
            if v is None:
                continue
            if "min" in spec and v < spec["min"]:
                failures.append(f"{key}.{name}={v} < min {spec['min']}")
            if "max" in spec and v > spec["max"]:
                failures.append(f"{key}.{name}={v} > max {spec['max']}")
    return failures


def challenger_vs_champion(cand_path: str, key: str, models_dir=MODELS) -> int:
    """Promotion gate: val primary metric +0.005, no test regression,
    latency p50 <= 1.5x champion."""
    df = D.load_engineered()
    split = D.temporal_split(df)
    champ = _eval_bundle(joblib.load(models_dir / f"{key}_bundle.joblib"), df, split, key)
    cand = _eval_bundle(joblib.load(cand_path), df, split, key)
    primary = "roc_auc" if key == "behaviour" else "pr_auc"

    verdict = {
        "val_gain": round(cand["val"][primary] - champ["val"][primary], 4),
        "test_gain": round(cand["test"][primary] - champ["test"][primary], 4),
        "latency_ratio": round(cand["latency"]["single_row_ms"]["p50"]
                               / max(champ["latency"]["single_row_ms"]["p50"], 1e-9), 2),
    }
    promote = (verdict["val_gain"] >= 0.005 and verdict["test_gain"] >= -0.001
               and verdict["latency_ratio"] <= 1.5)
    print(json.dumps({"model": key, "primary": primary, "champion": champ["val"][primary],
                      "challenger": cand["val"][primary], **verdict,
                      "promote": promote}, indent=2))
    return 0 if promote else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--challenger", metavar="BUNDLE_PATH")
    ap.add_argument("--model", choices=list(DOMAIN_OF_MODEL))
    a = ap.parse_args()

    if a.challenger:
        if not a.model:
            ap.error("--challenger requires --model")
        return challenger_vs_champion(a.challenger, a.model)

    results = measure()
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    with HISTORY.open("a") as f:
        for key in [*DOMAIN_OF_MODEL, "fusion"]:
            f.write(json.dumps({**results["_run"], "model": key,
                                **_flatten(results, key)}) + "\n")

    for key in [*DOMAIN_OF_MODEL, "fusion"]:
        print(f"{key:10s} {_flatten(results, key)}")

    if a.update_baseline:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(make_baseline(results), indent=2))
        print(f"baseline -> {BASELINE}")
        return 0

    if a.check:
        if not BASELINE.exists():
            print("no baseline committed — run --update-baseline first", file=sys.stderr)
            return 2
        failures = check(results, json.loads(BASELINE.read_text()))
        if failures:
            print("REGRESSION:\n  " + "\n  ".join(failures), file=sys.stderr)
            return 1
        print("gate OK — no regression vs baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
