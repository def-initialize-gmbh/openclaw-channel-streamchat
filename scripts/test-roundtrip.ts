#!/usr/bin/env npx tsx
/**
 * Automated round-trip test: sends a message and observes the streaming response.
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

// Discover channels
const channels = await client.queryChannels(
  { members: { $in: [userId] } },
  [{ last_message_at: -1 }],
  { limit: 10 },
);

const channel = channels[0];
console.log(`Using channel: ${channel.type}:${channel.id}`);
await channel.watch();

let gotResponse = false;

// Listen for new messages
client.on("message.new", (event) => {
  if (event.user?.id === userId) return;
  if (!event.message) return;
  const from = event.user?.name || event.user?.id || "unknown";
  const text = event.message.text || "(no text)";
  const aiGenerated = event.message.ai_generated ? " [AI]" : "";
  console.log(`[NEW MSG][${from}]${aiGenerated}: ${text}`);
});

// Listen for AI indicators
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

// Listen for message updates (streaming)
client.on("message.updated", (event) => {
  if (!event.message) return;
  const text = event.message.text || "";
  const generating = (event.message as Record<string, unknown>).generating;
  if (generating) {
    console.log(`[STREAMING] ${text.slice(-120)}`);
  } else {
    console.log(`[FINAL] ${text}`);
    gotResponse = true;
  }
});

// Send test message
console.log("\nSending test message...");
await channel.sendMessage({ text: "What is 2 + 2? Reply in one short sentence." });
console.log("Message sent. Waiting for response...\n");

// Wait up to 40 seconds for response
const start = Date.now();
while (!gotResponse && Date.now() - start < 40000) {
  await new Promise((r) => setTimeout(r, 500));
}

if (gotResponse) {
  console.log("\n✓ Round-trip test PASSED — got bot response.");
} else {
  console.log("\n✗ Round-trip test TIMED OUT — no response in 40s.");
}

await client.disconnectUser();
process.exit(gotResponse ? 0 : 1);
