// Pure contract for launching `opencode` itself as the ollama seat's
// pane-native process — NOT a wrapper runner. opencode's own TUI already
// hosts the full agentic loop (tool-calling, read/write/edit/bash, context
// compaction) against whatever model its config points at, including a
// local Ollama model via the openai-compatible provider shape. OpenRig's job
// here shrinks to: launch it, point it at Ollama, optionally sandbox it, and
// capture its session id as the resume token — exactly the role
// ClaudeCodeAdapter/CodexRuntimeAdapter play for THEIR native binaries.
//
// Consequence: there is no OpenRig-owned sidecar here (unlike Pi/OMP, which
// need one because the pi-runner is OpenRig's own process). Liveness reads
// the pane the same way Claude/Codex do — "the foreground process isn't a
// bare shell" — not a runner-authored file.

import { shellQuote } from "./shell-quote.js";

/** The provider id this adapter registers in the seat's opencode.json —
 *  fixed, not user-configurable, since it's purely an internal wiring label
 *  (never shown to a human; the display name in the config is). */
export const OPENCODE_OLLAMA_PROVIDER_ID = "ollama";

export interface OpencodeConfig {
  readonly $schema: string;
  provider: Record<string, {
    npm: string;
    name: string;
    options: { baseURL: string };
    models: Record<string, { name: string }>;
  }>;
  [key: string]: unknown;
}

/** Build (or merge into) the seat's opencode.json so opencode's own provider
 *  resolution finds the local Ollama server under OPENCODE_OLLAMA_PROVIDER_ID.
 *  `existing` is the project's current opencode.json content, if any parses —
 *  every other key (and every other provider) passes through untouched, so a
 *  human-authored config isn't clobbered by this adapter's one concern. */
export function mergeOpencodeConfig(existing: Record<string, unknown> | null, baseUrl: string, model: string): OpencodeConfig {
  const base = (existing ?? {}) as Partial<OpencodeConfig>;
  const providers = { ...(base.provider ?? {}) };
  providers[OPENCODE_OLLAMA_PROVIDER_ID] = {
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama (local)",
    options: { baseURL: baseUrl },
    models: { [model]: { name: model } },
  };
  return { ...base, $schema: "https://opencode.ai/config.json", provider: providers };
}

export interface OpencodeLaunchOpts {
  /** Ollama model tag (NodeBinding.model, or the adapter's default). */
  model: string;
  /** Local TCP port opencode's own session API listens on — ephemeral, chosen
   *  fresh per launch; only needed for this launch's resume-token capture. */
  port: number;
  /** A prior opencode session id to resume. Absent = fresh session (opencode
   *  mints its own id lazily, on first message — there is no client-supplied-id
   *  equivalent to Claude's --session-id). */
  resumeToken?: string;
  /** Absolute path to an srt settings JSON file. Absent = launch unsandboxed
   *  (dev/test only — every real seat should have one). */
  srtSettingsPath?: string;
}

/** The command typed into the seat's tmux pane. opencode owns everything past
 *  this boundary — there is no runner process in between. */
export function buildOpencodeLaunchCommand(opts: OpencodeLaunchOpts): string {
  const args = ["opencode", "--port", String(opts.port), "-m", shellQuote(`${OPENCODE_OLLAMA_PROVIDER_ID}/${opts.model}`)];
  if (opts.resumeToken) args.push("-s", shellQuote(opts.resumeToken));
  const inner = args.join(" ");
  return opts.srtSettingsPath ? `srt --settings ${shellQuote(opts.srtSettingsPath)} -- ${inner}` : inner;
}

/** Per-seat-cwd convention for the srt sandbox settings this seat's opencode
 *  process should launch under — mirrors the existing `.openrig/ollama/`
 *  convention (skills target dir, etc.), so no new per-seat binding field is
 *  needed (and no daemon-wide single path, since different seats can have
 *  different cwds). Absent file = unsandboxed launch. */
export function ollamaSrtSettingsPath(cwd: string): string {
  return `${cwd}/.openrig/ollama/srt-config.json`;
}

/** One entry from opencode's `GET /session` response — only the fields this
 *  adapter actually reads. */
export interface OpencodeSessionSummary {
  id: string;
  directory?: string;
  time?: { created?: number };
}

/** Pick this seat's own newest session from a (possibly multi-project) list —
 *  opencode's session store is global across every project on the machine
 *  (confirmed live: `/session` on one seat's port can list sessions from an
 *  unrelated project), so callers MUST filter by directory, never just take
 *  the list's first/last entry. */
export function newestSessionForCwd(sessions: OpencodeSessionSummary[], cwd: string): string | undefined {
  const matches = sessions.filter((s) => s.directory === cwd);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
  return matches[0]?.id;
}
