"""Conformance generator for the FinSpark export contract.

**Scaffolding, not a dataset.** This emits events that match
``docs/finspark_export_spec.md`` so the whole path — loader, validation,
label-lag replay, corpus assembly, retrain, calibration — can be exercised
before the bank's real export exists. Everything it writes is tagged
``source_dataset="finspark_synth"`` and carries ``synthetic=true``, so it can
never be mistaken for real bank traffic in a corpus or a report.

    python notebooks/finspark_gen.py --out data/raw/financial/finspark \\
        --customers 400 --days 120

Replace with the real export and rerun ``notebooks/src/15_finspark.py``; the
loader treats both identically apart from the source name.

Design points that matter for what this is testing:

* **Whole customer sequences.** Every event for a chosen customer is emitted, in
  time order. Sub-sampling a customer is what killed the v1 history features.
* **Real confirmation lag.** Positives carry ``label.confirmedAt`` drawn from a
  lognormal delay, and only a fraction are ever confirmed — this is the field
  the offline label replay needs.
* **No label-derived fields.** No severity, no rule verdict, nothing that is a
  function of the target.
* **Context events outnumber payments**, as on a real channel, so ``/ingest``
  and the velocity features get a realistic workout.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

CHANNELS = ["mobile", "web", "atm", "pos", "branch"]
MCCS = ["grocery_pos", "shopping_net", "travel", "gas_transport", "entertainment",
        "health_fitness", "home", "kids_pets", "personal_care", "food_dining"]
CONTEXT_TYPES = ["balance_check", "statement_view"]
DEVICE_OS = ["iOS", "Android", "Windows", "macOS", "other"]


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def generate(customers: int, days: int, seed: int, fraud_rate: float,
             start: datetime) -> list[dict]:
    rng = random.Random(seed)
    events: list[dict] = []

    for c in range(customers):
        uid = f"cust-{c:06d}"
        device = f"dev-{c:06d}"
        os_name = rng.choice(DEVICE_OS)
        home = rng.choice(["GB", "GB", "GB", "IE", "FR"])   # mostly domestic
        opened = start - timedelta(days=rng.randint(60, 3000))
        balance = rng.uniform(300, 25_000)
        # Each customer has a stable spend profile — this is what makes
        # amount-vs-own-history meaningful rather than noise.
        typical = rng.lognormvariate(math.log(45), 0.6)
        payees = [f"bene-{c:06d}-{i}" for i in range(rng.randint(2, 8))]
        # Payees are added at spread-out times, not all at account opening.
        # Without this, every benign payment goes to an old payee and every
        # fraud to a fresh one, making `isNew` a near-perfect alias of the label
        # — which prep_utils.assert_no_label_alias correctly rejects. Real
        # customers add a payee and pay it minutes later all the time; that
        # legitimate overlap is exactly what the model has to learn to handle.
        payee_added: dict[str, datetime] = {
            p: start - timedelta(days=rng.uniform(0, 400)) for p in payees}
        per_day = rng.uniform(0.6, 4.0)
        t = start

        while t < start + timedelta(days=days):
            t += timedelta(seconds=rng.expovariate(per_day / 86400.0))
            if t >= start + timedelta(days=days):
                break

            roll = rng.random()
            if roll < 0.45:                                   # context event
                events.append(_context(uid, device, os_name, home, t, rng))
                continue
            if roll < 0.52:                                   # login
                events.append(_login(uid, device, os_name, home, t, rng))
                continue
            if roll < 0.56 or not payee_added:                # beneficiary add
                p = rng.choice(payees)
                payee_added[p] = t
                events.append(_beneficiary(uid, device, home, p, t))
                continue

            # ---- payment ----
            is_fraud = rng.random() < fraud_rate
            if is_fraud:
                # Fraud signature: large relative to the customer's own norm,
                # a payee added minutes ago, overnight, often a name mismatch.
                amount = round(typical * rng.uniform(8, 60), 2)
                payee = f"bene-mule-{rng.randint(0, 9999)}"
                payee_added[payee] = t - timedelta(minutes=rng.randint(2, 90))
                t_ev = t.replace(hour=rng.choice([1, 2, 3, 4, 23]))
                name_mismatch = 1 if rng.random() < 0.7 else 0
                foreign = 1 if rng.random() < 0.5 else 0
            else:
                amount = round(max(1.0, rng.lognormvariate(math.log(typical), 0.5)), 2)
                payee = rng.choice(payees)
                # ~15% of legitimate payments go to a payee added in the last
                # day — the benign overlap that stops isNew being a giveaway.
                if rng.random() < 0.15:
                    payee_added[payee] = t - timedelta(minutes=rng.randint(1, 1400))
                payee_added.setdefault(payee, opened)
                t_ev = t
                name_mismatch = 1 if rng.random() < 0.02 else 0
                foreign = 1 if rng.random() < 0.03 else 0

            amount = min(amount, max(balance, 1.0))
            before, after = balance, max(0.0, balance - amount)
            balance = after if rng.random() > 0.15 else rng.uniform(300, 25_000)

            events.append(_payment(
                uid, device, os_name, home, t_ev, amount, payee,
                (t_ev - payee_added[payee]).total_seconds(), name_mismatch,
                foreign, before, after, opened, is_fraud, rng, events))
    events.sort(key=lambda e: e["eventTime"])
    return events


def _base(uid, device, home, t, etype):
    return {"eventId": f"fs-{uid}-{int(t.timestamp() * 1000)}-{etype[:3]}",
            "eventTime": _iso(t), "eventType": etype, "userId": uid,
            "deviceId": device, "country": home,
            "label": {"value": -1, "type": "none"}, "synthetic": True}


def _context(uid, device, os_name, home, t, rng):
    e = _base(uid, device, home, t, rng.choice(CONTEXT_TYPES))
    e["channel"] = rng.choice(["mobile", "web"])
    e["device"] = {"os": os_name, "isNew": 0, "sessionLengthSeconds": rng.randint(20, 900)}
    return e


def _login(uid, device, os_name, home, t, rng):
    e = _base(uid, device, home, t, "login")
    e["channel"] = rng.choice(["mobile", "web"])
    e["device"] = {"os": os_name, "isNew": 1 if rng.random() < 0.05 else 0,
                   "sessionLengthSeconds": rng.randint(30, 1800),
                   "isForeignRequest": 1 if rng.random() < 0.04 else 0}
    e["label"] = {"value": 0, "type": "none"}
    return e


def _beneficiary(uid, device, home, payee, t):
    e = _base(uid, device, home, t, "beneficiary_add")
    e["counterparty"] = {"id": payee, "country": home, "isNew": 1, "ageSeconds": 0}
    return e


def _payment(uid, device, os_name, home, t, amount, payee, payee_age,
             name_mismatch, foreign, before, after, opened, is_fraud, rng, sofar):
    e = _base(uid, device, home, t, "payment_initiation")
    e["channel"] = rng.choice(CHANNELS)
    e["amount"] = amount
    e["currency"] = "GBP"
    e["paymentType"] = "transfer"
    e["isCredit"] = False
    e["balanceBefore"] = round(before, 2)
    e["balanceAfter"] = round(after, 2)
    e["merchant"] = {"id": f"mrc-{rng.randint(0, 400)}",
                     "category": rng.choice(MCCS)}
    e["counterparty"] = {
        "id": payee, "country": home if rng.random() > 0.1 else "RO",
        "isNew": 1 if payee_age < 86400 else 0,
        "ageSeconds": max(0.0, payee_age),
        "nameMismatch": name_mismatch,
        "balanceBefore": round(rng.uniform(0, 5000), 2),
        "balanceAfter": round(rng.uniform(0, 9000), 2),
    }
    e["customer"] = {"age": rng.randint(18, 85),
                     "accountAgeSeconds": (t - opened).total_seconds(),
                     "income": round(rng.random(), 2),
                     "emailIsFree": 1 if rng.random() < 0.4 else 0}
    e["device"] = {"os": os_name, "isNew": 1 if (is_fraud and rng.random() < 0.6)
                   else (1 if rng.random() < 0.05 else 0),
                   "sessionLengthSeconds": rng.randint(15, 1200),
                   "isForeignRequest": foreign}
    e["geo"] = {"lat": round(51.5 + rng.uniform(-2, 2), 4),
                "lon": round(-0.12 + rng.uniform(-2, 2), 4)}
    # The bank's own precomputed view (§3.3).
    e["bankComputed"] = {
        "txnCountLastHour": rng.randint(3, 12) if is_fraud else rng.randint(0, 2),
        "amountVsUserMean": round(amount / max(1.0, rng.uniform(30, 90)), 2),
        "beneficiaryAgeMinutes": round(max(0.0, payee_age) / 60.0, 2),
        "isNewBeneficiary": 1 if payee_age < 86400 else 0,
    }
    if is_fraud:
        # Confirmation lag: skewed, and only some frauds are ever adjudicated.
        if rng.random() < 0.65:
            delay = timedelta(seconds=rng.lognormvariate(math.log(4 * 86400), 0.8))
            e["label"] = {"value": 1, "type": "fraud",
                          "confirmedAt": _iso(t + delay), "source": "chargeback"}
        else:
            e["label"] = {"value": 1, "type": "fraud", "source": "chargeback"}
    else:
        e["label"] = {"value": 0, "type": "none", "confirmedAt": _iso(t),
                      "source": "rule"}
    return e


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("data/raw/financial/finspark"))
    ap.add_argument("--customers", type=int, default=400)
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--fraud-rate", type=float, default=0.006)
    a = ap.parse_args()

    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    events = generate(a.customers, a.days, a.seed, a.fraud_rate, start)
    a.out.mkdir(parents=True, exist_ok=True)
    path = a.out / "events_synthetic_0001.jsonl"
    with path.open("w") as fh:
        for e in events:
            fh.write(json.dumps(e, separators=(",", ":")) + "\n")

    pays = [e for e in events if e["eventType"] == "payment_initiation"]
    frauds = [e for e in pays if e["label"]["value"] == 1]
    print(f"{path}: {len(events):,} events, {len(pays):,} payments, "
          f"{len(frauds):,} fraud ({len(frauds) / max(len(pays), 1):.3%})")
    print(f"customers={a.customers}  events/customer={len(events) / a.customers:.0f}")
    print(f"confirmed frauds={sum('confirmedAt' in e['label'] for e in frauds):,}")


if __name__ == "__main__":
    main()
