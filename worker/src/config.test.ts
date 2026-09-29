import { describe, expect, test } from "bun:test";

import {
  configuredSkillbookRepository,
  deploySocketPath,
  macFileRoots,
  parseGitHubRepositories,
  validateBridgeUrl,
  validateMcpUrl,
  workspaceChild,
} from "./config";

describe("worker configuration", () => {
  test("syncs Skillbook on Oracle without managing Mac skills", () => {
    expect(configuredSkillbookRepository(true, undefined)).toBe(
      "sago-cream/skills",
    );
    expect(configuredSkillbookRepository(false, undefined)).toBeUndefined();
    expect(configuredSkillbookRepository(false, "owner/skillbook")).toBe(
      "owner/skillbook",
    );
  });

  test("accepts only an absolute deployment socket path", () => {
    expect(deploySocketPath("/run/sago-cloud/deploy.sock")).toBe(
      "/run/sago-cloud/deploy.sock",
    );
    expect(deploySocketPath(" ")).toBeUndefined();
    expect(() => deploySocketPath("deploy.sock")).toThrow("absolute path");
  });

  test("discovers every valid repository visible to the worker account", () => {
    expect(
      parseGitHubRepositories(
        "Hsiii/mini-sago\nsago-cream/mini-sago\ninvalid\nHsiii/mini-sago\n",
      ),
    ).toEqual(["Hsiii/mini-sago", "sago-cream/mini-sago"]);
  });

  test("limits default Mac file access to common user folders", () => {
    expect(macFileRoots(undefined, "/Users/hsi")).toContain(
      "/Users/hsi/Documents",
    );
    expect(macFileRoots(undefined, "/Users/hsi")).not.toContain("/Users/hsi");
    expect(
      macFileRoots("/Volumes/Work:/Users/hsi/Desktop", "/Users/hsi"),
    ).toEqual(["/Volumes/Work", "/Users/hsi/Desktop"]);
  });

  test("allows plaintext bridge traffic only for local hostnames", () => {
    expect(validateBridgeUrl("ws://bot-core:3000/api/mac-agent/ws")).toBe(
      "ws://bot-core:3000/api/mac-agent/ws",
    );
    expect(validateBridgeUrl("ws://[::1]:3000/api/mac-agent/ws")).toBe(
      "ws://[::1]:3000/api/mac-agent/ws",
    );
    expect(validateBridgeUrl("wss://bot.example.com/api/mac-agent/ws")).toBe(
      "wss://bot.example.com/api/mac-agent/ws",
    );
    expect(() =>
      validateBridgeUrl("ws://bot.example.com/api/mac-agent/ws"),
    ).toThrow("must use wss://");
    expect(() =>
      validateBridgeUrl("ws://[2001:db8::1]/api/mac-agent/ws"),
    ).toThrow("must use wss://");
    expect(() =>
      validateBridgeUrl("ws://[2606:4700:4700::1111]/api/mac-agent/ws"),
    ).toThrow("must use wss://");
  });

  test("allows plaintext MCP traffic only for local hostnames", () => {
    expect(validateMcpUrl("http://bot-core:3000/api/chatbot/mcp")).toBe(
      "http://bot-core:3000/api/chatbot/mcp",
    );
    expect(validateMcpUrl("https://bot.example.com/api/chatbot/mcp")).toBe(
      "https://bot.example.com/api/chatbot/mcp",
    );
    expect(() =>
      validateMcpUrl("http://bot.example.com/api/chatbot/mcp"),
    ).toThrow("must use https://");
  });

  test("keeps GitHub worktree roots inside the dev workspace", () => {
    expect(
      workspaceChild(
        "/workspace",
        "/workspace/worktrees",
        "MINISAGO_GITHUB_WORKTREE_ROOT",
      ),
    ).toBe("/workspace/worktrees");
    expect(() =>
      workspaceChild(
        "/workspace",
        "/private/worktrees",
        "MINISAGO_GITHUB_WORKTREE_ROOT",
      ),
    ).toThrow("must be a directory inside MINISAGO_WORKSPACE_ROOT");
    expect(() =>
      workspaceChild(
        "/workspace",
        "/workspace",
        "MINISAGO_GITHUB_WORKTREE_ROOT",
      ),
    ).toThrow("must be a directory inside MINISAGO_WORKSPACE_ROOT");
  });
});
