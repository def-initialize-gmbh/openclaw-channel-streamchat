#!/usr/bin/env npx tsx
/**
 * Generate a JWT for the bot user.
 *
 * Usage:
 *   STREAM_API_KEY=... STREAM_API_SECRET=... BOT_USER_ID=chatgpt npx tsx scripts/generate-bot-token.ts
 *
 * Or with a .env file in the project root:
 *   npx tsx scripts/generate-bot-token.ts
 *
 * The generated token should be saved to your openclaw.json config:
 *   channels.streamchat.botUserToken
 */

import { StreamChat } from "stream-chat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Try loading .env manually (no dotenv dependency needed)
function loadEnv(): void {
  try {
    const envPath = resolve(import.meta.dirname ?? ".", "../.env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env file not found, that's fine
  }
}

loadEnv();

const apiKey = process.env.STREAM_API_KEY || process.env.STREAM_CHAT_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET || process.env.STREAM_CHAT_API_SECRET;
const botUserId = process.env.BOT_USER_ID || "chatgpt";

if (!apiKey || !apiSecret) {
  console.error(
    "Error: STREAM_API_KEY and STREAM_API_SECRET environment variables are required.",
  );
  console.error(
    "\nUsage: STREAM_API_KEY=... STREAM_API_SECRET=... npx tsx scripts/generate-bot-token.ts",
  );
  process.exit(1);
}

// Server-side client (uses apiSecret for token generation)
const client = StreamChat.getInstance(apiKey, apiSecret);

// Upsert the bot user first
await client.upsertUser({
  id: botUserId,
  name: botUserId,
  role: "admin",
});

// Generate a permanent token (no expiry)
const token = client.createToken(botUserId);

console.log(`\nBot user: ${botUserId}`);
console.log(`Token: ${token}`);
console.log(`\nAdd this to your openclaw.json:`);
console.log(`  "channels": {`);
console.log(`    "streamchat": {`);
console.log(`      "botUserToken": "${token}"`);
console.log(`    }`);
console.log(`  }`);

await client.disconnectUser().catch(() => {});
process.exit(0);
