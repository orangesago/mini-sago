import { getGuildMemoryStore } from "../src/chatbot/guild-memory";
import { backfillGuildMemory } from "../src/chatbot/guild-memory-sync";
import { createDiscordRequest } from "../src/discord/api/request";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
if (!token) throw new Error("DISCORD_BOT_TOKEN is required.");
const result = await backfillGuildMemory(
  createDiscordRequest(token),
  getGuildMemoryStore(),
);
console.log(JSON.stringify(result, null, 2));
if (result.failed.length) process.exitCode = 1;
