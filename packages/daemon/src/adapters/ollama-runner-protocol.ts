// The shared, PURE contract between the Ollama runtime adapter and the
// pane-hosted ollama-runner process. Mirrors stub-runner-protocol.ts's shape
// (a Pi-shaped node-script runner with a self-invocation guard) but for a
// REAL backend: an OpenAI-compatible local model server, not a test double.
//
// Contract summary:
// - The adapter launches `node <runnerEntry> …` inside the seat's tmux pane.
// - The runner writes the readiness sidecar `<cwd>/.openrig/ollama/state.json`
//   and prints the READY marker; the daemon reads ONLY this runner-authored
//   surface for the readiness decision, never pane heuristics.
// - The runner is the seat's live foreground process: it reads lines from
//   stdin (how `rig send` delivers a message — tmux types text into the
//   pane, which lands as stdin here, exactly like a human typing), calls the
//   Ollama chat API with the seat's accumulated history, and prints the
//   reply to stdout.

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

// ── Readiness sidecar layout ────────────────────────────────────────────────

export const OLLAMA_READINESS_SIDECAR_SUBPATH = nodePath.join(".openrig", "ollama", "state.json");

/** Absolute path to the readiness sidecar for a seat whose managed cwd is `cwd`. */
export function ollamaSeatSidecarPath(cwd: string): string {
  return nodePath.join(cwd, OLLAMA_READINESS_SIDECAR_SUBPATH);
}

/** Absolute path to the persisted conversation history for a seat whose managed
 *  cwd is `cwd`. Survives runner restarts — a crash/relaunch resumes, it doesn't
 *  wipe the seat's memory. */
export function ollamaSeatHistoryPath(cwd: string): string {
  return nodePath.join(cwd, ".openrig", "ollama", "history.json");
}

// ── Pane markers (runner-authored; the adapter greps for THESE, never harness UI) ─

export const OLLAMA_RUNNER_READY_MARKER = "[ollama-runner] READY";
export const OLLAMA_RUNNER_EXIT_MARKER = "[ollama-runner] EXITED";
export const OLLAMA_RUNNER_ERROR_MARKER = "[ollama-runner] ERROR";

// ── Readiness sidecar shape ─────────────────────────────────────────────────

export interface OllamaRunnerState {
  /** True once the runner has come up; the daemon's positive readiness signal. */
  ready: boolean;
  /** Launch-attempt scope: the adapter mints a launchId per attempt and passes
   *  --launch-id; the runner stamps it into every sidecar write so a durable
   *  artifact from a prior runner instance can never false-green a new launch. */
  launchId?: string;
  /** Set when the runner process exited; the seat is honestly non-running. */
  exited?: { code: number | null; at?: string };
  /** ISO timestamp of the last sidecar write (optional metadata). */
  updatedAt?: string;
}

/** Parse a readiness sidecar. Requires only `ready: boolean`. */
export function parseOllamaRunnerState(raw: string): OllamaRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean") return null;
    return parsed as unknown as OllamaRunnerState;
  } catch {
    return null;
  }
}

// ── Command construction ─────────────────────────────────────────────────────

export interface OllamaRunnerLaunchOpts {
  /** Absolute path to the compiled runner entry (daemon dist). */
  runnerEntryPath: string;
  /** The seat's canonical session name (identity). */
  sessionName: string;
  /** Managed working directory (the readiness sidecar + history root, and where
   *  deliverStartup wrote AGENTS.md — the seat's system prompt source). */
  cwd: string;
  /** Launch-attempt scope stamped into the runner's sidecar writes. */
  launchId: string;
  /** The seat's RESOLVED launch posture (byte-observable in the command on
   *  both fresh and resume paths, mirroring every other adapter). Currently
   *  informational for this runtime — Ollama has no bypass-permission concept
   *  — carried through for consistency with the shared launch-posture surface. */
  posture: "floor" | "full_bypass";
  /** Ollama model tag to serve this seat (from NodeBinding.model; falls back
   *  to a default in the adapter if absent). */
  model: string;
  /** Ollama's OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1. */
  baseUrl: string;
  /** Base URL of a sandboxed `opencode serve` instance for Read/Grep/Glob/Bash
   *  tool calls. Absent = tools disabled, seat stays chat-only. */
  opencodeUrl?: string;
  /** Exact resume marker for the restore path (carried through, not yet acted
   *  on beyond loading the persisted history file at that same cwd). */
  resumeToken?: string;
}

/** The command typed into the seat's tmux pane. The runner owns everything past
 *  this boundary (sidecar write, chat loop, history persistence). */
export function buildOllamaRunnerCommand(opts: OllamaRunnerLaunchOpts): string {
  const parts = [
    "node",
    shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    "--posture", shellQuote(opts.posture),
    "--model", shellQuote(opts.model),
    "--base-url", shellQuote(opts.baseUrl),
  ];
  if (opts.opencodeUrl) {
    parts.push("--opencode-url", shellQuote(opts.opencodeUrl));
  }
  if (opts.resumeToken) {
    parts.push("--session", shellQuote(opts.resumeToken));
  }
  return parts.join(" ");
}
