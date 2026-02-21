#!/usr/bin/env npx tsx
/**
 * Test thread support: sends a message, then sends a thread reply.
 */

import { StreamChat } from "stream-chat";

const apiKey = "b3haysfrr5yg";
const userId = "steookk";
const userToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoic3Rlb29rayJ9.9yO--MWVC9bYQAjdUR5vp_cKxiBXEzHrXXnPXesqakE";

const client = new StreamChat(apiKey, { allowServerSideConnect: true });
console.log(`Connecting as ${userId}...`);
await client.connectUser({ id: userId }, userToken);
console.log("Connected.");

const channels = await client.queryChannels(
  { members: { $in: [userId] } },
  [{ last_message_at: -1 }],
  { limit: 10 },
);

const channel = channels[0];
console.log(`Using channel: ${channel.type}:${channel.id}`);
await channel.watch();

let responseCount = 0;

client.on("message.new", (event) => {
  if (event.user?.id === userId) return;
  if (!event.message) return;
  const from = event.user?.name || event.user?.id || "unknown";
  const text = event.message.text || "(no text)";
  const parentId = event.message.parent_id;
  const threadLabel = parentId ? ` [thread:${parentId.slice(0, 8)}...]` : "";
  console.log(`[NEW MSG][${from}]${threadLabel}: ${text}`);
});

client.on("message.updated", (event) => {
  if (!event.message) return;
  const text = event.message.text || "";
  const generating = (event.message as Record<string, unknown>).generating;
  const parentId = event.message.parent_id;
  const threadLabel = parentId ? ` [thread:${parentId.slice(0, 8)}...]` : "";
  if (!generating && text) {
    console.log(`[FINAL]${threadLabel}: ${text.slice(0, 200)}`);
    responseCount++;
  }
});

for (const evType of ["ai_indicator.update", "ai_indicator.clear"] as const) {
  client.on(evType as Parameters<typeof client.on>[0], (event) => {
    const raw = event as Record<string, unknown>;
    if (String(raw.type).includes("clear")) {
      console.log(`[AI INDICATOR] cleared`);
    } else {
      console.log(`[AI INDICATOR] ${raw.ai_state}`);
    }
  });
}

// Step 1: Send a parent message
console.log("\n--- Step 1: Sending parent message ---");
const { message: parentMsg } = await channel.sendMessage({
  text: "Say the word 'apple' and nothing else.",
});
console.log(`Parent message ID: ${parentMsg.id}`);

// Wait for the bot's response to the parent message
console.log("Waiting for bot response to parent...");
while (responseCount < 1) {
  await new Promise((r) => setTimeout(r, 500));
  if (Date.now() - Date.now() > 30000) break;
}
await new Promise((r) => setTimeout(r, 3000));

// Step 2: Send a thread reply
console.log("\n--- Step 2: Sending thread reply ---");
await channel.sendMessage({
  text: "Now say 'banana' and nothing else.",
  parent_id: parentMsg.id,
});
console.log("Thread reply sent. Waiting for bot response in thread...");

// Wait for the bot's response to the thread
const start = Date.now();
while (responseCount < 2 && Date.now() - start < 40000) {
  await new Promise((r) => setTimeout(r, 500));
}

if (responseCount >= 2) {
  console.log("\n✓ Thread test PASSED — got responses to both parent and thread.");
} else {
  console.log(`\n✗ Thread test: got ${responseCount}/2 responses.`);
}

await client.disconnectUser();
process.exit(responseCount >= 2 ? 0 : 1);
