from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import modal

APP = "tb-omnara"
VOLUME = "tb-omnara-jobs"
JOBS = "/jobs"
HERE = Path(__file__).resolve().parent.parent

app = modal.App(APP)
volume = modal.Volume.from_name(VOLUME, create_if_missing=True, version=2)
image = (
    modal.Image.debian_slim(python_version="3.13")
    .uv_pip_install("harbor[modal]==0.24.0", "modal==1.6.1", "certifi", "httpx>=0.27", "pyyaml>=6")
    .env({"PYTHONPATH": "/root"})
    .add_local_file(HERE / "exclusions.yaml", "/root/exclusions.yaml")
    .add_local_file(HERE / "agent.codex.yaml", "/root/agent.codex.yaml")
    .add_local_file(HERE / "agent.claude-code.yaml", "/root/agent.claude-code.yaml")
    .add_local_file(HERE / "agent.claude-code.balanced.yaml", "/root/agent.claude-code.balanced.yaml")
    .add_local_python_source("omnara_harbor", ignore=["**/__pycache__", "**/*.pyc"])
)

DATASET = ["-d", "terminal-bench/terminal-bench@4.0.0", "-e", "modal"]
GPU_TASKS = ["fp8-rmsnorm-gemm", "jax-speedrun-gpu", "math-eval-grader"]
MODELS = {
    "gpt": "agent.codex.yaml",
    "opus": "agent.claude-code.yaml",
}
RUN_LINE = re.compile(r"run '(?P<run>.+)': (?:reusing )?profile (?P<profile>aprf_\w+)(?:, job (?P<job>\S+))?")


def _commit_loop(stop: threading.Event) -> None:
    while not stop.wait(60):
        volume.commit()


async def _delete_machines(job_dir: Path, finished: bool) -> None:
    from omnara_harbor.agent import MACHINE_FILE
    from omnara_harbor.client import Omnara, OmnaraError, load_credentials
    from omnara_harbor.launch import delete_finished_machines, trial_finished

    client = Omnara(load_credentials())
    try:
        if finished:
            await delete_finished_machines(client, job_dir)
            return
        for path in job_dir.glob(f"*/agent/{MACHINE_FILE}"):
            if trial_finished(path.parent.parent):
                continue
            try:
                await client.delete_machine(json.loads(path.read_text())["machine_id"])
            except OmnaraError as error:
                if error.status != 404:
                    print(f"could not delete machine in {path}: {error}", flush=True)
    finally:
        await client.aclose()


@app.function(
    image=image,
    volumes={JOBS: volume},
    secrets=[modal.Secret.from_name("omnara-prod")],
    timeout=24 * 3600,
    nonpreemptible=True,
    retries=modal.Retries(max_retries=3, initial_delay=30.0),
    cpu=4,
    memory=8192,
)
def run(key: str, omnara_tb_args: list[str]) -> int:
    import os

    (Path.home() / ".modal.toml").touch()
    os.environ.setdefault("OMNARA_TB_SETUP_SLOTS", "64")
    volume.reload()
    runs = Path(JOBS) / ".runs"
    runs.mkdir(parents=True, exist_ok=True)
    if not Path("/root/.runs").exists():
        Path("/root/.runs").symlink_to(runs)
    state_path = runs / f"{key}.state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    job_dir = Path(JOBS) / state["job"] if state.get("job") else None
    resuming = job_dir is not None and (job_dir / "config.json").exists()
    if resuming:
        asyncio.run(_delete_machines(job_dir, finished=False))
        command = ["harbor", "jobs", "resume", "-p", str(job_dir)]
    else:
        command = [sys.executable, "-m", "omnara_harbor.launch", *omnara_tb_args]
    log = Path(JOBS) / "logs" / f"{key}.log"
    log.parent.mkdir(parents=True, exist_ok=True)

    stop = threading.Event()
    committer = threading.Thread(target=_commit_loop, args=(stop,), daemon=True)
    committer.start()
    try:
        with log.open("a") as out:
            out.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {' '.join(command)}\n")
            out.flush()
            proc = subprocess.Popen(command, cwd="/root", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in proc.stdout:
                out.write(line)
                out.flush()
                if not state.get("job") and (match := RUN_LINE.search(line)):
                    run_name = match["run"]
                    state = {
                        "run": run_name,
                        "profile": match["profile"],
                        "job": match["job"] or re.sub(r"[^A-Za-z0-9._-]+", "-", run_name),
                    }
                    state_path.write_text(json.dumps(state, indent=2))
                    volume.commit()
            code = proc.wait()
            out.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} exited {code}\n")
        if resuming:
            asyncio.run(_delete_machines(job_dir, finished=True))
    finally:
        stop.set()
        committer.join()
        volume.commit()
    return code


@app.function(image=image, volumes={JOBS: volume})
def status(prefix: str = "") -> dict[str, dict[str, int]]:
    volume.reload()
    jobs: dict[str, dict[str, int]] = {}
    for job in sorted(p for p in Path(JOBS).iterdir()
                      if p.is_dir() and p.name.startswith(prefix) and p.name not in ("logs", ".runs")):
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


@app.function(image=image, volumes={JOBS: volume})
def run_states() -> dict[str, dict]:
    volume.reload()
    return {p.name.removesuffix(".state.json"): json.loads(p.read_text())
            for p in sorted((Path(JOBS) / ".runs").glob("*.state.json"))}


