from __future__ import annotations

import argparse
import json
import random
import re
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
RUN = re.compile(r"(?:-r|run)(\d+)(?:-|$)")
REFUSALS = {"refusal", "refused", "content_filter", "content_filtered"}


def load_run(prefix: str, jobs_dir: Path) -> dict:
    graded: dict[tuple[str, str], dict] = {}
    running: dict[str, int] = defaultdict(int)
    for job in sorted(p for p in jobs_dir.iterdir() if p.is_dir() and p.name.startswith(prefix)):
        match = RUN.search(job.name[len(prefix):]) or RUN.search(job.name)
        run = f"r{match.group(1)}" if match else job.name
        for trial in job.glob("*__*"):
            try:
                result = json.loads((trial / "result.json").read_text())
            except (OSError, ValueError):
                result = {}
            task = trial.name.split("__")[0]
            if not result.get("finished_at"):
                running[run] += 1
                continue
            reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")
            agent = result.get("agent_result") or {}
            span = result.get("agent_execution") or {}
            previous = graded.get((run, task))
            if previous and previous["finished_at"] > result["finished_at"]:
                continue
            graded[(run, task)] = {
                "finished_at": result["finished_at"],
                "passed": reward == 1,
                "error": (result.get("exception_info") or {}).get("exception_type") if reward is None else None,
                "stop_reason": (agent.get("metadata") or {}).get("stop_reason"),
                "cost": agent.get("cost_usd"),
                "seconds": _seconds(span),
            }
    return {"graded": graded, "running": running}


def _seconds(span: dict) -> float | None:
    try:
        return (datetime.fromisoformat(span["finished_at"]) - datetime.fromisoformat(span["started_at"])).total_seconds()
    except (KeyError, TypeError, ValueError):
        return None


def load_baseline(name: str) -> tuple[str, str, dict[str, list[dict]]]:
    data = json.loads((HERE / "viewer" / "data" / f"{name}-baseline.json").read_text())
    by_task: dict[str, list[dict]] = defaultdict(list)
    for trial in data["trials"]:
        trajectory = trial.get("trajectory") or {}
        by_task[trial["task"]].append({
            "passed": trial.get("reward") == 1,
            "cost": trajectory.get("costUsd"),
            "seconds": trajectory.get("agentSeconds"),
        })
    return data["label"], data["leaderboardRowUrl"], by_task


def _mean(values) -> float | None:
    values = [v for v in values if v is not None]
    return statistics.fmean(values) if values else None


def _per_task_mean(by_task: dict[str, list[dict]], tasks: list[str], key: str) -> float | None:
    return _mean(_mean(t[key] for t in by_task[task]) for task in tasks)


def bootstrap(ours: list[float], theirs: list[float], n: int = 2000, seed: int = 7) -> tuple[float, float]:
    rng = random.Random(seed)
    diffs = []
    for _ in range(n):
        sample = [rng.randrange(len(ours)) for _ in ours]
        diffs.append(statistics.fmean(ours[i] - theirs[i] for i in sample))
    diffs.sort()
    return diffs[int(0.025 * n)], diffs[int(0.975 * n) - 1]


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{100 * value:.1f}%"


def _usd(value: float | None) -> str:
    return "—" if value is None else f"${value:.2f}"


def _duration(value: float | None) -> str:
    if value is None:
        return "—"
    minutes = round(value / 60)
    return f"{minutes // 60}h {minutes % 60:02d}m" if minutes >= 60 else f"{minutes}m"


def _ratio(ours: float | None, theirs: float | None) -> str:
    return f"{ours / theirs:.2f}×" if ours is not None and theirs else "—"


def table(rows: list[list[str]]) -> str:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    lines = ["| " + " | ".join(cell.ljust(w) for cell, w in zip(row, widths)) + " |" for row in rows]
    lines.insert(1, "|" + "|".join("-" * (w + 2) for w in widths) + "|")
    return "\n".join(lines)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="omnara-tb compare", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("prefix", help="Job directory prefix of the run, e.g. tb4.0-prod-opus-high.")
    parser.add_argument("--baseline", required=True, help="claude-code or codex (viewer/data/<name>-baseline.json).")
    parser.add_argument("--jobs-dir", default=str(HERE / "jobs"))
    parser.add_argument("--tasks", action="store_true", help="Also print one row per task.")
    args = parser.parse_args(argv)

    run = load_run(args.prefix, Path(args.jobs_dir))
    label, url, base = load_baseline(args.baseline)
    ours: dict[str, list[dict]] = defaultdict(list)
    for (_, task), trial in run["graded"].items():
        ours[task].append(trial)
    runs = sorted({r for r, _ in run["graded"]} | set(run["running"]), key=lambda r: (len(r), r))
    common = sorted(t for t in ours if t in base)

    print(f"{args.prefix} vs {label}\n{url}\n")
    progress = [["Run", "Graded", "Passed", "Errors", "Running"]]
    for r in runs:
        mine = [t for (rr, _), t in run["graded"].items() if rr == r]
        progress.append([r, str(len(mine)), str(sum(t["passed"] for t in mine)),
                         str(sum(bool(t["error"]) for t in mine)), str(run["running"].get(r, 0))])
    print(table(progress) + "\n")

    if not common:
        print("No graded trials yet.")
        return
    ours_rate = [_mean(t["passed"] for t in ours[task]) for task in common]
    base_rate = [_mean(t["passed"] for t in base[task]) for task in common]
    low, high = bootstrap(ours_rate, base_rate)
    passed = sum(t["passed"] for task in common for t in ours[task])
    graded = sum(len(ours[task]) for task in common)
    cost = (_per_task_mean(ours, common, "cost"), _per_task_mean(base, common, "cost"))
    seconds = (_per_task_mean(ours, common, "seconds"), _per_task_mean(base, common, "seconds"))
    summary = [
        ["", "Omnara", label.split(" · ")[0], "Omnara − baseline"],
        ["Pass rate", f"{_pct(statistics.fmean(ours_rate))} ({passed}/{graded} trials)", _pct(statistics.fmean(base_rate)),
         f"{100 * (statistics.fmean(ours_rate) - statistics.fmean(base_rate)):+.1f} pts (95% {100 * low:+.1f} to {100 * high:+.1f})"],
        ["Cost per trial", _usd(cost[0]), _usd(cost[1]), _ratio(*cost)],
        ["Agent time per trial", _duration(seconds[0]), _duration(seconds[1]), _ratio(*seconds)],
    ]
    print(f"Over {len(common)} task(s) graded so far:\n" + table(summary))

    if args.tasks:
        rows = [["Task", "Omnara", "Baseline", "Omnara cost", "Baseline cost", "Notes"]]
        for task in sorted(ours):
            mine, theirs = ours[task], base.get(task, [])
            notes = sorted({t["error"] or t["stop_reason"] for t in mine
                            if t["error"] or t["stop_reason"] in REFUSALS})
            rows.append([task, f"{sum(t['passed'] for t in mine)}/{len(mine)}",
                         f"{sum(t['passed'] for t in theirs)}/{len(theirs)}" if theirs else "—",
                         _usd(_mean(t["cost"] for t in mine)), _usd(_mean(t["cost"] for t in theirs)), ", ".join(notes)])
        print("\n" + table(rows))
