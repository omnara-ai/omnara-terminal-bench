from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from harbor.environments.definition import should_use_prebuilt_docker_image
from harbor.environments.modal import ModalEnvironment
from harbor.models.trial.config import TrialConfig
from harbor.trial.single_step import SingleStepTrial
from harbor.trial.trial import Trial

from datetime import datetime

from omnara_harbor.agent import MACHINE_FILE, SESSION_FILE, trial_resource_name
from omnara_harbor.client import Omnara, OmnaraError, load_credentials
from omnara_harbor.launch import delete_finished_machines, pid_path, trial_finished


class RecoverTrial(SingleStepTrial):

    def __init__(self, config: TrialConfig, *, session: dict[str, Any], previous: dict[str, Any], **kwargs: Any):
        self._session = session
        self._previous = previous
        super().__init__(config, **kwargs)
        started = session.get("agent_started_at")
        if self._agent_timeout_sec is not None and started is not None:
            self._agent_timeout_sec = max(self._agent_timeout_sec - (time.time() - started), 1.0)

    def _init_result(self) -> None:
        super()._init_result()
        saved = self.config.model_copy(deep=True)
        saved.agent.kwargs.pop("recover", None)
        self.paths.config_path.write_text(saved.model_dump_json(indent=4, exclude_defaults=True))
        self.result.config = saved
        if self._previous.get("started_at"):
            self.result.started_at = self._previous["started_at"]

    async def _start_agent_environment(self) -> None:
        from modal import App, Sandbox

        env = self.agent_environment
        if not isinstance(env, ModalEnvironment):
            raise RuntimeError(f"recover supports Modal sandboxes only, not {type(env).__name__}")
        env._app = await App.lookup.aio(name=env._app_name, create_if_missing=True)
        env._sandbox = await Sandbox.from_id.aio(self._session["sandbox_id"])
        strategy = env._strategy
        if hasattr(strategy, "_use_prebuilt"):
            strategy._use_prebuilt = should_use_prebuilt_docker_image(
                env.environment_dir,
                docker_image=env.task_env_config.docker_image,
                force_build=self.config.environment.force_build,
            )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


async def _live_sandboxes() -> dict[str, str]:
    from modal import App, Sandbox

    app = await App.lookup.aio(name="__harbor__", create_if_missing=True)
    found = {}
    async for sandbox in Sandbox.list.aio(app_id=app.app_id, tags={"harbor.managed": "true"}):
        session = (await sandbox.get_tags.aio()).get("harbor.session_id", "")
        if session.endswith("__env"):
            found[session.removesuffix("__env")] = sandbox.object_id
    return found


async def _discover(trial_dir: Path, session: dict[str, Any], client: Omnara, sandboxes: dict[str, str]) -> dict[str, Any]:
    session = dict(session)
    machine_file = _read_json(trial_dir / "agent" / MACHINE_FILE)
    session.setdefault("machine_id", machine_file.get("machine_id"))
    if not session.get("machine_id"):
        return session
    if not session.get("sandbox_id") and trial_dir.name in sandboxes:
        session["sandbox_id"] = sandboxes[trial_dir.name]
    if "cwd" not in session or "machine_name" not in session:
        try:
            machine = await client.get_machine(session["machine_id"])
        except OmnaraError:
            return session
        session.setdefault("cwd", machine.get("cwd"))
        session.setdefault("machine_name", machine.get("display_name") or machine.get("name"))
    if not session.get("agent_id"):
        kwargs = _read_json(trial_dir / "config.json").get("agent", {}).get("kwargs", {})
        run_name = kwargs.get("run_name", "omnara")
        expected = {trial_resource_name(run_name, trial_dir.name), f"{run_name} · {trial_dir.name}"[:64]}
        params: dict[str, Any] = {"agent_profile_id": kwargs.get("profile_id"), "limit": 100}
        matches = []
        while True:
            page = await client.request("GET", f"{client.project}/agents", params=params)
            matches += [agent for agent in page["data"] if agent.get("name") in expected]
            if not page.get("next_cursor") or not page["data"]:
                break
            params["cursor"] = page["next_cursor"]
        if matches:
            agent = max(matches, key=lambda a: a["created_at"])
            session["agent_id"] = agent["id"]
            session["agent_started_at"] = datetime.fromisoformat(agent["created_at"]).timestamp()
    session.setdefault("skills", [])
    if session.get("sandbox_id"):
        (trial_dir / "agent").mkdir(parents=True, exist_ok=True)
        (trial_dir / "agent" / SESSION_FILE).write_text(json.dumps(session, indent=2))
    return session


async def _sandbox_alive(sandbox_id: str | None) -> bool:
    if not sandbox_id:
        return False
    from modal import Sandbox

    try:
        sandbox = await Sandbox.from_id.aio(sandbox_id)
        return await sandbox.poll.aio() is None
    except Exception:  # noqa: BLE001 - any lookup failure means it is gone
        return False


async def _release(trial_dir: Path, session: dict[str, Any], client: Omnara) -> None:
    for call in (
        client.cancel_agent(session["agent_id"]) if session.get("agent_id") else None,
        client.delete_machine(session["machine_id"]) if session.get("machine_id") else None,
    ):
        if call is None:
            continue
        try:
            await call
        except OmnaraError as error:
            if error.status not in (404, 409):
                print(f"  {trial_dir.name}: cleanup call failed: {error}", flush=True)


