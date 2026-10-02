import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChatbotMediaRegistry } from "../../../src/chatbot/media-assets";
import {
  handleChatbotMediaRequest,
  registerChatbotMcpSession,
} from "../../../src/chatbot/mcp";
import type { DiscordRequest } from "../../../src/discord/api/request";

const temporaryDirectories: string[] = [];
const clients: Client[] = [];

async function connectMedia(
  options: { developer?: boolean; mcpUrl?: string; token?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "minisago-media-mcp-"));
  temporaryDirectories.push(root);
  const outputs = join(root, "outputs");
  await mkdir(outputs);
  const manifestPath = join(root, "media-manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      root,
      outputDirectory: outputs,
      attachments: [],
    }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./media-mcp.ts", import.meta.url).pathname],
    env: {
      ...getDefaultEnvironment(),
      MINISAGO_MEDIA_MANIFEST: manifestPath,
      MINISAGO_SANDBOX_URL: "http://sandbox:8080",
      MINISAGO_MCP_URL:
        options.mcpUrl ?? "http://localhost:3000/api/chatbot/mcp",
      MINISAGO_MCP_TOKEN: options.token ?? "request-token",
      MINISAGO_MEDIA_DEVELOPER: options.developer ? "1" : "0",
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "minisago-media-test", version: "1.0.0" },
    { capabilities: {} },
  );
  clients.push(client);
  await client.connect(transport);
  return { client, root };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("MiniSago media MCP", () => {
  test("starts over stdio with only the curated request-local tools", async () => {
    const { client } = await connectMedia();

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "inspect_media",
      "transform_image",
      "extract_video_frame",
      "transcode_media",
      "run_python",
    ]);
    expect(
      tools.tools.find((tool) => tool.name === "transcode_media")?.inputSchema,
    ).not.toHaveProperty("args");
    expect(
      tools.tools.find((tool) => tool.name === "run_python")?.inputSchema,
    ).not.toHaveProperty("command");
  });

  test("downloads a late coding attachment through scoped host access and refreshes an expired link", async () => {
    const fetched: string[] = [];
    const requests: string[] = [];
    const oldUrl =
      "https://cdn.discordapp.com/attachments/100/300/image.png?hm=old";
    const newUrl =
      "https://cdn.discordapp.com/attachments/100/300/image.png?hm=new";
    const registry = new ChatbotMediaRegistry(
      async (url) => {
        fetched.push(String(url));
        return String(url) === oldUrl
          ? new Response(null, { status: 403 })
          : new Response("original image bytes");
      },
      (async (path) => {
        requests.push(path);
        return {
          id: "200",
          channel_id: "100",
          attachments: [{ id: "300", url: newUrl }],
        };
      }) as DiscordRequest,
    );
    const session = registerChatbotMcpSession({
      mediaRegistry: registry,
      resolveContext: async () => ({
        history: { status: "complete" as const, messages: [] },
        search: { status: "not_requested" as const, results: [] },
        members: { status: "not_requested" as const, results: [] },
        previousTrace: { status: "not_requested" as const },
      }),
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: handleChatbotMediaRequest,
    });
    try {
      const { client, root } = await connectMedia({
        developer: true,
        mcpUrl: `${server.url}api/chatbot/mcp`,
        token: session.token,
      });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "download_attachment",
      );
      registry.registerMessages([
        {
          id: "200",
          channelId: "100",
          author: "Participant",
          timestamp: "2026-10-02T00:00:00Z",
          content: "Here is the original",
          attachments: [
            {
              id: "300",
              filename: "image.png",
              contentType: "image/png",
              size: 20,
              url: oldUrl,
            },
          ],
        },
      ]);
      const result = await client.callTool({
        name: "download_attachment",
        arguments: { mediaId: "300" },
      });
      expect(result.structuredContent).toMatchObject({
        status: "complete",
        mediaId: "300",
        filename: "image.png",
        contentType: "image/png",
        size: 20,
      });
      const path = (result.structuredContent as { path: string }).path;
      expect(path).toStartWith(`${await realpath(root)}/`);
      expect(await Bun.file(path).text()).toBe("original image bytes");
      expect(requests).toEqual(["/channels/100/messages/200"]);
      expect(fetched).toEqual([oldUrl, newUrl]);
      expect(JSON.stringify(result)).not.toContain("discordapp.com");
      expect(JSON.stringify(result)).not.toContain(session.token);
      const unknown = await client.callTool({
        name: "download_attachment",
        arguments: { mediaId: "unregistered" },
      });
      expect(unknown.structuredContent).toMatchObject({ status: "invalid" });
      expect(fetched).toHaveLength(2);
      await client.callTool({
        name: "download_attachment",
        arguments: { mediaId: "300" },
      });
      expect(fetched).toHaveLength(2);
    } finally {
      session.revoke();
      server.stop(true);
    }
  });
});
