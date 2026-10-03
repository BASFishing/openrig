// The pane-hosted ollama-runner: a real, interactive conversational process
// (not a test double). The adapter types `node <thisEntry> …` into the seat's
// tmux pane; this process persists the readiness sidecar the daemon polls,
// then idles as the pane's live foreground process, reading stdin lines
// (how `rig send` delivers a message: tmux types text into the pane, which
// lands here exactly like a human typing) and driving an OpenAI-compatible
// chat loop against a local Ollama server.
//
// Tool-calling: Read/Grep/Glob/Bash proxy to a sandboxed `opencode serve`
// instance (run separately, wrapped in Anthropic's sandbox-runtime — see
// .ollama-pilot/srt-config.json) rather than reimplementing file/shell
// access here. Read/Grep/Glob hit opencode's direct, deterministic
// endpoints; Bash goes through opencode's own agent-mediated shell session
// (a second local model interprets the command, not a raw passthrough).
// Write/Edit are NOT proxied to opencode — its REST API has no write/edit
// endpoint (verified, not just unimplemented-by-us) — so they're implemented
// directly here, with their own path-containment check scoping every write
// to the seat's own cwd (same "never leave the sandbox" intent as srt, just
// enforced in-process since there's no opencode endpoint to inherit it from).
// dispatch_to_seat shells out to the `rig` CLI (`rig send <session> <message>`)
// for real seat-to-seat delegation — no reimplementation of OpenRig's own
// messaging.
//
// Deliberately NOT in scope here (kept as a clean follow-on, not bent into
// this file): multi-turn streaming, KV-cache-quant tuning (that's an Ollama
// server-side setting, not this runner's concern), and vector-store RAG
// memory. Compaction and persisted history remain as before.

import nodeFs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ollamaSeatSidecarPath,
  ollamaSeatHistoryPath,
  OLLAMA_RUNNER_READY_MARKER,
  OLLAMA_RUNNER_EXIT_MARKER,
  OLLAMA_RUNNER_ERROR_MARKER,
  type OllamaRunnerState,
} from "./ollama-runner-protocol.js";

export interface OllamaRunnerArgs {
  sessionName: string;
  cwd: string;
  launchId: string;
  posture: "floor" | "full_bypass";
  model: string;
  baseUrl: string;
  resumeToken?: string;
  /** Base URL of a sandboxed `opencode serve` instance for Read/Grep/Glob/Bash.
   *  Optional — absent means tools are disabled and the seat is chat-only
   *  (the original, pre-tool-calling behavior). Not threaded through the
   *  adapter's launch command yet — pilot-stage, override via
   *  OLLAMA_RUNNER_OPENCODE_URL in the pane's environment if needed. */
  opencodeUrl?: string;
}

/** Parse the runner argv (the flags buildOllamaRunnerCommand emits). Pure. */
export function parseOllamaRunnerArgs(argv: string[]): OllamaRunnerArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const sessionName = get("--session-name");
  const cwd = get("--cwd");
  const launchId = get("--launch-id");
  const model = get("--model");
  const baseUrl = get("--base-url");
  const postureRaw = get("--posture");
  if (!sessionName) throw new Error("ollama-runner: --session-name is required");
  if (!cwd) throw new Error("ollama-runner: --cwd is required");
  if (!launchId) throw new Error("ollama-runner: --launch-id is required");
  if (!model) throw new Error("ollama-runner: --model is required");
  if (!baseUrl) throw new Error("ollama-runner: --base-url is required");
  const posture = postureRaw === "full_bypass" ? "full_bypass" : "floor";
  return {
    sessionName, cwd, launchId, posture, model, baseUrl,
    resumeToken: get("--session"),
    opencodeUrl: get("--opencode-url") ?? process.env.OLLAMA_RUNNER_OPENCODE_URL,
  };
}

