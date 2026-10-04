import { getGuildMemoryStore } from "../chatbot/guild-memory";
import { routeWithJev } from "../chatbot/jev-routing";
import { handleCalendarConfirmation } from "../chatbot/calendar-confirmation";
import {
  getInstagramReplyUrls,
  getSocialLinkReplacement,
  getThreadsReplyUrls,
  getTwitterReplyUrls,
} from "./social/social-links";
import {
  canReplaceSocialMessage,
  getSocialProxyIdentity,
} from "./social/social-proxy";
import {
  ChatbotConversationTracker,
  handleChatbotMention,
} from "../chatbot/chatbot";
import {
  prewarmVoiceChatSpeech,
  respondToVoiceChat,
} from "../chatbot/voice-chat";
import { createDiscordRequest, type DiscordRequest } from "./api/request";
import {
  createEphemeralInteractionResponder,
  deferEphemeralInteraction,
  getAskPrompt,
  toInteractionMessage,
  type DiscordApplicationCommandInteraction,
} from "./interactions";
import { ChannelQuietTracker } from "./channel-quiet";
import { transcribeSpeech } from "./local-speech";
import {
  getChatbotAccessConfig,
  type ChatbotAccessConfig,
} from "../chatbot/access";
import {
  AmbientReactionController,
  getAmbientReactionPolicy,
  type AmbientReactionPolicy,
} from "./social/social-reactions";
import { DiscordReactionBroker } from "./api/reactions";
import {
  QuickReplyNudgeTracker,
  QUICK_REPLY_TARGET_USER_ID,
} from "./quick-reply-nudge";
import {
  buildVoiceStateUpdate,
  registerVoiceGateway,
  VoiceStateTracker,
  type DiscordVoiceState,
  type JoinVoiceChannelResult,
  type LeaveVoiceChannelResult,
  type VoiceGateway,
} from "./api/voice";
import { DiscordVoiceChat, type DiscordVoiceChatOptions } from "./voice-chat";
import type { DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";
import { getFeatureAvailabilityStore } from "./feature-availability";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const MESSAGE_CONTENT_LIMIT = 2_000;
const SOCIAL_WEBHOOK_NAME = "MiniSago Social Links";
const MAX_RECONNECT_DELAY_MS = 60_000;
const GUILDS_INTENT = 1 << 0;
const GUILD_VOICE_STATES_INTENT = 1 << 7;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;

type GatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type GatewayHello = {
  heartbeat_interval: number;
};

type GatewayReady = {
  session_id: string;
  guilds?: Array<{ id: string }>;
  resume_gateway_url?: string;
  user?: {
    id?: string;
  };
};

type GatewayGuildCreate = {
  id: string;
  voice_states?: DiscordVoiceState[];
};

type DiscordVoiceServerUpdate = {
  guild_id: string;
};

type DiscordUser = {
  id?: string;
  bot?: boolean;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  discriminator?: string;
};

type DiscordMessageCreate = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  type?: number;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    size: number;
    url: string;
  }>;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  sticker_items?: Array<{ name?: string }>;
  components?: unknown[];
  message_snapshots?: unknown[];
  poll?: unknown;
  referenced_message?: DiscordMessageCreate | null;
  mentions?: DiscordUser[];
  webhook_id?: string;
  author?: DiscordUser;
  member?: {
    nick?: string | null;
    avatar?: string | null;
  };
};

type DiscordChannel = {
  id: string;
  type: number;
  parent_id?: string | null;
};

type DiscordWebhook = {
  id: string;
  token?: string;
  name?: string | null;
  user?: DiscordUser;
};

type DiscordCreatedMessage = {
  id: string;
};

type InstagramGatewayConfig = {
  botToken: string;
  chatbotAccess: ChatbotAccessConfig;
  ambientReactionPolicy: AmbientReactionPolicy;
};