def run_key(label: str, model: str, i: int) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", f"{label} {model}-max-r{i}")


def cpu_specs(runs: int, label: str, n: int) -> list[tuple[str, list[str]]]:
    specs = []
    for model, config in MODELS.items():
        for i in range(1, runs + 1):
            specs.append((run_key(label, model, i), [
                "--agent-config", f"/root/{config}", "--effort", "max",
                "--name", f"{label} {model}-max-r{i}", "--exclude-gpu", "--",
                *DATASET, "-n", str(n), "-o", JOBS,
            ]))
    return specs


def gpu_specs(states: dict[str, dict], label: str, models: list[str], n: int,
              tasks: list[str] | None = None) -> list[tuple[str, list[str]]]:
    prefix = re.sub(r"[^A-Za-z0-9._-]+", "-", label) + "-"
    tasks = tasks or GPU_TASKS
    suffix = "-gpu" if tasks == GPU_TASKS else "-gpu-" + "-".join(tasks)
    include = [a for t in tasks for a in ("-i", f"terminal-bench/{t}")]
    specs = []
    for key, state in states.items():
        match = re.fullmatch(re.escape(prefix) + r"(?P<model>\w+)-max-r\d+", key)
        if not match or match["model"] not in models:
            continue
        specs.append((key + suffix, ["--agent-config", f"/root/{MODELS[match['model']]}",
                                     "--reuse-profile", state["profile"],
                                     "--", *DATASET, "-n", str(n), *include, "-o", JOBS]))
    return specs


def _spawn(specs: list[tuple[str, list[str]]], record_name: str) -> None:
    run_fn = modal.Function.from_name(APP, "run")
    calls = {}
    for key, args in specs:
        calls[key] = run_fn.spawn(key, args).object_id
        print(f"{key}: call {calls[key]}", flush=True)
    record = HERE / ".runs" / f"{record_name}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    record.parent.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({"calls": calls}, indent=2))
    print(f"recorded calls in {record}")


def export(prefix: str, jobs_dir: Path) -> None:
    import csv

    from omnara_harbor.modal_codex import SUMMARY_FIELDS, summarize_trial

    cli = str(Path(sys.executable).parent / "modal")
    jobs_dir.mkdir(parents=True, exist_ok=True)
    names = list(modal.Function.from_name(APP, "status").remote(prefix))
    for name in names:
        print(f"downloading {name}", flush=True)
        subprocess.run([cli, "volume", "get", "--force", VOLUME, name, str(jobs_dir)], check=True, stdout=subprocess.DEVNULL)
    rows = [row for name in names for trial in sorted((jobs_dir / name).glob("*__*"))
            if (row := summarize_trial(trial))]
    summary = jobs_dir / f"{prefix}-trials.csv"
    with summary.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SUMMARY_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"{len(rows)} graded trial(s) from {len(names)} job(s) in {summary}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="modal_omnara", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    launch = sub.add_parser("launch", help="Spawn the CPU-task runs (each model x --runs).")
    launch.add_argument("--runs", type=int, default=3)
    launch.add_argument("--label", default="tb4.0 prod")
    launch.add_argument("-n", type=int, default=57, help="Concurrent trials per run (57 = every CPU task at once).")
    launch.add_argument("--only", help="Spawn just this run key (e.g. gpt-max-r1), for a smoke test.")
    launch.add_argument("--task", action="append", help="Run only this task in the spawned runs; repeatable.")
    gpu = sub.add_parser("launch-gpu", help="Spawn the GPU tasks under each recorded run's profile.")
    gpu.add_argument("--label", default="tb4.0 prod")
    gpu.add_argument("--model", action="append", choices=sorted(MODELS), help="Only this model's runs; repeatable.")
    gpu.add_argument("-n", type=int, default=3, help="Concurrent GPU trials per run.")
    gpu.add_argument("--task", action="append", choices=GPU_TASKS, help="Only this GPU task; repeatable.")
    show = sub.add_parser("status", help="Trial outcomes per job, and recorded runs.")
    show.add_argument("prefix", nargs="?", default="")
    pull = sub.add_parser("export", help="Download jobs into jobs/ and write a per-trial CSV.")
    pull.add_argument("prefix")
    pull.add_argument("--jobs-dir", type=Path, default=HERE / "jobs")
    args = parser.parse_args()

    if args.command == "export":
        export(args.prefix, args.jobs_dir)
    elif args.command == "status":
        for job, counts in modal.Function.from_name(APP, "status").remote(args.prefix).items():
            print(f"{job:70} {counts}")
    elif args.command == "launch":
        specs = cpu_specs(args.runs, args.label, args.n)
        if args.only:
            specs = [(k, a) for k, a in specs if k.endswith(f"-{args.only}")]
        if args.task:
            specs = [(k, [x for x in a if x != "--exclude-gpu"] + [y for t in args.task for y in ("-i", t)])
                     for k, a in specs]
        _spawn(specs, "tb4.0-omnara-cpu")
    else:
        states = modal.Function.from_name(APP, "run_states").remote()
        tasks = [t for t in GPU_TASKS if t in (args.task or GPU_TASKS)]
        specs = gpu_specs(states, args.label, args.model or sorted(MODELS), args.n, tasks)
        if not specs:
            sys.exit("no recorded CPU runs to add GPU tasks to")
        _spawn(specs, "tb4.0-omnara-gpu")


if __name__ == "__main__":
    main()
