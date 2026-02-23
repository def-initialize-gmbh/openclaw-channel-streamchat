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

import "dotenv/config";
import { StreamChat } from "stream-chat";

const apiKey = process.env.STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;
const botUserId = process.env.BOT_USER_ID || "openclaw-bot";

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
