import { describe, expect, test } from "bun:test";

import { parseChatbotJob } from "./worker-contract";

const common = {
  id: "job-1",
  requesterUserId: "user-1",
  channelId: "channel-1",
  requestMessageId: "message-1",
  request: "hello",
  messages: [],
};

describe("chatbot job protocol", () => {
  test("accepts each valid job shape", () => {
    expect(
      parseChatbotJob({
        ...common,
        purpose: "execution_route",
        availableRepositories: ["sago-cream/mini-sago"],
        capabilities: [
          {
            id: "feature_availability",
            category: "system",
            availability: "available",
            description: "Change feature coverage with a host-bound tool.",
            tools: ["configure_feature_availability"],
          },
        ],
      })?.purpose,
    ).toBe("execution_route");
    expect(
      parseChatbotJob({ ...common, purpose: "trace_lookup" })?.purpose,
    ).toBe("trace_lookup");
    expect(
      parseChatbotJob({
        ...common,
        purpose: "social_action",
        availableTools: [],
        socialActionCandidateMessageIds: ["message-2"],
      })?.purpose,
    ).toBe("social_action");
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "chat",
        mcpAccessToken: "token",
        capabilities: [
          {
            id: "conversation",
            category: "conversation",
            availability: "available",
            description: "Answer from supplied context.",
          },
        ],
      })?.purpose,
    ).toBe("answer");
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "oracle",
        repository: "sago-cream/mini-sago",
        mcpAccessToken: "token",
        developerTask: {
          id: "task-1",
          currentRequesterUserId: "participant-1",
        },
      })?.purpose,
    ).toBe("answer");
  });

  test("rejects missing discriminants and required answer fields", () => {
    expect(parseChatbotJob(common)).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "chat",
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "execution_route",
        availableRepositories: [],
        capabilities: [{ id: "feature_availability", category: "unknown" }],
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "oracle",
        mcpAccessToken: "token",
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "chat",
        mcpAccessToken: "token",
        capabilities: [{ id: "conversation", category: "unknown" }],
      }),
    ).toBeNull();
  });

  test("rejects fields that belong to another job shape", () => {
    expect(
      parseChatbotJob({
        ...common,
        purpose: "trace_lookup",
        executionRoute: "chat",
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "mac",
        repository: "sago-cream/mini-sago",
        mcpAccessToken: "token",
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "execution_route",
        availableRepositories: [],
        mcpAccessToken: "token",
      }),
    ).toBeNull();
  });

  test("rejects malformed nested worker input", () => {
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "chat",
        mcpAccessToken: "token",
        messages: [{ id: "message-1", attachments: [] }],
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "oracle",
        repository: "sago-cream/mini-sago",
        mcpAccessToken: "token",
        developerTask: {},
      }),
    ).toBeNull();
    expect(
      parseChatbotJob({
        ...common,
        purpose: "answer",
        executionRoute: "oracle",
        repository: "sago-cream/mini-sago",
        mcpAccessToken: "token",
        developerTask: { id: "task-1", currentRequesterUserId: 42 },
      }),
    ).toBeNull();
  });
});
