import { access, chmod, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import type { OracleAnswerJob } from "../../contracts/worker-contract";

type DeveloperWorkspaceOptions = {
  githubConfigDir: string;
  githubRepositories: string[];
  githubWorktreeRoot: string;
  deploySocketPath?: string;
  deploySocketRepository?: string;
  signal?: AbortSignal;
};

export type DeveloperWorkspace = {
  directory: string;
  temporaryDirectory: string;
  attachmentsDirectory: string;
  environment: Record<string, string>;
  sandboxReadPaths: string[];
  sandboxWritePaths: string[];
  cleanup: () => Promise<void>;
};

const GH_WRAPPER = `#!/bin/sh
set -eu

deny() {
  echo "MiniSago denied this GitHub operation." >&2
  exit 77
}

command="\${1:-}"
subcommand="\${2:-}"
case "$command:$subcommand" in
  api:*)
    [ "$subcommand" != "graphql" ] || deny
    for argument in "$@"; do
      case "$argument" in
        -X|--method|-X*|--method=*|-f|-f*|--raw-field|--raw-field=*|-F|-F*|--field|--field=*|--input|--input=*) deny ;;
      esac
    done
    ;;
  issue:create|issue:edit|issue:close|issue:reopen|issue:comment|pr:edit|pr:ready|pr:review|pr:comment|run:rerun)
    ;;
  pr:create)
    draft=false
    for argument in "$@"; do
      [ "$argument" = "--draft" ] && draft=true
    done
    [ "$draft" = true ] || deny
    ;;
  pr:merge)
    for argument in "$@"; do
      case "$argument" in
        --admin|--admin=*) deny ;;
      esac
    done
    ;;
  repo:create|repo:delete|repo:archive|repo:edit|repo:fork|release:*|workflow:run|run:cancel|run:delete|secret:*|variable:*)
    deny
    ;;
  auth:status|repo:view|repo:clone|repo:list|pr:view|pr:list|pr:checks|pr:diff|pr:status|issue:view|issue:list|issue:status|run:view|run:list|run:watch|workflow:view|workflow:list|release:view|release:list|release:download|search:*|status:*|help:*|version:*)
    ;;
  *)
    deny
    ;;
esac

exec "$MINISAGO_REAL_GH" "$@"
`;

const GIT_WRAPPER = `#!/bin/sh
set -eu

if [ "\${1:-}" = "push" ]; then
  branch="$("$MINISAGO_REAL_GIT" branch --show-current)"
  [ "$branch" = "$MINISAGO_GIT_BRANCH" ] || {
    echo "MiniSago denied git push from an unprepared branch." >&2
    exit 77
  }
  for argument in "$@"; do
    case "$argument" in
      --force|--force-with-lease|-f|main|master|HEAD:main|HEAD:master)
        echo "MiniSago denied a protected or force push." >&2
        exit 77
        ;;
    esac
  done
fi

exec "$MINISAGO_REAL_GIT" "$@"
`;

function safeJobId(jobId: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(jobId)) {
    throw new Error("Developer job ID is not filesystem-safe.");
  }
  return jobId;
}

export function developerBranchName(workspaceId: string) {
  const slug = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  const suffix =
    slug === workspaceId
      ? slug
      : `${slug || "task"}-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 12)}`;
  return `chore/minisago-${suffix}`;
}

function selectedRepository(job: OracleAnswerJob, repositories: string[]) {
  const repository = repositories.find(
    (candidate) =>
      candidate.toLocaleLowerCase("en-US") ===
      job.repository.toLocaleLowerCase("en-US"),
  );
  if (!repository) {
    throw new Error("The selected repository is not available on this worker.");
  }
  return repository;
}

type RunCommand = (
  command: string[],
  environment: Record<string, string>,
  signal?: AbortSignal,
) => Promise<string | void>;

