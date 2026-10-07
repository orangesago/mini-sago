import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleCalendarConfirmation,
  withCalendarConfirmation,
} from "./calendar-confirmation";
import {
  CALENDAR_GUILD_ID,
  createGoogleCalendarClient,
  type GoogleCalendarClient,
} from "./google-calendar";
import type { DiscordRequest } from "../discord/api/request";

import { calendarSettings } from "./calendar-settings";
const config = calendarSettings({
  DISCORD_CALENDAR_ID: "events_test@group.calendar.google.com",
})!;
const original = process.env.MINISAGO_CALENDAR_DRAFTS_FILE;
const dirs: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.MINISAGO_CALENDAR_DRAFTS_FILE;
  else process.env.MINISAGO_CALENDAR_DRAFTS_FILE = original;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "calendar-confirmation-"));
  dirs.push(dir);
  const path = join(dir, "drafts.json");
  process.env.MINISAGO_CALENDAR_DRAFTS_FILE = path;
  const mutations: unknown[] = [];
  const messages: { path: string; body: any }[] = [];
  const client: GoogleCalendarClient = {
    config,
    call: async (name, input) => {
      if (name === "get_calendar_event")
        return {
          status: "complete",
          event: {
            id: "event1",
            etag: "version1",
            summary: "Before",
            start: { date: "2026-09-21" },
            end: { date: "2026-09-22" },
            attendees: [{ email: "existing@example.com" }],
          },
        };
      mutations.push({ name, input });
      return {
        status: "complete",
        event: {
          id: "event1",
          htmlLink: "https://calendar.google.com/event?eid=test",
        },
      };
    },
  };
  const discord = (async (path, options) => {
    messages.push({ path, body: options?.body });
    return {};
  }) as DiscordRequest;
  const context = {
    guildId: CALENDAR_GUILD_ID,
    channelId: "channel1",
    requesterId: "requester1",
    messageId: "origin1",
  };
  const wrapped = withCalendarConfirmation(client, context, discord);
  const button = (
    action = "confirm",
    user = "requester1",
    guild = CALENDAR_GUILD_ID,
  ) => ({
    type: 3,
    id: "click1",
    application_id: "app1",
    token: "interaction-token",
    guild_id: guild,
    channel_id: "channel1",
    member: { user: { id: user } },
    data: {
      custom_id: `calendar:${action}:${JSON.parse(readFileSync(path, "utf8"))[0].id}`,
    },
  });
  return {
    client,
    discord,
    context,
    wrapped,
    button,
    mutations,
    messages,
    path,
  };
}
const booking = {
  title: "Meeting",
  operationKey: "meeting",
  attendees: ["guest@example.com"],
  schedule: {
    kind: "timed",
    start: "2026-09-21T15:00:00+08:00",
    end: "2026-09-21T16:00:00+08:00",
  },
};

test("only the requester can confirm the immutable preview; repeated clicks do not repeat mutations", async () => {
  const f = fixture();
  expect((await f.wrapped.call("create_calendar_event", booking)).status).toBe(
    "awaiting_confirmation",
  );
  expect(f.mutations).toHaveLength(0);
  expect(f.messages[0].body.content).toContain("guest@example.com");
  expect(f.messages[0].body.content).toContain("2026-09-21 15:00");
  await f.wrapped.call("create_calendar_event", booking);
  expect(f.messages).toHaveLength(1);
  await handleCalendarConfirmation(
    f.button("confirm", "someone-else"),
    f.discord,
    {},
    () => f.client,
  );
  await handleCalendarConfirmation(
    f.button("confirm", "requester1", "another-guild"),
    f.discord,
    {},
    () => f.client,
  );
  expect(f.mutations).toHaveLength(0);
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toEqual([
    { name: "create_calendar_event", input: booking },
  ]);
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toHaveLength(1);
  expect(f.messages.at(-2)?.body.components).toEqual([]);
});

test("cancelled and expired drafts cannot create events", async () => {
  const f = fixture();
  await f.wrapped.call("create_calendar_event", booking);
  await handleCalendarConfirmation(
    f.button("cancel"),
    f.discord,
    {},
    () => f.client,
  );
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toHaveLength(0);
  const drafts = JSON.parse(readFileSync(f.path, "utf8"));
  drafts[0].expires = Date.now() - 1;
  delete drafts[0].result;
  writeFileSync(f.path, JSON.stringify(drafts));
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toHaveLength(0);
});

test("edit preview preserves omitted fields and attendees and rejects a stale preview etag", async () => {
  const f = fixture();
  const input = { eventId: "event1", etag: "version1", title: "After" };
  await f.wrapped.call("edit_calendar_event", input);
  expect(f.messages[0].body.content).toContain("existing@example.com");
  expect(f.messages[0].body.content).toContain("2026-09-21");
  expect(f.mutations).toHaveLength(0);
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toEqual([{ name: "edit_calendar_event", input }]);
  expect(
    (await f.wrapped.call("edit_calendar_event", { ...input, etag: "stale" }))
      .status,
  ).toBe("unavailable");
});

test("a failed Google request can be retried with the original operation key", async () => {
  const f = fixture();
  await f.wrapped.call("create_calendar_event", booking);
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => ({
    config,
    call: async () => ({ status: "unavailable" }),
  }));
  expect(JSON.parse(readFileSync(f.path, "utf8"))[0].result).toBeUndefined();
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toEqual([
    { name: "create_calendar_event", input: booking },
  ]);
});

test("concurrent confirmation clicks issue only one calendar write", async () => {
  const f = fixture();
  await f.wrapped.call("create_calendar_event", booking);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let writes = 0;
  const slowClient: GoogleCalendarClient = {
    config,
    call: async () => {
      writes++;
      await pending;
      return { status: "complete" };
    },
  };
  const first = handleCalendarConfirmation(
    f.button(),
    f.discord,
    {},
    () => slowClient,
  );
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => slowClient);
  finish();
  await first;
  expect(writes).toBe(1);
});

