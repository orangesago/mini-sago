import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildReviewRequest,
  formatThreadName,
  handleGithubWebhookRequest,
  verifyGithubWebhookSignature,
} from "./github-pr-webhook";

const HSI_ID = "917446775873343600";
const DANIEL_ID = "927940363644194847";
const JASMINE_ID = "881904247879368715";

function sign(body: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhookRequest(
  payload: unknown,
  secret: string,
  event = "pull_request",
) {
  const body = JSON.stringify(payload);

  return new Request("https://minisago.example/api/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": sign(body, secret),
    },
    body,
  });
}

function pullRequestPayload(action: string, merged = false, number = 42) {
  return {
    action,
    repository: { full_name: "sago-cream/health-check-system" },
    pull_request: {
      number,
      title: "Make health checks clearer",
      html_url: `https://github.com/sago-cream/health-check-system/pull/${number}`,
      draft: false,
      merged,
      user: { login: "sago-cream" },
      merged_by: merged ? { login: "Danielllllllllllllll" } : null,
    },
  };
}

function approvedReviewPayload() {
  return {
    ...pullRequestPayload("submitted"),
    review: { state: "approved" },
  };
}

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe("GitHub PR webhook", () => {
  test("validates GitHub's HMAC-SHA256 signature", () => {
    const body = '{"zen":"Keep it logically awesome."}';
    const secret = "test-secret";

    expect(verifyGithubWebhookSignature(body, sign(body, secret), secret)).toBe(
      true,
    );
    expect(
      verifyGithubWebhookSignature(body, "sha256=not-the-signature", secret),
    ).toBe(false);
    expect(verifyGithubWebhookSignature(body, null, secret)).toBe(false);
  });

  test("queues an Oracle skill refresh for Skillbook main pushes", async () => {
    const secret = "test-secret";
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    process.env.DISCORD_BOT_TOKEN = "test-token";
    let refreshes = 0;
    try {
      const response = await handleGithubWebhookRequest(
        webhookRequest(
          {
            ref: "refs/heads/main",
            repository: { full_name: "sago-cream/skills" },
          },
          secret,
          "push",
        ),
        () => {
          refreshes += 1;
          return true;
        },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, result: "queued" });
      expect(refreshes).toBe(1);
    } finally {
      restoreEnvironmentVariable("GITHUB_WEBHOOK_SECRET", originalSecret);
      restoreEnvironmentVariable("DISCORD_BOT_TOKEN", originalToken);
    }
  });

  test("mentions Daniel and Jasmine for Hsi's PR", () => {
    expect(
      buildReviewRequest({
        authorLogin: "sago-cream",
        title: "Improve checks",
        url: "https://github.com/sago-cream/health-check-system/pull/1",
      }),
    ).toEqual({
      authorDiscordId: HSI_ID,
      reviewerDiscordIds: [DANIEL_ID, JASMINE_ID],
      message: {
        content: `<@${DANIEL_ID}> <@${JASMINE_ID}> please review [Improve checks](<https://github.com/sago-cream/health-check-system/pull/1>)`,
        allowed_mentions: {
          parse: [],
          users: [DANIEL_ID, JASMINE_ID],
        },
      },
    });
  });

  test("mentions Hsi for Daniel's and Jasmine's PRs", () => {
    for (const [authorLogin, authorDiscordId] of [
      ["Danielllllllllllllll", DANIEL_ID],
      ["Jasmine0108", JASMINE_ID],
    ]) {
      const request = buildReviewRequest({
        authorLogin,
        title: "Improve checks",
        url: "https://github.com/sago-cream/health-check-system/pull/2",
      });

      expect(request.authorDiscordId).toBe(authorDiscordId);
      expect(request.reviewerDiscordIds).toEqual([HSI_ID]);
    }
  });

  test("keeps public thread names within Discord's 100-character limit", () => {
    expect(formatThreadName(42, `  ${"a".repeat(120)}  `)).toHaveLength(100);
    expect(formatThreadName(42, "Make health checks clearer")).toBe(
      "#42 Make health checks clearer",
    );
    expect(formatThreadName(42, "   ")).toBe("#42 Pull request");
  });

  test.serial(
    "creates review threads, sends lifecycle notifications, and archives them whenever the PR closes",
    async () => {
      const secret = "integration-test-secret";
      const stateDirectory = await mkdtemp(join(tmpdir(), "minisago-pr-test-"));
      const stateFile = join(stateDirectory, "state.json");
      const originalFetch = globalThis.fetch;
      const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
      const originalToken = process.env.DISCORD_BOT_TOKEN;
      const originalStateFile = process.env.GITHUB_PR_THREAD_STATE_FILE;
      const originalChannelId = process.env.GITHUB_PR_THREAD_CHANNEL_ID;
      const calls: Array<{ url: string; method: string; body?: unknown }> = [];

      process.env.GITHUB_WEBHOOK_SECRET = secret;
      process.env.DISCORD_BOT_TOKEN = "test-bot-token";
      process.env.GITHUB_PR_THREAD_STATE_FILE = stateFile;
      process.env.GITHUB_PR_THREAD_CHANNEL_ID = "1521506395034226830";

      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body:
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });

        if (url.endsWith("/channels/1521506395034226830/threads")) {
          return Response.json({ id: "thread-42" });
        }

        if (url.endsWith("/channels/thread-42/messages")) {
          return Response.json({ id: "message-42" });
        }

        if (url.endsWith("/channels/thread-42")) {
          return Response.json({ guild_id: "pr-guild-id" });
        }

        if (url.endsWith("/guilds/pr-guild-id/emojis")) {
          return Response.json([
            {
              id: "approved-emoji-id",
              name: "approved",
              available: true,
            },
          ]);
        }

        return new Response(null, { status: 204 });
      }) as typeof fetch;

      try {
        const readyResponse = await handleGithubWebhookRequest(
          webhookRequest(pullRequestPayload("ready_for_review"), secret),
        );
        expect(readyResponse.status).toBe(200);
        expect(await readyResponse.json()).toEqual({
          ok: true,
          result: "created",
        });

        const duplicateResponse = await handleGithubWebhookRequest(
          webhookRequest(pullRequestPayload("ready_for_review"), secret),
        );
        expect(await duplicateResponse.json()).toEqual({
          ok: true,
          result: "already-created",
        });

        const approvedResponse = await handleGithubWebhookRequest(
          webhookRequest(
            approvedReviewPayload(),
            secret,
            "pull_request_review",
          ),
        );
        expect(await approvedResponse.json()).toEqual({
          ok: true,
          result: "notified",
        });

        const duplicateApprovalResponse = await handleGithubWebhookRequest(
          webhookRequest(
            approvedReviewPayload(),
            secret,
            "pull_request_review",
          ),
        );
        expect(await duplicateApprovalResponse.json()).toEqual({
          ok: true,
          result: "already-notified",
        });

        const mergedResponse = await handleGithubWebhookRequest(
          webhookRequest(pullRequestPayload("closed", true), secret),
        );
        expect(await mergedResponse.json()).toEqual({
          ok: true,
          result: "archived",
        });

        expect(calls).toEqual([
          {
            url: "https://discord.com/api/v10/channels/1521506395034226830/threads",
            method: "POST",
            body: {
              name: "#42 Make health checks clearer",
              auto_archive_duration: 1440,
              type: 11,
            },
          },
          ...[DANIEL_ID, JASMINE_ID, HSI_ID].map((userId) => ({
            url: `https://discord.com/api/v10/channels/thread-42/thread-members/${userId}`,
            method: "PUT",
            body: undefined,
          })),
          {
            url: "https://discord.com/api/v10/channels/thread-42/messages",
            method: "POST",
            body: {
              content: `<@${DANIEL_ID}> <@${JASMINE_ID}> please review [Make health checks clearer](<https://github.com/sago-cream/health-check-system/pull/42>)`,
              allowed_mentions: {
                parse: [],
                users: [DANIEL_ID, JASMINE_ID],
              },
            },
          },
          {
            url: "https://discord.com/api/v10/channels/thread-42/pins/message-42",
            method: "PUT",
            body: undefined,
          },
          {
            url: "https://discord.com/api/v10/channels/thread-42",
            method: "GET",
            body: undefined,
          },
          {
            url: "https://discord.com/api/v10/guilds/pr-guild-id/emojis",
            method: "GET",
            body: undefined,
          },
          {
            url: "https://discord.com/api/v10/channels/thread-42/messages",
            method: "POST",
            body: {
              content: `<@${HSI_ID}> <:approved:approved-emoji-id>`,
              allowed_mentions: {
                parse: [],
                users: [HSI_ID],
              },
            },
          },
          {
            url: "https://discord.com/api/v10/channels/thread-42/messages",
            method: "POST",
            body: {
              content: `Merged by <@${DANIEL_ID}>, closing.`,
              allowed_mentions: {
                parse: [],
                users: [DANIEL_ID],
              },
            },
          },
          {
            url: "https://discord.com/api/v10/channels/thread-42",
            method: "PATCH",
            body: { archived: true },
          },
        ]);

        const state = JSON.parse(await readFile(stateFile, "utf8"));
        expect(
          state.threads["sago-cream/health-check-system#42"].archived,
        ).toBe(true);
        expect(
          state.threads["sago-cream/health-check-system#42"]
            .approvalNotificationSent,
        ).toBe(true);
        expect(
          state.threads["sago-cream/health-check-system#42"]
            .mergeNotificationSent,
        ).toBe(true);

        calls.length = 0;

        const secondReadyResponse = await handleGithubWebhookRequest(
          webhookRequest(
            pullRequestPayload("ready_for_review", false, 43),
            secret,
          ),
        );
        expect(await secondReadyResponse.json()).toEqual({
          ok: true,
          result: "created",
        });

        const closedWithoutMergeResponse = await handleGithubWebhookRequest(
          webhookRequest(pullRequestPayload("closed", false, 43), secret),
        );
        expect(await closedWithoutMergeResponse.json()).toEqual({
          ok: true,
          result: "archived",
        });
        expect(calls.at(-1)).toEqual({
          url: "https://discord.com/api/v10/channels/thread-42",
          method: "PATCH",
          body: { archived: true },
        });
        expect(
          calls.some(
            (call) =>
              call.method === "POST" &&
              typeof call.body === "object" &&
              call.body !== null &&
              "content" in call.body &&
              String(call.body.content).startsWith("Merged by "),
          ),
        ).toBe(false);

        const closedState = JSON.parse(await readFile(stateFile, "utf8"));
        expect(
          closedState.threads["sago-cream/health-check-system#43"].archived,
        ).toBe(true);
        expect(
          closedState.threads["sago-cream/health-check-system#43"]
            .mergeNotificationSent,
        ).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
        restoreEnvironmentVariable("GITHUB_WEBHOOK_SECRET", originalSecret);
        restoreEnvironmentVariable("DISCORD_BOT_TOKEN", originalToken);
        restoreEnvironmentVariable(
          "GITHUB_PR_THREAD_STATE_FILE",
          originalStateFile,
        );
        restoreEnvironmentVariable(
          "GITHUB_PR_THREAD_CHANNEL_ID",
          originalChannelId,
        );
        await rm(stateDirectory, { recursive: true });
      }
    },
  );
});
