// opencode plugin: tool-based long-term memory for the local "ollama" seat.
//
// Lets the model recall earlier parts of its OWN conversation, after opencode's
// automatic context compaction has summarized older turns away, by explicitly
// calling the `recall_context` tool below. Retrieval is tool-based only — nothing
// here injects memory silently into the model's context.
//
// Verified against the ACTUAL installed @opencode-ai/plugin@1.18.22 type
// definitions (~/.config/opencode/node_modules/@opencode-ai/plugin/dist/*.d.ts and
// its @opencode-ai/sdk dependency's dist/gen/types.gen.d.ts) rather than guessed
// from opencode.ai's docs alone, since the docs have been incomplete/stale on exact
// payload shapes in the past. Also cross-checked against a real, in-production
// opencode plugin (cmux's opencode-plugin.js, `CMUXFeed`) that solves the exact same
// "attribute a text part to a role" problem the indexing trigger below needs to
// solve, via the same messageID -> role tracking map this file uses.
//
// Despite that research, opencode's actual runtime event payloads are not
// guaranteed to match either the installed types OR this file's assumptions (real
// crash reports exist from exactly this kind of mismatch). Every handler below is
// written so a wrong guess fails silently (skip/return) rather than throwing —
// matching this repo's own house style in
// packages/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs
// (firstString/parseJson helpers) and the "unknown = noise, never evidence"
// convention in packages/daemon/src/routes/activity.ts's evidenceFromHookActivity.

import { tool, type Plugin } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MemoryStore } from "./memory-store.js";
import type { MemoryChunk } from "./memory-store.js";
import { EmbeddingsClient } from "./embeddings.js";
import { detectSupersession } from "./supersession.js";

/** Prefix stamped on every recall_context tool result, so the indexing trigger
 *  below can recognize-and-skip this plugin's own tool output if it ever gets
 *  echoed back inside a visible assistant text part (the structural guard — tool
 *  output lands in a ToolPart, never a TextPart — already prevents the normal
 *  case; this is the belt-and-suspenders textual check for the abnormal one). */
export const RECALL_RESULT_MARKER = "[recall_context result — do not re-index]";

interface SeatMemoryConfig {
  privileged: boolean;
  seatId: string;
}

/** Reads <directory>/.openrig/ollama/memory-config.json. Absence, malformed JSON,
 *  or missing/mistyped fields are NOT errors — they just mean "unprivileged,
 *  unknown seat" (many seats won't have this file, per the access-control spec). */
