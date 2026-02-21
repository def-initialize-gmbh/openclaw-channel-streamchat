import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setStreamChatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getStreamChatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("StreamChat runtime not initialized");
  }
  return runtime;
}
