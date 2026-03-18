import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { writeFile, readFile, unlink, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { lookup as mimeLookup } from "mime-types";
import type { Attachment, Channel, Event } from "stream-chat";
import type {
  ChannelGatewayContext,
  ChannelLogSink,
  ChannelOutboundContext,
  OpenClawConfig,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import { buildAgentMediaPayload, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { StreamChatConfigSchema } from "./config-schema.js";
import { getStreamChatRuntime } from "./runtime.js";
import { StreamChatClientRuntime } from "./stream-chat-runtime.js";
import { StreamingHandler } from "./streaming.js";
import { RunContextMap } from "./run-context.js";
import { buildEnvelope } from "./envelope.js";
import { safeAsync } from "./utils.js";
import type {
  ResolvedAccount,
  StreamChatChannelPlugin,
  RunContext,
} from "./types.js";
import {
  listStreamChatAccountIds,
  resolveStreamChatAccount,
} from "./types.js";

// Track which threads we've already seen (for first-in-thread detection)
const seenThreads = new Set<string>();

// Module-level registry of active gateway cleanup functions keyed by accountId.
// Allows startAccount to force-stop a stale connection if the framework calls
// startAccount again without having called stop() first (e.g. in-process reloads).
const activeGatewayCleanup = new Map<string, () => void>();

// ---------------------------------------------------------------------------
// Reactions helper
// ---------------------------------------------------------------------------

async function addReaction(
  runtime: StreamChatClientRuntime,
  channelType: string,
  channelId: string,
  messageId: string,
  reactionType: string,
  log?: ChannelLogSink,
): Promise<void> {
  try {
    const channel = await runtime.getOrQueryChannel(channelType, channelId);
    await channel.sendReaction(messageId, { type: reactionType });
  } catch (err) {
    log?.warn?.(
      `[StreamChat] Failed to add reaction ${reactionType}: ${String(err)}`,
    );
  }
}

async function removeReaction(
  runtime: StreamChatClientRuntime,
  channelType: string,
  channelId: string,
  messageId: string,
  reactionType: string,
  log?: ChannelLogSink,
): Promise<void> {
  try {
    const channel = await runtime.getOrQueryChannel(channelType, channelId);
    await channel.deleteReaction(messageId, reactionType);
  } catch (err) {
    log?.warn?.(
      `[StreamChat] Failed to remove reaction ${reactionType}: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

const MAX_MEDIA_FILES = 8;
const DEFAULT_MEDIA_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/** Attachments that carry downloadable media files. */
function isMediaAttachment(att: Attachment): boolean {
  return Boolean(att.asset_url || att.image_url);
}

/** Resolves the download URL for a Stream Chat attachment. */
function resolveAttachmentUrl(att: Attachment): string | undefined {
  return att.asset_url || att.image_url || undefined;
}

/** Builds a human-readable label for an attachment (used in the envelope). */
function attachmentLabel(att: Attachment): string {
  const name = att.title || att.type || "file";
  return `[Attachment: ${name}]`;
}

type ResolvedMedia = {
  path: string;
  contentType?: string;
  label: string;
};

const execFileAsync = promisify(execFile);

/** MIME types that need conversion to OGG before passing to OpenClaw. */
const WAV_MIMES = new Set(["audio/wav", "audio/wave", "audio/x-wav"]);

/**
 * Converts a WAV buffer to OGG (Opus) via ffmpeg.
 * Returns the converted buffer, or the original buffer if ffmpeg is unavailable
 * or conversion fails.
 */
async function convertWavToOgg(
  buffer: Buffer,
  log?: ChannelLogSink,
): Promise<{ buffer: Buffer; contentType: string; ext: string }> {
  const id = randomUUID();
  const wavPath = join(tmpdir(), `${id}.wav`);
  const oggPath = join(tmpdir(), `${id}.ogg`);
  try {
    await writeFile(wavPath, buffer);
    await execFileAsync("ffmpeg", [
      "-i", wavPath,
      "-c:a", "libopus",
      "-y", oggPath,
    ], { timeout: 15_000 });
    const oggBuffer = await readFile(oggPath);
    return { buffer: oggBuffer, contentType: "audio/ogg", ext: ".ogg" };
  } catch (err) {
    log?.warn?.(`[StreamChat] WAV→OGG conversion failed, passing WAV as-is: ${String(err)}`);
    return { buffer, contentType: "audio/wav", ext: ".wav" };
  } finally {
    await unlink(wavPath).catch(() => {});
    await unlink(oggPath).catch(() => {});
  }
}

/**
 * Downloads Stream Chat attachments and saves them locally via the OpenClaw
 * media pipeline. Returns an array of resolved media entries (empty if none
 * could be downloaded).
 */
async function resolveStreamChatMedia(
  attachments: Attachment[],
  maxBytes: number,
  log?: ChannelLogSink,
): Promise<ResolvedMedia[]> {
  const rt = getStreamChatRuntime();
  const candidates = attachments.filter(isMediaAttachment).slice(0, MAX_MEDIA_FILES);
  const results: ResolvedMedia[] = [];

  for (const att of candidates) {
    const url = resolveAttachmentUrl(att);
    if (!url) continue;

    try {
      const fetched = await rt.channel.media.fetchRemoteMedia({
        url,
        filePathHint: att.title ?? undefined,
        maxBytes,
      });
      if (fetched.buffer.byteLength > maxBytes) continue;

      let mediaBuffer = fetched.buffer;
      let contentType = att.mime_type ?? fetched.contentType;
      let fileName = att.title ?? fetched.fileName;

      // Convert WAV to OGG — OpenClaw's mime-to-extension map lacks audio/wav,
      // so WAV files get saved without an extension and aren't transcribed.
      if (contentType && WAV_MIMES.has(contentType.split(";")[0]?.trim().toLowerCase())) {
        const converted = await convertWavToOgg(mediaBuffer, log);
        mediaBuffer = converted.buffer;
        contentType = converted.contentType;
        if (fileName) {
          fileName = fileName.replace(/\.wav$/i, converted.ext);
        }
      }

      if (mediaBuffer.byteLength > maxBytes) continue;

      const saved = await rt.channel.media.saveMediaBuffer(
        mediaBuffer,
        contentType,
        "inbound",
        maxBytes,
        fileName,
      );

      results.push({
        path: saved.path,
        contentType: contentType ?? saved.contentType,
        label: attachmentLabel(att),
      });
    } catch (err) {
      log?.warn?.(
        `[StreamChat] Failed to download attachment "${att.title ?? url}": ${String(err)}`,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Outbound media helpers
// ---------------------------------------------------------------------------

const AUDIO_MIMES = new Set([
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/ogg", "audio/wav",
  "audio/wave", "audio/x-wav", "audio/x-m4a", "audio/aac", "audio/flac",
  "audio/webm",
]);

function isAudioMime(mime?: string): boolean {
  if (!mime) return false;
  return AUDIO_MIMES.has(mime.split(";")[0]?.trim().toLowerCase());
}

/**
 * Uploads a local media file to Stream Chat and returns a Stream Chat
 * attachment object ready to be added to a message.
 */
async function uploadOutboundMedia(
  ch: Channel,
  localPath: string,
  audioAsVoice: boolean,
  log?: ChannelLogSink,
): Promise<Attachment | null> {
  try {
    const fileStat = await stat(localPath);
    if (!fileStat.isFile()) return null;

    const fileName = basename(localPath);
    const ext = extname(localPath).toLowerCase();
    const mimeType = mimeLookup(ext) || "application/octet-stream";
    const buffer = await readFile(localPath);

    const uploadResp = await ch.sendFile(
      buffer as unknown as Parameters<typeof ch.sendFile>[0],
      fileName,
      mimeType,
    );
    const assetUrl = uploadResp.file;

    const isAudio = isAudioMime(mimeType);
    const attachmentType = isAudio && audioAsVoice ? "voiceRecording" : isAudio ? "audio" : "file";

    const att: Attachment = {
      type: attachmentType,
      asset_url: assetUrl,
      mime_type: mimeType,
      title: fileName,
      file_size: fileStat.size,
    };

    if (attachmentType === "voiceRecording") {
      att.waveform_data = new Array(100).fill(0.5);
    }

    log?.info?.(`[StreamChat] Uploaded outbound media: ${fileName} → ${attachmentType}`);
    return att;
  } catch (err) {
    log?.warn?.(`[StreamChat] Failed to upload outbound media "${localPath}": ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inbound message handler
// ---------------------------------------------------------------------------

interface HandleMessageParams {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedAccount;
  event: Event;
  chatRuntime: StreamChatClientRuntime;
  streamingHandler: StreamingHandler;
  runContexts: RunContextMap;
  log?: ChannelLogSink;
}

async function handleStreamChatMessage(params: HandleMessageParams): Promise<void> {
  const {
    cfg,
    accountId,
    account,
    event,
    chatRuntime,
    streamingHandler,
    runContexts,
    log,
  } = params;
  const rt = getStreamChatRuntime();

  const message = event.message;
  if (!message) return;

  // Bot echo prevention: skip our own messages and AI-generated messages
  if (event.user?.id === account.botUserId) return;
  if (message.ai_generated) return;

  const text = message.text?.trim() ?? "";
  const attachments = message.attachments ?? [];
  const hasMedia = attachments.some(isMediaAttachment);

  // Require either text or downloadable media
  if (!text && !hasMedia) return;

  const channelType = event.channel_type ?? "messaging";
  const channelId = event.channel_id ?? "";
  const messageId = message.id;
  const senderId = event.user?.id ?? "unknown";
  const senderName = event.user?.name || senderId;

  // Determine thread and reply context
  const threadParentId = message.parent_id ?? null;
  const quotedMessageId = message.quoted_message_id ?? null;
  const quotedMessage = message.quoted_message ?? null;

  // Resolve agent route
  // Use peer kind "channel" so the framework builds per-channel session keys:
  //   agent:<agentId>:streamchat:channel:<channelId>
  // This ensures each Stream Chat channel gets its own session (per action plan).
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: "streamchat",
    accountId,
    peer: { kind: "channel", id: channelId },
  });

  const storePath = rt.channel.session.resolveStorePath(
    cfg.session?.store,
    { agentId: route.agentId },
  );

  // Build envelope with thread/reply context
  let threadParentInfo: {
    id: string;
    text?: string;
    userId?: string;
    userName?: string;
  } | null = null;

  if (threadParentId) {
    // Try to get the parent message for context
    try {
      const channel = await chatRuntime.getOrQueryChannel(channelType, channelId);
      await channel.getReplies(threadParentId, { limit: 0 });
      // The parent message is embedded in the channel messages
      const state = channel.state;
      const parentMsg = state.messages.find((m) => m.id === threadParentId);
      threadParentInfo = {
        id: threadParentId,
        text: parentMsg?.text ?? undefined,
        userId: parentMsg?.user?.id ?? undefined,
        userName: parentMsg?.user?.name ?? undefined,
      };
    } catch {
      threadParentInfo = { id: threadParentId };
    }
  }

  let quotedInfo: {
    id: string;
    text?: string;
    userId?: string;
    userName?: string;
  } | null = null;

  if (quotedMessageId || quotedMessage) {
    quotedInfo = {
      id: quotedMessageId ?? quotedMessage?.id ?? "",
      text: quotedMessage?.text ?? undefined,
      userId: quotedMessage?.user?.id ?? undefined,
      userName: quotedMessage?.user?.name ?? undefined,
    };
  }

  const isFirstInThread = threadParentId
    ? !seenThreads.has(threadParentId)
    : false;
  if (threadParentId) seenThreads.add(threadParentId);

  // Download media attachments (if any)
  const media = hasMedia
    ? await resolveStreamChatMedia(attachments, DEFAULT_MEDIA_MAX_BYTES, log)
    : [];

  // For attachment-only messages, synthesize a text body describing the attachments
  // so the LLM receives something meaningful.
  const effectiveText = text || media.map((m) => m.label).join("\n");

  const envelope = buildEnvelope({
    text: effectiveText,
    senderId,
    senderName,
    messageId,
    quotedMessage: quotedInfo,
    threadParent: threadParentInfo,
    isFirstInThread,
  });

  // Build media payload for OpenClaw
  const mediaPayload = media.length > 0
    ? buildAgentMediaPayload(
        media.map((m) => ({
          path: m.path,
          contentType: m.contentType ?? null,
        })),
      )
    : {};

  // Finalize inbound context
  const to = channelId;
  const fromLabel = `${senderName} (${senderId})`;

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: envelope.body,
    RawBody: text || effectiveText,
    CommandBody: envelope.commandBody,
    From: to,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: "channel" as const,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "streamchat",
    Surface: "streamchat",
    MessageSid: messageId,
    Timestamp: message.created_at
      ? new Date(message.created_at).getTime()
      : Date.now(),
    OriginatingChannel: "streamchat",
    OriginatingTo: to,
    ...mediaPayload,
  });

  // Record session
  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "streamchat",
      to,
      accountId,
    },
    onRecordError: (err: unknown) => {
      log?.error?.(
        `[StreamChat] Failed to record inbound session: ${String(err)}`,
      );
    },
  });

  log?.info?.(
    `[StreamChat] Inbound: from=${senderName} text="${effectiveText.slice(0, 50)}"${media.length > 0 ? ` media=${media.length}` : ""}`,
  );

  // Send ack reaction
  if (account.ackReaction) {
    safeAsync(
      () =>
        addReaction(
          chatRuntime,
          channelType,
          channelId,
          messageId,
          account.ackReaction,
          log,
        ),
      log,
      "ack reaction",
    );
  }

  // Create RunContext for delivery routing
  const runId = randomUUID();
  const runCtx: RunContext = {
    runId,
    channelType,
    channelId,
    threadParentId,
    inboundMessageId: messageId,
    senderId,
    responseMessageId: null,
  };
  runContexts.set(runId, runCtx);

  // Pre-create the placeholder message before dispatch so the message ID is
  // available when onPartialReply fires (which is called fire-and-forget by
  // OpenClaw and cannot safely do async work itself).
  const responseChannel = await chatRuntime.getOrQueryChannel(channelType, channelId);
  await streamingHandler.onRunStarted(runId, responseChannel, runCtx);

  let errorDelivered = false;

  // Track cumulative text from onPartialReply to compute per-token deltas.
  // onPartialReply gives full accumulated text so far ("2", "2 +", "2 + 2 = 4"),
  // while onTextChunk expects a delta and appends it. We slice to get the new portion.
  let lastPartialText = "";

  // Dispatch reply via the buffered block dispatcher.
  // onPartialReply fires for every streaming token (preview streaming).
  // deliver is called once per complete block; used here only for tool/error events.
  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    replyOptions: {
      onPartialReply: (payload: { text?: string }) => {
        const full = payload.text ?? "";
        const delta = full.slice(lastPartialText.length);
        lastPartialText = full;
        if (delta) {
          void streamingHandler.onTextChunk(runId, delta, account.streamingThrottle);
        }
      },
    },
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (
        payload: ReplyPayload,
        info: { kind: string },
      ) => {
        try {
          // Tool progress: update indicator to EXTERNAL_SOURCES
          if (info.kind === "tool") {
            await streamingHandler.onRunProgress(runId);
            return;
          }

          // Error: finalize with error state
          if (payload.isError) {
            await streamingHandler.onRunError(
              runId,
              payload.text || "Unknown error",
            );
            errorDelivered = true;
            return;
          }

          // Media attachments: upload to Stream Chat and queue for final message
          const mediaUrls = [
            ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ...(payload.mediaUrls ?? []),
          ];
          for (const mediaPath of mediaUrls) {
            const att = await uploadOutboundMedia(
              responseChannel,
              mediaPath,
              payload.audioAsVoice ?? false,
              log,
            );
            if (att) {
              streamingHandler.addAttachment(runId, att);
            }
          }

          // Text blocks are handled token-by-token via onPartialReply above.
        } catch (err) {
          log?.error?.(
            `[StreamChat] Deliver failed: ${String(err)}`,
          );
          throw err;
        }
      },
    },
  });

  // Finalize after all deliveries complete
  if (!errorDelivered) {
    await streamingHandler.onRunCompleted(runId);
  }

  // Swap ack → done reaction
  if (account.ackReaction && account.doneReaction) {
    safeAsync(
      async () => {
        await removeReaction(
          chatRuntime,
          channelType,
          channelId,
          messageId,
          account.ackReaction,
          log,
        );
        await addReaction(
          chatRuntime,
          channelType,
          channelId,
          messageId,
          account.doneReaction,
          log,
        );
      },
      log,
      "reaction swap",
    );
  }

  runContexts.delete(runId);
}

