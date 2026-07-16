"""SOC-style terminal rendering (rich). Pure presentation — every number
shown here arrives computed by demo.engine from the real models."""
from __future__ import annotations

import time

import pandas as pd
from rich import box
from rich.align import Align
from rich.console import Console, Group
from rich.panel import Panel
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

from .engine import MODEL_TITLES, DemoEngine, IncidentResult

LEVEL_STYLE = {"low": "bold green", "medium": "bold yellow",
               "high": "bold dark_orange", "critical": "bold red"}
DOMAIN_ICON = {"behaviour": "👤", "cyber": "🖥 ", "financial": "💳", "quantum": "🔐"}


def _sleep(console: Console, secs: float) -> None:
    if not getattr(console, "_demo_fast", False):
        time.sleep(secs)


def banner(console: Console) -> None:
    title = Text("SENTINEL FUSION AI", style="bold bright_cyan", justify="center")
    sub = Text("AI-Driven Cybersecurity & Transaction Correlation Engine",
               style="cyan", justify="center")
    console.print(Panel(Group(Align.center(title), Align.center(sub)),
                        box=box.DOUBLE, border_style="bright_cyan", padding=(1, 4)))


def loading(console: Console, engine: DemoEngine) -> None:
    console.print("\n[bold]Loading AI Components...[/bold]\n")
    with Progress(SpinnerColumn(style="cyan"),
                  TextColumn("[progress.description]{task.description}"),
                  console=console, transient=True) as prog:
        task = prog.add_task("initializing", total=None)

        def cb(name, ms):
            prog.update(task, description=f"loading {name}")
            console.print(f"  [green]✓[/green] {name:34s} [dim]{ms:7.1f} ms[/dim]")
        engine.load(progress_cb=cb)
    console.print("\n  [bold green]Models Ready[/bold green]"
                  "\n  [bold green]Inference Engine Ready[/bold green]\n")


def waiting(console: Console, title: str) -> None:
    console.print(Rule(style="dim"))
    with console.status("[cyan]Waiting for incoming banking event stream...",
                        spinner="dots"):
        _sleep(console, 1.2)
    console.print(f"[bold bright_white on red] INCOMING EVENT STREAM [/] "
                  f"[bold]{title}[/bold]\n")


def _fmt(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)) or pd.isna(v):
        return "[dim]—[/dim]"
    if isinstance(v, float):
        return f"{v:,.2f}"
    return str(v)


def show_events(console: Console, events: pd.DataFrame, meta: dict) -> None:
    heads = {e["event_id"]: e for e in meta["events"]}
    for _, r in events.iterrows():
        h = heads.get(r["event_id"], {})
        t = Table(box=box.SIMPLE, show_header=False, pad_edge=False)
        t.add_column(style="dim", width=16)
        t.add_column()
        t.add_row("Event ID", f"[bold]{r['event_id']}[/bold]")
        t.add_row("Timestamp", str(r["event_time"]))
        t.add_row("User", _fmt(r.get("user_id")))
        t.add_row("Device", _fmt(r.get("device_id")))
        t.add_row("Domain / Type", f"{r['event_domain']} / {_fmt(r.get('event_type'))}"
                                   f" ({_fmt(r.get('event_subtype'))})")
        t.add_row("Country", _fmt(r.get("country")))
        if pd.notna(r.get("amount")):
            t.add_row("Amount", f"[bold]{r['amount']:,.2f}[/bold]")
        if pd.notna(r.get("dst_ip")):
            t.add_row("Destination IP", f"{r['dst_ip']}:{_fmt(r.get('dst_port'))}")
        if pd.notna(r.get("bytes_out")):
            t.add_row("Bytes out", f"{r['bytes_out']:,.0f}")
        if pd.notna(r.get("attack_technique")):
            t.add_row("Technique", str(r["attack_technique"]))
        console.print(Panel(t, title=f"[bold]{h.get('time', '')}  "
                                     f"{h.get('headline', 'event')}[/bold]",
                            border_style="blue", box=box.ROUNDED))
        _sleep(console, 0.35)


def feature_engineering(console: Console, incident: IncidentResult) -> None:
    console.print(Rule("[bold]Feature Engineering[/bold]", style="cyan"))
    seen, rows = set(), []
    for ev in incident.events:
        for f in ev.top_features:
            if f["feature"] not in seen and f["value"] is not None:
                seen.add(f["feature"])
                rows.append(f)
    with console.status("[cyan]Extracting behavioural, transactional and "
                        "volumetric features...", spinner="line"):
        _sleep(console, 0.9)
    t = Table(box=box.SIMPLE_HEAD, show_header=True, header_style="dim")
    t.add_column("engineered feature"); t.add_column("value", justify="right")
    for f in rows[:12]:
        t.add_row(f"[green]✓[/green] {f['label']}", _fmt(f["value"]))
    console.print(t)
    n_total = sum(len({x['feature'] for x in ev.top_features}) for ev in incident.events)
    console.print(f"  [dim]{len(seen)} distinct features shown — "
                  f"{n_total} model-feature evaluations across "
                  f"{len(incident.events)} events[/dim]\n")


