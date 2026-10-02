export const CHATBOT_PROTOCOL_VERSION = 36;
export const CHATBOT_JOB_TIMEOUT_MS = 5 * 60_000;
export const CHATBOT_OUTGOING_FILE_LIMITS = {
  count: 10,
  bytes: 8 * 1024 * 1024,
} as const;

export type ChatbotWorkerCapability = "chat" | "dev" | "mac";
export type ChatbotFailureKind = "unavailable" | "timeout" | "internal";

export type ChatbotAttachment = {
  id: string;
  filename: string;
  contentType?: string;
  size: number;
  url: string;
};

export type ChatbotMediaRef = {
  mediaId: string;
  filename: string;
  contentType?: string;
  size?: number;
};

export type ChatbotOutgoingFile = {
  filename: string;
  contentType: string;
  size: number;
  data: string;
};

export type ChatbotReaction = {
  emoji: string;
  count: number;
  me?: boolean;
};

export type ChatbotExecutionRoute = "chat" | "mac" | "oracle";
export type ChatbotAddressingMode = "mention" | "reply" | "dm" | "continuation";

export type CodexUsageWindow = {
  label: string;
  windowMinutes: number;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
};

export type CodexUsageSnapshot = {
  windows: CodexUsageWindow[];
  updatedAt: string;
};

export type WorkerSkillbookStatus = {
  ok: boolean;
  syncing: boolean;
  skills: number;
  revision?: string;
  lastSyncedAt?: string;
  error?: string;
};

export type ChatbotToolCapability = {
  name: string;
  risk: "ambient" | "normal" | "owner_confirmed";
  description: string;
  inputSchema: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ChatbotCapability = {
  id: string;
  category:
    | "conversation"
    | "context"
    | "discord"
    | "reminders"
    | "attachments"
    | "development"
    | "memory"
    | "travel"
    | "system";
  availability: "available" | "conditional";
  description: string;
  tools?: string[];
  condition?: string;
};

export type ChatbotMemberResult = {
  query: string;
  names: string[];
  avatar: ChatbotMediaRef;
};

export type ChatbotMcpTraceCall = {
  name: string;
  arguments: Record<string, unknown>;
  resultCount?: number;
  status?: string;
};

export type ChatbotPromptTelemetry = {
  promptVersion: number;
  versions: {
    policy: number;
    task: number;
    context: number;
  };
  purpose: CodexJob["purpose"];
  developerCharacters: number;
  taskCharacters: number;
  contextCharacters: number;
};

export type ChatbotTaskProgress = {
  phase: "preparing" | "exploring" | "implementing" | "testing" | "reviewing";
  summary: string;
  sessionId?: string;
  kind?: "trace" | "action";
  completion?: "pull_request_merged";
  timing?: { stage: string; durationMs: number };
};

export type PreservedDeveloperTask = {
  id: string;
  requesterUserId: string;
  repository: string;
  request: string;
  title?: string;
  resumeSessionId?: string;
};

export type ChatbotTraceContext = {
  historyCount?: number;
  contextMessageCount: number;
  searchQueries: Array<Record<string, unknown>>;
  searchResultCount: number;
  memberQueries: string[];
  toolCalls?: ChatbotMcpTraceCall[];
  elapsedMs: number;
  model?: string;
  promptVersion?: number;
  prompt?: ChatbotPromptTelemetry;
};

export type ChatbotMessage = {
  id: string;
  role?: "user" | "assistant";
  author: string;
  authorAliases?: string[];
  timestamp: string;
  content: string;
  attachments: ChatbotAttachment[];
  reactions?: ChatbotReaction[];
  channelId?: string;
  channelName?: string;
  jumpUrl?: string;
  referencedMessage?: Omit<ChatbotMessage, "referencedMessage">;
};

export type ChatbotServerMemory = {
  revision: number;
  entries: Array<{
    id: string;
    content: string;
  }>;
};

type ChatbotJobBase = {
  id: string;
  requesterUserId: string;
  channelId: string;
  requestMessageId: string;
  request: string;
  requestMessage?: ChatbotMessage;
  messages: ChatbotMessage[];
};

type NonAnswerJob = {
  executionRoute?: never;
  repository?: never;
  mcpAccessToken?: never;
  addressingMode?: never;
  serverMemory?: never;
  developerTask?: never;
};

type NonRoutingJob = {
  availableRepositories?: never;
  chatbotRepository?: never;
};

export type ExecutionRouteJob = ChatbotJobBase &
  NonAnswerJob & {
    purpose: "execution_route";
    availableRepositories: string[];
    chatbotRepository?: string;
    capabilities?: ChatbotCapability[];
    availableTools?: never;
    socialActionCandidateMessageIds?: never;
  };

export type TraceLookupJob = ChatbotJobBase &
  NonAnswerJob &
  NonRoutingJob & {
    purpose: "trace_lookup";
    availableTools?: never;
    socialActionCandidateMessageIds?: never;
  };

export type SocialActionJob = ChatbotJobBase &
  NonAnswerJob &
  NonRoutingJob & {
    purpose: "social_action";
    availableTools: ChatbotToolCapability[];
    socialActionCandidateMessageIds: string[];
  };

type AnswerJobBase = ChatbotJobBase &
  NonRoutingJob & {
    purpose: "answer";
    mcpAccessToken: string;
    capabilities?: ChatbotCapability[];
    availableTools?: ChatbotToolCapability[];
    addressingMode?: ChatbotAddressingMode;
    serverMemory?: ChatbotServerMemory;
    streamReply?: boolean;
    socialActionCandidateMessageIds?: never;
  };

export type ChatAnswerJob = AnswerJobBase & {
  executionRoute: "chat";
  repository?: never;
  developerTask?: never;
};

export type MacAnswerJob = AnswerJobBase & {
  executionRoute: "mac";
  repository?: never;
  developerTask?: never;
};

export type OracleAnswerJob = AnswerJobBase & {
  executionRoute: "oracle";
  repository: string;
  developerTask?: {
    id: string;
    title?: string;
    resumeSessionId?: string;
    currentRequesterUserId?: string;
  };
};

export type AnswerJob = ChatAnswerJob | MacAnswerJob | OracleAnswerJob;
export type CodexJob = AnswerJob | ExecutionRouteJob | SocialActionJob;
export type ChatbotJob = CodexJob | TraceLookupJob;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isAttachment(value: unknown): value is ChatbotAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.filename === "string" &&
    (value.contentType === undefined ||
      typeof value.contentType === "string") &&
    typeof value.size === "number" &&
    typeof value.url === "string"
  );
}

