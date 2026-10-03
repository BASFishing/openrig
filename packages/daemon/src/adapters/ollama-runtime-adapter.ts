// The Ollama runtime adapter: a real, HTTP-backed local model as a first-class
// OpenRig seat. Structurally mirrors stub-runtime-adapter.ts (a node-script
// runner hosted in the seat's normal tmux pane, readiness read from a
// runner-authored sidecar — never pane heuristics) but the pane process is a
// genuine conversational loop against a local Ollama server, not a test double.
//
// Generic file-projection logic (project/deliverStartup's guidance_merge /
// skill_install / send_text handling) is intentionally identical to the stub
// adapter's — it's runtime-agnostic already; nothing about serving a local
// model instead of a terminal-native CLI changes how startup files land on
// disk.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { yoloEnabled, type ResolvedLaunchPosture } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  ollamaSeatSidecarPath, buildOllamaRunnerCommand, parseOllamaRunnerState,
  type OllamaRunnerState,
} from "./ollama-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/** Default Ollama model when a seat's NodeBinding.model is unset. Overridable
 *  per-seat via the SAME `model` field every other adapter already reads. */
const DEFAULT_MODEL = "qwen3:8b";

export interface OllamaAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface OllamaRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  /** Real filesystem operations. Absent in minimal/hermetic test constructions —
   *  the adapter then falls back to an in-memory launch record for readiness and
   *  performs NO real filesystem writes. */
  fsOps?: OllamaAdapterFsOps;
  /** Runtime label. Defaults to "ollama"; accepted as a dep so a test can name it. */
  runtime?: string;
  /** Absolute path to the compiled ollama-runner entry in the daemon dist. When
   *  present, launchHarness spawns the real runner (with a MANDATORY existence
   *  fail-fast, mirroring the stub adapter); when absent, launchHarness takes
   *  the hermetic in-memory path. */
  runnerEntryPath?: string;
  /** Ollama's OpenAI-compatible base URL. Defaults to the local default port —
   *  overridable for a remote/non-default Ollama host. */
  baseUrl?: string;
  /** Base URL of a sandboxed `opencode serve` instance for Read/Grep/Glob/Bash
   *  tool calls. Absent = tools disabled, every seat on this adapter stays
   *  chat-only. Deliberately opt-in at the adapter level rather than always-on —
   *  tools only work where that server is actually running and sandboxed. */
  opencodeUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

/** In-memory launch record: the readiness fallback for the hermetic path (no
 *  fsOps, no runner). Keyed by tmux session. */
interface OllamaLaunchRecord {
  ready: boolean;
  launchId: string;
  exited?: { code: number | null };
}

