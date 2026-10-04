// Phase 5 — ClaudeManagedLaunch's integration with the Anthropic key failover
// router. Mirrors claude-managed-launch-help-timeout.test.ts's hermetic
// fixture (real DB, real fake `claude` executable, real ClaudeManagedLaunch)
// but asserts on the built command() string rather than prepare()'s outcome.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch, type AnthropicKeyRouterSeam } from "../src/domain/claude-managed-launch.js";

const CHOICES = '  --permission-mode <mode>   Permission mode to use for the session (choices: "acceptEdits", "auto", "default", "plan")';

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function fixture(sessionEnv: Record<string, string | undefined>, keyRouter?: AnthropicKeyRouterSeam) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-key-router-")));
  const cwd = path.join(root, "seat"); const bin = path.join(root, "bin");
  mkdirSync(cwd); mkdirSync(bin); mkdirSync(path.join(root, "home"));
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' '${CHOICES}'\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  const db = new Database(":memory:"); open.push(db);
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const managed = new ClaudeManagedLaunch(
    db,
    { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home"), ...sessionEnv },
    {},
    keyRouter,
  );
  return { managed };
}

describe("ClaudeManagedLaunch x AnthropicKeyRouter", () => {
  it("without a router, forwards ANTHROPIC_API_KEY the upstream way (resolved in the pane's own shell)", async () => {
    const f = fixture({ ANTHROPIC_API_KEY: "sk-ambient-placeholder" });
    const prepared = await f.managed.prepare({ nodeId: "node" }, "auto");
    const cmd = prepared.command(["--resume", "tok"]);
    expect(cmd).toContain('"ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-}"');
    expect(cmd).not.toContain("$(cat");
  });

  it("with an active router, substitutes ANTHROPIC_API_KEY from the router's file by path, never embedding a value", async () => {
    const router: AnthropicKeyRouterSeam = { currentValueFilePath: () => "/state/anthropic-key-router/current" };
    const f = fixture({ ANTHROPIC_API_KEY: "sk-ambient-placeholder" }, router);
    const prepared = await f.managed.prepare({ nodeId: "node" }, "auto");
    const cmd = prepared.command(["--resume", "tok"]);
    expect(cmd).toContain(`ANTHROPIC_API_KEY="$(cat '/state/anthropic-key-router/current')"`);
    expect(cmd).not.toContain('${ANTHROPIC_API_KEY-}');
    expect(cmd).not.toContain("sk-ambient-placeholder"); // never the literal value in text
  });

  it("re-checks the router on every command() call — a switch takes effect on the very next build, not cached from prepare()", async () => {
    let path_ = "/state/anthropic-key-router/key-a";
    const router: AnthropicKeyRouterSeam = { currentValueFilePath: () => path_ };
    const f = fixture({ ANTHROPIC_API_KEY: "sk-ambient-placeholder" }, router);
    const prepared = await f.managed.prepare({ nodeId: "node" }, "auto");
    expect(prepared.command(["--resume", "tok"])).toContain("key-a");
    path_ = "/state/anthropic-key-router/key-b"; // router "switched" between the two command() calls
    expect(prepared.command(["--resume", "tok"])).toContain("key-b");
  });

  it("an inactive router (null path) falls back to the upstream ${KEY-} forwarding unchanged", async () => {
    const router: AnthropicKeyRouterSeam = { currentValueFilePath: () => null };
    const f = fixture({ ANTHROPIC_API_KEY: "sk-ambient-placeholder" }, router);
    const prepared = await f.managed.prepare({ nodeId: "node" }, "auto");
    const cmd = prepared.command(["--resume", "tok"]);
    expect(cmd).toContain('"ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-}"');
    expect(cmd).not.toContain("$(cat");
  });

  it("other inherited provider-auth vars are unaffected by the router — only ANTHROPIC_API_KEY is special-cased", async () => {
    const router: AnthropicKeyRouterSeam = { currentValueFilePath: () => "/state/anthropic-key-router/current" };
    const f = fixture({ ANTHROPIC_API_KEY: "sk-ambient-placeholder", CLAUDE_CODE_OAUTH_TOKEN: "oauth-placeholder" }, router);
    const prepared = await f.managed.prepare({ nodeId: "node" }, "auto");
    const cmd = prepared.command(["--resume", "tok"]);
    expect(cmd).toContain('"CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN-}"');
  });
});
