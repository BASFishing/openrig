// Unit tests for the pane-hosted ollama-runner's pure/injectable logic.
// Three facts here each pin a bug that was found and fixed against a REAL
// live pilot rig, not discovered by inspection — see ollama-runner.ts's
// own comments at createTurnQueue and the debounce block for the incident
// each test guards against.

import { describe, it, expect, vi, afterEach } from "vitest";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

// Real Node execFile has a util.promisify.custom implementation that returns
// {stdout, stderr} directly; generic promisify-of-a-callback would instead
// resolve with just the callback's first non-error argument. Replicate that
// custom symbol here — set INSIDE the vi.hoisted block, since only vi.mock/
// vi.hoisted calls themselves are hoisted above imports, not plain statements
// that follow them — so execFileAsync (promisify(execFile) in production
// code) behaves the same way against this mock as against the real module.
const { execFileMock, execFilePromisifiedMock } = vi.hoisted(() => {
  const promisifyCustomSymbol = Symbol.for("nodejs.util.promisify.custom");
  const execFilePromisifiedMock = vi.fn(async () => ({ stdout: "Sent to dev-local@test-rig\n", stderr: "" }));
  const execFileMock = vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => cb(null, "Sent to dev-local@test-rig\n", ""),
  ) as unknown as Record<symbol, unknown>;
  execFileMock[promisifyCustomSymbol] = execFilePromisifiedMock;
  return { execFileMock, execFilePromisifiedMock };
});
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import {
  parseOllamaRunnerArgs,
  maybeCompact,
  createTurnQueue,
  makeRespond,
  MAX_TOOL_ITERATIONS,
  COMPACTION_TRIGGER_TOKENS,
  COMPACTION_KEEP_RECENT,
  type ChatMessage,
} from "../src/adapters/ollama-runner.js";

const OLLAMA_URL = "http://127.0.0.1:11434/v1";
const OPENCODE_URL = "http://127.0.0.1:4096";

/** A fake assistant message, OpenAI-shaped, as the fake Ollama endpoint returns it. */
function assistantMessage(opts: { content?: string; toolCall?: { name: string; args: Record<string, unknown> } }) {
  return {
    choices: [{
      message: {
        content: opts.content ?? "",
        tool_calls: opts.toolCall
          ? [{ id: "call_1", type: "function", function: { name: opts.toolCall.name, arguments: JSON.stringify(opts.toolCall.args) } }]
          : undefined,
      },
    }],
  };
}