export class OllamaRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: string;
  private tmux: TmuxAdapter;
  private fsOps?: OllamaAdapterFsOps;
  private runnerEntryPath?: string;
  private baseUrl: string;
  private opencodeUrl?: string;
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;
  private readonly launchRecords = new Map<string, OllamaLaunchRecord>();

  constructor(deps: OllamaRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fsOps = deps.fsOps;
    this.runtime = deps.runtime ?? "ollama";
    this.runnerEntryPath = deps.runnerEntryPath;
    this.baseUrl = deps.baseUrl ?? "http://127.0.0.1:11434/v1";
    this.opencodeUrl = deps.opencodeUrl;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/v1\/?$/, "")}/api/tags`);
      if (!response.ok) return [];
      const body = (await response.json()) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => ({ effectiveId: m.name, category: "model", installedPath: m.name }));
    } catch {
      // Ollama not reachable — an honest empty list, same posture as the stub
      // adapter's "nothing durable to enumerate" default.
      return [];
    }
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        if (!this.fsOps) throw new Error("no fsOps configured — cannot read startup file content");
        const content = this.fsOps.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            // This is the seat's per-agent context file (AGENTS.md) that
            // ollama-runner.ts loads as its system prompt on every boot.
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            if (!this.mergeGuidance(targetPath, file.path, content)) continue; // rig-role skip
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".openrig", "ollama", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fsOps.mkdirp(targetDir);
            this.fsOps.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the ollama harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.forkSource) {
      // Ollama's chat endpoint has no native session/fork primitive; refuse
      // clearly rather than guess (same contract rule every adapter follows).
      return { ok: false, error: "ollama runtime has no native fork primitive; remove session_source for ollama members" };
    }

    const sessionName = binding.tmuxSession;
    const launchId = this.newLaunchId();
    const model = binding.model ?? DEFAULT_MODEL;

    if (this.runnerEntryPath) {
      // PRODUCTION path: spawn the real pane-hosted runner.
      if (!this.fsOps || !this.fsOps.exists(this.runnerEntryPath)) {
        return { ok: false, error: `ollama-runner entry not found at ${this.runnerEntryPath} — the daemon package is incomplete` };
      }
      const posture: ResolvedLaunchPosture = yoloEnabled(process.env, binding.launchPosture) ? "full_bypass" : "floor";
      const cmd = buildOllamaRunnerCommand({
        runnerEntryPath: this.runnerEntryPath,
        sessionName,
        cwd: binding.cwd,
        launchId,
        posture,
        model,
        baseUrl: this.baseUrl,
        opencodeUrl: this.opencodeUrl,
        resumeToken: opts.resumeToken,
      });
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) return { ok: false, error: `Failed to send ollama launch command: ${textResult.message}` };
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };

      const ready = await this.waitForRunnerReady(binding, launchId);
      if (!ready.ok) return ready.failure;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: opts.resumeToken ? "ollama_session" : undefined };
    }

    // HERMETIC path (no runner configured): record the launch as the readiness
    // source and return. No real filesystem write.
    this.launchRecords.set(sessionName, { ready: true, launchId });
    return { ok: true, resumeToken: opts.resumeToken, resumeType: opts.resumeToken ? "ollama_session" : undefined };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const sessionName = binding.tmuxSession;
    if (!sessionName) return { ready: false, reason: "No tmux session bound" };

    const state: OllamaRunnerState | OllamaLaunchRecord | null = this.fsOps
      ? this.readReadinessSidecar(binding.cwd)
      : this.launchRecords.get(sessionName) ?? null;

    if (!state) return { ready: false, reason: "ollama seat has not reported readiness", code: "awaiting_runtime" };
    if (state.exited) {
      return { ready: false, reason: `ollama-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (!state.ready) return { ready: false, reason: "ollama-runner has not reported ready yet", code: "awaiting_runtime" };

    // Liveness cross-checks — ONLY where the tmux surface supports them, same
    // guard as the stub adapter: a ready sidecar does NOT prove current
    // liveness on its own (a dead runner leaves the pane at a shell, and a
    // stale sidecar can outlive it).
    if (this.fsOps) {
      if (typeof this.tmux?.hasSession === "function") {
        if (!(await this.tmux.hasSession(sessionName))) {
          return { ready: false, reason: "tmux session not responsive" };
        }
      }
      if (typeof this.tmux?.getPaneCommand === "function") {
        const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
        if (SHELL_COMMANDS.has(paneCommand)) {
          return { ready: false, reason: "ollama readiness is stale; the pane is back at a shell", code: "runner_exited" };
        }
      }
    }

    return { ready: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readReadinessSidecar(cwd: string): OllamaRunnerState | null {
    if (!this.fsOps) return null;
    const sidecarPath = ollamaSeatSidecarPath(cwd);
    if (!this.fsOps.exists(sidecarPath)) return null;
    try {
      return parseOllamaRunnerState(this.fsOps.readFile(sidecarPath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    binding: NodeBinding,
    launchId: string,
  ): Promise<{ ok: true } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 60; // ~15s: runner boot + first sidecar write
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readReadinessSidecar(binding.cwd);
      // Launch-attempt scoping: only THIS attempt's sidecar counts, so a
      // durable artifact from a prior runner instance cannot false-green or
      // false-fail this launch.
      if (state && state.launchId === launchId) {
        if (state.exited) {
          return {
            ok: false,
            failure: { ok: false, error: `ollama launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`, recovery: "attention_required" },
          };
        }
        if (state.ready) return { ok: true };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: { ok: false, error: "ollama launch: timed out waiting for the runner to report ready", recovery: "attention_required" },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (!this.fsOps) return false;
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      return this.mergeGuidance(targetPath, entry.effectiveId, this.fsOps.readFile(entry.absolutePath));
    }
    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".openrig", "ollama", "skills", entry.effectiveId);
      this.fsOps.mkdirp(targetDir);
      const isDir = this.fsOps.listFiles ? this.fsOps.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fsOps.listFiles) {
        for (const file of this.fsOps.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fsOps.mkdirp(nodePath.dirname(dest));
          this.fsOps.writeFile(dest, this.fsOps.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fsOps.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fsOps.readFile(entry.absolutePath));
      }
      return true;
    }
    // Plugins / subagents / runtime resources have no ollama projection target at MVP.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    if (!this.fsOps) return false;
    if (blockId === "rig-role") return false;
    mergeManagedBlock(this.fsOps, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
