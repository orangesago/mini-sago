import { describe, expect, test } from "bun:test";

import { ChatbotMediaRegistry } from "./media-assets";
import {
  toChatbotMessage,
  type DiscordMessage,
  type DiscordRequest,
} from "./chatbot-context";
import { handleChatbotMediaRequest, registerChatbotMcpSession } from "./mcp";

function handlers() {
  return {
    getPreviousTrace: async () => ({ status: "not_found" as const }),
    resolveContext: async () => ({
      history: { status: "complete" as const, messages: [] },
      search: { status: "not_requested" as const, results: [] },
      members: { status: "not_requested" as const, results: [] },
      previousTrace: { status: "not_requested" as const },
    }),
  };
}

const originalUrl =
  "https://cdn.discordapp.com/attachments/100/300/image.png?ex=old&hm=old";
const refreshedUrl =
  "https://cdn.discordapp.com/attachments/100/300/image.png?ex=new&hm=new";
function sourceMessage(url = originalUrl): DiscordMessage {
  return {
    id: "200",
    channel_id: "100",
    content: "original image",
    timestamp: "2026-10-02T00:00:00Z",
    author: { id: "user", username: "User" },
    attachments: [
      {
        id: "300",
        filename: "image.png",
        size: 3,
        content_type: "image/png",
        url,
      },
    ],
  };
}

