# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Type-check the plugin (no emit)
npm run type-check          # tsc --noEmit

# Run individual test scripts (no build step needed — tsx runs TS directly)
npx tsx scripts/generate-bot-token.ts
npx tsx scripts/discover-channels.ts
npx tsx scripts/chat-client.ts
npx tsx scripts/test-roundtrip.ts
npx tsx scripts/test-thread.ts

# Restart the gateway after code changes
openclaw gateway restart
```

There is no build step for the plugin itself. OpenClaw loads it directly from TypeScript source via `tsx`. The `scripts/` directory is excluded from `tsconfig.json`; scripts are run standalone with `npx tsx`.

The `openclaw/plugin-sdk` import alias resolves to `../openclaw/dist/plugin-sdk/plugin-sdk/index.d.ts`. If that file is missing, rebuild it:

```bash
cd ../openclaw && tsc -p tsconfig.plugin-sdk.dts.json
```

## Architecture

### Plugin registration

`index.ts` is the plugin entry point. It exports a default object conforming to `OpenClawPluginDefinition`: the `register(api)` method stores the framework runtime singleton (`setStreamChatRuntime`) and calls `api.registerChannel({ plugin: streamchatPlugin })`.

The OpenClaw framework discovers the plugin via `plugins.load.paths` in `~/.openclaw/openclaw.json`, looks for `openclaw.plugin.json` in the directory, then loads the extension listed in `package.json#openclaw.extensions`.

**Config wiring gotchas:**
- The `plugins.entries` key must equal the manifest `id` field (`"streamchat"`), not the package name (`@wunderchat/openclaw-channel-streamchat`) or directory name. Using the wrong key causes a `plugin not found` validation error at startup.
- `PluginEntryConfig` only accepts `{ enabled, config }`. Any other field (e.g. `source`) will be rejected with `Unrecognized key`.
- Config validation runs before plugin loading, so `plugins.load.paths` and `plugins.entries` must both be correct before the gateway will start.
- There will always be a harmless cosmetic warning: `plugin id mismatch (manifest uses "streamchat", entry hints "openclaw-channel-streamchat")`. This is because the directory name differs from the manifest id and can be ignored.

### Source module map

| File | Responsibility |
|---|---|
| `src/channel.ts` | Main plugin export (`streamchatPlugin`). Contains `handleStreamChatMessage` (inbound dispatch) and the `ChannelPlugin` adapter implementations: `config`, `outbound`, `gateway`, `status`. |
| `src/stream-chat-runtime.ts` | `StreamChatClientRuntime` — wraps the `stream-chat` SDK. Connects as bot user (`allowServerSideConnect: true` is required for Node.js server contexts), queries + watches channels on startup, auto-watches channels added later via `notification.added_to_channel`. |
| `src/streaming.ts` | `StreamingHandler` — manages the AI streaming lifecycle per run: creates placeholder message → sends `ai_indicator` events → calls `partialUpdateMessage` on throttled chunks → finalizes on completion. |
| `src/run-context.ts` | `RunContextMap` — binds an OpenClaw `runId` (UUID generated per inbound message) to delivery routing state: `channelId`, `threadParentId`, `responseMessageId`. TTL of 5 min. |
| `src/envelope.ts` | `buildEnvelope` — wraps the raw message text in `[Thread]` / `[Replying to]` XML-like tags so the LLM receives thread and quote context in the single-session model. |
| `src/types.ts` | `StreamChatChannelConfig`, `ResolvedAccount`, `RunContext`, `EnvelopeResult` interfaces, plus config helper functions (`getStreamChatConfig`, `resolveStreamChatAccount`). |
| `src/config-schema.ts` | Zod schema for `channels.streamchat.*` config. Uses `z.lazy()` for the recursive `accounts` sub-map (multi-account support). |
| `src/runtime.ts` | Module-level singleton accessor (`getStreamChatRuntime` / `setStreamChatRuntime`) for the `PluginRuntime` injected by OpenClaw at registration time. |
| `src/stream-chat.d.ts` | Module augmentation adding `generating?: boolean` and `ai_generated?: boolean` to `CustomMessageData`. |
| `src/utils.ts` | `truncate` and `safeAsync` helpers. |

