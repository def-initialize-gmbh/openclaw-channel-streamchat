import type { ChannelLogSink } from "openclaw/plugin-sdk";

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function safeAsync(
  fn: () => Promise<unknown>,
  log?: ChannelLogSink,
  label?: string,
): void {
  fn().catch((err) => {
    log?.error?.(`[StreamChat]${label ? ` ${label}` : ""} ${String(err)}`);
  });
}