function readSeatMemoryConfig(directory: unknown): SeatMemoryConfig {
  const fallback: SeatMemoryConfig = { privileged: false, seatId: "unknown" };
  if (typeof directory !== "string" || directory.trim().length === 0) {
    return fallback;
  }
  try {
    const raw = readFileSync(join(directory, ".openrig", "ollama", "memory-config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fallback;
    }
    const record = parsed as Record<string, unknown>;
    const privileged = typeof record.privileged === "boolean" ? record.privileged : false;
    const seatId =
      typeof record.seatId === "string" && record.seatId.trim().length > 0 ? record.seatId : "unknown";
    return { privileged, seatId };
  } catch {
    return fallback;
  }
}

/** Returns the first non-empty string among the candidates, else null. Mirrors
 *  activity-relay.cjs's firstString — real event payloads carry the same field
 *  under different names across opencode versions/builds, so every read of a
 *  "the field I actually want" value goes through this instead of one bare
 *  property access. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export const OpenRigMemory: Plugin = async ({ directory }) => {
  // ── one-time init (per the task spec: construct these once, reuse across all
  // hook/tool invocations — never reconstruct per-call) ──
  const memoryDir = join(directory, ".openrig", "ollama", "memory");
  try {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
  } catch {
    // Best-effort: MemoryStore.persist() also mkdir's lazily on its first write,
    // so a failure here (e.g. a race, or a permissions quirk) is not fatal.
  }

  const memoryStore = new MemoryStore({ filePath: join(memoryDir, "chunks.jsonl") });
  const embeddingsClient = new EmbeddingsClient();

  // In-flight embed-and-index work. The pre-compaction flush hook awaits exactly
  // these before letting opencode summarize-away the turns they're indexing, so
  // nothing in flight is lost to compaction.
  const pendingEmbedPromises = new Set<Promise<void>>();

  // message.part.updated carries no role — only message.updated's `info.role`
  // does, keyed by message id. Bounded like the equivalent map in cmux's own
  // opencode plugin, since a long session must not grow this unboundedly.
  const messageRoles = new Map<string, { sessionId: string; role: string }>();
  const MAX_TRACKED_MESSAGES = 500;

  // Fallback completion signal (see the `event` hook below for why): the latest
  // known text for a message whose owning text part's own time.end has not (yet,
  // or ever) been observed set. Flushed when message.updated reports that
  // message as done.
  const lastTextByMessageId = new Map<string, { sessionId: string; partId: string; text: string }>();
  const MAX_TRACKED_TEXT = 500;

  // Guards against indexing the same part twice (e.g. if both the primary
  // time.end-gated path and the message.updated fallback path below ever fire
  // for the same part — defensive, not expected in the common case).
  const indexedPartIds = new Set<string>();
  const MAX_INDEXED_PART_IDS = 2000;

  function rememberMessageRole(messageId: string, sessionId: string, role: string): void {
    messageRoles.set(messageId, { sessionId, role });
    if (messageRoles.size > MAX_TRACKED_MESSAGES) {
      const oldestKey = messageRoles.keys().next().value;
      if (oldestKey !== undefined) messageRoles.delete(oldestKey);
    }
  }

  function rememberLatestText(messageId: string, sessionId: string, partId: string, text: string): void {
    lastTextByMessageId.set(messageId, { sessionId, partId, text });
    if (lastTextByMessageId.size > MAX_TRACKED_TEXT) {
      const oldestKey = lastTextByMessageId.keys().next().value;
      if (oldestKey !== undefined) lastTextByMessageId.delete(oldestKey);
    }
  }

  function markPartIndexed(partId: string): void {
    indexedPartIds.add(partId);
    if (indexedPartIds.size > MAX_INDEXED_PART_IDS) {
      const oldest = indexedPartIds.values().next().value;
      if (oldest !== undefined) indexedPartIds.delete(oldest);
    }
  }

  /** Embeds `text`, runs supersession detection against this session's recent
   *  chunks, and appends the new chunk — the full async body of "index one
   *  complete piece of conversation text." Never throws: every failure mode
   *  (embeddings unreachable, store I/O) is swallowed, since this always runs
   *  fire-and-forget off the `event` hook and must never crash opencode. */
  async function indexText(sessionId: string, text: string): Promise<void> {
    // Belt-and-suspenders guard against re-indexing this plugin's own tool
    // output — see RECALL_RESULT_MARKER's doc comment.
    if (text.startsWith(RECALL_RESULT_MARKER)) {
      return;
    }

    let embedding: number[];
    try {
      embedding = await embeddingsClient.embed(text);
    } catch {
      return;
    }

    try {
      const config = readSeatMemoryConfig(directory);

      const candidates = memoryStore
        .recentChunksForSession({ sessionId, limit: 20 })
        .map((chunk: MemoryChunk) => ({ chunkId: chunk.id, content: chunk.content, embedding: chunk.embedding }));

      const supersededIds = detectSupersession({
        newContent: text,
        newEmbedding: embedding,
        candidates,
      });

      const tags = [`session:${sessionId}`];
      if (config.privileged) {
        tags.push("shared");
      }

      const newChunk = memoryStore.appendChunk({
        sessionId,
        seatId: config.seatId,
        tags,
        content: text,
        embedding,
        supersededBy: null,
      } as Parameters<MemoryStore["appendChunk"]>[0]);

      for (const oldId of supersededIds) {
        try {
          memoryStore.markSuperseded(oldId, newChunk.id);
        } catch {
          // best-effort
        }
      }
    } catch {
      // Store I/O failure — never let indexing crash opencode.
    }
  }

  /** Fire-and-forget indexText, tracked in pendingEmbedPromises so the
   *  compaction-flush hook can await it. */
  function enqueueIndex(sessionId: string, text: string): void {
    const promise = indexText(sessionId, text).catch(() => {});
    pendingEmbedPromises.add(promise);
    void promise.finally(() => {
      pendingEmbedPromises.delete(promise);
    });
  }

  return {
    event: async ({ event }) => {
      try {
        const type = (event as { type?: unknown } | null | undefined)?.type;
        const props = asRecord((event as { properties?: unknown } | null | undefined)?.properties) ?? {};

        // ── message.updated: properties.info is a Message (UserMessage |
        // AssistantMessage) — carries role + id + sessionID, but NEVER text
        // (text lives only in parts, keyed by messageID). Verified against
        // @opencode-ai/sdk's EventMessageUpdated / UserMessage / AssistantMessage
        // types. Confidence: HIGH (matches installed SDK types exactly, and
        // matches cmux's own production plugin's handling of this event). ──
        if (type === "message.updated") {
          const info = asRecord(props.info);
          const messageId = firstString(info?.id);
          const sessionId = firstString(info?.sessionID);
          const role = firstString(info?.role);
          if (messageId && sessionId && role) {
            rememberMessageRole(messageId, sessionId, role);

            // Fallback completion flush. WHY this exists: a user-submitted
            // message's text part may never get a `time.end` at all (no
            // streaming concept for typed-and-submitted input — TextPart.time
            // is fully optional in the SDK type), so the primary time.end-gated
            // path in message.part.updated below may NEVER fire for user turns.
            // This path treats "role is user" (always immediately complete) or
            // "role is assistant AND info.time.completed is set" as an
            // independent completion signal, and flushes whatever text we've
            // seen so far for that messageId if the primary path hasn't already
            // consumed it. Confidence: MEDIUM — info.time.completed's exact
            // presence/timing relative to the last message.part.updated for
            // that message is NOT independently verified against a live
            // opencode server, only against the installed TS type (which marks
            // it optional: `time: { created: number; completed?: number }`).
            const time = asRecord(info?.time);
            const isUserComplete = role === "user";
            const isAssistantComplete = role === "assistant" && typeof time?.completed === "number";
            if (isUserComplete || isAssistantComplete) {
              const pending = lastTextByMessageId.get(messageId);
              if (pending && !indexedPartIds.has(pending.partId)) {
                markPartIndexed(pending.partId);
                lastTextByMessageId.delete(messageId);
                enqueueIndex(pending.sessionId, pending.text);
              }
            }
          }
          return;
        }

        // ── message.part.updated: properties.part is a Part; properties.delta
        // is an optional streaming-chunk hint. Verified against
        // EventMessagePartUpdated / TextPart types. Confidence: HIGH on the
        // shape itself (matches installed SDK types AND cmux's production
        // plugin); MEDIUM on part.time.end reliably marking "this is the full,
        // finished text, not a streaming delta" — TextPart.text is documented
        // as the FULL accumulated text at every update (not delta-only), and
        // TextPart.time.end is documented as only set once streaming for that
        // part has stopped, but no live opencode server was available to this
        // agent to confirm end is actually populated before the LAST
        // message.part.updated for a given part is emitted. Flagged for
        // empirical verification. ──
        if (type !== "message.part.updated") {
          return;
        }

        const part = asRecord(props.part);
        if (!part || part.type !== "text") {
          return;
        }

        const partId = firstString(part.id);
        const messageId = firstString(part.messageID);
        const sessionId = firstString(part.sessionID);
        if (!partId || !messageId || !sessionId) {
          return;
        }

        const text = firstString(part.text, part.content);
        if (!text) {
          return;
        }

        // Always remember the latest full text for this message, regardless of
        // completion state — this feeds the message.updated fallback above.
        rememberLatestText(messageId, sessionId, partId, text);

        const time = asRecord(part.time);
        const isFinalized = typeof time?.end === "number";
        if (!isFinalized) {
          return;
        }
        if (indexedPartIds.has(partId)) {
          return;
        }

        markPartIndexed(partId);
        lastTextByMessageId.delete(messageId);
        enqueueIndex(sessionId, text);
      } catch {
        // Never let a malformed/unexpected event payload crash opencode's event loop.
      }
    },

    // Verified exactly against the installed @opencode-ai/plugin 1.18.22 type:
    //   "experimental.session.compacting"?: (input: { sessionID: string },
    //     output: { context: string[]; prompt?: string }) => Promise<void>
    // We don't touch `output` — our only job is to make sure nothing still
    // in-flight gets lost to compaction before it's durably indexed.
    "experimental.session.compacting": async (_input, _output) => {
      try {
        const inFlight = Array.from(pendingEmbedPromises);
        // Remove exactly what we're about to await (not a wholesale `.clear()`)
        // so a promise enqueued *during* this await — from an event the model's
        // still-finishing turn fires concurrently — stays tracked for a later
        // compaction instead of being silently dropped from the set.
        for (const promise of inFlight) {
          pendingEmbedPromises.delete(promise);
        }
        await Promise.allSettled(inFlight);
      } catch {
        // Promise.allSettled never rejects; this is pure defensive belt-and-suspenders.
      }
    },

    tool: {
      recall_context: tool({
        description:
          "Recall earlier parts of THIS conversation — or, if this seat is privileged, other " +
          "seats' shared conversation history too — that may have been summarized away by " +
          "automatic context compaction. Use this when you need a specific detail, decision, or " +
          "earlier instruction that is no longer visible in your current context window.",
        args: {
          query: tool.schema.string().describe("Natural-language description of what to recall."),
          includeSuperseded: tool.schema
            .boolean()
            .optional()
            .describe("Include chunks that were later revised/superseded in the conversation. Default false."),
          limit: tool.schema.number().optional().describe("Maximum number of chunks to return. Default 5."),
        },
        async execute(args, context) {
          try {
            const sessionID = typeof context.sessionID === "string" ? context.sessionID.trim() : "";
            if (!sessionID) {
              return `${RECALL_RESULT_MARKER}\nNo active session — unable to recall.`;
            }
            const dir = typeof context.directory === "string" && context.directory.length > 0
              ? context.directory
              : directory;

            // Read for completeness/parity with the access-control spec (missing
            // file => unprivileged/unknown, never an error). Read access to the
            // shared partition below does not depend on this seat's own
            // privileged flag — every seat may READ "shared"; only a privileged
            // seat's own conversation WRITES into it (see indexText above).
            readSeatMemoryConfig(dir);

            const query = typeof args.query === "string" ? args.query : "";
            if (!query.trim()) {
              return `${RECALL_RESULT_MARKER}\nNo query given — unable to recall.`;
            }

            let queryEmbedding: number[];
            try {
              queryEmbedding = await embeddingsClient.embed(query);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return `${RECALL_RESULT_MARKER}\nMemory recall failed: could not reach the embeddings model (${message}).`;
            }

            const includeSuperseded = args.includeSuperseded === true;
            const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 5;
            const allowedTags = [`session:${sessionID}`, "shared"];

            let results: Array<MemoryChunk & { score: number }>;
            try {
              results = memoryStore.queryBySimilarity(queryEmbedding, {
                allowedTags,
                excludeSuperseded: !includeSuperseded,
                limit,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return `${RECALL_RESULT_MARKER}\nMemory recall failed: could not read memory store (${message}).`;
            }

            if (results.length === 0) {
              return `${RECALL_RESULT_MARKER}\nNo matching earlier context found for: "${query}"`;
            }

            const lines = [RECALL_RESULT_MARKER, `Recalled ${results.length} earlier item(s) for: "${query}"`, ""];
            for (const chunk of results) {
              lines.push(`--- from earlier in this session, turn ${chunk.turnIndex} (similarity ${chunk.score.toFixed(2)}) ---`);
              lines.push(chunk.content);
              if (includeSuperseded && chunk.supersededBy) {
                lines.push("(note: this may have been revised later in the conversation)");
              }
              lines.push("");
            }
            return lines.join("\n").trimEnd();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `${RECALL_RESULT_MARKER}\nMemory recall failed unexpectedly: ${message}`;
          }
        },
      }),
    },
  };
};
