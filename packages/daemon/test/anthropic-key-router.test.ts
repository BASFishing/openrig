// Phase 5 — the Anthropic key failover router. Hermetic: real in-memory
// SQLite with just the two tables it touches (anthropic_key_router_state,
// usage_samples), an in-memory fsOps fake (no real filesystem writes).
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { AnthropicKeyRouter, type AnthropicKeyCandidate } from "../src/domain/anthropic-key-router.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function memFs() {
  const files: Record<string, string> = {};
  return { files, writeFile: (p: string, c: string) => { files[p] = c; }, mkdirp: () => {} };
}

function fixture(opts: {
  candidates?: AnthropicKeyCandidate[];
  thresholdPercent?: number;
  now?: Date;
} = {}) {
  const db = new Database(":memory:"); open.push(db);
  db.exec(`
    CREATE TABLE anthropic_key_router_state (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'),
      active_candidate_name TEXT NOT NULL,
      last_switch_sample_captured_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT, seat_session TEXT, window TEXT,
      window_used_percent REAL, resets_at TEXT, captured_at TEXT
    );
  `);
  const fs = memFs();
  const candidates = opts.candidates ?? [
    { name: "ANTHROPIC_API_KEY_PRIMARY", value: "sk-primary" },
    { name: "ANTHROPIC_API_KEY_SECONDARY", value: "sk-secondary" },
  ];
  const router = new AnthropicKeyRouter({
    db, candidates, secretFilePath: "/state/anthropic-key-router/current", fsOps: fs,
    exhaustionThresholdPercent: opts.thresholdPercent, now: opts.now ? () => opts.now! : undefined,
  });
  function insertSample(windowUsedPercent: number | null, resetsAt: string | null, capturedAt: string) {
    db.prepare(`INSERT INTO usage_samples (lane, seat_session, window, window_used_percent, resets_at, captured_at)
      VALUES ('provider_window', 'seat-1', 'five_hour', ?, ?, ?)`).run(windowUsedPercent, resetsAt, capturedAt);
  }
  return { router, fs, db, insertSample };
}

describe("AnthropicKeyRouter.isActive", () => {
  it("is inactive with fewer than 2 candidates", () => {
    const { router } = fixture({ candidates: [{ name: "ANTHROPIC_API_KEY", value: "sk-only" }] });
    expect(router.isActive).toBe(false);
    expect(router.currentValueFilePath()).toBeNull();
  });

  it("is active with 2+ candidates", () => {
    const { router } = fixture();
    expect(router.isActive).toBe(true);
  });
});

describe("AnthropicKeyRouter.currentValueFilePath", () => {
  it("on first call with no prior state, writes the first candidate's value and persists it as active", () => {
    const { router, fs } = fixture();
    const path = router.currentValueFilePath();
    expect(path).toBe("/state/anthropic-key-router/current");
    expect(fs.files[path!]).toBe("sk-primary");
  });

  it("stays on the active candidate when no usage sample exists yet (honest-unknown, not exhausted)", () => {
    const { router, fs } = fixture();
    router.currentValueFilePath();
    const path = router.currentValueFilePath();
    expect(fs.files[path!]).toBe("sk-primary");
  });

  it("stays on the active candidate when the latest sample is below the exhaustion threshold", () => {
    const { router, fs, insertSample } = fixture();
    insertSample(80, null, "2026-01-01T00:00:00.000Z");
    const path = router.currentValueFilePath();
    expect(fs.files[path!]).toBe("sk-primary");
  });

  it("switches to the next candidate when the latest sample reports the window fully exhausted", () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const { router, fs, insertSample } = fixture({ now });
    insertSample(100, "2026-01-01T05:00:00.000Z", "2026-01-01T00:30:00.000Z"); // future reset, exhausted
    const path = router.currentValueFilePath();
    expect(fs.files[path!]).toBe("sk-secondary");
  });

  it("does not switch when the window has already reset (resetsAt in the past)", () => {
    const now = new Date("2026-01-01T06:00:00.000Z");
    const { router, fs, insertSample } = fixture({ now });
    insertSample(100, "2026-01-01T05:00:00.000Z", "2026-01-01T00:30:00.000Z"); // reset already passed
    const path = router.currentValueFilePath();
    expect(fs.files[path!]).toBe("sk-primary");
  });

  it("wraps around to the first candidate after the last one is exhausted", () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const { router, fs, insertSample, db } = fixture({ now });
    insertSample(100, "2026-01-01T05:00:00.000Z", "2026-01-01T00:30:00.000Z");
    router.currentValueFilePath(); // switches primary -> secondary
    expect(fs.files["/state/anthropic-key-router/current"]).toBe("sk-secondary");
    insertSample(100, "2026-01-01T05:00:00.000Z", "2026-01-01T00:45:00.000Z"); // newer, still exhausted
    router.currentValueFilePath(); // switches secondary -> wraps to primary
    expect(fs.files["/state/anthropic-key-router/current"]).toBe("sk-primary");
    const state = db.prepare("SELECT active_candidate_name FROM anthropic_key_router_state WHERE id='singleton'").get() as { active_candidate_name: string };
    expect(state.active_candidate_name).toBe("ANTHROPIC_API_KEY_PRIMARY");
  });

  it("thrash guard: does not switch again on a repeated call with the SAME stale exhausted sample", () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const { router, fs, insertSample } = fixture({ now });
    insertSample(100, "2026-01-01T05:00:00.000Z", "2026-01-01T00:30:00.000Z");
    router.currentValueFilePath(); // switches primary -> secondary
    expect(fs.files["/state/anthropic-key-router/current"]).toBe("sk-secondary");
    router.currentValueFilePath(); // same stale sample again — must NOT advance further
    expect(fs.files["/state/anthropic-key-router/current"]).toBe("sk-secondary");
  });

  it("respects a custom exhaustion threshold", () => {
    const now = new Date("2026-01-01T01:00:00.000Z");
    const { router, fs, insertSample } = fixture({ now, thresholdPercent: 90 });
    insertSample(92, "2026-01-01T05:00:00.000Z", "2026-01-01T00:30:00.000Z");
    const path = router.currentValueFilePath();
    expect(fs.files[path!]).toBe("sk-secondary");
  });

  it("treats a null window_used_percent as honest-unknown, never exhausted", () => {
    const { router, fs, insertSample } = fixture();
    insertSample(null, null, "2026-01-01T00:30:00.000Z");
    const path = router.currentValueFilePath();
    expect(fs.files[path!]).toBe("sk-primary");
  });
});