function writeSidecar(cwd: string, state: OllamaRunnerState): void {
  const sidecarPath = ollamaSeatSidecarPath(cwd);
  nodeFs.mkdirSync(nodePath.dirname(sidecarPath), { recursive: true });
  // Atomic replace: write a temp sibling then rename, so a poller never reads a
  // half-written sidecar (a torn read would misreport readiness).
  const tmp = `${sidecarPath}.${process.pid}.tmp`;
  nodeFs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
  nodeFs.renameSync(tmp, sidecarPath);
}

// ── Chat message shape (OpenAI-compatible, matches Ollama's /v1 endpoint) ──

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on an assistant message that chose to call one or more tools. */
  tool_calls?: ToolCall[];
  /** Present on a role:"tool" message — which call this is the result of. */
  tool_call_id?: string;
}

/** Load the seat's system prompt from AGENTS.md (written by deliverStartup's
 *  guidance_merge path — this IS the seat's per-agent context file). Absent
 *  file = a minimal default rather than a hard failure; a seat with no
 *  authored guidance yet should still come up. */
function loadSystemPrompt(cwd: string): string {
  const agentsPath = nodePath.join(cwd, "AGENTS.md");
  if (nodeFs.existsSync(agentsPath)) {
    return nodeFs.readFileSync(agentsPath, "utf-8");
  }
  return "You are a helpful agent participating in a multi-agent rig. No AGENTS.md guidance has been authored for this seat yet.";
}

/** Load persisted history if present, else start fresh with just the system
 *  message. Either way, the system message is REFRESHED to the current
 *  AGENTS.md content on every boot — so editing a seat's guidance takes
 *  effect on next restart without discarding the rest of its memory. */
export function loadHistory(cwd: string): ChatMessage[] {
  const historyPath = ollamaSeatHistoryPath(cwd);
  const systemContent = loadSystemPrompt(cwd);
  if (nodeFs.existsSync(historyPath)) {
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(historyPath, "utf-8")) as ChatMessage[];
      const first = parsed[0];
      if (Array.isArray(parsed) && first !== undefined && first.role === "system") {
        parsed[0] = { role: "system", content: systemContent };
        return parsed;
      }
    } catch {
      // Corrupt/unreadable history — fall through to a fresh start rather than
      // crash the seat over a damaged file.
    }
  }
  return [{ role: "system", content: systemContent }];
}

function saveHistory(cwd: string, history: ChatMessage[]): void {
  const historyPath = ollamaSeatHistoryPath(cwd);
  nodeFs.mkdirSync(nodePath.dirname(historyPath), { recursive: true });
  const tmp = `${historyPath}.${process.pid}.tmp`;
  nodeFs.writeFileSync(tmp, JSON.stringify(history, null, 2), "utf-8");
  nodeFs.renameSync(tmp, historyPath);
}

// ── Compaction ────────────────────────────────────────────────────────────
// Ollama's chat endpoint is stateless — the FULL history is resent every
// call, and it grows without bound until something trims it. There's no
// tokenizer dependency here on purpose (keep the runner dependency-free): a
// character-count proxy (~4 chars/token is the standard rule of thumb) is
// good enough to decide "getting close," which is all a compaction trigger
// needs to be.

/** Rough token-count proxy: total content length / 4, across all messages. */
function estimateTokens(history: ChatMessage[]): number {
  const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4);
}

/** Compact once history estimate crosses this many tokens. */
export const COMPACTION_TRIGGER_TOKENS = 6000;
/** Always keep this many of the most recent messages verbatim, uncompacted. */
export const COMPACTION_KEEP_RECENT = 6;

/**
 * If history is over budget, ask the model to summarize everything except the
 * system message and the most recent COMPACTION_KEEP_RECENT turns into one
 * compact brief, then splice history down to [system, summary, ...recent].
 * Returns the (possibly unchanged) history.
 */
