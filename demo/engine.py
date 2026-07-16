"""Demo inference engine — thin orchestration over the REAL artifacts.

Loads trained bundles + fusion engine, computes live per-event predictions,
live SHAP attributions, threat-intel lookups against real feeds, and real
stage timings. Nothing here fabricates a number: every probability comes out
of a serialized model, every SHAP value out of TreeExplainer at runtime.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from ml.config import DOMAIN_OF_MODEL, FUSION_WEIGHTS, MODELS, ROOT
from ml.features import CategoryEncoder, build_matrix, impute

DEMO_DIR = Path(__file__).resolve().parent
FEATURE_DOCS = ROOT / "reports" / "feature_documentation.json"

MODEL_TITLES = {"fraud": "Fraud Detection", "cyber": "Cyber Threat Detection",
                "behaviour": "Behaviour Analytics", "quantum": "Quantum Risk"}

# feature -> analyst-readable label (fallback: feature_documentation.json text)
NICE = {
    "amount": "Transaction amount", "f_log1p_amount": "Amount (log scale)",
    "f_amount_z_user": "Amount z-score vs user history",
    "f_amount_ratio_mean": "Amount vs user's past mean",
    "duration_s": "Session/flow duration", "event_type": "Event channel",
    "event_subtype": "Event subtype", "protocol": "Network protocol",
    "src_port": "Source port", "dst_port": "Destination port",
    "bytes_in": "Bytes received", "bytes_out": "Bytes sent",
    "f_log1p_bytes_in": "Inbound volume (log)", "f_log1p_bytes_out": "Outbound volume (log)",
    "f_bytes_ratio": "Outbound/inbound ratio",
    "f_user_seq_no": "User event count", "f_user_secs_since_last": "Time since user's last event",
    "f_user_past_malicious_rate": "User's past incident rate",
    "f_user_new_country": "First login from this country",
    "f_device_seq_no": "Device event count",
    "f_device_past_hisev_count": "Device past high-severity events",
    "f_hour": "Hour of day", "f_dayofweek": "Day of week",
    "f_is_weekend": "Weekend flag", "f_is_night": "Night-time flag (00-06 UTC)",
    "f_hour_sin": "Hour (cyclic sin)", "f_hour_cos": "Hour (cyclic cos)",
    "country": "Country", "q_key_exchange": "TLS key exchange",
    "q_cert_key_type": "Certificate key type", "q_data_class": "Data classification",
    "q_cert_age_days": "Certificate age (days)",
    "q_cert_validity_days": "Certificate validity (days)",
}

ACTIONS = {
    "critical": ["Freeze account and hold pending transactions",
                 "Terminate all active sessions and revoke tokens",
                 "Disable newly added beneficiary",
                 "Isolate endpoint from network (EDR quarantine)",
                 "Page on-call SOC analyst — open P1 incident",
                 "Preserve forensics: session logs, process tree, pcap"],
    "high": ["Step-up authentication on next action",
             "Hold outbound transfers for manual review",
             "Notify SOC queue — open P2 incident"],
    "medium": ["Add account to enhanced monitoring watchlist",
               "Request re-authentication for sensitive operations"],
    "low": ["No action — continue passive monitoring"],
}


@dataclass
class EventResult:
    event_id: str
    domain: str
    model_key: str
    raw_score: float
    prob: float                      # calibrated
    confidence: float
    infer_ms: float
    shap_ms: float
    top_features: list[dict]         # {feature, label, value, shap, pct}
    ti_matches: list[str]
    headline: str
    time_str: str


@dataclass
class IncidentResult:
    events: list[EventResult]
    fused: dict                      # risk_score, risk_level, contributions
    domain_max: dict[str, float]
    timings: dict = field(default_factory=dict)


class DemoEngine:
    def __init__(self):
        self.bundles: dict = {}
        self.fusion = None
        self.explainers: dict = {}
        self.feodo: pd.DataFrame | None = None
        self.mitre: dict[str, dict] = {}
        self.feature_docs: dict[str, str] = {}
        self.load_ms: dict[str, float] = {}
        self.version = "unknown"

    # ------------------------------------------------------------- loading ---
    def load(self, progress_cb=None) -> None:
        def step(name, fn):
            t0 = time.perf_counter()
            fn()
            self.load_ms[name] = round((time.perf_counter() - t0) * 1e3, 1)
            if progress_cb:
                progress_cb(name, self.load_ms[name])

        for key in DOMAIN_OF_MODEL:
            step(f"{MODEL_TITLES[key]} Model", lambda k=key: self.bundles.update(
                {k: joblib.load(MODELS / f"{k}_bundle.joblib")}))
        step("Risk Fusion Engine", lambda: setattr(
            self, "fusion", joblib.load(MODELS / "fusion_engine.joblib")))

        def _explainers():
            import shap
            for k, b in self.bundles.items():
                self.explainers[k] = shap.TreeExplainer(b["model"])
        step("Explainability Engine (SHAP)", _explainers)

        def _ti():
            self.feodo = pd.read_parquet(
                ROOT / "data" / "clean" / "feodo.parquet",
                columns=["ip_address", "malware", "as_name", "country", "status"])
            m = pd.read_parquet(ROOT / "data" / "clean" / "mitre_attack.parquet",
                                columns=["technique_id", "name", "tactics"])
            self.mitre = m.set_index("technique_id").to_dict("index")
        step("Threat Intelligence Database", _ti)

        if FEATURE_DOCS.exists():
            self.feature_docs = json.loads(FEATURE_DOCS.read_text())
        manifest = ROOT / "reports" / "ml" / "run_manifest.json"
        if manifest.exists():
            j = json.loads(manifest.read_text())
            self.version = (f"pipeline-{j['data']['rows']}rows-"
                            f"xgb{j['versions']['xgboost']}-lgbm{j['versions']['lightgbm']}")

    # ------------------------------------------------------------ scenarios --
    def load_scenario(self, name: str) -> tuple[pd.DataFrame, dict]:
        df = pd.read_parquet(DEMO_DIR / "scenarios.parquet")
        meta = json.loads((DEMO_DIR / "scenarios_meta.json").read_text())
        return df[df["scenario"] == name].copy(), meta[name]

    # -------------------------------------------------------------- scoring --
    def _predict_one(self, key: str, row: pd.DataFrame) -> tuple[float, float, float]:
        b = self.bundles[key]
        X, _ = build_matrix(row, key, CategoryEncoder(b["encoder_mapping"]))
        X = X[b["features"]]
        if b["medians"] is not None:
            X = impute(X, b["medians"])
        m = b["model"]
        t0 = time.perf_counter()
        raw = (m.predict_proba(X)[:, 1] if hasattr(m, "predict_proba")
               else -m.decision_function(X))[0]
        infer_ms = (time.perf_counter() - t0) * 1e3
        return float(raw), infer_ms, X

    def _explain_one(self, key: str, X: pd.DataFrame, top_n: int = 7):
        t0 = time.perf_counter()
        sv = self.explainers[key].shap_values(X, check_additivity=False)
        if isinstance(sv, list):
            sv = sv[1]
        if sv.ndim == 3:
            sv = sv[:, :, 1]
        shap_ms = (time.perf_counter() - t0) * 1e3
        v = sv[0]
        total = np.abs(v).sum() or 1.0
        order = np.argsort(-np.abs(v))[:top_n]
        feats = []
        for i in order:
            name = X.columns[i]
            feats.append({
                "feature": name,
                "label": NICE.get(name, self.feature_docs.get(name, name)),
                "value": None if pd.isna(X.iloc[0, i]) else round(float(X.iloc[0, i]), 3),
                "shap": round(float(v[i]), 4),
                "pct": round(100 * abs(float(v[i])) / total, 1),
            })
        return feats, shap_ms

    def _threat_intel(self, row: pd.Series) -> list[str]:
        hits = []
        ips = self.feodo.set_index("ip_address")
        for col, side in (("dst_ip", "destination"), ("src_ip", "source")):
            ip = row.get(col)
            if pd.notna(ip) and ip in ips.index:
                r = ips.loc[ip]
                hits.append(f"{side} IP {ip} = known {r['malware']} C2 "
                            f"(Feodo Tracker, {r['as_name']}, {r['country']})")
        tech = row.get("attack_technique")
        if pd.notna(tech) and tech in self.mitre:
            t = self.mitre[tech]
            hits.append(f"MITRE ATT&CK {tech}: {t['name']} [{t['tactics']}]")
        return hits

    def analyze(self, events: pd.DataFrame, meta: dict) -> IncidentResult:
        t_total = time.perf_counter()
        headlines = {e["event_id"]: e for e in meta["events"]}
        results: list[EventResult] = []
        domain_max: dict[str, float] = {}
        model_of_domain = {v: k for k, v in DOMAIN_OF_MODEL.items()}

        for _, row in events.iterrows():
            key = model_of_domain.get(row["event_domain"])
            if key is None:
                continue
            frame = row.to_frame().T
            raw, infer_ms, X = self._predict_one(key, frame)
            feats, shap_ms = self._explain_one(key, X)
            prob = float(self.fusion.calibrate(key, raw)[0])
            mmeta = headlines.get(row["event_id"], {})
            results.append(EventResult(
                event_id=row["event_id"], domain=row["event_domain"],
                model_key=key, raw_score=round(raw, 4), prob=round(prob, 4),
                confidence=round(abs(prob - 0.5) * 2, 3),
                infer_ms=round(infer_ms, 2), shap_ms=round(shap_ms, 1),
                top_features=feats, ti_matches=self._threat_intel(row),
                headline=mmeta.get("headline", ""), time_str=mmeta.get("time", "")))
            domain_max[key] = max(domain_max.get(key, 0.0), raw)

        t_fuse = time.perf_counter()
        fused = self.fusion.fuse(domain_max)  # per-domain max raw -> noisy-OR
        fuse_ms = (time.perf_counter() - t_fuse) * 1e3

        return IncidentResult(
            events=results, fused=fused, domain_max=domain_max,
            timings={
                "model_ms": round(sum(r.infer_ms for r in results), 2),
                "shap_ms": round(sum(r.shap_ms for r in results), 1),
                "fusion_ms": round(fuse_ms, 2),
                "total_ms": round((time.perf_counter() - t_total) * 1e3, 1),
                "weights": FUSION_WEIGHTS,
            })

    @staticmethod
    def actions(level: str) -> list[str]:
        return ACTIONS[level]

    @staticmethod
    def rss_mb() -> float:
        import psutil
        return round(psutil.Process().memory_info().rss / 1e6, 0)