### Inbound flow

```
message.new (WebSocket)
  → handleStreamChatMessage
      → skip if event.user.id === botUserId  (own messages)
      → skip if message.ai_generated === true (own placeholder/streamed messages)
      → resolveAgentRoute   (peer kind: "channel", id: channelId)
      → buildEnvelope       (wraps text with thread/reply context tags)
      → finalizeInboundContext
      → recordInboundSession
      → onRunStarted        (pre-creates placeholder + THINKING indicator)
      → dispatchReplyWithBufferedBlockDispatcher
          replyOptions.onPartialReply fires per streaming token (cumulative text):
            delta = full.slice(lastPartialText.length) → onTextChunk (throttled partialUpdateMessage)
          deliver(payload, info) called once per complete block:
            info.kind === "tool"  → onRunProgress (EXTERNAL_SOURCES indicator)
            payload.isError       → onRunError (error text + ERROR indicator)
            text block            → no-op (already handled token-by-token above)
          after dispatcher returns:
            → onRunCompleted (final partialUpdateMessage + ai_indicator.clear)
```

**Why pre-create the placeholder:** `onPartialReply` is called fire-and-forget (`void`) by OpenClaw, so it cannot safely do async work (like `channel.sendMessage`). The placeholder must exist before the first token arrives.

The `ai_generated: true` check is critical — without it the bot would trigger on its own empty placeholder message created by `onRunStarted`, causing an infinite loop.

### Event mapping

How each signal from the OpenClaw pipeline translates into Stream Chat API calls or channel events:

| Trigger | Stream Chat action | Notes |
|---|---|---|
| Inbound message received | `channel.sendReaction(msgId, { type: "eyes" })` | Ack reaction, fire-and-forget |
| Pre-dispatch (before agent runs) | `channel.sendMessage({ text: "", ai_generated: true })` | Creates the bot's placeholder message |
| Pre-dispatch (before agent runs) | `channel.sendEvent({ type: "ai_indicator.update", ai_state: "AI_STATE_THINKING" })` | Sent immediately with placeholder |
| `onPartialReply` first token | `channel.sendEvent({ type: "ai_indicator.update", ai_state: "AI_STATE_GENERATING" })` | Transitions from THINKING on the very first token |
| `onPartialReply` per token — throttled | `client.partialUpdateMessage(msgId, { set: { text, generating: true } })` | Delta-computed from cumulative text. Odd chunks 1,3,5,7; then every N (default 15). Chained via `lastUpdatePromise` to avoid out-of-order updates |
| `deliver` with `info.kind === "tool"` | `channel.sendEvent({ type: "ai_indicator.update", ai_state: "AI_STATE_EXTERNAL_SOURCES" })` | Only emitted once per run (de-duplicated by `indicatorState`) |
| Dispatcher resolves (run complete) | `client.partialUpdateMessage(msgId, { set: { text, generating: false } })` | Final flush, waits for any in-flight partial updates first |
| Dispatcher resolves (run complete) | `channel.sendEvent({ type: "ai_indicator.clear" })` | Clears the indicator bubble |
| Dispatcher resolves (run complete) | `channel.deleteReaction(inboundMsgId, "eyes")` → `channel.sendReaction(inboundMsgId, { type: "white_check_mark" })` | Reaction swap on the original user message |
| `deliver` with `payload.isError` | `client.partialUpdateMessage(msgId, { set: { text: "…\n\nError: …", generating: false } })` | Appends error to any partial text already accumulated |
| `deliver` with `payload.isError` | `channel.sendEvent({ type: "ai_indicator.update", ai_state: "AI_STATE_ERROR" })` | Leaves the error indicator visible (no `ai_indicator.clear`) |
| `ai_indicator.stop` from client | `client.partialUpdateMessage(msgId, { set: { generating: false } })` | Clears the generating flag without touching the accumulated text |
| `ai_indicator.stop` from client | `channel.sendEvent({ type: "ai_indicator.clear" })` | |

