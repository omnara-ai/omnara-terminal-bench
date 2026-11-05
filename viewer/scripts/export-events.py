import json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

base, snapshots = sys.argv[1].rstrip("/"), sys.argv[2:]
token = os.environ["OMNARA_API_KEY"]
out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "events")
os.makedirs(out_dir, exist_ok=True)


def get(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "User-Agent": "omnara-tb-viewer"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def export(job):
    org, project, agent = job
    path = os.path.join(out_dir, f"{agent}.json")
    if os.path.exists(path):
        return agent, "cached", os.path.getsize(path)
    events, after = [], None
    while True:
        url = f"{base}/orgs/{org}/projects/{project}/agents/{agent}/events?limit=500" + (f"&after_sequence={after}" if after is not None else "")
        page = get(url)
        events += page["data"]
        if not page.get("has_more") or not page["data"]:
            break
        after = page["next_after_sequence"]
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(events, f, separators=(",", ":"))
    os.replace(tmp, path)
    return agent, len(events), os.path.getsize(path)


jobs = []
for snapshot in snapshots:
    data = json.load(open(snapshot))
    jobs += [(data["orgId"], data["projectId"], t["agentId"]) for t in data["trials"] if t.get("agentId")]


def safe_export(job):
    try:
        return export(job)
    except Exception as error:  # noqa: BLE001 - report every agent that failed, then exit non-zero
        return job[2], f"failed: {error}", 0


with ThreadPoolExecutor(4) as pool:
    results = list(pool.map(safe_export, jobs))
failed = [(agent, n) for agent, n, _ in results if isinstance(n, str) and n.startswith("failed")]
for agent, error in failed:
    print(agent, error)
total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir) if f.endswith(".json"))
print(f"{len(jobs)} agents, {len(failed)} failed, {len(os.listdir(out_dir))} files, {total / 1e6:.1f} MB in {out_dir}")
sys.exit(1 if failed else 0)
