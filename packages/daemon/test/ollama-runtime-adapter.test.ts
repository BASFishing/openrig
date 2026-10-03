// Hermetic tests for OllamaRuntimeAdapter, mirroring stub-runtime-adapter.test.ts's
// conventions (in-memory fs/tmux/fetch fakes, no real process/network). The
// adapter launches `opencode` directly in the pane (no OpenRig-owned runner),
// so readiness is pure pane-liveness — no sidecar file — and launch exercises
// opencode.json management + resume-token capture via a fake HTTP session API.

import { describe, it, expect, vi } from "vitest";
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
    _store: store,
  };
}

function tmuxWith(opts: { hasSession?: boolean; paneCommand?: string } = {}) {
  return {
    hasSession: vi.fn(async () => opts.hasSession ?? false),
    getPaneCommand: vi.fn(async () => opts.paneCommand ?? "opencode"),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  };
}

function fakeFetch(sessions: Array<{ id: string; directory?: string; time?: { created?: number } }> = []) {
  return vi.fn(async () => new Response(JSON.stringify(sessions), { status: 200 })) as unknown as typeof fetch;
}

const binding = { tmuxSession: "dev-local@test-rig", cwd: "/work", model: "qwen3:8b" };

describe("OllamaRuntimeAdapter.checkReady", () => {
  it("reports ready for a live session with a non-shell pane", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith({ hasSession: true, paneCommand: "opencode" }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(true);
  });

  it("reports not ready when the tmux session itself is gone", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith({ hasSession: false }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/not responsive/);
  });

  it("reports not ready when the pane has fallen back to a bare shell", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith({ hasSession: true, paneCommand: "zsh" }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("reports awaiting_runtime when the pane command is still empty (opencode hasn't started)", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith({ hasSession: true, paneCommand: "" }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("awaiting_runtime");
  });

  it("reports not ready with no tmux session bound at all", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.checkReady({ cwd: "/work" });
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/No tmux session bound/);
  });
});

describe("OllamaRuntimeAdapter.launchHarness", () => {
  it("refuses forkSource — ollama has no cross-seat fork primitive", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.launchHarness(binding, { name: "local", forkSource: { kind: "last" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no cross-seat fork primitive/);
  });

  it("refuses when both resumeToken and forkSource are given", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.launchHarness(binding, { name: "local", resumeToken: "r1", forkSource: { kind: "last" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mutually exclusive/);
  });

  it("refuses with no tmux session bound", async () => {
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs() });
    const result = await adapter.launchHarness({ cwd: "/work" }, { name: "local" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No tmux session bound/);
  });

  it("writes opencode.json wiring the Ollama provider at this seat's model, merging any existing config", async () => {
    const fs = memFs({ "/work/opencode.json": JSON.stringify({ provider: { other: { npm: "x" } }, extra: true }) });
    const tmux = tmuxWith();
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: fs, sleep: async () => {}, fetchImpl: fakeFetch([]) });
    await adapter.launchHarness(binding, { name: "local" });
    const written = JSON.parse(fs._store["/work/opencode.json"]!);
    expect(written.provider.ollama.options.baseURL).toBe("http://127.0.0.1:11434/v1");
    expect(written.provider.ollama.models).toHaveProperty("qwen3:8b");
    expect(written.provider.other).toEqual({ npm: "x" }); // untouched
    expect(written.extra).toBe(true); // untouched
  });

  it("wraps the launch command in srt when a seat-cwd srt settings file exists", async () => {
    const fs = memFs({ "/work/.openrig/ollama/srt-config.json": "{}" });
    const tmux = tmuxWith();
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: fs, sleep: async () => {}, fetchImpl: fakeFetch([]) });
    await adapter.launchHarness(binding, { name: "local" });
    const cmd = tmux.sendText.mock.calls[0]?.[1] as string;
    expect(cmd).toMatch(/^srt --settings '\/work\/\.openrig\/ollama\/srt-config\.json' -- opencode /);
  });

  it("launches bare (no srt) when no seat-cwd srt settings file exists", async () => {
    const tmux = tmuxWith();
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: memFs(), sleep: async () => {}, fetchImpl: fakeFetch([]) });
    await adapter.launchHarness(binding, { name: "local" });
    const cmd = tmux.sendText.mock.calls[0]?.[1] as string;
    expect(cmd.startsWith("opencode ")).toBe(true);
  });

  it("passes the model as provider/model and sends Enter after the command", async () => {
    const tmux = tmuxWith();
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: memFs(), sleep: async () => {}, fetchImpl: fakeFetch([]) });
    await adapter.launchHarness(binding, { name: "local" });
    const cmd = tmux.sendText.mock.calls[0]?.[1] as string;
    expect(cmd).toMatch(/-m '?ollama\/qwen3:8b'?/);
    expect(tmux.sendKeys).toHaveBeenCalledWith(binding.tmuxSession, ["Enter"]);
  });

  it("on resume, threads the given resumeToken into the command and returns it unchanged without polling", async () => {
    const tmux = tmuxWith();
    const fetchImpl = fakeFetch([]);
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: memFs(), sleep: async () => {}, fetchImpl });
    const result = await adapter.launchHarness(binding, { name: "local", resumeToken: "ses_abc123" });
    const cmd = tmux.sendText.mock.calls[0]?.[1] as string;
    expect(cmd).toMatch(/-s '?ses_abc123'?/);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("ses_abc123");
      expect(result.resumeType).toBe("opencode_session");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("on a fresh launch, captures a newly-appeared session for this seat's cwd as the resume token", async () => {
    const tmux = tmuxWith();
    const fetchImpl = fakeFetch([
      { id: "ses_other_project", directory: "/elsewhere", time: { created: 999 } },
      { id: "ses_this_seat_old", directory: "/work", time: { created: 1 } },
      { id: "ses_this_seat_new", directory: "/work", time: { created: 2 } },
    ]);
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: memFs(), sleep: async () => {}, fetchImpl });
    const result = await adapter.launchHarness(binding, { name: "local" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("ses_this_seat_new");
      expect(result.resumeType).toBe("opencode_session");
    }
  });

  it("on a fresh launch with no session yet (idle seat), returns ok with no resumeToken — not a failure", async () => {
    const tmux = tmuxWith();
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: memFs(), sleep: async () => {}, fetchImpl: fakeFetch([]) });
    const result = await adapter.launchHarness(binding, { name: "local" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBeUndefined();
      expect(result.resumeType).toBeUndefined();
    }
  });

  it("fails the launch if the pane never starts opencode (stays at a shell)", async () => {
    const tmux = tmuxWith({ paneCommand: "zsh" });
    const adapter = new OllamaRuntimeAdapter({ tmux, fsOps: memFs(), sleep: async () => {}, fetchImpl: fakeFetch([]) });
    const result = await adapter.launchHarness(binding, { name: "local" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out waiting for the pane/);
  });
});

describe("OllamaRuntimeAdapter.listInstalled", () => {
  it("lists models from Ollama's /api/tags", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "qwen3.5-9b-uncensored:latest" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs(), fetchImpl });
    const installed = await adapter.listInstalled(binding);
    expect(installed.map((r) => r.effectiveId)).toEqual(["qwen3:8b", "qwen3.5-9b-uncensored:latest"]);
  });

  it("returns an honest empty list when Ollama is unreachable, never throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const adapter = new OllamaRuntimeAdapter({ tmux: tmuxWith(), fsOps: memFs(), fetchImpl });
    const installed = await adapter.listInstalled(binding);
    expect(installed).toEqual([]);
  });
});
