#!/usr/bin/env npx tsx
/**
 * Automated audio round-trip test: uploads a WAV file, sends it as a voice
 * recording, and observes the bot's streaming response.
 *
 * Requires a .env file at the project root (see .env.example).
 */

import { config } from "dotenv";
config({ path: new URL(".env", import.meta.url).pathname });
import { StreamChat } from "stream-chat";
import { readFileSync } from "fs";

const apiKey = process.env.STREAM_API_KEY;
const userId = process.env.TEST_USER_ID;
const userToken = process.env.TEST_USER_TOKEN;
const channelId = process.env.TEST_CHANNEL_ID || "ai-test-channel";

if (!apiKey || !userId || !userToken) {
  console.error("Error: STREAM_API_KEY, TEST_USER_ID, and TEST_USER_TOKEN must be set in .env");
  process.exit(1);
}

const client = new StreamChat(apiKey, { allowServerSideConnect: true });
console.log(`Connecting as ${userId}...`);
await client.connectUser({ id: userId }, userToken);
console.log("Connected.");

// Watch the test channel
const channel = client.channel("messaging", channelId);
await channel.watch();
console.log(`Using channel: messaging:${channelId}`);

let gotResponse = false;

// Listen for new messages
client.on("message.new", (event) => {
  if (event.user?.id === userId) return;
  if (!event.message) return;
  const from = event.user?.name || event.user?.id || "unknown";
  const text = event.message.text || "(no text)";
  const aiGenerated = event.message.ai_generated ? " [AI]" : "";
  const attachments = event.message.attachments || [];
  const hasAudio = attachments.some(
    (a) => a.type === "voiceRecording" || a.mime_type?.startsWith("audio/"),
  );
  console.log(`[NEW MSG][${from}]${aiGenerated}: ${text}${hasAudio ? " [has audio]" : ""}`);
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
  const attachments = event.message.attachments || [];
  const hasAudio = attachments.some(
    (a) => a.type === "voiceRecording" || a.mime_type?.startsWith("audio/"),
  );
  if (generating) {
    console.log(`[STREAMING] ${text.slice(-120)}${hasAudio ? " [has audio]" : ""}`);
  } else {
    console.log(`[FINAL] ${text}${hasAudio ? " [has audio]" : ""}`);
    gotResponse = true;
  }
});

// Read audio file
const audioPath = new URL("assets/test-audio.wav", import.meta.url).pathname;
const wavBuffer = readFileSync(audioPath);
console.log(`\nLoaded test audio: ${wavBuffer.length} bytes`);

// Upload WAV via channel.sendFile
console.log("Uploading audio file...");
const uploadResp = await channel.sendFile(wavBuffer as any, "test-audio.wav", "audio/wav");
const assetUrl = uploadResp.file;
console.log(`Uploaded → ${assetUrl.slice(0, 80)}...`);

// Send message with voiceRecording attachment
console.log("Sending audio message...");
await channel.sendMessage({
  text: "",
  attachments: [
    {
      type: "voiceRecording",
      asset_url: assetUrl,
      mime_type: "audio/wav",
      title: "test-audio.wav",
      file_size: wavBuffer.length,
      duration: 5.071,
      waveform_data: new Array(100).fill(0.2),
    },
  ],
});
console.log("Audio message sent. Waiting for response...\n");

// Wait up to 60 seconds for response (audio processing is slower)
const start = Date.now();
while (!gotResponse && Date.now() - start < 60000) {
  await new Promise((r) => setTimeout(r, 500));
}

if (gotResponse) {
  console.log("\n✓ Audio round-trip test PASSED — got bot response.");
} else {
  console.log("\n✗ Audio round-trip test TIMED OUT — no response in 60s.");
}

await client.disconnectUser();
process.exit(gotResponse ? 0 : 1);
