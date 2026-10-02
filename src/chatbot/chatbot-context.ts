import { CHATBOT_CONTEXT_LIMITS } from "./context-limits";
import type {
  ChatbotAttachment,
  ChatbotMessage,
} from "../../contracts/worker-contract";
import type { DiscordRequest } from "../discord/api/request";

export type { DiscordRequest } from "../discord/api/request";
import { getDiscordAvatarUrl } from "../discord/social/social-proxy";

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  timestamp: string;
  webhook_id?: string;
  author?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
  mentions?: Array<{
    id?: string;
  }>;
  member?: {
    nick?: string | null;
    roles?: string[];
  };
  attachments?: DiscordAttachment[];
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
  sticker_items?: Array<{ name?: string }>;
  reactions?: Array<{
    count: number;
    me?: boolean;
    emoji: {
      id?: string | null;
      name?: string | null;
      animated?: boolean;
    };
  }>;
  referenced_message?: DiscordMessage | null;
};

type DiscordGuildMember = {
  nick?: string | null;
  avatar?: string | null;
  user?: {
    id?: string;
    username?: string;
    global_name?: string | null;
    avatar?: string | null;
    discriminator?: string;
  };
};

type DiscordChannel = {
  id: string;
  name?: string;
  type?: number;
  permission_overwrites?: Array<{
    id: string;
    type: number;
    allow: string;
    deny: string;
  }>;
};

type DiscordRole = {
  id: string;
  permissions: string;
};

type DiscordMessageSearchResponse = {
  code?: number;
  retry_after?: number;
  messages?: DiscordMessage[][];
};

type SearchHas =
  | "image"
  | "sound"
  | "video"
  | "file"
  | "sticker"
  | "embed"
  | "link"
  | "poll"
  | "snapshot";
type SearchEmbedType = "image" | "video" | "gif" | "sound" | "article";

export type DiscordSearchQuery = {
  author?: string;
  mentions?: string;
  content?: string;
  has?: SearchHas[];
  embedType?: SearchEmbedType;
  linkHostname?: string;
  attachmentExtension?: string;
  sortBy?: "relevance" | "timestamp";
  sortOrder?: "asc" | "desc";
};

function authorAliases(message: DiscordMessage) {
  return [
    message.member?.nick,
    message.author?.global_name,
    message.author?.username,
  ].filter(
    (name, index, names): name is string =>
      Boolean(name) &&
      names.findIndex(
        (candidate) =>
          candidate?.toLocaleLowerCase() === name?.toLocaleLowerCase(),
      ) === index,
  );
}

function authorName(message: DiscordMessage) {
  return authorAliases(message)[0] || message.author?.id || "Unknown user";
}

function attachment(attachment: DiscordAttachment): ChatbotAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.content_type,
    size: attachment.size,
    url: attachment.url,
  };
}

function messageContent(message: DiscordMessage) {
  const parts = [message.content?.trim() ?? ""];

  for (const embed of message.embeds ?? []) {
    parts.push(
      [embed.title, embed.description, embed.url].filter(Boolean).join("\n"),
    );
  }

  for (const sticker of message.sticker_items ?? []) {
    if (sticker.name) {
      parts.push(`[Sticker: ${sticker.name}]`);
    }
  }

  return parts.filter(Boolean).join("\n");
}

function messageReactions(message: DiscordMessage) {
  return (message.reactions ?? []).flatMap((reaction) => {
    const name = reaction.emoji.name;
    if (!name) return [];

    return [
      {
        emoji: reaction.emoji.id
          ? `<${reaction.emoji.animated ? "a" : ""}:${name}:${reaction.emoji.id}>`
          : name,
        count: reaction.count,
        ...(reaction.me ? { me: true } : {}),
      },
    ];
  });
}

function contextMessage(
  message: DiscordMessage,
  botUserId?: string,
): Omit<ChatbotMessage, "referencedMessage"> {
  const aliases = authorAliases(message);

  return {
    id: message.id,
    channelId: message.channel_id,
    role: message.author?.id === botUserId ? "assistant" : "user",
    author: authorName(message),
    ...(aliases.length > 1 ? { authorAliases: aliases } : {}),
    timestamp: message.timestamp,
    content: messageContent(message),
    attachments: (message.attachments ?? []).map(attachment),
    ...(message.reactions?.length
      ? { reactions: messageReactions(message) }
      : {}),
  };
}