function getInstagramGatewayConfig(): InstagramGatewayConfig | null {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!botToken) {
    console.warn("Instagram gateway disabled: DISCORD_BOT_TOKEN is missing.");
    return null;
  }

  return {
    botToken,
    chatbotAccess: getChatbotAccessConfig(),
    ambientReactionPolicy: getAmbientReactionPolicy(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readGatewayMessage(data: MessageEvent["data"]) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  return String(data);
}

export class ChannelTaskQueue {
  private tails = new Map<string, Promise<void>>();

  async run<T>(channelId: string, task: () => Promise<T>) {
    const previous = this.tails.get(channelId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(channelId, tail);

    try {
      return await current;
    } finally {
      if (this.tails.get(channelId) === tail) {
        this.tails.delete(channelId);
      }
    }
  }
}

function getGatewayCloseReason(code: number) {
  if (code === 4004) {
    return "authentication failed; check DISCORD_BOT_TOKEN";
  }

  if (code === 4013) {
    return "invalid gateway intents requested";
  }

  if (code === 4014) {
    return "disallowed gateway intents; enable the Message Content privileged intent in the Discord Developer Portal";
  }

  return "no specific reason mapped";
}

class InstagramGatewayClient implements VoiceGateway {
  private ambientReactions: AmbientReactionController;
  private channelTasks = new ChannelTaskQueue();
  private conversations = new ChatbotConversationTracker();
  private latestMessages = new Map<string, string>();
  private quietChannels = new ChannelQuietTracker();
  private quickReplyNudges = new QuickReplyNudgeTracker();
  private heartbeatAcked = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private resumeGatewayUrl: string | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  private botUserId: string | null = null;
  private voiceChat: DiscordVoiceChat;
  private voiceAdapters = new Map<
    string,
    DiscordGatewayAdapterLibraryMethods
  >();
  private reactionBroker: DiscordReactionBroker;
  private voiceStates = new VoiceStateTracker();
  private socialWebhookDestinations = new Map<
    string,
    { webhookChannelId: string; threadId?: string }
  >();
  private socialWebhooks = new Map<string, Promise<DiscordWebhook>>();
  private discordRequest: DiscordRequest;
  private featureAvailability = getFeatureAvailabilityStore();

  constructor(private readonly config: InstagramGatewayConfig) {
    this.discordRequest = createDiscordRequest(config.botToken);
    this.reactionBroker = new DiscordReactionBroker();
    this.ambientReactions = new AmbientReactionController({
      policy: config.ambientReactionPolicy,
      reactionBroker: this.reactionBroker,
    });
    const voiceOptions: DiscordVoiceChatOptions = {
      adapterCreator: (guildId) => (methods) => {
        this.voiceAdapters.set(guildId, methods);
        return {
          sendPayload: (payload) => this.sendVoicePayload(payload),
          destroy: () => {
            if (this.voiceAdapters.get(guildId) === methods) {
              this.voiceAdapters.delete(guildId);
            }
          },
        };
      },
      getBotUserId: () => this.botUserId,
      transcribe: transcribeSpeech,
      respond: respondToVoiceChat,
    };
    this.voiceChat = new DiscordVoiceChat(voiceOptions);
  }

  connect() {
    void this.openSocket(false);
  }

  stop() {
    this.stopped = true;
    this.clearHeartbeat();
    this.ambientReactions.stop();
    this.voiceChat.destroy();
    this.socket?.close(1000, "MiniSago shutdown");
    registerVoiceGateway(null);
  }

  joinMemberVoiceChannel(
    guildId: string,
    userId: string,
  ): JoinVoiceChannelResult {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.botUserId) {
      return { status: "gateway_unavailable" };
    }

    const channelId = this.voiceStates.getChannelId(guildId, userId);

    if (!channelId) {
      return { status: "member_not_in_voice" };
    }

    return this.voiceChat.join(guildId, channelId);
  }

  leaveVoiceChannel(guildId: string): LeaveVoiceChannelResult {
    if (this.voiceChat.leave(guildId)) {
      return { status: "left" };
    }

    if (!this.updateVoiceState(guildId, null)) {
      return { status: "gateway_unavailable" };
    }

    return { status: "left" };
  }

  private async openSocket(resume: boolean) {
    const url =
      resume && this.resumeGatewayUrl
        ? `${this.resumeGatewayUrl}?v=10&encoding=json`
        : GATEWAY_URL;

    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      void this.handleGatewayPayload(event);
    });
    this.socket.addEventListener("close", (event) => {
      this.latestMessages.clear();
      this.clearHeartbeat();

      if (this.stopped || !this.shouldReconnect(event.code)) {
        console.warn(
          `Discord gateway closed with code ${event.code}: ${getGatewayCloseReason(event.code)}.`,
        );
        return;
      }

      const canResume = Boolean(this.sessionId && this.sequence !== null);
      void this.reconnect(canResume);
    });
    this.socket.addEventListener("error", () => {
      console.warn("Discord gateway socket error.");
    });
  }

  private async handleGatewayPayload(event: MessageEvent) {
    const payload = JSON.parse(
      readGatewayMessage(event.data),
    ) as GatewayPayload;

    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 0:
        await this.handleDispatch(payload);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.socket?.close(4000, "Discord requested reconnect");
        break;
      case 9:
        await this.handleInvalidSession(Boolean(payload.d));
        break;
      case 10:
        this.handleHello(payload.d as GatewayHello);
        break;
      case 11:
        this.heartbeatAcked = true;
        break;
    }
  }

  private async handleDispatch(payload: GatewayPayload) {
    if (payload.t === "READY") {
      const ready = payload.d as GatewayReady;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.botUserId = ready.user?.id ?? null;
      this.reconnectAttempts = 0;
      console.log("Discord gateway ready.");
      for (const guild of ready.guilds ?? []) {
        void this.ensureGuildMemory(guild.id);
      }
      return;
    }

    if (payload.t === "RESUMED") {
      this.reconnectAttempts = 0;
      console.log("Discord gateway resumed.");
      return;
    }

    if (payload.t === "GUILD_CREATE") {
      const guild = payload.d as GatewayGuildCreate;
      this.voiceStates.replaceGuild(guild.id, guild.voice_states ?? []);
      void this.ensureGuildMemory(guild.id);
      return;
    }

    if (payload.t === "VOICE_STATE_UPDATE") {
      const voiceState = payload.d as DiscordVoiceState;
      this.voiceStates.observe(voiceState);
      if (voiceState.user_id === this.botUserId && voiceState.guild_id) {
        this.voiceAdapters
          .get(voiceState.guild_id)
          ?.onVoiceStateUpdate(payload.d as never);
      }
      return;
    }

    if (payload.t === "VOICE_SERVER_UPDATE") {
      const voiceServer = payload.d as DiscordVoiceServerUpdate;
      this.voiceAdapters
        .get(voiceServer.guild_id)
        ?.onVoiceServerUpdate(payload.d as never);
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      const message = payload.d as DiscordMessageCreate;
      this.latestMessages.delete(message.channel_id);
      this.latestMessages.set(message.channel_id, message.id);
      if (this.latestMessages.size > 2000)
        this.latestMessages.delete(this.latestMessages.keys().next().value!);
      const receivedSequence = this.conversations.recordMessage();
      await this.channelTasks.run(message.channel_id, () =>
        this.handleMessageCreate(message, receivedSequence),
      );
      return;
    }

    if (payload.t === "INTERACTION_CREATE") {
      await this.handleInteractionCreate(
        payload.d as DiscordApplicationCommandInteraction,
      );
    }
  }

  private async ensureGuildMemory(guildId: string) {
    try {
      await getGuildMemoryStore().ensure(guildId);
    } catch {
      console.warn(
        `Discord server memory initialization failed for ${guildId}.`,
      );
    }
  }

  private async handleInteractionCreate(
    interaction: DiscordApplicationCommandInteraction,
  ) {
    try {
      if (await handleCalendarConfirmation(interaction, this.discordRequest))
        return;
    } catch {
      console.error(
        `Calendar confirmation failed for interaction ${interaction.id}.`,
      );
      return;
    }
    const prompt = getAskPrompt(interaction);
    if (!prompt || !interaction.channel_id) return;

    const discordRequest = createDiscordRequest(this.config.botToken);
    try {
      await deferEphemeralInteraction(interaction, discordRequest);
    } catch (error) {
      console.error(
        `Failed to defer /ask interaction ${interaction.id}:`,
        error,
      );
      return;
    }

    const baseRespond = createEphemeralInteractionResponder(
      interaction,
      discordRequest,
    );
    let responseAttempted = false;
    const respond: typeof baseRespond = (...args) => {
      responseAttempted = true;
      return baseRespond(...args);
    };
    void handleChatbotMention({
      message: toInteractionMessage(interaction, prompt),
      botUserId: interaction.application_id,
      discordRequest,
      accessConfig: this.config.chatbotAccess,
      invocation: {
        request: prompt,
        addressingMode: "mention",
        chatOnly: true,
        recentContext: true,
        silent: true,
        respond,
      },
      featureAvailability: this.featureAvailability,
    })
      .then(async (handled) => {
        if (!handled) {
          await respond("我剛剛卡住了 晚點再叫我一次");
        }
      })
      .catch(async (error) => {
        console.error(
          `Failed to handle /ask interaction ${interaction.id}:`,
          error,
        );
        if (!responseAttempted) {
          await respond("我剛剛卡住了 晚點再叫我一次").catch(() => undefined);
        }
      });
  }

  private handleHello(hello: GatewayHello) {
    this.startHeartbeat(hello.heartbeat_interval);

    if (this.sessionId && this.sequence !== null) {
      this.resume();
      return;
    }

    this.identify();
  }

  private startHeartbeat(intervalMs: number) {
    this.clearHeartbeat();
    this.heartbeatAcked = true;

    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcked) {
        this.socket?.close(4000, "Heartbeat ACK timeout");
        return;
      }

      this.sendHeartbeat();
    }, intervalMs);

    setTimeout(() => this.sendHeartbeat(), Math.random() * intervalMs);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendHeartbeat() {
    this.heartbeatAcked = false;
    this.send({
      op: 1,
      d: this.sequence,
    });
  }

  private identify() {
    this.send({
      op: 2,
      d: {
        token: this.config.botToken,
        intents:
          GUILDS_INTENT |
          GUILD_VOICE_STATES_INTENT |
          GUILD_MESSAGES_INTENT |
          DIRECT_MESSAGES_INTENT |
          MESSAGE_CONTENT_INTENT,
        properties: {
          os: process.platform,
          browser: "minisago",
          device: "minisago",
        },
        presence: {
          since: null,
          activities: [
            {
              name: "Custom Status",
              type: 4,
              state: "標我才會讀訊息",
            },
          ],
          status: "online",
          afk: false,
        },
      },
    });
  }

  private resume() {
    this.send({
      op: 6,
      d: {
        token: this.config.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private send(payload: GatewayPayload) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private sendVoicePayload(payload: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.botUserId) {
      return false;
    }

    this.socket.send(JSON.stringify(payload));
    return true;
  }

  private updateVoiceState(guildId: string, channelId: string | null) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.botUserId) {
      return false;
    }

    this.send(buildVoiceStateUpdate(guildId, channelId));
    return true;
  }

  private async handleInvalidSession(canResume: boolean) {
    if (!canResume) {
      this.sessionId = null;
      this.sequence = null;
      this.resumeGatewayUrl = null;
    }

    await sleep(1_000 + Math.random() * 4_000);
    this.socket?.close(4000, "Invalid session");
  }

  private shouldReconnect(code: number) {
    return ![4004, 4010, 4011, 4013, 4014].includes(code);
  }

  private async reconnect(canResume: boolean) {
    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectAttempts += 1;
    await sleep(delay);

    if (!this.stopped) {
      await this.openSocket(canResume);
    }
  }

  private async handleMessageCreate(
    message: DiscordMessageCreate,
    receivedSequence: number,
  ) {
    const shouldNudgeQuickReply =
      !this.quietChannels.isPaused(message.channel_id) &&
      this.quickReplyNudges.observe(message);

    if (shouldNudgeQuickReply) {
      try {
        await this.replyToMessage(
          message,
          `<@${QUICK_REPLY_TARGET_USER_ID}> 今天已經秒回超過三次了 去做點有意義的事啦`,
          [QUICK_REPLY_TARGET_USER_ID],
        );
      } catch (error) {
        console.error(
          `Failed to send quick reply nudge for ${message.id}:`,
          error,
        );
      }
    }

    if (this.botUserId) {
      try {
        const handled = await handleChatbotMention({
          message,
          botUserId: this.botUserId,
          discordRequest: createDiscordRequest(this.config.botToken),
          accessConfig: this.config.chatbotAccess,
          reactionBroker: this.reactionBroker,
          conversationTracker: this.conversations,
          quietTracker: this.quietChannels,
          receivedSequence,
          featureAvailability: this.featureAvailability,
          executionOptions: {
            nonBlockingTyping: true,
            lazyPreviousTrace: true,
            latestMessageId: () => this.latestMessages.get(message.channel_id),
            routeRequest: routeWithJev,
          },
        });

        if (handled) {
          return;
        }
      } catch (error) {
        console.error(`Failed to handle chatbot mention ${message.id}:`, error);
        return;
      }

      if (this.quietChannels.isPaused(message.channel_id)) {
        return;
      }

      if (
        this.featureAvailability.isEnabled("ambient_reactions", {
          guildId: message.guild_id,
          channelId: message.channel_id,
        })
      ) {
        this.ambientReactions.observe({
          message,
          botUserId: this.botUserId,
          discordRequest: createDiscordRequest(this.config.botToken),
          accessConfig: this.config.chatbotAccess,
          featureEnabled: true,
        });
      }
    }

    if (!this.shouldTransformMessage(message)) {
      return;
    }

    const content = message.content ?? "";
    const replyUrls = [
      ...getInstagramReplyUrls(content),
      ...getTwitterReplyUrls(content),
      ...getThreadsReplyUrls(content),
    ];

    if (replyUrls.length === 0) {
      return;
    }

    const replyContent = replyUrls.join("\n");
    const replacementContent = getSocialLinkReplacement(content);

    if (
      replacementContent &&
      replacementContent.length <= MESSAGE_CONTENT_LIMIT &&
      canReplaceSocialMessage(message)
    ) {
      try {
        await this.replaceSocialMessage(message, replacementContent);
        return;
      } catch (error) {
        console.error(
          `Failed to replace social link message ${message.id}; falling back to a reply:`,
          error,
        );
      }
    }

    if (replyContent.length > MESSAGE_CONTENT_LIMIT) {
      console.warn(
        `Skipped social link reply for message ${message.id}: reply content exceeds ${MESSAGE_CONTENT_LIMIT} characters.`,
      );
      try {
        await this.replyToMessage(
          message,
          "這則訊息裡的社群連結太多了 我一次回不完",
        );
      } catch (error) {
        console.error(
          `Failed to send social link length warning for message ${message.id}:`,
          error,
        );
      }
      return;
    }

    try {
      await this.replyToMessage(message, replyContent);
    } catch (error) {
      console.error(
        `Failed to reply to social link for message ${message.id}:`,
        error,
      );
    }
  }

  private shouldTransformMessage(message: DiscordMessageCreate) {
    if (!message.guild_id || !message.content) {
      return false;
    }

    if (message.webhook_id || message.author?.bot) {
      return false;
    }

    return message.author?.id !== this.botUserId;
  }

  private async replaceSocialMessage(
    message: DiscordMessageCreate,
    content: string,
  ) {
    const destination = await this.getSocialWebhookDestination(
      message.channel_id,
    );
    const webhookChannelId = destination.webhookChannelId;
    const webhook = await this.getSocialWebhook(webhookChannelId);

    if (!webhook.token) {
      throw new Error("Social link webhook is missing its token.");
    }

    const identity = getSocialProxyIdentity(message);
    const query = new URLSearchParams({ wait: "true" });
    if (destination.threadId) query.set("thread_id", destination.threadId);

    let proxyMessage: DiscordCreatedMessage;
    try {
      proxyMessage = await this.discordRequest<DiscordCreatedMessage>(
        `/webhooks/${webhook.id}/${webhook.token}?${query}`,
        {
          method: "POST",
          body: {
            content,
            username: identity.username,
            avatar_url: identity.avatarUrl,
            allowed_mentions: { parse: [] },
          },
        },
      );
    } catch (error) {
      this.socialWebhooks.delete(webhookChannelId);
      throw error;
    }

    try {
      await this.discordRequest(
        `/channels/${message.channel_id}/messages/${message.id}`,
        { method: "DELETE" },
      );
    } catch (error) {
      try {
        await this.discordRequest(
          `/webhooks/${webhook.id}/${webhook.token}/messages/${proxyMessage.id}${
            destination.threadId ? `?thread_id=${destination.threadId}` : ""
          }`,
          { method: "DELETE" },
        );
      } catch (cleanupError) {
        console.error(
          `Failed to roll back social link proxy ${proxyMessage.id}:`,
          cleanupError,
        );
      }
      throw error;
    }
  }

  private async getSocialWebhookDestination(channelId: string) {
    const cached = this.socialWebhookDestinations.get(channelId);
    if (cached) return cached;

    const channel = await this.discordRequest<DiscordChannel>(
      `/channels/${channelId}`,
    );
    const isThread = [10, 11, 12].includes(channel.type);
    const destination = {
      webhookChannelId:
        isThread && channel.parent_id ? channel.parent_id : channel.id,
      ...(isThread ? { threadId: channel.id } : {}),
    };

    this.socialWebhookDestinations.set(channelId, destination);
    return destination;
  }

  private async getSocialWebhook(channelId: string) {
    const cached = this.socialWebhooks.get(channelId);
    if (cached) return await cached;

    const webhookPromise = this.findOrCreateSocialWebhook(channelId);
    this.socialWebhooks.set(channelId, webhookPromise);

    try {
      return await webhookPromise;
    } catch (error) {
      if (this.socialWebhooks.get(channelId) === webhookPromise) {
        this.socialWebhooks.delete(channelId);
      }
      throw error;
    }
  }

  private async findOrCreateSocialWebhook(channelId: string) {
    const webhooks = await this.discordRequest<DiscordWebhook[]>(
      `/channels/${channelId}/webhooks`,
    );
    const existing = webhooks.find(
      (webhook) =>
        webhook.name === SOCIAL_WEBHOOK_NAME &&
        webhook.token &&
        (!this.botUserId || webhook.user?.id === this.botUserId),
    );
    return (
      existing ??
      this.discordRequest<DiscordWebhook>(`/channels/${channelId}/webhooks`, {
        method: "POST",
        body: { name: SOCIAL_WEBHOOK_NAME },
      })
    );
  }

  private async replyToMessage(
    message: DiscordMessageCreate,
    content: string,
    mentionedUserIds: string[] = [],
  ) {
    await this.discordRequest(`/channels/${message.channel_id}/messages`, {
      method: "POST",
      body: {
        content,
        message_reference: {
          message_id: message.id,
          fail_if_not_exists: false,
        },
        allowed_mentions: {
          parse: [],
          users: mentionedUserIds,
          replied_user: false,
        },
      },
    });
  }
}

export function startInstagramGateway() {
  const config = getInstagramGatewayConfig();

  if (!config) {
    return null;
  }

  const client = new InstagramGatewayClient(config);
  registerVoiceGateway(client);
  client.connect();
  void prewarmVoiceChatSpeech();

  return client;
}