function isReaction(value: unknown): value is ChatbotReaction {
  if (!isRecord(value)) return false;
  return (
    typeof value.emoji === "string" &&
    typeof value.count === "number" &&
    (value.me === undefined || typeof value.me === "boolean")
  );
}

function isMessage(value: unknown): value is ChatbotMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.role === undefined ||
      ["user", "assistant"].includes(String(value.role))) &&
    typeof value.author === "string" &&
    (value.authorAliases === undefined || isStringArray(value.authorAliases)) &&
    typeof value.timestamp === "string" &&
    typeof value.content === "string" &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isAttachment) &&
    (value.reactions === undefined ||
      (Array.isArray(value.reactions) && value.reactions.every(isReaction))) &&
    (value.channelId === undefined || typeof value.channelId === "string") &&
    (value.channelName === undefined ||
      typeof value.channelName === "string") &&
    (value.jumpUrl === undefined || typeof value.jumpUrl === "string") &&
    (value.referencedMessage === undefined ||
      isMessage(value.referencedMessage))
  );
}

function isToolCapability(value: unknown): value is ChatbotToolCapability {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    ["ambient", "normal", "owner_confirmed"].includes(String(value.risk)) &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema) &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function isCapability(value: unknown): value is ChatbotCapability {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    [
      "conversation",
      "context",
      "discord",
      "reminders",
      "attachments",
      "development",
      "memory",
      "travel",
      "system",
    ].includes(String(value.category)) &&
    ["available", "conditional"].includes(String(value.availability)) &&
    typeof value.description === "string" &&
    (value.tools === undefined || isStringArray(value.tools)) &&
    (value.condition === undefined || typeof value.condition === "string")
  );
}

function isServerMemory(value: unknown): value is ChatbotServerMemory {
  if (!isRecord(value) || typeof value.revision !== "number") return false;
  return (
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.content === "string",
    )
  );
}

function isDeveloperTask(value: unknown) {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.resumeSessionId === undefined ||
      typeof value.resumeSessionId === "string") &&
    (value.currentRequesterUserId === undefined ||
      typeof value.currentRequesterUserId === "string")
  );
}

function hasOnlyAbsent(record: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => record[key] === undefined);
}

function hasCommonJobFields(record: Record<string, unknown>) {
  return (
    typeof record.id === "string" &&
    typeof record.requesterUserId === "string" &&
    typeof record.channelId === "string" &&
    typeof record.requestMessageId === "string" &&
    typeof record.request === "string" &&
    Array.isArray(record.messages) &&
    record.messages.every(isMessage) &&
    (record.requestMessage === undefined || isMessage(record.requestMessage))
  );
}

const ANSWER_ONLY_FIELDS = [
  "executionRoute",
  "repository",
  "mcpAccessToken",
  "capabilities",
  "addressingMode",
  "serverMemory",
  "streamReply",
  "developerTask",
] as const;

const ROUTING_ONLY_FIELDS = [
  "availableRepositories",
  "chatbotRepository",
] as const;

