#!/usr/bin/env python3
"""
Generic, adaptable OpenRig launcher.

Replaces one hardcoded .command file per project with a single entry point:
pick an existing project from the registry, or create a new one (default
Claude+local pair, with an option to add additional seats). A separate
main-menu option (not per-project — see configure_key_failover) configures
a daemon-wide Claude key failover pool: every Claude seat shares one active
key, auto-switching to the next candidate when the current one's rate-limit
window is exhausted (Phase 5 / anthropic-key-router.ts) — this replaced an
earlier per-seat distinct-account design.

Registry: .rigs-registry.json (project name -> path, seats).
Secrets:  .rigs-secrets.env (gitignored — actual API key VALUES live here,
          never in the registry or in any rig.yaml; sourced into this
          process's environment before the daemon is touched).

Known limitation, inherited from the daemon's own settings-at-boot design: a
key only takes effect for a daemon that had it in its OWN environment at
`rig start` time. If you add or change a key while the daemon is already
running, you'll need to restart it for the change to take effect — this
script warns about that rather than silently restarting a daemon that may
have other live rigs in it.
"""

import getpass
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Keep this process's own stdout in lockstep with subprocess output (osascript,
# tmux, etc. write straight to the terminal fd, unbuffered) — without this,
# Python's buffered prints can appear to "jump" out of order on screen even
# though execution order is correct.
sys.stdout.reconfigure(line_buffering=True)

OPENRIG_DIR = Path("/Users/bakari/Documents/GitHub/openrig")
REGISTRY_PATH = OPENRIG_DIR / ".rigs-registry.json"
SECRETS_PATH = OPENRIG_DIR / ".rigs-secrets.env"
NODE22_BIN = "/opt/homebrew/opt/node@22/bin"
DEFAULT_MODEL = "qwen3.5-9b-uncensored"
DISPATCH_TOOL_SRC = Path(__file__).resolve().parent / "opencode-tools" / "dispatch_to_seat.ts"

# Seed data for the two projects that predate this registry.
DEFAULT_REGISTRY = {
    "projects": {
        "pilot": {
            "path": str(OPENRIG_DIR / ".ollama-pilot" / "workspace"),
            "rig_dir": str(OPENRIG_DIR / ".ollama-pilot"),
            "seats": [{"id": "local", "runtime": "ollama", "model": DEFAULT_MODEL}],
        },
        "tls": {
            "path": "/Users/bakari/Documents/GitHub/tls",
            "rig_dir": str(OPENRIG_DIR / ".tls-rig"),
            "seats": [
                {"id": "claude", "runtime": "claude-code"},
                {"id": "local", "runtime": "ollama", "model": DEFAULT_MODEL},
            ],
        },
    }
}


def run(cmd, **kwargs):
    env = os.environ.copy()
    env["PATH"] = f"{NODE22_BIN}:{env['PATH']}"
    kwargs.setdefault("env", env)
    return subprocess.run(cmd, **kwargs)


def sh(cmd_str, **kwargs):
    return run(cmd_str, shell=True, **kwargs)


def tmux_has_session(name: str) -> bool:
    return run(["tmux", "has-session", "-t", name], capture_output=True).returncode == 0


def load_registry() -> dict:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text())
    REGISTRY_PATH.write_text(json.dumps(DEFAULT_REGISTRY, indent=2))
    return json.loads(json.dumps(DEFAULT_REGISTRY))


def save_registry(reg: dict) -> None:
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2))


def load_secrets_into_env() -> None:
    if not SECRETS_PATH.exists():
        return
    for line in SECRETS_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ[key.strip()] = value.strip()


def store_secret(var_name: str, value: str) -> None:
    lines = []
    if SECRETS_PATH.exists():
        lines = [l for l in SECRETS_PATH.read_text().splitlines() if not l.startswith(f"{var_name}=")]
    lines.append(f"{var_name}={value}")
    SECRETS_PATH.write_text("\n".join(lines) + "\n")
    SECRETS_PATH.chmod(0o600)
    os.environ[var_name] = value


def configure_key_failover() -> None:
    """Daemon-wide (not per-project): every Claude seat on this daemon shares
    ONE active Anthropic key, auto-switching to the next candidate when the
    current one's rate-limit window is exhausted. Replaces the old per-seat
    distinct-account design — see Phase 5 / anthropic-key-router.ts."""
    print()
    print("== Claude key failover ==")
    print("Configure 2+ Anthropic API keys; the daemon auto-switches to the next")
    print("one when the active key's rate-limit window is exhausted.")
    keys: list[str] = []
    i = 1
    while True:
        label = "primary" if i == 1 else f"backup #{i - 1}"
        key_value = getpass.getpass(f"  Key {i} ({label}, hidden, blank to stop): ").strip()
        if not key_value:
            break
        var_name = f"ANTHROPIC_API_KEY_CANDIDATE_{i}"
        store_secret(var_name, key_value)
        keys.append(var_name)
        i += 1
    if len(keys) < 2:
        print("  Need at least 2 keys for failover to do anything — nothing changed." if keys
              else "  No keys entered — nothing changed.")
        return
    ensure_daemon()
    run(["rig", "config", "set", "recovery.provider_auth_env_allowlist", "ANTHROPIC_API_KEY"], capture_output=True)
    run(["rig", "config", "set", "recovery.anthropic_key_candidates", ",".join(keys)], capture_output=True)
    print(f"  Stored {len(keys)} keys in {SECRETS_PATH} and configured the router.")
    print("  NOTE: restart the daemon for this to take effect on already-running")
    print("  seats (rig daemon stop && rig daemon start) — a daemon reads these")
    print("  candidate values from its OWN environment only at start time.")


