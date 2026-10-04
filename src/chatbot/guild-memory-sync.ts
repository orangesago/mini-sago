import type { DiscordRequest } from "../discord/api/request";
import type { GuildMemoryStore } from "./guild-memory";

/** Reconcile all joined guilds, independently of chatbot access rules. */
export async function backfillGuildMemory(
  discordRequest: DiscordRequest,
  memory: Pick<GuildMemoryStore, "ensure">,
) {
  const ensured: string[] = [];
  const failed: string[] = [];
  let after: string | undefined;
  while (true) {
    const query = new URLSearchParams({ limit: "200" });
    if (after) query.set("after", after);
    const guilds = await discordRequest<Array<{ id: string }>>(
      `/users/@me/guilds?${query}`,
    );
    for (const guild of guilds) {
      try {
        await memory.ensure(guild.id);
        ensured.push(guild.id);
      } catch {
        failed.push(guild.id);
      }
    }
    if (guilds.length < 200) break;
    const next = guilds.at(-1)!.id;
    if (next === after)
      throw new Error("Discord guild pagination did not advance.");
    after = next;
  }
  return { ensured, failed };
}
