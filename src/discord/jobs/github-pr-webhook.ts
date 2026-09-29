import { createHmac, timingSafeEqual } from "node:crypto";

import { createDiscordRequest } from "../api/request";
import { readJsonFile, writeJsonFile } from "./job-utils";
import { macAgentBridge } from "../../chatbot/bridge";

const TARGET_REPOSITORY = "sago-cream/health-check-system";
const SKILLBOOK_REPOSITORY = "sago-cream/skills";
const DEFAULT_THREAD_CHANNEL_ID = "1521506395034226830";
const DEFAULT_STATE_FILE = ".data/github-pr-threads.json";
const PUBLIC_THREAD_TYPE = 11;
const APPROVED_EMOJI_NAME = "approved";

const TEAM = {
  "sago-cream": "917446775873343600",
  Danielllllllllllllll: "927940363644194847",
  Jasmine0108: "881904247879368715",
} as const;

type TeamLogin = keyof typeof TEAM;

type PullRequestPayload = {
  action?: string;
  repository?: {
    full_name?: string;
  };
  pull_request?: {
    number?: number;
    title?: string;
    html_url?: string;
    draft?: boolean;
    merged?: boolean;
    user?: {
      login?: string;
    };
    merged_by?: {
      login?: string;
    } | null;
  };
  review?: {
    state?: string;
  };
};

type PushPayload = {
  ref?: string;
  repository?: { full_name?: string };
};

type ThreadRecord = {
  threadId: string;
  title: string;
  url: string;
  authorLogin: string;
  reviewRequestSent: boolean;
  approvalNotificationSent?: boolean;
  mergeNotificationSent?: boolean;
  archived: boolean;
};

type ThreadState = {
  version: 1;
  threads: Record<string, ThreadRecord>;
};

type WebhookConfig = {
  botToken: string;
  channelId: string;
  secret: string;
  stateFile: string;
};

type DiscordThread = {
  id: string;
};

type DiscordMessage = {
  id: string;
};

type DiscordChannel = {
  guild_id?: string;
};

type DiscordEmoji = {
  id: string;
  name?: string | null;
  animated?: boolean;
  available?: boolean;
};

export type ReviewRequest = {
  authorDiscordId?: string;
  reviewerDiscordIds: string[];
  message: {
    content: string;
    allowed_mentions: {
      parse: string[];
      users: string[];
    };
  };
};

export function verifyGithubWebhookSignature(
  body: string,
  signature: string | null,
  secret: string,
) {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);

  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isTeamLogin(login: string): login is TeamLogin {
  return login in TEAM;
}

function escapeDiscordLinkText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

export function buildReviewRequest({
  authorLogin,
  title,
  url,
}: {
  authorLogin: string;
  title: string;
  url: string;
}): ReviewRequest {
  const reviewerDiscordIds =
    authorLogin === "sago-cream"
      ? [TEAM.Danielllllllllllllll, TEAM.Jasmine0108]
      : [TEAM["sago-cream"]];
  const mentions = reviewerDiscordIds.map((id) => `<@${id}>`).join(" ");

  return {
    authorDiscordId: isTeamLogin(authorLogin) ? TEAM[authorLogin] : undefined,
    reviewerDiscordIds,
    message: {
      content: `${mentions} please review [${escapeDiscordLinkText(title)}](<${url}>)`,
      allowed_mentions: {
        parse: [],
        users: reviewerDiscordIds,
      },
    },
  };
}

export function formatThreadName(number: number, title: string) {
  return Array.from(`#${number} ${title.trim() || "Pull request"}`)
    .slice(0, 100)
    .join("");
}

function getWebhookConfig(): WebhookConfig | null {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

  if (!secret || !botToken) {
    return null;
  }

  return {
    secret,
    botToken,
    channelId:
      process.env.GITHUB_PR_THREAD_CHANNEL_ID?.trim() ||
      DEFAULT_THREAD_CHANNEL_ID,
    stateFile:
      process.env.GITHUB_PR_THREAD_STATE_FILE?.trim() || DEFAULT_STATE_FILE,
  };
}

