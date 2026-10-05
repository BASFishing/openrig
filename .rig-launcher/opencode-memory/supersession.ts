import { cosineSimilarity } from "./memory-store.js";

// Deterministic, no-LLM-call detection of whether a brand-new chunk supersedes an
// older one. Purely a pattern-match + similarity-threshold heuristic, NOT a
// decay/recency mechanism — recency/age plays NO role here. An old-but-still-valid
// "parked idea" must never be flagged just for being old; only an actual textual
// revision signal plus high topical similarity triggers it.

export interface SupersessionCandidate {
  chunkId: string;
  content: string;
  embedding: number[];
}

export interface DetectSupersessionInput {
  newContent: string;
  newEmbedding: number[];
  /** Candidate OLDER chunks to check against — caller is responsible for supplying
   *  a reasonable candidate set (e.g. via MemoryStore.recentChunksForSession); this
   *  function does no filtering of its own beyond what's described below. */
  candidates: SupersessionCandidate[];
  /** Cosine similarity threshold above which two chunks are considered "about the
   *  same specific thing." Default 0.84 — deliberately conservative (false negatives
   *  are far cheaper than false positives here: wrongly marking a still-valid parked
   *  idea as superseded actively hides it from later retrieval). */
  similarityThreshold?: number;
}

/** Revision-language patterns checked against newContent (case-insensitive). Exported
 *  so tests can enumerate them and so the plugin/future callers could extend the list
 *  without forking this file. Include common explicit-revision phrasings: "actually",
 *  "instead", "scrap that", "scratch that", "let's not", "changed my mind", "never mind",
 *  "on second thought", "forget what I said", "disregard that", "that's wrong", "I was wrong".
 *  Use word-boundary-aware regexes, not naive substring checks (e.g. "actually" should not
 *  match inside "factually"). */
export const REVISION_PATTERNS: RegExp[] = [
  /\bactually\b/i,
  /\binstead\b/i,
  /\bscrap that\b/i,
  /\bscratch that\b/i,
  /\blet's not\b/i,
  /\bchanged my mind\b/i,
  /\bnever mind\b/i,
  /\bon second thought\b/i,
  /\bforget what i said\b/i,
  /\bdisregard that\b/i,
  /\bthat's wrong\b/i,
  /\bi was wrong\b/i,
];

const DEFAULT_SIMILARITY_THRESHOLD = 0.84;

/** Returns the chunkId(s) that newContent/newEmbedding supersedes, or [] if none.
 *  A candidate is superseded iff: (a) newContent matches at least one REVISION_PATTERNS
 *  entry, AND (b) that candidate's embedding similarity to newEmbedding is >=
 *  similarityThreshold. Both conditions required — similarity alone is never enough
 *  (that would just be normal topical relevance, not revision), and revision language
 *  alone is never enough (it needs a specific thing in front of it to revise). A single
 *  new chunk CAN supersede multiple candidates if more than one clears both bars. */
export function detectSupersession(input: DetectSupersessionInput): string[] {
  const threshold = input.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  const hasRevisionLanguage = REVISION_PATTERNS.some((pattern) => pattern.test(input.newContent));
  if (!hasRevisionLanguage) {
    return [];
  }

  const superseded: string[] = [];
  for (const candidate of input.candidates) {
    const similarity = cosineSimilarity(input.newEmbedding, candidate.embedding);
    if (similarity >= threshold) {
      superseded.push(candidate.chunkId);
    }
  }
  return superseded;
}
