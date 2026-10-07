import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DiscordRequest } from "../discord/api/request";
import type { DiscordApplicationCommandInteraction } from "../discord/interactions";
import {
  calendarSchemas,
  createGoogleCalendarClient,
  type GoogleCalendarClient,
} from "./google-calendar";

import { getFeatureAvailabilityStore } from "../discord/feature-availability";
import { resolveDriveRequester } from "./drive-discord-access";

const draftSchema = z.object({
  id: z.string(),
  guildId: z.string(),
  calendarBinding: z.string().optional(),
  channelId: z.string(),
  requesterId: z.string(),
  messageId: z.string(),
  expires: z.number(),
  name: z.enum([
    "create_calendar_event",
    "edit_calendar_event",
    "delete_calendar_event",
  ]),
  input: z.record(z.string(), z.unknown()),
  preview: z.string(),
  result: z.string().optional(),
});
type Draft = z.infer<typeof draftSchema>;
type Context = {
  guildId?: string;
  channelId: string;
  requesterId: string;
  messageId: string;
};
const busy = new Set<string>();
const statePath = () =>
  process.env.DISCORD_CALENDAR_DRAFTS_FILE ||
  process.env.MINISAGO_CALENDAR_DRAFTS_FILE ||
  join(
    dirname(process.env.MINISAGO_REMINDER_STATE_FILE || ".data/reminders.json"),
    "calendar-drafts.json",
  );
