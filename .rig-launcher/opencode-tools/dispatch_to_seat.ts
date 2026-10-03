// Custom opencode tool: lets the local model delegate to another seat in the
// same OpenRig rig (e.g. a Claude seat) via `rig send` — real delegation,
// not a simulated reply. The recipient answers on its own schedule; this
// call returns once the message is delivered, not once it's answered.
//
// Auto-discovered by opencode from .opencode/tool/<name>.ts in the seat's
// project — copied here by launcher.py's scaffold_project for any rig
// containing an "ollama" seat. Reuses OpenRig's own `rig send` CLI rather
// than reimplementing tmux delivery.

import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default tool({
  description:
    "Send a message to another seat in this rig (e.g. a Claude seat) via `rig send` — real " +
    "delegation, not a simulated reply. The recipient answers on its own schedule; this call " +
    "returns once the message is delivered, not once it's answered.",
  args: {
    session: tool.schema.string().describe("Target seat address, e.g. dev-impl@my-rig."),
    message: tool.schema.string().describe("Self-contained message — the recipient has no other context."),
  },
  async execute(args) {
    const { stdout, stderr } = await execFileAsync("rig", ["send", args.session, args.message]);
    return stdout.trim() || stderr.trim() || `sent to ${args.session}`;
  },
});
