import { randomBytes } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

export const GUILD_MEMORY_MAX_CHARACTERS = 4_000;
export const GUILD_MEMORY_MAX_ENTRY_CHARACTERS = 400;

const GUILD_ID_PATTERN = /^\d{17,20}$/u;
const ENTRY_ID_PATTERN = /^mem_[a-f0-9]{12}$/u;
const MESSAGE_ID_PATTERN = /^\d{17,20}$/u;
const INVISIBLE_UNICODE_PATTERN =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export type GuildMemoryEntry = {
  id: string;
  content: string;
  evidenceMessageIds: string[];
  updatedBy: string;
  updatedAt: string;
};

export type GuildMemorySnapshot = {
  revision: number;
  entries: GuildMemoryEntry[];
};

export type GuildMemoryMutation =
  | { action: "add"; content: string }
  | { action: "replace"; entryId: string; content: string }
  | { action: "remove"; entryId: string };

export type GuildMemoryMutationResult = GuildMemorySnapshot & {
  action: GuildMemoryMutation["action"];
  entryId: string;
};

type GuildMemoryStoreOptions = {
  now?: () => Date;
  createEntryId?: () => string;
};

function assertSnowflake(value: string, label: string) {
  if (!GUILD_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a Discord snowflake.`);
  }
}

function normalizedContent(value: string) {
  const content = value.replace(/\s+/gu, " ").trim();
  if (!content) throw new Error("Memory content cannot be blank.");
  if (content.length > GUILD_MEMORY_MAX_ENTRY_CHARACTERS) {
    throw new Error(
      `Memory entries are limited to ${GUILD_MEMORY_MAX_ENTRY_CHARACTERS} characters.`,
    );
  }
  if (INVISIBLE_UNICODE_PATTERN.test(content)) {
    throw new Error("Memory content contains invisible control characters.");
  }
  return content;
}

function renderSnapshot(
  guildId: string,
  snapshot: GuildMemorySnapshot,
  updatedAt: string,
) {
  const entries = snapshot.entries
    .map(
      (entry) =>
        `- [${entry.id}] ${entry.content}\n  <!-- evidence=${entry.evidenceMessageIds.join(",")}; updated_by=${entry.updatedBy}; updated_at=${entry.updatedAt} -->`,
    )
    .join("\n\n");
  return `# MiniSago server memory\n\n<!-- guild_id=${guildId}; revision=${snapshot.revision}; updated_at=${updatedAt} -->\n${entries ? `\n${entries}\n` : ""}`;
}

function parseSnapshot(guildId: string, value: string): GuildMemorySnapshot {
  const header = value.match(
    /^# MiniSago server memory\n\n<!-- guild_id=(\d{17,20}); revision=(\d+); updated_at=([^\s]+) -->\n/u,
  );
  if (!header || header[1] !== guildId) {
    throw new Error(`Invalid server memory file for guild ${guildId}.`);
  }

  const body = value.slice(header[0].length).trim();
  if (!body) return { revision: Number(header[2]), entries: [] };

  const entries = body.split("\n\n").map((section) => {
    const match = section.match(
      /^- \[(mem_[a-f0-9]{12})\] ([^\n]+)\n  <!-- evidence=([\d,]+); updated_by=(\d{17,20}); updated_at=([^\s]+) -->$/u,
    );
    if (!match) {
      throw new Error(
        `Invalid entry in server memory file for guild ${guildId}.`,
      );
    }
    const evidenceMessageIds = match[3]!.split(",");
    if (!evidenceMessageIds.every((id) => MESSAGE_ID_PATTERN.test(id))) {
      throw new Error(
        `Invalid evidence in server memory file for guild ${guildId}.`,
      );
    }
    return {
      id: match[1]!,
      content: normalizedContent(match[2]!),
      evidenceMessageIds,
      updatedBy: match[4]!,
      updatedAt: match[5]!,
    };
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error(
      `Duplicate entry ID in server memory file for guild ${guildId}.`,
    );
  }
  return { revision: Number(header[2]), entries };
}

async function runGit(directory: string, args: string[]) {
  const process = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || "Local Git failed.");
  }
  return stdout.trim();
}