def sanitize_name(raw: str) -> str:
    name = re.sub(r"[^a-z0-9-]+", "-", raw.lower()).strip("-")
    return name or "project"


def ensure_ollama() -> None:
    print("== Ollama ==")
    r = run(["curl", "-s", "-o", "/dev/null", "http://127.0.0.1:11434/api/tags"])
    if r.returncode != 0:
        run(["brew", "services", "start", "ollama"])
        sh("sleep 2")
    else:
        print("already running")


def ensure_daemon() -> None:
    print("== OpenRig daemon ==")
    if run(["rig", "status"], capture_output=True).returncode != 0:
        run(["rig", "start"])
        sh("sleep 2")
    else:
        print("already running (left as-is)")


def write_srt_config(path: Path, project_path: str) -> None:
    config = {
        "filesystem": {
            "allowWrite": [".", "~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode"],
            "denyWrite": [".env", ".git/config"],
            "denyRead": ["~/.ssh", "~/.aws", "~/.config/herdr", "~/.openrig", ".env"],
        },
        "network": {
            "allowedDomains": ["models.dev"],
            "deniedDomains": [],
            "allowLocalBinding": True,
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2))


AGENT_YAML_TEMPLATE = """name: {seat_id}-seat
version: "1.0"
description: {description}

defaults:
  runtime: {runtime}

profiles:
  default:
    uses:
      skills: []
      guidance: []
      subagents: []
      plugins: []
      runtime_resources: []

resources:
  guidance:
    - id: role
      path: guidance/role.md

startup:
  files:
    - path: guidance/role.md
      delivery_hint: {delivery_hint}
      required: true
  actions: []
"""

ROLE_MD_TEMPLATE = """# Role

{role_body}
"""


def scaffold_project(name: str, path: str, seats: list[dict]) -> str:
    rig_dir = OPENRIG_DIR / f".{name}-rig"
    agents_dir = rig_dir / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)

    members_yaml = []
    for seat in seats:
        seat_id = seat["id"]
        runtime = seat["runtime"]
        seat_dir = agents_dir / f"{seat_id}-seat" / "guidance"
        seat_dir.mkdir(parents=True, exist_ok=True)

        if runtime == "claude-code":
            desc = f"Coding seat for {name}."
            delivery_hint = "send_text"
            role_body = (
                f"You are a coding seat for the {name} project.\n\n"
                "Before doing anything else, look for a project context folder "
                "(e.g. `.missions/`, `CLAUDE.md`, or similar) and read it first.\n"
            )
        else:
            desc = f"Local-model seat for {name}."
            delivery_hint = "guidance_merge"
            role_body = (
                f"You are a local-model seat for the {name} project.\n\n"
                "Before discussing anything, look for a project context folder "
                "(e.g. `.missions/`, `CLAUDE.md`, or similar) and read it first.\n"
                "You have opencode's own read/write/edit/bash/grep/glob tools, "
                "sandboxed to this directory, and dispatch_to_seat to delegate "
                "to other seats in this rig.\n"
            )

        (agents_dir / f"{seat_id}-seat" / "agent.yaml").write_text(
            AGENT_YAML_TEMPLATE.format(seat_id=seat_id, description=desc, runtime=runtime, delivery_hint=delivery_hint)
        )
        (seat_dir / "role.md").write_text(ROLE_MD_TEMPLATE.format(role_body=role_body))

        member_lines = [
            f"      - id: {seat_id}",
            f'        agent_ref: "local:agents/{seat_id}-seat"',
            f"        runtime: {runtime}",
        ]
        if runtime == "ollama":
            member_lines.append(f"        model: {seat.get('model', DEFAULT_MODEL)}")
        member_lines.append("        profile: default")
        member_lines.append('        cwd: "."')
        members_yaml.append("\n".join(member_lines))

    rig_yaml = f"""version: "0.2"
name: {name}
summary: Multi-agent rig for {name}.

pods:
  - id: dev
    label: Development
    members:
{chr(10).join(members_yaml)}

edges: []
"""
    (rig_dir / "rig.yaml").write_text(rig_yaml)

    if any(seat["runtime"] == "ollama" for seat in seats):
        # Per-seat-cwd convention OllamaRuntimeAdapter reads directly (see
        # ollama-runner-protocol.ts's ollamaSrtSettingsPath) — no rig-level
        # config file or daemon wiring needed; absence just means unsandboxed.
        write_srt_config(Path(path) / ".openrig" / "ollama" / "srt-config.json", path)
        tool_dir = Path(path) / ".opencode" / "tool"
        tool_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(DISPATCH_TOOL_SRC, tool_dir / "dispatch_to_seat.ts")

    return str(rig_dir)


