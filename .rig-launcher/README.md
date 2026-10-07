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
- If `<seat-cwd>/.openrig/ollama/fence-config.json` exists, the launch command
  is wrapped in `fence --settings <that file> --`; if absent, it launches
  unsandboxed. This is a **per-seat-cwd convention**, not a shared pane — each
  seat's sandbox is scoped to its own project directory. This is `fence`
  (fencesandbox/fence), not Anthropic's `srt` (`@anthropic-ai/sandbox-runtime`)
  — srt cannot run an interactive TUI on macOS at all (confirmed live: Seatbelt's
  file-ioctl rule covers the generic `/dev/tty` alias, not the pty slave device
  a real terminal is, so opencode's `setRawMode()` call fails with EPERM every
  time; the open upstream fix, anthropics/sandbox-runtime#480, has sat with zero
  maintainer engagement since 2026-08-16). `fence` solved the identical bug
  class months earlier and ships `allowPty` — verified live end-to-end before
  switching: the TUI starts cleanly, a real secret file under `~/.ssh` was
  denied, and opencode's own `WebFetch` tool call to a non-allowlisted domain
  came back 403 (network restriction genuinely enforced for opencode's real
  traffic, not silently bypassed).
- `dispatch_to_seat` (letting the local model delegate to another seat, e.g.
  a Claude seat, via `rig send`) is a real opencode custom tool at
  `.opencode/tool/dispatch_to_seat.ts` inside the project — opencode
  auto-discovers it. `scaffold_project` (below) copies it in from
  `.rig-launcher/opencode-tools/dispatch_to_seat.ts` for any rig with an
  `ollama` seat.
- Both `dispatch_to_seat.ts` and the memory plugin (below) do a real runtime
  `import ... from "@opencode-ai/plugin"` — opencode's plugin-authoring API
  package, not a type-only import. `scaffold_project` installs it via
  `ensure_opencode_plugin_dependency()` into `<project>/.opencode/node_modules`
  (its own throwaway `package.json`, `npm install --no-save`, pinned to the
  installed opencode CLI's own version) so it resolves for any file under
  `.opencode/tool/` or `.opencode/plugin/` without touching the host
  project's own package.json/node_modules (which may not exist, or may be
  for an entirely different language — confirmed live: `prefore`'s root is
  Python). **Found the hard way**: skip this step and every message to that
  seat fails silently — opencode's `ToolRegistry` throws
  `Cannot find module '@opencode-ai/plugin'` before ever calling the model,
  the assistant turn comes back with zero tokens and no visible error, and
  it looks exactly like an unresponsive local model rather than a missing
  dependency. If a project was scaffolded before this fix (check for
  `.opencode/node_modules/@opencode-ai/plugin`), re-run
  `ensure_opencode_plugin_dependency(path)` by hand or just re-scaffold.
