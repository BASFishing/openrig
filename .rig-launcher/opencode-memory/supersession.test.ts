import { describe, it, expect } from "vitest";
import { detectSupersession, REVISION_PATTERNS } from "./supersession.js";
import type { SupersessionCandidate } from "./supersession.js";

// Similar embeddings (high cosine similarity) vs dissimilar embeddings, used across tests.
const SIMILAR_TO_A = [1, 0.05, 0];
const EMBEDDING_A = [1, 0, 0];
const DISSIMILAR = [0, 1, 0];

describe("detectSupersession", () => {
  it("a clear revision against a highly-similar older chunk about the same topic -> superseded", () => {
    const candidates: SupersessionCandidate[] = [
      { chunkId: "old-1", content: "Let's use MySQL for the database.", embedding: EMBEDDING_A },
    ];

    const result = detectSupersession({
      newContent: "Actually, let's use Postgres instead of MySQL.",
      newEmbedding: SIMILAR_TO_A,
      candidates,
    });

    expect(result).toEqual(["old-1"]);
  });

  it("revision language with NO similar candidate -> returns []", () => {
    const candidates: SupersessionCandidate[] = [
      { chunkId: "old-1", content: "Unrelated topic about fonts.", embedding: DISSIMILAR },
    ];

    const result = detectSupersession({
      newContent: "Actually, let's use Postgres instead of MySQL.",
      newEmbedding: EMBEDDING_A,
      candidates,
    });

    expect(result).toEqual([]);
  });

  it("highly-similar candidate but NO revision language -> returns [] (plain topical continuation)", () => {
    const candidates: SupersessionCandidate[] = [
      { chunkId: "old-1", content: "Let's use MySQL for the database.", embedding: EMBEDDING_A },
    ];

    const result = detectSupersession({
      newContent: "MySQL also supports JSON columns, which is handy here.",
      newEmbedding: SIMILAR_TO_A,
      candidates,
    });

    expect(result).toEqual([]);
  });

  it("word-boundary false-positive check: 'factually' must not match 'actually', and a naive substring regex would wrongly fire", () => {
    const candidates: SupersessionCandidate[] = [
      { chunkId: "old-1", content: "Let's use MySQL for the database.", embedding: EMBEDDING_A },
    ];

    const result = detectSupersession({
      newContent: "That claim is factually incorrect, but MySQL is still the plan.",
      newEmbedding: SIMILAR_TO_A,
      candidates,
    });

    expect(result).toEqual([]);
    // Directly confirm the regex itself is word-boundary-aware, not substring-based.
    const actuallyPattern = REVISION_PATTERNS.find((p) => p.source.includes("actually"));
    expect(actuallyPattern).toBeDefined();
    expect(actuallyPattern!.test("factually")).toBe(false);
    expect(actuallyPattern!.test("actually")).toBe(true);
  });

  it("multiple qualifying candidates are all returned", () => {
    const candidates: SupersessionCandidate[] = [
      { chunkId: "old-1", content: "Use MySQL for storage.", embedding: EMBEDDING_A },
      { chunkId: "old-2", content: "Use MySQL for the cache layer too.", embedding: [0.98, 0.1, 0] },
      { chunkId: "old-3", content: "Completely unrelated idea about fonts.", embedding: DISSIMILAR },
    ];

    const result = detectSupersession({
      newContent: "Actually, scrap that — let's use Postgres everywhere instead.",
      newEmbedding: EMBEDDING_A,
      candidates,
    });

    expect(result).toEqual(["old-1", "old-2"]);
  });

  it("respects a custom similarityThreshold", () => {
    const candidates: SupersessionCandidate[] = [{ chunkId: "old-1", content: "Use MySQL.", embedding: [0.9, 0.1, 0] }];

    const strict = detectSupersession({
      newContent: "Actually, let's use Postgres instead.",
      newEmbedding: EMBEDDING_A,
      candidates,
      similarityThreshold: 0.999,
    });
    expect(strict).toEqual([]);

    const lenient = detectSupersession({
      newContent: "Actually, let's use Postgres instead.",
      newEmbedding: EMBEDDING_A,
      candidates,
      similarityThreshold: 0.8,
    });
    expect(lenient).toEqual(["old-1"]);
  });

  it("REVISION_PATTERNS includes word-boundary guards for other near-miss phrasings", () => {
    const mistakenPattern = REVISION_PATTERNS.find((p) => p.test("mistaken"));
    // "I was wrong" should not fire on an unrelated word like "mistaken"
    expect(mistakenPattern).toBeUndefined();
  });
});
