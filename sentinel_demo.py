#!/usr/bin/env python
"""Sentinel Fusion AI — terminal SOC demonstration.

    python sentinel_demo.py                     # account-takeover attack story
    python sentinel_demo.py --scenario benign   # routine transaction
    python sentinel_demo.py --all               # both, back to back
    python sentinel_demo.py --fast              # no dramatic pauses

Real trained models, real Risk Fusion Engine, live SHAP, real threat-intel
lookups. Event data is simulated from real labeled test rows; predictions are
never faked.
"""
from __future__ import annotations

import argparse

from rich.console import Console

from demo import render
from demo.engine import DemoEngine


def run_scenario(console: Console, engine: DemoEngine, name: str) -> None:
    events, meta = engine.load_scenario(name)
    render.waiting(console, meta["title"])
    render.show_events(console, events, meta)
    incident = engine.analyze(events, meta)
    render.feature_engineering(console, incident)
    render.routing_and_predictions(console, incident)
    render.fusion(console, incident)
    render.explainability(console, incident)
    render.threat_intel(console, incident)
    if len(incident.events) > 1:
        render.timeline(console, incident)
    render.final_report(console, incident, engine, meta)
    render.performance(console, incident, engine)
    render.completion(console)


def main() -> None:
    ap = argparse.ArgumentParser(description="Sentinel Fusion AI terminal demo")
    ap.add_argument("--scenario", choices=["attack", "benign"], default="attack")
    ap.add_argument("--all", action="store_true", help="run every scenario")
    ap.add_argument("--fast", action="store_true", help="skip dramatic pauses")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    console = Console(no_color=args.no_color, highlight=False)
    console._demo_fast = args.fast  # read by render._sleep

    render.banner(console)
    engine = DemoEngine()
    render.loading(console, engine)

    for name in (["attack", "benign"] if args.all else [args.scenario]):
        run_scenario(console, engine, name)


if __name__ == "__main__":
    main()
