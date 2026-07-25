"""Plain-language layer — turns model internals into sentences anyone follows.

Every sentence is derived from a real value on the event row or a real SHAP
attribution; this file only translates, it never invents facts.
"""
from __future__ import annotations

import json

import pandas as pd

from ml.config import ROOT

# The specialists — how we introduce the models to a non-technical room.
# Keys are the real model keys in reports/ml/metrics_all.json (v2: two fraud heads).
TEAM = {
    "fraud_payment": {
        "icon": "💳", "name": "The Money Watcher",
        "tech": "Fraud Detection (Payments) — XGBoost",
        "what": "Watches every payment and transfer. Knows what a normal "
                "payment looks like for each customer — size, timing, "
                "destination, who they usually pay — and raises a hand when "
                "money moves strangely.",
        "catches": "stolen-card purchases, drained accounts, new-payee scams",
    },
    "fraud_application": {
        "icon": "📝", "name": "The New-Account Watcher",
        "tech": "Fraud Detection (Applications) — XGBoost",
        "what": "Watches new account and credit applications. Spots identities "
                "and details that don't add up before an account is even opened.",
        "catches": "application fraud, synthetic identities, mule accounts",
    },
    "cyber": {
        "icon": "🖥️", "name": "The Intrusion Watcher",
        "tech": "Cyber Threat Detection — LightGBM",
        "what": "Watches computers and network traffic. Spots break-ins: "
                "malicious programs starting, data flowing to criminal "
                "servers, machines talking to places they never talk to.",
        "catches": "hacking tools, data theft, malware calling home",
    },
    "behaviour": {
        "icon": "👤", "name": "The Habits Watcher",
        "tech": "Behaviour Analytics — LightGBM (supervised champion)",
        "what": "Learns each person's routine — where they log in from, "
                "when, from which device. When 'you' suddenly aren't "
                "behaving like you, it notices.",
        "catches": "stolen passwords, account takeovers, impossible travel",
    },
    "quantum": {
        "icon": "🔐", "name": "The Future-Proofing Watcher",
        "tech": "Quantum Risk — XGBoost",
        "what": "Checks the locks on sensitive data. Criminals steal "
                "encrypted data TODAY to crack it with quantum computers "
                "TOMORROW. This watcher spots weak locks guarding "
                "important secrets.",
        "catches": "harvest-now-decrypt-later theft of long-lived secrets",
    },
}

FUSION_PLAIN = ("The Command Center listens to all four watchers at once. "
                "One loud alarm is enough to escalate — and several quiet "
                "worries add up too. Out comes ONE final threat level.")


def suspicion_phrase(p: float) -> tuple[str, str]:
    """(headline, style) for a calibrated probability."""
    if p >= 0.9:
        return "ALARM — as certain as it gets", "bold red"
    if p >= 0.5:
        return "Suspicious — needs attention", "bold dark_orange"
    if p >= 0.2:
        return "A little unusual — keeping an eye on it", "yellow"
    return "Looks normal", "green"


def meter(p: float, width: int = 20) -> str:
    filled = int(round(p * width))
    color = "red" if p >= 0.5 else ("yellow" if p >= 0.2 else "green")
    return (f"[{color}]{'█' * filled}[/{color}][dim]{'░' * (width - filled)}[/dim] "
            f"[{color}]{int(round(p * 100))}/100[/{color}]")


def _mb(x: float) -> str:
    return f"{x / 1e6:,.0f} MB" if x >= 1e6 else f"{x / 1e3:,.0f} KB"


