#!/usr/bin/env npx tsx
/**
 * Minimal CLI Stream Chat test client.
 *
 * Connects as a test user, watches a channel, sends messages,
 * and prints incoming messages from the bot.
 *
 * Usage:
 *   npx tsx scripts/test-client.ts [channelId] [message]
 *
 * Examples:
 *   npx tsx scripts/test-client.ts                    # Interactive mode, discover channels
 *   npx tsx scripts/test-client.ts myChannel          # Watch channel, interactive
 *   npx tsx scripts/test-client.ts myChannel "Hello"  # Send a message and watch
 */

import { StreamChat } from "stream-chat";
import { createInterface } from "node:readline";
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
const userId = process.env.TEST_USER_ID || "steookk";
const userToken =
  process.env.TEST_USER_TOKEN ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoic3Rlb29rayJ9.9yO--MWVC9bYQAjdUR5vp_cKxiBXEzHrXXnPXesqakE";

const channelId = process.argv[2] || "";
const initialMessage = process.argv[3] || "";

const client = new StreamChat(apiKey, { allowServerSideConnect: true });

console.log(`Connecting as ${userId}...`);
await client.connectUser({ id: userId }, userToken);
console.log("Connected.\n");

// Discover or use specified channel
let targetChannelId = channelId;
let targetChannelType = "messaging";

if (!targetChannelId) {
  console.log("Discovering channels...");
  const channels = await client.queryChannels(
    { members: { $in: [userId] } },
    [{ last_message_at: -1 }],
    { limit: 10 },
  );

  if (channels.length === 0) {
    console.log("No channels found. Create one first.");
    await client.disconnectUser();
    process.exit(1);
  }

  console.log("\nAvailable channels:");
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const members = Object.keys(ch.state.members);
    console.log(`  [${i}] ${ch.type}:${ch.id} (members: ${members.join(", ")})`);
  }

  targetChannelType = channels[0].type;
  targetChannelId = channels[0].id!;
  console.log(`\nUsing first channel: ${targetChannelType}:${targetChannelId}\n`);
}

// Watch the channel
const channel = client.channel(targetChannelType, targetChannelId);
await channel.watch();
console.log(`Watching ${targetChannelType}:${targetChannelId}\n`);

// Listen for messages
client.on("message.new", (event) => {
  if (!event.message || event.user?.id === userId) return;
  const from = event.user?.name || event.user?.id || "unknown";
  const text = event.message.text || "(no text)";
  const aiGenerated = event.message.ai_generated ? " [AI]" : "";
  const generating = (event.message as Record<string, unknown>).generating ? " [generating...]" : "";
  console.log(`\n[${from}]${aiGenerated}${generating}: ${text}`);
});

// Listen for AI indicators
for (const evType of ["ai_indicator.update", "ai_indicator.clear"]) {
  client.on(evType as Parameters<typeof client.on>[0], (event) => {
    const raw = event as Record<string, unknown>;
    if (evType === "ai_indicator.clear") {
      console.log(`  [AI indicator] cleared`);
    } else {
      console.log(`  [AI indicator] ${raw.ai_state}`);
    }
  });
}

// Listen for message updates (streaming)
client.on("message.updated", (event) => {
  if (!event.message) return;
  const text = event.message.text || "";
  const generating = (event.message as Record<string, unknown>).generating;
  if (generating) {
    process.stdout.write(`\r  [streaming] ${text.slice(-80)}`);
  } else {
    console.log(`\n  [final] ${text.slice(0, 200)}`);
  }
});

// Send initial message if provided
if (initialMessage) {
  console.log(`Sending: "${initialMessage}"`);
  await channel.sendMessage({ text: initialMessage });
}

// Interactive mode
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log("\nType a message and press Enter to send. Commands:");
console.log("  /thread <parentId> <text>  — Send as thread reply");
console.log("  /quote <messageId> <text>  — Send as quoted reply");
console.log("  /quit                      — Exit\n");

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed === "/quit") {
    console.log("Disconnecting...");
    await client.disconnectUser();
    process.exit(0);
  }

  if (trimmed.startsWith("/thread ")) {
    const parts = trimmed.slice(8).split(" ");
    const parentId = parts[0];
    const text = parts.slice(1).join(" ");
    if (parentId && text) {
      await channel.sendMessage({ text, parent_id: parentId });
      console.log(`  Sent thread reply to ${parentId}: "${text}"`);
    } else {
      console.log("  Usage: /thread <parentId> <text>");
    }
    return;
  }

  if (trimmed.startsWith("/quote ")) {
    const parts = trimmed.slice(7).split(" ");
    const quotedId = parts[0];
    const text = parts.slice(1).join(" ");
    if (quotedId && text) {
      await channel.sendMessage({
        text,
        quoted_message_id: quotedId,
      } as Parameters<typeof channel.sendMessage>[0]);
      console.log(`  Sent quoted reply to ${quotedId}: "${text}"`);
    } else {
      console.log("  Usage: /quote <messageId> <text>");
    }
    return;
  }

  await channel.sendMessage({ text: trimmed });
  console.log(`  Sent: "${trimmed}"`);
});

// Keep alive
process.on("SIGINT", async () => {
  console.log("\nDisconnecting...");
  rl.close();
  await client.disconnectUser();
  process.exit(0);
});
