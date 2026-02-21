import type { EnvelopeResult } from "./types.js";
import { truncate } from "./utils.js";

const MAX_QUOTED_LENGTH = 500;

export interface EnvelopeInput {
  text: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  /** If this message is a reply (quoted_message), include the quoted message info */
  quotedMessage?: {
    id: string;
    text?: string;
    userId?: string;
    userName?: string;
  } | null;
  /** If this message is within a thread, include the thread parent info */
  threadParent?: {
    id: string;
    text?: string;
    userId?: string;
    userName?: string;
  } | null;
  /** Whether this thread has been seen before (subsequent messages skip parent text) */
  isFirstInThread: boolean;
}

export function buildEnvelope(input: EnvelopeInput): EnvelopeResult {
  const { text, quotedMessage, threadParent, isFirstInThread } = input;
  const commandBody = text;

  let body = text;

  // Build reply wrapper if replying to a specific message
  if (quotedMessage) {
    const sender = quotedMessage.userName || quotedMessage.userId || "unknown";
    const quoted = quotedMessage.text
      ? truncate(quotedMessage.text, MAX_QUOTED_LENGTH)
      : "(no text)";
    body = `[Replying to ${sender} id:${quotedMessage.id}]\n${quoted}\n[/Replying]\n${body}`;
  }

  // Wrap in thread context if in a thread
  if (threadParent) {
    if (isFirstInThread) {
      const parentText = threadParent.text
        ? truncate(threadParent.text, MAX_QUOTED_LENGTH)
        : "(no text)";
      body = `[Thread thread:${threadParent.id} on message id:${threadParent.id}]\nParent message: ${parentText}\n${body}\n[/Thread]`;
    } else {
      body = `[Thread thread:${threadParent.id}]\n${body}\n[/Thread]`;
    }
  }

  return { body, commandBody };
}
