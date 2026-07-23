"""Dev-time scenario builder (run once; demo loads the small parquet).

    .venv/bin/python -m demo.build_scenarios

Takes REAL labeled rows from the TEST split (models never trained on them),
rewrites identity/story fields (user, device, timestamps — recomputing the
temporal features so they stay consistent), plants a real Feodo C2 IP as the
exfil destination, and saves demo/scenarios.parquet + scenarios_meta.json.
Model-feature values stay real — predictions in the demo are genuine.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from ml import data as D
from ml.config import ROOT

DEMO_DIR = Path(__file__).resolve().parent
OUT_PARQUET = DEMO_DIR / "scenarios.parquet"
OUT_META = DEMO_DIR / "scenarios_meta.json"

USER = "ACC-778341"
DEVICE = "DEV-MACBOOK-7741"
BASE = pd.Timestamp("2026-07-16 09:01:00", tz="UTC")


def _retime(row: pd.Series, ts: pd.Timestamp) -> pd.Series:
    """Move an event to story time; recompute the temporal features that
    depend on it so the vector stays internally consistent (and real)."""
    row = row.copy()
    row["event_time"] = ts
    row["f_hour"] = ts.hour
    row["f_dayofweek"] = ts.dayofweek
    row["f_is_weekend"] = int(ts.dayofweek >= 5)
    row["f_is_night"] = int(ts.hour <= 5)
    row["f_hour_sin"] = np.sin(2 * np.pi * ts.hour / 24)
    row["f_hour_cos"] = np.cos(2 * np.pi * ts.hour / 24)
    return row


def _pick(df, split, mask, order_col, ascending=False, any_split=False):
    """Prefer TEST rows (model never trained on them). any_split covers
    degenerate sources — beth has zero positives outside train."""
    cand = df[mask] if any_split else df[(split == "test") & mask]
    cand = cand.sort_values(order_col, ascending=ascending, na_position="last")
    if cand.empty:
        raise RuntimeError("no candidate row for scenario slot")
    return cand.iloc[0]


def main() -> None:
    df = D.load_engineered()
    split = D.temporal_split(df)
    feodo = pd.read_parquet(ROOT / "data" / "clean" / "feodo.parquet")
    c2 = feodo[feodo["status"] == "online"].iloc[0] if (feodo["status"] == "online").any() \
        else feodo.iloc[0]

    lab1 = df["label"] == 1
    lab0 = df["label"] == 0

    # ---------------- attack scenario: account takeover -> exfil -> fraud ----
    login = _pick(df, split, lab1 & (df["source_dataset"] == "rba")
                  & (df["f_user_new_country"] == 1), "f_user_secs_since_last")
    pwsh = _pick(df, split, lab1 & (df["source_dataset"] == "beth")
                 & (df["event_subtype"] == "security_file_open"), "f_device_seq_no",
                 any_split=True)
    exfil = _pick(df, split, lab1 & (df["source_dataset"].isin(["unsw_nb15", "cicids2017"])),
                  "bytes_out")
    # wire slot: among real fraud positives, take the one the deployed model
    # scores HIGHEST (true-positive showcase — still a genuine test-split row)
    import joblib

    from ml.config import MODELS
    from ml.features import CategoryEncoder, build_matrix
    b = joblib.load(MODELS / "fraud_payment_bundle.joblib")
    cand = df[(split == "test") & lab1 & (df["event_domain"] == "financial")
              & df["amount"].notna() & (df["amount"] > 1000)]
    Xc, _ = build_matrix(cand, "fraud", CategoryEncoder(b["encoder_mapping"]))
    scores = b["model"].predict_proba(Xc[b["features"]])[:, 1]
    wire = cand.iloc[int(scores.argmax())]
    print(f"wire slot: fraud p={scores.max():.3f} amount={wire['amount']:.0f}")
    hndl = _pick(df, split, lab1 & (df["event_domain"] == "quantum"), "bytes_out")

    story = [
        (login, BASE + pd.Timedelta(minutes=0), "Login from new country (VPN exit node)"),
        (pwsh, BASE + pd.Timedelta(minutes=2), "PowerShell security-file access on user device"),
        (exfil, BASE + pd.Timedelta(minutes=4), "Bulk outbound network transfer to C2"),
        (wire, BASE + pd.Timedelta(minutes=6), "High-value transfer to new beneficiary"),
        (hndl, BASE + pd.Timedelta(minutes=7), "Bulk TLS upload on quantum-breakable channel"),
    ]
    attack_rows, attack_meta = [], []
    for i, (row, ts, headline) in enumerate(story):
        r = _retime(row, ts)
        r["event_id"] = f"INC-2026-0716-{i + 1:02d}"
        r["user_id"] = USER
        r["device_id"] = DEVICE
        if r["event_domain"] == "cyber" and pd.notna(row.get("bytes_out")):
            r["dst_ip"] = c2["ip_address"]          # real Feodo C2 address
        if i == 1:
            r["attack_technique"] = "T1059"         # display/TI enrichment only
        attack_rows.append(r)
        attack_meta.append({"event_id": r["event_id"], "headline": headline,
                            "time": ts.strftime("%H:%M")})

    # ------------------------------- benign scenario: normal card payment ----
    normal = _pick(df, split, lab0 & (df["event_domain"] == "financial")
                   & df["amount"].notna() & df["amount"].between(10, 200),
                   "f_user_seq_no")
    b = _retime(normal, BASE + pd.Timedelta(hours=3))
    b["event_id"] = "TXN-2026-0716-OK"
    b["user_id"] = "ACC-102455"
    b["device_id"] = "DEV-ANDROID-2210"

    out = pd.DataFrame(attack_rows + [b]).reset_index(drop=True)
    out["scenario"] = ["attack"] * len(attack_rows) + ["benign"]
    out.to_parquet(OUT_PARQUET, index=False)

    OUT_META.write_text(json.dumps({
        "attack": {
            "title": "Account takeover with data exfiltration and wire fraud",
            "user": USER, "device": DEVICE,
            "c2": {"ip": str(c2["ip_address"]), "malware": str(c2["malware"]),
                   "asn": str(c2["as_name"]), "country": str(c2["country"])},
            "events": attack_meta,
        },
        "benign": {"title": "Routine card payment", "user": "ACC-102455",
                   "events": [{"event_id": "TXN-2026-0716-OK",
                               "headline": "Everyday card transaction",
                               "time": (BASE + pd.Timedelta(hours=3)).strftime("%H:%M")}]},
    }, indent=2))
    print(f"{OUT_PARQUET.name}: {len(out)} rows "
          f"({out.groupby('scenario', observed=True).size().to_dict()})")
    print(f"C2 planted: {c2['ip_address']} ({c2['malware']})")


if __name__ == "__main__":
    main()
