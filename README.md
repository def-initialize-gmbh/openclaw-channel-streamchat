# @wunderchat/openclaw-channel-streamchat

OpenClaw channel plugin for [Stream Chat](https://getstream.io/chat/). Connects as a bot user via WebSocket, normalizes inbound messages into OpenClaw envelope format, and delivers agent responses using Stream Chat's AI streaming pattern (`partialUpdateMessage` + `ai_indicator` events).

## Prerequisites

- OpenClaw `>= 2026.2.13`
- A Stream Chat application (API key + secret from the [Stream Dashboard](https://dashboard.getstream.io/))
- Node.js `>= 20`

## Setup

### 1. Install dependencies

```bash
cd openclaw-channel-streamchat
npm install
```

### 2. Generate a bot token

The plugin connects to Stream Chat as a regular user (the bot). You need a JWT for that user, generated from your API secret. The secret is only used here — it is **not** stored in the plugin config.

Create a `.env` file in the plugin root:

```env
STREAM_API_KEY=your_api_key
STREAM_API_SECRET=your_api_secret
BOT_USER_ID=chatgpt
```

Then run:

```bash
npx tsx scripts/generate-bot-token.ts
```

This prints the bot JWT. Copy it for the next step.

### 3. Configure OpenClaw

Add the channel config and plugin entry to your `~/.openclaw/openclaw.json`:

```jsonc
{
  // Add the channel configuration
  "channels": {
    "streamchat": {
      "enabled": true,
      "apiKey": "your_api_key",
      "botUserId": "chatgpt",
      "botUserToken": "<token from step 2>",
      // Optional:
      "ackReaction": "eyes",           // reaction added when message is received (default: "eyes")
      "doneReaction": "white_check_mark", // reaction swapped in when response is done (default: "white_check_mark")
      "streamingThrottle": 15          // partial-update every Nth chunk (default: 15)
    }
  },

  // Register the plugin
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-channel-streamchat"
      ]
    },
    "entries": {
      "streamchat": {
        "enabled": true
      }
    }
  }
}
```

### 4. Restart the gateway

```bash
openclaw gateway restart
```

The plugin will connect to Stream Chat, watch all channels where the bot is a member, and start processing messages.

## Testing

All test scripts live in `scripts/` and can be run with `npx tsx`. They load credentials from `.env` or use environment variables.

### Discover channels

Lists all channels the test user belongs to:

```bash
npx tsx scripts/discover-channels.ts
```

Override the defaults with environment variables:

```bash
STREAM_API_KEY=... USER_ID=myuser USER_TOKEN=... npx tsx scripts/discover-channels.ts
```

### Interactive test client

Connects as a test user, watches a channel, and lets you send messages interactively while printing incoming bot responses and AI indicator events:

```bash
# Auto-discover channels and use the first one
npx tsx scripts/test-client.ts

# Specify a channel
npx tsx scripts/test-client.ts myChannelId

# Send a single message
npx tsx scripts/test-client.ts myChannelId "Hello bot"
```

Commands inside the interactive client:

| Command | Description |
|---------|-------------|
| `/thread <parentId> <text>` | Send a thread reply |
| `/quote <messageId> <text>` | Send a quoted reply |
| `/quit` | Disconnect and exit |

Override the test user with environment variables:

```bash
STREAM_API_KEY=... TEST_USER_ID=myuser TEST_USER_TOKEN=... npx tsx scripts/test-client.ts
```

### Automated round-trip test

Sends a message and waits for the bot to respond, verifying the full streaming lifecycle (placeholder message, AI indicators, partial updates, final update):

```bash
npx tsx scripts/test-roundtrip.ts
```

Expected output:

```
[NEW MSG][chatgpt] [AI]: (no text)        # empty placeholder
[AI INDICATOR] AI_STATE_THINKING           # thinking indicator
[AI INDICATOR] AI_STATE_GENERATING         # generating indicator
[STREAMING] 2 + 2 = 4.                    # partial update
[FINAL] 2 + 2 = 4.                        # final update (generating: false)
[AI INDICATOR] cleared                     # indicator cleared

✓ Round-trip test PASSED — got bot response.
```

### Thread test

Sends a parent message, waits for the bot's response, then sends a thread reply and verifies the bot responds inside the thread:

```bash
npx tsx scripts/test-thread.ts
```

## How it works

**Inbound flow:**
1. Bot receives `message.new` event via WebSocket
2. Plugin filters out bot's own messages and AI-generated messages
3. Builds an envelope with thread/reply context wrappers (`[Thread]`, `[Replying]`)
4. Dispatches to the OpenClaw agent pipeline

**Outbound flow (streaming):**
1. Creates an empty placeholder message with `ai_generated: true`
2. Sends `ai_indicator.update` with `AI_STATE_THINKING`
3. On first text chunk, switches to `AI_STATE_GENERATING`
4. Progressively updates the message via `partialUpdateMessage` with `generating: true`
5. On completion, sends final update with `generating: false` and clears the indicator

**Thread handling:**
- Thread replies include `parent_id` so the bot's response routes to the correct thread
- First message in a thread includes the parent message text for context
- Quoted replies are wrapped in `[Replying to ...]` envelopes
