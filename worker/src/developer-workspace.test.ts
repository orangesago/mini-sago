import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OracleAnswerJob } from "../../contracts/worker-contract";
import {
  developerBranchName,
  prepareDeveloperWorkspace,
} from "./developer-workspace";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function options() {
  const root = await mkdtemp(join(tmpdir(), "minisago-dev-workspace-"));
  roots.push(root);
  return {
    githubConfigDir: "/secrets/github",
    githubRepositories: ["sago-cream/mini-sago"],
    githubWorktreeRoot: join(root, "worktrees"),
  };
}

function job(): OracleAnswerJob {
  return {
    id: "job-123",
    requesterUserId: "917446775873343600",
    purpose: "answer",
    executionRoute: "oracle",
    repository: "sago-cream/mini-sago",
    mcpAccessToken: "test-token",
    channelId: "channel-1",
    requestMessageId: "message-1",
    request: "review the PR",
    messages: [],
  };
}

async function localCommand(command: string[], environment = {}) {
  const child = Bun.spawn(command, {
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function legacyWorkspace() {
  const settings = await options();
  const taskJob = { ...job(), developerTask: { id: "task-456" } };
  const directory = join(
    settings.githubWorktreeRoot,
    "task-456",
    "sago-cream",
    "mini-sago",
  );
  await mkdir(directory, { recursive: true });
  const git = (...args: string[]) =>
    localCommand(["git", "-C", directory, ...args]);
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await Bun.write(join(directory, "tracked.txt"), "committed");
  await git("add", "tracked.txt");
  await git("commit", "-m", "chore: fixture");
  await git("switch", "-c", "minisago/task-456");
  return { settings, taskJob, directory, git };
}

describe("developer workspace", () => {
  test("generates conventional branch names without conflating normalized IDs", () => {
    const ids = [
      "task-123",
      "Task-123",
      "task_123",
      "task.123",
      "task--123",
      "task_",
      "A",
    ];
    const branches = ids.map(developerBranchName);
    for (const branch of branches) {
      expect(branch).toMatch(/^chore\/[a-z0-9]+(-[a-z0-9]+)*$/u);
    }
    expect(new Set(branches).size).toBe(ids.length);
  });

  test.each([undefined, "session-123"])(
    "migrates a legacy branch and preserves work with session %s",
    async (resumeSessionId) => {
      const { settings, taskJob, directory, git } = await legacyWorkspace();
      const head = await git("rev-parse", "HEAD");
      await Bun.write(join(directory, "tracked.txt"), "staged");
      await git("add", "tracked.txt");
      await Bun.write(join(directory, "tracked.txt"), "unstaged");
      await Bun.write(join(directory, "untracked.txt"), "keep");
      const resumedJob = {
        ...taskJob,
        developerTask: { ...taskJob.developerTask, resumeSessionId },
      };
      const workspace = await prepareDeveloperWorkspace(
        resumedJob,
        settings,
        localCommand,
      );
      expect(await git("branch", "--show-current")).toBe(
        "chore/minisago-task-456",
      );
      expect(await git("rev-parse", "HEAD")).toBe(head);
      expect(await git("show", ":tracked.txt")).toBe("staged");
      expect(await Bun.file(join(directory, "tracked.txt")).text()).toBe(
        "unstaged",
      );
      expect(await Bun.file(join(directory, "untracked.txt")).text()).toBe(
        "keep",
      );
      expect(workspace.environment.MINISAGO_GIT_BRANCH).toBe(
        "chore/minisago-task-456",
      );
      await prepareDeveloperWorkspace(resumedJob, settings, localCommand);
      expect(await git("rev-parse", "HEAD")).toBe(head);

      const remote = join(settings.githubWorktreeRoot, "remote.git");
      await localCommand(["git", "init", "--bare", remote]);
      await git("remote", "add", "origin", remote);
      const wrapper = join(workspace.environment.PATH!.split(":")[0]!, "git");
      // The wrapper checks the current directory, just as a task's shell does.
      const push = async () => {
        const child = Bun.spawn(
          [
            wrapper,
            "push",
            "origin",
            `HEAD:refs/heads/${workspace.environment.MINISAGO_GIT_BRANCH}`,
          ],
          {
            cwd: directory,
            env: { ...process.env, ...workspace.environment },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const stderr = await new Response(child.stderr).text();
        return { code: await child.exited, stderr };
      };
      expect((await push()).code).toBe(0);
      expect(
        await localCommand([
          "git",
          "--git-dir",
          remote,
          "rev-parse",
          "refs/heads/chore/minisago-task-456",
        ]),
      ).toBe(head);
      await git("switch", "-c", "fix/unprepared");
      const denied = await push();
      expect(denied.code).toBe(77);
      expect(denied.stderr).toContain("unprepared branch");
    },
  );

  test("does not overwrite a destination branch during migration", async () => {
    const { settings, taskJob, git } = await legacyWorkspace();
    await git("branch", "chore/minisago-task-456");
    const head = await git("rev-parse", "HEAD");
    await expect(
      prepareDeveloperWorkspace(taskJob, settings, localCommand),
    ).rejects.toThrow("already exists");
    expect(await git("branch", "--show-current")).toBe("minisago/task-456");
    expect(await git("rev-parse", "chore/minisago-task-456")).toBe(head);
  });

  test("clones only the selected repo with the dedicated credential", async () => {
    const commands: Array<{
      command: string[];
      environment: Record<string, string>;
    }> = [];
    const workspace = await prepareDeveloperWorkspace(
      job(),
      await options(),
      async (command, environment) => {
        commands.push({ command, environment });
      },
    );

    expect(workspace.directory).toEndWith(
      "/worktrees/job-123/sago-cream/mini-sago",
    );
    expect(commands).toHaveLength(2);
    expect(commands[0]!.command.slice(0, 4)).toEqual([
      "gh",
      "repo",
      "clone",
      "sago-cream/mini-sago",
    ]);
    expect(commands[0]!.environment.GH_CONFIG_DIR).toBe("/secrets/github");
    expect(workspace.sandboxReadPaths[0]).toEndWith("/worktrees/job-123/bin");
    expect(workspace.sandboxReadPaths[1]).toBe("/secrets/github");
    expect(workspace.sandboxReadPaths).not.toContain(workspace.directory);
    expect(workspace.sandboxWritePaths).toEqual([
      join(workspace.directory, ".git"),
      workspace.temporaryDirectory,
    ]);
    await workspace.cleanup();
  });

  test("prepares every owner coding job on a protected feature branch", async () => {
    const commands: Array<{
      command: string[];
      environment: Record<string, string>;
    }> = [];
    await prepareDeveloperWorkspace(
      job(),
      await options(),
      async (command, environment) => {
        commands.push({ command, environment });
      },
    );

    expect(commands).toHaveLength(2);
    expect(
      commands.every(
        ({ environment }) => environment.GH_CONFIG_DIR === "/secrets/github",
      ),
    ).toBe(true);
    expect(commands[1]!.command.at(-1)).toBe("chore/minisago-job-123");
  });

  test("never supplies the deployment socket as a writable directory", async () => {
    const workspace = await prepareDeveloperWorkspace(
      job(),
      {
        ...(await options()),
        deploySocketPath: "/run/sago-cloud/minisago-deploy.sock",
        deploySocketRepository: "sago-cream/mini-sago",
      },
      async () => undefined,
    );

    expect(workspace.environment.MINISAGO_DEPLOY_SOCKET).toBeUndefined();
    expect(workspace.sandboxWritePaths).toEqual([
      join(workspace.directory, ".git"),
      workspace.temporaryDirectory,
    ]);
  });

  test("hides the deployment socket from other repositories", async () => {
    const workspaceOptions = await options();
    workspaceOptions.githubRepositories.push("sago-cream/other");
    const workspace = await prepareDeveloperWorkspace(
      { ...job(), repository: "sago-cream/other" },
      {
        ...workspaceOptions,
        deploySocketPath: "/run/sago-cloud/minisago-deploy.sock",
        deploySocketRepository: "sago-cream/mini-sago",
      },
      async () => undefined,
    );

    expect(workspace.environment.MINISAGO_DEPLOY_SOCKET).toBeUndefined();
    expect(workspace.sandboxWritePaths).toEqual([
      join(workspace.directory, ".git"),
      workspace.temporaryDirectory,
    ]);
  });

  test("preserves and reuses a coding task workspace", async () => {
    const workspaceOptions = await options();
    const commands: string[][] = [];
    const taskJob = {
      ...job(),
      developerTask: { id: "task-456" },
    };
    const first = await prepareDeveloperWorkspace(
      taskJob,
      workspaceOptions,
      async (command) => {
        commands.push(command);
        if (command.slice(0, 3).join(" ") === "gh repo clone") {
          await mkdir(command[4]!, { recursive: true });
        }
      },
    );
    await first.cleanup();

    const resumed = await prepareDeveloperWorkspace(
      {
        ...taskJob,
        id: "turn-2",
        developerTask: {
          id: "task-456",
          resumeSessionId: "019-session",
        },
      },
      workspaceOptions,
      async (command) => {
        commands.push(command);
      },
    );

    expect(resumed.directory).toBe(first.directory);
    expect(commands).toHaveLength(3);
    expect(commands[2]).toContain("for-each-ref");
    expect(resumed.environment.MINISAGO_GIT_BRANCH).toBe(
      "chore/minisago-task-456",
    );
    await resumed.cleanup();
  });

  test("allows issue, PR, release, and workflow operations", async () => {
    const workspace = await prepareDeveloperWorkspace(
      job(),
      await options(),
      async () => undefined,
    );
    const gh = join(workspace.environment.PATH!.split(":")[0]!, "gh");
    const environment = {
      ...process.env,
      ...workspace.environment,
      MINISAGO_REAL_GH: "/bin/echo",
    };
    const draftPr = Bun.spawn([gh, "pr", "create", "--draft"], {
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await draftPr.exited).toBe(0);
    for (const args of [
      ["pr", "edit", "12"],
      ["pr", "ready", "12"],
      ["pr", "comment", "12"],
      ["pr", "review", "12", "--comment"],
      ["run", "rerun", "123", "--failed"],
      ["release", "list"],
      ["release", "view", "v1.0.0"],
      ["release", "download", "v1.0.0"],
      ["release", "create", "v1.0.0", "--draft"],
      ["release", "edit", "v1.0.0", "--draft=false"],
      ["release", "upload", "v1.0.0", "build.zip"],
      ["release", "delete", "v1.0.0", "--yes"],
      ["workflow", "list"],
      ["workflow", "view", "deploy.yml"],
      ["workflow", "run", "deploy.yml", "--ref", "main"],
      ["workflow", "enable", "deploy.yml"],
      ["workflow", "disable", "deploy.yml"],
    ]) {
      expect(
        await Bun.spawn([gh, ...args], {
          env: environment,
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ).toBe(0);
    }
    const allowed = Bun.spawn([gh, "issue", "comment", "12"], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await allowed.exited).toBe(0);
    expect(await new Response(allowed.stdout).text()).toContain(
      "issue comment 12",
    );
    const merge = Bun.spawn([gh, "pr", "merge", "12"], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await merge.exited).toBe(0);
    expect(await new Response(merge.stdout).text()).toContain("pr merge 12");
    const denied = Bun.spawn([gh, "pr", "merge", "12", "--admin"], {
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await denied.exited).toBe(77);
    const assignedAdmin = Bun.spawn([gh, "pr", "merge", "12", "--admin=true"], {
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await assignedAdmin.exited).toBe(77);
    for (const args of [
      ["repo", "delete"],
      ["secret", "set", "TOKEN"],
    ]) {
      expect(
        await Bun.spawn([gh, ...args], {
          env: environment,
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ).toBe(77);
    }
  });

  test("runs image uploads with internal authentication while guarding task commands", async () => {
    const settings = await options();
    const workspace = await prepareDeveloperWorkspace(
      job(),
      settings,
      async () => undefined,
    );
    const bin = workspace.environment.PATH!.split(":")[0]!;
    const realBin = join(settings.githubWorktreeRoot, "real-bin");
    await mkdir(realBin, { recursive: true });
    const realGh = join(realBin, "gh");
    const image = join(realBin, "gh-image");
    await Bun.write(
      realGh,
      '#!/bin/sh\n[ "$1 $2" = "auth token" ]\necho fixture-auth\n',
    );
    await Bun.write(
      image,
      '#!/bin/sh\nset -eu\n[ "$(gh auth token)" = "fixture-auth" ]\nprintf "%s\\n" "$@"\n',
    );
    await Promise.all([chmod(realGh, 0o700), chmod(image, 0o700)]);
    const environment = {
      ...process.env,
      ...workspace.environment,
      MINISAGO_REAL_GH: realGh,
      MINISAGO_GH_IMAGE: image,
    };
    for (const args of [
      ["image", "after.png", "--repo", "sago-cream/mini-sago"],
      [
        "image",
        "download",
        "https://github.com/user-attachments/assets/fixture",
        "--output",
        "after.png",
      ],
      ["image", "--help"],
      ["image", "--version"],
    ]) {
      expect(await localCommand([join(bin, "gh"), ...args], environment)).toBe(
        args.slice(1).join("\n"),
      );
    }
    for (const args of [
      ["auth", "token"],
      ["image", "extract-token"],
      ["image", "check-token"],
      ["image", "after.png", "--token", "secret"],
      ["image", "--token=secret", "after.png"],
      ["image", "after.png", "--", "pr", "create"],
      ["image", "after.png", "--", "pr", "merge", "42", "--admin"],
      ["extension", "install", "other/gh-extension"],
    ]) {
      expect(
        await Bun.spawn([join(bin, "gh"), ...args], {
          env: environment,
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ).toBe(77);
    }
    const missing = Bun.spawn([join(bin, "gh"), "image", "after.png"], {
      env: { ...environment, MINISAGO_GH_IMAGE: "" },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await missing.exited).toBe(127);
    expect(await new Response(missing.stderr).text()).toContain(
      "not installed",
    );
  });

  test("rejects a repository outside the worker advertisement", async () => {
    await expect(
      prepareDeveloperWorkspace(
        { ...job(), repository: "sago-cream/other" },
        await options(),
        async () => {
          throw new Error("command should not run");
        },
      ),
    ).rejects.toThrow("not available on this worker");
  });
});

test("retains dirty files and scratch files when a turn never produced a session", async () => {
  const opts = await options();
  const taskJob = { ...job(), developerTask: { id: "task-no-session" } };
  const first = await prepareDeveloperWorkspace(
    taskJob,
    opts,
    async (command) => {
      if (command[0] === "gh") await mkdir(command[4]!, { recursive: true });
    },
  );
  await Bun.write(join(first.directory, "uncommitted.txt"), "keep my work");
  await Bun.write(join(first.temporaryDirectory, "scratch"), "scratch");
  await first.cleanup();
  const second = await prepareDeveloperWorkspace(
    { ...taskJob, id: "turn-two" },
    opts,
    async (command) => {
      expect(command[3]).toBe("for-each-ref");
      return "";
    },
  );
  expect(await Bun.file(join(second.directory, "uncommitted.txt")).text()).toBe(
    "keep my work",
  );
  expect(
    await Bun.file(join(second.temporaryDirectory, "scratch")).text(),
  ).toBe("scratch");
  await expect(
    prepareDeveloperWorkspace({ ...job(), developerTask: { id: ".." } }, opts),
  ).rejects.toThrow("filesystem-safe");
});
