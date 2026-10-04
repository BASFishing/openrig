import type { Migration } from "../migrate.js";

// Phase 5 — the Anthropic API-key failover router's persisted state.
// Single-row table (id fixed to 'singleton'): which candidate is currently
// active, and the captured_at of the usage sample that justified the LAST
// switch — so a still-stale reading from the key we just switched AWAY from
// can't trigger a second switch before any fresh sample exists for the new
// one (see anthropic-key-router.ts).
export const anthropicKeyRouterStateSchema: Migration = {
  name: "095_anthropic_key_router_state.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS anthropic_key_router_state (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'),
      active_candidate_name TEXT NOT NULL,
      last_switch_sample_captured_at TEXT,
      updated_at TEXT NOT NULL
    );
  `,
};
