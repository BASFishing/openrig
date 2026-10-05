import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, cosineSimilarity } from "./memory-store.js";
import type { MemoryChunk } from "./memory-store.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-store-test-"));
  filePath = join(dir, "memory.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Plain-optional (not derived from the Omit-intersection the method itself is typed
// with) so that omitting turnIndex here is actually legal at the type level — the
// method's own parameter type flattens `Omit<MemoryChunk, ...> & { turnIndex?: number }`
// to a required `turnIndex: number` by TS's intersection rules, so appendInput() below
// casts at the one call site instead of fighting that quirk in every test.
interface ChunkInput {
  sessionId: string;
  seatId: string;
  tags: string[];
  content: string;
  embedding: number[];
  supersededBy: string | null;
  turnIndex?: number;
}

function baseInput(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    sessionId: "session-A",
    seatId: "seat-1",
    tags: ["session:session-A"],
    content: "some content",
    embedding: [1, 0, 0],
    supersededBy: null,
    ...overrides,
  };
}

/** Appends a chunk built from baseInput()'s overrides, exercising the exact same
 *  runtime object shape appendChunk documents (turnIndex present only when the
 *  caller supplies it). */
function appendInput(store: MemoryStore, overrides: Partial<ChunkInput> = {}) {
  return store.appendChunk(baseInput(overrides) as Parameters<MemoryStore["appendChunk"]>[0]);
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("returns 0 for a zero vector instead of throwing/NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("MemoryStore.appendChunk", () => {
  it("assigns sequential turnIndex per session starting at 0", () => {
    const store = new MemoryStore({ filePath });
    const c0 = appendInput(store, { content: "first" });
    const c1 = appendInput(store, { content: "second" });
    const c2 = appendInput(store, { content: "third" });
    expect(c0.turnIndex).toBe(0);
    expect(c1.turnIndex).toBe(1);
    expect(c2.turnIndex).toBe(2);
  });

  it("tracks turnIndex independently per sessionId", () => {
    const store = new MemoryStore({ filePath });
    const a0 = appendInput(store, { sessionId: "A" });
    const b0 = appendInput(store, { sessionId: "B" });
    const a1 = appendInput(store, { sessionId: "A" });
    expect(a0.turnIndex).toBe(0);
    expect(b0.turnIndex).toBe(0);
    expect(a1.turnIndex).toBe(1);
  });

  it("respects an explicitly-supplied turnIndex", () => {
    const store = new MemoryStore({ filePath });
    const c = appendInput(store, { turnIndex: 99 });
    expect(c.turnIndex).toBe(99);
    // subsequent auto-assigned chunk should build on the explicit value
    const next = appendInput(store);
    expect(next.turnIndex).toBe(100);
  });

  it("assigns an id and createdAt, and persists immediately", () => {
    const store = new MemoryStore({ filePath });
    const c = appendInput(store);
    expect(typeof c.id).toBe("string");
    expect(c.id.length).toBeGreaterThan(0);
    expect(typeof c.createdAt).toBe("string");
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("MemoryStore.markSuperseded", () => {
  it("sets supersededBy and persists", () => {
    const store = new MemoryStore({ filePath });
    const oldChunk = appendInput(store, { content: "old" });
    const newChunk = appendInput(store, { content: "new" });
    store.markSuperseded(oldChunk.id, newChunk.id);

    const reloaded = new MemoryStore({ filePath });
    const found = reloaded.all().find((c) => c.id === oldChunk.id);
    expect(found?.supersededBy).toBe(newChunk.id);
  });

  it("is a no-op (does not throw) if oldChunkId doesn't exist", () => {
    const store = new MemoryStore({ filePath });
    appendInput(store);
    expect(() => store.markSuperseded("nonexistent-id", "whatever")).not.toThrow();
  });

  it("excludes superseded chunks from queryBySimilarity by default, includes with excludeSuperseded:false", () => {
    const store = new MemoryStore({ filePath });
    const oldChunk = appendInput(store, { content: "old", embedding: [1, 0, 0] });
    const newChunk = appendInput(store, { content: "new", embedding: [0.9, 0.1, 0] });
    store.markSuperseded(oldChunk.id, newChunk.id);

    const defaultResults = store.queryBySimilarity([1, 0, 0], { allowedTags: ["session:session-A"] });
    expect(defaultResults.find((c) => c.id === oldChunk.id)).toBeUndefined();

    const includedResults = store.queryBySimilarity([1, 0, 0], {
      allowedTags: ["session:session-A"],
      excludeSuperseded: false,
    });
    expect(includedResults.find((c) => c.id === oldChunk.id)).toBeDefined();
  });
});

describe("MemoryStore.queryBySimilarity", () => {
  it("filters by tag intersection: a chunk tagged only session:A is invisible to a query allowing only session:B", () => {
    const store = new MemoryStore({ filePath });
    appendInput(store, { tags: ["session:A"], embedding: [1, 0, 0] });

    const results = store.queryBySimilarity([1, 0, 0], { allowedTags: ["session:B"] });
    expect(results).toHaveLength(0);
  });

  it("a chunk tagged [session:A, shared] is visible to a query allowing just 'shared'", () => {
    const store = new MemoryStore({ filePath });
    const c = appendInput(store, { tags: ["session:A", "shared"], embedding: [1, 0, 0] });

    const results = store.queryBySimilarity([1, 0, 0], { allowedTags: ["shared"] });
    expect(results.map((r) => r.id)).toContain(c.id);
  });

  it("respects limit and ranks by descending score", () => {
    const store = new MemoryStore({ filePath });
    // Build chunks with varying similarity to [1, 0, 0]
    appendInput(store, { content: "low", embedding: [0, 1, 0] }); // sim 0
    const mid = appendInput(store, { content: "mid", embedding: [0.5, 0.5, 0] });
    const high = appendInput(store, { content: "high", embedding: [1, 0.01, 0] });

    const results = store.queryBySimilarity([1, 0, 0], { allowedTags: ["session:session-A"], limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe(high.id);
    expect(results[1]?.id).toBe(mid.id);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });

  it("defaults to limit 5", () => {
    const store = new MemoryStore({ filePath });
    for (let i = 0; i < 8; i++) {
      appendInput(store, { content: `c${i}`, embedding: [1, i, 0] });
    }
    const results = store.queryBySimilarity([1, 0, 0], { allowedTags: ["session:session-A"] });
    expect(results).toHaveLength(5);
  });
});

describe("MemoryStore.recentChunksForSession", () => {
  it("respects limit, excludeChunkId, descending turnIndex order, and never returns superseded chunks", () => {
    const store = new MemoryStore({ filePath });
    const c0 = appendInput(store, { content: "0" });
    const c1 = appendInput(store, { content: "1" });
    const c2 = appendInput(store, { content: "2" });
    const c3 = appendInput(store, { content: "3" });
    store.markSuperseded(c1.id, c3.id);

    const results = store.recentChunksForSession({ sessionId: "session-A", excludeChunkId: c3.id, limit: 10 });
    // c3 excluded explicitly, c1 excluded because superseded
    expect(results.map((r) => r.id)).toEqual([c2.id, c0.id]);
  });

  it("respects limit", () => {
    const store = new MemoryStore({ filePath });
    for (let i = 0; i < 5; i++) {
      appendInput(store, { content: `${i}` });
    }
    const results = store.recentChunksForSession({ sessionId: "session-A", limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]!.turnIndex).toBeGreaterThan(results[1]!.turnIndex);
  });

  it("only returns chunks for the given sessionId", () => {
    const store = new MemoryStore({ filePath });
    appendInput(store, { sessionId: "A" });
    appendInput(store, { sessionId: "B" });
    const results = store.recentChunksForSession({ sessionId: "A" });
    expect(results.every((r) => r.sessionId === "A")).toBe(true);
  });
});

describe("MemoryStore persistence round-trip", () => {
  it("a fresh MemoryStore pointed at the same filePath sees all previously-persisted chunks", () => {
    const store1 = new MemoryStore({ filePath });
    appendInput(store1, { content: "first" });
    appendInput(store1, { content: "second" });
    appendInput(store1, { content: "third" });

    const store2 = new MemoryStore({ filePath });
    const all = store2.all();
    expect(all).toHaveLength(3);
    expect(all.map((c) => c.content)).toEqual(["first", "second", "third"]);
  });

  it("creates the parent directory if it doesn't exist yet", () => {
    const nestedPath = join(dir, "nested", "deeper", "memory.jsonl");
    const store = new MemoryStore({ filePath: nestedPath });
    appendInput(store);
    expect(existsSync(nestedPath)).toBe(true);
  });
});
