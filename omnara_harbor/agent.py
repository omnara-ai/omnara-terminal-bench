from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
import random
import shlex
import time
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any

import certifi
import httpx
import yaml
from pydantic import Field

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.options import AgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from omnara_harbor.atif import build_trajectory, openrouter_pricing
from omnara_harbor.client import Omnara, OmnaraError, load_credentials
from omnara_harbor.mcp_tunnel import cloudflared_binary, mcp_server_name, open_tunnel

RELEASE_URL = "https://releases.omnara.com/omnarad/latest"
REMOTE_DIR = "/tmp/omnara"
SCRIPTS_DIR = Path(__file__).resolve().parent / "scripts"
MACHINE_FILE = "omnara-machine.json"
SESSION_FILE = "omnara-session.json"
CACHE_DIR = Path.home() / ".cache" / "omnara-harbor"
MACHINE_POLL_SEC = 10.0
AGENT_POLL_SEC = 30.0
SETUP_SLOTS = int(os.environ.get("OMNARA_TB_SETUP_SLOTS", "20"))
SETUP_SLOT_DIR = CACHE_DIR / "setup-slots"


@contextlib.asynccontextmanager
async def _setup_slot() -> AsyncIterator[None]:
    SETUP_SLOT_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        for slot in range(SETUP_SLOTS):
            lock = open(SETUP_SLOT_DIR / f"slot-{slot}.lock", "w")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock.close()
                continue
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                lock.close()
            return
        await asyncio.sleep(1 + random.random())


class OmnaraOptions(AgentOptions):
    profile_id: str = Field(description="Agent profile for the run (created by `omnara-tb`).")
    config_id: str = Field(description="The profile's base agent config.")
    agent_config: str = Field(description="Path to the base agent config YAML (no machine_sources).")
    run_name: str = Field(default="omnara", description="Prefix for agent and machine names.")
    org_id: str | None = Field(default=None, description="Omnara org (defaults to OMNARA_ORG_ID / CLI login).")
    project_id: str | None = Field(default=None, description="Omnara project.")
    omnarad_binary: str | None = Field(
        default=None, description="Local omnarad binary to upload instead of the latest release."
    )
    machine_timeout_sec: int = Field(default=300, description="How long to wait for the daemon to connect.")
    recover: bool = Field(
        default=False, description="Reattach to the trial's recorded machine and agent (set by `omnara-tb recover`)."
    )


def trial_resource_name(run_name: str, trial: str, limit: int = 64) -> str:
    trial = trial[-(limit - 4):]
    return f"{run_name[: max(limit - len(trial) - 3, 0)]} · {trial}"


_manifests: dict[str, dict[str, str]] = {}


async def _release_manifest(platform: str) -> dict[str, str]:
    if platform not in _manifests:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as http:
            text = (await http.get(f"{RELEASE_URL}/linux-{platform}.txt")).raise_for_status().text
        _manifests[platform] = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
    return _manifests[platform]


async def _release_binary(platform: str) -> Path:
    fields = await _release_manifest(platform)
    path = CACHE_DIR / "omnarad" / fields["version"] / f"omnarad-linux-{platform}"
    if not path.exists():
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as http:
            data = (await http.get(fields["url"])).raise_for_status().content
        if hashlib.sha256(data).hexdigest() != fields["sha256"]:
            raise RuntimeError(f"omnarad {fields['version']} digest mismatch")
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(f".{id(data)}.partial")
        partial.write_bytes(data)
        partial.replace(path)
    return path


_FETCH = r"""
url=$1 dest=$2 sum=$3 ca=$4 ok=
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 --cacert "$ca" -o "$dest" "$url" && ok=1
fi
if [ -z "$ok" ] && command -v wget >/dev/null 2>&1; then
  # BusyBox wget has no --ca-certificate; it uses the image's store, if any.
  { wget -q -T 60 --ca-certificate="$ca" -O "$dest" "$url" || wget -q -T 60 -O "$dest" "$url"; } 2>/dev/null && ok=1
fi
if [ -z "$ok" ] && command -v python3 >/dev/null 2>&1; then
  python3 -c 'import ssl, sys, urllib.request as u; open(sys.argv[2], "wb").write(u.urlopen(u.Request(sys.argv[1], headers={"User-Agent": "omnara-harbor"}), context=ssl.create_default_context(cafile=sys.argv[3]), timeout=300).read())' "$url" "$dest" "$ca" && ok=1
fi
[ -n "$ok" ] || { echo "no curl, wget or python3 could download it"; rm -f "$dest"; exit 1; }
got=$( (sha256sum "$dest" || shasum -a 256 "$dest") 2>/dev/null | cut -d' ' -f1)
[ -n "$got" ] || got=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$dest" 2>/dev/null)
[ "$got" = "$sum" ] || { echo "sha256 mismatch: $got"; rm -f "$dest"; exit 3; }
"""

