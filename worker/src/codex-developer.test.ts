import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OracleAnswerJob } from "../../contracts/worker-contract";
import { runCodexJob } from "./codex";
import type { CodexAppServerManager } from "./codex-app-server";

const roots: string[] = [];
type DeveloperRun = Parameters<CodexAppServerManager["run"]>[0];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function developerFixture() {
  const root = await mkdtemp(join(tmpdir(), "minisago-developer-run-"));
  roots.push(root);
  const githubWorktreeRoot = join(root, "worktrees");
  const directory = join(githubWorktreeRoot, "task-1", "owner", "repo");
  const codexHome = join(root, "codex-home");
  const githubConfigDir = join(root, "github");
  await Promise.all(
    [directory, codexHome, githubConfigDir].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  const git = Bun.spawn(["git", "init", "--quiet", directory], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await git.exited) !== 0)
    throw new Error(await new Response(git.stderr).text());
  const codexPath = join(root, "codex");
  // The model runner is injected below; sandbox preflight needs no credentials.
  await Bun.write(codexPath, "#!/bin/sh\nexit 0\n");
  await chmod(codexPath, 0o700);
  const job: OracleAnswerJob = {
    id: "turn-1",
    requesterUserId: "917446775873343600",
    purpose: "answer",
    executionRoute: "oracle",
    repository: "owner/repo",
    mcpAccessToken: "fixture-token",
    channelId: "thread-1",
    requestMessageId: "message-1",
    request: "Implement the requested change.",
    messages: [],
    developerTask: { id: "task-1" },
  };
  const options = {
    codexHome,
    codexPath,
    githubConfigDir,
    githubRepositories: [job.repository],
    githubWorktreeRoot,
    macFileRoots: [],
    mcpUrl: "http://localhost:1234/mcp",
    sandboxUrl: "http://localhost:1234/sandbox",
    workspaceRoot: root,
    chatbotAccess: {
      ownerUserId: job.requesterUserId,
      guildIds: new Set<string>(),
      channelIds: new Set<string>(),
      roleIds: new Set<string>(),
    },
  };
  return { root, directory, job, options };
}

test("enables repository instruction discovery in new and resumed developer runs", async () => {
  const { job, options, directory } = await developerFixture();
  await Bun.write(join(directory, "AGENTS.md"), "Use conventional commits.\n");
  const calls: DeveloperRun[] = [];
  const appServer = {
    run: async (call: DeveloperRun) => {
      calls.push(call);
      return "Done.";
    },
  } as unknown as CodexAppServerManager;
  await runCodexJob(job, { ...options, appServer });
  await runCodexJob(
    {
      ...job,
      id: "turn-2",
      developerTask: { id: "task-1", resumeSessionId: "session-1" },
    },
    { ...options, appServer },
  );
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call.cwd).toBe(directory);
    expect(call.command).toContain("project_doc_max_bytes=32768");
    expect(call.command).not.toContain("project_doc_max_bytes=0");
    expect(call.developerInstructions).toContain("Follow discovered AGENTS.md");
  }
  expect(calls[1]!.resumeThreadId).toBe("session-1");
});