async function run(
  command: string[],
  environment: Record<string, string>,
  signal?: AbortSignal,
) {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });
  const stop = () => child.kill();
  signal?.addEventListener("abort", stop, { once: true });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.removeEventListener("abort", stop);
  if (signal?.aborted) {
    throw new Error("Repository preparation was cancelled.");
  }
  if (exitCode !== 0) {
    throw new Error(
      stderr.trim().split("\n").at(-1) ||
        `Repository preparation exited with status ${exitCode}.`,
    );
  }
  return stdout;
}

export async function prepareDeveloperWorkspace(
  job: OracleAnswerJob,
  options: DeveloperWorkspaceOptions,
  runCommand: RunCommand = run,
): Promise<DeveloperWorkspace> {
  const repository = selectedRepository(job, options.githubRepositories);
  const workspaceId = job.developerTask?.id ?? job.id;
  const jobRoot = resolve(options.githubWorktreeRoot, safeJobId(workspaceId));
  const directory = join(jobRoot, ...repository.split("/"));
  const binDirectory = join(jobRoot, "bin");
  const branch = developerBranchName(workspaceId);
  const preparationEnvironment = {
    GH_CONFIG_DIR: options.githubConfigDir,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  // A task owns its checkout even when initialization never produced a session ID.
  const exists = await access(directory).then(
    () => true,
    () => false,
  );
  const resume = Boolean(job.developerTask?.resumeSessionId) || exists;
  if (job.developerTask?.resumeSessionId && !exists) {
    throw new Error(
      "The preserved coding workspace is unavailable on this worker.",
    );
  }
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = join(jobRoot, "tmp");
  const attachmentsDirectory = join(jobRoot, "attachments");
  await Promise.all(
    [temporaryDirectory, attachmentsDirectory, binDirectory].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  if (!resume) {
    await runCommand(
      [
        "gh",
        "repo",
        "clone",
        repository,
        directory,
        "--",
        "--filter=blob:none",
      ],
      preparationEnvironment,
      options.signal,
    );
    await runCommand(
      ["git", "-C", directory, "switch", "-c", branch],
      preparationEnvironment,
      options.signal,
    );
  } else {
    const legacyBranch = `minisago/${workspaceId}`;
    const legacyRef = `refs/heads/${legacyBranch}`;
    const refs = await runCommand(
      [
        "git",
        "-C",
        directory,
        "for-each-ref",
        "--format=%(refname)",
        legacyRef,
      ],
      preparationEnvironment,
      options.signal,
    );
    if (refs?.trim().split("\n").includes(legacyRef)) {
      // Rename without checkout/reset so staged and uncommitted work survives.
      // Git refuses to overwrite an existing destination branch.
      await runCommand(
        ["git", "-C", directory, "branch", "-m", legacyBranch, branch],
        preparationEnvironment,
        options.signal,
      );
    }
  }
  // Refresh policy on continuation after a worker upgrade.
  const ghWrapper = join(binDirectory, "gh");
  const gitWrapper = join(binDirectory, "git");
  await Promise.all([
    Bun.write(ghWrapper, GH_WRAPPER),
    Bun.write(gitWrapper, GIT_WRAPPER),
  ]);
  await Promise.all([chmod(ghWrapper, 0o700), chmod(gitWrapper, 0o700)]);

  const environment = {
    ...preparationEnvironment,
    MINISAGO_GIT_BRANCH: branch,
    MINISAGO_REAL_GH: Bun.which("gh") || "/usr/bin/gh",
    MINISAGO_REAL_GIT: Bun.which("git") || "/usr/bin/git",
    PATH: `${binDirectory}:${process.env.PATH || "/usr/bin:/bin"}`,
  };

  return {
    directory,
    temporaryDirectory,
    attachmentsDirectory,
    environment,
    sandboxReadPaths: [
      binDirectory,
      resolve(options.githubConfigDir),
      attachmentsDirectory,
    ],
    sandboxWritePaths: [resolve(directory, ".git"), temporaryDirectory],
    // Persistent tasks are explicitly retained; an idle timer must never erase dirty work.
    cleanup: job.developerTask
      ? () => Promise.resolve()
      : () => rm(jobRoot, { recursive: true, force: true }),
  };
}