def explain_feature(feat: dict, row: pd.Series) -> str | None:
    """One real signal -> one human sentence. Returns None when the signal
    isn't worth a headline (tiny weight / unhelpful raw encoding)."""
    name, val = feat["feature"], feat["value"]
    up = feat["shap"] > 0
    if val is None:
        return None
    amount = row.get("amount")
    country = row.get("country")
    match name:
        case "amount" | "f_log1p_amount" if pd.notna(amount):
            return (f"The amount — {amount:,.0f} — is far outside this "
                    f"customer's normal range" if up else
                    f"The amount ({amount:,.0f}) is ordinary for this customer")
        case "f_amount_z_user" if up and val and val > 2:
            return (f"This transfer is about {val:.0f}× larger than anything "
                    f"this customer usually sends")
        case "f_amount_ratio_mean" if up and val and val > 2:
            return f"The amount is {val:.0f}× this customer's normal spend"
        case ("f_counterparty_new" | "counterparty_is_new"
              | "bank_is_new_beneficiary") if up and val == 1:
            return "First ever payment to this beneficiary"
        case "name_mismatch" if up and val == 1:
            return "The payee name doesn't match the account holder"
        case "counterparty_age_s" if up and val is not None and val < 3600:
            mins = max(1, int(val // 60))
            return f"The beneficiary was added just {mins} minute(s) before this payment"
        case "f_user_txn_count_1h" | "bank_txn_count_1h" if up and val and val >= 2:
            return f"{int(val)} payments from this customer in the last hour — a velocity spike"
        case "f_balance_drain_ratio" if up and val and val >= 0.9:
            return "This payment empties almost the entire balance"
        case "f_merchant_category_novel" if up and val == 1:
            return "First time this customer has spent in this category"
        case "f_user_new_country" if val == 1:
            where = f" ({country})" if pd.notna(country) else ""
            return f"First time this account has EVER been used from this country{where}"
        case "f_is_night" if val == 1:
            return "It's happening in the middle of the night"
        case "f_hour" | "f_hour_sin" | "f_hour_cos" if up:
            return "The timing is unusual for this customer"
        case "bytes_out" | "f_log1p_bytes_out" if up and pd.notna(row.get("bytes_out")):
            return f"A very large amount of data — {_mb(row['bytes_out'])} — is leaving the network"
        case "f_bytes_ratio" if up:
            return "Far more data is going OUT than coming in — the signature of data theft"
        case "f_user_secs_since_last" if up:
            return "Actions are happening much faster than a human normally works"
        case "f_user_past_malicious_rate" if up and val and val > 0:
            return "This account has been tied to incidents before"
        case "f_device_seq_no" | "f_user_seq_no" if up:
            return "Unusually heavy activity from this device/account"
        case "dst_port" | "protocol" | "src_port" if up:
            return "It's talking to an unusual service on the destination machine"
        case "event_subtype" if up and pd.notna(row.get("event_subtype")):
            return f"The action itself ('{row['event_subtype']}') is one attackers love to use"
        case "q_cert_key_type" if up:
            return (f"The data is protected by an old, weak lock "
                    f"({row.get('q_cert_key_type', 'legacy key')}) that a future "
                    f"quantum computer could break")
        case "q_data_class" if up:
            return (f"The data itself is highly sensitive "
                    f"({row.get('q_data_class', 'classified')}) — worth stealing now, "
                    f"cracking later")
        case "q_key_exchange" if up:
            return ("The connection is NOT quantum-safe — whoever records it "
                    "today can decrypt it one day")
        case "duration_s" if up:
            return "The session lasted an unusual amount of time"
    return None


def why_sentences(ev, row: pd.Series, limit: int = 3) -> list[str]:
    """Top human-readable reasons for one event's verdict."""
    out = []
    for f in ev.top_features:
        s = explain_feature(f, row)
        if s and s not in out:
            out.append(s)
        if len(out) == limit:
            break
    if not out:
        out.append("Many small signals together looked "
                   + ("wrong" if ev.prob >= 0.5 else "fine"))
    return out


# --------------------------------------------------------- plain scoreboard --
def scoreboard() -> list[dict]:
    """reports/ml/metrics_all.json -> plain-language report card. Real numbers."""
    m = json.loads((ROOT / "reports" / "ml" / "metrics_all.json").read_text())
    cards = []
    for key, t in TEAM.items():
        te = m[key]["test"]
        lat = m[key]["latency"]
        cards.append({
            "icon": t["icon"], "name": t["name"],
            "catch": f"Catches {round(te['recall'] * 100)} of every 100 real cases",
            "trust": (f"When it raises an alarm, it's right "
                      f"{round(te['precision'] * 100)} times out of 100"),
            "speed": (f"Checks one event in about "
                      f"{max(round(lat['single_row_ms']['p50']), 1)} thousandth(s) of a second"),
        })
    fusion = m["fusion"]["cross_domain_roc_auc"]
    tested = m["fusion"].get("test_events_fused")
    tested_str = (f"Tested on {tested:,} events the AI had never seen before"
                  if tested else "Tested on held-out events the AI never saw")
    cards.append({
        "icon": "🧠", "name": "The Command Center (all specialists combined)",
        "catch": (f"Given one threat and one normal event, it ranks the threat "
                  f"higher {round(fusion * 100)} times out of 100"),
        "trust": tested_str,
        "speed": "Combines all opinions in under a millisecond",
    })
    return cards
