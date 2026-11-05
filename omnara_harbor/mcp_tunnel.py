from __future__ import annotations

import asyncio
import hashlib
import re
import shlex
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from harbor.environments.base import BaseEnvironment

RELEASES_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
CACHE_DIR = Path.home() / ".cache" / "omnara-harbor" / "cloudflared"
TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


async def cloudflared_binary(platform: str) -> Path:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as http:
        release = (await http.get(RELEASES_API)).raise_for_status().json()
        name = f"cloudflared-linux-{platform}"
        asset = next(a for a in release["assets"] if a["name"] == name)
        path = CACHE_DIR / release["tag_name"] / name
        if not path.exists():
            data = (await http.get(asset["browser_download_url"])).raise_for_status().content
            digest = asset.get("digest") or ""
            if digest.startswith("sha256:") and hashlib.sha256(data).hexdigest() != digest.removeprefix("sha256:"):
                raise RuntimeError(f"cloudflared {release['tag_name']} digest mismatch")
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(f".{id(data)}.partial")
            partial.write_bytes(data)
            partial.replace(path)
    return path


def mcp_server_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9-]+", "-", name).strip("-") or "mcp"


async def open_tunnel(
    environment: BaseEnvironment, remote_dir: str, index: int, url: str, transport: str, env: dict[str, str]
) -> str:
    target = urlsplit(url)
    origin = f"{target.scheme}://{target.netloc}"
    path = target.path or "/"
    if transport == "sse" and path.endswith("/sse"):
        path = path.removesuffix("/sse") + "/mcp"
    log = f"{remote_dir}/tunnel-{index}.log"
    start = (
        f"(setsid sh -c {shlex.quote(f'exec {remote_dir}/cloudflared tunnel --no-autoupdate --protocol http2 --url {origin}')} "
        f"</dev/null >{log} 2>&1 &)"
    )
    result = await environment.exec(start, env=env)
    if result.return_code != 0:
        raise RuntimeError(f"failed to start cloudflared: {result.stderr or result.stdout}")

    deadline = time.monotonic() + 90
    public = None
    while public is None:
        output = (await environment.exec(f"cat {log}")).stdout or ""
        if match := TUNNEL_URL.search(output):
            public = match.group(0)
        elif time.monotonic() > deadline:
            raise RuntimeError(f"cloudflared did not report a tunnel URL: {output[-1500:]}")
        else:
            await asyncio.sleep(2)

    endpoint = public + path
    async with httpx.AsyncClient(timeout=10) as http:
        while True:
            try:
                async with http.stream("GET", endpoint, headers={"Accept": "text/event-stream"}) as response:
                    if response.status_code < 500:
                        return endpoint
            except httpx.HTTPError:
                pass
            if time.monotonic() > deadline:
                raise RuntimeError(f"tunnel {endpoint} did not become reachable")
            await asyncio.sleep(2)
