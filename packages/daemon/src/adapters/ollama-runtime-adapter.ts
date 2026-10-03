// The Ollama runtime adapter: a real, HTTP-backed local model as a first-class
// OpenRig seat, launched by handing `opencode` itself the Ollama provider —
// NOT a hand-rolled tool-calling loop. opencode's own TUI already provides
// the agentic loop (tool-calling, read/write/edit/bash, compaction) and
// reads a project's AGENTS.md natively, so this adapter's job is the same as
// ClaudeCodeAdapter's/CodexRuntimeAdapter's for THEIR native binaries: launch
// it directly in the seat's pane, point it at the right model/provider,
// optionally sandbox it, and read its own liveness — not re-implement what
// opencode already does.
//
// Generic file-projection logic (project/deliverStartup's guidance_merge /
// skill_install / send_text handling) is unchanged from the stub adapter's
// shape — it's runtime-agnostic; nothing about the pane process being
// opencode instead of a test double changes how startup files land on disk.

import nodePath from "node:path";
import { createServer } from "node:net";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  buildOpencodeLaunchCommand, mergeOpencodeConfig, ollamaSrtSettingsPath,
  newestSessionForCwd, type OpencodeSessionSummary,
} from "./ollama-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/** Default Ollama model when a seat's NodeBinding.model is unset. Overridable
 *  per-seat via the SAME `model` field every other adapter already reads. */
const DEFAULT_MODEL = "qwen3:8b";

/** Bounded best-effort window to notice a NEW session appear after a fresh
 *  launch (e.g. a near-immediate dispatch_to_seat message). opencode mints
 *  session ids lazily on first message — unlike Claude's --session-id, there
 *  is no way to pre-mint one — so a truly idle fresh seat legitimately has no
 *  resumeToken yet; that's an honest "none captured", not a failure. */
const RESUME_POLL_ATTEMPTS = 8;
const RESUME_POLL_DELAY_MS = 500;

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
   *  the adapter then skips opencode.json management and performs NO real
   *  filesystem writes, but still launches/checks readiness via tmux. */
  fsOps?: OllamaAdapterFsOps;
  /** Runtime label. Defaults to "ollama"; accepted as a dep so a test can name it. */
  runtime?: string;
  /** Ollama's OpenAI-compatible base URL. Defaults to the local default port —
   *  overridable for a remote/non-default Ollama host. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Port allocator (tests inject a deterministic one; defaults to asking the
   *  OS for a free port). */
  allocatePort?: () => Promise<number>;
  /** HTTP fetch (tests inject a mock; defaults to the global fetch). */
  fetchImpl?: typeof fetch;
}