def routing_and_predictions(console: Console, incident: IncidentResult) -> None:
    console.print(Rule("[bold]Model Routing & Inference[/bold]", style="cyan"))
    with Progress(SpinnerColumn(style="cyan"), TextColumn("{task.description}"),
                  BarColumn(bar_width=24), console=console, transient=True) as prog:
        for ev in incident.events:
            tid = prog.add_task(f"{MODEL_TITLES[ev.model_key]:26s}", total=1)
            _sleep(console, 0.25)
            prog.update(tid, completed=1)

    for ev in incident.events:
        style = "red" if ev.prob >= 0.5 else "green"
        bar_len = int(ev.prob * 30)
        bar = f"[{style}]{'█' * bar_len}[/{style}][dim]{'░' * (30 - bar_len)}[/dim]"
        body = Table(box=None, show_header=False, pad_edge=False)
        body.add_column(width=14, style="dim"); body.add_column()
        body.add_row("Probability", f"{bar} [{style}]{ev.prob:6.1%}[/{style}]")
        body.add_row("Raw score", f"{ev.raw_score:.4f}")
        body.add_row("Confidence", f"{ev.confidence:.1%}")
        body.add_row("Inference", f"{ev.infer_ms:.2f} ms  [dim](+{ev.shap_ms:.0f} ms SHAP)[/dim]")
        console.print(Panel(body, title=f"{DOMAIN_ICON[ev.domain]} "
                                        f"[bold]{MODEL_TITLES[ev.model_key]}[/bold] "
                                        f"— {ev.event_id}",
                            border_style=style, box=box.ROUNDED))
        _sleep(console, 0.3)


def fusion(console: Console, incident: IncidentResult) -> None:
    console.print(Rule("[bold]Risk Fusion Engine[/bold]", style="cyan"))
    fused = incident.fused
    lvl_style = LEVEL_STYLE[fused["risk_level"]]

    inputs = "   ".join(f"{MODEL_TITLES[k].split()[0]} {v:.3f}"
                        for k, v in incident.domain_max.items())
    diagram = Text.from_markup(
        f"[bold]{inputs}[/bold]\n"
        f"{' ' * 20}│\n"
        f"{' ' * 12}▼  calibration (isotonic) + weighted noisy-OR\n"
        f"{' ' * 12}[bold]risk = 1 − Π(1 − wᵢ·pᵢ)[/bold]\n"
        f"{' ' * 20}│\n"
        f"{' ' * 12}▼\n"
        f"{' ' * 6}UNIFIED THREAT SCORE: [{lvl_style}]{fused['risk_score']:.4f}"
        f"  ({fused['risk_level'].upper()})[/{lvl_style}]")
    console.print(Panel(diagram, border_style="magenta", box=box.HEAVY))

    t = Table(box=box.SIMPLE_HEAD, header_style="dim")
    t.add_column("model"); t.add_column("weight", justify="right")
    t.add_column("calibrated p", justify="right")
    t.add_column("contribution w·p", justify="right")
    for k, c in fused["contributions"].items():
        w = incident.timings["weights"][k]
        t.add_row(MODEL_TITLES[k], f"{w:.1f}", f"{c / w:.4f}", f"[bold]{c:.4f}[/bold]")
    console.print(t)
    console.print()


def explainability(console: Console, incident: IncidentResult) -> None:
    console.print(Rule("[bold]Explainable AI — Top Contributing Signals[/bold]",
                       style="cyan"))
    pool: dict[str, dict] = {}
    for ev in incident.events:
        for f in ev.top_features:
            cur = pool.get(f["label"])
            if cur is None or f["pct"] > cur["pct"]:
                pool[f["label"]] = {**f, "model": MODEL_TITLES[ev.model_key]}
    top = sorted(pool.values(), key=lambda f: f["pct"], reverse=True)[:7]
    t = Table(box=box.SIMPLE_HEAD, header_style="dim")
    t.add_column("#", width=3); t.add_column("signal"); t.add_column("model", style="dim")
    t.add_column("direction", justify="center"); t.add_column("weight", justify="right")
    for i, f in enumerate(top, 1):
        arrow = "[red]▲ raises risk[/red]" if f["shap"] > 0 else "[green]▼ lowers risk[/green]"
        bar = "▰" * max(1, int(f["pct"] / 4))
        t.add_row(str(i), f"[bold]{f['label']}[/bold]", f["model"], arrow,
                  f"{bar} {f['pct']:.0f}%")
    console.print(t)
    console.print("  [dim]SHAP TreeExplainer, computed live on this event[/dim]\n")


