from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import yaml

from omnara_harbor.agent import MACHINE_FILE, RELEASE_URL
from omnara_harbor.client import Omnara, OmnaraError, load_credentials

HERE = Path(__file__).resolve().parent.parent


def trial_finished(trial_dir: Path) -> bool:
    try:
        return bool(json.loads((trial_dir / "result.json").read_text()).get("finished_at"))
    except (OSError, ValueError):
        return False


def pid_path(job_dir: Path) -> Path:
    return HERE / ".runs" / f"{job_dir.name}.pid"


async def delete_finished_machines(client: Omnara, job_dir: Path) -> None:
    deleted = 0
    for path in sorted(job_dir.glob(f"*/agent/{MACHINE_FILE}")):
        if not trial_finished(path.parent.parent):
            continue
        machine_id = json.loads(path.read_text())["machine_id"]
        try:
            await client.delete_machine(machine_id)
        except OmnaraError as error:
            if error.status != 404:
                print(f"could not delete machine {machine_id}: {error}", flush=True)
                continue
        path.unlink()
        deleted += 1
    if deleted:
        print(f"deleted {deleted} machine(s)", flush=True)
    unfinished = [d.name for d in job_dir.glob("*__*") if d.is_dir() and not trial_finished(d)]
    if unfinished:
        print(f"{len(unfinished)} trial(s) did not finish; `omnara-tb recover {job_dir}` can finish them", flush=True)


async def _cleanup(args: argparse.Namespace, profile_id: str, job_dir: Path) -> None:
    client = Omnara(load_credentials(args.org, args.project))
    try:
        await delete_finished_machines(client, job_dir)
        if args.reuse_profile:
            return
        agents = await client.request(
            "GET", f"{client.project}/agents",
            params={"agent_profile_id": profile_id, "include_archived": "true", "limit": 1},
        )
        if not agents["data"]:
            await client.request("DELETE", f"{client.project}/agent-profiles/{profile_id}")
            print(f"no trial launched an agent; deleted profile {profile_id}", flush=True)
    finally:
        await client.aclose()


async def _get_profile(args: argparse.Namespace, profile_id: str) -> dict:
    client = Omnara(load_credentials(args.org, args.project))
    try:
        return await client.request("GET", f"{client.project}/agent-profiles/{profile_id}")
    finally:
        await client.aclose()


async def _create_profile(args: argparse.Namespace, config_path: Path, run_name: str) -> tuple[str, str]:
    client = Omnara(load_credentials(args.org, args.project))
    try:
        config = await client.create_config(config_path.read_text())
        profile = await client.create_profile(run_name, config["id"])
        return profile["id"], config["id"]
    finally:
        await client.aclose()