The `ai_indicator` events are sent via `safeSendEvent`, which retries up to 5 times on 429/5xx with exponential backoff (100 ms base, doubles each attempt) and swallows the error rather than aborting delivery if all retries fail.

### Outbound streaming lifecycle

Each agent run that produces text goes through these steps in `StreamingHandler`:

1. `onRunStarted` — `channel.sendMessage({ text: "", ai_generated: true })` → `ai_indicator.update(AI_STATE_THINKING)`
2. `onTextChunk` — accumulates text, switches indicator to `AI_STATE_GENERATING` on first chunk, calls `client.partialUpdateMessage({ set: { text, generating: true } })` throttled (early burst: odd chunks < 8; then every Nth chunk, default N=15)
3. `onRunCompleted` — waits for in-flight partial updates, sends final `partialUpdateMessage({ generating: false })`, sends `ai_indicator.clear`

Force-stop (`ai_indicator.stop` from client) calls `onForceStop`, which clears `generating` without overwriting the accumulated text.

### Session model

Each Stream Chat channel maps to exactly one OpenClaw session:

```
agent:<agentId>:streamchat:channel:<channelId>
```

This is achieved by passing `peer: { kind: "channel", id: channelId }` to `resolveAgentRoute`. The "channel" peer kind bypasses the `dmScope` logic and always builds per-channel keys. Do not use `peer.kind: "direct"` — with the framework default of `dmScope: "main"`, all direct-peer messages collapse into a single shared session (`agent:main:main`), so all channels would share one conversation context.

All messages in a channel — main feed and threads — go to the same session. Thread context is injected into the prompt via `buildEnvelope` wrappers, not via separate sessions. This preserves cross-thread LLM context.

### Multi-account support

Config supports a flat default account or named sub-accounts:

```jsonc
"channels": {
  "streamchat": {
    "apiKey": "...",         // default account
    "accounts": {
      "workspace-b": { "apiKey": "..." }  // named account
    }
  }
}
```

`resolveStreamChatAccount(cfg, accountId)` merges the named account config over the base config. Each account gets its own `StreamChatClientRuntime`, `RunContextMap`, and `StreamingHandler` instance (created in `gateway.startAccount`).

## Key design decisions

- **Bot token in config, secret is not.** The API secret is only used in `scripts/generate-bot-token.ts` to mint a JWT. Only the resulting token is stored in `openclaw.json`.
- **`deliver` callback vs. completion signal.** `dispatchReplyWithBufferedBlockDispatcher` signals completion by resolving its promise, not by passing an `isComplete` flag. The `info.kind` parameter (`"tool" | "block" | "final"`) distinguishes delivery type. `onRunCompleted` is called after the dispatcher awaits. The `ReplyPayload` type has `text` and `isError` as the only relevant fields — there is no `markdown`, `isComplete`, or `toolName` field, despite what seems intuitive.
- **Partial updates are chained via `lastUpdatePromise`.** Each `partialUpdateMessage` is `.then()`-chained onto the previous one to avoid out-of-order message text.
- **`safeSendEvent` swallows errors.** Indicator events are best-effort; a failed `ai_indicator` update must not abort message delivery. Retries: 5 attempts, exponential backoff starting at 100 ms, only on 429/5xx.
- **`seenThreads` is process-scoped.** The `Set<string>` tracking "first message in thread" lives at module level, so it persists across gateway reloads until the process restarts. This is intentional — it avoids re-sending parent context for active threads after a config reload.
- **`onTextChunk` receives deltas despite the wire protocol using full text.** `onPartialReply` provides cumulative text; `channel.ts` extracts the delta before calling `onTextChunk`. Inside `StreamingHandler`, `onTextChunk` re-accumulates deltas into `accumulatedText` and passes that full string to `partialUpdateMessage`. The round-trip is: cumulative → delta → cumulative. The delta extraction exists because `StreamingHandler` was designed around the "streaming chunks" mental model — it owns the accumulation and the throttle counter, making that API feel natural. The redundancy is intentional for architectural clarity, not a bug.