test("foreign contexts and oversized previews cannot publish actionable drafts", async () => {
  const f = fixture();
  const foreign = withCalendarConfirmation(
    f.client,
    { ...f.context, guildId: "other" },
    f.discord,
  );
  expect((await foreign.call("create_calendar_event", booking)).status).toBe(
    "unavailable",
  );
  expect(
    (
      await f.wrapped.call("create_calendar_event", {
        ...booking,
        description: "x".repeat(1800),
      })
    ).status,
  ).toBe("unavailable");
  expect(f.messages).toHaveLength(0);
  expect(f.mutations).toHaveLength(0);
});

test("deletion previews the exact event and notifies only after requester confirmation", async () => {
  const f = fixture();
  const input = { eventId: "event1", etag: "version1" };
  expect((await f.wrapped.call("delete_calendar_event", input)).status).toBe(
    "awaiting_confirmation",
  );
  expect(f.mutations).toHaveLength(0);
  expect(f.messages[0].body.content).toContain("確認刪除活動");
  expect(f.messages[0].body.content).toContain("discord-calendar");
  expect(f.messages[0].body.content).toContain("existing@example.com");
  expect(f.messages[0].body.components[0].components[0].style).toBe(4);
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toEqual([{ name: "delete_calendar_event", input }]);
});

test("office preview distinguishes requesting the room from an accepted reservation", async () => {
  const f = fixture();
  await f.wrapped.call("create_calendar_event", {
    ...booking,
    useOffice: true,
  });
  expect(f.messages[0].body.content).toContain(
    "邀請會辦日曆；接受後才算預約成功",
  );
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => ({
    ...f.client,
    call: async () => ({ status: "complete", officeReservation: "pending" }),
  }));
  expect(f.messages.at(-1)?.body.content).toContain("不能視為預約成功");
});

test("configuration changes and legacy drafts cannot be confirmed against another calendar", async () => {
  const f = fixture();
  await f.wrapped.call("create_calendar_event", booking);
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => ({
    ...f.client,
    config: { ...config, calendarId: "changed@group.calendar.google.com" },
  }));
  expect(f.mutations).toHaveLength(0);
  const drafts = JSON.parse(readFileSync(f.path, "utf8"));
  delete drafts[0].calendarBinding;
  writeFileSync(f.path, JSON.stringify(drafts));
  await handleCalendarConfirmation(f.button(), f.discord, {}, () => f.client);
  expect(f.mutations).toHaveLength(0);
});

test("raw calendar recipients cannot publish a preview and moving away explicitly cancels office use", async () => {
  const f = fixture();
  expect(
    (
      await f.wrapped.call("create_calendar_event", {
        ...booking,
        attendees: [config.officeCalendarId],
      })
    ).status,
  ).toBe("unavailable");
  expect(f.messages).toHaveLength(0);
  f.client.call = async () => ({
    status: "complete",
    event: {
      id: "event1",
      etag: "version1",
      summary: "Office meeting",
      start: { date: "2026-09-21" },
      end: { date: "2026-09-22" },
      attendees: [
        { email: config.officeCalendarId },
        { email: "guest@example.com" },
      ],
    },
  });
  expect(
    (
      await f.wrapped.call("edit_calendar_event", {
        eventId: "event1",
        etag: "version1",
        location: "Online",
        useOffice: false,
      })
    ).status,
  ).toBe("awaiting_confirmation");
  expect(f.messages[0].body.content).toContain("取消會辦邀請；不使用");
  expect(f.messages[0].body.content).toContain("guest@example.com");
  expect(f.messages[0].body.content).not.toContain(config.officeCalendarId);
  expect(f.mutations).toHaveLength(0);
});

test("revoked access cannot post a new confirmation preview", async () => {
  const f = fixture();
  const wrapped = withCalendarConfirmation(
    f.client,
    f.context,
    f.discord,
    async () => false,
  );
  const result = await wrapped.call("create_calendar_event", {
    title: "Denied",
    operationKey: "denied",
    schedule: { kind: "all_day", start: "2026-10-18", end: "2026-10-19" },
  });
  expect(result.status).toBe("unavailable");
  expect(f.mutations).toHaveLength(0);
  expect(f.messages).toHaveLength(0);
});

test("losing the allowed role after a preview prevents confirmation from reaching Google", async () => {
  const f = fixture();
  const guildId = "1394943277836402779";
  const client = { ...f.client, config: { ...f.client.config, guildId } };
  const wrapped = withCalendarConfirmation(
    client,
    { ...f.context, guildId },
    f.discord,
    async () => true,
  );
  expect((await wrapped.call("create_calendar_event", booking)).status).toBe(
    "awaiting_confirmation",
  );
  let calls = 0;
  const request = (async () => {
    calls++;
    throw new Error("Google must not be contacted");
  }) as unknown as typeof fetch;
  const oauthEnv = {
    DISCORD_CALENDAR_ID: config.calendarId,
    DISCORD_CALENDAR_OAUTH_JSON: JSON.stringify({
      client_id: "test.apps.googleusercontent.com",
      client_secret: "test",
      refresh_token: "test",
    }),
  };
  await handleCalendarConfirmation(
    {
      ...f.button("confirm", "requester1", guildId),
      member: { user: { id: "requester1" }, roles: [] },
    },
    f.discord,
    oauthEnv,
    (env, context) => createGoogleCalendarClient(env, context, request),
  );
  expect(calls).toBe(0);
  expect(f.mutations).toHaveLength(0);
  expect(f.messages.at(-1)?.body.content).toContain("活動操作尚未完成");
});
