# Terminal-Bench run viewer

The frontend for viewing the results: a Vite app on Cloudflare Workers that compares Omnara with
the model's own harness on Terminal-Bench 4.0, Omnara on Opus 5.5 max against Claude Code and
Omnara on GPT-6.1 Sol max against Codex.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set OMNARA_API_KEY to a project-scoped API token
pnpm dev
```