def ensure_rig_running(name: str, rig_dir: str, path: str) -> None:
    print(f"== {name} rig ==")
    r = run(["rig", "ps", "--rig", name, "--json"], capture_output=True, text=True)
    if r.returncode == 0 and '"status":"running"' in r.stdout:
        print("already running")
        return
    print("launching via rig up")
    run(["rig", "up", f"{rig_dir}/rig.yaml", "--cwd", path])
    sh("sleep 3")


def ensure_herdr() -> None:
    print("== herdr ==")
    if tmux_has_session("herdr-host"):
        print("already running")
        return
    print("launching fresh")
    run(["tmux", "new-session", "-d", "-s", "herdr-host", "-x", "220", "-y", "55"])
    run(["tmux", "send-keys", "-t", "herdr-host", "herdr", "Enter"])
    sh("sleep 3")


def open_terminal_windows(sessions: list[str]) -> None:
    script_lines = ['tell application "Terminal"', "  activate"]
    for s in sessions:
        script_lines.append(f'  do script "tmux attach -t {s}"')
    script_lines.append("end tell")
    run(["osascript", "-e", "\n".join(script_lines)])

    print()
    print("Want these combined into one window with tabs instead? In any one")
    print("of the windows that just opened: press Cmd+T, then run one of:")
    for s in sessions:
        print(f"  tmux attach -t {s}")
    print("(whichever ones aren't already in that window).")


def launch_project(name: str, cfg: dict) -> None:
    path = cfg["path"]
    rig_dir = cfg["rig_dir"]
    seats = cfg["seats"]

    ensure_rig_running(name, rig_dir, path)
    ensure_herdr()
    r = run(["rig", "terminal", "open", name, "--provider", "herdr"], capture_output=True, text=True)
    if r.returncode != 0:
        print("warning: herdr workspace open failed (give it a few more seconds and re-run if so)")

    sessions = [f"dev-{s['id']}@{name}" for s in seats] + ["herdr-host"]
    open_terminal_windows(sessions)


def prompt_new_project(reg: dict) -> tuple[str, dict]:
    raw_path = input("Project path: ").strip()
    project_path = str(Path(raw_path).expanduser().resolve())
    if not Path(project_path).is_dir():
        print(f"'{project_path}' is not a directory.")
        sys.exit(1)

    default_name = sanitize_name(Path(project_path).name)
    name = input(f"Rig name [{default_name}]: ").strip() or default_name
    name = sanitize_name(name)
    if name in reg["projects"]:
        print(f"'{name}' already exists in the registry — pick a different name.")
        sys.exit(1)

    seats = [
        {"id": "claude", "runtime": "claude-code"},
        {"id": "local", "runtime": "ollama", "model": DEFAULT_MODEL},
    ]
    use_default = input("Use the default Claude + local pair? [Y/n]: ").strip().lower()
    if use_default == "n":
        seats = []

    while True:
        add_more = input("Add a seat? [y/N]: ").strip().lower()
        if add_more != "y":
            break
        seat_id = sanitize_name(input("  Seat id (short name): ").strip() or "seat")
        runtime = input("  Runtime [claude-code/ollama]: ").strip() or "ollama"
        seat = {"id": seat_id, "runtime": runtime}
        if runtime == "ollama":
            seat["model"] = input(f"  Model [{DEFAULT_MODEL}]: ").strip() or DEFAULT_MODEL
        # Distinct-API-key-per-seat was dropped in favor of a daemon-wide key
        # failover pool shared by every Claude seat — see
        # configure_key_failover() and the "Configure Claude key failover"
        # main-menu option, not a per-seat prompt here.
        seats.append(seat)

    rig_dir = scaffold_project(name, project_path, seats)
    cfg = {"path": project_path, "rig_dir": rig_dir, "seats": seats}
    reg["projects"][name] = cfg
    save_registry(reg)
    return name, cfg


def main() -> None:
    load_secrets_into_env()
    ensure_ollama()
    ensure_daemon()

    reg = load_registry()
    names = list(reg["projects"].keys())

    print()
    print("Known projects:")
    for i, n in enumerate(names, start=1):
        print(f"  {i}) {n}  ({reg['projects'][n]['path']})")
    new_project_idx = len(names) + 1
    failover_idx = len(names) + 2
    print(f"  {new_project_idx}) New project")
    print(f"  {failover_idx}) Configure Claude key failover (daemon-wide, not per-project)")
    choice = input(f"Pick one [1-{failover_idx}]: ").strip()

    try:
        idx = int(choice)
    except ValueError:
        idx = new_project_idx

    if 1 <= idx <= len(names):
        name = names[idx - 1]
        cfg = reg["projects"][name]
    elif idx == failover_idx:
        configure_key_failover()
        return
    else:
        name, cfg = prompt_new_project(reg)

    launch_project(name, cfg)


if __name__ == "__main__":
    main()
