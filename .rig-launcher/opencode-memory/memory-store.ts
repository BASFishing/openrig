import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A plain-JSONL-backed memory store for the opencode local-agent memory system.
// Deliberately has NO native dependencies (no better-sqlite3/sqlite3) because this
// runs inside opencode's own process, where native deps aren't guaranteed to resolve.
// The whole file is loaded into memory on construction and rewritten in full on every
// mutation — simplicity over throughput, which is the right tradeoff at the scale this
// is meant for (a single person's long-running conversation: low thousands of chunks).

export interface MemoryChunk {
  id: string;
  sessionId: string;
  seatId: string;
  /** e.g. ["session:<sessionId>"] for a normal chunk, plus ["shared"] when a privileged
   *  seat explicitly writes into the cross-seat shared partition. Access filtering at
   *  query time is tag-based: a caller passes the tags it's allowed to see. */
  tags: string[];
  content: string;
  embedding: number[];
  /** Set by markSuperseded when a LATER chunk is judged (by the supersession module,
   *  not this one) to replace this one. Null = not superseded. */
  supersededBy: string | null;
  createdAt: string; // ISO 8601
  /** Monotonically increasing per sessionId — lets a caller reason about recency
   *  within a session without using wall-clock time (see note below on why). */
  turnIndex: number;
}

export interface MemoryStoreDeps {
  /** Absolute path to the JSONL file. Caller is responsible for the path existing
   *  or being creatable (mkdir -p the parent dir yourself if absent). */
  filePath: string;
}

/** Standard cosine similarity, exported standalone since embeddings.ts and tests
 *  both need it too — avoid a duplicate implementation. Returns a number in roughly
 *  [-1, 1] (can be outside that range only from floating-point error at the edges). */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class MemoryStore {
  private readonly filePath: string;
  private chunks: MemoryChunk[];

  constructor(deps: MemoryStoreDeps) {
    this.filePath = deps.filePath;
    this.chunks = this.load();
  }

  private load(): MemoryChunk[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as MemoryChunk);
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const body = this.chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
    // Trailing newline so the file is a well-formed JSONL file (and appends, if any
    // tool ever tails it, land cleanly on their own line).
    writeFileSync(this.filePath, this.chunks.length > 0 ? body + "\n" : "", "utf8");
  }

  /** Appends a new chunk (assigns it an id — use crypto.randomUUID() — and persists
   *  immediately). turnIndex should be assigned by this method as
   *  (highest existing turnIndex for that sessionId) + 1, starting at 0, UNLESS the
   *  caller explicitly supplies turnIndex in the input (some callers may want to
   *  control it themselves) — support both: if input.turnIndex is a number, use it
   *  as-is; if absent, auto-assign per the rule above. Returns the full persisted chunk. */
  appendChunk(input: Omit<MemoryChunk, "id" | "createdAt"> & { turnIndex?: number }): MemoryChunk {
    let turnIndex: number;
    if (typeof input.turnIndex === "number") {
      turnIndex = input.turnIndex;
    } else {
      let highest = -1;
      for (const chunk of this.chunks) {
        if (chunk.sessionId === input.sessionId && chunk.turnIndex > highest) {
          highest = chunk.turnIndex;
        }
      }
      turnIndex = highest + 1;
    }

    const chunk: MemoryChunk = {
      id: randomUUID(),
      sessionId: input.sessionId,
      seatId: input.seatId,
      tags: input.tags,
      content: input.content,
      embedding: input.embedding,
      supersededBy: input.supersededBy,
      createdAt: new Date().toISOString(),
      turnIndex,
    };

    this.chunks.push(chunk);
    this.persist();
    return chunk;
  }

  /** Marks oldChunkId as superseded by newChunkId (sets supersededBy, persists).
   *  No-op (does not throw) if oldChunkId doesn't exist. */
  markSuperseded(oldChunkId: string, newChunkId: string): void {
    const target = this.chunks.find((chunk) => chunk.id === oldChunkId);
    if (!target) {
      return;
    }
    target.supersededBy = newChunkId;
    this.persist();
  }

  /** Returns chunks ranked by cosine similarity to queryEmbedding, filtered to only
   *  chunks whose `tags` intersects `opts.allowedTags` (at least one tag in common),
   *  descending by score. excludeSuperseded (default true) drops any chunk with a
   *  non-null supersededBy UNLESS the caller explicitly passes false. limit (default 5)
   *  caps the result count. */
  queryBySimilarity(
    queryEmbedding: number[],
    opts: {
      allowedTags: string[];
      excludeSuperseded?: boolean;
      limit?: number;
    },
  ): Array<MemoryChunk & { score: number }> {
    const excludeSuperseded = opts.excludeSuperseded !== false;
    const limit = opts.limit ?? 5;
    const allowed = new Set(opts.allowedTags);

    const candidates = this.chunks.filter((chunk) => {
      if (excludeSuperseded && chunk.supersededBy !== null) {
        return false;
      }
      return chunk.tags.some((tag) => allowed.has(tag));
    });

    return candidates
      .map((chunk) => ({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Returns the N most recent (by turnIndex, descending) non-superseded chunks for
   *  a given sessionId — used by the supersession module as the candidate pool to
   *  check a brand-new chunk against. excludeChunkId lets the caller exclude the
   *  chunk that was JUST inserted (so it never "supersedes itself"). limit default 20. */
  recentChunksForSession(opts: { sessionId: string; excludeChunkId?: string; limit?: number }): MemoryChunk[] {
    const limit = opts.limit ?? 20;
    return this.chunks
      .filter((chunk) => {
        if (chunk.sessionId !== opts.sessionId) return false;
        if (chunk.supersededBy !== null) return false;
        if (opts.excludeChunkId && chunk.id === opts.excludeChunkId) return false;
        return true;
      })
      .sort((a, b) => b.turnIndex - a.turnIndex)
      .slice(0, limit);
  }

  /** All chunks, unfiltered — mainly for tests, but real callers may use it too. */
  all(): MemoryChunk[] {
    return [...this.chunks];
  }
}
