# Personal multi-agent rig tooling

This folder (plus the `.ollama-pilot/` and `.*-rig/` directories elsewhere in
this repo) is personal tooling built on top of OpenRig — a generic launcher
for running local-model + Claude collaboration rigs, not part of the OpenRig
product itself.

## How a local-model seat actually runs

An `ollama` seat's pane runs `opencode` directly — not a hand-rolled runner.
opencode already supports Ollama as a model provider and has its own full
agentic loop (tool-calling, read/write/edit/bash, context compaction), so
OpenRig's `OllamaRuntimeAdapter` just launches it, same as how the Claude
Code and Codex adapters launch their own native binaries:

- At every launch, the adapter writes/merges `<seat-cwd>/opencode.json` so
  opencode's provider resolution finds Ollama under the `ollama` provider id.
- If `<seat-cwd>/.openrig/ollama/srt-config.json` exists, the launch command
  is wrapped in `srt --settings <that file> --`; if absent, it launches
  unsandboxed. This is a **per-seat-cwd convention**, not a shared pane — each
  seat's sandbox is scoped to its own project directory.
- `dispatch_to_seat` (letting the local model delegate to another seat, e.g.
  a Claude seat, via `rig send`) is a real opencode custom tool at
  `.opencode/tool/dispatch_to_seat.ts` inside the project — opencode
  auto-discovers it. `scaffold_project` (below) copies it in from
  `.rig-launcher/opencode-tools/dispatch_to_seat.ts` for any rig with an
  `ollama` seat.

There is no separate "sandboxed opencode server" pane and no manual
"enable tools" step anymore — every seat's own opencode process already has
tools built in from the moment it starts.

## What's tracked here vs. what's excluded, and why

**Tracked (this is authored config/code, portable by design):**
- `launcher.py` — the actual launcher logic
- `opencode-tools/dispatch_to_seat.ts` — the custom tool template copied into
  new `ollama`-seat projects
- `OpenRig Launcher.command` — the double-clickable entry point (copy to
  `~/Desktop/` on a new machine; see Setup below for the one edit it needs)
- Every `.*-rig/` directory (e.g. `.tls-rig/`, `.ollama-pilot/`'s `rig.yaml`/
  `agents/`) — these intentionally contain **no absolute paths**. A seat's
  actual working directory is always supplied via `--cwd` at launch time,
  never baked into the spec, so these are fully portable.

**Excluded (genuinely machine-specific or secret):**
- `.rigs-registry.json` — real absolute paths for *this* machine. Auto-seeded
  fresh by `launcher.py` on first run if absent (see `DEFAULT_REGISTRY` in
  `launcher.py`), so there's nothing to hand-recreate.
- `.rigs-secrets.env` — reserved for a future per-seat credential feature
  (see Known limitations below); currently unused.
- `.ollama-pilot/workspace/` — runtime-generated per-seat state (persisted
  chat history, merged AGENTS.md). Mechanically regenerated from the tracked
  `agents/*/guidance/role.md` on every launch — never authored by hand,
  nothing to replicate. **Caveat:** this also currently swallows
  `.ollama-pilot/workspace/.openrig/ollama/srt-config.json` — the *authored*
  sandbox policy for the `pilot` project specifically, which per the
  per-seat-cwd convention above now lives inside this ignored tree. It's
  real config, not regenerated state, but git can't selectively re-include a
  file under an ignored parent directory without restructuring this ignore
  rule from "ignore the whole directory" to "ignore specific filenames
  inside it." Not yet done — if you're replicating the `pilot` project on a
  new machine, hand-copy that one file, or regenerate it from
  `write_srt_config` in `launcher.py`. Any `ollama` seat whose project lives
  *outside* this repo (e.g. `tls`) isn't affected — its srt-config.json lives
  in that other project's own directory, under that project's own tracking
  policy, not this one.
- `__pycache__/` — Python bytecode cache, standard.

## External dependencies (NOT in this repo — install separately)

| Dependency | Why | Install |
|---|---|---|
| Node 22 LTS | This repo's native deps (`better-sqlite3`) don't build against newer Node. Installed **keg-only** so it doesn't touch your global `node`. | `brew install node@22` |
| tmux | Every seat is a tmux pane; the launcher also uses it directly. | `brew install tmux` |
| Ollama | Serves the local model(s). | `brew install ollama` (or ollama.com) |
| ripgrep | Required by `sandbox-runtime`. | `brew install ripgrep` |
| `@anthropic-ai/sandbox-runtime` (`srt`) | OS-level sandbox wrapping each `ollama` seat's own `opencode` process — enforces the filesystem/network restrictions in that seat's `srt-config.json`. | `npm install -g @anthropic-ai/sandbox-runtime` |
| `opencode` CLI | IS the local seat's agent — launched directly in the pane, configured via `opencode.json` to use Ollama as its model provider. Not a separate backend process. | See opencode.ai — exact install method not re-verified on this machine, just confirmed already present (1.18.23 at last check). |
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

## Known limitations

- **Per-seat distinct Claude API keys are not currently supported.** An
  earlier version of this tooling had a working `apiKeyEnv` mechanism (one
  Claude account per seat), but it was dropped in favor of a planned
  rate-limit **failover** router (switch to a second key when the first
  hits its rate limit, rather than running two accounts simultaneously) —
  not yet built. `launcher.py`'s interactive "add a seat" flow may still ask
  about a per-seat API key; if it does, that's stale and the answer is
  currently a no-op (the daemon ignores the field). This will be replaced
  once the failover router lands.

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