export function toChatbotMessage(
  message: DiscordMessage,
  botUserId?: string,
): ChatbotMessage {
  return {
    ...contextMessage(message, botUserId),
    referencedMessage: message.referenced_message
      ? contextMessage(message.referenced_message, botUserId)
      : undefined,
  };
}

export function isConversationContextMessage(
  message: DiscordMessage,
  requestMessageId: string,
  botUserId: string,
) {
  return message.id !== requestMessageId && !message.webhook_id;
}

export function isHumanContextMessage(
  message: DiscordMessage,
  requestMessageId: string,
) {
  return (
    message.id !== requestMessageId &&
    !message.webhook_id &&
    !message.author?.bot
  );
}

const SELF_AUTHOR_PATTERN = /^(?:self|i|me|myself|我|自己)$/iu;
const USER_MENTION_PATTERN = /^<@!?(\d+)>$/u;

function memberNames(member: DiscordGuildMember) {
  return [member.nick, member.user?.global_name, member.user?.username].filter(
    (name, index, names): name is string =>
      Boolean(name) &&
      names.findIndex(
        (candidate) =>
          candidate?.toLocaleLowerCase() === name?.toLocaleLowerCase(),
      ) === index,
  );
}

async function resolveGuildMember({
  guildId,
  memberQuery,
  discordRequest,
}: {
  guildId: string;
  memberQuery: string;
  discordRequest: DiscordRequest;
}) {
  const mentionedUserId = memberQuery.match(USER_MENTION_PATTERN)?.[1];
  if (mentionedUserId) {
    return discordRequest<DiscordGuildMember>(
      `/guilds/${guildId}/members/${mentionedUserId}`,
    );
  }

  const query = new URLSearchParams({
    query: memberQuery,
    limit: String(CHATBOT_CONTEXT_LIMITS.memberSearchResults),
  });
  const members = await discordRequest<DiscordGuildMember[]>(
    `/guilds/${guildId}/members/search?${query}`,
  );
  const normalizedQuery = memberQuery.toLocaleLowerCase();
  const exactMatches = members.filter((member) =>
    memberNames(member).some(
      (name) => name.toLocaleLowerCase() === normalizedQuery,
    ),
  );
  const match =
    exactMatches.length === 1
      ? exactMatches[0]
      : members.length === 1
        ? members[0]
        : undefined;

  return match;
}

export async function lookupGuildMembers({
  guildId,
  queries,
  discordRequest,
}: {
  guildId: string;
  queries: string[];
  discordRequest: DiscordRequest;
}) {
  const results = await Promise.all(
    queries
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumMemberLookups)
      .map(async (query) => {
        const member = await resolveGuildMember({
          guildId,
          memberQuery: query,
          discordRequest,
        });
        if (!member) return [];

        const names = memberNames(member);
        if (names.length === 0) return [];

        return [
          {
            query,
            names,
            avatarUrl: getDiscordAvatarUrl(
              {
                guild_id: guildId,
                author: member.user,
                member,
              },
              4096,
            ),
          },
        ];
      }),
  );

  return results.flat();
}

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const SEARCHABLE_CHANNEL_TYPES = new Set([0, 5, 15, 16]);

export function canMemberSearchChannel({
  guildId,
  userId,
  roleIds,
  roles,
  channel,
}: {
  guildId: string;
  userId: string;
  roleIds: string[];
  roles: DiscordRole[];
  channel: DiscordChannel;
}) {
  const memberRoleIds = new Set([guildId, ...roleIds]);
  let permissions = roles.reduce(
    (value, role) =>
      memberRoleIds.has(role.id) ? value | BigInt(role.permissions) : value,
    0n,
  );

  if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

  const overwrites = channel.permission_overwrites ?? [];
  const applyOverwrite = (deny: bigint, allow: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  const everyone = overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === guildId,
  );
  if (everyone) applyOverwrite(BigInt(everyone.deny), BigInt(everyone.allow));

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && roleIds.includes(overwrite.id)) {
      roleDeny |= BigInt(overwrite.deny);
      roleAllow |= BigInt(overwrite.allow);
    }
  }
  applyOverwrite(roleDeny, roleAllow);

  const member = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === userId,
  );
  if (member) applyOverwrite(BigInt(member.deny), BigInt(member.allow));

  return (
    (permissions & VIEW_CHANNEL) === VIEW_CHANNEL &&
    (permissions & READ_MESSAGE_HISTORY) === READ_MESSAGE_HISTORY
  );
}