async function readState(stateFile: string): Promise<ThreadState> {
  try {
    const state = await readJsonFile<ThreadState>(stateFile, () => ({
      version: 1,
      threads: {},
    }));

    if (state.version !== 1 || !state.threads) {
      throw new Error("unsupported state format");
    }

    return state;
  } catch (error) {
    throw new Error(
      `Failed to read GitHub PR thread state at ${stateFile}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function getPullRequestDetails(payload: PullRequestPayload) {
  const repository = payload.repository?.full_name;
  const pullRequest = payload.pull_request;

  if (
    repository?.toLowerCase() !== TARGET_REPOSITORY.toLowerCase() ||
    !pullRequest ||
    typeof pullRequest.number !== "number" ||
    !pullRequest.title ||
    !pullRequest.html_url ||
    !pullRequest.user?.login
  ) {
    return null;
  }

  return {
    key: `${repository.toLowerCase()}#${pullRequest.number}`,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.html_url,
    authorLogin: pullRequest.user.login,
    merged: pullRequest.merged === true,
    mergedByLogin: pullRequest.merged_by?.login,
  };
}

async function openReviewThread(
  config: WebhookConfig,
  details: NonNullable<ReturnType<typeof getPullRequestDetails>>,
) {
  const discordRequest = createDiscordRequest(config.botToken);
  const state = await readState(config.stateFile);
  let record = state.threads[details.key];

  if (!record) {
    const thread = await discordRequest<DiscordThread>(
      `/channels/${config.channelId}/threads`,
      {
        method: "POST",
        body: {
          name: formatThreadName(details.number, details.title),
          auto_archive_duration: 1440,
          type: PUBLIC_THREAD_TYPE,
        },
      },
    );

    if (!thread?.id) {
      throw new Error("Discord did not return a thread ID");
    }

    record = {
      threadId: thread.id,
      title: details.title,
      url: details.url,
      authorLogin: details.authorLogin,
      reviewRequestSent: false,
      archived: false,
    };
    state.threads[details.key] = record;
    await writeJsonFile(config.stateFile, state);
  }

  if (record.reviewRequestSent) {
    return "already-created" as const;
  }

  const reviewRequest = buildReviewRequest(details);
  const participantIds = new Set([
    ...reviewRequest.reviewerDiscordIds,
    ...(reviewRequest.authorDiscordId ? [reviewRequest.authorDiscordId] : []),
  ]);

  for (const userId of participantIds) {
    await discordRequest(
      `/channels/${record.threadId}/thread-members/${userId}`,
      { method: "PUT" },
    );
  }

  const reviewMessage = await discordRequest<DiscordMessage>(
    `/channels/${record.threadId}/messages`,
    {
      method: "POST",
      body: reviewRequest.message,
    },
  );

  if (!reviewMessage?.id) {
    throw new Error("Discord did not return a review message ID");
  }

  await discordRequest(
    `/channels/${record.threadId}/pins/${reviewMessage.id}`,
    { method: "PUT" },
  );

  record.reviewRequestSent = true;
  await writeJsonFile(config.stateFile, state);
  return "created" as const;
}

async function notifyAuthorOfApproval(
  config: WebhookConfig,
  details: NonNullable<ReturnType<typeof getPullRequestDetails>>,
) {
  const discordRequest = createDiscordRequest(config.botToken);
  const state = await readState(config.stateFile);
  const record = state.threads[details.key];

  if (!record) {
    return "not-found" as const;
  }

  if (record.approvalNotificationSent) {
    return "already-notified" as const;
  }

  const authorDiscordId = isTeamLogin(record.authorLogin)
    ? TEAM[record.authorLogin]
    : undefined;

  if (!authorDiscordId) {
    return "not-found" as const;
  }

  const channel = await discordRequest<DiscordChannel>(
    `/channels/${record.threadId}`,
  );

  if (!channel?.guild_id) {
    throw new Error(`Discord thread ${record.threadId} has no guild ID`);
  }

  const emojis = await discordRequest<DiscordEmoji[]>(
    `/guilds/${channel.guild_id}/emojis`,
  );
  const approvedEmoji = emojis?.find(
    (emoji) => emoji.name === APPROVED_EMOJI_NAME && emoji.available !== false,
  );

  if (!approvedEmoji) {
    throw new Error(
      `Discord guild ${channel.guild_id} does not have an available :${APPROVED_EMOJI_NAME}: emoji`,
    );
  }

  const emoji = `<${approvedEmoji.animated ? "a" : ""}:${APPROVED_EMOJI_NAME}:${approvedEmoji.id}>`;
  await discordRequest(`/channels/${record.threadId}/messages`, {
    method: "POST",
    body: {
      content: `<@${authorDiscordId}> ${emoji}`,
      allowed_mentions: {
        parse: [],
        users: [authorDiscordId],
      },
    },
  });

  record.approvalNotificationSent = true;
  await writeJsonFile(config.stateFile, state);
  return "notified" as const;
}

async function archiveReviewThread(
  config: WebhookConfig,
  details: NonNullable<ReturnType<typeof getPullRequestDetails>>,
) {
  const discordRequest = createDiscordRequest(config.botToken);
  const state = await readState(config.stateFile);
  const record = state.threads[details.key];

  if (!record || record.archived) {
    return "not-found" as const;
  }

  const mergerDiscordId =
    details.mergedByLogin && isTeamLogin(details.mergedByLogin)
      ? TEAM[details.mergedByLogin]
      : undefined;

  if (!record.mergeNotificationSent && mergerDiscordId) {
    await discordRequest(`/channels/${record.threadId}/messages`, {
      method: "POST",
      body: {
        content: `Merged by <@${mergerDiscordId}>, closing.`,
        allowed_mentions: {
          parse: [],
          users: [mergerDiscordId],
        },
      },
    });

    record.mergeNotificationSent = true;
    await writeJsonFile(config.stateFile, state);
  }

  await discordRequest(`/channels/${record.threadId}`, {
    method: "PATCH",
    body: { archived: true },
  });

  record.archived = true;
  await writeJsonFile(config.stateFile, state);
  return "archived" as const;
}

let processingQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>) {
  const result = processingQueue.then(operation, operation);
  processingQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function handleGithubWebhookRequest(
  request: Request,
  triggerSkillSync = () => macAgentBridge.triggerOracleSkillSync(),
) {
  const config = getWebhookConfig();

  if (!config) {
    return Response.json(
      { ok: false, error: "GitHub 自動通知服務尚未設定" },
      { status: 503 },
    );
  }

  const body = await request.text();

  if (
    !verifyGithubWebhookSignature(
      body,
      request.headers.get("X-Hub-Signature-256"),
      config.secret,
    )
  ) {
    return Response.json(
      { ok: false, error: "自動通知簽章無效" },
      { status: 401 },
    );
  }

  const event = request.headers.get("X-GitHub-Event");

  if (event === "push") {
    let payload: PushPayload;
    try {
      payload = JSON.parse(body) as PushPayload;
    } catch {
      return Response.json(
        { ok: false, error: "請求資料格式無效" },
        { status: 400 },
      );
    }
    if (
      payload.repository?.full_name?.toLowerCase() !==
        SKILLBOOK_REPOSITORY.toLowerCase() ||
      payload.ref !== "refs/heads/main"
    ) {
      return Response.json({ ok: true, ignored: true }, { status: 202 });
    }
    const queued = triggerSkillSync();
    return Response.json(
      { ok: queued, result: queued ? "queued" : "oracle_offline" },
      { status: queued ? 202 : 503 },
    );
  }

  if (event !== "pull_request" && event !== "pull_request_review") {
    return Response.json({ ok: true, ignored: true }, { status: 202 });
  }

  let payload: PullRequestPayload;

  try {
    payload = JSON.parse(body) as PullRequestPayload;
  } catch {
    return Response.json(
      { ok: false, error: "請求資料格式無效" },
      { status: 400 },
    );
  }

  const details = getPullRequestDetails(payload);

  if (!details) {
    return Response.json({ ok: true, ignored: true }, { status: 202 });
  }

  try {
    if (event === "pull_request" && payload.action === "ready_for_review") {
      const result = await enqueue(() => openReviewThread(config, details));
      return Response.json({ ok: true, result });
    }

    if (
      event === "pull_request_review" &&
      payload.action === "submitted" &&
      payload.review?.state?.toLowerCase() === "approved"
    ) {
      const result = await enqueue(() =>
        notifyAuthorOfApproval(config, details),
      );
      return Response.json({ ok: true, result });
    }

    if (event === "pull_request" && payload.action === "closed") {
      const result = await enqueue(() => archiveReviewThread(config, details));
      return Response.json({ ok: true, result });
    }

    return Response.json({ ok: true, ignored: true }, { status: 202 });
  } catch (error) {
    console.error("Failed to process GitHub PR webhook:", error);
    return Response.json(
      { ok: false, error: "無法處理自動通知" },
      { status: 502 },
    );
  }
}

export function isGithubWebhookConfigured() {
  return Boolean(process.env.GITHUB_WEBHOOK_SECRET?.trim());
}
