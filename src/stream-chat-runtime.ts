import { StreamChat } from "stream-chat";
import type { Channel, Event } from "stream-chat";
import type { ChannelLogSink } from "openclaw/plugin-sdk";
import type { ResolvedAccount } from "./types.js";

export class StreamChatClientRuntime {
  private client: StreamChat;
  private channels = new Map<string, Channel>();
  private account: ResolvedAccount;
  private log?: ChannelLogSink;
  private connected = false;

  constructor(account: ResolvedAccount, log?: ChannelLogSink) {
    this.account = account;
    this.log = log;
    this.client = new StreamChat(account.apiKey, {
      allowServerSideConnect: true,
    });
  }

  async start(): Promise<void> {
    const { botUserId, botUserToken, botUserName } = this.account;

    this.log?.info?.(`[StreamChat] Connecting as ${botUserId}...`);

    await this.client.connectUser(
      { id: botUserId, name: botUserName || botUserId },
      botUserToken,
    );
    this.connected = true;

    this.log?.info?.(`[StreamChat] Connected. Querying channels...`);

    const filters = { members: { $in: [botUserId] } };
    const sort = [{ last_message_at: -1 as const }];
    const channelList = await this.client.queryChannels(filters, sort, {
      watch: true,
      limit: 30,
    });

    for (const ch of channelList) {
      const key = `${ch.type}:${ch.id}`;
      this.channels.set(key, ch);
    }

    this.log?.info?.(
      `[StreamChat] Watching ${channelList.length} channel(s).`,
    );

    // Auto-watch new channels the bot is added to
    this.client.on("notification.added_to_channel", (event: Event) => {
      if (event.channel) {
        const ch = this.client.channel(
          event.channel.type,
          event.channel.id,
        );
        ch.watch().then(() => {
          const key = `${event.channel!.type}:${event.channel!.id}`;
          this.channels.set(key, ch);
          this.log?.info?.(
            `[StreamChat] Auto-watching new channel ${key}`,
          );
        }).catch((err) => {
          this.log?.error?.(
            `[StreamChat] Failed to watch channel: ${String(err)}`,
          );
        });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.connected) {
      this.log?.info?.(`[StreamChat] Disconnecting...`);
      await this.client.disconnectUser();
      this.connected = false;
      this.channels.clear();
      this.log?.info?.(`[StreamChat] Disconnected.`);
    }
  }

  getClient(): StreamChat {
    return this.client;
  }

  getChannel(type: string, id: string): Channel | undefined {
    return this.channels.get(`${type}:${id}`);
  }

  async getOrQueryChannel(type: string, id: string): Promise<Channel> {
    const existing = this.channels.get(`${type}:${id}`);
    if (existing) return existing;

    const ch = this.client.channel(type, id);
    await ch.watch();
    this.channels.set(`${type}:${id}`, ch);
    return ch;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
