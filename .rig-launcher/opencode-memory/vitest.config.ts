import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Deliberately NOT registered in the repo root's vitest.config.ts `projects`
// list — this directory is personal tooling (see .rig-launcher/README.md),
// not one of the product's packages/*, and the root config's project list
// exists specifically for packages/* hermeticity (B15) which doesn't apply
// here (these tests touch no daemon, no live services — real tmpdir
// filesystem + injected fetch mocks only). Run directly:
//   cd .rig-launcher/opencode-memory && npx vitest run
// or: npx vitest run --config .rig-launcher/opencode-memory/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["*.test.ts"],
  },
});
