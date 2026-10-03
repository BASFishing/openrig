import type { Migration } from "../migrate.js";

export const nodeApiKeyEnvSchema: Migration = {
  name: "085_node_api_key_env.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN api_key_env TEXT;
  `,
};
