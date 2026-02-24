#!/usr/bin/env npx tsx
/**
 * Discover channels that a user belongs to.
 *
 * Usage:
 *   npx tsx scripts/discover-channels.ts
 *
 * Requires a .env file at the project root (see .env.example).
 */

import { config } from "dotenv";
config({ path: new URL(".env", import.meta.url).pathname });
import { StreamChat } from "stream-chat";

const apiKey = process.env.STREAM_API_KEY;
const userId = process.env.TEST_USER_ID;
const userToken = process.env.TEST_USER_TOKEN;

if (!apiKey || !userId || !userToken) {
  console.error("Error: STREAM_API_KEY, TEST_USER_ID, and TEST_USER_TOKEN must be set in .env");
  process.exit(1);
}

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
