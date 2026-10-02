export {};

const encoder = new TextEncoder();

function send(value: unknown) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify(value)}\n`));
}

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();
let buffer = "";
let threadConfig: unknown;
let permissions: unknown;
let cwd: unknown;
let resumed = false;

async function handle(line: string) {
  if (!line.trim()) return;
  const message = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "initialize") {
    if (process.env.MINISAGO_TEST_HANG_INIT) return;
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "initialized") {
    // Notification only.
  } else if (
    message.method === "thread/start" ||
    message.method === "thread/resume"
  ) {
    threadConfig = message.params?.config;
    permissions = message.params?.permissions;
    cwd = message.params?.cwd;
    resumed = message.method === "thread/resume";
    send({
      id: message.id,
      result: { thread: { id: "thread-native", sessionId: "thread-native" } },
    });
  } else if (message.method === "thread/name/set") {
    send({ id: message.id, result: {} });
  } else if (message.method === "turn/start") {
    send({
      id: message.id,
      result: {
        turn: { id: "turn-native", status: "inProgress", items: [] },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          id: "reasoning-1",
          type: "reasoning",
          summary: [
            {
              text: "Managing file modifications\n\nI need to consider internal implementation details.",
            },
          ],
          content: [],
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          type: "agentMessage",
          phase: "commentary",
          text: "Inspecting the task.",
        },
      },
    });
    if (process.env.MINISAGO_TEST_COMMAND_FAILURE)
      send({
        method: "item/completed",
        params: {
          threadId: "thread-native",
          turnId: "turn-native",
          item: {
            type: "commandExecution",
            status: "completed",
            exitCode: 1,
            aggregatedOutput: "No matches found.",
          },
        },
      });
    if (message.params?.outputSchema && process.env.MINISAGO_TEST_RUNTIME) {
      if (process.env.MINISAGO_TEST_SANDBOX_FAILURE)
        send({
          method: "item/completed",
          params: {
            threadId: "thread-native",
            turnId: "turn-native",
            item: {
              type: "commandExecution",
              exitCode: 101,
              aggregatedOutput:
                "bwrap: failed to inspect synthetic bubblewrap mount target /socket/.git: Not a directory",
            },
          },
        });
      send({
        method: "item/completed",
        params: {
          threadId: "thread-native",
          turnId: "turn-native",
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: JSON.stringify({
              pid: process.pid,
              tmp: process.env.TMPDIR,
              token: process.env.MINISAGO_TEST_TOKEN,
              threadConfig,
              permissions,
              cwd,
              resumed,
            }),
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-native",
          turn: { id: "turn-native", status: "completed", items: [] },
        },
      });
    } else if (message.params?.outputSchema) {
      for (const delta of ['{"reply":"最初の文。', '次の文。"}']) {
        send({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-native",
            turnId: "turn-native",
            itemId: "message-stream",
            delta,
          },
        });
      }
      send({
        method: "item/completed",
        params: {
          threadId: "thread-native",
          turnId: "turn-native",
          item: {
            id: "message-stream",
            type: "agentMessage",
            phase: "final_answer",
            text: '{"reply":"最初の文。次の文。"}',
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId: "thread-native",
          turn: { id: "turn-native", status: "completed", items: [] },
        },
      });
    }
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "turn-native" } });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          id: "message-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Applying the new direction.",
        },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-native",
        turnId: "turn-native",
        item: {
          id: "message-2",
          type: "agentMessage",
          phase: "final_answer",
          text: "Finished after steering.",
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-native",
        turn: { id: "turn-native", status: "completed", items: [] },
      },
    });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: "thread-native",
        turn: { id: "turn-native", status: "interrupted", items: [] },
      },
    });
  }
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    await handle(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
}
