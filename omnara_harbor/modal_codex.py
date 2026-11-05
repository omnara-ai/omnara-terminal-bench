from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import modal

APP = "tb-codex"
VOLUME = "tb-codex-jobs"
JOBS = "/jobs"
HERE = Path(__file__).resolve().parent.parent

app = modal.App(APP)
volume = modal.Volume.from_name(VOLUME, create_if_missing=True, version=2)
image = modal.Image.debian_slim(python_version="3.13").uv_pip_install("harbor[modal]==0.24.0", "modal==1.6.1")

HARBOR_ARGS = [
    "-a", "codex", "-m", "openai/gpt-6.1-sol",
    "--ak", "version=0.166.0", "--ak", "reasoning_effort=max", "--ak", "web_search=disabled",
    "-d", "terminal-bench/terminal-bench@4.0.0", "-e", "modal",
    "-r", "3",
    "--allow-agent-host", "openrouter.ai",
    "-q",
]

OPENROUTER_PROVIDER = {
    "model_provider": "openrouter",
    "model_providers": {
        "openrouter": {
            "name": "OpenRouter",
            "base_url": "https://openrouter.ai/api/v1",
            "env_key": "OPENAI_API_KEY",
            "wire_api": "responses",
            "supports_websockets": False,
            "capabilities": {"remote_compaction": "unsupported"},
        },
    },
}


JOB_OPTIONS = dict(
    image=image,
    volumes={JOBS: volume},
    timeout=24 * 3600,
    nonpreemptible=True,
    retries=modal.Retries(max_retries=3, initial_delay=30.0),
    cpu=2,
    memory=4096,
)


@app.function(**JOB_OPTIONS, secrets=[modal.Secret.from_name("codex-openrouter")])
def run_job(job_name: str, harbor_args: list[str]) -> int:
    return _run_job(job_name, harbor_args)


@app.function(**JOB_OPTIONS, secrets=[modal.Secret.from_name("codex-openai")])
def run_job_openai(job_name: str, harbor_args: list[str]) -> int:
    """Codex against api.openai.com with an OpenAI key instead of OpenRouter."""
    return _run_job(job_name, harbor_args)


def _run_job(job_name: str, harbor_args: list[str]) -> int:
    (Path.home() / ".modal.toml").touch()
    volume.reload()
    job_dir = Path(JOBS) / job_name
    if (job_dir / "config.json").exists():
        command = ["harbor", "jobs", "resume", "-p", str(job_dir)]
    else:
        command = ["harbor", "run", *harbor_args, "-o", JOBS, "--job-name", job_name]
    log = Path(JOBS) / "logs" / f"{job_name}.log"
    log.parent.mkdir(parents=True, exist_ok=True)

    stop = threading.Event()

    def commit_loop() -> None:
        while not stop.wait(60):
            volume.commit()

    committer = threading.Thread(target=commit_loop, daemon=True)
    committer.start()
    try:
        with log.open("a") as out:
            out.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {' '.join(command)}\n")
            out.flush()
            code = subprocess.call(command, stdout=out, stderr=subprocess.STDOUT)
            out.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} exited {code}\n")
    finally:
        stop.set()
        committer.join()
        volume.commit()
    return code


@app.function(image=image, volumes={JOBS: volume})
def status(prefix: str = "") -> dict[str, dict[str, int]]:
    volume.reload()
    jobs: dict[str, dict[str, int]] = {}
    for job in sorted(p for p in Path(JOBS).iterdir() if p.is_dir() and p.name.startswith(prefix) and p.name != "logs"):
        counts: dict[str, int] = {}
        for trial in job.glob("*__*"):
            try:
                result = json.loads((trial / "result.json").read_text())
            except (OSError, ValueError):
                result = {}
            if not result.get("finished_at"):
                key = "running"
            else:
                reward = ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")
                error = (result.get("exception_info") or {}).get("exception_type")
                key = f"reward={reward}" if reward is not None else f"err:{error}"
            counts[key] = counts.get(key, 0) + 1
        jobs[job.name] = dict(sorted(counts.items()))
    return jobs


SUMMARY_FIELDS = [
    "job", "task", "trial", "reward", "error", "input_tokens", "cached_tokens", "output_tokens",
    "reasoning_tokens", "cost_usd", "model_calls", "agent_seconds", "agent_setup_seconds",
    "verifier_seconds", "trial_seconds", "started_at",
]


def _seconds(span: dict | None) -> float | None:
    from datetime import datetime

    if not span or not span.get("started_at") or not span.get("finished_at"):
        return None
    start, end = (datetime.fromisoformat(span[k].replace("Z", "+00:00")) for k in ("started_at", "finished_at"))
    return round((end - start).total_seconds(), 3)


