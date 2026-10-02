import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { ChatbotAccessConfig } from "./access";
import { macAgentBridge, type MacAgentSocketData } from "./bridge";
import { CHATBOT_PROTOCOL_VERSION } from "../../contracts/worker-contract";
import { enforceFirstPersonIdentity } from "../../contracts/answer-contract";
import { ChatbotMediaRegistry } from "./media-assets";
import { handleChatbotMcpRequest } from "./mcp";
import { ChannelQuietTracker } from "../discord/channel-quiet";
import type { FeatureAvailabilityStore } from "../discord/feature-availability";
import {
  addGuildExpressionForRequest,
  ChatbotConversationTracker,
  chatbotFailureReply,
  canMemberSearchChannel,
  chatbotAddressingMode,
  extractChatbotRequest,
  extractMentionRequest,
  executeChatbotAnswerDecision,
  executionRouteOrChat,
  developerThreadName,
  createDeveloperThread,
  formatDiscordAnswer,
  formatDiscordAnswers,
  getNearbyHumanMessages,
  getRecentHumanMessages,
  handleChatbotMention,
  isConversationContextMessage,
  isChatbotAuthorized,
  isHumanContextMessage,
  lookupGuildMembers,
  missingDeveloperRepositoryResponse,
  parseChatbotAnswerDecision,
  parseExecutionRoute,
  parsePreviousTraceLookup,
  postChatbotResponse,
  searchGuildMessages,
  supplementalCapabilities,
  toChatbotMessage,
  type DiscordRequest,
} from "./chatbot";

const BOT_ID = "123456789012345678";
const ACCESS_CONFIG: ChatbotAccessConfig = {
  ownerUserId: "917446775873343600",
  guildIds: new Set([
    "917436845187563610",
    "1282936453134815275",
    "1439286996869713992",
    "1521168712579682567",
  ]),
  channelIds: new Set(["1517766866964316201"]),
  roleIds: new Set(["1522110684610166907"]),
};

async function waitFor<T>(value: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = value();
    if (result !== undefined) return result;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for test event");
}

