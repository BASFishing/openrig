import type { Migration } from "../migrate.js";

// Phase 5 V2 — debounce for the rate-limit-triggered handover trigger
// (routes/activity.ts's "provider_error" branch). One row per node: the last
// time a StopFailure/rate_limit hook event actually triggered a handover for
// it, so a seat producing several matching events in quick succession (e.g.
// before its successor has stabilized) doesn't get handed over repeatedly.
export const anthropicRateLimitHandoversSchema: Migration = {
  name: "096_anthropic_rate_limit_handovers.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS anthropic_rate_limit_handovers (
      node_id TEXT PRIMARY KEY,
      last_triggered_at TEXT NOT NULL
    );
  `,
};
