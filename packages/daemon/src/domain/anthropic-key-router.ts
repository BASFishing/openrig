// Phase 5 — the Anthropic API-key failover router. Replaces the earlier
// per-seat apiKeyEnv design (dropped): instead of distinct accounts running
// simultaneously on different seats, ALL managed Claude seats share ONE
// active key, and the router switches which candidate is active when the
// current one's rate-limit window is exhausted.
//
// Security posture (unchanged from upstream): this NEVER bypasses the
// operator's recovery.provider_auth_env_allowlist consent gate — the caller
// (startup.ts) only constructs a live router when "ANTHROPIC_API_KEY" is
// already allowlisted. This module is purely "which value backs that
// already-consented-to name right now," never a new consent path.
//
// How the active value actually reaches a launch: ClaudeManagedLaunch reads
// currentValueFilePath() and has the LAUNCHED SHELL read the file via
// `$(cat <path>)` at launch time, rather than embedding the literal value in
// the command text or relying on the pane's own (possibly stale, fixed at
// session-creation) ambient environment. The pane's scrollback shows only
// the file path, never the key — and critically, this is re-read fresh on
// EVERY launch (fresh/resume/handover), so it's correct even for a pane
// whose shell has been running since before the last switch — unlike the
// upstream ${KEY-} ambient-env forwarding, which can't change for an
// already-running pane's shell at all.
//
// Exhaustion detection deliberately rides the EXISTING five_hour provider-
// window signal (usage_samples, lane='provider_window') rather than
// inventing new rate-limit detection — see claude-usage-reader.ts /
// provider-signals.ts for where that signal originates. One approximation,
// stated plainly: usage_samples carries no per-KEY identity (Option-A bar —
// no account identity in the schema), so "exhausted" means "the most recent
// five_hour reading from ANY seat, which was produced by whichever key was
// active at the time" — switching keys doesn't retroactively reclassify old
// readings; new readings naturally reflect whichever key is active once a
// seat's statusline reports again.

import type { Database } from "better-sqlite3";

export interface AnthropicKeyCandidate {
  /** The daemon-env var NAME this candidate's value was read from (for
   *  logging/diagnostics only — never persisted or forwarded under this
   *  name; the launched process always sees it as ANTHROPIC_API_KEY). */
  name: string;
  value: string;
}

export interface AnthropicKeyRouterFsOps {
  writeFile(path: string, content: string, mode?: number): void;
  mkdirp(path: string): void;
}

export interface AnthropicKeyRouterDeps {
  db: Database;
  /** Resolved once at daemon boot from the operator's candidate-name list
   *  (recovery.anthropic_key_candidates), in priority order. Fewer than 2
   *  means nothing to route — the router is then fully inert. */
  candidates: AnthropicKeyCandidate[];
  /** Mode-600 runtime file the router writes the active value to. */
  secretFilePath: string;
  fsOps: AnthropicKeyRouterFsOps;
  /** window_used_percent at/above this is "exhausted". Default 100 — only
   *  switch once Anthropic's own signal reports the window as fully used,
   *  not on an early-warning buffer (that's a product decision an operator
   *  could later expose as a setting; not needed for v1). */
  exhaustionThresholdPercent?: number;
  now?: () => Date;
}

interface LatestFiveHourRow {
  window_used_percent: number | null;
  resets_at: string | null;
  captured_at: string;
}

/** The latest five_hour provider-window sample across every seat, or null if
 *  none exists yet. Shared by the router's own switch decision AND the
 *  rate-limit-hook handover trigger (routes/activity.ts) — ONE query, so the
 *  "is the window actually exhausted" judgment never drifts between the two
 *  call sites. */