- `dispatch_to_seat.ts` shells out to `rig send`, and `rig` is only
  installed as a local dev build (`/opt/homebrew/bin/rig` execs
  `<OPENRIG_DIR>/packages/cli/dist/bin-wrapper.js` directly — no published
  global package). Seatbelt sandboxes inherit down the process tree, so
  that child `rig` process is confined by the SAME fence config as the
  parent opencode seat. **Found the hard way (prefore, live)**: without
  `<OPENRIG_DIR>/packages/**` + `node_modules/**` + `package.json` in
  `allowRead`, every `dispatch_to_seat` call died with `EPERM: open
  '.../packages/cli/dist/bin-wrapper.js'` — and the resulting tool-error
  result fed back into the model's next turn is what then triggered a
  separate, very confusing-looking Ollama error ("Jinja Exception: No user
  query found in messages"), which looks like a chat-template/model bug
  but is really just fallout from the sandbox denial upstream of it. Needs
  the whole `packages/` tree, not just `cli/`: it's an npm workspace,
  `node_modules/@openrig/*` are symlinks to the other workspace packages
  (daemon/ui/tui), and Seatbelt resolves symlinks to their real target
  before applying rules. `write_fence_config()` denies
  `<OPENRIG_DIR>/.rigs-secrets.env` explicitly rather than relying on it
  simply not being inside `packages/`.

There is no separate "sandboxed opencode server" pane and no manual
"enable tools" step anymore — every seat's own opencode process already has
tools built in from the moment it starts.

## What's tracked here vs. what's excluded, and why

**Tracked (this is authored config/code, portable by design):**
- `launcher.py` — the actual launcher logic
- `opencode-tools/dispatch_to_seat.ts` — the custom tool template copied into
  new `ollama`-seat projects
- `opencode-memory/` — the memory plugin (`recall_context` tool + indexing/
  pre-compaction hooks) copied whole into new `ollama`-seat projects; see
  "Agent memory" below
- `OpenRig Launcher.command` — the double-clickable entry point (copy to
  `~/Desktop/` on a new machine; see Setup below for the one edit it needs)
- Every `.*-rig/` directory (e.g. `.tls-rig/`, `.ollama-pilot/`'s `rig.yaml`/
  `agents/`) — these intentionally contain **no absolute paths**. A seat's
  actual working directory is always supplied via `--cwd` at launch time,
  never baked into the spec, so these are fully portable.
- `.ollama-pilot/workspace/.openrig/ollama/fence-config.json` — the `pilot`
  project's authored sandbox policy. It lives inside the otherwise-ignored
  `workspace/` tree (per-seat-cwd convention — see above), so the `.gitignore`
  carves out this one path specifically (`.openrig/` is excluded at any depth
  by a different, unrelated rule; git can't re-include a file under an
  excluded parent without negating that parent first — see the comment above
  this exception in `.gitignore` if you're adding another one). An `ollama`
  seat whose project lives *outside* this repo (e.g. `tls`) isn't affected —
  its fence-config.json lives in that other project's own directory, under
  that project's own tracking policy, not this one.
- `.ollama-pilot/workspace/.openrig/ollama/memory-config.json` — same carve-
  out as fence-config.json above, same reasoning: small, authored-at-scaffold-
  time, no conversation content. The memory system's actual data (the chunk
  store under `.openrig/ollama/memory/`) is NOT given this treatment — see
  Excluded below.

**Excluded (genuinely machine-specific or secret):**
- `.rigs-registry.json` — real absolute paths for *this* machine. Auto-seeded
  fresh by `launcher.py` on first run if absent (see `DEFAULT_REGISTRY` in
  `launcher.py`), so there's nothing to hand-recreate.
- `.rigs-secrets.env` — reserved for a future per-seat credential feature
  (see Known limitations below); currently unused.
- `.ollama-pilot/workspace/` — runtime-generated per-seat state (persisted
  chat history, merged AGENTS.md, the old sidecar). Mechanically regenerated
  from the tracked `agents/*/guidance/role.md` on every launch — never
  authored by hand, nothing to replicate (the authored exceptions,
  fence-config.json and memory-config.json, are called out above). This
  includes `.openrig/ollama/memory/` — the memory system's chunk store,
  which unlike those two DOES contain real conversation content and must
  never be tracked.
- `__pycache__/` — Python bytecode cache, standard.

## External dependencies (NOT in this repo — install separately)

| Dependency | Why | Install |
|---|---|---|
| Node 22 LTS | This repo's native deps (`better-sqlite3`) don't build against newer Node. Installed **keg-only** so it doesn't touch your global `node`. | `brew install node@22` |
| tmux | Every seat is a tmux pane; the launcher also uses it directly. | `brew install tmux` |
| Ollama | Serves the local model(s). | `brew install ollama` (or ollama.com) |
| ripgrep | Backs opencode's own `grep` tool. | `brew install ripgrep` |
| `fence` (fencesandbox/fence, Apache-2.0) | OS-level sandbox wrapping each `ollama` seat's own `opencode` process — enforces the filesystem/network restrictions in that seat's `fence-config.json`. Not Anthropic's `srt` — see "How a local-model seat actually runs" above for why. Pin a specific version rather than trusting "latest" (the installer has no checksum verification). | `curl -fsSL https://cli.fencesandbox.com/install.sh \| FENCE_VERSION=v0.1.67 sh` |
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

## Claude key failover (daemon-wide, not per-project)

Per-seat distinct Claude accounts were dropped. Instead, every Claude seat
on this daemon shares ONE active Anthropic API key; when that key's
rate-limit window is exhausted (read from the same `five_hour` usage signal
Claude Code's own statusline already reports), the daemon's router switches
to the next configured candidate automatically.

- **Configure it:** launcher main menu → "Configure Claude key failover" (not
  tied to any one project). Paste 2+ keys when prompted; they're stored in
  `.rigs-secrets.env` under generated names
  (`ANTHROPIC_API_KEY_CANDIDATE_1`, `_2`, ...), and the daemon's
  `recovery.anthropic_key_candidates` + `recovery.provider_auth_env_allowlist`
  settings are set via `rig config set` to point at them.
- **Takes effect on restart, not instantly:** same constraint as every
  daemon-env-at-boot setting in this tooling — `rig daemon stop && rig daemon
  start` after configuring or changing keys. A switch the router makes WHILE
  the daemon is running takes effect on each seat's next launch/resume
  (fresh start, handover, or a manual reconnect) — not by interrupting an
  already-running `claude` process, which doesn't re-read credentials mid-run
  anyway.
- **One known approximation:** the usage signal that triggers a switch isn't
  tagged by which key was active when it was recorded (OpenRig's own
  usage-metering schema carries no account identity by design). Switching
  keys doesn't retroactively reclassify old readings; the next seat to
  report simply reflects whichever key is active by then.
- Without this configured (fewer than 2 keys, or the allowlist entry unset),
  behavior is byte-identical to plain upstream OpenRig — nothing about this
  feature is on by default.

## Agent memory (`recall_context`)

Each `ollama` seat's `opencode` process runs with an extra plugin. Confirmed
empirically against the real installed opencode (not just docs, which say
"plugins" plural and don't mention this): opencode only auto-discovers
plugin entry files at the TOP LEVEL of `.opencode/plugin/` (singular) — a
file nested in a subdirectory is never loaded, even though it can still be
imported by a top-level file. So `scaffold_project` copies the whole
`.rig-launcher/opencode-memory/` tree (plugin.ts + its sibling modules
memory-store.ts/embeddings.ts/supersession.ts) into
`.opencode/plugin/opencode-memory/` as a subdirectory, then writes a tiny
top-level shim, `.opencode/plugin/opencode-memory-shim.ts`
(`export { OpenRigMemory } from "./opencode-memory/plugin.js";`), so
discovery actually finds it. It indexes that seat's own
conversation into a local chunk store as it goes and exposes a custom tool,
`recall_context`, so the model can pull back relevant history that opencode's
own context compaction would otherwise have lossily summarized or dropped —
tool-based semantic recall over a seat's own conversation, surviving
compaction, not a replacement for opencode's context window.

- **Opt-in per seat, not per rig:** `agent.yaml`'s `memory_privileged` field
  (new under `defaults:`, next to `runtime:`) defaults to `false`. Every seat
  — privileged or not — still gets full read/write over its OWN session's
  memory; the field only governs whether this seat may also read and write
  OTHER seats' shared memory. Prompted at scaffold time ("Give this local
  seat privileged memory access (read other seats' shared memory, write to
  it)? [y/N]") for every `ollama` seat, in both the default-pair flow and the
  "add a seat" flow. Only meaningful for `ollama` seats.
- **Requires an embedding model pulled in Ollama:** `ollama pull
  nomic-embed-text` (confirmed against `.rig-launcher/opencode-memory/
  embeddings.ts`, which defaults to that model name against Ollama's
  `/api/embed` endpoint).
- **Access control file:** `<seat cwd>/.openrig/ollama/memory-config.json`
  (`{"privileged": bool, "seatId": "..."}`), written by `scaffold_project`
  alongside `fence-config.json` — small and authored-at-scaffold-time, so
  unlike the memory data itself it's tracked, not gitignored.
- **Known multi-seat limitation:** `memory-config.json` lives at a
  per-project-path location, not per-seat. If a rig ever has more than one
  `ollama` seat sharing the same project `path` (today's launcher model is
  one `path` per rig), whichever seat's scaffold step runs last wins and
  silently overwrites the others' file. Not handled — today's launcher only
  ever scaffolds one `ollama` seat per rig in practice, and this is called
  out plainly rather than papered over with a multi-seat-aware scheme.
- **Data location:** the actual chunk store (real conversation content, not
  authored config) lives under `<seat cwd>/.openrig/ollama/memory/` and is
  gitignored — see `.gitignore`'s re-ignore list below the `fence-config.json`
  carve-out comment.

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