export class GuildMemoryStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly createEntryId: () => string;

  constructor(
    readonly directory: string,
    options: GuildMemoryStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createEntryId =
      options.createEntryId ?? (() => `mem_${randomBytes(6).toString("hex")}`);
  }

  private path(guildId: string) {
    assertSnowflake(guildId, "Guild ID");
    return join(this.directory, `${guildId}.md`);
  }

  async load(guildId: string): Promise<GuildMemorySnapshot> {
    const path = this.path(guildId);
    try {
      return parseSnapshot(guildId, await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { revision: 0, entries: [] };
      }
      throw error;
    }
  }

  ensure(guildId: string): Promise<GuildMemorySnapshot> {
    assertSnowflake(guildId, "Guild ID");
    const operation = this.mutationQueue.then(() =>
      this.performEnsure(guildId),
    );
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performEnsure(guildId: string): Promise<GuildMemorySnapshot> {
    const path = this.path(guildId);
    try {
      return parseSnapshot(guildId, await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.ensureLocalRepository();
    const snapshot = { revision: 0, entries: [] };
    const temporaryPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(
      temporaryPath,
      renderSnapshot(guildId, snapshot, this.now().toISOString()),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    try {
      // Publish the complete file without replacing concurrently saved memory.
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.load(guildId);
    } finally {
      await unlink(temporaryPath);
    }
    await this.commitFile(path, `chore(memory): initialize ${guildId}`);
    return snapshot;
  }

  mutate(
    guildId: string,
    mutation: GuildMemoryMutation,
    evidenceMessageId: string,
    updatedBy: string,
  ): Promise<GuildMemoryMutationResult> {
    assertSnowflake(guildId, "Guild ID");
    assertSnowflake(evidenceMessageId, "Evidence message ID");
    assertSnowflake(updatedBy, "Updater ID");
    const operation = this.mutationQueue.then(() =>
      this.performMutation(guildId, mutation, evidenceMessageId, updatedBy),
    );
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performMutation(
    guildId: string,
    mutation: GuildMemoryMutation,
    evidenceMessageId: string,
    updatedBy: string,
  ): Promise<GuildMemoryMutationResult> {
    const previous = await this.load(guildId);
    const timestamp = this.now().toISOString();
    const entries = [...previous.entries];
    let entryId: string;

    if (mutation.action === "add") {
      const content = normalizedContent(mutation.content);
      const duplicate = entries.find((entry) => entry.content === content);
      if (duplicate) {
        return { ...previous, action: mutation.action, entryId: duplicate.id };
      }
      entryId = this.createEntryId();
      if (!ENTRY_ID_PATTERN.test(entryId)) {
        throw new Error("Generated memory entry ID is invalid.");
      }
      entries.push({
        id: entryId,
        content,
        evidenceMessageIds: [evidenceMessageId],
        updatedBy,
        updatedAt: timestamp,
      });
    } else {
      entryId = mutation.entryId;
      if (!ENTRY_ID_PATTERN.test(entryId)) {
        throw new Error("Memory entry ID is invalid.");
      }
      const index = entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) throw new Error(`Memory entry ${entryId} was not found.`);
      if (mutation.action === "remove") {
        entries.splice(index, 1);
      } else {
        const content = normalizedContent(mutation.content);
        const duplicate = entries.find(
          (entry, otherIndex) =>
            otherIndex !== index && entry.content === content,
        );
        if (duplicate) {
          throw new Error(`Memory already exists as ${duplicate.id}.`);
        }
        entries[index] = {
          ...entries[index]!,
          content,
          evidenceMessageIds: [
            ...new Set([
              ...entries[index]!.evidenceMessageIds,
              evidenceMessageId,
            ]),
          ].slice(-8),
          updatedBy,
          updatedAt: timestamp,
        };
      }
    }

    const snapshot = { revision: previous.revision + 1, entries };
    const rendered = renderSnapshot(guildId, snapshot, timestamp);
    if (rendered.length > GUILD_MEMORY_MAX_CHARACTERS) {
      throw new Error(
        `Server memory is full (${rendered.length}/${GUILD_MEMORY_MAX_CHARACTERS} characters). Replace, shorten, or remove an entry first.`,
      );
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.ensureLocalRepository();
    const path = this.path(guildId);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, rendered, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    await this.commit(
      path,
      mutation.action,
      entryId,
      updatedBy,
      evidenceMessageId,
    );
    return { ...snapshot, action: mutation.action, entryId };
  }

  private async ensureLocalRepository() {
    try {
      if (!(await stat(join(this.directory, ".git"))).isDirectory()) {
        throw new Error("Server memory .git path is not a directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await runGit(this.directory, ["init", "-q"]);
    }
    if (await runGit(this.directory, ["remote"])) {
      throw new Error("Server memory Git repository must not have a remote.");
    }
  }

  private async commit(
    path: string,
    action: GuildMemoryMutation["action"],
    entryId: string,
    updatedBy: string,
    evidenceMessageId: string,
  ) {
    await this.commitFile(
      path,
      `chore(memory): ${action} ${entryId}`,
      `updated_by=${updatedBy}\nevidence_message=${evidenceMessageId}`,
    );
  }

  private async commitFile(path: string, subject: string, body?: string) {
    const filename = basename(path);
    await runGit(this.directory, ["add", "--", filename]);
    await runGit(this.directory, [
      "-c",
      "user.name=MiniSago",
      "-c",
      "user.email=memory@minisago.local",
      "commit",
      "-q",
      "-m",
      subject,
      ...(body ? ["-m", body] : []),
      "--",
      filename,
    ]);
  }
}

let configuredStore: GuildMemoryStore | undefined;

export function getGuildMemoryStore() {
  configuredStore ??= new GuildMemoryStore(
    process.env.MINISAGO_GUILD_MEMORY_DIRECTORY?.trim() || ".data/guild-memory",
  );
  return configuredStore;
}
