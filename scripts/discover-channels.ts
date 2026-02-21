#!/usr/bin/env npx tsx
/**
 * Discover channels that a user belongs to.
 *
 * Usage:
 *   STREAM_API_KEY=... USER_ID=steookk USER_TOKEN=... npx tsx scripts/discover-channels.ts
 */

import { StreamChat } from "stream-chat";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    // .env file not found
  }
}

loadEnv();

const apiKey = process.env.STREAM_API_KEY || "b3haysfrr5yg";
const userId = process.env.USER_ID || "steookk";
const userToken =
  process.env.USER_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoic3Rlb29rayJ9.9yO--MWVC9bYQAjdUR5vp_cKxiBXEzHrXXnPXesqakE";

const client = new StreamChat(apiKey, { allowServerSideConnect: true });

console.log(`Connecting as ${userId}...`);
await client.connectUser({ id: userId }, userToken);

console.log(`Querying channels...`);
const channels = await client.queryChannels(
  { members: { $in: [userId] } },
  [{ last_message_at: -1 }],
  { limit: 30 },
);

console.log(`\nFound ${channels.length} channel(s):\n`);

for (const ch of channels) {
  const members = Object.keys(ch.state.members);
  console.log(`  ${ch.type}:${ch.id}`);
  console.log(`    Members: ${members.join(", ")}`);
  const lastMsg = ch.state.messages[ch.state.messages.length - 1];
  if (lastMsg) {
    console.log(
      `    Last message: "${(lastMsg.text ?? "").slice(0, 60)}" (by ${lastMsg.user?.id})`,
    );
  }
  console.log();
}

await client.disconnectUser();
process.exit(0);
