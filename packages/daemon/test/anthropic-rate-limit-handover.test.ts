// Phase 5 V2 — the StopFailure/rate_limit hook's handover trigger
// (routes/activity.ts's "provider_error" branch). Real app, real DB
// (ALL_MIGRATIONS — the router + debounce tables are core-fixture
// exclusions), a real AnthropicKeyRouter, and a real tmux fake so the
// triggered handover actually runs end-to-end.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AnthropicKeyRouter, type AnthropicKeyCandidate } from "../src/domain/anthropic-key-router.js";

function memFs() {
  const files: Record<string, string> = {};
  return { writeFile: (p: string, c: string) => { files[p] = c; }, mkdirp: () => {} };
}

function seedFiveHourSample(db: Database.Database, usedPercent: number, resetsAt: string | null, capturedAt: string) {
  db.prepare(`INSERT INTO usage_samples (lane, seat_session, window, window_used_percent, resets_at, captured_at)
    VALUES ('provider_window', 'dev-claude@failover', 'five_hour', ?, ?, ?)`).run(usedPercent, resetsAt, capturedAt);
}

/** `candidates: undefined` means "do not construct a router at all" (the
 *  undefined-feature case); an empty/short list still builds one (the
 *  isActive:false case) since those are meaningfully different scenarios. */
function setup(candidates: AnthropicKeyCandidate[] | undefined) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("failover");
  const node = rigRepo.addNode(rig.id, "dev.claude", { runtime: "claude-code" });
  const sessionRegistry = new SessionRegistry(db);
  const sess = sessionRegistry.registerSession(node.id, "dev-claude@failover");
  sessionRegistry.updateStatus(sess.id, "running");

  const router = candidates
    ? new AnthropicKeyRouter({ db, candidates, secretFilePath: "/tmp/anthropic-key-router-test/current", fsOps: memFs() })
    : undefined;

  // Mirrors seat-handover-service.test.ts's fixture for a successful FRESH
  // same-pane cutover — this test's job is to prove routes/activity.ts
  // correctly gates and invokes SeatHandoverService, not to re-prove the
  // handover executor's own pane mechanics (seat-handover-service.test.ts
  // already covers that in depth).
  const tmux = {
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true })),
    listPanes: vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]),
    killSession: vi.fn(async () => ({ ok: true })),
    respawnPane: vi.fn(async () => ({ ok: true })),
    setRemainOnExit: vi.fn(async () => ({ ok: true })),
    signalPaneProcess: vi.fn(async () => ({ ok: true })),
    isPaneDead: vi.fn(async () => true),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    capturePaneScreen: vi.fn(async () => "predecessor screen tail"),
    capturePaneContent: vi.fn(async () => ""),
    getDefaultShell: vi.fn(async () => "/bin/zsh"),
    getPaneCommand: vi.fn(async () => "zsh"),
  };

  const claudeCodeAdapter = {
    launchHarness: vi.fn(async () => ({ ok: true, resumeToken: "claude-launch-tok", resumeType: "claude_id" })),
    checkReady: vi.fn(async () => ({ ready: true })),
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
  };

  const { app } = createTestApp(db, {
    activityHookToken: "tok",
    tmux: tmux as never,
    adapters: { "claude-code": claudeCodeAdapter as never },
    appDeps: { anthropicKeyRouter: router },
  });

  return { db, app, node, rig };
}

async function postProviderError(app: { request: (path: string, init: RequestInit) => Promise<Response> }, overrides: Record<string, unknown> = {}) {
  const res = await app.request("/api/activity/hooks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-openrig-activity-token": "tok" },
    body: JSON.stringify({
      eventFamily: "provider_error",
      sessionName: "dev-claude@failover",
      runtime: "claude-code",
      hookEvent: "StopFailure",
      errorType: "rate_limit",
      ...overrides,
    }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const TWO_CANDIDATES: AnthropicKeyCandidate[] = [{ name: "A", value: "sk-a" }, { name: "B", value: "sk-b" }];

describe("provider_error (StopFailure/rate_limit) activity hook branch", () => {
  const open: Database.Database[] = [];
  afterEach(() => { for (const db of open.splice(0)) db.close(); });

  it("triggers a handover when the router is active AND the five-hour window is already corroborated exhausted", async () => {
    const { db, app, node } = setup(TWO_CANDIDATES);
    open.push(db);
    seedFiveHourSample(db, 100, "2099-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z");

    const { status, body } = await postProviderError(app);
    expect(status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true, acted: true, handover: "triggered" });

    const debounceRow = db.prepare("SELECT node_id FROM anthropic_rate_limit_handovers WHERE node_id = ?").get(node.id);
    expect(debounceRow).toBeTruthy();
  });

  it("does NOT trigger when the router is undefined (feature not configured)", async () => {
    const { db, app } = setup(undefined);
    open.push(db);
    const { status, body } = await postProviderError(app);
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, acted: false });
  });

  it("does NOT trigger when the router is active but has fewer than 2 resolved candidates", async () => {
    const { db, app } = setup([{ name: "A", value: "sk-a" }]); // only 1 — isActive is false
    open.push(db);
    seedFiveHourSample(db, 100, "2099-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z");

    const { body } = await postProviderError(app);
    expect(body).toEqual({ ok: true, acted: false });
  });

  it("does NOT trigger for a non-rate_limit error type (e.g. billing_error)", async () => {
    const { db, app } = setup(TWO_CANDIDATES);
    open.push(db);
    seedFiveHourSample(db, 100, "2099-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z");

    const { body } = await postProviderError(app, { errorType: "billing_error" });
    expect(body).toMatchObject({ ok: true, acted: false });
  });

  it("does NOT trigger when the usage signal does not corroborate exhaustion (transient-blip guard)", async () => {
    const { db, app } = setup(TWO_CANDIDATES);
    open.push(db);
    seedFiveHourSample(db, 10, null, "2026-01-01T00:30:00.000Z"); // nowhere near exhausted

    const { body } = await postProviderError(app);
    expect(body).toMatchObject({ ok: true, acted: false, reason: "not_corroborated_by_usage_signal" });
  });

  it("debounces a second trigger within the cooldown window", async () => {
    const { db, app } = setup(TWO_CANDIDATES);
    open.push(db);
    seedFiveHourSample(db, 100, "2099-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z");

    const first = await postProviderError(app);
    expect(first.body).toMatchObject({ acted: true });

    const second = await postProviderError(app);
    expect(second.body).toMatchObject({ ok: true, acted: false, reason: "debounced" });
  });

  it("does NOT trigger when the seat cannot be resolved", async () => {
    const { db, app } = setup(TWO_CANDIDATES);
    open.push(db);
    seedFiveHourSample(db, 100, "2099-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z");

    const { body } = await postProviderError(app, { sessionName: "no-such-session@failover" });
    expect(body).toMatchObject({ ok: true, acted: false, reason: "session_not_found" });
  });
});