function load(): Draft[] {
  try {
    return z
      .array(draftSchema)
      .parse(JSON.parse(readFileSync(statePath(), "utf8")))
      .filter((d) => d.expires > Date.now());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Calendar draft storage is unavailable.");
  }
}
function save(drafts: Draft[]) {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(drafts), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
function put(draft: Draft) {
  save([...load().filter((d) => d.id !== draft.id), draft]);
}
const safe = (value: unknown) =>
  String(value ?? "").replace(/([\\`*_~|<>])/g, "\\$1");
function scheduleText(start: string, end: string, allDay: boolean) {
  if (allDay) {
    const last = new Date(Date.parse(end) - 86400000)
      .toISOString()
      .slice(0, 10);
    return `${start}${start === last ? "" : ` → ${last}`}（全天）`;
  }
  const local = (time: string) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Taipei",
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(time));
  return `${local(start)} → ${local(end)}（台北時間）`;
}
function preview(
  name: Draft["name"],
  input: Record<string, any>,
  existing: Record<string, any> | undefined,
  config: GoogleCalendarClient["config"],
) {
  const time = input.schedule;
  const deleting = name === "delete_calendar_event";
  const hadOffice =
    existing?.attendees?.some(
      (a: any) =>
        a.email?.toLowerCase() === config.officeCalendarId.toLowerCase(),
    ) ?? false;
  const useOffice = input.useOffice ?? hadOffice;
  const people = (
    input.attendees ??
    existing?.attendees?.map((a: any) => a.email) ??
    []
  ).filter(
    (email: string) =>
      email.toLowerCase() !== config.officeCalendarId.toLowerCase(),
  );
  return [
    deleting
      ? "**確認刪除活動**"
      : name === "create_calendar_event"
        ? "**確認建立活動**"
        : "**確認修改活動**",
    `日曆：${safe(config.calendarName)}`,
    `會辦：${useOffice ? (deleting ? "取消會辦邀請" : "邀請會辦日曆；接受後才算預約成功") : hadOffice ? "取消會辦邀請；不使用" : "不使用"}`,
    `名稱：${safe(input.title ?? existing?.summary)}`,
    `時間：${
      time
        ? scheduleText(time.start, time.end, time.kind === "all_day")
        : scheduleText(
            existing?.start?.dateTime ?? existing?.start?.date,
            existing?.end?.dateTime ?? existing?.end?.date,
            Boolean(existing?.start?.date),
          )
    }`,
    `地點：${safe(input.location ?? existing?.location ?? "未指定")}`,
    `說明：${safe(input.description ?? existing?.description ?? "無")}`,
    `邀請對象：${people.map(safe).join("、") || "無"}`,
    deleting
      ? "確認後才會刪除此活動並通知上述邀請對象。取消不會更動日曆。此預覽 15 分鐘後失效。"
      : "確認後才會儲存並寄送邀請／更新通知。取消不會更動日曆。此預覽 15 分鐘後失效。",
  ].join("\n");
}

export function withCalendarConfirmation(
  client: GoogleCalendarClient,
  context: Context,
  discord: DiscordRequest,
  allowed: () => Promise<boolean> = async () =>
    getFeatureAvailabilityStore().isEnabled("calendar", context),
): GoogleCalendarClient {
  return {
    config: client.config,
    async call(name, raw) {
      if (context.guildId !== client.config.guildId || !(await allowed()))
        return {
          status: "unavailable",
          error: "Calendar access is unavailable here.",
        };
      if (name === "list_calendar_events" || name === "get_calendar_event")
        return client.call(name, raw);
      try {
        const input = calendarSchemas[name].parse(raw);
        const calendarBinding = createHash("sha256")
          .update(JSON.stringify(client.config))
          .digest("hex");
        const id = createHash("sha256")
          .update(JSON.stringify([context, calendarBinding, name, input]))
          .digest("hex")
          .slice(0, 40);
        const old = load().find((d) => d.id === id);
        if (old)
          return {
            status: old.result ? "complete" : "awaiting_confirmation",
            detail:
              old.result ||
              "A confirmation preview was already posted. Ask the requester to click its button.",
          };
        let existing: Record<string, any> | undefined;
        if (
          name === "edit_calendar_event" ||
          name === "delete_calendar_event"
        ) {
          const found = await client.call("get_calendar_event", {
            eventId: (input as any).eventId,
          });
          if (found.status !== "complete") return found;
          existing = found.event as Record<string, any>;
          if (existing.attendeeCount > 50)
            return {
              status: "unavailable",
              error:
                "This event has too many guests to preview safely. Edit it in Google Calendar.",
            };
          if (existing.etag !== (input as any).etag)
            return {
              status: "unavailable",
              error:
                "The event changed. Read it again before preparing an edit.",
            };
        }
        if (existing?.recurrence || existing?.status === "cancelled")
          return {
            status: "unavailable",
            error:
              "Select a current single event or recurring occurrence; whole-series changes are unsupported.",
          };
        const content = preview(name, input, existing, client.config);
        if (content.length > 1800)
          return {
            status: "unavailable",
            error:
              "The booking preview is too long. Shorten the description or reduce the guest list.",
          };
        const draft: Draft = {
          id,
          ...context,
          guildId: client.config.guildId,
          calendarBinding,
          name,
          input,
          preview: content,
          expires: Date.now() + 15 * 60000,
        };
        const drafts = load();
        if (
          drafts.filter(
            (d) => d.requesterId === context.requesterId && !d.result,
          ).length >= 10
        )
          return {
            status: "unavailable",
            error:
              "Too many pending previews. Confirm or cancel an existing preview first.",
          };
        put(draft);
        try {
          await discord(`/channels/${context.channelId}/messages`, {
            method: "POST",
            body: {
              content,
              allowed_mentions: { parse: [] },
              components: [
                {
                  type: 1,
                  components: [
                    {
                      type: 2,
                      style: name === "delete_calendar_event" ? 4 : 3,
                      label:
                        name === "delete_calendar_event" ? "確認刪除" : "確認",
                      custom_id: `calendar:confirm:${id}`,
                    },
                    {
                      type: 2,
                      style: 2,
                      label: "取消",
                      custom_id: `calendar:cancel:${id}`,
                    },
                  ],
                },
              ],
            },
          });
        } catch {
          save(load().filter((d) => d.id !== id));
          return {
            status: "unavailable",
            error:
              "Could not post the confirmation preview. No calendar changes were made.",
          };
        }
        return {
          status: "awaiting_confirmation",
          detail:
            "Preview posted. Tell the requester to review the exact details and click Confirm or Cancel. No calendar changes or invitations have been made.",
        };
      } catch {
        return {
          status: "unavailable",
          error:
            "Could not prepare the booking preview. Check the inputs and try again.",
        };
      }
    },
  };
}

export async function handleCalendarConfirmation(
  interaction: DiscordApplicationCommandInteraction,
  discord: DiscordRequest,
  env: Record<string, string | undefined> = process.env,
  makeClient = createGoogleCalendarClient,
) {
  const match =
    interaction.type === 3
      ? /^calendar:(confirm|cancel):([a-f0-9]{40})$/.exec(
          interaction.data?.custom_id || "",
        )
      : null;
  if (!match) return false;
  const respond = (content: string) =>
    discord(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      authenticated: false,
      body: {
        type: 4,
        data: { content, flags: 64, allowed_mentions: { parse: [] } },
      },
    });
  let draft: Draft | undefined;
  try {
    draft = load().find((d) => d.id === match[2]);
  } catch {
    await respond("活動確認暫時無法使用，請稍後再試。");
    return true;
  }
  const requester = interaction.member?.user?.id ?? interaction.user?.id;
  if (
    !draft ||
    draft.guildId !== interaction.guild_id ||
    draft.channelId !== interaction.channel_id ||
    draft.requesterId !== requester
  ) {
    await respond(
      "只有原本提出活動的人能確認，且預覽必須尚未過期。請重新提出活動。",
    );
    return true;
  }
  if (draft.result) {
    await respond(draft.result);
    return true;
  }
  if (busy.has(draft.id)) {
    await respond("正在處理這筆活動，請稍候。");
    return true;
  }
  if (match[1] === "cancel") {
    draft.result = "已取消這筆活動草稿，日曆未更動。";
    put(draft);
    await discord(
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      {
        method: "POST",
        authenticated: false,
        body: {
          type: 7,
          data: {
            content: draft.result,
            components: [],
            allowed_mentions: { parse: [] },
          },
        },
      },
    );
    return true;
  }
  busy.add(draft.id);
  try {
    await discord(
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { method: "POST", authenticated: false, body: { type: 6 } },
    );
    const client = makeClient(env, {
      guildId: draft.guildId,
      channelId: draft.channelId,
      roleIds: interaction.member?.roles,
      messageId: draft.messageId,
      resolveRoleIds: async () =>
        (
          await resolveDriveRequester(
            { guildId: draft.guildId, requesterId: draft.requesterId },
            discord,
          )
        ).roleIds,
    });
    const currentBinding = client
      ? createHash("sha256").update(JSON.stringify(client.config)).digest("hex")
      : undefined;
    const result =
      client && draft.calendarBinding === currentBinding
        ? await client.call(draft.name, draft.input)
        : {
            status: "unavailable",
            error:
              "Calendar access or configuration changed; prepare a new preview.",
          };
    const complete = result.status === "complete";
    const event = result.event as { htmlLink?: string } | undefined;
    const office = result.officeReservation;
    const officeText =
      office === "accepted"
        ? "會辦已接受邀請，預約成功。"
        : office === "declined"
          ? "會辦已拒絕邀請，未預約成功；請選擇其他時間或地點。"
          : office === "pending"
            ? "已邀請會辦，但尚未接受，不能視為預約成功。"
            : "";
    const content = complete
      ? draft.name === "delete_calendar_event"
        ? "已刪除活動，並要求 Google 寄送取消通知。"
        : `已${draft.name === "create_calendar_event" ? "建立" : "更新"}活動（日曆：${safe(client!.config.calendarName)}）。${officeText}${event?.htmlLink ? `\n${event.htmlLink}` : ""}`
      : `活動操作尚未完成。${safe(result.error ?? "請稍後重試；如活動或設定已變更，請重新讀取並確認。")}`;
    if (complete) {
      draft.result = content;
      put(draft);
    }
    await discord(
      `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
      {
        method: "PATCH",
        authenticated: false,
        body: {
          content: complete ? content : `${draft.preview}\n\n${content}`,
          ...(complete ? { components: [] } : {}),
          allowed_mentions: { parse: [] },
        },
      },
    );
  } finally {
    busy.delete(draft.id);
  }
  return true;
}
