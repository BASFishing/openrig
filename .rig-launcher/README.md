# Personal multi-agent rig tooling

This folder (plus the `.ollama-pilot/` and `.*-rig/` directories elsewhere in
this repo) is personal tooling built on top of OpenRig — a generic launcher
for running local-model + Claude collaboration rigs, not part of the OpenRig
product itself.

## What's tracked here vs. what's excluded, and why

**Tracked (this is authored config/code, portable by design):**
- `launcher.py` — the actual launcher logic
- `OpenRig Launcher.command` — the double-clickable entry point (copy to
  `~/Desktop/` on a new machine; see Setup below for the one edit it needs)
- Every `.*-rig/` directory (e.g. `.tls-rig/`, `.ollama-pilot/`'s `rig.yaml`/
  `agents/`/`srt-config.json`) — these intentionally contain **no absolute
  paths**. A seat's actual working directory is always supplied via `--cwd`
  at launch time, never baked into the spec, so these are fully portable.

**Excluded (genuinely machine-specific or secret):**
- `.rigs-registry.json` — real absolute paths for *this* machine. Auto-seeded
  fresh by `launcher.py` on first run if absent (see `DEFAULT_REGISTRY` in
  `launcher.py`), so there's nothing to hand-recreate.
- `.rigs-secrets.env` — real API key **values** for any seat using a distinct
  Claude account (see `apiKeyEnv` in the main OpenRig daemon). Never commit
  this, on any machine.
- `.ollama-pilot/workspace/` — runtime-generated per-seat state (readiness
  sidecar, persisted chat history, the merged `AGENTS.md`). Mechanically
  regenerated from the tracked `agents/*/guidance/role.md` on every launch —
  never authored by hand, nothing to replicate.
- `__pycache__/` — Python bytecode cache, standard.

## External dependencies (NOT in this repo — install separately)

| Dependency | Why | Install |
|---|---|---|
| Node 22 LTS | This repo's native deps (`better-sqlite3`) don't build against newer Node. Installed **keg-only** so it doesn't touch your global `node`. | `brew install node@22` |
| tmux | Every seat is a tmux pane; the launcher also uses it directly. | `brew install tmux` |
| Ollama | Serves the local model(s). | `brew install ollama` (or ollama.com) |
| ripgrep | Required by `sandbox-runtime`. | `brew install ripgrep` |
| `@anthropic-ai/sandbox-runtime` (`srt`) | OS-level sandbox wrapping each project's `opencode serve` — enforces the filesystem/network restrictions in each `srt-config.json`. | `npm install -g @anthropic-ai/sandbox-runtime` |
| `opencode` CLI | Backs the local seat's Read/Grep/Glob/Bash/tool execution (`opencode serve`, run inside `srt`). | See opencode.ai — exact install method not re-verified on this machine, just confirmed already present. |
| herdr | Terminal workspace viewer; the launcher auto-pops each rig's seats into it. | `brew install herdr` |
| cmux | Alternative terminal workspace viewer (optional — requires running commands from inside it; see the herdr-vs-cmux discussion earlier in this project's history for tradeoffs). | `brew install --cask cmux` |
| Claude Code CLI | Required for any `claude-code` seat. | Standard Claude Code install |
| This repo itself, built | The daemon/CLI the launcher drives. | `npm install && npm run build` (with Node 22 on `PATH`) |

## The `rig` command wrapper

`rig` is invoked globally throughout the launcher and these docs. It's a
tiny wrapper, not part of any package — recreate it at `/opt/homebrew/bin/rig`
on a new machine:

```bash
#!/usr/bin/env bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
exec node /Users/bakari/Documents/GitHub/openrig/packages/cli/dist/bin-wrapper.js "$@"
```

(`chmod +x` it.) **Edit the hardcoded path** if this repo lives somewhere
other than `/Users/bakari/Documents/GitHub/openrig` on the new machine.

## Local models

The seats in this registry use `qwen3.5-9b-uncensored` (and a 35B variant
exists), imported into Ollama from a GGUF originally downloaded via LM Studio
(`HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive`). To replicate:

1. Get the GGUF (LM Studio's model browser, or wherever you source it).
2. `ollama create qwen3.5-9b-uncensored -f Modelfile` with a Modelfile
   containing `FROM /path/to/the.gguf`.

Any model already in Ollama's own library works too — `model:` in a seat's
section of `.rigs-registry.json`, or the `model` prompt when creating a new
project through the launcher, just needs to match whatever `ollama list`
shows.

## Setup on a new machine, in order

1. Clone this repo; install the dependencies table above.
2. `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"; npm install && npm run build` in the repo root.
3. Recreate `/opt/homebrew/bin/rig` (above), editing the path if needed.
4. Import whatever local model(s) your rigs reference (above).
5. Copy `.rig-launcher/OpenRig Launcher.command` to `~/Desktop/`, `chmod +x` it.
6. Double-click it. First run seeds `.rigs-registry.json` fresh (pointing at
   wherever your projects actually live on *this* machine — the tracked
   `rig.yaml`s don't care, but you'll want to confirm the seeded `path`
   entries are right, or just delete the file and let a new project walk
   you through it from the launcher's menu).
7. If any seat needs a distinct Claude API key, create `.rigs-secrets.env`
   by hand (`VARNAME=key`, one per line) — the launcher's "add a seat" flow
   does this for you when creating a new project, but an existing registry
   entry referencing a key needs it created manually.
