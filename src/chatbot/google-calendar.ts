import { createHash, createPrivateKey, sign } from "node:crypto";
import { z } from "zod";

import {
  getFeatureAvailabilityStore,
  type FeatureAvailabilityStore,
  type FeatureContext,
} from "../discord/feature-availability";
import { calendarSettings } from "./calendar-settings";
export {
  CALENDAR_GUILD_ID,
  CALENDAR_USER_ACCOUNT,
  OFFICE_CALENDAR_ID as CALENDAR_ID,
} from "./calendar-settings";
export const CALENDAR_SERVICE_ACCOUNT =
  "discord-calendar@nthusa-discord-calendar.iam.gserviceaccount.com";
const oauthSchema = z.object({
  client_id: z.string().endsWith(".apps.googleusercontent.com"),
  client_secret: z.string().min(1),
  refresh_token: z.string().min(1),
});
const timezone = "Asia/Taipei";
const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.literal(CALENDAR_SERVICE_ACCOUNT),
  private_key_id: z.string().min(1),
  private_key: z.string().min(1),
});
const timestamp = z.iso.datetime({ offset: true });
const date = z.iso.date();
const eventId = z.string().regex(/^[a-zA-Z0-9_-]{5,1024}$/u);
const schedule = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("timed"), start: timestamp, end: timestamp })
      .strict(),
    z.object({ kind: z.literal("all_day"), start: date, end: date }).strict(),
  ])
  .refine((value) => Date.parse(value.end) > Date.parse(value.start), {
    message: "End must be after start; all-day end dates are exclusive.",
  });
