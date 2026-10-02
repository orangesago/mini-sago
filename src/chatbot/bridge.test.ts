import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import { MacAgentBridge, type MacAgentSocketData } from "./bridge";
import {
  CHATBOT_PROTOCOL_VERSION,
  CHATBOT_OUTGOING_FILE_LIMITS,
  type ChatbotJob,
} from "../../contracts/worker-contract";

const originalSecrets = {
  mac: process.env.MINISAGO_MAC_BRIDGE_SECRET,
  worker: process.env.MINISAGO_WORKER_BRIDGE_SECRET,
};
const bridgeSecret = "bridge-secret-that-is-at-least-32-bytes";
const macSecret = "mac-bridge-secret-that-is-at-least-32-bytes";

afterEach(() => {
  for (const [name, value] of Object.entries({
    MINISAGO_MAC_BRIDGE_SECRET: originalSecrets.mac,
    MINISAGO_WORKER_BRIDGE_SECRET: originalSecrets.worker,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function useWorker() {
  delete process.env.MINISAGO_MAC_BRIDGE_SECRET;
  process.env.MINISAGO_WORKER_BRIDGE_SECRET = bridgeSecret;
}

function fakeSocket() {
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    data: { authenticated: false },
    send(message: string) {
      sent.push(message);
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
  } as unknown as ServerWebSocket<MacAgentSocketData>;

  return { socket, sent, closed };
}

function connectWorker(
  bridge: MacAgentBridge,
  {
    workerId = "oracle",
    secret = bridgeSecret,
    repositories = ["sago-cream/mini-sago"],
    chatbotRepository,
    capacity = 1,
  }: {
    workerId?: string;
    secret?: string;
    repositories?: string[];
    chatbotRepository?: string;
    capacity?: number | null;
  } = {},
) {
  const worker = fakeSocket();
  bridge.open(worker.socket);
  bridge.message(
    worker.socket,
    JSON.stringify({
      type: "authenticate",
      protocolVersion: CHATBOT_PROTOCOL_VERSION,
      secret,
      workerId,
      repositories,
      ...(chatbotRepository ? { chatbotRepository } : {}),
    }),
  );
  if (capacity !== null) {
    bridge.message(
      worker.socket,
      JSON.stringify({ type: "availability", available: true, capacity }),
    );
  }
  return worker;
}

describe("Mac agent bridge", () => {
  test("binds cloud worker identity to its profile secret", () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const worker = fakeSocket();

    bridge.open(worker.socket);
    bridge.message(
      worker.socket,
      JSON.stringify({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: bridgeSecret,
        workerId: "other-worker",
        repositories: ["sago-cream/mini-sago"],
      }),
    );

    expect(worker.sent).toEqual([]);
    expect(worker.closed).toEqual([
      { code: 4001, reason: "Authentication failed" },
    ]);
  });

  test("stays offline until an authenticated helper reports availability", () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket, sent } = connectWorker(bridge, {
      repositories: ["sago-cream/mini-sago", "Kiwi/backend"],
      chatbotRepository: "sago-cream/mini-sago",
      capacity: null,
    });

    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { type: "authenticated", protocolVersion: CHATBOT_PROTOCOL_VERSION },
    ]);
    expect(bridge.getStatus()).toBe("offline");

    bridge.message(
      socket,
      JSON.stringify({ type: "availability", available: true, capacity: 1 }),
    );
    expect(bridge.getStatus()).toBe("available");
  });

  test("triggers and records Oracle Skillbook refreshes", () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket, sent } = connectWorker(bridge);
    bridge.message(
      socket,
      JSON.stringify({
        type: "availability",
        available: true,
        capacity: 1,
        skillbook: { ok: true, syncing: false, skills: 21 },
      }),
    );

    expect(bridge.triggerOracleSkillSync()).toBe(true);
    expect(bridge.getWorkerSummary().skillbook?.syncing).toBe(true);
    const request = JSON.parse(sent.at(-1)!);
    expect(request).toMatchObject({ type: "skill_sync_request" });
    expect(typeof request.requestId).toBe("string");

    bridge.message(
      socket,
      JSON.stringify({
        type: "skill_sync_result",
        requestId: request.requestId,
        status: {
          ok: true,
          syncing: false,
          skills: 21,
          lastSyncedAt: "2026-09-02T00:00:00.000Z",
        },
      }),
    );
    expect(bridge.getWorkerSummary().skillbook).toEqual({
      ok: true,
      syncing: false,
      skills: 21,
      lastSyncedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  test("enforces the advertised capacity and resolves matching results", async () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket, sent } = connectWorker(bridge);
    const job: ChatbotJob = {
      id: "job-1",
      requesterUserId: "test-user",
      purpose: "answer",
      executionRoute: "chat",
      mcpAccessToken: "test-token",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "Summarize this",
      messages: [],
    };

    const deltas: string[] = [];
    const dispatch = bridge.dispatch(job, ["chat"], (delta) =>
      deltas.push(delta),
    );
    expect(dispatch.status).toBe("accepted");
    expect(bridge.dispatch({ ...job, id: "job-2" }).status).toBe("busy");
    expect(JSON.parse(sent.at(-1)!)).toEqual({ type: "job", job });

    bridge.message(
      socket,
      JSON.stringify({
        type: "answer_delta",
        jobId: job.id,
        delta: "最初の文。",
      }),
    );
    expect(deltas).toEqual(["最初の文。"]);

    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: job.id,
        ok: true,
        content: "A short summary",
        files: [
          {
            filename: "notes.txt",
            contentType: "text/plain",
            size: 5,
            data: Buffer.from("hello").toString("base64"),
          },
        ],
      }),
    );

    if (dispatch.status !== "accepted") {
      throw new Error("Expected accepted dispatch");
    }

    expect(await dispatch.result).toEqual({
      ok: true,
      content: "A short summary",
      files: [
        {
          filename: "notes.txt",
          contentType: "text/plain",
          size: 5,
          data: Buffer.from("hello").toString("base64"),
        },
      ],
    });
    expect(bridge.getStatus()).toBe("available");
  });

  test("accepts multiple images but rejects excessive count and combined bytes", async () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket } = connectWorker(bridge);
    const job: ChatbotJob = {
      id: "images",
      requesterUserId: "test-user",
      purpose: "answer",
      executionRoute: "chat",
      mcpAccessToken: "test-token",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "Show the screenshots",
      messages: [],
    };
    const file = {
      filename: "after.png",
      contentType: "image/png",
      size: 5,
      data: Buffer.from("image").toString("base64"),
    };
    const largeBytes = Buffer.alloc(CHATBOT_OUTGOING_FILE_LIMITS.bytes / 2 + 1);
    const largeFile = {
      ...file,
      size: largeBytes.length,
      data: largeBytes.toString("base64"),
    };
    for (const [index, files] of [
      [file, file],
      Array(11).fill(file),
      [largeFile, largeFile],
    ].entries()) {
      const dispatch = bridge.dispatch({ ...job, id: `images-${index}` });
      if (dispatch.status !== "accepted")
        throw new Error("Expected accepted dispatch");
      bridge.message(
        socket,
        JSON.stringify({
          type: "result",
          jobId: `images-${index}`,
          ok: true,
          content: "Done",
          files,
        }),
      );
      const result = await dispatch.result;
      if (index === 0)
        expect(result).toEqual({ ok: true, content: "Done", files });
      else
        expect(result).toEqual({
          ok: false,
          error: "Worker returned invalid files.",
          failureKind: "internal",
        });
    }
    bridge.close(socket);
  });

  test("reserves the bridge across routing and answering jobs", async () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket } = connectWorker(bridge, {
      repositories: ["sago-cream/mini-sago", "Kiwi/backend"],
      chatbotRepository: "sago-cream/mini-sago",
    });
    const job: ChatbotJob = {
      id: "router-1",
      requesterUserId: "test-user",
      purpose: "execution_route",
      availableRepositories: ["Kiwi/backend", "sago-cream/mini-sago"],
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "What did we decide?",
      messages: [],
    };

    const acquired = bridge.acquireWorkflow();
    expect(acquired.status).toBe("accepted");
    expect(bridge.getStatus()).toBe("busy");
    expect(bridge.acquireWorkflow().status).toBe("busy");
    if (acquired.status !== "accepted") throw new Error("Expected workflow");
    expect(acquired.workflow.availableRepositories).toEqual([
      "Kiwi/backend",
      "sago-cream/mini-sago",
    ]);
    expect(acquired.workflow.chatbotRepository).toBe("sago-cream/mini-sago");

    const planning = acquired.workflow.dispatch(job);
    expect(planning.status).toBe("accepted");
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: job.id,
        ok: true,
        content: '{"history":"local","queries":[]}',
      }),
    );
    if (planning.status !== "accepted") throw new Error("Expected planning");
    await planning.result;

    const answer = acquired.workflow.dispatch({
      id: "answer-1",
      requesterUserId: job.requesterUserId,
      purpose: "answer",
      executionRoute: "chat",
      mcpAccessToken: "test-token",
      channelId: job.channelId,
      requestMessageId: job.requestMessageId,
      request: job.request,
      messages: job.messages,
    });
    expect(answer.status).toBe("accepted");
    acquired.workflow.release();
    expect(bridge.getStatus()).toBe("busy");
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: "answer-1",
        ok: true,
        content: "Friday",
      }),
    );
    if (answer.status !== "accepted") throw new Error("Expected answer");
    await answer.result;
    expect(bridge.getStatus()).toBe("available");
  });

  test("forwards bounded progress and stops a workflow job", async () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket, sent } = connectWorker(bridge);
    const acquired = bridge.acquireWorkflow();
    if (acquired.status !== "accepted") throw new Error("Expected workflow");
    const progress: unknown[] = [];
    const job: ChatbotJob = {
      id: "coding-1",
      requesterUserId: "test-user",
      purpose: "answer",
      executionRoute: "oracle",
      repository: "sago-cream/mini-sago",
      mcpAccessToken: "test-token",
      channelId: "thread-1",
      requestMessageId: "message-1",
      request: "Fix it",
      messages: [],
    };
    const dispatch = acquired.workflow.dispatch(job, (value) =>
      progress.push(value),
    );
    if (dispatch.status !== "accepted") throw new Error("Expected dispatch");

    bridge.message(
      socket,
      JSON.stringify({
        type: "progress",
        jobId: job.id,
        progress: {
          phase: "implementing",
          summary: "Updated the working tree.",
          sessionId: "019-session",
        },
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({
        type: "progress",
        jobId: job.id,
        progress: { phase: "secret", summary: "invalid" },
      }),
    );

    expect(progress).toEqual([
      {
        phase: "implementing",
        summary: "Updated the working tree.",
        sessionId: "019-session",
      },
    ]);
    const steer = acquired.workflow.steer(job.id, "Check the setup guide");
    const steerMessage = JSON.parse(sent.at(-1)!);
    expect(steerMessage).toMatchObject({
      type: "steer",
      jobId: job.id,
      request: "Check the setup guide",
    });
    bridge.message(
      socket,
      JSON.stringify({
        type: "steer_result",
        jobId: job.id,
        requestId: steerMessage.requestId,
        accepted: true,
      }),
    );
    expect(await steer).toBe(true);
    expect(acquired.workflow.stop(job.id)).toBe(true);
    expect(JSON.parse(sent.at(-1)!)).toEqual({
      type: "cancel",
      jobId: job.id,
    });
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: job.id,
        ok: false,
        error: "Task stopped.",
        failureKind: "internal",
        stopped: true,
      }),
    );
    expect(await dispatch.result).toEqual({
      ok: false,
      error: "Task stopped.",
      failureKind: "internal",
      stopped: true,
    });
    acquired.workflow.release();
  });

  test("reads Codex usage from the worker reserved by a workflow", async () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket, sent } = connectWorker(bridge, { repositories: [] });
    const acquired = bridge.acquireWorkflow();
    if (acquired.status !== "accepted") throw new Error("Expected workflow");

    const usagePromise = acquired.workflow.getCodexUsage();
    const request = JSON.parse(sent.at(-1)!);
    expect(request.type).toBe("codex_usage_request");
    bridge.message(
      socket,
      JSON.stringify({
        type: "codex_usage_result",
        requestId: request.requestId,
        usage: {
          windows: [
            {
              label: "weekly",
              windowMinutes: 10_080,
              usedPercent: 35,
              remainingPercent: 65,
              resetsAt: "2026-08-09T00:00:00.000Z",
            },
          ],
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      }),
    );
    expect(await usagePromise).toMatchObject({
      windows: [{ usedPercent: 35, remainingPercent: 65 }],
    });

    const invalidPromise = acquired.workflow.getCodexUsage();
    const invalidRequest = JSON.parse(sent.at(-1)!);
    bridge.message(
      socket,
      JSON.stringify({
        type: "codex_usage_result",
        requestId: invalidRequest.requestId,
        usage: {
          windows: [
            {
              label: "weekly",
              windowMinutes: 10_080,
              usedPercent: 200,
              remainingPercent: -100,
              resetsAt: "not-a-date",
            },
          ],
          updatedAt: "not-a-date",
        },
      }),
    );
    expect(await invalidPromise).toBeNull();
    acquired.workflow.release();
  });

  test("runs multiple reserved workflows concurrently up to capacity", async () => {
    useWorker();
    const bridge = new MacAgentBridge();
    const { socket } = connectWorker(bridge, { capacity: 2 });
    const job: ChatbotJob = {
      id: "job-1",
      requesterUserId: "test-user",
      purpose: "answer",
      executionRoute: "chat",
      mcpAccessToken: "test-token",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "Summarize this",
      messages: [],
    };

    const first = bridge.acquireWorkflow();
    const second = bridge.acquireWorkflow();
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(bridge.acquireWorkflow().status).toBe("busy");
    if (first.status !== "accepted" || second.status !== "accepted") {
      throw new Error("Expected concurrent workflows");
    }

    const firstJob = first.workflow.dispatch(job);
    const secondJob = second.workflow.dispatch({ ...job, id: "job-2" });
    expect(firstJob.status).toBe("accepted");
    expect(secondJob.status).toBe("accepted");

    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: "job-2",
        ok: true,
        content: "second",
      }),
    );
    bridge.message(
      socket,
      JSON.stringify({
        type: "result",
        jobId: "job-1",
        ok: true,
        content: "first",
      }),
    );

    if (firstJob.status !== "accepted" || secondJob.status !== "accepted") {
      throw new Error("Expected concurrent jobs");
    }
    expect(await Promise.all([firstJob.result, secondJob.result])).toEqual([
      { ok: true, content: "first" },
      { ok: true, content: "second" },
    ]);
    first.workflow.release();
    second.workflow.release();
    expect(bridge.getStatus()).toBe("available");
  });

  test("keeps cloud and Mac connected while routing workflows by capability", async () => {
    process.env.MINISAGO_WORKER_BRIDGE_SECRET = bridgeSecret;
    process.env.MINISAGO_MAC_BRIDGE_SECRET = macSecret;
    const bridge = new MacAgentBridge();
    const cloud = connectWorker(bridge);
    const mac = connectWorker(bridge, {
      workerId: "hsi-mac",
      secret: macSecret,
    });
    expect(cloud.closed).toEqual([]);
    expect(mac.closed).toEqual([]);
    expect(bridge.getWorkerSummary()).toEqual({
      connected: 2,
      available: 2,
      capacity: 2,
      active: 0,
      mac: "available",
    });

    const first = bridge.acquireWorkflow();
    const fallback = bridge.acquireWorkflow();
    if (first.status !== "accepted" || fallback.status !== "accepted") {
      throw new Error("Expected both workers to accept workflows");
    }
    const cloudJob: ChatbotJob = {
      id: "cloud-job",
      requesterUserId: "owner",
      purpose: "answer",
      executionRoute: "chat",
      mcpAccessToken: "test-token",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "Review a PR",
      messages: [],
    };
    const macJob = { ...cloudJob, id: "mac-job", request: "Open Xcode" };
    const cloudDispatch = first.workflow.dispatch(cloudJob);
    const fallbackDispatch = fallback.workflow.dispatch(macJob);
    expect(JSON.parse(cloud.sent.at(-1)!)).toEqual({
      type: "job",
      job: cloudJob,
    });
    expect(JSON.parse(mac.sent.at(-1)!)).toEqual({
      type: "job",
      job: macJob,
    });
    bridge.message(
      mac.socket,
      JSON.stringify({
        type: "result",
        jobId: "cloud-job",
        ok: true,
        content: "wrong worker",
      }),
    );
    expect(bridge.getWorkerSummary().active).toBe(2);
    bridge.message(
      cloud.socket,
      JSON.stringify({
        type: "result",
        jobId: "cloud-job",
        ok: true,
        content: "routed",
      }),
    );
    bridge.message(
      mac.socket,
      JSON.stringify({
        type: "result",
        jobId: "mac-job",
        ok: true,
        content: "fallback",
      }),
    );
    if (
      cloudDispatch.status !== "accepted" ||
      fallbackDispatch.status !== "accepted"
    ) {
      throw new Error("Expected routed jobs");
    }
    await Promise.all([cloudDispatch.result, fallbackDispatch.result]);
    fallback.workflow.release();

    expect(first.workflow.route(["chat", "mac"])).toEqual({
      status: "accepted",
    });
    const localDispatch = first.workflow.dispatch({
      ...macJob,
      id: "local-job",
      executionRoute: "mac",
    });
    expect(JSON.parse(mac.sent.at(-1)!)).toEqual({
      type: "job",
      job: {
        ...macJob,
        id: "local-job",
        executionRoute: "mac",
      },
    });
    bridge.message(
      mac.socket,
      JSON.stringify({
        type: "result",
        jobId: "local-job",
        ok: true,
        content: "local",
      }),
    );
    if (localDispatch.status !== "accepted") {
      throw new Error("Expected Mac-routed job");
    }
    expect(await localDispatch.result).toEqual({ ok: true, content: "local" });
    expect(
      first.workflow.route(["dev", "mac"], "sago-cream/mini-sago"),
    ).toEqual({
      status: "accepted",
    });
    first.workflow.release();
  });

  test("enforces repository scope before dispatching a dev job", () => {
    useWorker();
    const bridge = new MacAgentBridge();
    connectWorker(bridge);

    const workflow = bridge.acquireWorkflow();
    if (workflow.status !== "accepted") throw new Error("Expected workflow");
    expect(
      workflow.workflow.route(["dev"], "sago-cream/not-advertised"),
    ).toEqual({
      status: "offline",
    });
    expect(
      workflow.workflow.dispatch({
        id: "review-job",
        requesterUserId: "owner",
        purpose: "answer",
        executionRoute: "oracle",
        repository: "sago-cream/not-advertised",
        mcpAccessToken: "test-token",
        channelId: "channel-1",
        requestMessageId: "message-1",
        request: "review this PR",
        messages: [],
      }).status,
    ).toBe("offline");
    workflow.workflow.release();
  });
});

