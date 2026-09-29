import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../../contracts/worker-contract";
import { failureKindForCause, formatJobFailure } from "./client";

const job: ChatbotJob = {
  id: "job-123",
  requesterUserId: "owner",
  purpose: "answer",
  executionRoute: "oracle",
  repository: "sago-cream/mini-sago",
  mcpAccessToken: "test-token",
  channelId: "thread-1",
  requestMessageId: "message-1",
  request: "fix it",
  messages: [],
  developerTask: { id: "task-456" },
};

describe("worker failure reporting", () => {
  test("reports enough context to diagnose and retry a coding failure", () => {
    expect(formatJobFailure(job, "testing", "Network timeout")).toBe(
      "Phase: testing\nCause: Network timeout\nRepository: sago-cream/mini-sago\nBranch: chore/minisago-task-456\nRetry: safe\nLogs: worker job job-123",
    );
  });

  test("classifies failures without exposing their details to Discord", () => {
    expect(failureKindForCause("Codex worker is busy.")).toBe("unavailable");
    expect(failureKindForCause("Codex request timed out.")).toBe("timeout");
    expect(failureKindForCause("Malformed output")).toBe("internal");
    expect(failureKindForCause("Network timeout", true)).toBe("internal");
  });
});

test("serves lazy trace reads even when all generation slots are occupied", async () => {
  const { MacAgentClient } = await import("./client");
  const replies: unknown[] = [];
  const currentJobs = new Map([["active-answer", new AbortController()]]);
  const receiver = {
    config: { maxConcurrentJobs: 1 },
    currentJobs,
    traceStore: { previousTrace: () => undefined },
    send: (message: unknown) => replies.push(message),
  };
  const handle = (
    MacAgentClient.prototype as unknown as {
      handleJob: (this: typeof receiver, job: ChatbotJob) => Promise<void>;
    }
  ).handleJob;
  await handle.call(receiver, {
    id: "lazy-read",
    purpose: "trace_lookup",
    requesterUserId: "owner",
    channelId: "channel",
    requestMessageId: "message",
    request: "why?",
    messages: [],
  });
  expect(replies).toEqual([
    {
      type: "result",
      jobId: "lazy-read",
      ok: true,
      content: '{"status":"not_found"}',
    },
  ]);
  expect(currentJobs.size).toBe(1);
  expect(currentJobs.has("active-answer")).toBe(true);
});