export async function maybeCompact(
  history: ChatMessage[],
  chat: (messages: ChatMessage[]) => Promise<string>,
): Promise<ChatMessage[]> {
  if (estimateTokens(history) < COMPACTION_TRIGGER_TOKENS) return history;
  if (history.length <= 1 + COMPACTION_KEEP_RECENT) return history; // nothing old enough to compact

  const system = history[0];
  if (system === undefined) return history; // malformed history (no messages at all)
  const recent = history.slice(-COMPACTION_KEEP_RECENT);
  const middle = history.slice(1, history.length - COMPACTION_KEEP_RECENT);
  if (middle.length === 0) return history;

  const summaryPrompt: ChatMessage[] = [
    system,
    {
      role: "user",
      content:
        "Summarize the following conversation history into a compact brief that " +
        "preserves every decision, fact, and open question a continuation would " +
        "need. Be dense, not narrative — this replaces the raw turns below in " +
        "this seat's ongoing memory.\n\n" +
        middle.map((m) => `[${m.role}] ${m.content}`).join("\n\n"),
    },
  ];
  const summary = await chat(summaryPrompt);
  return [
    system,
    { role: "user", content: `[compacted summary of earlier conversation]\n${summary}` },
    ...recent,
  ];
}

// ── Ollama chat call ──────────────────────────────────────────────────────

/** Strip fields callOllamaChatRaw added (tool_calls/tool_call_id) before
 *  sending back out — Ollama's /v1 endpoint only wants the OpenAI-shaped
 *  subset, and compaction's plain `chat` never needs them regardless. */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) wire.tool_calls = m.tool_calls;
  if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
  return wire;
}

/** Low-level call returning the full assistant message (content + any
 *  tool_calls), not just text. `tools` omitted entirely when absent/empty —
 *  sending an empty tools array to some OpenAI-compatible servers changes
 *  behavior versus never mentioning tools at all. */
async function callOllamaChatRaw(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  tools?: ToolSchema[],
): Promise<ChatMessage> {
  const body: Record<string, unknown> = { model, messages: messages.map(toWireMessage) };
  if (tools && tools.length > 0) body.tools = tools;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`ollama chat request failed: ${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  };
  const message = parsed.choices?.[0]?.message;
  if (!message) throw new Error("ollama chat response had no choices[0].message");
  return { role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls };
}

/** Plain text-in/text-out call, no tools — used by compaction's internal
 *  summarization prompt, which must never itself trigger a tool call. */
export async function callOllamaChat(baseUrl: string, model: string, messages: ChatMessage[]): Promise<string> {
  const message = await callOllamaChatRaw(baseUrl, model, messages);
  return message.content;
}

// ── OpenCode tool client (Read/Grep/Glob/Bash via a sandboxed opencode serve) ──
// Deterministic for Read/Grep/Glob (direct opencode endpoints, no agent in
// the loop); Bash routes through opencode's OWN configured agent/model —
// see the file header note. Session creation is lazy + cached so repeated
// bash calls within one runner lifetime share context instead of each
// spawning a fresh opencode session.

let cachedOpencodeSessionId: string | undefined;

async function getOpencodeSessionId(opencodeUrl: string): Promise<string> {
  if (cachedOpencodeSessionId) return cachedOpencodeSessionId;
  const response = await fetch(`${opencodeUrl.replace(/\/$/, "")}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error(`opencode session create failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error("opencode session create returned no id");
  cachedOpencodeSessionId = body.id;
  return body.id;
}

async function opencodeReadFile(opencodeUrl: string, path: string): Promise<string> {
  const response = await fetch(`${opencodeUrl.replace(/\/$/, "")}/file/content?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(`opencode read failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { content?: string };
  return body.content ?? "";
}

async function opencodeGrep(opencodeUrl: string, pattern: string): Promise<string> {
  const response = await fetch(`${opencodeUrl.replace(/\/$/, "")}/find?pattern=${encodeURIComponent(pattern)}`);
  if (!response.ok) throw new Error(`opencode grep failed: ${response.status} ${await response.text()}`);
  return JSON.stringify(await response.json());
}

async function opencodeGlob(opencodeUrl: string, query: string): Promise<string> {
  const response = await fetch(`${opencodeUrl.replace(/\/$/, "")}/find/file?query=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`opencode glob failed: ${response.status} ${await response.text()}`);
  return JSON.stringify(await response.json());
}

async function opencodeBash(opencodeUrl: string, command: string): Promise<string> {
  const sessionId = await getOpencodeSessionId(opencodeUrl);
  const response = await fetch(`${opencodeUrl.replace(/\/$/, "")}/session/${sessionId}/shell`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "general", command }),
  });
  if (!response.ok) throw new Error(`opencode bash failed: ${response.status} ${await response.text()}`);
  return JSON.stringify(await response.json());
}