def summarize_trial(trial: Path) -> dict | None:
    try:
        result = json.loads((trial / "result.json").read_text())
    except (OSError, ValueError):
        return None
    if not result.get("finished_at"):
        return None
    try:
        trajectory = json.loads((trial / "agent" / "trajectory.json").read_text())
    except (OSError, ValueError):
        trajectory = {}
    agent = result.get("agent_result") or {}
    metrics = trajectory.get("final_metrics") or {}
    return {
        "job": trial.parent.name,
        "task": result.get("task_name", "").split("/")[-1],
        "trial": trial.name,
        "reward": ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward"),
        "error": (result.get("exception_info") or {}).get("exception_type"),
        "input_tokens": agent.get("n_input_tokens"),
        "cached_tokens": agent.get("n_cache_tokens"),
        "output_tokens": agent.get("n_output_tokens"),
        "reasoning_tokens": (metrics.get("extra") or {}).get("reasoning_output_tokens"),
        "cost_usd": agent.get("cost_usd"),
        "model_calls": sum(1 for step in trajectory.get("steps") or [] if step.get("metrics")),
        "agent_seconds": _seconds(result.get("agent_execution")),
        "agent_setup_seconds": _seconds(result.get("agent_setup")),
        "verifier_seconds": _seconds(result.get("verifier")),
        "trial_seconds": _seconds(result),
        "started_at": result.get("started_at"),
    }


def export(prefix: str, jobs_dir: Path) -> None:
    import csv

    cli = str(Path(sys.executable).parent / "modal")
    jobs_dir.mkdir(parents=True, exist_ok=True)
    names = list(modal.Function.from_name(APP, "status").remote(prefix))
    for name in names:
        print(f"downloading {name}", flush=True)
        subprocess.run([cli, "volume", "get", "--force", VOLUME, name, str(jobs_dir)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run([cli, "volume", "get", "--force", VOLUME, f"logs/{name}.log", str(jobs_dir / name / "run_job.log")],
                       check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rows = [row for name in names for trial in sorted((jobs_dir / name).glob("*__*"))
            if (row := summarize_trial(trial))]
    summary = jobs_dir / f"{prefix}-trials.csv"
    with summary.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SUMMARY_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(rows)} graded trial(s) from {len(names)} job(s) in {summary}")


def job_specs(runs: int, label: str, stamp: str, tasks: list[str] | None,
              codex_config: dict | None = None, openai: bool = False) -> list[tuple[str, list[str]]]:
    import yaml

    base = HARBOR_ARGS + (["--ak", "config=" + json.dumps(codex_config, separators=(",", ":"))] if codex_config else [])
    if openai:
        base = ["api.openai.com" if a == "openrouter.ai" else a for a in base]
    exclusions = yaml.safe_load((HERE / "exclusions.yaml").read_text())
    if tasks:
        return [(f"{label}-r{i}-{stamp}", [*base, "-n", str(len(tasks)), *(a for t in tasks for a in ("-i", t))])
                for i in range(1, runs + 1)]
    cpu = [a for t in exclusions["default"] + exclusions["gpu"] for a in ("-x", t)]
    gpu = [a for t in exclusions["gpu"] for a in ("-i", t)]
    specs = []
    for i in range(1, runs + 1):
        specs.append((f"{label}-r{i}-{stamp}", [*base, "-n", "16", *cpu]))
        specs.append((f"{label}-r{i}-gpu-{stamp}", [*base, "-n", "3", *gpu]))
    return specs


def main() -> None:
    parser = argparse.ArgumentParser(prog="modal_codex", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    launch = sub.add_parser("launch", help="Spawn the runs' jobs on the deployed app.")
    launch.add_argument("--runs", type=int, default=3)
    launch.add_argument("--label", default="tb4.0-codex-max")
    launch.add_argument("--task", action="append", help="Run only this task (e.g. terminal-bench/vpp-loss-divergence); repeatable.")
    launch.add_argument("--local-compaction", action="store_true",
                        help="Use OpenRouter as a custom provider so Codex compacts locally (see OPENROUTER_PROVIDER).")
    launch.add_argument("--auto-compact-limit", type=int,
                        help="Set model_auto_compact_token_limit, e.g. low to force compaction in a smoke test.")
    launch.add_argument("--openai", action="store_true",
                        help="Call api.openai.com with the codex-openai secret instead of OpenRouter.")
    show = sub.add_parser("status", help="Trial outcomes per job on the volume.")
    show.add_argument("prefix", nargs="?", default="")
    pull = sub.add_parser("export", help="Download jobs into jobs/ and write a per-trial CSV.")
    pull.add_argument("prefix")
    pull.add_argument("--jobs-dir", type=Path, default=HERE / "jobs")
    args = parser.parse_args()

    if args.command == "export":
        export(args.prefix, args.jobs_dir)
        return
    if args.command == "status":
        for job, counts in modal.Function.from_name(APP, "status").remote(args.prefix).items():
            print(f"{job:60} {counts}")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    run_fn = modal.Function.from_name(APP, "run_job_openai" if args.openai else "run_job")
    calls = {}
    codex_config = dict(OPENROUTER_PROVIDER) if args.local_compaction else {}
    if args.auto_compact_limit:
        codex_config["model_auto_compact_token_limit"] = args.auto_compact_limit
    for job_name, harbor_args in job_specs(args.runs, args.label, stamp, args.task, codex_config or None, args.openai):
        calls[job_name] = run_fn.spawn(job_name, harbor_args).object_id
        print(f"{job_name}: call {calls[job_name]}", flush=True)
    record = HERE / ".runs" / f"{args.label}-{stamp}.json"
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({"stamp": stamp, "calls": calls}, indent=2))
    print(f"recorded calls in {record}")


if __name__ == "__main__":
    main()