const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8000),
  location: z.string().max(1000),
  schedule,
  attendees: z
    .array(
      z
        .email()
        .max(254)
        .refine(
          (email) =>
            !email.toLowerCase().endsWith("@group.calendar.google.com"),
          "Use useOffice for the office invitation, not a calendar ID in attendees.",
        ),
    )
    .max(50)
    .refine(
      (values) =>
        new Set(values.map((v) => v.toLowerCase())).size === values.length,
      "Remove duplicate email addresses.",
    ),
};
export const calendarSchemas = {
  list_calendar_events: z
    .object({
      calendar: z.enum(["events", "office"]).optional(),
      start: timestamp,
      end: timestamp,
      query: z.string().trim().min(1).max(200).optional(),
      pageToken: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(50).default(25),
    })
    .strict()
    .refine(
      ({ start, end }) => {
        const duration = Date.parse(end) - Date.parse(start);
        return duration > 0 && duration <= 366 * 86400000;
      },
      { message: "Use a positive date range of at most 366 days." },
    ),
  get_calendar_event: z
    .object({ eventId, calendar: z.enum(["events", "office"]).optional() })
    .strict(),
  delete_calendar_event: z
    .object({ eventId, etag: z.string().min(1).max(256) })
    .strict(),
  create_calendar_event: z
    .object({
      ...fields,
      useOffice: z.boolean().optional(),
      attendees: fields.attendees.optional(),
      description: fields.description.optional(),
      location: fields.location.optional(),
      operationKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    })
    .strict(),
  edit_calendar_event: z
    .object({
      eventId,
      etag: z.string().min(1).max(256),
      useOffice: z.boolean().optional(),
      title: fields.title.optional(),
      description: fields.description.optional(),
      location: fields.location.optional(),
      schedule: fields.schedule.optional(),
      attendees: fields.attendees.optional(),
    })
    .strict()
    .refine(
      (input) =>
        [
          input.useOffice,
          input.title,
          input.description,
          input.location,
          input.schedule,
          input.attendees,
        ].some((value) => value !== undefined),
      { message: "Provide at least one changed field." },
    ),
};
export type CalendarToolName = keyof typeof calendarSchemas;
export const calendarDescriptions: Record<CalendarToolName, string> = {
  list_calendar_events:
    "Read a bounded time range from calendar=events (the dedicated discord-calendar) or calendar=office (學生會辦空間登記, read-only). For office availability questions explicitly select office. Times require UTC offsets; local timezone is Asia/Taipei. Follow nextPageToken.",
  get_calendar_event:
    "Read an event and its etag from events or office. Only the dedicated events calendar supports edits/deletion. The office calendar is read-only. Check officeReservation before claiming an office booking is accepted.",
  create_calendar_event:
    "Prepare an event in the dedicated discord-calendar, for the requester to Confirm/Cancel before saving or invitations. Set useOffice=true only when the user explicitly wants the office; this invites the office calendar after checking conflicts and never writes it directly. Other locations leave useOffice false. Resolve named guests with lookup_calendar_contacts; ask the user to choose ambiguous matches, never guess emails. Include only selected/supplied people in attendees, never calendar IDs. Use timed RFC3339 timestamps or all_day dates with exclusive end. Reuse operationKey unchanged for retries. Event creation and office acceptance are separate: never call the office booked unless officeReservation is accepted.",
  edit_calendar_event:
    "Prepare an edit on the dedicated events calendar after reading its latest etag. Requester confirmation is required. Office events cannot be edited directly. useOffice=true requests the office, false removes the office invitation; omitted preserves it. Changing location away from the office should explicitly remove its invitation after confirming intent. attendees replaces people, while omitted preserves them; office invitation is controlled separately by useOffice. Resolve names using lookup_calendar_contacts, never guess emails. Recurring instances are supported, whole-series edits are not.",
  delete_calendar_event:
    "Prepare cancellation of one event in the dedicated events calendar using its latest etag. The requester must click Confirm before deletion and cancellation notices to guests or the office. Never delete directly from the office calendar. Whole recurring-series deletion is unsupported; choose the intended occurrence.",
};
type CalendarEvent = Record<string, any>;
function compact(event: CalendarEvent, includeAttendees = false) {
  return {
    ...Object.fromEntries(
      [
        "id",
        "etag",
        "iCalUID",
        "summary",
        "description",
        "location",
        "start",
        "end",
        "status",
        "htmlLink",
        "recurrence",
        "recurringEventId",
        "originalStartTime",
      ]
        .filter((key) => event[key] !== undefined)
        .map((key) => [
          key,
          typeof event[key] === "string"
            ? event[key].slice(0, 8000)
            : event[key],
        ]),
    ),
    ...(includeAttendees && Array.isArray(event.attendees)
      ? {
          attendeeCount: event.attendees.length,
          attendees: event.attendees
            .slice(0, 50)
            .map((guest: CalendarEvent) => ({
              email: guest.email,
              responseStatus: guest.responseStatus,
            })),
        }
      : {}),
  };
}
function eventFields(input: {
  title?: string;
  description?: string;
  location?: string;
  schedule?: z.infer<typeof schedule>;
  attendees?: string[];
}) {
  const result: CalendarEvent = {};
  if (input.attendees !== undefined)
    result.attendees = input.attendees.map((email) => ({ email }));
  if (input.title !== undefined) result.summary = input.title;
  if (input.description !== undefined) result.description = input.description;
  if (input.location !== undefined) result.location = input.location;
  if (input.schedule) {
    const { kind, start, end } = input.schedule;
    result.start =
      kind === "timed"
        ? { dateTime: start, timeZone: timezone }
        : { date: start };
    result.end =
      kind === "timed" ? { dateTime: end, timeZone: timezone } : { date: end };
  }
  return result;
}
class CalendarError extends Error {}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function createGoogleCalendarClient(
  env: Record<string, string | undefined>,
  context: FeatureContext & {
    messageId: string;
    resolveRoleIds?: () => Promise<readonly string[]>;
  },
  request: typeof fetch = fetch,
  availability: Pick<
    FeatureAvailabilityStore,
    "isEnabled"
  > = getFeatureAvailabilityStore(),
) {
  const settings = calendarSettings(env);
  if (
    !settings ||
    !context.guildId ||
    !availability.isEnabled("calendar", context)
  )
    return undefined;
  const config = { ...settings, guildId: context.guildId };
  const allowed = async () => {
    try {
      const roleIds = context.resolveRoleIds
        ? await context.resolveRoleIds()
        : context.roleIds;
      return availability.isEnabled("calendar", { ...context, roleIds });
    } catch {
      return false;
    }
  };
  const configured = env.MINISAGO_GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON;
  const oauthConfigured =
    env.DISCORD_CALENDAR_OAUTH_JSON || env.MINISAGO_GOOGLE_CALENDAR_OAUTH_JSON;
  if (!configured && !oauthConfigured) return undefined;
  let oauth: z.infer<typeof oauthSchema> | undefined;
  let credentials: z.infer<typeof serviceAccountSchema> | undefined;
  let privateKey: ReturnType<typeof createPrivateKey> | undefined;
  try {
    if (oauthConfigured) oauth = oauthSchema.parse(JSON.parse(oauthConfigured));
    else {
      credentials = serviceAccountSchema.parse(JSON.parse(configured!));
      privateKey = createPrivateKey(credentials.private_key);
      if (privateKey.asymmetricKeyType !== "rsa") return undefined;
    }
  } catch {
    return undefined;
  }
  let token: { value: string; expires: number } | undefined;
  let refreshing: Promise<string> | undefined;
  async function accessToken() {
    if (token && token.expires > Date.now() + 60000) return token.value;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      let parameters: URLSearchParams;
      if (oauth)
        parameters = new URLSearchParams({
          ...oauth,
          grant_type: "refresh_token",
        });
      else {
        const issuedAt = Math.floor(Date.now() / 1000);
        const encode = (value: unknown) =>
          Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: credentials!.private_key_id })}.${encode(
          {
            iss: credentials!.client_email,
            scope: "https://www.googleapis.com/auth/calendar.events",
            aud: "https://oauth2.googleapis.com/token",
            iat: issuedAt,
            exp: issuedAt + 3600,
          },
        )}`;
        const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey!).toString("base64url")}`;
        parameters = new URLSearchParams({
          assertion,
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        });
      }
      const response = await request("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: parameters,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new CalendarError(
          "Calendar authorization unavailable; an administrator must check the saved calendar credentials.",
        );
      const data = (await response.json()) as Record<string, unknown>;
      if (
        typeof data.access_token !== "string" ||
        typeof data.expires_in !== "number"
      )
        throw new CalendarError(
          "Calendar authorization returned an invalid response.",
        );
      if (oauth) {
        const identity = await request(
          "https://openidconnect.googleapis.com/v1/userinfo",
          {
            headers: { Authorization: `Bearer ${data.access_token}` },
            signal: AbortSignal.timeout(15000),
          },
        );
        const user = identity.ok
          ? ((await identity.json()) as Record<string, unknown>)
          : {};
        if (user.email !== config!.account || user.email_verified !== true)
          throw new CalendarError(
            "Calendar authorization belongs to the wrong account. Reconnect the dedicated booking user.",
          );
      }
      token = {
        value: data.access_token,
        expires: Date.now() + data.expires_in * 1000,
      };
      return token.value;
    })();
    try {
      return await refreshing;
    } finally {
      refreshing = undefined;
    }
  }
  async function api(
    path = "",
    init: RequestInit = {},
    calendar: "events" | "office" = "events",
  ) {
    if (calendar === "office" && (init.method ?? "GET") !== "GET")
      throw new CalendarError("The office calendar is read-only.");
    const calendarId =
      calendar === "office" ? config!.officeCalendarId : config!.calendarId;
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    const bearer = await accessToken();
    const response = await request(base + path, {
      ...init,
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...init.headers,
        Authorization: `Bearer ${bearer}`,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) token = undefined;
    return response;
  }
  async function body(response: Response): Promise<CalendarEvent> {
    if (!response.ok) {
      const errors: Record<number, string> = {
        401: "Calendar authorization expired. Ask an administrator to check the calendar authorization and sharing.",
        403: "Calendar access denied. Ask an administrator to check access or quota.",
        404: "Calendar event not found.",
        409: "This operationKey already belongs to a different event request. Read the existing booking before continuing.",
        412: "Calendar event changed. Read it again and reconcile changes before retrying.",
        429: "Calendar rate limit reached. Retry later with the same operationKey.",
      };
      throw new CalendarError(
        errors[response.status] ??
          "Google Calendar request failed. Read the event before retrying an edit; reuse the same operationKey when retrying creation.",
      );
    }
    return (await response.json()) as CalendarEvent;
  }
  function officeReservation(event: CalendarEvent) {
    const guest = event.attendees?.find(
      (a: CalendarEvent) =>
        a.email?.toLowerCase() === config!.officeCalendarId.toLowerCase(),
    );
    return guest
      ? guest.responseStatus === "accepted"
        ? "accepted"
        : guest.responseStatus === "declined"
          ? "declined"
          : "pending"
      : "not_requested";
  }
  function result(event: CalendarEvent, includeAttendees = false) {
    return {
      status: "complete",
      calendar: config!.calendarName,
      event: compact(event, includeAttendees),
      officeReservation: officeReservation(event),
    };
  }
  function guests(
    input: { attendees?: string[]; useOffice?: boolean },
    existing?: CalendarEvent,
  ) {
    if (
      input.attendees?.some((email) =>
        email.toLowerCase().endsWith("@group.calendar.google.com"),
      )
    )
      throw new CalendarError(
        "Use useOffice for the office invitation; attendees must contain the selected people, not calendar IDs.",
      );
    const hadOffice = officeReservation(existing ?? {}) !== "not_requested";
    const useOffice = input.useOffice ?? hadOffice;
    let attendees: CalendarEvent[] =
      input.attendees?.map((email) => ({ email })) ?? existing?.attendees ?? [];
    if (
      input.attendees !== undefined ||
      input.useOffice !== undefined ||
      !existing
    ) {
      attendees = attendees.filter(
        (a) =>
          a.email?.toLowerCase() !== config!.officeCalendarId.toLowerCase(),
      );
      if (useOffice)
        attendees.push(
          existing?.attendees?.find(
            (a: CalendarEvent) =>
              a.email?.toLowerCase() === config!.officeCalendarId.toLowerCase(),
          ) ?? { email: config!.officeCalendarId },
        );
      if (attendees.length > 50)
        throw new CalendarError(
          "Use at most 50 guests including the office calendar.",
        );
      if (attendees.length && !oauth)
        throw new CalendarError(
          "Invitations require the dedicated booking user to be connected.",
        );
      return { attendees, useOffice };
    }
    return { attendees: undefined, useOffice };
  }
  async function checkOffice(event: CalendarEvent, existing?: CalendarEvent) {
    const start = event.start ?? existing?.start;
    const end = event.end ?? existing?.end;
    const timeMin = start?.dateTime ?? `${start?.date}T00:00:00+08:00`;
    const timeMax = end?.dateTime ?? `${end?.date}T00:00:00+08:00`;
    if (
      !Number.isFinite(Date.parse(timeMin)) ||
      !Number.isFinite(Date.parse(timeMax))
    )
      throw new CalendarError(
        "Read the event's current start and end before requesting the office.",
      );
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      });
      const data = await body(await api(`?${params}`, {}, "office"));
      if (
        (data.items ?? []).some(
          (item: CalendarEvent) =>
            item.status !== "cancelled" &&
            item.transparency !== "transparent" &&
            !(existing?.iCalUID && item.iCalUID === existing.iCalUID) &&
            !item.attendees?.some(
              (a: CalendarEvent) => a.self && a.responseStatus === "declined",
            ),
        )
      )
        throw new CalendarError(
          "The office calendar has an overlapping event. Choose another time or location; no change was saved.",
        );
      if (!data.nextPageToken) return;
      pageToken = data.nextPageToken;
    }
    throw new CalendarError(
      "Office availability could not be checked completely; no change was saved.",
    );
  }
  return {
    config,
    async call(
      name: CalendarToolName,
      raw: unknown,
    ): Promise<Record<string, unknown>> {
      try {
        if (!(await allowed())) return { status: "forbidden" };
        calendarSchemas[name].parse(raw);
        if (name === "list_calendar_events") {
          const input = calendarSchemas.list_calendar_events.parse(raw);
          const params = new URLSearchParams({
            timeMin: input.start,
            timeMax: input.end,
            maxResults: String(input.limit),
            singleEvents: "true",
            orderBy: "startTime",
            timeZone: timezone,
          });
          if (input.query) params.set("q", input.query);
          if (input.pageToken) params.set("pageToken", input.pageToken);
          const data = await body(await api(`?${params}`, {}, input.calendar));
          return {
            status: "complete",
            calendar: input.calendar ?? "events",
            events: (data.items ?? []).map((event: CalendarEvent) => ({
              ...compact(event),
              officeReservation: officeReservation(event),
            })),
            nextPageToken: data.nextPageToken,
          };
        }
        if (name === "get_calendar_event") {
          const input = calendarSchemas.get_calendar_event.parse(raw);
          const event = await body(
            await api(`/${input.eventId}`, {}, input.calendar),
          );
          return {
            ...result(event, true),
            calendar: input.calendar ?? "events",
          };
        }
        if (name === "create_calendar_event") {
          const input = calendarSchemas.create_calendar_event.parse(raw);
          const guestList = guests(input);
          const event = {
            ...eventFields(input),
            ...(guestList.attendees?.length
              ? { attendees: guestList.attendees }
              : {}),
          };
          const id = digest(
            `${config!.calendarId}:${context.guildId}:${context.messageId}:${input.operationKey}`,
          );
          const fingerprint = digest(JSON.stringify(event));
          // A successful retry must not conflict with its own accepted office invitation.
          if (guestList.useOffice) {
            const previous = await api(`/${id}`);
            if (previous.ok) {
              const existing = await body(previous);
              if (
                existing.status !== "cancelled" &&
                existing.extendedProperties?.private
                  ?.discordCalendarFingerprint === fingerprint
              )
                return { ...result(existing), reused: true };
              throw new CalendarError(
                "This operationKey already belongs to a different or cancelled event.",
              );
            }
            if (previous.status !== 404 && previous.status !== 410)
              await body(previous);
            await checkOffice(event);
          }
          const response = await api("?sendUpdates=all", {
            method: "POST",
            body: JSON.stringify({
              ...event,
              id,
              extendedProperties: {
                private: { discordCalendarFingerprint: fingerprint },
              },
            }),
          });
          if (response.status === 409) {
            const existing = await body(await api(`/${id}`));
            if (
              existing.status !== "cancelled" &&
              existing.extendedProperties?.private
                ?.discordCalendarFingerprint === fingerprint
            )
              return { ...result(existing), reused: true };
          }
          return result(await body(response));
        }
        const input =
          name === "delete_calendar_event"
            ? calendarSchemas.delete_calendar_event.parse(raw)
            : calendarSchemas.edit_calendar_event.parse(raw);
        const response = await api(`/${input.eventId}`);
        if (
          name === "delete_calendar_event" &&
          (response.status === 404 || response.status === 410)
        )
          return { status: "complete", deleted: true, reused: true };
        const existing = await body(response);
        if (name === "delete_calendar_event" && existing.status === "cancelled")
          return { status: "complete", deleted: true, reused: true };
        if (existing.etag !== input.etag)
          throw new CalendarError(
            "Calendar event changed. Read it again and reconcile changes before retrying.",
          );
        if (existing.recurrence)
          throw new CalendarError(
            "Whole recurring series changes are unsupported. Select the intended occurrence.",
          );
        if (existing.status === "cancelled")
          throw new CalendarError("Cancelled events cannot be edited.");
        if (
          existing.organizer?.email &&
          existing.organizer.email !== config!.calendarId
        )
          throw new CalendarError(
            "Only events organized by the dedicated calendar can be changed.",
          );
        if (name === "delete_calendar_event") {
          const removed = await api(`/${input.eventId}?sendUpdates=all`, {
            method: "DELETE",
            headers: { "If-Match": input.etag },
          });
          if (!removed.ok && removed.status !== 404 && removed.status !== 410)
            await body(removed);
          return { status: "complete", deleted: true };
        }
        const edit = calendarSchemas.edit_calendar_event.parse(raw);
        const guestList = guests(edit, existing);
        const changed = eventFields(edit);
        if (guestList.attendees !== undefined)
          changed.attendees = guestList.attendees;
        if (
          guestList.useOffice &&
          (edit.schedule !== undefined || edit.useOffice === true)
        )
          await checkOffice(changed, existing);
        return result(
          await body(
            await api(
              `/${input.eventId}?sendUpdates=all&conferenceDataVersion=1`,
              {
                method: "PATCH",
                headers: { "If-Match": edit.etag },
                body: JSON.stringify(changed),
              },
            ),
          ),
        );
      } catch (error) {
        return {
          status: "unavailable",
          error:
            error instanceof CalendarError
              ? error.message
              : error instanceof z.ZodError
                ? "Invalid calendar input. Check dates, event ID, and required fields."
                : "Calendar request could not be completed. Reuse the same operationKey for creation retries; read events again before retrying edits or deletion.",
        };
      }
    },
  };
}

export type GoogleCalendarClient = NonNullable<
  ReturnType<typeof createGoogleCalendarClient>
>;