// ---------------------------------------------------------------------------
// Channel plugin definition
// ---------------------------------------------------------------------------

export const streamchatPlugin: StreamChatChannelPlugin = {
  id: "streamchat",

  meta: {
    id: "streamchat",
    label: "Stream Chat",
    selectionLabel: "Stream Chat",
    docsPath: "/channels/streamchat",
    blurb: "Stream Chat messaging channel with AI streaming support.",
    aliases: ["sc"],
  },

  capabilities: {
    chatTypes: ["channel"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },

  reload: { configPrefixes: ["channels.streamchat"] },

  configSchema: buildChannelConfigSchema(StreamChatConfigSchema),

  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] =>
      listStreamChatAccountIds(cfg),

    resolveAccount: (
      cfg: OpenClawConfig,
      accountId?: string | null,
    ): ResolvedAccount => resolveStreamChatAccount(cfg, accountId),

    defaultAccountId: () => "default",

    isConfigured: (account: ResolvedAccount): boolean =>
      Boolean(account.apiKey && account.botUserId && account.botUserToken),

    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: account.botUserName || account.botUserId || undefined,
      enabled: account.enabled,
      configured: account.configured,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    }),
  },

  outbound: {
    deliveryMode: "direct",

    sendText: async (ctx: ChannelOutboundContext) => {
      const account = resolveStreamChatAccount(ctx.cfg, ctx.accountId);
      if (!account.configured) {
        throw new Error("StreamChat account not configured");
      }

      // We need to create a temporary client to send the outbound message.
      // In gateway mode, we reuse the running runtime, but for outbound-only
      // we create an ephemeral connection.
      const tempRuntime = new StreamChatClientRuntime(account);
      try {
        await tempRuntime.start();
        const channel = await tempRuntime.getOrQueryChannel(
          "messaging",
          ctx.to,
        );

        const msgPayload: Record<string, unknown> = { text: ctx.text };
        if (ctx.threadId) {
          msgPayload.parent_id = String(ctx.threadId);
        }

        const { message } = await channel.sendMessage(
          msgPayload as Parameters<typeof channel.sendMessage>[0],
        );

        return {
          channel: "streamchat" as const,
          messageId: message.id,
        };
      } finally {
        await tempRuntime.stop();
      }
    },
  },

  gateway: {
    startAccount: async (
      ctx: ChannelGatewayContext<ResolvedAccount>,
    ): Promise<{ stop: () => void }> => {
      const { cfg, accountId, account, log, abortSignal } = ctx;

      if (!account.configured) {
        throw new Error(
          "StreamChat not configured: apiKey, botUserId, and botUserToken are required",
        );
      }

      // Force-stop any stale runtime for this accountId that was never cleaned up
      // (can happen when the framework does an in-process reload without calling stop()).
      const staleCleanup = activeGatewayCleanup.get(accountId);
      if (staleCleanup) {
        log?.warn?.(
          `[StreamChat] Stale connection detected for account "${accountId}" — forcing cleanup before restart`,
        );
        staleCleanup();
      }

      const chatRuntime = new StreamChatClientRuntime(account, log);
      const runContexts = new RunContextMap();
      const streamingHandler = new StreamingHandler({
        client: chatRuntime.getClient(),
        runContexts,
        log,
      });

      // Connect and watch channels
      await chatRuntime.start();

      ctx.setStatus({
        ...ctx.getStatus(),
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      // Listen for new messages
      const client = chatRuntime.getClient();
      const handleMessage = (event: Event) => {
        handleStreamChatMessage({
          cfg,
          accountId,
          account,
          event,
          chatRuntime,
          streamingHandler,
          runContexts,
          log,
        }).catch((err) => {
          log?.error?.(
            `[StreamChat] Message handler error: ${String(err)}`,
          );
        });
      };

      // Listen for force stop from client
      const handleAiStop = (event: Event) => {
        const messageId = (event as unknown as Record<string, unknown>).message_id as string | undefined;
        if (!messageId) return;
        const activeRun = runContexts.findByResponseMessageId(messageId);
        if (activeRun) {
          streamingHandler.onForceStop(activeRun.runId).catch((err) => {
            log?.warn?.(
              `[StreamChat] Force stop error: ${String(err)}`,
            );
          });
        }
      };

      client.on("message.new", handleMessage);
      client.on("ai_indicator.stop" as "user.watching.start", handleAiStop);

      // Handle abort signal / explicit stop — idempotent via `stopped` guard
      let stopped = false;
      const handleAbort = () => {
        if (stopped) return;
        stopped = true;
        client.off("message.new", handleMessage);
        client.off("ai_indicator.stop" as "user.watching.start", handleAiStop);
        activeGatewayCleanup.delete(accountId);
        chatRuntime.stop().catch((err) => {
          log?.error?.(
            `[StreamChat] Disconnect error: ${String(err)}`,
          );
        });
        ctx.setStatus({
          ...ctx.getStatus(),
          running: false,
          lastStopAt: Date.now(),
        });
      };

      activeGatewayCleanup.set(accountId, handleAbort);

      if (abortSignal) {
        abortSignal.addEventListener("abort", handleAbort, { once: true });
      }

      log?.info?.(
        `[StreamChat] Gateway started for account "${accountId}"`,
      );

      return {
        stop: () => {
          handleAbort();
        },
      };
    },
  },

  status: {
    defaultRuntime: {
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: false,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
  },
};
