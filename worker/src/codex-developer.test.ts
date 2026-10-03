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

test("returns final screenshot bytes from the native developer runner", async () => {
  const { job, options, directory } = await developerFixture();
  const path = join(directory, "after.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jivsAAAAASUVORK5CYII=",
    "base64",
  );
  await Bun.write(path, png);
  const appServer = {
    run: async () => `Done.\n\n![After](<${path}>)`,
  } as unknown as CodexAppServerManager;
  const result = await runCodexJob(job, { ...options, appServer });
  expect(result).toEqual({
    content: "Done.\n\nAfter",
    files: [
      {
        filename: "after.png",
        contentType: "image/png",
        size: png.length,
        data: png.toString("base64"),
      },
    ],
  });
});

test.each([
  {
    repository: "OWNER/REPO",
    socket: "/run/minisago-deploy.sock",
    enabled: true,
  },
  {
    repository: "owner/other",
    socket: "/run/minisago-deploy.sock",
    enabled: false,
  },
  { repository: "owner/repo", socket: undefined, enabled: false },
])(
  "exposes deployment only for the configured repository and socket: %j",
  async ({ repository, socket, enabled }) => {
    const { job, options } = await developerFixture();
    const calls: DeveloperRun[] = [];
    const appServer = {
      run: async (call: DeveloperRun) => {
        calls.push(call);
        return "Done.";
      },
    } as unknown as CodexAppServerManager;
    const settings = {
      ...options,
      appServer,
      chatbotRepository: repository,
      deploySocketPath: socket,
    };
    await runCodexJob(job, settings);
    await runCodexJob(
      {
        ...job,
        id: "turn-2",
        developerTask: { id: "task-1", resumeSessionId: "session-1" },
      },
      settings,
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const config = call.threadConfig as {
        mcp_servers?: { minisago_deploy?: { env: Record<string, string> } };
      };
      expect(Boolean(config.mcp_servers?.minisago_deploy)).toBe(enabled);
      expect(
        call.developerInstructions.includes("deploy_minisago is available"),
      ).toBe(enabled);
      if (enabled) {
        expect(config.mcp_servers!.minisago_deploy!.env).toEqual({
          MINISAGO_DEPLOY_SOCKET: socket!,
          MINISAGO_DISCORD_CHANNEL_ID: job.channelId,
        });

        expect(call.developerInstructions).toContain(
          "no switch to main or SSH is required",
        );
      }
      expect(call.environment.MINISAGO_DEPLOY_SOCKET).toBeUndefined();
      expect(call.developerInstructions).toContain(
        "Do not ask for the same authorization again",
      );
      expect(call.developerInstructions).toContain(
        "gh image /absolute/path/to/screenshot.png",
      );
    }
  },
);

test("exposes the deployment tool through the exec developer runner", async () => {
  const { root, job, options } = await developerFixture();
  const capture = join(root, "exec-arguments");
  await Bun.write(
    options.codexPath,
    `#!/bin/sh
printf '%s\\n' "$@" > '${capture}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}'
`,
  );
  const result = await runCodexJob(job, {
    ...options,
    chatbotRepository: job.repository,
    deploySocketPath: "/run/minisago-deploy.sock",
  });
  expect(result.content).toBe("Done.");
  const arguments_ = await Bun.file(capture).text();
  expect(arguments_).toContain("mcp_servers.minisago_deploy.command=");
  expect(arguments_).toContain('MINISAGO_DISCORD_CHANNEL_ID="thread-1"');
  expect(arguments_).toContain("deploy_minisago is available");
});