export class OllamaRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: string;
  private tmux: TmuxAdapter;
  private fsOps?: OllamaAdapterFsOps;
  private baseUrl: string;
  private sleep: (ms: number) => Promise<void>;
  private allocatePort: () => Promise<number>;
  private fetchImpl: typeof fetch;

  constructor(deps: OllamaRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fsOps = deps.fsOps;
    this.runtime = deps.runtime ?? "ollama";
    this.baseUrl = deps.baseUrl ?? "http://127.0.0.1:11434/v1";
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.allocatePort = deps.allocatePort ?? defaultAllocatePort;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/v1\/?$/, "")}/api/tags`);
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
            // opencode reads AGENTS.md from the project cwd natively (its own
            // startup, not anything this adapter drives) — this is still the
            // right merge target, just no longer a hand-rolled system prompt.
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
      return { ok: false, error: "No tmux session bound — cannot launch opencode for this seat" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.forkSource) {
      // opencode CAN fork a session (--fork), but only relative to --continue/
      // --session, i.e. this seat's OWN prior session — not an arbitrary
      // cross-seat fork source. Refuse clearly rather than guess.
      return { ok: false, error: "ollama runtime has no cross-seat fork primitive; remove session_source for ollama members" };
    }

    const sessionName = binding.tmuxSession;
    const model = binding.model ?? DEFAULT_MODEL;

    this.ensureOpencodeConfig(binding.cwd, model);
    const srtSettingsPath = this.fsOps?.exists(ollamaSrtSettingsPath(binding.cwd)) ? ollamaSrtSettingsPath(binding.cwd) : undefined;
    const port = await this.allocatePort();

    const cmd = buildOpencodeLaunchCommand({ model, port, resumeToken: opts.resumeToken, srtSettingsPath });
    const textResult = await this.tmux.sendText(sessionName, cmd);
    if (!textResult.ok) return { ok: false, error: `Failed to send opencode launch command: ${textResult.message}` };
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };

    const alive = await this.waitForPaneAlive(sessionName);
    if (!alive.ok) return alive.failure;

    if (opts.resumeToken) {
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "opencode_session" };
    }
    // Fresh launch: best-effort capture of a just-created session for THIS
    // cwd. A genuinely idle seat has none yet — that's an honest "no token
    // captured now", not a launch failure (same posture as every other
    // adapter's "core launch path only" caveats).
    const captured = await this.pollForNewSession(port, binding.cwd);
    return { ok: true, resumeToken: captured, resumeType: captured ? "opencode_session" : undefined };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const sessionName = binding.tmuxSession;
    if (!sessionName) return { ready: false, reason: "No tmux session bound" };

    if (typeof this.tmux?.hasSession === "function") {
      if (!(await this.tmux.hasSession(sessionName))) {
        return { ready: false, reason: "tmux session not responsive" };
      }
    }
    if (typeof this.tmux?.getPaneCommand === "function") {
      const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
      if (SHELL_COMMANDS.has(paneCommand)) {
        return { ready: false, reason: "opencode is not running — the pane is back at a shell", code: "runner_exited" };
      }
      if (paneCommand === "") {
        return { ready: false, reason: "opencode has not started yet", code: "awaiting_runtime" };
      }
    }

    return { ready: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** opencode.json management is skipped entirely in hermetic test
   *  constructions (no fsOps) — tests exercise command/readiness shape, not
   *  real filesystem writes. */
  private ensureOpencodeConfig(cwd: string, model: string): void {
    if (!this.fsOps) return;
    const configPath = nodePath.join(cwd, "opencode.json");
    let existing: Record<string, unknown> | null = null;
    if (this.fsOps.exists(configPath)) {
      try {
        existing = JSON.parse(this.fsOps.readFile(configPath)) as Record<string, unknown>;
      } catch {
        existing = null; // Unparseable — treat as absent rather than fail the launch over it.
      }
    }
    const merged = mergeOpencodeConfig(existing, this.baseUrl, model);
    this.fsOps.writeFile(configPath, JSON.stringify(merged, null, 2));
  }

  private async waitForPaneAlive(sessionName: string): Promise<{ ok: true } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 20; // ~5s: binary start + first render
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (typeof this.tmux?.getPaneCommand === "function") {
        const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
        if (paneCommand && !SHELL_COMMANDS.has(paneCommand)) return { ok: true };
      } else {
        // No pane-introspection available (minimal tmux dep in a test) — trust the send.
        return { ok: true };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: { ok: false, error: "opencode launch: timed out waiting for the pane to start opencode", recovery: "attention_required" },
    };
  }

  private async pollForNewSession(port: number, cwd: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < RESUME_POLL_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${port}/session`);
        if (response.ok) {
          const sessions = (await response.json()) as OpencodeSessionSummary[];
          const found = newestSessionForCwd(sessions, cwd);
          if (found) return found;
        }
      } catch {
        // Server not up yet (or already gone) — keep polling within budget.
      }
      if (attempt < RESUME_POLL_ATTEMPTS - 1) await this.sleep(RESUME_POLL_DELAY_MS);
    }
    return undefined;
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

/** OS-assigned free TCP port — released immediately so opencode can bind it;
 *  the brief gap is the same accepted race every "pick a free port" caller
 *  takes (there is no portable atomic reserve-without-bind). */
function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not allocate a free port"));
      });
    });
  });
}