// ── Write/Edit (local, path-containment checked — opencode has no write API) ──

/** Resolve `path` against `cwd` and refuse if the result would land outside
 *  `cwd` — the same "never leave the sandbox" intent as srt's allow-only
 *  writes, enforced here in-process since opencode has no write endpoint to
 *  inherit that restriction from. Throws, never silently clamps. */
function resolveInsideCwd(cwd: string, path: string): string {
  const resolvedCwd = nodePath.resolve(cwd);
  const resolvedTarget = nodePath.resolve(cwd, path);
  if (resolvedTarget !== resolvedCwd && !resolvedTarget.startsWith(resolvedCwd + nodePath.sep)) {
    throw new Error(`refusing to write outside the seat's working directory: "${path}" resolves to ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function writeFileScoped(cwd: string, path: string, content: string): string {
  const target = resolveInsideCwd(cwd, path);
  nodeFs.mkdirSync(nodePath.dirname(target), { recursive: true });
  nodeFs.writeFileSync(target, content, "utf-8");
  return `wrote ${content.length} bytes to ${path}`;
}

/** Exact-match replace, mirroring Claude Code's Edit tool: old_str must
 *  occur exactly once, or this refuses rather than guess which occurrence
 *  was meant. */
function editFileScoped(cwd: string, path: string, oldStr: string, newStr: string): string {
  const target = resolveInsideCwd(cwd, path);
  const content = nodeFs.readFileSync(target, "utf-8");
  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) throw new Error(`old_str not found in ${path}`);
  if (occurrences > 1) throw new Error(`old_str occurs ${occurrences} times in ${path} — must be unique; add more context`);
  nodeFs.writeFileSync(target, content.replace(oldStr, newStr), "utf-8");
  return `edited ${path}`;
}

// ── Dispatch (seat-to-seat delegation via the real `rig` CLI) ──────────────

const execFileAsync = promisify(execFile);

async function dispatchToSeat(session: string, message: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("rig", ["send", session, message]);
  return stdout.trim() || stderr.trim() || `sent to ${session}`;
}

// ── Tool schemas (OpenAI tool-calling format) + dispatch ───────────────────

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const OLLAMA_RUNNER_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file's contents by path, relative to the seat's working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path to read." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents for a text pattern.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Text/regex pattern to search for." } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by name (fuzzy match).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Filename query." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command. Executes inside a sandboxed environment with restricted filesystem/network " +
        "access, mediated by a separate coding-focused agent — expect some latency.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Shell command to run." } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file, scoped to the seat's own working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          content: { type: "string", description: "Full content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact string in a file with another. old_str must occur exactly once in the file " +
        "or this refuses — include enough surrounding context to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the working directory." },
          old_str: { type: "string", description: "Exact text to replace — must be unique in the file." },
          new_str: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_to_seat",
      description:
        "Send a message to another seat in this rig (e.g. a Claude seat) via `rig send` — real " +
        "delegation, not a simulated reply. The recipient answers on its own schedule; this call " +
        "returns once the message is delivered, not once it's answered.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Target seat address, e.g. dev-impl@my-rig." },
          message: { type: "string", description: "Self-contained message — the recipient has no other context." },
        },
        required: ["session", "message"],
      },
    },
  },
];

/** Execute one tool call against the sandboxed opencode server (or, for
 *  write/edit/dispatch, locally). Never throws out of the loop — a tool
 *  failure becomes the tool_result content (prefixed, so the model sees it
 *  failed) rather than crashing the turn. */
async function executeTool(opencodeUrl: string, cwd: string, call: ToolCall): Promise<string> {
  try {
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    switch (call.function.name) {
      case "read_file":
        return await opencodeReadFile(opencodeUrl, String(args.path ?? ""));
      case "grep":
        return await opencodeGrep(opencodeUrl, String(args.pattern ?? ""));
      case "glob":
        return await opencodeGlob(opencodeUrl, String(args.query ?? ""));
      case "bash":
        return await opencodeBash(opencodeUrl, String(args.command ?? ""));
      case "write_file":
        return writeFileScoped(cwd, String(args.path ?? ""), String(args.content ?? ""));
      case "edit_file":
        return editFileScoped(cwd, String(args.path ?? ""), String(args.old_str ?? ""), String(args.new_str ?? ""));
      case "dispatch_to_seat":
        return await dispatchToSeat(String(args.session ?? ""), String(args.message ?? ""));
      default:
        return `error: unknown tool "${call.function.name}"`;
    }
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

/** Max assistant/tool round-trips in one turn before giving up — a model
 *  that keeps calling tools without ever producing a final answer should
 *  not hang the seat forever. */
export const MAX_TOOL_ITERATIONS = 6;

/**
 * The tool-aware reply function for a single user turn: calls the model,
 * and if it chooses to call tools, executes them against the sandboxed
 * opencode server and loops — pushing every assistant/tool message onto
 * historyRef.current itself (so the full tool-use trace is persisted, not
 * just the final answer) — until a plain-text reply comes back or the
 * iteration cap is hit.
 */
export function makeRespond(
  baseUrl: string,
  model: string,
  opencodeUrl: string | undefined,
  cwd: string,
): (historyRef: { current: ChatMessage[] }) => Promise<string> {
  const tools = opencodeUrl ? OLLAMA_RUNNER_TOOLS : undefined;
  return async (historyRef) => {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const message = await callOllamaChatRaw(baseUrl, model, historyRef.current, tools);
      historyRef.current.push(message);
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message.content;
      }
      for (const call of message.tool_calls) {
        const result = opencodeUrl
          ? await executeTool(opencodeUrl, cwd, call)
          : `error: tools are disabled for this seat (no opencode server configured)`;
        historyRef.current.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return "[tool loop exceeded max iterations without a final reply]";
  };
}

// ── Turn queue ────────────────────────────────────────────────────────────
// Extracted from runOllamaRunner so the concurrency-correctness logic is
// independently unit-testable with a fake `chat` (artificial delay, no real
// network) rather than only provable by watching a live pane.

export interface TurnQueueDeps {
  /** Mutable holder so the queue can read/replace history across turns
   *  without the caller needing to manage reassignment itself. */
  historyRef: { current: ChatMessage[] };
  /** Plain text-in/text-out call, no tools — used ONLY by maybeCompact's
   *  internal summarization prompt. */
  chat: (messages: ChatMessage[]) => Promise<string>;
  /** Tool-aware reply for the actual turn — pushes any assistant/tool
   *  messages onto historyRef.current itself and returns the final text.
   *  See makeRespond. */
  respond: (historyRef: { current: ChatMessage[] }) => Promise<string>;
  onReply: (reply: string) => void;
  onError: (err: Error) => void;
  /** Called with the full history after each turn completes (for persistence). */
  onHistoryChange: (history: ChatMessage[]) => void;
}

/**
 * Returns a `handleUserMessage` function that chains every turn (push user
 * turn -> maybe-compact -> call model -> push reply -> persist) onto a single
 * promise, so turns run STRICTLY one at a time in arrival order. Without
 * this, a message arriving while a prior model call is still in flight (a
 * single call can run 20-60+ seconds) races on the shared history array —
 * both read/mutate/push it concurrently, so a reply can land after a LATER
 * user turn that wasn't even part of its own request.
 */
export function createTurnQueue(deps: TurnQueueDeps): (text: string) => void {
  let turnQueue: Promise<void> = Promise.resolve();
  return (text: string) => {
    turnQueue = turnQueue.then(async () => {
      deps.historyRef.current.push({ role: "user", content: text });
      try {
        deps.historyRef.current = await maybeCompact(deps.historyRef.current, deps.chat);
        const reply = await deps.respond(deps.historyRef);
        deps.onHistoryChange(deps.historyRef.current);
        deps.onReply(reply);
      } catch (err) {
        deps.onError(err as Error);
      }
    });
  };
}

export async function runOllamaRunner(args: OllamaRunnerArgs): Promise<void> {
  try {
    writeSidecar(args.cwd, { ready: true, launchId: args.launchId, updatedAt: new Date().toISOString() });
    // eslint-disable-next-line no-console
    console.log(`${OLLAMA_RUNNER_READY_MARKER} session=${args.sessionName} model=${args.model} posture=${args.posture}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`${OLLAMA_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let history = loadHistory(args.cwd);
  saveHistory(args.cwd, history);

  const chat = (messages: ChatMessage[]) => callOllamaChat(args.baseUrl, args.model, messages);
  const respond = makeRespond(args.baseUrl, args.model, args.opencodeUrl, args.cwd);
  if (args.opencodeUrl) {
    // eslint-disable-next-line no-console
    console.log(`[ollama-runner] tools enabled via opencode at ${args.opencodeUrl}`);
  }

  const recordExit = (code: number | null) => {
    try {
      writeSidecar(args.cwd, {
        ready: false,
        launchId: args.launchId,
        exited: { code, at: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      });
    } catch {
      /* best-effort on the way out */
    }
    // eslint-disable-next-line no-console
    console.log(OLLAMA_RUNNER_EXIT_MARKER);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => { recordExit(0); process.exit(0); });
  }

  // The pane's live foreground process: this is where `rig send`'s delivery
  // arrives — NOT one line at a time. `rig send` types a multi-line envelope
  // (From:/To:/Sent: headers, the message body, a trailing reply hint) as one
  // paste ending in a single Enter, and a raw stdin reader cannot otherwise
  // distinguish "one multi-line paste" from "several distinct messages" — both
  // arrive as a stream of line-ending bytes. So lines are buffered and only
  // flushed as ONE user turn after a short idle gap: an automated multi-line
  // delivery lands within milliseconds (well under the debounce), while a
  // human attached to the pane typing separate messages paces slower than it.
  const FLUSH_DEBOUNCE_MS = 400;
  let lineBuffer: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;

  const historyRef = { current: history };
  const handleUserMessage = createTurnQueue({
    historyRef,
    chat,
    respond,
    onReply: (reply) => {
      // eslint-disable-next-line no-console
      console.log(reply);
    },
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error(`${OLLAMA_RUNNER_ERROR_MARKER} ${err.message}`);
    },
    onHistoryChange: (h) => saveHistory(args.cwd, h),
  });

  // An active readline listener on stdin keeps the event loop ref'd on its
  // own — no synthetic keep-alive needed here.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    lineBuffer.push(line);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const text = lineBuffer.join("\n").trim();
      lineBuffer = [];
      if (text) handleUserMessage(text);
    }, FLUSH_DEBOUNCE_MS);
  });
  rl.on("close", () => recordExit(0));
}

// ── Self-invocation guard (mirrors every other pane-hosted runner) ─────────
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runOllamaRunner(parseOllamaRunnerArgs(process.argv.slice(2))).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${OLLAMA_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exit(1);
  });
}