async def _recover(trial_dir: Path, session: dict[str, Any]) -> str:
    config = TrialConfig.model_validate_json((trial_dir / "config.json").read_text())
    config.agent.kwargs = {**config.agent.kwargs, "recover": True}
    task, download = await Trial._load_task(config)
    if task.has_steps:
        raise RuntimeError("multi-step tasks are not supported")
    trial = RecoverTrial(
        config,
        session=session,
        previous=_read_json(trial_dir / "result.json"),
        _task=task,
        _task_download_result=download,
    )
    result = await trial.run()
    reward = ((result.verifier_result.rewards or {}) if result.verifier_result else {}).get("reward")
    error = result.exception_info.exception_type if result.exception_info else None
    return f"reward {reward}" + (f" ({error})" if error else "")


async def _run(args: argparse.Namespace) -> int:
    job_dir = Path(args.job_dir).resolve()
    if not (job_dir / "config.json").exists():
        sys.exit(f"{job_dir} is not a Harbor job directory")
    pid_file = pid_path(job_dir)
    if pid_file.exists() and not (args.force or args.dry_run):
        try:
            os.kill(int(pid_file.read_text()), 0)
            sys.exit(f"omnara-tb is still running this job (pid {pid_file.read_text()}); pass --force to recover anyway")
        except (ProcessLookupError, ValueError):
            pass
    running = subprocess.run(["pgrep", "-f", f"harbor run .*--job-name {job_dir.name}"], capture_output=True, text=True)
    if running.stdout.strip() and not (args.force or args.dry_run):
        sys.exit(f"harbor run is still running this job (pid {running.stdout.split()[0]}); pass --force to recover anyway")

    pending = sorted(d for d in job_dir.iterdir() if (d / "config.json").exists() and not trial_finished(d))
    if not pending:
        print("every trial has finished", flush=True)
    org = project = None
    for session_dir in pending:
        kwargs = _read_json(session_dir / "config.json").get("agent", {}).get("kwargs", {})
        org, project = kwargs.get("org_id"), kwargs.get("project_id")
        if org:
            break
    client = Omnara(load_credentials(org, project))
    try:
        sandboxes = await _live_sandboxes() if pending else {}
        sessions = {
            d: await _discover(d, _read_json(d / "agent" / SESSION_FILE), client, sandboxes) for d in pending
        }
        alive = await asyncio.gather(*(_sandbox_alive(s.get("sandbox_id")) for s in sessions.values()))
        recoverable = []
        if args.dry_run:
            for trial_dir, ok in zip(pending, alive):
                s = sessions[trial_dir]
                state = "recoverable" if ok and s.get("cwd") else ("sandbox gone" if s.get("machine_id") else "no session")
                print(f"  {trial_dir.name}: {state}; sandbox {s.get('sandbox_id')}, agent {s.get('agent_id')}", flush=True)
            return 0
        for trial_dir, ok in zip(pending, alive):
            session = sessions[trial_dir]
            previous = _read_json(trial_dir / "result.json")
            cancelled = (previous.get("exception_info") or {}).get("exception_type") == "CancelledError"
            if ok and session.get("machine_id") and session.get("cwd") and not cancelled:
                recoverable.append(trial_dir)
                continue
            reason = "cancelled" if cancelled else ("no session recorded" if not session.get("machine_id") else "sandbox is gone")
            print(f"  {trial_dir.name}: cannot recover ({reason}); releasing it for `harbor jobs resume`", flush=True)
            await _release(trial_dir, session, client)
        print(f"recovering {len(recoverable)} of {len(pending)} unfinished trial(s)", flush=True)

        limit = asyncio.Semaphore(args.n)

        async def one(trial_dir: Path) -> None:
            async with limit:
                try:
                    outcome = await _recover(trial_dir, sessions[trial_dir])
                except Exception as error:  # noqa: BLE001 - report and move on
                    outcome = f"failed: {error}"
                print(f"  {trial_dir.name}: {outcome}", flush=True)

        await asyncio.gather(*(one(d) for d in recoverable))
        await delete_finished_machines(client, job_dir)
    finally:
        await client.aclose()

    if args.resume:
        harbor = Path(sys.executable).parent / "harbor"
        code = subprocess.call([str(harbor), "jobs", "resume", "-p", str(job_dir)])
        client = Omnara(load_credentials(org, project))
        try:
            await delete_finished_machines(client, job_dir)
        finally:
            await client.aclose()
        return code
    if any(not trial_finished(d) for d in job_dir.iterdir() if (d / "config.json").exists()):
        print(f"run `harbor jobs resume -p {job_dir}` to re-run the rest", flush=True)
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="omnara-tb recover", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("job_dir", help="Harbor job directory, e.g. jobs/tb4.0-codex-gpt-6.1-sol-...")
    parser.add_argument("-n", type=int, default=10, help="Trials to recover concurrently (default 10).")
    parser.add_argument("--resume", action="store_true", help="Then `harbor jobs resume` the trials that could not be recovered.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Only report what would be recovered (and record missing session files).")
    parser.add_argument("--force", action="store_true", help="Recover even if omnara-tb or harbor run still seems to be running the job.")
    sys.exit(asyncio.run(_run(parser.parse_args(argv))))
