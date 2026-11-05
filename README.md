# Terminal-Bench on Omnara

Runs Omnara agents on [Harbor](https://github.com/harbor-framework/harbor)
benchmarks such as Terminal-Bench, against `api.omnara.com`. Harbor owns the
sandboxes, grading and job output. Omnara owns the agent loop.

```
omnara-tb ──▶ Omnara: base config + agent profile for the run (once)
          └─▶ harbor run -a omnara_harbor.agent:OmnaraAgent ...
                │ per trial, Harbor creates the task sandbox (e.g. on Modal)
                ├─ setup: connect a BYO machine, copy omnarad into the sandbox, start it
                ├─ run:   launch an agent from the profile, attach the BYO machine
                │         (config update), send the instruction, wait
                ├─ trajectory.json (ATIF) + tokens/cost into Harbor's trial result
                └─ Harbor grades the trial; omnara-tb deletes the machines after the job
```

Because grading, verifier containers and multi-container tasks are Harbor's,
every Terminal-Bench task type works. That includes docker-compose tasks,
GPU tasks on Modal and separate verifiers. Results are standard Harbor jobs.

## Setup

- Log the Omnara CLI in to `app.omnara.com` (`npx omnara login`). Set
  `OMNARA_API_KEY` instead for an org API key.
- The project needs a grant for the model in your agent config (for example
  `omnara-openrouter` → `openai/gpt-6.1-sol`).
- For Modal sandboxes, log in with `uvx modal setup`.
- `uv sync` in this directory installs Harbor and this package.

## Run

```sh
uv run omnara-tb --agent-config agent.codex.yaml --name "tb4.0 codex" \
  --org org_... --project proj_... -- \
  -d terminal-bench/terminal-bench@4.0.0 -e modal -n 32
```

Everything after `--` goes to `harbor run` unchanged (`-d`, `-i`, `-e`, `-n`,
`-k`, …). `omnara-tb` options:

| Option | |
| --- | --- |
| `--agent-config` | Base agent config. [`agent.codex.yaml`](agent.codex.yaml) mirrors Codex with GPT-6.1 Sol; [`agent.claude-code.yaml`](agent.claude-code.yaml) mirrors Claude Code; [`agent.yaml`](agent.yaml) is a minimal prompt. |
| `--model`, `--effort` | Override the config's model name and reasoning effort. |
| `--name` | Run name; the profile is `<name> <model> <timestamp>`, and agents and machines are `<run> · <trial>`. |
| `--org`, `--project` | Omnara org and project (default: CLI login or `OMNARA_ORG_ID`/`OMNARA_PROJECT_ID`). |
| `--omnarad-binary` | Upload this `omnarad` build instead of the latest release. |
| `--no-default-excludes` | Also run the tasks [`exclusions.yaml`](exclusions.yaml) leaves out by default: `cad-model` (broken reference solution) and the security tasks. |
| `--exclude-gpu` | Also leave out the GPU tasks, which need H100s on Modal. |

Results land in `jobs/<run>/`. Each trial's `agent/` has `trajectory.json`
(ATIF) and the raw `omnara-events.json`. `harbor view jobs` browses them, and
[`viewer/`](viewer) compares a run with a Harbor Hub leaderboard row.

## How a trial runs

1. **Machine.** `POST /orgs/{org}/machines/connect` creates a BYO machine
   granted to the project and returns a daemon token. The released `omnarad`
   for the sandbox's architecture is checked against its published digest,
   then copied into the sandbox with a CA bundle (some task images have none).
   It is installed under `/tmp/omnara` and started with `--no-service`. The
   token is passed through the environment, not the command line.
2. **Agent.** The agent is launched from the run's profile with its base
   config: `api.omnara.com` still requires `config` on launch. A config update
   then adds `machine_sources: [{machine_name, cwd}]`, attaching the trial's
   machine with the sandbox's working directory. The instruction goes in as
   the first input.
3. **Finish.** The agent is done when it is idle and its last model output
   ended its turn. On Harbor's agent timeout the Omnara agent is cancelled.
   The trajectory, tokens and cost are recorded. Cost uses OpenRouter's
   published prices for the model. Agents stay active under the profile for
   inspection.
4. **Cleanup.** The machine stays connected while Harbor grades the trial:
   deleting a machine makes `omnarad` stop the processes it started, such as a
   server the verifier checks. Each trial records its machine in
   `agent/omnara-machine.json`, and `omnara-tb` deletes them all once
   `harbor run` exits.

`omnara-tb` passes `--allow-agent-host api.omnara.com` so the daemon can reach
Omnara in tasks that restrict network access.
