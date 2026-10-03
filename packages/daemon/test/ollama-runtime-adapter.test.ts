// Hermetic tests for OllamaRuntimeAdapter, mirroring stub-runtime-adapter.test.ts's
// conventions (in-memory fs/tmux fakes, no real process/network).

import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaRuntimeAdapter } from "../src/adapters/ollama-runtime-adapter.js";

function memFs(files: Record<string, string> = {}) {
  const store = { ...files };
  return {
    readFile: (p: string) => {
      if (p in store) return store[p]!;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    },
    writeFile: vi.fn((p: string, c: string) => { store[p] = c; }),
    exists: (p: string) => p in store,
    mkdirp: vi.fn(),
    listFiles: vi.fn(() => []),
  };
}

function tmuxWith(opts: { hasSession?: boolean; paneCommand?: string } = {}) {
  return {
    hasSession: vi.fn(async () => opts.hasSession ?? false),
    getPaneCommand: vi.fn(async () => opts.paneCommand ?? ""),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  };
}

const binding = { tmuxSession: "dev-local@test-rig", cwd: "/work", model: "qwen3:8b" };

describe("OllamaRuntimeAdapter.checkReady", () => {
  it("reports ready for a live seat with ready sidecar evidence and a non-shell pane", async () => {
    const adapter = new OllamaRuntimeAdapter({
      tmux: tmuxWith({ hasSession: true, paneCommand: "node" }),
      fsOps: memFs({ "/work/.openrig/ollama/state.json": JSON.stringify({ ready: true }) }),
    });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(true);
  });

  it("reports not ready when no sidecar has ever been written (absent)", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith({ hasSession: true }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("awaiting_runtime");
  });

  it("reports not ready when the runner recorded its own exit", async () => {
    const adapter = new OllamaRuntimeAdapter({
      tmux: tmuxWith({ hasSession: true }),
      fsOps: memFs({ "/work/.openrig/ollama/state.json": JSON.stringify({ ready: false, exited: { code: 1 } }) }),
    });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("does not trust a ready sidecar when the pane has fallen back to a bare shell", async () => {
    const adapter = new OllamaRuntimeAdapter({
      tmux: tmuxWith({ hasSession: true, paneCommand: "zsh" }),
      fsOps: memFs({ "/work/.openrig/ollama/state.json": JSON.stringify({ ready: true }) }),
    });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "a stale sidecar must not survive a pane that fell back to a shell").toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("reports not ready when the tmux session itself is gone", async () => {
    const adapter = new OllamaRuntimeAdapter({
      tmux: tmuxWith({ hasSession: false }),
      fsOps: memFs({ "/work/.openrig/ollama/state.json": JSON.stringify({ ready: true }) }),
    });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
  });

  it("reports not ready with no tmux session bound at all", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.checkReady({ cwd: "/work" });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/No tmux session bound/);
  });
});

describe("OllamaRuntimeAdapter.launchHarness", () => {
  it("refuses forkSource — ollama has no native session/fork primitive", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.launchHarness(binding, { name: "local", forkSource: { kind: "last" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no native fork primitive/);
  });

  it("refuses when both resumeToken and forkSource are given", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.launchHarness(binding, {
      name: "local",
      resumeToken: "r1",
      forkSource: { kind: "last" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mutually exclusive/);
  });

  it("refuses with no tmux session bound", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.launchHarness({ cwd: "/work" }, { name: "local" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No tmux session bound/);
  });

  it("fails fast when runnerEntryPath is configured but the compiled runner is missing", async () => {
    const adapter = new OllamaRuntimeAdapter({
      tmux: tmuxWith(),
      fsOps: memFs(),
      runnerEntryPath: "/dist/adapters/ollama-runner.js",
    });
    const result = await adapter.launchHarness(binding, { name: "local" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ollama-runner entry not found/);
  });

  it("takes the hermetic in-memory path and reports ready when no runnerEntryPath is configured", async () => {
    // No fsOps at all — this IS the hermetic construction (mirrors the stub
    // adapter's own contract: fsOps present, even if empty, routes checkReady
    // through the sidecar file instead of the in-memory launch record).
    const tmux = tmuxWith();
    const adapter = new OllamaRuntimeAdapter({ tmux, sleep: async () => {} });
    const result = await adapter.launchHarness(binding, { name: "local" });
    expect(result.ok).toBe(true);
    // Hermetic path never types anything into the pane.
    expect(tmux.sendText).not.toHaveBeenCalled();
    const ready = await adapter.checkReady(binding);
    expect(ready.ready).toBe(true);
  });
});

describe("OllamaRuntimeAdapter.listInstalled", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("lists models from Ollama's /api/tags", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "qwen3.5-9b-uncensored:latest" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const installed = await adapter.listInstalled(binding);
    expect(installed.map((r) => r.effectiveId)).toEqual(["qwen3:8b", "qwen3.5-9b-uncensored:latest"]);
  });

  it("returns an honest empty list when Ollama is unreachable, never throws", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const installed = await adapter.listInstalled(binding);
    expect(installed).toEqual([]);
  });
});
