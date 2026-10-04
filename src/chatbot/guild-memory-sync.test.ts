import { describe, expect, test } from "bun:test";
import type { DiscordRequest } from "../discord/api/request";
import { backfillGuildMemory } from "./guild-memory-sync";

describe("guild memory backfill", () => {
  test("paginates every joined guild and continues after an individual failure", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: String(917436845187563610n + BigInt(index)),
    }));
    const lastGuild = "1282936453134815275";
    const paths: string[] = [];
    const request: DiscordRequest = async <T>(path: string) => {
      paths.push(path);
      return (paths.length === 1 ? firstPage : [{ id: lastGuild }]) as T;
    };
    const visited: string[] = [];
    const result = await backfillGuildMemory(request, {
      ensure: async (guildId) => {
        visited.push(guildId);
        if (guildId === firstPage[0]!.id) throw new Error("Unreadable memory");
        return { revision: 0, entries: [] };
      },
    });
    expect(paths).toEqual([
      "/users/@me/guilds?limit=200",
      `/users/@me/guilds?limit=200&after=${firstPage.at(-1)!.id}`,
    ]);
    expect(visited).toEqual([...firstPage.map(({ id }) => id), lastGuild]);
    expect(result.failed).toEqual([firstPage[0]!.id]);
    expect(result.ensured).toHaveLength(200);
    expect(result.ensured.at(-1)).toBe(lastGuild);
  });

  test("fails when the guild inventory cannot be fetched", async () => {
    await expect(
      backfillGuildMemory(
        async () => {
          throw new Error("Discord unavailable");
        },
        { ensure: async () => ({ revision: 0, entries: [] }) },
      ),
    ).rejects.toThrow("Discord unavailable");
  });
});