/** Installs a fetch mock keyed by which base URL a request hits, restored after each test. */
function mockFetch(opts: {
  ollama: Array<Record<string, unknown>>; // one entry consumed per /chat/completions call, in order
  opencode?: (url: string) => Record<string, unknown> | { status: number };
}) {
  let ollamaCallIndex = 0;
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(OLLAMA_URL)) {
      const body = opts.ollama[ollamaCallIndex];
      ollamaCallIndex += 1;
      if (!body) throw new Error(`mockFetch: no ollama response queued for call #${ollamaCallIndex}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.startsWith(OPENCODE_URL)) {
      const result = opts.opencode?.(url) ?? { content: "" };
      if ("status" in result) return new Response("error", { status: result.status });
      return new Response(JSON.stringify(result), { status: 200 });
    }
    throw new Error(`mockFetch: unexpected URL ${url}`);
  }) as unknown as typeof fetch;
  return { calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("parseOllamaRunnerArgs", () => {
  it("parses all required flags plus the optional --session resume token", () => {
    const args = parseOllamaRunnerArgs([
      "--session-name", "dev-local@rig",
      "--cwd", "/work",
      "--launch-id", "abc123",
      "--posture", "floor",
      "--model", "qwen3:8b",
      "--base-url", "http://127.0.0.1:11434/v1",
      "--session", "resume-token-1",
    ]);
    expect(args).toEqual({
      sessionName: "dev-local@rig",
      cwd: "/work",
      launchId: "abc123",
      posture: "floor",
      model: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434/v1",
      resumeToken: "resume-token-1",
    });
  });

  it("throws a clear error when a required flag is missing", () => {
    expect(() => parseOllamaRunnerArgs(["--cwd", "/work"])).toThrow(/--session-name is required/);
  });

  it("defaults an unrecognized or absent --posture to floor, never full_bypass", () => {
    const args = parseOllamaRunnerArgs([
      "--session-name", "s", "--cwd", "/w", "--launch-id", "l",
      "--model", "m", "--base-url", "http://x",
    ]);
    expect(args.posture).toBe("floor");
  });
});

describe("maybeCompact", () => {
  const system: ChatMessage = { role: "system", content: "sys" };

  it("leaves history untouched when under the token-estimate threshold", async () => {
    const history: ChatMessage[] = [system, { role: "user", content: "hi" }];
    const chat = vi.fn();
    const result = await maybeCompact(history, chat);
    expect(result).toBe(history); // same reference — no-op, not just equal content
    expect(chat).not.toHaveBeenCalled();
  });

  it("leaves history untouched when over threshold but not enough turns exist to compact", async () => {
    // One giant message blows the token estimate but there's nothing "old"
    // beyond the keep-recent window — compacting would have nothing to do.
    const big = "x".repeat(COMPACTION_TRIGGER_TOKENS * 4 + 100);
    const history: ChatMessage[] = [system, { role: "user", content: big }];
    const chat = vi.fn();
    const result = await maybeCompact(history, chat);
    expect(result).toBe(history);
    expect(chat).not.toHaveBeenCalled();
  });

  it("summarizes everything except the system message and the recent window once over threshold", async () => {
    const big = "x".repeat(COMPACTION_TRIGGER_TOKENS * 4 + 100);
    const middleCount = COMPACTION_KEEP_RECENT + 3; // enough "old" turns to actually compact
    const history: ChatMessage[] = [
      system,
      ...Array.from({ length: middleCount }, (_, i) => ({ role: "user", content: `${big}-${i}` } as ChatMessage)),
      ...Array.from({ length: COMPACTION_KEEP_RECENT }, (_, i) => ({ role: "user", content: `recent-${i}` } as ChatMessage)),
    ];
    const chat = vi.fn(async () => "a dense summary");
    const result = await maybeCompact(history, chat);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result[0]).toBe(system);
    expect(result[1]!.content).toContain("a dense summary");
    // Every recent message survives verbatim, in order, after the summary.
    const recentTail = result.slice(2);
    expect(recentTail).toHaveLength(COMPACTION_KEEP_RECENT);
    expect(recentTail.map((m) => m.content)).toEqual(
      Array.from({ length: COMPACTION_KEEP_RECENT }, (_, i) => `recent-${i}`),
    );
  });
});

/** Wraps a plain text-in/text-out `chat` into a `respond` matching the
 *  pre-tool-calling behavior (push one assistant reply, no tool loop) — for
 *  tests exercising queue/concurrency semantics independent of tool-calling. */
function respondFromChat(chat: (messages: ChatMessage[]) => Promise<string>) {
  return async (historyRef: { current: ChatMessage[] }): Promise<string> => {
    const reply = await chat(historyRef.current);
    historyRef.current.push({ role: "assistant", content: reply });
    return reply;
  };
}

describe("createTurnQueue — concurrency correctness", () => {
  // Incident: the daemon's own post-launch identity-hint message and a
  // human/operator `rig send` landed ~3s apart on a live pilot rig. A single
  // model call can run 20-60+ seconds, so the second message's debounce flush
  // fired while the first call was still in flight. Before this queue
  // existed, both handlers read/mutated the SAME shared history array
  // concurrently: the first reply landed AFTER the second user turn had
  // already been pushed, making it look like a reply to the wrong message,
  // while the second request's own (correct) answer was at risk of being
  // silently dropped. This test reproduces that exact shape with a fake
  // `chat` whose delay is deliberately longer than the gap between the two
  // calls, and asserts strict in-order turns regardless.
  it("processes turns strictly one at a time, in arrival order, even when a later message arrives before an earlier model call resolves", async () => {
    const system: ChatMessage = { role: "system", content: "sys" };
    const historyRef = { current: [system] };
    const replies: string[] = [];
    const persisted: ChatMessage[][] = [];

    // call 1 resolves slowly; call 2 (queued behind it) resolves fast — if
    // the old racy code were still in place, call 2 could start before call
    // 1 finishes and interleave.
    let callCount = 0;
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      callCount += 1;
      const thisCall = callCount;
      await new Promise((resolve) => setTimeout(resolve, thisCall === 1 ? 40 : 5));
      // Prove each call sees a conversation the other call could not have
      // produced: call 1's request must NOT already contain call 2's user
      // turn (that's exactly the corruption the old code allowed).
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return `reply-to:${lastUser?.content}`;
    });

    const handleUserMessage = createTurnQueue({
      historyRef,
      chat,
      respond: respondFromChat(chat),
      onReply: (reply) => replies.push(reply),
      onError: (err) => { throw err; },
      onHistoryChange: (h) => persisted.push(h.map((m) => ({ ...m }))),
    });

    handleUserMessage("question-1");
    // Fire the second message almost immediately — well before call 1's 40ms
    // delay resolves — reproducing the real-world gap that broke the old code.
    await new Promise((resolve) => setTimeout(resolve, 5));
    handleUserMessage("question-2");

    // Wait out both calls.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(replies).toEqual(["reply-to:question-1", "reply-to:question-2"]);
    expect(historyRef.current.map((m) => `${m.role}:${m.content}`)).toEqual([
      "system:sys",
      "user:question-1",
      "assistant:reply-to:question-1",
      "user:question-2",
      "assistant:reply-to:question-2",
    ]);
    // Persisted exactly twice, once per completed turn, each a stable snapshot.
    expect(persisted).toHaveLength(2);
    expect(persisted[0]!.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("still completes and reports the error when the model call rejects, without blocking later turns", async () => {
    const historyRef = { current: [{ role: "system", content: "sys" } as ChatMessage] };
    const errors: Error[] = [];
    const replies: string[] = [];
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser?.content === "boom") throw new Error("model unreachable");
      return "ok";
    });
    const handleUserMessage = createTurnQueue({
      historyRef,
      chat,
      respond: respondFromChat(chat),
      onReply: (reply) => replies.push(reply),
      onError: (err) => errors.push(err),
      onHistoryChange: () => {},
    });

    handleUserMessage("boom");
    handleUserMessage("fine");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("model unreachable");
    expect(replies).toEqual(["ok"]);
  });
});

describe("makeRespond — tool-calling loop", () => {
  const system: ChatMessage = { role: "system", content: "sys" };

  it("returns the model's plain reply directly when it calls no tools", async () => {
    mockFetch({ ollama: [assistantMessage({ content: "just an answer" })] });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, "/tmp");
    const historyRef = { current: [system, { role: "user", content: "hi" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toBe("just an answer");
    expect(historyRef.current.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("executes a read_file tool call against opencode and feeds the real result back to the model", async () => {
    const { calls } = mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "read_file", args: { path: "AGENTS.md" } } }),
        assistantMessage({ content: "the file says hello" }),
      ],
      opencode: () => ({ content: "hello from the real file" }),
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, "/tmp");
    const historyRef = { current: [system, { role: "user", content: "read it" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toBe("the file says hello");
    expect(historyRef.current.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.content).toBe("hello from the real file");
    expect(toolMessage.tool_call_id).toBe("call_1");
    // Two ollama calls (initial + after tool result), one opencode call.
    expect(calls.filter((u) => u.startsWith(OLLAMA_URL))).toHaveLength(2);
    expect(calls.filter((u) => u.startsWith(OPENCODE_URL))).toHaveLength(1);
    expect(calls.find((u) => u.includes("/file/content"))).toContain("path=AGENTS.md");
  });

  it("turns an opencode failure into an error tool_result instead of throwing", async () => {
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "read_file", args: { path: "missing.md" } } }),
        assistantMessage({ content: "couldn't read it" }),
      ],
      opencode: () => ({ status: 500 }),
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, "/tmp");
    const historyRef = { current: [system, { role: "user", content: "read it" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toBe("couldn't read it");
    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.content).toMatch(/^error:/);
  });

  it("reports tools as disabled, without crashing, when no opencode URL is configured", async () => {
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "bash", args: { command: "echo hi" } } }),
        assistantMessage({ content: "ok, skipped" }),
      ],
    });
    // No third arg — opencodeUrl undefined, mirroring a seat launched without tools.
    const respond = makeRespond(OLLAMA_URL, "test-model", undefined, "/tmp");
    const historyRef = { current: [system, { role: "user", content: "run something" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toBe("ok, skipped");
    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.content).toMatch(/tools are disabled/);
  });

  it("stops after MAX_TOOL_ITERATIONS rather than looping forever on a model that never stops calling tools", async () => {
    const infiniteToolCalls = Array.from({ length: MAX_TOOL_ITERATIONS }, () =>
      assistantMessage({ toolCall: { name: "bash", args: { command: "echo loop" } } }),
    );
    const { calls } = mockFetch({
      ollama: infiniteToolCalls,
      opencode: () => ({ content: "loop" }),
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, "/tmp");
    const historyRef = { current: [system, { role: "user", content: "go forever" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toMatch(/exceeded max iterations/);
    expect(calls.filter((u) => u.startsWith(OLLAMA_URL))).toHaveLength(MAX_TOOL_ITERATIONS);
  });
});

describe("write_file / edit_file tools — real filesystem, path-containment enforced", () => {
  const system: ChatMessage = { role: "system", content: "sys" };
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a new file inside the seat's cwd", async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ollama-runner-test-"));
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "write_file", args: { path: "note.txt", content: "hello from the model" } } }),
        assistantMessage({ content: "wrote it" }),
      ],
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, tmpDir);
    const historyRef = { current: [system, { role: "user", content: "write a note" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toBe("wrote it");
    expect(nodeFs.readFileSync(nodePath.join(tmpDir, "note.txt"), "utf-8")).toBe("hello from the model");
    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.content).toMatch(/^wrote \d+ bytes/);
  });

  it("refuses a write_file path that escapes the seat's cwd", async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ollama-runner-test-"));
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "write_file", args: { path: "../escape.txt", content: "nope" } } }),
        assistantMessage({ content: "blocked" }),
      ],
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, tmpDir);
    const historyRef = { current: [system, { role: "user", content: "escape" } as ChatMessage] };

    await respond(historyRef);

    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.content).toMatch(/^error: refusing to write outside/);
    expect(nodeFs.existsSync(nodePath.join(tmpDir, "..", "escape.txt"))).toBe(false);
  });

  it("edits a file via a unique exact-string replace", async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ollama-runner-test-"));
    nodeFs.writeFileSync(nodePath.join(tmpDir, "code.txt"), "const x = 1;\nconst y = 2;\n");
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "edit_file", args: { path: "code.txt", old_str: "const x = 1;", new_str: "const x = 100;" } } }),
        assistantMessage({ content: "edited" }),
      ],
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, tmpDir);
    const historyRef = { current: [system, { role: "user", content: "fix x" } as ChatMessage] };

    await respond(historyRef);

    expect(nodeFs.readFileSync(nodePath.join(tmpDir, "code.txt"), "utf-8")).toBe("const x = 100;\nconst y = 2;\n");
  });

  it("refuses an edit_file whose old_str is not unique in the file", async () => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "ollama-runner-test-"));
    nodeFs.writeFileSync(nodePath.join(tmpDir, "dup.txt"), "same\nsame\n");
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "edit_file", args: { path: "dup.txt", old_str: "same", new_str: "different" } } }),
        assistantMessage({ content: "couldn't" }),
      ],
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, tmpDir);
    const historyRef = { current: [system, { role: "user", content: "fix it" } as ChatMessage] };

    await respond(historyRef);

    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.content).toMatch(/occurs 2 times/);
    expect(nodeFs.readFileSync(nodePath.join(tmpDir, "dup.txt"), "utf-8")).toBe("same\nsame\n");
  });
});

describe("dispatch_to_seat tool — real delegation via the rig CLI", () => {
  const system: ChatMessage = { role: "system", content: "sys" };

  afterEach(() => { execFilePromisifiedMock.mockClear(); });

  it("shells out to `rig send <session> <message>` and returns its output", async () => {
    mockFetch({
      ollama: [
        assistantMessage({ toolCall: { name: "dispatch_to_seat", args: { session: "dev-impl@my-rig", message: "please run the tests" } } }),
        assistantMessage({ content: "dispatched" }),
      ],
    });
    const respond = makeRespond(OLLAMA_URL, "test-model", OPENCODE_URL, "/tmp");
    const historyRef = { current: [system, { role: "user", content: "ask impl to test" } as ChatMessage] };

    const reply = await respond(historyRef);

    expect(reply).toBe("dispatched");
    expect(execFilePromisifiedMock).toHaveBeenCalledWith("rig", ["send", "dev-impl@my-rig", "please run the tests"]);
    const toolMessage = historyRef.current[3]!;
    expect(toolMessage.content).toBe("Sent to dev-local@test-rig");
  });
});