describe("Discord chatbot", () => {
  test("keeps worker failures short and actionable", () => {
    expect(chatbotFailureReply("unavailable")).toBe(
      "我現在暫時忙不過來 稍後再試一次",
    );
    expect(chatbotFailureReply("timeout")).toBe(
      "我沒等到操作結果 先確認一下再重試",
    );
    expect(chatbotFailureReply("internal")).toBe("我這次沒完成 稍後再試一次");
  });

  test("creates concise coding task thread names", () => {
    expect(developerThreadName("  Add   live Codex traces  ")).toBe(
      "Add live Codex traces",
    );
    expect(developerThreadName("x".repeat(200)).length).toBe(100);
    expect(developerThreadName()).toBe("Coding task");
  });

  test("advertises owner merges and self-deploys in chat", () => {
    const capabilities = supplementalCapabilities({
      isOwner: true,
      hasAttachments: false,
      hasReactions: false,
      availableRepositories: ["sago-cream/mini-sago"],
      chatbotRepository: "sago-cream/mini-sago",
      executionRoute: "chat",
    });

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "repository_work",
          availability: "conditional",
          description: expect.stringContaining("pull-request merges"),
          condition: expect.stringContaining("explicit current request"),
        }),
        expect.objectContaining({
          id: "self_development",
          availability: "conditional",
          description: expect.stringContaining("deploy it from main"),
          condition: expect.stringContaining("deployment"),
        }),
      ]),
    );
  });

  test("advertises live NTHU campus lookups to every chatbot user", () => {
    const capabilities = supplementalCapabilities({
      isOwner: false,
      hasAttachments: false,
      hasReactions: false,
      availableRepositories: [],
      executionRoute: "chat",
    });

    expect(capabilities).toContainEqual(
      expect.objectContaining({
        id: "nthu_campus",
        availability: "available",
        tools: expect.arrayContaining([
          "search_campus",
          "get_next_buses",
          "search_courses",
          "get_library_info",
        ]),
      }),
    );
  });

  test("detaches developer work into a steerable Discord thread", async () => {
    const oldWorkerSecret = process.env.MINISAGO_WORKER_BRIDGE_SECRET;
    const oldMacSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET;
    const secret = "coding-thread-test-secret-at-least-32-bytes";
    process.env.MINISAGO_WORKER_BRIDGE_SECRET = secret;
    delete process.env.MINISAGO_MAC_BRIDGE_SECRET;
    const sent: string[] = [];
    const socket = {
      data: { authenticated: false },
      send: (message: string) => sent.push(message),
      close: () => undefined,
    } as unknown as ServerWebSocket<MacAgentSocketData>;
    const discordCalls: Array<{
      path: string;
      method?: string;
      body: unknown;
      formData?: FormData;
    }> = [];
    let codingMessageCount = 0;
    let supplementaryContent = "Add the stamp to the last page too.";
    const supplement = () => ({
      id: "supplementary-message",
      channel_id: "coding-thread",
      content: supplementaryContent,
      timestamp: new Date().toISOString(),
      author: { id: "another-participant", username: "Daniel" },
      attachments: [
        {
          id: "stamp-image",
          filename: "stamp.png",
          content_type: "image/png",
          size: 42,
          url: "https://cdn.discordapp.com/attachments/stamp.png?signature=private",
        },
      ],
    });
    const mcpServer = Bun.serve({
      port: 0,
      fetch: handleChatbotMcpRequest,
    });
    let contextClient: Client | undefined;
    const featurePolicy = { defaultEnabled: false, rules: [] };
    let participantSteeringEnabled = false;
    const featureAvailability = {
      isEnabled: (feature: string) =>
        feature === "developer_steering" && participantSteeringEnabled,
      list: () => ({
        version: 1 as const,
        features: {
          chatbot: featurePolicy,
          ambient_reactions: featurePolicy,
          trip_planner: featurePolicy,
          ccxp_meetings: featurePolicy,
        },
      }),
      configure: async () => featurePolicy,
    } as unknown as FeatureAvailabilityStore;

    try {
      macAgentBridge.open(socket);
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "authenticate",
          protocolVersion: CHATBOT_PROTOCOL_VERSION,
          secret,
          workerId: "oracle",
          repositories: ["sago-cream/mini-sago"],
          chatbotRepository: "sago-cream/mini-sago",
        }),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({ type: "availability", available: true, capacity: 1 }),
      );

      const handled = handleChatbotMention({
        message: {
          id: "coding-request",
          channel_id: "channel-1",
          guild_id: "917436845187563610",
          content: `<@${BOT_ID}> add progress reports`,
          timestamp: "2026-08-10T12:00:00.000Z",
          author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
          mentions: [{ id: BOT_ID }],
        },
        botUserId: BOT_ID,
        accessConfig: ACCESS_CONFIG,
        featureAvailability,
        discordRequest: async (path, options) => {
          discordCalls.push({
            path,
            method: options?.method,
            body: options?.formData
              ? JSON.parse(options.formData.get("payload_json") as string)
              : options?.body,
            formData: options?.formData,
          });
          if (path.startsWith("/channels/coding-thread/messages?"))
            return [supplement()] as never;
          if (path.includes("?around=")) return [] as never;
          if (path === "/channels/channel-1") return { type: 0 } as never;
          if (path.endsWith("/threads"))
            return { id: "coding-thread" } as never;
          if (path === "/channels/coding-thread/messages") {
            codingMessageCount += 1;
            return { id: `coding-message-${codingMessageCount}` } as never;
          }
          return undefined as never;
        },
      });

      const routeJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" && value.job.purpose === "execution_route",
          ),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: routeJob.job.id,
          ok: true,
          content: JSON.stringify({
            route: "oracle",
            repository: "sago-cream/mini-sago",
            threadTitle: "Stream Codex task progress",
            reason: "code change",
          }),
        }),
      );
      expect(routeJob.job.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "channel_messaging",
            tools: ["send_channel_message"],
          }),
          expect.objectContaining({
            id: "feature_availability",
            tools: [
              "list_feature_availability",
              "configure_feature_availability",
            ],
          }),
        ]),
      );
      const traceJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" && value.job.purpose === "trace_lookup",
          ),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: traceJob.job.id,
          ok: true,
          content: '{"status":"not_found"}',
        }),
      );

      expect(await handled).toBe(true);
      const answerJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) => value.type === "job" && value.job.purpose === "answer",
          ),
      );
      expect(answerJob.job.channelId).toBe("coding-thread");
      expect(answerJob.job.developerTask.id).toBeString();
      contextClient = new Client({
        name: "coding-context-test",
        version: "1.0.0",
      });
      await contextClient.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost:${mcpServer.port}/api/chatbot/mcp`),
          {
            requestInit: {
              headers: {
                Authorization: `Bearer ${answerJob.job.mcpAccessToken}`,
              },
            },
          },
        ),
      );
      const liveContext = await contextClient.callTool({
        name: "resolve_context",
        arguments: { historyCount: 5 },
      });
      expect(liveContext.structuredContent).toMatchObject({
        history: {
          status: "complete",
          messages: [
            { id: "supplementary-message", content: supplementaryContent },
          ],
        },
      });
      supplementaryContent =
        "Use the new stamp image for both report versions.";
      const refreshedContext = await contextClient.callTool({
        name: "resolve_context",
        arguments: { historyCount: 5 },
      });
      expect(JSON.stringify(refreshedContext.structuredContent)).toContain(
        supplementaryContent,
      );
      expect(JSON.stringify(refreshedContext)).not.toContain(
        "signature=private",
      );
      const fetchCount = discordCalls.length;
      const emptyContext = await contextClient.callTool({
        name: "resolve_context",
        arguments: { historyCount: 0 },
      });
      expect(emptyContext.structuredContent).toMatchObject({
        history: { status: "complete", messages: [] },
      });
      expect(discordCalls.length).toBe(fetchCount);
      expect(answerJob.job.capabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "repository_work",
            availability: "available",
          }),
          expect.objectContaining({
            id: "discord_context",
            tools: ["resolve_context"],
          }),
        ]),
      );
      expect(
        discordCalls.find(
          ({ path }) =>
            path === "/channels/channel-1/messages/coding-request/threads",
        )?.body,
      ).toMatchObject({ auto_archive_duration: 4320 });
      expect(
        discordCalls.find(
          ({ path }) =>
            path === "/channels/channel-1/messages/coding-request/threads",
        )?.body,
      ).toMatchObject({ name: "Stream Codex task progress" });

      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "progress",
          jobId: answerJob.job.id,
          progress: {
            phase: "preparing",
            summary: "Codex session started.",
            sessionId: "019-coding-session",
          },
        }),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "progress",
          jobId: answerJob.job.id,
          progress: {
            phase: "exploring",
            summary:
              "**Inspecting the Discord task bridge.**\n### Checking progress delivery.\n\n-# Reviewing the result.",
            kind: "action",
          },
        }),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: answerJob.job.id,
          ok: true,
          content: "done",
          files: ["before.png", "after.png"].map((filename) => ({
            filename,
            contentType: "image/png",
            size: 5,
            data: Buffer.from("image").toString("base64"),
          })),
        }),
      );
      await waitFor(() =>
        discordCalls.find(
          ({ path, body }) =>
            path === "/channels/coding-thread/messages" &&
            (body as { content?: string })?.content === "done",
        ),
      );
      const evidenceUpload = discordCalls.find(
        ({ body }) => (body as { content?: string })?.content === "done",
      )!.formData!;
      expect(JSON.parse(evidenceUpload.get("payload_json") as string)).toEqual({
        content: "done",
        allowed_mentions: { parse: [] },
      });
      for (const [index, filename] of ["before.png", "after.png"].entries()) {
        const image = evidenceUpload.get(`files[${index}]`) as File;
        expect(image.name).toBe(filename);
        expect(image.type).toBe("image/png");
        expect(await image.text()).toBe("image");
      }
      expect(discordCalls.filter(({ formData }) => formData).length).toBe(1);
      expect(
        discordCalls.find(
          ({ path }) => path === "/channels/coding-thread/messages",
        )?.body,
      ).toEqual({
        content:
          "-# Inspecting the Discord task bridge.\n-# Checking progress delivery.\n\n-# Reviewing the result.",
        allowed_mentions: { parse: [] },
      });
      expect(
        discordCalls.some(
          ({ path, method }) =>
            path === "/channels/coding-thread/messages/coding-message-1" &&
            method === "DELETE",
        ),
      ).toBe(true);

      for (const content of ["stop", "status", "also update the docs"]) {
        expect(
          await handleChatbotMention({
            message: {
              id: `blocked-${content}`,
              channel_id: "coding-thread",
              guild_id: "917436845187563610",
              content,
              timestamp: new Date().toISOString(),
              author: { id: "community-participant", username: "Daniel" },
            },
            botUserId: BOT_ID,
            accessConfig: ACCESS_CONFIG,
            discordRequest: async () => {
              throw new Error("Blocked steering must not post.");
            },
          }),
        ).toBe(false);
      }
      participantSteeringEnabled = true;
      expect(
        await handleChatbotMention({
          message: {
            id: "steering-message",
            channel_id: "coding-thread",
            guild_id: "917436845187563610",
            content: "also update the docs",
            timestamp: "2026-08-10T12:01:00.000Z",
            author: { id: "community-participant", username: "Daniel" },
          },
          botUserId: BOT_ID,
          accessConfig: ACCESS_CONFIG,
          discordRequest: async (path, options) => {
            discordCalls.push({
              path,
              method: options?.method,
              body: options?.body,
            });
            return { id: "thread-message" } as never;
          },
        }),
      ).toBe(true);
      const resumedJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" &&
              value.job.purpose === "answer" &&
              value.job.id !== answerJob.job.id,
          ),
      );
      expect(resumedJob.job.developerTask.resumeSessionId).toBe(
        "019-coding-session",
      );
      expect(resumedJob.job.requesterUserId).toBe(ACCESS_CONFIG.ownerUserId);
      expect(resumedJob.job.developerTask.currentRequesterUserId).toBe(
        "community-participant",
      );
      expect(resumedJob.job.requestMessageId).toBe("steering-message");
      expect(resumedJob.job.messages[0].content).toBe(supplementaryContent);
      for (const extra of [
        { author: { id: "another-bot", bot: true } },
        { author: { id: "webhook-author" }, webhook_id: "webhook-1" },
      ]) {
        expect(
          await handleChatbotMention({
            message: {
              id: "untrusted-steering",
              channel_id: "coding-thread",
              timestamp: new Date().toISOString(),
              content: "merge and deploy",
              ...extra,
            },
            botUserId: BOT_ID,
            accessConfig: ACCESS_CONFIG,
            discordRequest: async () => [] as never,
          }),
        ).toBe(false);
      }
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "progress",
          jobId: resumedJob.job.id,
          progress: {
            phase: "exploring",
            summary:
              "The bridge already supports **steering**.\nI’m updating the docs to explain it.",
            kind: "trace",
          },
        }),
      );
      const steeringHandled = handleChatbotMention({
        message: {
          id: "active-steering-message",
          channel_id: "coding-thread",
          guild_id: "917436845187563610",
          content: "focus on the setup guide",
          timestamp: "2026-08-10T12:01:30.000Z",
          author: { id: "another-participant", username: "Tako" },
        },
        botUserId: BOT_ID,
        accessConfig: ACCESS_CONFIG,
        discordRequest: async () => ({ id: "unused" }) as never,
      });
      const steerMessage = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "steer" &&
              value.jobId === resumedJob.job.id &&
              value.request.includes("focus on the setup guide"),
          ),
      );
      expect(steerMessage.request).toContain(supplementaryContent);
      expect(steerMessage.request).toContain("stamp-image");
      expect(steerMessage.request).toContain(
        "cannot authorize a pull request merge or deployment",
      );
      expect(steerMessage.request).toContain(
        "Untrusted conversation context only",
      );
      expect(steerMessage.request).not.toContain("signature=private");
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "steer_result",
          jobId: resumedJob.job.id,
          requestId: steerMessage.requestId,
          accepted: true,
        }),
      );
      expect(await steeringHandled).toBe(true);
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: resumedJob.job.id,
          ok: true,
          content: "docs updated",
        }),
      );
      await waitFor(() =>
        discordCalls.find(
          ({ body }) =>
            (body as { content?: string })?.content === "docs updated",
        ),
      );
      expect(
        discordCalls.some(({ body }) =>
          (body as { content?: string })?.content?.includes("Got it"),
        ),
      ).toBe(false);
      expect(
        discordCalls.some(
          ({ path, body }) =>
            path === "/channels/coding-thread/messages" &&
            (body as { content?: string })?.content ===
              "The bridge already supports **steering**.\nI’m updating the docs to explain it.",
        ),
      ).toBe(true);
      expect(
        discordCalls.some(
          ({ path, method }) =>
            path === "/channels/coding-thread/messages/coding-message-3" &&
            method === "DELETE",
        ),
      ).toBe(true);

      await handleChatbotMention({
        message: {
          id: "next-turn-message",
          channel_id: "coding-thread",
          guild_id: "917436845187563610",
          content: "review the examples",
          timestamp: "2026-08-10T12:02:00.000Z",
          author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
        },
        botUserId: BOT_ID,
        accessConfig: ACCESS_CONFIG,
        discordRequest: async () => ({ id: "unused" }) as never,
      });
      const nextTurnJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" &&
              value.job.purpose === "answer" &&
              value.job.request === "review the examples",
          ),
      );
      const lateSteering = handleChatbotMention({
        message: {
          id: "late-steering-message",
          channel_id: "coding-thread",
          guild_id: "917436845187563610",
          content: "include edge cases",
          timestamp: "2026-08-10T12:02:30.000Z",
          author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
        },
        botUserId: BOT_ID,
        accessConfig: ACCESS_CONFIG,
        discordRequest: async () => ({ id: "unused" }) as never,
      });
      await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "steer" && value.jobId === nextTurnJob.job.id,
          ),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: nextTurnJob.job.id,
          ok: true,
          content: "examples reviewed",
        }),
      );
      expect(await lateSteering).toBe(true);
      const fallbackJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" &&
              value.job.purpose === "answer" &&
              value.job.request.includes(
                "<current_request>\ninclude edge cases\n",
              ),
          ),
      );
      expect(fallbackJob.job.developerTask.resumeSessionId).toBe(
        "019-coding-session",
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "progress",
          jobId: fallbackJob.job.id,
          progress: {
            phase: "reviewing",
            summary: "Pull request merged.",
            completion: "pull_request_merged",
          },
        }),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: fallbackJob.job.id,
          ok: true,
          content: "edge cases included",
        }),
      );
      await waitFor(() =>
        discordCalls.find(
          ({ body }) =>
            (body as { content?: string })?.content === "edge cases included",
        ),
      );

      expect(
        await handleChatbotMention({
          message: {
            id: "ambient-after-merge",
            channel_id: "coding-thread",
            guild_id: "917436845187563610",
            content: "this should stay a normal thread message",
            timestamp: "2026-08-10T12:03:00.000Z",
            author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
          },
          botUserId: BOT_ID,
          accessConfig: ACCESS_CONFIG,
          discordRequest: async () => ({ id: "unused" }) as never,
        }),
      ).toBe(false);

      expect(
        await handleChatbotMention({
          message: {
            id: "mention-after-merge",
            channel_id: "coding-thread",
            guild_id: "917436845187563610",
            content: `<@${BOT_ID}> review the release notes`,
            timestamp: "2026-08-10T12:03:30.000Z",
            author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
            mentions: [{ id: BOT_ID }],
          },
          botUserId: BOT_ID,
          accessConfig: ACCESS_CONFIG,
          discordRequest: async () => ({ id: "unused" }) as never,
        }),
      ).toBe(true);
      const mentionedJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" &&
              value.job.purpose === "answer" &&
              value.job.request === "review the release notes",
          ),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: mentionedJob.job.id,
          ok: true,
          content: "release notes reviewed",
        }),
      );
      await waitFor(() =>
        discordCalls.find(
          ({ body }) =>
            (body as { content?: string })?.content ===
            "release notes reviewed",
        ),
      );

      expect(
        await handleChatbotMention({
          message: {
            id: "reply-after-merge",
            channel_id: "coding-thread",
            guild_id: "917436845187563610",
            content: "check the changelog too",
            timestamp: "2026-08-10T12:04:00.000Z",
            author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
            mentions: [{ id: BOT_ID }],
            referenced_message: {
              id: "bot-result",
              channel_id: "coding-thread",
              content: "release notes reviewed",
              timestamp: "2026-08-10T12:03:45.000Z",
              author: { id: BOT_ID, username: "MiniSago" },
            },
          },
          botUserId: BOT_ID,
          accessConfig: ACCESS_CONFIG,
          discordRequest: async () => ({ id: "unused" }) as never,
        }),
      ).toBe(true);
      const repliedJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" &&
              value.job.purpose === "answer" &&
              value.job.request === "check the changelog too",
          ),
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: repliedJob.job.id,
          ok: true,
          content: "changelog checked",
        }),
      );
      await waitFor(() =>
        discordCalls.find(
          ({ body }) =>
            (body as { content?: string })?.content === "changelog checked",
        ),
      );
      expect(
        await handleChatbotMention({
          message: {
            id: "attachment-only-follow-up",
            channel_id: "coding-thread",
            guild_id: "917436845187563610",
            content: `<@${BOT_ID}>`,
            mentions: [{ id: BOT_ID }],
            timestamp: new Date().toISOString(),
            author: { id: "community-participant", username: "Daniel" },
            attachments: supplement().attachments,
          },
          botUserId: BOT_ID,
          accessConfig: ACCESS_CONFIG,
          discordRequest: async () => [] as never,
        }),
      ).toBe(true);
      const attachmentJob = await waitFor(() =>
        sent
          .map((value) => JSON.parse(value))
          .find(
            (value) =>
              value.type === "job" &&
              value.job.requestMessageId === "attachment-only-follow-up",
          ),
      );
      expect(attachmentJob.job.request).toBe(
        "Use the attached files to continue the task.",
      );
      expect(attachmentJob.job.requestMessage.attachments[0].id).toBe(
        "stamp-image",
      );
      expect(attachmentJob.job.developerTask.currentRequesterUserId).toBe(
        "community-participant",
      );
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: attachmentJob.job.id,
          ok: true,
          content: "",
          files: [
            {
              filename: "stamp.png",
              contentType: "image/png",
              size: 5,
              data: Buffer.from("stamp").toString("base64"),
            },
          ],
        }),
      );
      await waitFor(() =>
        discordCalls.find(
          ({ formData }) =>
            (formData?.get("files[0]") as File | undefined)?.name ===
            "stamp.png",
        ),
      );
      const imageOnly = discordCalls.find(
        ({ formData }) =>
          (formData?.get("files[0]") as File | undefined)?.name === "stamp.png",
      )!;
      expect(imageOnly.body).toEqual({ allowed_mentions: { parse: [] } });
    } finally {
      await contextClient?.close();
      mcpServer.stop(true);
      macAgentBridge.close(socket);
      if (oldWorkerSecret === undefined)
        delete process.env.MINISAGO_WORKER_BRIDGE_SECRET;
      else process.env.MINISAGO_WORKER_BRIDGE_SECRET = oldWorkerSecret;
      if (oldMacSecret === undefined)
        delete process.env.MINISAGO_MAC_BRIDGE_SECRET;
      else process.env.MINISAGO_MAC_BRIDGE_SECRET = oldMacSecret;
    }
  });

  test.each([10, 11, 12])(
    "reuses an existing Discord thread of type %i",
    async (type) => {
      const paths: string[] = [];
      const threadId = await createDeveloperThread(
        {
          id: "retry",
          channel_id: "existing-thread",
          timestamp: "2026-10-02T18:11:00.000Z",
        },
        "Continue coding",
        (async (path) => {
          paths.push(path);
          return { type };
        }) as DiscordRequest,
      );
      expect(threadId).toBe("existing-thread");
      expect(paths).toEqual(["/channels/existing-thread"]);
    },
  );

  test.each(["owner", "no-session", "other-owner", "other-repository"])(
    "recovers only a matching coding task after restart (%s)",
    async (scenario) => {
      const oldSecret = process.env.MINISAGO_WORKER_BRIDGE_SECRET;
      const secret = "recover-coding-thread-secret-at-least-32-bytes";
      process.env.MINISAGO_WORKER_BRIDGE_SECRET = secret;
      const sent: string[] = [];
      const socket = {
        data: { authenticated: false },
        send: (value: string) => sent.push(value),
        close: () => undefined,
      } as unknown as ServerWebSocket<MacAgentSocketData>;
      const threadId = `recovered-thread-${scenario}`;
      const paths: string[] = [];
      const preservedTask = {
        id: "preserved-task",
        requesterUserId:
          scenario === "other-owner"
            ? "another-owner"
            : ACCESS_CONFIG.ownerUserId,
        repository:
          scenario === "other-repository"
            ? "sago-cream/other-repo"
            : "sago-cream/mini-sago",
        request: "Finish the original change and publish a draft PR",
        title: "Original coding task",
        ...(scenario === "no-session"
          ? {}
          : { resumeSessionId: "preserved-codex-session" }),
      };
      try {
        macAgentBridge.open(socket);
        macAgentBridge.message(
          socket,
          JSON.stringify({
            type: "authenticate",
            protocolVersion: CHATBOT_PROTOCOL_VERSION,
            secret,
            workerId: "oracle",
            repositories: ["sago-cream/mini-sago"],
          }),
        );
        macAgentBridge.message(
          socket,
          JSON.stringify({
            type: "availability",
            available: true,
            capacity: 1,
          }),
        );
        const handled = handleChatbotMention({
          message: {
            id: `retry-${scenario}`,
            channel_id: threadId,
            timestamp: "2026-10-02T18:11:00.000Z",
            guild_id: "917436845187563610",
            content: `<@${BOT_ID}> try again`,
            author: { id: ACCESS_CONFIG.ownerUserId },
            mentions: [{ id: BOT_ID }],
          },
          botUserId: BOT_ID,
          accessConfig: ACCESS_CONFIG,
          executionOptions: {
            lazyPreviousTrace: true,
            routeRequest: async () =>
              JSON.stringify({
                route: "oracle",
                repository: "sago-cream/mini-sago",
              }),
          },
          discordRequest: (async (path, options) => {
            paths.push(path);
            if (path === `/channels/${threadId}`) return { type: 11 };
            if (path.endsWith("/threads"))
              throw new Error("Discord forbids nested threads");
            if (options?.method === "POST") return { id: "reply" };
            return [];
          }) as DiscordRequest,
        });
        const traceJob = await waitFor(() =>
          sent
            .map((value) => JSON.parse(value))
            .find(
              (value) =>
                value.type === "job" && value.job.purpose === "trace_lookup",
            ),
        );
        macAgentBridge.message(
          socket,
          JSON.stringify({
            type: "result",
            jobId: traceJob.job.id,
            ok: true,
            content: JSON.stringify({
              status: "not_found",
              developerTask: preservedTask,
            }),
          }),
        );
        expect(await handled).toBe(true);
        const answer = await waitFor(() =>
          sent
            .map((value) => JSON.parse(value))
            .find(
              (value) => value.type === "job" && value.job.purpose === "answer",
            ),
        );
        expect(answer.job.channelId).toBe(threadId);
        expect(answer.job.request).toBe(
          scenario === "no-session"
            ? `${preservedTask.request}\n\nAdditional direction: try again`
            : "try again",
        );
        expect(paths.some((path) => path.endsWith("/threads"))).toBe(false);
        if (scenario === "owner" || scenario === "no-session") {
          expect(answer.job.developerTask).toEqual({
            id: "preserved-task",
            title: "Original coding task",
            ...(scenario === "no-session"
              ? {}
              : { resumeSessionId: "preserved-codex-session" }),
          });
        } else {
          expect(answer.job.developerTask.id).not.toBe("preserved-task");
          expect(answer.job.developerTask.resumeSessionId).toBeUndefined();
        }
        macAgentBridge.message(
          socket,
          JSON.stringify({
            type: "result",
            jobId: answer.job.id,
            ok: true,
            content: "Finished the change.",
          }),
        );
        await waitFor(() =>
          paths.find((path) => path === `/channels/${threadId}/messages`),
        );
      } finally {
        macAgentBridge.close(socket);
        if (oldSecret === undefined)
          delete process.env.MINISAGO_WORKER_BRIDGE_SECRET;
        else process.env.MINISAGO_WORKER_BRIDGE_SECRET = oldSecret;
      }
    },
  );

  test("continues the original requester's next message after an answer", () => {
    let now = 1_000;
    const conversations = new ChatbotConversationTracker(90_000, () => now);
    const followUp = {
      id: "follow-up-1",
      channel_id: "channel-1",
      guild_id: "917436845187563610",
      content: "那明天呢",
      timestamp: "2026-07-25T11:00:00.000Z",
      author: { id: "member-1", username: "Member" },
    };

    conversations.activate("channel-1", "member-1");

    expect(conversations.take(followUp, conversations.recordMessage())).toBe(
      true,
    );
    expect(
      conversations.take(
        { ...followUp, id: "follow-up-2" },
        conversations.recordMessage(),
      ),
    ).toBe(false);

    conversations.activate("channel-1", "member-1");
    expect(
      conversations.take(
        {
          ...followUp,
          id: "interruption-1",
          author: { id: "member-2", username: "Other member" },
        },
        conversations.recordMessage(),
      ),
    ).toBe(false);
    expect(
      conversations.take(
        { ...followUp, id: "follow-up-3" },
        conversations.recordMessage(),
      ),
    ).toBe(false);

    conversations.activate("channel-1", "member-1");
    expect(
      conversations.take(
        {
          ...followUp,
          id: "mentioned-member-1",
          content: "<@member-2> 你記得嗎",
          mentions: [{ id: "member-2" }],
        },
        conversations.recordMessage(),
      ),
    ).toBe(false);
    expect(
      conversations.take(
        { ...followUp, id: "follow-up-4" },
        conversations.recordMessage(),
      ),
    ).toBe(false);

    conversations.activate("channel-1", "member-1");
    now += 90_000;
    expect(
      conversations.take(
        { ...followUp, id: "follow-up-5" },
        conversations.recordMessage(),
      ),
    ).toBe(false);
  });

  test("does not turn messages queued before an answer into follow-ups", () => {
    const conversations = new ChatbotConversationTracker();
    const queuedSequence = conversations.recordMessage();
    const followUp = {
      id: "queued-message",
      channel_id: "channel-1",
      guild_id: "917436845187563610",
      content: "現在也有記憶",
      timestamp: "2026-08-23T14:12:34.762Z",
      author: { id: "member-1", username: "Member" },
    };

    conversations.activate("channel-1", "member-1");

    expect(conversations.take(followUp, queuedSequence)).toBe(false);
    expect(
      conversations.take(
        { ...followUp, id: "new-follow-up", content: "那明天呢" },
        conversations.recordMessage(),
      ),
    ).toBe(true);
  });

  test("stays silent while paused until an addressed wake request", async () => {
    const quietTracker = new ChannelQuietTracker();
    const requests: Array<{ path: string; body: unknown }> = [];
    const discordRequest: DiscordRequest = async (path, options) => {
      requests.push({ path, body: options?.body });
      return undefined as never;
    };
    quietTracker.pause("channel-1", 30);

    expect(
      await handleChatbotMention({
        message: {
          id: "quiet-mention",
          channel_id: "channel-1",
          guild_id: "917436845187563610",
          content: `<@${BOT_ID}> what time is it?`,
          timestamp: "2026-08-11T04:00:00.000Z",
          author: { id: "member-1", username: "Member" },
          mentions: [{ id: BOT_ID }],
        },
        botUserId: BOT_ID,
        accessConfig: ACCESS_CONFIG,
        discordRequest,
        quietTracker,
      }),
    ).toBe(true);
    expect(requests).toEqual([]);
    expect(quietTracker.isPaused("channel-1")).toBe(true);

    expect(
      await handleChatbotMention({
        message: {
          id: "wake-mention",
          channel_id: "channel-1",
          guild_id: "917436845187563610",
          content: `<@${BOT_ID}> wake up and reply again`,
          timestamp: "2026-08-11T04:01:00.000Z",
          author: { id: "member-1", username: "Member" },
          mentions: [{ id: BOT_ID }],
        },
        botUserId: BOT_ID,
        accessConfig: ACCESS_CONFIG,
        discordRequest,
        quietTracker,
      }),
    ).toBe(true);
    expect(quietTracker.isPaused("channel-1")).toBe(false);
    expect(requests.at(-1)).toMatchObject({
      path: "/channels/channel-1/messages",
      body: { content: "我現在沒接上工作機 晚點再叫我一次 💤" },
    });
  });

  test("accepts reply-only, reaction-only, and combined mention decisions", () => {
    expect(
      parseChatbotAnswerDecision(
        '{"reply":"看得到兩個","reaction":{"emoji":"sago:emoji-1"}}',
      ),
    ).toEqual({
      reply: "看得到兩個",
      reactionEmoji: "sago:emoji-1",
    });
    expect(
      parseChatbotAnswerDecision('{"reply":null,"reaction":{"emoji":"👀"}}'),
    ).toEqual({ reply: null, reactionEmoji: "👀" });
    expect(
      parseChatbotAnswerDecision('{"reply":"可以啊","reaction":null}'),
    ).toEqual({ reply: "可以啊" });
    expect(parseChatbotAnswerDecision("舊版純文字回答")).toEqual({
      reply: null,
    });
    expect(
      parseChatbotAnswerDecision(
        JSON.stringify({ reply: "x".repeat(1_901), reaction: null }),
      ),
    ).toEqual({ reply: null });
  });

  test("enforces first-person MiniSago identity before posting", () => {
    expect(
      parseChatbotAnswerDecision(
        JSON.stringify({
          reply: "You mean MiniSago's globally available built-ins.",
          reaction: null,
        }),
      ),
    ).toEqual({ reply: "You mean my globally available built-ins." });
    expect(
      parseChatbotAnswerDecision(
        JSON.stringify({
          reply: "這些是迷你西米露的全域功能",
          reaction: null,
        }),
      ),
    ).toEqual({ reply: "這些是我的全域功能" });
    expect(
      parseChatbotAnswerDecision(
        JSON.stringify({
          reply: "MiniSago handles reminders.",
          reaction: null,
        }),
      ),
    ).toEqual({ reply: null });
    expect(
      parseChatbotAnswerDecision(
        JSON.stringify({
          reply: enforceFirstPersonIdentity(
            "<self-introduction>MiniSago</self-introduction> here, reporting in.",
            false,
          ),
          reaction: null,
        }),
      ),
    ).toEqual({ reply: "MiniSago here, reporting in." });
    expect(
      parseChatbotAnswerDecision(
        JSON.stringify({ reply: "I'm MiniSago.", reaction: null }),
      ),
    ).toEqual({ reply: null });
  });

  test("binds a proposed mention reaction to the current message", async () => {
    const calls: unknown[] = [];
    const capabilities = {
      expiresAt: Date.now() + 60_000,
      tools: [
        {
          name: "discord.add_reaction",
          risk: "ambient" as const,
          description: "react",
          inputSchema: {},
        },
      ],
      customEmojiValues: new Set(["sago:emoji-1"]),
    };

    const result = await executeChatbotAnswerDecision({
      content: '{"reply":"這顆可以用","reaction":{"emoji":"sago:emoji-1"}}',
      message: { id: "mention-1", channel_id: "channel-1" },
      reactionCapabilities: capabilities,
      reactionBroker: {
        addReaction: async (options) => {
          calls.push(options);
          return true;
        },
      },
      discordRequest: async () => undefined as never,
    });

    expect(result).toEqual({ reply: "這顆可以用", reacted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channelId: "channel-1",
      messageId: "mention-1",
      emoji: "sago:emoji-1",
    });
  });

  test("extracts a natural request from either Discord mention form", () => {
    expect(extractMentionRequest(`<@${BOT_ID}> summarize this`, BOT_ID)).toBe(
      "summarize this",
    );
    expect(extractMentionRequest(`hello <@!${BOT_ID}>`, BOT_ID)).toBe("hello");
    expect(extractMentionRequest("summarize this", BOT_ID)).toBeNull();
    expect(
      extractMentionRequest(
        "<@&1522110684610166907> summarize this",
        BOT_ID,
        ACCESS_CONFIG.roleIds,
      ),
    ).toBe("summarize this");
    expect(
      extractMentionRequest(
        "<@&1522110684610166908> summarize this",
        BOT_ID,
        ACCESS_CONFIG.roleIds,
      ),
    ).toBeNull();
  });

  test("labels how the current request addresses MiniSago", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      guild_id: "917436845187563610",
      content: `<@${BOT_ID}> 你怎麼看`,
      timestamp: "2026-08-09T12:00:00.000Z",
      author: { id: "member-1", username: "Member" },
      mentions: [{ id: BOT_ID }],
    };

    expect(chatbotAddressingMode(base, BOT_ID, ACCESS_CONFIG)).toBe("mention");
    expect(
      chatbotAddressingMode(
        {
          ...base,
          content: "<@&1522110684610166907> 你怎麼看",
          mentions: [],
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBe("mention");
    expect(
      chatbotAddressingMode(
        {
          ...base,
          content: "她怎麼會這樣",
          referenced_message: {
            id: "bot-message-1",
            channel_id: "channel-1",
            content: "我剛剛看錯了",
            timestamp: "2026-08-09T11:59:00.000Z",
            author: { id: BOT_ID, username: "MiniSago", bot: true },
          },
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBe("reply");
    expect(
      chatbotAddressingMode(
        {
          ...base,
          guild_id: undefined,
          content: "妳怎麼看",
          author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
          mentions: [],
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBe("dm");
    expect(
      chatbotAddressingMode(
        { ...base, content: "她怎麼會這樣", mentions: [] },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
  });

  test("treats replies that ping MiniSago as chatbot requests", () => {
    const message = {
      id: "reply-1",
      channel_id: "channel-1",
      content: "再找一次",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "Hsi" },
      mentions: [{ id: BOT_ID }],
      referenced_message: {
        id: "bot-message-1",
        channel_id: "channel-1",
        content: "我剛剛沒找到",
        timestamp: "2026-07-20T10:59:00.000Z",
        author: { id: BOT_ID, username: "MiniSago", bot: true },
      },
    };

    expect(extractChatbotRequest(message, BOT_ID, ACCESS_CONFIG)).toBe(
      "再找一次",
    );
    expect(
      extractChatbotRequest(
        { ...message, content: undefined },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBe("");
    expect(
      extractChatbotRequest(
        {
          ...message,
          referenced_message: {
            ...message.referenced_message,
            author: { id: "other-user", username: "Other" },
          },
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
    expect(
      extractChatbotRequest(
        { ...message, mentions: [] },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
  });

  test("treats only the owner's unmentioned DMs as chatbot requests", () => {
    const directMessage = {
      id: "dm-1",
      channel_id: "dm-channel-1",
      content: "幫我找一下",
      timestamp: "2026-07-22T11:00:00.000Z",
      author: { id: "917446775873343600", username: "Hsi" },
    };

    expect(extractChatbotRequest(directMessage, BOT_ID, ACCESS_CONFIG)).toBe(
      "幫我找一下",
    );
    expect(
      extractChatbotRequest(
        {
          ...directMessage,
          author: { id: "other-user", username: "Other" },
        },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
    expect(
      extractChatbotRequest(
        { ...directMessage, guild_id: "917436845187563610" },
        BOT_ID,
        ACCESS_CONFIG,
      ),
    ).toBeNull();
  });

  test("keeps the replied-to MiniSago message in request context", () => {
    const requestMessage = toChatbotMessage(
      {
        id: "reply-1",
        channel_id: "channel-1",
        content: "再找一次",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "user-1", username: "Hsi" },
        referenced_message: {
          id: "bot-message-1",
          channel_id: "channel-1",
          content: "我剛剛沒找到",
          timestamp: "2026-07-20T10:59:00.000Z",
          author: { id: BOT_ID, username: "MiniSago", bot: true },
        },
      },
      BOT_ID,
    );

    expect(requestMessage.referencedMessage).toMatchObject({
      id: "bot-message-1",
      role: "assistant",
      author: "MiniSago",
      content: "我剛剛沒找到",
    });
  });

  test("authorizes configured guilds, channels, and the owner", () => {
    expect(
      isChatbotAuthorized("member-1", ACCESS_CONFIG, "917436845187563610"),
    ).toBe(true);
    expect(
      isChatbotAuthorized("member-2", ACCESS_CONFIG, "1282936453134815275"),
    ).toBe(true);
    expect(
      isChatbotAuthorized("member-3", ACCESS_CONFIG, "1439286996869713992"),
    ).toBe(true);
    expect(
      isChatbotAuthorized("member-4", ACCESS_CONFIG, "1521168712579682567"),
    ).toBe(true);
    expect(
      isChatbotAuthorized(
        "member-5",
        ACCESS_CONFIG,
        "other-guild",
        "1517766866964316201",
      ),
    ).toBe(true);
    expect(
      isChatbotAuthorized(
        "member-5",
        ACCESS_CONFIG,
        "other-guild",
        "other-channel",
      ),
    ).toBe(false);
    expect(isChatbotAuthorized("member-5", ACCESS_CONFIG, "other-guild")).toBe(
      false,
    );
    expect(isChatbotAuthorized("member-5", ACCESS_CONFIG)).toBe(false);
    expect(
      isChatbotAuthorized("917446775873343600", ACCESS_CONFIG, "other-guild"),
    ).toBe(true);
    expect(isChatbotAuthorized("917446775873343600", ACCESS_CONFIG)).toBe(true);
  });

  test("allows community code questions into the read-only chat path", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "message-community-pr",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: `<@${BOT_ID}> review https://github.com/sago-cream/health-check-system/pull/42`,
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "member-1", username: "Member" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "message-community-pr" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("responds when another bot mentions MiniSago", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "message-other-bot",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: `<@${BOT_ID}> hello from another bot`,
        timestamp: "2026-08-26T11:00:00.000Z",
        author: { id: "other-bot", username: "Other Bot", bot: true },
        mentions: [{ id: BOT_ID }],
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "message-other-bot" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("ignores MiniSago's own messages", async () => {
    const handled = await handleChatbotMention({
      message: {
        id: "message-self",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: `<@${BOT_ID}> accidental self mention`,
        timestamp: "2026-08-26T11:00:00.000Z",
        author: { id: BOT_ID, username: "MiniSago", bot: true },
        mentions: [{ id: BOT_ID }],
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async () => undefined as never,
    });

    expect(handled).toBe(false);
  });

  test("routes slash command failures through the private responder", async () => {
    const responses: Array<string | string[] | null> = [];
    const discordPaths: string[] = [];
    const handled = await handleChatbotMention({
      message: {
        id: "interaction-1",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: "private question",
        timestamp: "2026-08-18T11:00:00.000Z",
        author: { id: "member-1", username: "Member" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path) => {
        discordPaths.push(path);
        return undefined as never;
      },
      invocation: {
        request: "private question",
        addressingMode: "mention",
        chatOnly: true,
        recentContext: true,
        silent: true,
        respond: async (content) => {
          responses.push(content);
        },
      },
    });

    expect(handled).toBe(true);
    expect(discordPaths).toEqual([]);
    expect(responses).toEqual(["我現在沒接上工作機 晚點再叫我一次 💤"]);
  });

  test("gives unauthorized guild members a safe Chinese reply", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "message-unauthorized",
        channel_id: "channel-1",
        guild_id: "other-guild",
        content: `<@${BOT_ID}> help`,
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "other-user", username: "Other" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "message-unauthorized" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests).toEqual([
      {
        path: "/channels/channel-1/messages?limit=1",
        body: undefined,
      },
      {
        path: "/channels/channel-1/messages",
        body: {
          content: "在這個伺服器裡我暫時只聽 <@917446775873343600> 的 抱歉啦",
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  test("responds to a MiniSago reply without requiring another mention", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "reply-1",
        channel_id: "channel-1",
        guild_id: "917436845187563610",
        content: "再找一次",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "member-1", username: "Member" },
        mentions: [{ id: BOT_ID }],
        referenced_message: {
          id: "bot-message-1",
          channel_id: "channel-1",
          content: "我剛剛沒找到",
          timestamp: "2026-07-20T10:59:00.000Z",
          author: { id: BOT_ID, username: "MiniSago", bot: true },
        },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "reply-1" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("responds to the owner's DM without requiring a mention", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const handled = await handleChatbotMention({
      message: {
        id: "dm-1",
        channel_id: "dm-channel-1",
        content: "幫我找一下",
        timestamp: "2026-07-22T11:00:00.000Z",
        author: { id: "917446775873343600", username: "Hsi" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "dm-1" }] as never;
        }
        return undefined as never;
      },
    });

    expect(handled).toBe(true);
    expect(requests.at(-1)).toEqual({
      path: "/channels/dm-channel-1/messages",
      body: {
        content: "我現在沒接上工作機 晚點再叫我一次 💤",
        allowed_mentions: { parse: [] },
      },
    });
  });

  test("uses a reply when newer channel messages make the relationship unclear", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    await handleChatbotMention({
      message: {
        id: "message-unauthorized",
        channel_id: "channel-1",
        guild_id: "other-guild",
        content: `<@${BOT_ID}> help`,
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "other-user", username: "Other" },
      },
      botUserId: BOT_ID,
      accessConfig: ACCESS_CONFIG,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("?limit=1")) {
          return [{ id: "newer-message" }] as never;
        }
        return undefined as never;
      },
    });

    expect(requests.at(-1)).toMatchObject({
      path: "/channels/channel-1/messages",
      body: {
        message_reference: {
          message_id: "message-unauthorized",
          fail_if_not_exists: false,
        },
      },
    });
  });

  test("posts blank-line-separated answers sequentially", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const message = {
      id: "request-1",
      channel_id: "channel-1",
      content: `<@${BOT_ID}> help`,
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "User" },
    };
    const contents = formatDiscordAnswers(
      "第一段\n還在第一段\n\n第二段\n\n\n第三段",
    );
    await postChatbotResponse(message, contents, async (path, options) => {
      requests.push({ path, body: options?.body });
      if (path.endsWith("?limit=1")) {
        return [{ id: "newer-message" }] as never;
      }
      return undefined as never;
    });

    expect(contents).toEqual(["第一段\n還在第一段", "第二段", "第三段"]);
    expect(requests.slice(1).map(({ body }) => body)).toEqual([
      {
        content: "第一段\n還在第一段",
        message_reference: {
          message_id: "request-1",
          fail_if_not_exists: false,
        },
        allowed_mentions: { parse: [], replied_user: true },
      },
      {
        content: "第二段",
        allowed_mentions: { parse: [] },
      },
      {
        content: "第三段",
        allowed_mentions: { parse: [] },
      },
    ]);
  });

  test("keeps fenced code blocks together across blank lines", () => {
    expect(
      formatDiscordAnswers("前言\n\n```text\n第一行\n\n第二行\n```\n\n結尾"),
    ).toEqual(["前言", "```text\n第一行\n\n第二行\n```", "結尾"]);

    expect(
      formatDiscordAnswers(
        "~~~ts\nconst first = 1;\n```not a closing fence\n\nconst second = 2;\n~~~",
      ),
    ).toEqual([
      "~~~ts\nconst first = 1;\n```not a closing fence\n\nconst second = 2;\n~~~",
    ]);
  });

  test("uploads a Mac file with the first Discord response", async () => {
    let uploaded: FormData | undefined;
    const message = {
      id: "request-file",
      channel_id: "channel-1",
      content: `<@${BOT_ID}> send the notes file`,
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: ACCESS_CONFIG.ownerUserId, username: "Hsi" },
    };

    await postChatbotResponse(
      message,
      "found it",
      async (path, options) => {
        if (path.endsWith("?limit=1")) return [message] as never;
        uploaded = options?.formData;
        return undefined as never;
      },
      [
        {
          filename: "notes.txt",
          contentType: "text/plain",
          size: 5,
          data: Buffer.from("hello").toString("base64"),
        },
      ],
    );

    expect(uploaded).toBeDefined();
    expect(JSON.parse(String(uploaded!.get("payload_json")))).toEqual({
      content: "found it",
      allowed_mentions: { parse: [] },
    });
    const file = uploaded!.get("files[0]") as File;
    expect(file.name).toBe("notes.txt");
    expect(file.type).toStartWith("text/plain");
    expect(await file.text()).toBe("hello");
  });

  test("accepts only human context messages other than the request", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "Hsi" },
    };

    expect(isHumanContextMessage(base, "request")).toBe(true);
    expect(isHumanContextMessage(base, "message-1")).toBe(false);
    expect(
      isHumanContextMessage(
        { ...base, author: { ...base.author, bot: true } },
        "request",
      ),
    ).toBe(false);
  });

  test("backfills beyond seven days until it has 100 context messages", async () => {
    const recentPage = Array.from({ length: 100 }, (_, index) => ({
      id: `recent-${index}`,
      channel_id: "channel-1",
      content: `recent ${index}`,
      timestamp: "2026-07-19T12:00:00.000Z",
      author: {
        id: `user-${index}`,
        username: `Recent ${index}`,
        bot: index % 4 === 0,
      },
      webhook_id: index % 2 === 1 ? `webhook-${index}` : undefined,
    }));
    const olderPage = Array.from({ length: 50 }, (_, index) => ({
      id: `older-${index}`,
      channel_id: "channel-1",
      content: `older ${index}`,
      timestamp: "2026-07-01T12:00:00.000Z",
      author: { id: `older-user-${index}`, username: `Older ${index}` },
    }));
    const requestedPaths: string[] = [];

    const messages = await getRecentHumanMessages({
      channelId: "channel-1",
      requestMessageId: "request",
      botUserId: BOT_ID,
      now: new Date("2026-07-20T12:00:00.000Z"),
      discordRequest: async (path) => {
        requestedPaths.push(path);
        return (requestedPaths.length === 1 ? recentPage : olderPage) as never;
      },
    });

    expect(requestedPaths).toHaveLength(2);
    expect(messages).toHaveLength(100);
    expect(messages[0]?.id).toBe("older-49");
    expect(messages.at(-1)?.id).toBe("recent-0");
  });

  test("loads a small context window around the request", async () => {
    const requestedPaths: string[] = [];
    const nearby = Array.from({ length: 25 }, (_, index) => ({
      id: index === 4 ? "request" : `message-${index}`,
      channel_id: "channel-1",
      content: `message ${index}`,
      timestamp: `2026-07-20T11:${String(59 - index).padStart(2, "0")}:00.000Z`,
      author: {
        id: `user-${index}`,
        username: `User ${index}`,
        bot: index === 3,
      },
    }));

    const messages = await getNearbyHumanMessages({
      channelId: "channel-1",
      requestMessageId: "request",
      botUserId: BOT_ID,
      discordRequest: async (path) => {
        requestedPaths.push(path);
        return nearby as never;
      },
    });

    expect(requestedPaths).toEqual([
      "/channels/channel-1/messages?around=request&limit=25",
    ]);
    expect(messages).toHaveLength(20);
    expect(messages[0]?.id).toBe("message-20");
    expect(messages.at(-1)?.id).toBe("message-0");
    expect(messages.some((message) => message.id === "request")).toBe(false);
    expect(messages.some((message) => message.id === "message-3")).toBe(true);
  });

  test("keeps MiniSago replies and other bot messages as context", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "earlier answer",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: BOT_ID, username: "MiniSago", bot: true },
    };

    expect(isConversationContextMessage(base, "request", BOT_ID)).toBe(true);
    expect(
      isConversationContextMessage(
        { ...base, author: { ...base.author, id: "other-bot" } },
        "request",
        BOT_ID,
      ),
    ).toBe(true);
    expect(toChatbotMessage(base, BOT_ID).role).toBe("assistant");
  });

  test("includes Discord server and global display names as author aliases", () => {
    const message = toChatbotMessage({
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: {
        id: "user-1",
        username: "daniel_account",
        global_name: "Daniel",
      },
      member: { nick: "午前" },
    });

    expect(message.author).toBe("午前");
    expect(message.authorAliases).toEqual(["午前", "Daniel", "daniel_account"]);
    expect(
      toChatbotMessage({
        id: "message-2",
        channel_id: "channel-1",
        content: "hello again",
        timestamp: "2026-07-20T11:01:00.000Z",
        author: { id: "user-1", username: "Daniel", global_name: "daniel" },
      }).authorAliases,
    ).toBeUndefined();
  });

  test("accepts only structured previous-trace lookup results", () => {
    const trace = {
      contextMessageCount: 20,
      searchQueries: [],
      searchResultCount: 0,
      memberQueries: [],
      elapsedMs: 1_200,
      model: "test-model",
      promptVersion: 20,
    };
    expect(
      parsePreviousTraceLookup(JSON.stringify({ status: "complete", trace })),
    ).toEqual({ status: "complete", trace });
    expect(parsePreviousTraceLookup('{"status":"not_found"}')).toEqual({
      status: "not_found",
    });
    expect(parsePreviousTraceLookup("not json")).toEqual({
      status: "unavailable",
    });
    const developerTask = {
      id: "preserved-task",
      requesterUserId: "owner",
      repository: "sago-cream/mini-sago",
      request: "finish it",
      resumeSessionId: "codex-session",
    };
    expect(
      parsePreviousTraceLookup(
        JSON.stringify({ status: "complete", trace, developerTask }),
      ),
    ).toEqual({ status: "complete", trace, developerTask });
    for (const invalid of [
      { id: ".." },
      { id: "../escape" },
      { resumeSessionId: 123 },
      { requesterUserId: null },
      { repository: null },
    ]) {
      expect(
        parsePreviousTraceLookup(
          JSON.stringify({
            status: "not_found",
            developerTask: { ...developerTask, ...invalid },
          }),
        ),
      ).toEqual({ status: "not_found" });
    }
  });

  test("validates the router's proposed execution route and repository", () => {
    const repositories = ["sago-cream/mini-sago", "Kiwi/backend"];
    expect(
      parseExecutionRoute(
        '{"route":"oracle","repository":"sago-cream/mini-sago","threadTitle":"  Review   pull request  ","reason":"PR review"}',
        repositories,
      ),
    ).toEqual({
      route: "oracle",
      repository: "sago-cream/mini-sago",
      threadTitle: "Review pull request",
    });
    expect(
      parseExecutionRoute(
        '{"route":"chat","repository":"sago-cream/mini-sago","threadTitle":null,"reason":"discussion"}',
        repositories,
      ),
    ).toEqual({
      route: "chat",
    });
    expect(
      parseExecutionRoute(
        '{"route":"oracle","repository":"Kiwi/backend","threadTitle":null,"reason":"issue update"}',
        repositories,
      ),
    ).toEqual({
      route: "oracle",
      repository: "Kiwi/backend",
    });
    expect(
      parseExecutionRoute(
        '{"route":"oracle","repository":"invented/private","threadTitle":null,"reason":"repo work"}',
        repositories,
      ),
    ).toEqual({
      route: "oracle",
    });
    expect(parseExecutionRoute("not json", repositories)).toEqual({
      route: "unclear",
    });
    expect(executionRouteOrChat("unclear")).toBe("chat");
  });

  test("asks for a repository instead of dispatching an invalid dev job", () => {
    expect(missingDeveloperRepositoryResponse("oracle")).toBe(
      "這題要碰程式碼 但我還不知道是哪個 GitHub repo\n告訴我是哪個 我就能繼續",
    );
    expect(
      missingDeveloperRepositoryResponse("oracle", undefined, [
        "sago-cream/mini-sago",
        "Kiwi/backend",
      ]),
    ).toBe(
      "這題要碰程式碼 但我還不知道是哪個 GitHub repo\n目前可用的有 `sago-cream/mini-sago` `Kiwi/backend`\n告訴我是哪個 我就能繼續",
    );
    expect(
      missingDeveloperRepositoryResponse("oracle", "sago-cream/mini-sago"),
    ).toBeUndefined();
    expect(missingDeveloperRepositoryResponse("chat")).toBeUndefined();
    expect(missingDeveloperRepositoryResponse("unclear")).toBeUndefined();
  });

  test("looks up Discord member aliases without classifying the request", async () => {
    const paths: string[] = [];
    const results = await lookupGuildMembers({
      guildId: "guild-1",
      queries: ["kiseki", "<@123456789012345678>"],
      discordRequest: async (path) => {
        paths.push(path);
        const member = {
          nick: "Kiseki",
          avatar: "a_server-avatar",
          user: {
            id: "123456789012345678",
            username: "kiseki_account",
            global_name: "Daniel",
            avatar: "global-avatar",
          },
        };
        return (path.includes("/members/search?") ? [member] : member) as never;
      },
    });

    expect(paths[0]).toContain("/members/search?query=kiseki");
    expect(paths[1]).toBe("/guilds/guild-1/members/123456789012345678");
    expect(results).toEqual([
      {
        query: "kiseki",
        names: ["Kiseki", "Daniel", "kiseki_account"],
        avatarUrl:
          "https://cdn.discordapp.com/guilds/guild-1/users/123456789012345678/avatars/a_server-avatar.gif?size=4096",
      },
      {
        query: "<@123456789012345678>",
        names: ["Kiseki", "Daniel", "kiseki_account"],
        avatarUrl:
          "https://cdn.discordapp.com/guilds/guild-1/users/123456789012345678/avatars/a_server-avatar.gif?size=4096",
      },
    ]);
  });

  test("falls back to a member's global avatar", async () => {
    const results = await lookupGuildMembers({
      guildId: "guild-1",
      queries: ["Daniel"],
      discordRequest: async () =>
        [
          {
            user: {
              id: "123456789012345678",
              username: "Daniel",
              avatar: "global-avatar",
            },
          },
        ] as never,
    });

    expect(results[0]?.avatarUrl).toBe(
      "https://cdn.discordapp.com/avatars/123456789012345678/global-avatar.png?size=4096",
    );
  });

  test("adds any resolved media reference as an emoji", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];
    const mediaRegistry = new ChatbotMediaRegistry();
    const avatar = mediaRegistry.registerUrl({
      mediaId: "avatar-1",
      filename: "Fan-avatar.png",
      contentType: "image/png",
      url: "https://cdn.discordapp.com/guilds/guild-1/users/123456789012345678/avatars/a_server-avatar.png?size=128",
    });
    const result = await addGuildExpressionForRequest({
      input: { mediaId: avatar.mediaId, name: "fan" },
      guildId: "guild-1",
      mediaRegistry,
      discordRequest: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path === "/users/@me/guilds") {
          return [
            {
              id: "guild-1",
              name: "Current",
              permissions: (1n << 43n).toString(),
            },
          ] as never;
        }
        return {
          id: "987654321098765432",
          name: "fan",
          animated: false,
        } as never;
      },
      fetchEmoji: async (url) => {
        expect(String(url)).toBe(
          "https://cdn.discordapp.com/guilds/guild-1/users/123456789012345678/avatars/a_server-avatar.png?size=128",
        );
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });

    expect(result).toMatchObject({
      kind: "emoji",
      name: "fan",
      guild: { id: "guild-1", name: "Current" },
    });
    expect(requests.at(-1)).toEqual({
      path: "/guilds/guild-1/emojis",
      body: {
        name: "fan",
        image: "data:image/png;base64,AQID",
      },
    });
  });

  test("preserves the model's punctuation and line breaks", () => {
    const answer =
      "重新查完整一點，6uc 應該是午前。\n最直接：有人說「6uc是午前」。";

    expect(formatDiscordAnswer(answer)).toBe(answer);
  });

  test("searches the guild and returns channel names and safe jump links", async () => {
    const requestedPaths: string[] = [];
    const results = await searchGuildMessages({
      guildId: "guild-1",
      requesterUserId: "owner-1",
      requesterRoleIds: ["role-1"],
      currentChannelId: "channel-1",
      requestMessageId: "request-1",
      queries: [
        {
          author: "Daniel",
          mentions: "Daniel",
          has: ["image"],
        },
      ],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path.includes("/members/search?")) {
          return [
            {
              nick: "Daniel",
              user: { id: "user-1", username: "daniel" },
            },
          ] as never;
        }
        if (path === "/guilds/guild-1/roles") {
          return [
            { id: "guild-1", permissions: "0" },
            { id: "role-1", permissions: "66560" },
          ] as never;
        }
        if (path === "/guilds/guild-1/channels") {
          return [
            { id: "channel-1", name: "memes", type: 0 },
            {
              id: "hidden-1",
              name: "staff",
              type: 0,
              permission_overwrites: [
                { id: "guild-1", type: 0, allow: "0", deny: "1024" },
              ],
            },
          ] as never;
        }

        return {
          total_results: 1,
          messages: [
            [
              {
                id: "message-1",
                channel_id: "channel-1",
                content: "",
                timestamp: "2026-07-01T12:00:00.000Z",
                author: { id: "user-1", global_name: "Daniel" },
                attachments: [
                  {
                    id: "attachment-1",
                    filename: "meme.png",
                    content_type: "image/png",
                    size: 1234,
                    url: "https://cdn.discordapp.com/meme.png",
                  },
                ],
              },
            ],
          ],
        } as never;
      },
    });

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths[3]).toContain("channel_id=channel-1");
    expect(requestedPaths[3]).not.toContain("hidden-1");
    expect(requestedPaths[3]).toContain("author_id=user-1");
    expect(requestedPaths[3]).toContain("mentions=user-1");
    expect(requestedPaths[3]).toContain("has=image");
    expect(results).toHaveLength(1);
    expect(results[0]?.channelName).toBe("memes");
    expect(results[0]?.jumpUrl).toBe(
      "https://discord.com/channels/guild-1/channel-1/message-1",
    );
  });

  test("uses the requester directly for Chinese self-reference", async () => {
    const requestedPaths: string[] = [];
    let searchRequestCount = 0;

    const results = await searchGuildMessages({
      guildId: "guild-1",
      requesterUserId: "owner-1",
      requesterRoleIds: ["role-1"],
      currentChannelId: "channel-2",
      requestMessageId: "request-1",
      queries: [
        { author: "self", content: "新 app" },
        { author: "self", content: "app", has: ["link"] },
      ],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path === "/guilds/guild-1/roles") {
          return [
            { id: "guild-1", permissions: "0" },
            { id: "role-1", permissions: "66560" },
          ] as never;
        }
        if (path === "/guilds/guild-1/channels") {
          return [{ id: "channel-2", name: "projects", type: 0 }] as never;
        }

        searchRequestCount += 1;
        const id = searchRequestCount === 1 ? "request-1" : "target-1";
        return {
          total_results: 1,
          messages: [
            [
              {
                id,
                channel_id: "channel-2",
                content: searchRequestCount === 1 ? "新 app" : "app launch",
                timestamp: "2026-07-01T12:00:00.000Z",
                author: { id: "owner-1", username: "Hsi" },
              },
            ],
          ],
        } as never;
      },
    });

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths[2]).not.toContain("/members/search");
    expect(requestedPaths[2]).toContain("author_id=owner-1");
    expect(requestedPaths[2]).toContain("content=%E6%96%B0+app");
    expect(requestedPaths[3]).toContain("content=app");
    expect(requestedPaths[3]).toContain("has=link");
    expect(results.map((result) => result.id)).toEqual(["target-1"]);
    expect(results[0]?.channelName).toBe("projects");
  });

  test("preserves attachments and an older referenced human message", () => {
    expect(
      toChatbotMessage({
        id: "message-2",
        channel_id: "channel-1",
        content: "see this",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "user-1", global_name: "Hsi" },
        attachments: [
          {
            id: "attachment-1",
            filename: "notes.pdf",
            content_type: "application/pdf",
            size: 1234,
            url: "https://cdn.discordapp.com/notes.pdf",
          },
        ],
        reactions: [
          {
            count: 3,
            emoji: { id: null, name: "😂" },
          },
          {
            count: 2,
            me: true,
            emoji: { id: "emoji-1", name: "sago", animated: true },
          },
        ],
        referenced_message: {
          id: "message-1",
          channel_id: "channel-1",
          content: "older context",
          timestamp: "2026-07-18T11:00:00.000Z",
          author: { id: "user-2", username: "Daniel" },
        },
      }),
    ).toEqual({
      id: "message-2",
      channelId: "channel-1",
      role: "user",
      author: "Hsi",
      timestamp: "2026-07-20T11:00:00.000Z",
      content: "see this",
      attachments: [
        {
          id: "attachment-1",
          filename: "notes.pdf",
          contentType: "application/pdf",
          size: 1234,
          url: "https://cdn.discordapp.com/notes.pdf",
        },
      ],
      reactions: [
        { emoji: "😂", count: 3 },
        { emoji: "<a:sago:emoji-1>", count: 2, me: true },
      ],
      referencedMessage: {
        id: "message-1",
        channelId: "channel-1",
        role: "user",
        author: "Daniel",
        timestamp: "2026-07-18T11:00:00.000Z",
        content: "older context",
        attachments: [],
      },
    });
  });

  test("applies role and member channel overwrites before guild search", () => {
    const roles = [
      { id: "guild-1", permissions: "66560" },
      { id: "role-1", permissions: "0" },
    ];
    const channel = {
      id: "private-1",
      type: 0,
      permission_overwrites: [
        { id: "guild-1", type: 0, allow: "0", deny: "1024" },
        { id: "owner-1", type: 1, allow: "1024", deny: "0" },
      ],
    };

    expect(
      canMemberSearchChannel({
        guildId: "guild-1",
        userId: "owner-1",
        roleIds: ["role-1"],
        roles,
        channel,
      }),
    ).toBe(true);
    expect(
      canMemberSearchChannel({
        guildId: "guild-1",
        userId: "other-1",
        roleIds: ["role-1"],
        roles,
        channel,
      }),
    ).toBe(false);
  });

  test("shortens answers to one Discord message", () => {
    expect(formatDiscordAnswer(" short answer ")).toBe("short answer");
    expect(formatDiscordAnswer("   ")).toBe("我剛剛腦袋一片空白 再問我一次");
    const longAnswer = "a".repeat(2_100);
    expect(formatDiscordAnswer(longAnswer)).toHaveLength(2_000);
    expect(formatDiscordAnswer(longAnswer).endsWith("…")).toBe(true);
  });
});