def main() -> None:
    argv = sys.argv[1:]
    if argv[:1] == ["recover"]:
        from omnara_harbor.recover import main as recover_main

        recover_main(argv[1:])
        return
    if argv[:1] == ["compare"]:
        from omnara_harbor.compare import main as compare_main

        compare_main(argv[1:])
        return
    passthrough: list[str] = []
    if "--" in argv:
        split = argv.index("--")
        argv, passthrough = argv[:split], argv[split + 1 :]

    parser = argparse.ArgumentParser(prog="omnara-tb", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--agent-config", required=True, help="Base agent config YAML (no machine_sources).")
    parser.add_argument("--model", help="Override the config's model name (e.g. anthropic/claude-opus-5.5).")
    parser.add_argument("--effort", help="Override the config's reasoning effort.")
    parser.add_argument("--name", help="Run name prefix for the profile, agents and machines.")
    parser.add_argument("--org", help="Omnara org ID (default: OMNARA_ORG_ID or CLI login).")
    parser.add_argument("--project", help="Omnara project ID (default: OMNARA_PROJECT_ID or CLI login).")
    parser.add_argument("--omnarad-binary", help="Upload this omnarad build instead of the latest release.")
    parser.add_argument("--no-default-excludes", action="store_true",
                        help="Run the tasks in exclusions.yaml's default list too.")
    parser.add_argument("--exclude-gpu", action="store_true", help="Also leave out GPU tasks.")
    parser.add_argument("--reuse-profile", metavar="PROFILE_ID",
                        help="Run more trials under an existing run's profile and base config instead of creating new ones.")
    args = parser.parse_args(argv)

    base = yaml.safe_load(Path(args.agent_config).read_text())
    base.pop("machine_sources", None)
    model = dict(base.get("model") or {})
    if args.model:
        model["name"] = args.model
    if args.effort:
        model["reasoning"] = {"effort": args.effort}
    base["model"] = model

    stamp = time.strftime("%Y%m%d-%H%M%S")
    creds = load_credentials(args.org, args.project)
    if args.reuse_profile:
        profile = asyncio.run(_get_profile(args, args.reuse_profile))
        profile_id, config_id, run_name = profile["id"], profile["current_config_id"], profile["name"]
        effective = HERE / ".runs" / f"{re.sub(r'[^A-Za-z0-9._-]+', '_', run_name)}.yaml"
        if not effective.exists():
            sys.exit(f"{effective} not found; --reuse-profile needs the run's effective config")
        job_name = re.sub(r"[^A-Za-z0-9._-]+", "-", f"{run_name}-{stamp}-{os.getpid()}")
        print(f"run {run_name!r}: reusing profile {profile_id}, job {job_name}", flush=True)
    else:
        short = (model.get("name") or "model").split("/")[-1]
        run_name = f"{args.name or 'omnara'} {short} {stamp}"[:64]
        effective = HERE / ".runs" / f"{re.sub(r'[^A-Za-z0-9._-]+', '_', run_name)}.yaml"
        effective.parent.mkdir(parents=True, exist_ok=True)
        effective.write_text(yaml.safe_dump(base, sort_keys=False))
        profile_id, config_id = asyncio.run(_create_profile(args, effective, run_name))
        job_name = re.sub(r"[^A-Za-z0-9._-]+", "-", run_name)
        print(f"run {run_name!r}: profile {profile_id}, config {effective}", flush=True)

    harbor = Path(sys.executable).parent / "harbor"
    jobs_dir = "jobs"
    for flag in ("-o", "--jobs-dir"):
        if flag in passthrough[:-1]:
            jobs_dir = passthrough[passthrough.index(flag) + 1]
    command = [
        str(harbor), "run",
        "-a", "omnara_harbor.agent:OmnaraAgent",
        "--ak", f"profile_id={profile_id}",
        "--ak", f"config_id={config_id}",
        "--ak", f"agent_config={effective}",
        "--ak", f"run_name={run_name}",
        "--ak", f"org_id={creds.org_id}",
        "--ak", f"project_id={creds.project_id}",
        "--allow-agent-host", urlparse(creds.api_url).hostname or "api.omnara.com",
        "--allow-agent-host", urlparse(RELEASE_URL).hostname,
        "--job-name", job_name,
    ]
    if args.omnarad_binary:
        command += ["--ak", f"omnarad_binary={Path(args.omnarad_binary).resolve()}"]
    exclusions = yaml.safe_load((HERE / "exclusions.yaml").read_text())
    excluded = ([] if args.no_default_excludes else exclusions["default"]) + (exclusions["gpu"] if args.exclude_gpu else [])
    for task in excluded:
        command += ["-x", task]
    if excluded:
        print(f"excluding {len(excluded)} task(s): {', '.join(t.split('/')[-1] for t in excluded)}", flush=True)
    command += passthrough
    job_dir = Path(jobs_dir) / job_name
    pid_path(job_dir).write_text(str(os.getpid()))
    try:
        code = subprocess.call(command)
    finally:
        asyncio.run(_cleanup(args, profile_id, job_dir))
        pid_path(job_dir).unlink(missing_ok=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
