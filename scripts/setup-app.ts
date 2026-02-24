#!/usr/bin/env npx tsx
/**
 * One-shot setup script for a fresh Stream Chat app.
 *
 * What it does:
 *   1. Creates/upserts a bot user and a test user via the server API
 *   2. Generates permanent tokens for both
 *   3. Creates a messaging channel with both as members
 *   4. Updates ~/.openclaw/openclaw.json with apiKey, botUserId, botUserToken
 *   5. Writes scripts/.env with STREAM_API_KEY, TEST_USER_ID, TEST_USER_TOKEN, TEST_CHANNEL_ID
 *
 * Usage:
 *   STREAM_API_SECRET=your_secret npx tsx scripts/setup-app.ts
 *
 * STREAM_API_KEY can be in .env or passed on the command line.
 */

import { config } from "dotenv";
config({ path: new URL(".env", import.meta.url).pathname });
import { StreamChat } from "stream-chat";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPTS_DIR, "..");
const OPENCLAW_CONFIG = join(homedir(), ".openclaw/openclaw.json");

// ── App credentials ──────────────────────────────────────────────────────────
const API_KEY = process.env.STREAM_API_KEY;
const API_SECRET = process.env.STREAM_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error("Error: STREAM_API_KEY and STREAM_API_SECRET must be set");
  process.exit(1);
}

// ── User IDs ─────────────────────────────────────────────────────────────────
const BOT_USER_ID = process.env.BOT_USER_ID || "openclaw-bot";
const BOT_USER_NAME = "OpenClaw Bot";
const TEST_USER_ID = process.env.TEST_USER_ID || "test-user";
const TEST_USER_NAME = "Test User";

// ── Channel ───────────────────────────────────────────────────────────────────
const CHANNEL_TYPE = "messaging";
const CHANNEL_ID = "ai-test-channel";
const CHANNEL_NAME = "AI Test Channel";

// ─────────────────────────────────────────────────────────────────────────────

console.log("=== Stream Chat App Setup ===\n");

// Step 1: Server-side client (needs secret for admin operations)
console.log(`Connecting to app ${API_KEY} as server...`);
const server = new StreamChat(API_KEY, API_SECRET);

// Step 2: Create/upsert users
console.log(`\nUpserting users...`);
await server.upsertUsers([
  { id: BOT_USER_ID, name: BOT_USER_NAME, role: "admin" },
  { id: TEST_USER_ID, name: TEST_USER_NAME },
]);
console.log(`  ✓ ${BOT_USER_ID} (bot)`);
console.log(`  ✓ ${TEST_USER_ID} (client)`);

// Step 3: Generate tokens
const botToken = server.createToken(BOT_USER_ID);
const clientToken = server.createToken(TEST_USER_ID);
console.log(`\nGenerated tokens:`);
console.log(`  bot:    ${botToken.slice(0, 40)}...`);
console.log(`  client: ${clientToken.slice(0, 40)}...`);

// Step 4: Create channel with both members
console.log(`\nCreating channel ${CHANNEL_TYPE}:${CHANNEL_ID}...`);
const channel = server.channel(CHANNEL_TYPE, CHANNEL_ID, {
  name: CHANNEL_NAME,
  members: [BOT_USER_ID, TEST_USER_ID],
  created_by_id: TEST_USER_ID,
});
await channel.create();
console.log(`  ✓ Channel created`);

// Step 5: Update openclaw.json
console.log(`\nUpdating ${OPENCLAW_CONFIG}...`);
const rawConfig = readFileSync(OPENCLAW_CONFIG, "utf-8");
const config = JSON.parse(rawConfig) as Record<string, unknown>;
const channels = (config.channels ?? {}) as Record<string, unknown>;
const existing = (channels.streamchat ?? {}) as Record<string, unknown>;
channels.streamchat = {
  ...existing,
  apiKey: API_KEY,
  botUserId: BOT_USER_ID,
  botUserToken: botToken,
};
config.channels = channels;
writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n");
console.log(`  ✓ channels.streamchat updated`);

// Step 6: Write .env in scripts/ for all scripts
const envPath = join(SCRIPTS_DIR, ".env");
const envContent = [
  `STREAM_API_KEY=${API_KEY}`,
  `TEST_USER_ID=${TEST_USER_ID}`,
  `TEST_USER_TOKEN=${clientToken}`,
  `TEST_CHANNEL_ID=${CHANNEL_ID}`,
].join("\n") + "\n";
writeFileSync(envPath, envContent);
console.log(`  ✓ Wrote .env`);

// Done
console.log(`
✓ Setup complete!

  App key:     ${API_KEY}
  Bot user:    ${BOT_USER_ID}
  Client user: ${TEST_USER_ID}
  Channel:     ${CHANNEL_TYPE}:${CHANNEL_ID}

Next steps:
  openclaw gateway restart
  npx tsx scripts/test-roundtrip.ts
`);

process.exit(0);