export function latestFiveHourSample(db: Database): LatestFiveHourRow | null {
  return (db
    .prepare(
      `SELECT window_used_percent, resets_at, captured_at FROM usage_samples
       WHERE lane = 'provider_window' AND window = 'five_hour'
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
    )
    .get() as LatestFiveHourRow | undefined) ?? null;
}

/** True iff the latest five_hour reading reports the window at/above
 *  `thresholdPercent` AND the reset time (if known) hasn't passed yet. A
 *  null percentage is honest-unknown, never exhausted (never fabricate). */
export function isFiveHourWindowExhausted(db: Database, thresholdPercent: number, now: () => Date = () => new Date()): boolean {
  const latest = latestFiveHourSample(db);
  return latest !== null
    && latest.window_used_percent !== null
    && latest.window_used_percent >= thresholdPercent
    && (latest.resets_at === null || new Date(latest.resets_at) > now());
}

interface RouterStateRow {
  active_candidate_name: string;
  last_switch_sample_captured_at: string | null;
}

export class AnthropicKeyRouter {
  private db: Database;
  private candidates: AnthropicKeyCandidate[];
  private secretFilePath: string;
  private fsOps: AnthropicKeyRouterFsOps;
  private exhaustionThresholdPercent: number;
  private now: () => Date;

  constructor(deps: AnthropicKeyRouterDeps) {
    this.db = deps.db;
    this.candidates = deps.candidates;
    this.secretFilePath = deps.secretFilePath;
    this.fsOps = deps.fsOps;
    this.exhaustionThresholdPercent = deps.exhaustionThresholdPercent ?? 100;
    this.now = deps.now ?? (() => new Date());
  }

  /** Fewer than 2 candidates means there's nothing to route between — callers
   *  (startup.ts) should not even construct a router in that case, but this
   *  stays safe either way. */
  get isActive(): boolean {
    return this.candidates.length >= 2;
  }

  /** V2 — the corroboration half of the rate-limit-hook handover trigger
   *  (routes/activity.ts): true iff the five-hour window is ALREADY reported
   *  exhausted by our own existing signal, using this router's own configured
   *  threshold. A StopFailure/rate_limit hook event alone can't tell a
   *  transient overload apart from real usage-limit exhaustion — this is the
   *  second signal that does. */
  isWindowExhausted(): boolean {
    return isFiveHourWindowExhausted(this.db, this.exhaustionThresholdPercent, this.now);
  }

  /** Call before every managed Claude launch. Re-evaluates exhaustion against
   *  the latest five_hour sample, advances + persists + rewrites the secret
   *  file if warranted, and returns the file path to substitute via
   *  `$(cat <path>)`. Returns null when inactive (ClaudeManagedLaunch then
   *  falls back to upstream's existing ${KEY-} behavior, unchanged). */
  currentValueFilePath(): string | null {
    if (!this.isActive) return null;

    const state = this.readState();
    const active = this.resolveActive(state);
    const latest = latestFiveHourSample(this.db);
    const isExhausted = isFiveHourWindowExhausted(this.db, this.exhaustionThresholdPercent, this.now);

    // Thrash guard: only switch again once a STRICTLY NEWER sample than the
    // one that justified the last switch exists — otherwise the same stale
    // "exhausted" reading (produced by the key we just switched AWAY from)
    // would cycle through every candidate on every single launch.
    const isFreshEvidence = latest !== null
      && (state === null || state.last_switch_sample_captured_at === null
        || latest.captured_at > state.last_switch_sample_captured_at);

    let activeCandidate = active;
    if (isExhausted && isFreshEvidence) {
      const currentIndex = this.candidates.findIndex((c) => c.name === active.name);
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % this.candidates.length;
      activeCandidate = this.candidates[nextIndex]!;
      this.writeState(activeCandidate.name, latest!.captured_at);
    } else if (state === null) {
      // First-ever call with no persisted state yet — persist the default
      // (first candidate) so a restart doesn't silently re-derive a
      // different starting point.
      this.writeState(activeCandidate.name, null);
    }

    this.fsOps.mkdirp(pathDirname(this.secretFilePath));
    this.fsOps.writeFile(this.secretFilePath, activeCandidate.value, 0o600);
    return this.secretFilePath;
  }

  private resolveActive(state: RouterStateRow | null): AnthropicKeyCandidate {
    const byName = state ? this.candidates.find((c) => c.name === state.active_candidate_name) : undefined;
    return byName ?? this.candidates[0]!;
  }

  private readState(): RouterStateRow | null {
    return (this.db
      .prepare(`SELECT active_candidate_name, last_switch_sample_captured_at FROM anthropic_key_router_state WHERE id = 'singleton'`)
      .get() as RouterStateRow | undefined) ?? null;
  }

  private writeState(activeCandidateName: string, lastSwitchSampleCapturedAt: string | null): void {
    this.db
      .prepare(
        `INSERT INTO anthropic_key_router_state (id, active_candidate_name, last_switch_sample_captured_at, updated_at)
         VALUES ('singleton', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET active_candidate_name = excluded.active_candidate_name,
           last_switch_sample_captured_at = excluded.last_switch_sample_captured_at, updated_at = excluded.updated_at`,
      )
      .run(activeCandidateName, lastSwitchSampleCapturedAt, this.now().toISOString());
  }
}

/** Tiny local dirname — avoids pulling node:path into a module that otherwise
 *  has zero filesystem-shape dependencies beyond the injected fsOps. */
function pathDirname(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}