async function requesterSearchChannels({
  guildId,
  requesterUserId,
  requesterRoleIds,
  currentChannelId,
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requesterRoleIds?: string[];
  currentChannelId: string;
  discordRequest: DiscordRequest;
}) {
  if (!requesterRoleIds) {
    return { ids: [currentChannelId], names: new Map<string, string>() };
  }

  try {
    const [roles, channels] = await Promise.all([
      discordRequest<DiscordRole[]>(`/guilds/${guildId}/roles`),
      discordRequest<DiscordChannel[]>(`/guilds/${guildId}/channels`),
    ]);
    const visible = channels.filter(
      (channel) =>
        SEARCHABLE_CHANNEL_TYPES.has(channel.type ?? -1) &&
        canMemberSearchChannel({
          guildId,
          userId: requesterUserId,
          roleIds: requesterRoleIds,
          roles,
          channel,
        }),
    );
    const ids = [currentChannelId, ...visible.map((channel) => channel.id)]
      .filter((id, index, values) => values.indexOf(id) === index)
      .slice(0, CHATBOT_CONTEXT_LIMITS.maximumSearchChannels);
    const names = new Map(
      visible.flatMap((channel) =>
        channel.name ? [[channel.id, channel.name] as const] : [],
      ),
    );
    return { ids, names };
  } catch {
    return { ids: [currentChannelId], names: new Map<string, string>() };
  }
}

function toSearchResult(
  message: DiscordMessage,
  guildId: string,
  channelNames: Map<string, string>,
): ChatbotMessage {
  return {
    ...toChatbotMessage(message),
    channelId: message.channel_id,
    channelName: channelNames.get(message.channel_id),
    jumpUrl: `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`,
  };
}

export async function searchGuildMessages({
  guildId,
  requesterUserId,
  requesterRoleIds,
  currentChannelId,
  requestMessageId,
  queries,
  knownMembers = [],
  discordRequest,
}: {
  guildId: string;
  requesterUserId: string;
  requesterRoleIds?: string[];
  currentChannelId: string;
  requestMessageId: string;
  queries: DiscordSearchQuery[];
  knownMembers?: DiscordGuildMember[];
  discordRequest: DiscordRequest;
}) {
  const searchableChannels = await requesterSearchChannels({
    guildId,
    requesterUserId,
    requesterRoleIds,
    currentChannelId,
    discordRequest,
  });
  const memberIds = new Map<string, string | undefined>();
  for (const member of knownMembers) {
    for (const name of memberNames(member)) {
      memberIds.set(name.toLocaleLowerCase(), member.user?.id);
    }
  }
  const matches = new Map<string, DiscordMessage>();

  for (const search of queries.slice(
    0,
    CHATBOT_CONTEXT_LIMITS.maximumSearchQueries,
  )) {
    const resolveMemberId = async (memberQuery: string) => {
      const normalizedMember = memberQuery.toLocaleLowerCase();
      let memberId = SELF_AUTHOR_PATTERN.test(memberQuery)
        ? requesterUserId
        : memberIds.get(normalizedMember);
      if (!memberId && !memberIds.has(normalizedMember)) {
        const member = await resolveGuildMember({
          guildId,
          memberQuery,
          discordRequest,
        });
        memberId = member?.user?.id;
        memberIds.set(normalizedMember, memberId);
      }
      return memberId;
    };
    const authorId = search.author
      ? await resolveMemberId(search.author)
      : undefined;
    const mentionedId = search.mentions
      ? await resolveMemberId(search.mentions)
      : undefined;
    if ((search.author && !authorId) || (search.mentions && !mentionedId)) {
      continue;
    }

    const query = new URLSearchParams({
      limit: String(CHATBOT_CONTEXT_LIMITS.searchResultsPerQuery),
      author_type: "user",
      sort_by: search.sortBy ?? (search.content ? "relevance" : "timestamp"),
      sort_order: search.sortOrder ?? "desc",
    });
    if (authorId) query.append("author_id", authorId);
    if (mentionedId) query.append("mentions", mentionedId);
    if (search.content) query.set("content", search.content);
    for (const has of search.has ?? []) query.append("has", has);
    if (search.embedType) query.append("embed_type", search.embedType);
    if (search.linkHostname) query.append("link_hostname", search.linkHostname);
    if (search.attachmentExtension)
      query.append("attachment_extension", search.attachmentExtension);
    for (const channelId of searchableChannels.ids) {
      query.append("channel_id", channelId);
    }

    for (
      let attempt = 0;
      attempt < CHATBOT_CONTEXT_LIMITS.searchRetryAttempts;
      attempt += 1
    ) {
      const response = await discordRequest<DiscordMessageSearchResponse>(
        `/guilds/${guildId}/messages/search?${query}`,
      );

      if (response.messages) {
        for (const message of response.messages.flat()) {
          if (
            message.id === requestMessageId ||
            message.webhook_id ||
            message.author?.bot
          ) {
            continue;
          }
          if (matches.has(message.id)) continue;
          if (matches.size >= CHATBOT_CONTEXT_LIMITS.maximumSearchResults)
            continue;
          matches.set(message.id, message);
        }
        break;
      }

      if (
        response.code !== 110000 ||
        attempt === CHATBOT_CONTEXT_LIMITS.searchRetryAttempts - 1
      )
        break;
      await Bun.sleep(Math.max(response.retry_after ?? 1, 1) * 1_000);
    }

    if (matches.size >= CHATBOT_CONTEXT_LIMITS.maximumSearchResults) break;
  }

  if (matches.size === 0) return [];

  return [...matches.values()].map((message) =>
    toSearchResult(message, guildId, searchableChannels.names),
  );
}