_SERVERS = r"""
cd /proc || exit 1
listening=" $(awk 'NR > 1 && $4 == "0A" { printf "%s ", $10 }' net/tcp net/tcp6 2>/dev/null)"
for pid in [0-9]*; do
  stat=$(cat "$pid/stat" 2>/dev/null) || continue
  ppid=${stat##*) }; ppid=${ppid#* }; ppid=${ppid%% *}
  runner=0; tr '\0' ' ' <"$pid/cmdline" 2>/dev/null | grep -q '__omnara_process_[r]unner' && runner=1
  socket=0
  for fd in "$pid"/fd/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    case $link in socket:\[*\])
      inode=${link#socket:[}; inode=${inode%]}
      case $listening in *" $inode "*) socket=1; break ;; esac ;;
    esac
  done
  echo "$pid $ppid $runner $socket"
done | awk '
  { parent[$1] = $2; runner[$1] = $3; socket[$1] = $4 }
  END {
    for (p in socket) if (socket[p]) for (q = p; q in parent && q > 1; q = parent[q]) if (runner[q]) { serving[q] = 1; break }
    for (p in runner) if (runner[p]) { n++; if (p in serving) m++ }
    print n + 0, m + 0
  }'
"""


def _timestamp(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class OmnaraAgent(BaseAgent):
    options_model = OmnaraOptions
    capabilities = AgentCapabilities(atif=True, skills=True, mcp_servers=True)

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._opts: OmnaraOptions = self.options  # type: ignore[assignment]
        self._client: Omnara | None = None
        self._machine_id: str | None = None
        self._machine_name: str | None = None
        self._cwd: str | None = None
        self._agent_id: str | None = None
        self._skills: list[tuple[str, str, str]] = []
        self._mcp: dict[str, str] = {}
        self._environment: BaseEnvironment | None = None
        self._omnarad_source: str | None = None

    @staticmethod
    def name() -> str:
        return "omnara"

    def version(self) -> str | None:
        return "0.1.0"

    @property
    def _trial(self) -> str:
        return self.logs_dir.parent.name

    def _client_for_run(self) -> Omnara:
        if self._client is None:
            self._client = Omnara(load_credentials(self._opts.org_id, self._opts.project_id))
        return self._client

    def _save_session(self, **fields: Any) -> None:
        path = self.logs_dir / SESSION_FILE
        session = json.loads(path.read_text()) if path.exists() else {}
        session.update(fields)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(session, indent=2))

    async def setup(self, environment: BaseEnvironment) -> None:
        if self._opts.recover:
            self._environment = environment
            session = json.loads((self.logs_dir / SESSION_FILE).read_text())
            self._machine_id = session["machine_id"]
            self._machine_name = session["machine_name"]
            self._cwd = session["cwd"]
            self._agent_id = session.get("agent_id")
            self._skills = [tuple(skill) for skill in session.get("skills", [])]
            self._mcp = session.get("mcp", {})
            return
        try:
            async with _setup_slot():
                await self._setup(environment)
        except BaseException:
            client = self._client_for_run()
            if self._machine_id:
                await asyncio.shield(self._quietly(client.delete_machine(self._machine_id)))
                (self.logs_dir / MACHINE_FILE).unlink(missing_ok=True)
            await client.aclose()
            self._client = None
            raise

    async def _setup(self, environment: BaseEnvironment) -> None:
        self._environment = environment
        client = self._client_for_run()
        probe = await environment.exec("pwd; uname -m")
        cwd, arch = (probe.stdout or "").strip().splitlines()[-2:]
        self._cwd = cwd
        platform = "arm64" if arch in ("aarch64", "arm64") else "amd64"

        await environment.exec(f"mkdir -p {REMOTE_DIR}/home")
        await environment.upload_file(certifi.where(), f"{REMOTE_DIR}/ca.pem")
        await environment.upload_file(SCRIPTS_DIR / "memsample.sh", f"{REMOTE_DIR}/memsample.sh")
        await self._install_binary(environment, platform)
        await environment.exec(f"chmod 755 {REMOTE_DIR}/omnarad {REMOTE_DIR}/memsample.sh")
        await environment.exec(
            f"(setsid sh {REMOTE_DIR}/memsample.sh </dev/null >/dev/null 2>&1 & echo $! >{REMOTE_DIR}/memsample.pid)"
        )

        self._machine_name = trial_resource_name(self._opts.run_name, self._trial)
        connected = await client.connect_byo_machine(self._machine_name, cwd)
        self._machine_id = connected["machine"]["id"]
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / MACHINE_FILE).write_text(json.dumps({"machine_id": self._machine_id}))
        sandbox = getattr(environment, "_sandbox", None)
        self._save_session(
            machine_id=self._machine_id,
            machine_name=self._machine_name,
            cwd=cwd,
            environment=type(environment).__name__,
            sandbox_id=getattr(sandbox, "object_id", None),
            omnarad_source=self._omnarad_source,
        )

        start = (
            f"cd / && {REMOTE_DIR}/omnarad install --release-manifest-url {RELEASE_URL}/linux-{platform}.txt "
            f"--no-start >{REMOTE_DIR}/omnarad.log 2>&1 && "
            f"(setsid sh -c 'exec {REMOTE_DIR}/home/bin/omnarad start --no-service' "
            f"</dev/null >>{REMOTE_DIR}/omnarad.log 2>&1 &)"
        )
        result = await environment.exec(
            start,
            env={
                "OMNARA_API_URL": client.creds.api_url,
                "OMNARA_MACHINE_TOKEN": connected["token"],
                "OMNARA_NO_UPDATE": "1",
                "OMNARA_HOME": f"{REMOTE_DIR}/home",
                "SSL_CERT_FILE": f"{REMOTE_DIR}/ca.pem",
            },
        )
        if result.return_code != 0:
            log = await environment.exec(f"tail -c 2000 {REMOTE_DIR}/omnarad.log")
            raise RuntimeError(f"failed to start omnarad: {log.stdout or result.stderr or result.stdout}")

        self._skills = await self._list_skills(environment)
        self._save_session(skills=self._skills)
        self._mcp = await self._open_mcp_tunnels(environment, platform)
        self._save_session(mcp=self._mcp)

        deadline = time.monotonic() + self._opts.machine_timeout_sec
        while True:
            machine = await client.get_machine(self._machine_id)
            if machine.get("connection_state") == "online":
                return
            if time.monotonic() > deadline:
                log = await environment.exec(f"tail -c 2000 {REMOTE_DIR}/omnarad.log")
                raise RuntimeError(f"omnarad did not connect: {log.stdout}")
            await asyncio.sleep(MACHINE_POLL_SEC * (0.5 + random.random()))

    async def _install_binary(self, environment: BaseEnvironment, platform: str) -> None:
        dest = f"{REMOTE_DIR}/omnarad"
        if self._opts.omnarad_binary:
            await environment.upload_file(Path(self._opts.omnarad_binary), dest)
            self._omnarad_source = "upload"
            return
        release = await _release_manifest(platform)
        args = " ".join(shlex.quote(a) for a in (release["url"], dest, release["sha256"], f"{REMOTE_DIR}/ca.pem"))
        fetched = await environment.exec(f"sh -c {shlex.quote(_FETCH)} fetch {args}")
        if fetched.return_code == 0:
            self._omnarad_source = "download"
            return
        self.logger.warning(
            "sandbox could not download omnarad (%s); uploading it",
            (fetched.stdout or fetched.stderr or "").strip()[-300:] or f"exit {fetched.return_code}",
        )
        await environment.upload_file(await _release_binary(platform), dest)
        self._omnarad_source = "upload"

    async def _open_mcp_tunnels(self, environment: BaseEnvironment, platform: str) -> dict[str, str]:
        if not self.mcp_servers:
            return {}
        stdio = [server.name for server in self.mcp_servers if server.transport == "stdio"]
        if stdio:
            raise RuntimeError(f"stdio MCP servers are not supported: {', '.join(stdio)}")
        await environment.upload_file(await cloudflared_binary(platform), f"{REMOTE_DIR}/cloudflared")
        await environment.exec(f"chmod 755 {REMOTE_DIR}/cloudflared")
        env = {"SSL_CERT_FILE": f"{REMOTE_DIR}/ca.pem"}
        return {
            mcp_server_name(server.name): await open_tunnel(
                environment, REMOTE_DIR, index, server.url, server.transport, env
            )
            for index, server in enumerate(self.mcp_servers)
        }

    async def _list_skills(self, environment: BaseEnvironment) -> list[tuple[str, str, str]]:
        if not self.skills_dir:
            return []
        listing = await environment.exec(
            f"for f in {shlex.quote(self.skills_dir)}/*/SKILL.md; do [ -f \"$f\" ] && "
            "printf '\\036%s\\n' \"$f\" && awk 'NR==1&&/^---$/{f=1;print;next} f{print; if(/^---$/) exit}' \"$f\"; done"
        )
        skills = []
        for chunk in (listing.stdout or "").split("\x1e")[1:]:
            path, _, head = chunk.partition("\n")
            front = head.split("---")[1] if head.count("---") >= 2 else ""
            try:
                meta = yaml.safe_load(front) or {}
            except yaml.YAMLError:
                meta = {}
            name = meta.get("name") or Path(path).parent.name
            skills.append((str(name), " ".join(str(meta.get("description") or "").split()), path))
        return skills

    def _with_skills(self, instruction: str) -> str:
        if not self._skills:
            return instruction
        lines = "\n".join(f"- {name}: {description} (file: {path})" for name, description, path in self._skills)
        return (
            f"{instruction}\n\n## Skills\n"
            "These skills are installed on the machine. When the task matches a skill's description, "
            "read its SKILL.md with run_command before starting and follow it.\n"
            f"{lines}"
        )

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        client = self._client_for_run()
        try:
            if self._opts.recover and self._agent_id:
                context.metadata = self._metadata()
                await self._wait(client, self._agent_id)
                return
            base = yaml.safe_load(Path(self._opts.agent_config).read_text())
            launched = await client.launch_from_profile(
                self._opts.profile_id, self._opts.config_id, trial_resource_name(self._opts.run_name, self._trial)
            )
            self._agent_id = launched["agent"]["id"]
            self._save_session(agent_id=self._agent_id, agent_started_at=time.time())
            context.metadata = self._metadata()

            current = await client.get_agent(self._agent_id)
            config = dict(base)
            config["machine_sources"] = [{"machine_name": self._machine_name, "cwd": self._cwd}]
            if self._mcp:
                config["mcp"] = {
                    **(config.get("mcp") or {}),
                    **{name: {"url": url, "permission": {"mode": "always_allow"}} for name, url in self._mcp.items()},
                }
            await client.update_agent_config(
                self._agent_id, yaml.safe_dump(config, sort_keys=False), current["agent"]["current_config_id"]
            )

            await client.send_input(self._agent_id, self._with_skills(instruction))
            await self._wait(client, self._agent_id)
        except asyncio.CancelledError:
            if self._agent_id:
                await asyncio.shield(self._quietly(client.cancel_agent(self._agent_id)))
            raise
        finally:
            await asyncio.shield(self._finish(client, context))

    def _metadata(self) -> dict[str, Any]:
        return {
            "omnara_agent_id": self._agent_id,
            "omnara_machine_id": self._machine_id,
            "omnara_profile_id": self._opts.profile_id,
        }

    async def _wait(self, client: Omnara, agent_id: str) -> None:
        after: int | None = None
        finished = False
        watches: dict[str, float] = {}
        seen: str | None = None
        while True:
            agent = (await client.get_agent(agent_id))["agent"]
            activity = agent.get("activity") or {}
            state = activity.get("state")
            if state in ("waiting_on_interaction", "archived"):
                return
            processes = (activity.get("running_processes") or {}).get("count", 0)
            subagents = (activity.get("working_subagents") or {}).get("count", 0)
            if state == "idle" and not subagents:
                while True:
                    page = await client.list_events(agent_id, after)
                    for event in page["data"]:
                        if event["event_kind"] == "model_output":
                            if event.get("stop_reason") == "error":
                                text = " ".join(b.get("text", "") for b in event.get("content_blocks") or [])
                                raise RuntimeError(f"model call failed: {text.strip() or 'no detail'}")
                            finished = event.get("stop_reason") != "tool_use"
                            for block in event.get("content_blocks") or []:
                                args = block.get("input") or {}
                                if block.get("name") == "watch_process" and args.get("process_id"):
                                    started = _timestamp(event["created_at"])
                                    watches[args["process_id"]] = started + float(args.get("timeout_seconds") or 1e9)
                        elif event["event_kind"] in ("agent_input", "tool_result"):
                            finished = False
                            text = " ".join(b.get("text", "") for b in event.get("content_blocks") or [])
                            if text.startswith("Background process "):
                                watches.pop(text.split()[2], None)
                    if not page["data"] or page.get("next_after_sequence") == after:
                        break
                    after = page["next_after_sequence"]
                last = activity.get("last_activity_at")
                watching = any(deadline > time.time() for deadline in watches.values())
                done = finished and (not processes or (not watching and await self._only_servers(processes)))
                if done and seen == last:
                    return
                seen = last if done else None
                if seen is not None:
                    await asyncio.sleep(AGENT_POLL_SEC / 3)
                    continue
            else:
                seen = None
            await asyncio.sleep(AGENT_POLL_SEC * (0.5 + random.random()))

    async def _only_servers(self, processes: int) -> bool:
        if self._environment is None:
            return False
        try:
            result = await self._environment.exec(f"sh -c {shlex.quote(_SERVERS)}", timeout_sec=60)
            running, serving = map(int, (result.stdout or "").split()[-2:])
        except Exception as error:  # noqa: BLE001 - unknown counts as not done
            self.logger.warning("could not check for servers: %s", error)
            return False
        return running == serving == processes

    async def _collect_diagnostics(self) -> None:
        env = self._environment
        if env is None:
            return
        report = (
            f"kill $(cat {REMOTE_DIR}/memsample.pid) 2>/dev/null; {{ "
            "echo '## memory.max'; cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; "
            "echo '## memory.peak'; cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/memory.max_usage_in_bytes; "
            "echo '## memory.events'; cat /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.oom_control; "
            "echo '## meminfo'; head -5 /proc/meminfo; "
            "echo '## dmesg (oom)'; dmesg 2>&1 | grep -i -E 'oom|out of memory|killed process' | tail -50; "
            f"echo '## omnarad home'; ls -la {REMOTE_DIR}/home {REMOTE_DIR}/home/* ; "
            f"}} >{REMOTE_DIR}/diagnostics.txt 2>&1"
        )
        try:
            await env.exec(report, timeout_sec=60)
        except Exception as error:  # noqa: BLE001 - the sandbox may be gone
            self.logger.warning("could not collect diagnostics: %s", error)
        tunnel_logs = tuple(f"tunnel-{index}.log" for index in range(len(self._mcp)))
        for name in ("omnarad.log", "mem.log", "diagnostics.txt", *tunnel_logs):
            try:
                await env.download_file(f"{REMOTE_DIR}/{name}", self.logs_dir / f"omnara-{name}")
            except Exception as error:  # noqa: BLE001 - best effort
                self.logger.warning("could not download %s: %s", name, error)
        try:
            await env.download_dir(f"{REMOTE_DIR}/home/logs", self.logs_dir / "omnara-daemon-logs")
        except Exception as error:  # noqa: BLE001 - best effort
            self.logger.warning("could not download daemon logs: %s", error)

    async def _finish(self, client: Omnara, context: AgentContext) -> None:
        await self._collect_diagnostics()
        if self._agent_id:
            try:
                events = await client.all_events(self._agent_id)
                model = (yaml.safe_load(Path(self._opts.agent_config).read_text()).get("model") or {}).get("name", "")
                pricing = await openrouter_pricing(model) if model else None
                trajectory, totals = build_trajectory(
                    events,
                    agent_name=self.name(),
                    agent_version=self.version() or "",
                    model_name=model,
                    session_id=self._agent_id,
                    pricing=pricing,
                )
                self.logs_dir.mkdir(parents=True, exist_ok=True)
                (self.logs_dir / "trajectory.json").write_text(json.dumps(trajectory, indent=2))
                (self.logs_dir / "omnara-events.json").write_text(json.dumps(events, indent=2))
                context.n_input_tokens = totals.input_tokens
                context.n_cache_tokens = totals.cached_tokens
                context.n_output_tokens = totals.output_tokens
                context.cost_usd = totals.cost_usd
                context.metadata = {
                    **(context.metadata or {}),
                    "stop_reason": totals.stop_reason,
                    "model_calls": totals.model_calls,
                    "reasoning_output_tokens": totals.reasoning_tokens,
                }
            except Exception as error:  # noqa: BLE001 - the trial result matters more
                self.logger.warning("could not record Omnara trajectory: %s", error)
        await client.aclose()
        self._client = None

    async def _quietly(self, awaitable: Any) -> None:
        try:
            await awaitable
        except (OmnaraError, httpx.HTTPError) as error:
            self.logger.warning("Omnara cleanup call failed: %s", error)
