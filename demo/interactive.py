"""Interactive menu experience — pick what to see, follow it in plain words.

Everything shown is computed live by the real models (demo.engine); this
module only decides what to show next and says it in human language.
"""
from __future__ import annotations

from rich import box
from rich.align import Align
from rich.console import Console, Group
from rich.panel import Panel
from rich.prompt import IntPrompt, Prompt
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

from . import render
from .engine import DemoEngine
from .narrative import FUSION_PLAIN, TEAM, meter, scoreboard, suspicion_phrase, why_sentences

MENU = [
    ("🚨", "Watch a live attack get caught", "attack_story"),
    ("✅", "Watch a normal customer sail through", "benign_story"),
    ("🧠", "Meet the AI team — who watches what", "team"),
    ("🔍", "Step through the attack, one event at a time", "step"),
    ("📊", "Report card — how good is this AI really?", "score"),
    ("🚪", "Exit", "exit"),
]


def main_menu(console: Console, engine: DemoEngine) -> None:
    while True:
        console.print()
        t = Table(box=box.ROUNDED, show_header=False, border_style="cyan",
                  title="[bold]What would you like to see?[/bold]", padding=(0, 2))
        t.add_column(width=3, justify="right")
        t.add_column(width=4)
        t.add_column()
        for i, (icon, label, _) in enumerate(MENU, 1):
            t.add_row(f"[bold cyan]{i}[/bold cyan]", icon, label)
        console.print(t)
        choice = IntPrompt.ask("[bold cyan]Pick a number[/bold cyan]",
                               choices=[str(i) for i in range(1, len(MENU) + 1)],
                               console=console)
        action = MENU[choice - 1][2]
        if action == "exit":
            console.print("\n[dim]Sentinel Fusion AI — session ended. "
                          "Stay safe out there.[/dim]\n")
            return
        console.clear()
        {"attack_story": lambda: _auto_story(console, engine, "attack"),
         "benign_story": lambda: _auto_story(console, engine, "benign"),
         "team": lambda: _team(console),
         "step": lambda: _step_through(console, engine),
         "score": lambda: _scoreboard(console)}[action]()
        Prompt.ask("\n[dim]Press Enter to go back to the menu[/dim]",
                   default="", show_default=False, console=console)
        console.clear()


# ------------------------------------------------------------ full stories --
def _auto_story(console: Console, engine: DemoEngine, scenario: str) -> None:
    events, meta = engine.load_scenario(scenario)
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


# -------------------------------------------------------------- meet the AI --
def _team(console: Console) -> None:
    console.print(Rule("[bold]The four watchers, in plain words[/bold]",
                       style="cyan"))
    for t in TEAM.values():
        body = Group(
            Text(t["what"]),
            Text(f"\nGood at catching: {t['catches']}", style="italic dim"),
            Text(f"Under the hood: {t['tech']}", style="dim"))
        console.print(Panel(body, title=f"{t['icon']}  [bold]{t['name']}[/bold]",
                            border_style="cyan", box=box.ROUNDED))
    console.print(Panel(Text(FUSION_PLAIN), title="🧠  [bold]The Command Center[/bold]",
                        border_style="magenta", box=box.HEAVY))


# ------------------------------------------------------------- step-through --
def _step_through(console: Console, engine: DemoEngine) -> None:
    events, meta = engine.load_scenario("attack")
    incident = engine.analyze(events, meta)
    rows = {r["event_id"]: r for _, r in events.iterrows()}

    console.print(Panel(Text(
        "A criminal has stolen a customer's password. Over the next seven "
        "minutes they will try to break in, steal data, and move money out.\n"
        "You'll see each move — and what the AI thinks — one step at a time.",
        justify="center"), title="[bold]The story you're about to watch[/bold]",
        border_style="cyan", box=box.DOUBLE, padding=(1, 4)))

    for i, ev in enumerate(incident.events, 1):
        Prompt.ask(f"\n[bold cyan]Press Enter for event {i} of "
                   f"{len(incident.events)}[/bold cyan]",
                   default="", show_default=False, console=console)
        row = rows[ev.event_id]

        # what happened, in words
        console.print(Panel(
            Text(f"{ev.time_str}  —  {ev.headline}", style="bold"),
            border_style="blue", box=box.ROUNDED))

        # who looked at it + verdict
        watcher = TEAM[ev.model_key]
        headline, style = suspicion_phrase(ev.prob)
        v = Table(box=None, show_header=False, pad_edge=False)
        v.add_column(width=18, style="dim")
        v.add_column()
        v.add_row("Who checked it", f"{watcher['icon']} {watcher['name']}")
        v.add_row("Suspicion meter", meter(ev.prob))
        v.add_row("Verdict", f"[{style}]{headline}[/{style}]")
        v.add_row("Time to decide", f"{ev.infer_ms:.1f} ms — faster than a blink")
        console.print(v)

        # why, in words
        console.print("[bold]  Why the AI thinks so:[/bold]")
        for s in why_sentences(ev, row):
            console.print(f"    [cyan]•[/cyan] {s}")
        for m in ev.ti_matches:
            console.print(f"    [red]⚠ Cross-checked worldwide criminal watchlists: "
                          f"{m}[/red]")

    # the combined picture
    Prompt.ask("\n[bold cyan]Press Enter to see the Command Center's final "
               "call[/bold cyan]", default="", show_default=False, console=console)
    fused = incident.fused
    headline, style = suspicion_phrase(fused["risk_score"])
    parts = [f"{TEAM[k]['icon']} {TEAM[k]['name']}: {meter(v, 12)}"
             for k, v in ((k, incident.domain_max[k]) for k in incident.domain_max)]
    console.print(Panel(Group(
        Text(FUSION_PLAIN + "\n", style="italic"),
        *[Text.from_markup(p) for p in parts],
        Text(""),
        Text.from_markup(f"FINAL THREAT LEVEL: [{style}]{fused['risk_level'].upper()}"
                         f"[/{style}]  —  {meter(fused['risk_score'])}"),
        Text.from_markup(f"[{style}]{headline}[/{style}]")),
        title="🧠 [bold]Command Center[/bold]", border_style="magenta",
        box=box.HEAVY, padding=(1, 2)))

    console.print("[bold]What the bank does next, automatically:[/bold]")
    for a in engine.actions(fused["risk_level"])[:4]:
        console.print(f"  [red]▶[/red] {a}")


# --------------------------------------------------------------- scoreboard --
def _scoreboard(console: Console) -> None:
    console.print(Rule("[bold]Report card — measured on 306,556 events the AI "
                       "never saw during training[/bold]", style="cyan"))
    for c in scoreboard():
        t = Table(box=None, show_header=False, pad_edge=False)
        t.add_column(width=14, style="dim")
        t.add_column()
        t.add_row("Catch rate", c["catch"])
        t.add_row("Trustworthy?", c["trust"])
        t.add_row("Speed", c["speed"])
        console.print(Panel(t, title=f"{c['icon']}  [bold]{c['name']}[/bold]",
                            border_style="cyan", box=box.ROUNDED))
    console.print(Align.center(Text(
        "Every number above comes straight from the saved test results — "
        "nothing rounded up.", style="dim italic")))
