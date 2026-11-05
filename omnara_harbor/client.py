from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

_RETRYABLE = {502, 503, 504, 520, 521, 522, 523, 524, 530}
_RATE_LIMIT_WAIT_SEC = 900.0
_RETRY_AFTER_TEXT = re.compile(r"retry after (\d+(?:\.\d+)?)s")


def _retry_after_sec(response: httpx.Response) -> float:
    header = response.headers.get("Retry-After", "").strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", header):
        return max(float(header), 1.0)
    match = _RETRY_AFTER_TEXT.search(response.text)
    return max(float(match.group(1)), 1.0) if match else 5.0


@dataclass(frozen=True)
class Credentials:
    api_url: str
    token: str
    org_id: str
    project_id: str


def load_credentials(org_id: str | None = None, project_id: str | None = None) -> Credentials:
    saved: dict[str, Any] = {}
    path = Path.home() / ".config" / "omnara" / "config.json"
    if path.exists():
        saved = json.loads(path.read_text())
    token = os.environ.get("OMNARA_API_KEY") or saved.get("token")
    api_url = os.environ.get("OMNARA_API_URL") or saved.get("api_url") or "https://api.omnara.com/v1"
    org = org_id or os.environ.get("OMNARA_ORG_ID") or saved.get("org_id")
    project = project_id or os.environ.get("OMNARA_PROJECT_ID") or saved.get("project_id")
    if not token:
        raise RuntimeError("not logged in: run `omnara login` or set OMNARA_API_KEY")
    if not org or not project:
        raise RuntimeError("set the Omnara org and project (agent kwargs, OMNARA_ORG_ID/OMNARA_PROJECT_ID)")
    return Credentials(api_url.rstrip("/"), token, org, project)


class OmnaraError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"Omnara API {status}: {body[:500]}")
        self.status = status
        self.body = body


class Omnara:
    def __init__(self, creds: Credentials):
        self.creds = creds
        self._http = httpx.AsyncClient(
            base_url=creds.api_url,
            headers={"Authorization": f"Bearer {creds.token}", "User-Agent": "omnara-harbor"},
            timeout=httpx.Timeout(60.0, connect=15.0),
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    @property
    def org(self) -> str:
        return f"/orgs/{self.creds.org_id}"

    @property
    def project(self) -> str:
        return f"{self.org}/projects/{self.creds.project_id}"

    async def request(self, method: str, path: str, *, json_body: Any = None, params: Any = None,
                      idempotent: bool | None = None) -> Any:
        headers: dict[str, str] = {}
        if idempotent is None:
            idempotent = method in ("GET", "PUT", "DELETE")
        if method == "POST" and idempotent:
            headers["Idempotency-Key"] = str(uuid.uuid4())
        attempt = 0
        limited_since: float | None = None
        while True:
            try:
                response = await self._http.request(method, path, json=json_body, params=params, headers=headers)
            except httpx.TransportError:
                if not idempotent or attempt == 7:
                    raise
            else:
                if response.status_code < 400:
                    return response.json() if response.content else None
                if response.status_code == 429:
                    now = time.monotonic()
                    limited_since = limited_since or now
                    if now - limited_since > _RATE_LIMIT_WAIT_SEC:
                        raise OmnaraError(response.status_code, response.text)
                    await asyncio.sleep(_retry_after_sec(response) * (1 + random.random()))
                    continue
                if not (idempotent and response.status_code in _RETRYABLE) or attempt == 7:
                    raise OmnaraError(response.status_code, response.text)
            await asyncio.sleep(min(30.0, 2**attempt) * (0.5 + random.random()))
            attempt += 1


    async def create_config(self, source: str) -> dict[str, Any]:
        return await self.request("POST", f"{self.project}/agent-configs",
                                  json_body={"source": source, "source_format": "yaml"})

    async def create_profile(self, name: str, config_id: str) -> dict[str, Any]:
        return await self.request("POST", f"{self.project}/agent-profiles",
                                  json_body={"name": name, "config": config_id}, idempotent=True)

    async def launch_from_profile(self, profile_id: str, config_id: str, name: str) -> dict[str, Any]:
        return await self.request("POST", f"{self.project}/agents",
                                  json_body={"profile": profile_id, "config": config_id, "name": name},
                                  idempotent=True)

    async def get_agent(self, agent_id: str) -> dict[str, Any]:
        return await self.request("GET", f"{self.project}/agents/{agent_id}")

    async def update_agent_config(self, agent_id: str, source: str, expected_config_id: str) -> dict[str, Any]:
        return await self.request(
            "POST", f"{self.project}/agents/{agent_id}/config",
            json_body={"source": source, "source_format": "yaml", "expected_current_config_id": expected_config_id},
            idempotent=True,
        )

    async def send_input(self, agent_id: str, text: str) -> dict[str, Any]:
        return await self.request("POST", f"{self.project}/agents/{agent_id}/inputs",
                                  json_body={"content_blocks": [{"type": "text", "text": text}]}, idempotent=True)

    async def cancel_agent(self, agent_id: str) -> None:
        await self.request("POST", f"{self.project}/agents/{agent_id}/cancel", json_body={}, idempotent=True)

    async def list_events(self, agent_id: str, after: int | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": 500}
        if after is not None:
            params["after_sequence"] = after
        return await self.request("GET", f"{self.project}/agents/{agent_id}/events", params=params)

    async def all_events(self, agent_id: str) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        after: int | None = None
        while True:
            page = await self.list_events(agent_id, after)
            events.extend(page["data"])
            if not page["data"] or page.get("next_after_sequence") == after:
                return events
            after = page["next_after_sequence"]


    async def connect_byo_machine(self, name: str, cwd: str | None) -> dict[str, Any]:
        body: dict[str, Any] = {"display_name": name, "project_ids": [self.creds.project_id]}
        if cwd:
            body["cwd"] = cwd
        return await self.request("POST", f"{self.org}/machines/connect", json_body=body, idempotent=True)

    async def get_machine(self, machine_id: str) -> dict[str, Any]:
        return await self.request("GET", f"{self.org}/machines/{machine_id}")

    async def delete_machine(self, machine_id: str) -> None:
        await self.request("DELETE", f"{self.org}/machines/{machine_id}")