const EXECUTION_ROUTE_FORBIDDEN_FIELDS = ANSWER_ONLY_FIELDS.filter(
  (field) => field !== "capabilities",
);

export function parseChatbotJob(value: unknown): ChatbotJob | null {
  if (!isRecord(value) || !hasCommonJobFields(value)) return null;

  if (value.purpose === "execution_route") {
    if (
      !isStringArray(value.availableRepositories) ||
      (value.chatbotRepository !== undefined &&
        typeof value.chatbotRepository !== "string") ||
      (value.capabilities !== undefined &&
        (!Array.isArray(value.capabilities) ||
          !value.capabilities.every(isCapability))) ||
      !hasOnlyAbsent(value, [
        ...EXECUTION_ROUTE_FORBIDDEN_FIELDS,
        "availableTools",
        "socialActionCandidateMessageIds",
      ])
    ) {
      return null;
    }
    return value as ExecutionRouteJob;
  }

  if (value.purpose === "trace_lookup") {
    if (
      !hasOnlyAbsent(value, [
        ...ANSWER_ONLY_FIELDS,
        ...ROUTING_ONLY_FIELDS,
        "availableTools",
        "socialActionCandidateMessageIds",
      ])
    ) {
      return null;
    }
    return value as TraceLookupJob;
  }

  if (value.purpose === "social_action") {
    if (
      !Array.isArray(value.availableTools) ||
      !value.availableTools.every(isToolCapability) ||
      !isStringArray(value.socialActionCandidateMessageIds) ||
      !hasOnlyAbsent(value, [...ANSWER_ONLY_FIELDS, ...ROUTING_ONLY_FIELDS])
    ) {
      return null;
    }
    return value as SocialActionJob;
  }

  if (value.purpose !== "answer") return null;
  if (
    typeof value.mcpAccessToken !== "string" ||
    value.mcpAccessToken.length === 0 ||
    !["chat", "mac", "oracle"].includes(String(value.executionRoute)) ||
    (value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) ||
        !value.capabilities.every(isCapability))) ||
    (value.availableTools !== undefined &&
      (!Array.isArray(value.availableTools) ||
        !value.availableTools.every(isToolCapability))) ||
    (value.addressingMode !== undefined &&
      !["mention", "reply", "dm", "continuation"].includes(
        String(value.addressingMode),
      )) ||
    (value.serverMemory !== undefined && !isServerMemory(value.serverMemory)) ||
    (value.streamReply !== undefined &&
      typeof value.streamReply !== "boolean") ||
    !hasOnlyAbsent(value, [
      ...ROUTING_ONLY_FIELDS,
      "socialActionCandidateMessageIds",
    ])
  ) {
    return null;
  }

  if (value.executionRoute === "oracle") {
    if (
      typeof value.repository !== "string" ||
      value.repository.length === 0 ||
      (value.developerTask !== undefined &&
        !isDeveloperTask(value.developerTask))
    ) {
      return null;
    }
    return value as OracleAnswerJob;
  }

  if (!hasOnlyAbsent(value, ["repository", "developerTask"])) return null;
  return value as ChatAnswerJob | MacAnswerJob;
}

export type MacAgentClientMessage =
  | {
      type: "authenticate";
      protocolVersion: number;
      secret: string;
      workerId: string;
      repositories: string[];
      chatbotRepository?: string;
    }
  | {
      type: "availability";
      available: boolean;
      capacity: number;
      skillbook?: WorkerSkillbookStatus;
    }
  | {
      type: "heartbeat";
    }
  | {
      type: "codex_usage_result";
      requestId: string;
      usage: CodexUsageSnapshot | null;
    }
  | {
      type: "skill_sync_result";
      requestId: string;
      status: WorkerSkillbookStatus;
    }
  | {
      type: "progress";
      jobId: string;
      progress: ChatbotTaskProgress;
    }
  | {
      type: "answer_delta";
      jobId: string;
      delta: string;
    }
  | {
      type: "steer_result";
      jobId: string;
      requestId: string;
      accepted: boolean;
    }
  | {
      type: "result";
      jobId: string;
      ok: true;
      content: string;
      files?: ChatbotOutgoingFile[];
    }
  | {
      type: "result";
      jobId: string;
      ok: false;
      error: string;
      failureKind: ChatbotFailureKind;
      stopped?: boolean;
    };

export type MacAgentServerMessage =
  | {
      type: "authenticated";
      protocolVersion: number;
    }
  | {
      type: "job";
      job: ChatbotJob;
    }
  | {
      type: "cancel";
      jobId: string;
    }
  | {
      type: "steer";
      jobId: string;
      requestId: string;
      request: string;
    }
  | {
      type: "codex_usage_request";
      requestId: string;
    }
  | {
      type: "skill_sync_request";
      requestId: string;
    };
