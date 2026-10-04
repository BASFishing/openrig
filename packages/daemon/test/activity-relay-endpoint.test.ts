// OPR.0.4.3.28 B1+B3 — the relay resolves the ingest URL + token without the
// operator seeding OPENRIG_URL/OPENRIG_ACTIVITY_HOOK_TOKEN into the shell.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  resolveEndpoint: (env: Record<string, string | undefined>) => { baseUrl?: string; token?: string };
  buildOpenRigPayload: (
    providerPayload: Record<string, unknown>,
    env: Record<string, string | undefined>,
    now?: () => Date,
  ) => Record<string, unknown> | null;
  buildProviderErrorPayload: (
    providerPayload: Record<string, unknown>,
    env: Record<string, string | undefined>,
    now?: () => Date,
  ) => Record<string, unknown> | null;
};

describe("activity-relay resolveEndpoint (OPR.0.4.3.28 B1+B3)", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-relay-")); });
  afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("fast path: env OPENRIG_URL + token are used verbatim", () => {
    const r = relay.resolveEndpoint({ OPENRIG_URL: "http://d:9999", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r).toEqual({ baseUrl: "http://d:9999", token: "tok" });
  });

  it("B1: synthesizes the base URL from OPENRIG_HOST + OPENRIG_PORT when URL is absent", () => {
    const r = relay.resolveEndpoint({ OPENRIG_HOST: "10.0.0.5", OPENRIG_PORT: "7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://10.0.0.5:7433");
    expect(r.token).toBe("tok");
  });

  it("B1: defaults host to 127.0.0.1 when only PORT is present", () => {
    const r = relay.resolveEndpoint({ OPENRIG_PORT: "7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://127.0.0.1:7433");
  });

  it("B3: file-discovery supplies url+token for a reconcile/restored seat (no env vars)", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:7433", token: "filetok" }));
    // Frozen env has only OPENRIG_HOME (inherited), no url/token.
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home });
    expect(r.baseUrl).toBe("http://127.0.0.1:7433");
    expect(r.token).toBe("filetok");
  });

  it("B3: file-discovery fills only the MISSING piece (env token wins, file supplies url)", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://file:1", token: "filetok" }));
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home, OPENRIG_ACTIVITY_HOOK_TOKEN: "envtok" });
    expect(r.token).toBe("envtok"); // env token not overwritten
    expect(r.baseUrl).toBe("http://file:1");
  });

  it("safe no-op: nothing in env and no discoverable file → undefined url/token", () => {
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home }); // home has no endpoint.json
    expect(r.baseUrl).toBeFalsy();
    expect(r.token).toBeFalsy();
  });
});

describe("activity-relay occupant generation carry (W2a producer)", () => {
  const identity = {
    OPENRIG_SESSION_NAME: "dev-qa@producer-rig",
    OPENRIG_NODE_ID: "node-1",
    OPENRIG_RUNTIME: "codex",
  };

  it("carries the exact launch generation", () => {
    const payload = relay.buildOpenRigPayload(
      { hookEvent: "Stop" },
      { ...identity, OPENRIG_OCCUPANT_GENERATION: "generation-A" },
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toMatchObject({ generation: "generation-A" });
  });

  it("emits explicit null when the launch generation is absent", () => {
    const payload = relay.buildOpenRigPayload(
      { hookEvent: "Stop" },
      identity,
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toHaveProperty("generation", null);
  });
});

describe("activity-relay buildProviderErrorPayload (Phase 5 — rate-limit hook)", () => {
  const identity = {
    OPENRIG_SESSION_NAME: "dev-claude@failover-rig",
    OPENRIG_NODE_ID: "node-1",
    OPENRIG_RUNTIME: "claude-code",
  };

  it("builds a provider_error payload from a StopFailure/rate_limit event", () => {
    const payload = relay.buildProviderErrorPayload(
      { hookEvent: "StopFailure", matcher: "rate_limit" },
      identity,
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toEqual({
      eventFamily: "provider_error",
      sessionName: "dev-claude@failover-rig",
      nodeId: "node-1",
      runtime: "claude-code",
      hookEvent: "StopFailure",
      errorType: "rate_limit",
      occurredAt: "2026-08-09T00:00:00.000Z",
    });
  });

  it("carries a non-rate_limit error type through unchanged (the daemon decides relevance)", () => {
    const payload = relay.buildProviderErrorPayload({ hookEvent: "StopFailure", matcher: "billing_error" }, identity);
    expect(payload).toMatchObject({ errorType: "billing_error" });
  });

  it("returns null for any event other than StopFailure", () => {
    expect(relay.buildProviderErrorPayload({ hookEvent: "Stop", matcher: "rate_limit" }, identity)).toBeNull();
  });

  it("returns null when the matcher/error type is missing", () => {
    expect(relay.buildProviderErrorPayload({ hookEvent: "StopFailure" }, identity)).toBeNull();
  });

  it("returns null when neither session name nor node id is present", () => {
    expect(relay.buildProviderErrorPayload(
      { hookEvent: "StopFailure", matcher: "rate_limit" },
      { OPENRIG_RUNTIME: "claude-code" },
    )).toBeNull();
  });

  it("returns null without a provider payload", () => {
    expect(relay.buildProviderErrorPayload(null as never, identity)).toBeNull();
  });
});