describe("request-scoped media registry", () => {
  test.each([403, 404, 410])(
    "refreshes an attachment's source message after CDN status %i",
    async (status) => {
      const fetched: string[] = [];
      const requests: string[] = [];
      const registry = new ChatbotMediaRegistry(
        async (input) => {
          fetched.push(String(input));
          return String(input) === originalUrl
            ? new Response("expired", { status })
            : new Response(new Uint8Array([1, 2, 3]));
        },
        (async (path) => {
          requests.push(path);
          return sourceMessage(refreshedUrl);
        }) as DiscordRequest,
      );
      registry.registerMessages([toChatbotMessage(sourceMessage())]);

      expect([...(await registry.read("300")).bytes]).toEqual([1, 2, 3]);
      expect(requests).toEqual(["/channels/100/messages/200"]);
      expect(fetched).toEqual([originalUrl, refreshedUrl]);
      expect(registry.get("300")).not.toHaveProperty("url");
      await registry.read("300");
      expect(fetched.at(-1)).toBe(refreshedUrl);
      expect(requests).toHaveLength(1);
    },
  );

  test("refreshes reply attachments using their own source channel and message", async () => {
    const requests: string[] = [];
    const registry = new ChatbotMediaRegistry(
      async (input) =>
        String(input) === originalUrl
          ? new Response(null, { status: 403 })
          : new Response(new Uint8Array([1])),
      (async (path) => {
        requests.push(path);
        return sourceMessage(refreshedUrl);
      }) as DiscordRequest,
    );
    registry.registerMessages([
      toChatbotMessage({
        ...sourceMessage(),
        id: "other-message",
        channel_id: "other-channel",
        attachments: [],
        referenced_message: sourceMessage(),
      }),
    ]);
    await registry.read("300");
    expect(requests).toEqual(["/channels/100/messages/200"]);
  });

  test("does not substitute another attachment when the original was deleted", async () => {
    let downloads = 0;
    const registry = new ChatbotMediaRegistry(
      async () => {
        downloads++;
        return new Response(null, { status: 403 });
      },
      (async () => ({
        ...sourceMessage(refreshedUrl),
        attachments: [
          {
            ...sourceMessage(refreshedUrl).attachments![0]!,
            id: "another-attachment",
          },
        ],
      })) as DiscordRequest,
    );
    registry.registerMessages([toChatbotMessage(sourceMessage())]);
    await expect(registry.read("300")).rejects.toThrow("unavailable");
    expect(downloads).toBe(1);
  });

  test("keeps retries bounded when the refreshed link also fails", async () => {
    let downloads = 0;
    let refreshes = 0;
    const registry = new ChatbotMediaRegistry(
      async () => {
        downloads++;
        return new Response(null, { status: 403 });
      },
      (async () => {
        refreshes++;
        return sourceMessage(refreshedUrl);
      }) as DiscordRequest,
    );
    registry.registerMessages([toChatbotMessage(sourceMessage())]);
    await expect(registry.read("300")).rejects.toThrow("could not download");
    expect(downloads).toBe(2);
    expect(refreshes).toBe(1);
  });

  test.each([
    "https://example.com/image.png",
    "http://cdn.discordapp.com/image.png",
  ])("rejects a refreshed URL outside the Discord CDN: %s", async (url) => {
    let downloads = 0;
    const registry = new ChatbotMediaRegistry(
      async () => {
        downloads++;
        return new Response(null, { status: 403 });
      },
      (async () => sourceMessage(url)) as DiscordRequest,
    );
    registry.registerMessages([toChatbotMessage(sourceMessage())]);
    await expect(registry.read("300")).rejects.toThrow("allowed Discord CDN");
    expect(downloads).toBe(1);
  });

  test("retains the input size limit on refreshed downloads", async () => {
    const registry = new ChatbotMediaRegistry(
      async (input) =>
        String(input) === originalUrl
          ? new Response(null, { status: 403 })
          : new Response(null, {
              headers: { "content-length": String(20 * 1024 * 1024 + 1) },
            }),
      (async () => sourceMessage(refreshedUrl)) as DiscordRequest,
    );
    registry.registerMessages([toChatbotMessage(sourceMessage())]);
    await expect(registry.read("300")).rejects.toThrow("size limit");
  });

  test("does not refresh unknown media, avatars, or a source the bot can no longer read", async () => {
    const requests: string[] = [];
    const registry = new ChatbotMediaRegistry(
      async () => new Response(null, { status: 403 }),
      (async (path) => {
        requests.push(path);
        throw new Error("Discord denied access");
      }) as DiscordRequest,
    );
    registry.registerUrl({
      mediaId: "avatar",
      filename: "avatar.png",
      url: "https://cdn.discordapp.com/avatars/user/avatar.png",
    });
    await expect(registry.read("missing")).rejects.toThrow("unavailable");
    await expect(registry.read("avatar")).rejects.toThrow("could not download");
    expect(requests).toHaveLength(0);
    registry.registerMessages([toChatbotMessage(sourceMessage())]);
    await expect(registry.read("300")).rejects.toThrow("denied access");
    expect(requests).toEqual(["/channels/100/messages/200"]);
  });

  test("serves source media and accepts generated media with the same token", async () => {
    const registry = new ChatbotMediaRegistry(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        }),
    );
    registry.registerUrl({
      mediaId: "avatar-1",
      filename: "avatar.png",
      contentType: "image/png",
      url: "https://cdn.discordapp.com/avatars/user/avatar.png",
    });
    const session = registerChatbotMcpSession(
      { ...handlers(), mediaRegistry: registry },
      { ttlMs: 1_000 },
    );
    const authorization = { authorization: `Bearer ${session.token}` };

    try {
      const source = await handleChatbotMediaRequest(
        new Request("https://sago.test/api/chatbot/media/avatar-1", {
          headers: authorization,
        }),
      );
      expect([...new Uint8Array(await source.arrayBuffer())]).toEqual([
        1, 2, 3,
      ]);

      const upload = await handleChatbotMediaRequest(
        new Request("https://sago.test/api/chatbot/media/media-result.webp", {
          method: "POST",
          headers: {
            ...authorization,
            "content-type": "image/webp",
            "x-minisago-filename": "result.webp",
          },
          body: new Uint8Array([4, 5, 6]),
        }),
      );
      expect(upload.status).toBe(201);
      expect(registry.get("media-result.webp")).toEqual({
        mediaId: "media-result.webp",
        filename: "result.webp",
        contentType: "image/webp",
        size: 3,
      });
    } finally {
      session.revoke();
    }
  });

  test("rejects arbitrary URLs and unknown media IDs", async () => {
    const registry = new ChatbotMediaRegistry();
    expect(() =>
      registry.registerUrl({
        mediaId: "bad",
        filename: "bad.png",
        url: "https://example.com/bad.png",
      }),
    ).toThrow("allowed Discord CDN");
    await expect(registry.read("missing")).rejects.toThrow("unavailable");
  });
});
