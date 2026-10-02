import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ChatAnswerJob,
  OracleAnswerJob,
} from "../../contracts/worker-contract";
import { ChatbotTraceStore } from "./trace-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store() {
  const directory = mkdtempSync(join(tmpdir(), "minisago-traces-"));
  directories.push(directory);
  return new ChatbotTraceStore(join(directory, "traces.sqlite"), {
    model: "test-model",
    promptVersion: 7,
  });
}

function job(overrides: Partial<ChatAnswerJob>): ChatAnswerJob {
  return {
    id: "answer-1",
    requesterUserId: "test-user",
    purpose: "answer",
    executionRoute: "chat",
    mcpAccessToken: "test-token",
    channelId: "channel-1",
    requestMessageId: "request-1",
    request: "What happened?",
    messages: [],
    ...overrides,
  };
}

describe("chatbot trace store", () => {
  test("recovers a failed coding task and its session after reopening the store", () => {
    const traces = store();
    const now = Date.now();
    const answer: OracleAnswerJob = {
      ...job({}),
      executionRoute: "oracle",
      repository: "sago-cream/mini-sago",
      developerTask: { id: "coding-task", title: "Original task" },
    };
    traces.start(answer, now);
    traces.recordDeveloperSession(answer.id, "codex-session");
    traces.fail(answer.id, "Task stopped.", now + 100);
    // Later chat replies must not hide the preserved coding workspace.
    const chat = job({ id: "later-chat", requestMessageId: "later-request" });
    traces.start(chat, now + 200);
    traces.recordDeveloperSession(chat.id, "chat-session");
    traces.finish(chat.id, "Chat reply", now + 300);
    traces.close();
    const reopened = new ChatbotTraceStore(
      join(directories.at(-1)!, "traces.sqlite"),
    );
    expect(reopened.preservedDeveloperTask("channel-1", now + 400)).toEqual({
      id: "coding-task",
      title: "Original task",
      resumeSessionId: "codex-session",
      requesterUserId: "test-user",
      repository: "sago-cream/mini-sago",
      request: "What happened?",
    });
    expect(
      reopened.preservedDeveloperTask("other-channel", now + 400),
    ).toBeUndefined();
    expect(
      reopened.preservedDeveloperTask(
        "channel-1",
        now + 3 * 24 * 60 * 60_000 + 101,
      ),
    ).toBeUndefined();
    reopened.close();
  });

  test("recovers session metadata recorded before the worker upgrade", () => {
    const traces = store();
    const answer: OracleAnswerJob = {
      ...job({}),
      executionRoute: "oracle",
      repository: "sago-cream/mini-sago",
      developerTask: { id: "legacy-task", resumeSessionId: "legacy-session" },
    };
    traces.start(answer);
    traces.fail(answer.id, "Task stopped.");
    expect(traces.preservedDeveloperTask("channel-1")).toMatchObject({
      id: "legacy-task",
      resumeSessionId: "legacy-session",
    });
    traces.close();
  });
  test("returns sanitized observable metadata for the latest answer", () => {
    const traces = store();
    const answer = job({
      messages: Array.from({ length: 42 }, (_, index) => ({
        id: `message-${index}`,
        author: "Member",
        timestamp: "2026-07-21T10:00:00.000Z",
        content: "context",
        attachments: [],
      })),
      mcpAccessToken: "must-not-be-persisted",
    });

    traces.start(answer, 1_000, { model: "owner-model" });
    traces.finish(answer.id, "The answer", 3_000, [
      {
        name: "resolve_context",
        arguments: {
          historyCount: 50,
          queries: [{ content: "launch", author: "Daniel" }],
          memberQueries: ["Daniel"],
        },
        resultCount: 1,
        status: "completed",
      },
    ]);

    expect(traces.previousTrace("channel-1", "request-2")).toEqual({
      historyCount: 50,
      contextMessageCount: 42,
      searchQueries: [{ content: "launch", author: "Daniel" }],
      searchResultCount: 1,
      memberQueries: ["Daniel"],
      toolCalls: [
        {
          name: "resolve_context",
          arguments: {
            historyCount: 50,
            queries: [{ content: "launch", author: "Daniel" }],
            memberQueries: ["Daniel"],
          },
          resultCount: 1,
          status: "completed",
        },
      ],
      elapsedMs: 2_000,
      model: "owner-model",
      promptVersion: 7,
    });
    traces.close();
  });

  test("deletes traces older than fourteen days", () => {
    const traces = store();
    const oldJob = job({});
    traces.start(oldJob, 1_000);
    traces.finish(oldJob.id, "Old answer", 2_000);
    traces.cleanup(15 * 24 * 60 * 60 * 1_000);

    expect(traces.previousTrace("channel-1", "request-2")).toBeUndefined();
    traces.close();
  });

  test("records bounded prompt compilation metadata", () => {
    const traces = store();
    const answer = job({});
    traces.start(answer, 1_000);
    traces.recordPrompt(answer.id, {
      promptVersion: 31,
      versions: { policy: 2, task: 3, context: 4 },
      purpose: "answer",
      developerCharacters: 100,
      taskCharacters: 20,
      contextCharacters: 300,
    });
    traces.finish(answer.id, "The answer", 2_000);

    expect(traces.previousTrace("channel-1", "request-2")).toMatchObject({
      promptVersion: 31,
      prompt: {
        promptVersion: 31,
        versions: { policy: 2, task: 3, context: 4 },
        developerCharacters: 100,
        taskCharacters: 20,
        contextCharacters: 300,
      },
    });
    traces.close();
  });
});