test("direct voice dispatch cancels once and retains capacity until acknowledgement", async () => {
  useWorker();
  const bridge = new MacAgentBridge();
  const { socket, sent } = connectWorker(bridge);
  const job: ChatbotJob = {
    id: "voice-one",
    mcpAccessToken: "voice-test-token",
    executionRoute: "chat",
    purpose: "answer",
    requesterUserId: "user",
    channelId: "voice",
    requestMessageId: "message",
    request: "hello",
    messages: [],
    streamReply: true,
  };
  const deltas: string[] = [];
  const dispatch = bridge.dispatch(job, ["chat"], (delta) =>
    deltas.push(delta),
  );
  if (dispatch.status !== "accepted") throw new Error("Expected dispatch");
  expect(dispatch.cancel()).toBe(true);
  expect(dispatch.cancel()).toBe(true);
  expect(
    sent
      .map((value) => JSON.parse(value))
      .filter((value) => value.type === "cancel"),
  ).toEqual([{ type: "cancel", jobId: job.id }]);
  bridge.message(
    socket,
    JSON.stringify({ type: "answer_delta", jobId: job.id, delta: "stale" }),
  );
  expect(deltas).toEqual([]);
  expect(bridge.dispatch({ ...job, id: "voice-two" }).status).toBe("busy");
  bridge.message(
    socket,
    JSON.stringify({
      type: "result",
      jobId: job.id,
      ok: false,
      error: "cancelled",
      failureKind: "internal",
      stopped: true,
    }),
  );
  expect(await dispatch.result).toMatchObject({ ok: false, stopped: true });
  expect(dispatch.cancel()).toBe(false);
  const next = bridge.dispatch({ ...job, id: "voice-two" });
  expect(next.status).toBe("accepted");
  bridge.message(
    socket,
    JSON.stringify({
      type: "result",
      jobId: "voice-two",
      ok: true,
      content: "hello",
    }),
  );
  if (next.status === "accepted") await next.result;
});
