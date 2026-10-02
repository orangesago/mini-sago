import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { ChatbotTaskProgress } from "../../contracts/worker-contract";
import {
  CodexAppServerManager,
  isSuccessfulPullRequestMerge,
} from "./codex-app-server";

const fakeServer = join(
  import.meta.dir,
  "test-fixtures/fake-codex-app-server.ts",
);

function runOptions(
  onProgress: (progress: ChatbotTaskProgress) => void,
  jobId = "job-1",
) {
  return {
    jobId,
    taskId: "task-1",
    title: "Codex generated title",
    command: [process.execPath, fakeServer],
    cwd: import.meta.dir,
    environment: { ...process.env } as Record<string, string>,
    model: "gpt-5.6-sol",
    effort: "medium",
    developerInstructions: "Follow the coding policy.",
    prompt: "Implement the task.",
    imagePaths: [],
    onProgress,
  };
}

describe("Codex App Server manager", () => {
  test("recognizes only successful pull request merge commands", () => {
    expect(
      isSuccessfulPullRequestMerge({
        type: "commandExecution",
        command: '/bin/zsh -lc "gh pr merge 42 --merge"',
        status: "completed",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(
      isSuccessfulPullRequestMerge({
        type: "commandExecution",
        command: "gh pr merge 42 --merge",
        status: "failed",
        exitCode: 1,
      }),
    ).toBe(false);
    expect(
      isSuccessfulPullRequestMerge({
        type: "commandExecution",
        command: "gh pr view 42",
        status: "completed",
        exitCode: 0,
      }),
    ).toBe(false);
  });

  test("keeps steering in the active turn and returns only its final answer", async () => {
    const manager = new CodexAppServerManager();
    expect(manager.status()).toEqual({ ok: true, sessions: 0, active: 0 });
    const progress: ChatbotTaskProgress[] = [];
    const result = manager.run(runOptions((item) => progress.push(item)));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (progress.some((item) => item.summary === "Inspecting the task.")) {
        break;
      }
      await Bun.sleep(2);
    }

    expect(manager.status()).toEqual({ ok: true, sessions: 1, active: 1 });
    expect(await manager.steer("job-1", "Focus on the setup guide.")).toBe(
      true,
    );
    expect(await result).toBe("Finished after steering.");
    expect(manager.status()).toEqual({ ok: true, sessions: 1, active: 0 });
    expect(progress).toContainEqual({
      phase: "reviewing",
      summary: "Inspecting the task.",
      kind: "trace",
    });
    expect(JSON.stringify(progress)).not.toContain(
      "Managing file modifications",
    );
    expect(JSON.stringify(progress)).not.toContain(
      "internal implementation details",
    );
    expect(progress).toContainEqual({
      phase: "reviewing",
      summary: "Applying the new direction.",
      kind: "trace",
    });
    expect(
      progress.some((item) => item.summary === "Finished after steering."),
    ).toBe(false);
    manager.close();
  });

  test("streams reply deltas from an ephemeral turn", async () => {
    const manager = new CodexAppServerManager();
    const deltas: string[] = [];
    const progress: ChatbotTaskProgress[] = [];
    const result = await manager.run({
      ...runOptions((item) => progress.push(item), "job-stream"),
      taskId: "job-stream",
      ephemeral: true,
      outputSchema: { type: "object" },
      onAgentMessageDelta: (delta) => deltas.push(delta),
    });

    expect(result).toBe('{"reply":"最初の文。次の文。"}');
    expect(
      progress.filter((item) => item.timing).map((item) => item.timing!.stage),
    ).toEqual(["Process startup", "Thread setup"]);
    expect(
      progress
        .filter((item) => item.timing)
        .every((item) => item.timing!.durationMs >= 0),
    ).toBe(true);
    expect(deltas.join("")).toBe('{"reply":"最初の文。次の文。"}');
    expect(manager.status()).toEqual({ ok: true, sessions: 0, active: 0 });
    manager.close();
  });

  test("keeps recoverable command failures in diagnostics instead of public progress", async () => {
    const manager = new CodexAppServerManager();
    const progress: ChatbotTaskProgress[] = [];
    const calls: unknown[] = [];
    try {
      await manager.run({
        ...runOptions((item) => progress.push(item), "job-command-failure"),
        ephemeral: true,
        outputSchema: { type: "object" },
        failOnSandboxError: true,
        environment: {
          ...process.env,
          MINISAGO_TEST_COMMAND_FAILURE: "1",
        } as Record<string, string>,
        onMcpToolCall: (call) => calls.push(call),
      });
      expect(calls).toContainEqual({
        name: "command_execution",
        arguments: { exitCode: 1 },
        status: "failed",
      });
      expect(
        progress.some((item) => item.summary.includes("Command failed")),
      ).toBe(false);
    } finally {
      manager.close();
    }
  });

  test("interrupts without discarding the persistent Codex thread", async () => {
    const manager = new CodexAppServerManager();
    const firstProgress: ChatbotTaskProgress[] = [];
    const first = manager.run(
      runOptions((item) => firstProgress.push(item), "job-stop"),
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (firstProgress.some((item) => item.summary === "Inspecting the task."))
        break;
      await Bun.sleep(2);
    }
    expect(await manager.interrupt("job-stop")).toBe(true);
    await expect(first).rejects.toThrow("cancelled or timed out");

    const secondProgress: ChatbotTaskProgress[] = [];
    const second = manager.run(
      runOptions((item) => secondProgress.push(item), "job-continue"),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        secondProgress.some((item) => item.summary === "Inspecting the task.")
      )
        break;
      await Bun.sleep(2);
    }
    expect(await manager.steer("job-continue", "Continue.")).toBe(true);
    expect(await second).toBe("Finished after steering.");
    manager.close();
  });
});

test("restarts a task runner with fresh environment and replaces resumed thread configuration", async () => {
  const manager = new CodexAppServerManager();
  const progress: ChatbotTaskProgress[] = [];
  const options = {
    ...runOptions((item) => progress.push(item)),
    ephemeral: true,
    outputSchema: { type: "object" },
    threadConfig: { default_permissions: "new-profile" },
    permissions: "new-profile",
  };
  try {
    const first = JSON.parse(
      await manager.run({
        ...options,
        environment: {
          ...options.environment,
          MINISAGO_TEST_RUNTIME: "1",
          TMPDIR: "/tmp/first",
          MINISAGO_TEST_TOKEN: "old",
        },
      }),
    );
    const second = JSON.parse(
      await manager.run({
        ...options,
        jobId: "second",
        resumeThreadId: "thread-native",
        environment: {
          ...options.environment,
          MINISAGO_TEST_RUNTIME: "1",
          TMPDIR: "/tmp/second",
          MINISAGO_TEST_TOKEN: "new",
        },
      }),
    );
    expect(first.pid).not.toBe(second.pid);
    expect(second).toMatchObject({
      tmp: "/tmp/second",
      token: "new",
      resumed: true,
      permissions: "new-profile",
      cwd: options.cwd,
      threadConfig: {
        default_permissions: "new-profile",
      },
    });
    expect(manager.status().sessions).toBe(0);
    await expect(
      manager.run({
        ...options,
        failOnSandboxError: true,
        environment: {
          ...options.environment,
          MINISAGO_TEST_RUNTIME: "1",
          MINISAGO_TEST_SANDBOX_FAILURE: "1",
        },
      }),
    ).rejects.toThrow("Coding sandbox failed");
    expect(progress).toContainEqual({
      phase: "testing",
      kind: "trace",
      summary: "The coding environment is blocked by a sandbox failure.",
    });
  } finally {
    manager.close();
  }
});

test("cancels an initializing task runner before the first turn exists", async () => {
  const manager = new CodexAppServerManager();
  const options = runOptions(() => {});
  const controller = new AbortController();
  const run = manager.run({
    ...options,
    ephemeral: true,
    signal: controller.signal,
    environment: { ...options.environment, MINISAGO_TEST_HANG_INIT: "1" },
  });
  setTimeout(() => controller.abort(), 20);
  await expect(run).rejects.toThrow();
  expect(manager.status().active).toBe(0);
  manager.close();
});
