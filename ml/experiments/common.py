"""Shared experiment scaffolding: load data ONCE, uniform candidate eval,
challenger bundle writer, report persistence."""
from __future__ import annotations

import json
import time
from functools import lru_cache
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from .. import data as D
from .. import features as F
from ..config import ML_REPORTS, MODELS, SEED
from ..evaluate import pick_threshold

EXP_REPORTS = ML_REPORTS / "experiments"
CHALLENGERS = MODELS / "challengers"
EXP_REPORTS.mkdir(parents=True, exist_ok=True)
CHALLENGERS.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def corpus():
    df = D.load_engineered()
    return df, D.temporal_split(df)


def slices(key: str, labeled_train: bool):
    """(train, val, test) frames + matrices + labels for one model key.
    Encoder fitted on train, like the pipeline."""
    df, split = corpus()
    tr = D.domain_slice(df, split, key, "train", labeled_only=labeled_train)
    va = D.domain_slice(df, split, key, "val", labeled_only=True)
    te = D.domain_slice(df, split, key, "test", labeled_only=True)
    X_tr, enc = F.build_matrix(tr, key)
    X_va, _ = F.build_matrix(va, key, enc)
    X_te, _ = F.build_matrix(te, key, enc)
    y = {p: F.labels_and_weights(part)[0] for p, part in
         (("train", tr), ("val", va), ("test", te))}
    w_va = F.labels_and_weights(va)[1]
    return {"X": {"train": X_tr, "val": X_va, "test": X_te}, "y": y,
            "w_va": w_va, "encoder": enc, "train_frame": tr}


def eval_scores(y: np.ndarray, s: np.ndarray) -> dict:
    return {"roc_auc": round(float(roc_auc_score(y, s)), 4),
            "pr_auc": round(float(average_precision_score(y, s)), 4)}


def timed(fn, *args, **kw):
    t0 = time.perf_counter()
    out = fn(*args, **kw)
    return out, round(time.perf_counter() - t0, 1)


def write_challenger(key: str, model, sl: dict, library: str,
                     medians: dict | None, s_va: np.ndarray) -> Path:
    """Serialize a candidate in the exact bundle format the pipeline emits."""
    bundle = {"model": model, "features": list(sl["X"]["train"].columns),
              "encoder_mapping": sl["encoder"].mapping, "medians": medians,
              "threshold": pick_threshold(sl["y"]["val"], s_va),
              "library": library, "seed": SEED}
    p = CHALLENGERS / f"{key}_challenger.joblib"
    joblib.dump(bundle, p, compress=3)
    return p


def save_report(name: str, payload: dict) -> None:
    p = EXP_REPORTS / f"{name}.json"
    p.write_text(json.dumps(payload, indent=2))
    print(f"report -> {p}")