def threat_intel(console: Console, incident: IncidentResult) -> None:
    console.print(Rule("[bold]Threat Intelligence Correlation[/bold]", style="cyan"))
    hits = [(ev.event_id, m) for ev in incident.events for m in ev.ti_matches]
    if not hits:
        console.print("  [green]No Match[/green] — no indicators found in feeds\n")
        return
    t = Table(box=box.SIMPLE_HEAD, header_style="dim")
    t.add_column("event"); t.add_column("indicator match")
    for eid, m in hits:
        t.add_row(eid, f"[bold red]⚠ {m}[/bold red]")
    console.print(t)
    console.print("  [dim]feeds: Feodo Tracker C2 list, MITRE ATT&CK[/dim]\n")


def timeline(console: Console, incident: IncidentResult) -> None:
    console.print(Rule("[bold]Correlation Timeline — Attack Chain[/bold]", style="cyan"))
    for i, ev in enumerate(incident.events):
        style = "red" if ev.prob >= 0.5 else "green"
        console.print(f"  [bold]{ev.time_str}[/bold]  [{style}]●[/{style}] "
                      f"{ev.headline}  [dim]p={ev.prob:.2f} ({ev.model_key})[/dim]")
        if i < len(incident.events) - 1:
            console.print("           [dim]│[/dim]")
            _sleep(console, 0.2)
    console.print("           [dim]▼[/dim]\n  [bold magenta]AI Correlation "
                  "Complete — events linked by user, device, time window[/bold magenta]\n")


def final_report(console: Console, incident: IncidentResult, engine: DemoEngine,
                 meta: dict) -> None:
    fused = incident.fused
    lvl = fused["risk_level"]
    style = LEVEL_STYLE[lvl]
    avg_conf = sum(ev.confidence for ev in incident.events) / len(incident.events)
    multi = len({ev.domain for ev in incident.events}) >= 3
    classification = (meta["title"] if lvl in ("high", "critical")
                      else "No coordinated threat detected")

    t = Table(box=box.SIMPLE, show_header=False)
    t.add_column(style="dim", width=26); t.add_column()
    t.add_row("Overall Threat Level", f"[{style}]{lvl.upper()}[/{style}]")
    t.add_row("Unified Risk Score", f"[{style}]{fused['risk_score']:.4f}[/{style}]")
    t.add_row("Incident Classification", classification)
    t.add_row("Attack Category", "Multi-vector (account takeover → exfil → fraud)"
              if multi and lvl != "low" else "Single-domain / none")
    t.add_row("Model Confidence (avg)", f"{avg_conf:.1%}")
    for ev in incident.events:
        verdict = ("[red]FLAGGED[/red]" if ev.prob >= 0.5 else "[green]clear[/green]")
        t.add_row(f"  {MODEL_TITLES[ev.model_key]}", f"{verdict}  p={ev.prob:.3f}")
    console.print(Panel(t, title=f"[{style}]■ SOC INCIDENT REPORT ■[/{style}]",
                        border_style=style.split()[-1], box=box.DOUBLE))

    console.print("[bold]Recommended Actions[/bold]")
    for a in engine.actions(lvl):
        console.print(f"  [{style}]▶[/{style}] {a}")
        _sleep(console, 0.12)
    console.print()


def performance(console: Console, incident: IncidentResult, engine: DemoEngine) -> None:
    console.print(Rule("[bold]Performance Metrics[/bold]", style="cyan"))
    tm = incident.timings
    load_total = sum(engine.load_ms.values())
    t = Table(box=box.SIMPLE_HEAD, header_style="dim")
    t.add_column("stage"); t.add_column("time", justify="right")
    t.add_row("Component load (once)", f"{load_total:,.0f} ms")
    t.add_row("Model inference (all events)", f"{tm['model_ms']:.2f} ms")
    t.add_row("SHAP explainability", f"{tm['shap_ms']:.0f} ms")
    t.add_row("Risk fusion", f"{tm['fusion_ms']:.2f} ms")
    t.add_row("[bold]Total analysis[/bold]", f"[bold]{tm['total_ms']:.0f} ms[/bold]")
    t.add_row("Memory (RSS)", f"{engine.rss_mb():,.0f} MB")
    t.add_row("Model version", engine.version)
    console.print(t)


def completion(console: Console) -> None:
    console.print(Panel(Group(
        Align.center(Text("Analysis Complete", style="bold green")),
        Align.center(Text("Incident Successfully Correlated", style="green")),
        Align.center(Text("Threat Intelligence Generated", style="green")),
        Align.center(Text("Ready For Next Event", style="dim"))),
        box=box.DOUBLE, border_style="green", padding=(1, 8)))