export async function getNearbyHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
}) {
  const query = new URLSearchParams({
    around: requestMessageId,
    limit: String(CHATBOT_CONTEXT_LIMITS.nearbyFetchMessages),
  });
  const messages = await discordRequest<DiscordMessage[]>(
    `/channels/${channelId}/messages?${query}`,
  );

  return messages
    .filter((message) =>
      isConversationContextMessage(message, requestMessageId, botUserId),
    )
    .slice(0, CHATBOT_CONTEXT_LIMITS.nearbyMessages)
    .map((message) => toChatbotMessage(message, botUserId))
    .reverse();
}

export async function getRecentHumanMessages({
  channelId,
  requestMessageId,
  botUserId,
  discordRequest,
  messageLimit = CHATBOT_CONTEXT_LIMITS.maximumHistoryMessages,
  now = new Date(),
}: {
  channelId: string;
  requestMessageId: string;
  botUserId: string;
  discordRequest: DiscordRequest;
  messageLimit?: number;
  now?: Date;
}) {
  const cutoff = new Date(
    now.getTime() - CHATBOT_CONTEXT_LIMITS.historyWindowMs,
  );
  const messages: ChatbotMessage[] = [];
  let before: string | undefined;

  for (;;) {
    const query = new URLSearchParams({
      limit: String(CHATBOT_CONTEXT_LIMITS.historyPageMessages),
    });
    if (before) {
      query.set("before", before);
    }

    const page = await discordRequest<DiscordMessage[]>(
      `/channels/${channelId}/messages?${query}`,
    );

    for (const message of page) {
      const withinHistoryWindow = new Date(message.timestamp) >= cutoff;
      const needsBackfill = messages.length < messageLimit;

      if (
        isConversationContextMessage(message, requestMessageId, botUserId) &&
        (withinHistoryWindow || needsBackfill)
      ) {
        messages.push(toChatbotMessage(message, botUserId));
      }

      if (messages.length >= messageLimit) {
        return messages.slice(0, messageLimit).reverse();
      }
    }

    const oldestMessage = page.at(-1);
    if (
      page.length < CHATBOT_CONTEXT_LIMITS.historyPageMessages ||
      !oldestMessage
    ) {
      break;
    }

    if (oldestMessage.id === before) break;

    before = oldestMessage.id;
  }

  return messages.reverse();
}
