import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CHATBOT_PROTOCOL_VERSION } from "../../contracts/worker-contract";
import { macAgentBridge, type MacAgentSocketData } from "./bridge";
import { handleChatbotMention, type DiscordRequest } from "./chatbot";
import { GuildMemoryStore } from "./guild-memory";
import { handleChatbotMcpRequest } from "./mcp";

for (const scenario of [
  "worker-failure",
  "invalid-reply",
  "failed-save",
] as const) {
  test(`first memory save reports its committed outcome after ${scenario}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "minisago-memory-chat-"));
    const memory = new GuildMemoryStore(directory);
    const oldWorkerSecret = process.env.MINISAGO_WORKER_BRIDGE_SECRET;
    const oldMacSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET;
    const secret = "memory-conversation-test-secret-at-least-32-bytes";
    process.env.MINISAGO_WORKER_BRIDGE_SECRET = secret;
    delete process.env.MINISAGO_MAC_BRIDGE_SECRET;
    const sent: string[] = [];
    const socket = {
      data: { authenticated: false },
      send: (value: string) => sent.push(value),
      close: () => undefined,
    } as unknown as ServerWebSocket<MacAgentSocketData>;
    const server = Bun.serve({ port: 0, fetch: handleChatbotMcpRequest });
    const client = new Client({ name: "memory-chat-test", version: "1.0.0" });
    const replies: string[] = [];
    const guildId = "1282936453134815275";
    const messageId = "1555300893098774741";
    const requesterId = "981919551312785490";
    let handled: Promise<boolean> | undefined;
    try {
      macAgentBridge.open(socket);
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "authenticate",
          protocolVersion: CHATBOT_PROTOCOL_VERSION,
          secret,
          workerId: "oracle",
          capabilities: ["chat"],
          repositories: [],
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
      handled = handleChatbotMention({
        message: {
          id: messageId,
          channel_id: "1520034281139994654",
          guild_id: guildId,
          content: "<@123456789012345678> 這裡的泡泡是讀書會的別名 幫我記住",
          timestamp: "2026-10-04T08:00:00.000Z",
          author: { id: requesterId, username: "Member" },
          mentions: [{ id: "123456789012345678" }],
        },
        botUserId: "123456789012345678",
        accessConfig: {
          ownerUserId: "917446775873343600",
          guildIds: new Set([guildId]),
          channelIds: new Set(),
          roleIds: new Set(),
        },
        guildMemoryStore: memory,
        executionOptions: { lazyPreviousTrace: true },
        discordRequest: (async (_path, options) => {
          if (options?.method === "POST") {
            const body = options.body as { content?: string } | undefined;
            if (body?.content) replies.push(body.content);
            return { id: "response" };
          }
          return [];
        }) as DiscordRequest,
      });
      let job;
      for (let attempt = 0; attempt < 1000; attempt++) {
        job = sent
          .map((value) => JSON.parse(value))
          .find(
            (value) => value.type === "job" && value.job.purpose === "answer",
          )?.job;
        if (job) break;
        await Bun.sleep(1);
      }
      if (!job) throw new Error("Answer job was not dispatched.");
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost:${server.port}/api/chatbot/mcp`),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${job.mcpAccessToken}` },
            },
          },
        ),
      );
      const result = await client.callTool({
        name: "manage_server_memory",
        arguments: {
          action: "add",
          content:
            scenario === "failed-save"
              ? "invalid\u200bcontent"
              : "泡泡是讀書會的別名",
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: scenario === "failed-save" ? "invalid" : "complete",
      });
      macAgentBridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: job.id,
          ...(scenario === "invalid-reply"
            ? {
                ok: true,
                content: '{"reply":"MiniSago saved that.","reaction":null}',
              }
            : {
                ok: false,
                error: "Codex identity repair did not use first person.",
                failureKind: "internal",
              }),
        }),
      );
      expect(await handled).toBe(true);
      const snapshot = await memory.load(guildId);
      if (scenario === "failed-save") {
        expect(snapshot.entries).toEqual([]);
        expect(replies).toEqual(["我這次沒完成 稍後再試一次"]);
      } else {
        expect(snapshot.entries).toMatchObject([
          {
            content: "泡泡是讀書會的別名",
            updatedBy: requesterId,
            evidenceMessageIds: [messageId],
          },
        ]);
        expect(replies).toEqual(["我已記住這個伺服器的資訊了"]);
      }
    } finally {
      macAgentBridge.close(socket);
      await handled?.catch(() => undefined);
      await client.close();
      server.stop(true);
      if (oldWorkerSecret === undefined)
        delete process.env.MINISAGO_WORKER_BRIDGE_SECRET;
      else process.env.MINISAGO_WORKER_BRIDGE_SECRET = oldWorkerSecret;
      if (oldMacSecret === undefined)
        delete process.env.MINISAGO_MAC_BRIDGE_SECRET;
      else process.env.MINISAGO_MAC_BRIDGE_SECRET = oldMacSecret;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
