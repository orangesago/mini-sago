import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { TARGET_GUILD_ID } from "./config";
import { CALENDAR_GUILD_ID } from "../chatbot/calendar-settings";

export const SCOPED_FEATURE_DEFINITIONS = {
  chatbot: "Answer mentions and /ask requests from non-owner members.",
  ambient_reactions: "Occasionally react to messages without being mentioned.",
  trip_planner: "Expose the shared Kyushu itinerary tools.",
  ccxp_meetings:
    "Search protected NTHU meeting records during related discussions. Owner registration is guild-only; requires a configured CCXP index.",
  calendar:
    "Expose Calendar tools in registered guilds, subject to optional role filters; requires configured Google credentials.",
  developer_steering:
    "Let non-owner humans steer existing coding tasks. Requires explicit guild registration; the owner can steer everywhere.",
} as const;

export type ScopedFeatureId = keyof typeof SCOPED_FEATURE_DEFINITIONS;
export type FeatureScope = "guild" | "channel";
export type FeatureContext = {
  guildId?: string;
  channelId?: string;
  roleIds?: readonly string[];
};
export type FeatureRoleFilters = {
  allowRoleIds?: string[];
  denyRoleIds?: string[];
};
export type FeatureRule = FeatureRoleFilters & {
  scope: FeatureScope;
  targetId: string;
  enabled: boolean;
};
export type FeaturePolicy = {
  defaultEnabled: boolean;
  rules: FeatureRule[];
};
export type FeatureAvailabilitySnapshot = {
  version: 1;
  features: Record<ScopedFeatureId, FeaturePolicy>;
};
export type FeatureAvailabilityMutation = FeatureRoleFilters & {
  feature: ScopedFeatureId;
  scope: FeatureScope;
  targetId: string;
  action: "enable" | "disable" | "inherit";
};

const DISCORD_SNOWFLAKE = /^\d{17,20}$/u;

function parseSnowflakes(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => DISCORD_SNOWFLAKE.test(item));
}

function enabledRules(
  scope: FeatureScope,
  targetIds: readonly string[],
): FeatureRule[] {
  return targetIds.map((targetId) => ({ scope, targetId, enabled: true }));
}

export function defaultFeatureAvailability(
  environment: NodeJS.ProcessEnv = process.env,
): FeatureAvailabilitySnapshot {
  const guildIds = parseSnowflakes(environment.MINISAGO_CHATBOT_GUILD_IDS);
  const channelIds = parseSnowflakes(environment.MINISAGO_CHATBOT_CHANNEL_IDS);
  const chatRules = [
    ...enabledRules("guild", guildIds),
    ...enabledRules("channel", channelIds),
  ];
  const ambientEnabled =
    environment.MINISAGO_AMBIENT_REACTIONS_ENABLED?.trim().toLowerCase() ===
    "true";

  return {
    version: 1,
    features: {
      chatbot: { defaultEnabled: false, rules: chatRules },
      ambient_reactions: {
        defaultEnabled: false,
        rules: ambientEnabled ? [...chatRules] : [],
      },
      trip_planner: {
        defaultEnabled: false,
        rules: enabledRules("guild", [TARGET_GUILD_ID]),
      },
      ccxp_meetings: {
        defaultEnabled: false,
        rules: enabledRules("guild", [
          "1394943277836402779",
          "1000249491494019092",
        ]),
      },
      calendar: {
        defaultEnabled: false,
        rules: [
          ...enabledRules(
            "guild",
            [environment.DISCORD_CALENDAR_GUILD_ID || CALENDAR_GUILD_ID].filter(
              (id) => id !== "1394943277836402779",
            ),
          ),
          // Owner-approved registration; applied once when upgrading legacy state.
          {
            scope: "guild",
            targetId: "1394943277836402779",
            enabled: true,
            allowRoleIds: ["1394944058534920213"],
          },
        ],
      },
      developer_steering: {
        defaultEnabled: false,
        rules: enabledRules("guild", ["1521168712579682567"]),
      },
    },
  };
}

function validRoleIds(value: unknown) {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 250 &&
      value.every((id) => typeof id === "string" && DISCORD_SNOWFLAKE.test(id)))
  );
}

function rolesAllowed(rule: FeatureRule, context: FeatureContext) {
  // Unknown membership cannot safely satisfy a denylist either.
  const filtered = Boolean(
    rule.allowRoleIds?.length || rule.denyRoleIds?.length,
  );
  if (filtered && (!context.guildId || context.roleIds === undefined))
    return false;
  const roles = new Set([context.guildId, ...(context.roleIds ?? [])]);
  if (rule.denyRoleIds?.some((id) => roles.has(id))) return false;
  return (
    !rule.allowRoleIds?.length || rule.allowRoleIds.some((id) => roles.has(id))
  );
}

function guildOnly(feature: ScopedFeatureId) {
  return ["ccxp_meetings", "developer_steering", "calendar"].includes(feature);
}

function assertSnapshot(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): FeatureAvailabilitySnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Feature availability must be a JSON object.");
  }
  const snapshot = value as Partial<FeatureAvailabilitySnapshot>;
  if (snapshot.version !== 1 || !snapshot.features) {
    throw new Error("Unsupported feature availability format.");
  }
  // Existing installations gain the initially approved registrations once.
  // A saved CCXP policy, including an empty registration list, stays authoritative.
  if (snapshot.features.ccxp_meetings === undefined) {
    snapshot.features.ccxp_meetings = defaultFeatureAvailability(
      {},
    ).features.ccxp_meetings;
  }
  if (snapshot.features.developer_steering === undefined) {
    snapshot.features.developer_steering = defaultFeatureAvailability(
      {},
    ).features.developer_steering;
  }
  if (snapshot.features.calendar === undefined) {
    snapshot.features.calendar =
      defaultFeatureAvailability(environment).features.calendar;
  }
  for (const feature of Object.keys(
    SCOPED_FEATURE_DEFINITIONS,
  ) as ScopedFeatureId[]) {
    const policy = snapshot.features[feature];
    if (!policy || typeof policy.defaultEnabled !== "boolean") {
      throw new Error(`Feature availability is missing ${feature}.`);
    }
    if (
      !Array.isArray(policy.rules) ||
      policy.rules.some(
        (rule) =>
          !["guild", "channel"].includes(rule.scope) ||
          !DISCORD_SNOWFLAKE.test(rule.targetId) ||
          typeof rule.enabled !== "boolean" ||
          !validRoleIds(rule.allowRoleIds) ||
          !validRoleIds(rule.denyRoleIds),
      )
    ) {
      throw new Error(`Feature availability has invalid ${feature} rules.`);
    }
    if (
      guildOnly(feature) &&
      (policy.defaultEnabled ||
        policy.rules.some((rule) => rule.scope !== "guild"))
    ) {
      throw new Error(
        `${feature} requires explicit guild registrations with a disabled default.`,
      );
    }
  }
  return snapshot as FeatureAvailabilitySnapshot;
}

function copySnapshot(
  snapshot: FeatureAvailabilitySnapshot,
): FeatureAvailabilitySnapshot {
  return structuredClone(snapshot);
}

export class FeatureAvailabilityStore {
  private snapshot: FeatureAvailabilitySnapshot;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.snapshot = existsSync(filePath)
      ? assertSnapshot(JSON.parse(readFileSync(filePath, "utf8")), environment)
      : defaultFeatureAvailability(environment);
  }

  list() {
    return copySnapshot(this.snapshot);
  }

  isEnabled(feature: ScopedFeatureId, context: FeatureContext) {
    if (guildOnly(feature) && !context.guildId) return false;
    const policy = this.snapshot.features[feature];
    const channelRule = context.channelId
      ? policy.rules.find(
          (rule) =>
            rule.scope === "channel" && rule.targetId === context.channelId,
        )
      : undefined;
    if (channelRule)
      return channelRule.enabled && rolesAllowed(channelRule, context);

    const guildRule = context.guildId
      ? policy.rules.find(
          (rule) => rule.scope === "guild" && rule.targetId === context.guildId,
        )
      : undefined;
    return guildRule
      ? guildRule.enabled && rolesAllowed(guildRule, context)
      : policy.defaultEnabled;
  }

  configure(input: FeatureAvailabilityMutation): Promise<FeaturePolicy> {
    if (guildOnly(input.feature) && input.scope !== "guild") {
      return Promise.reject(
        new Error(`${input.feature} registration requires guild scope.`),
      );
    }
    if (!validRoleIds(input.allowRoleIds) || !validRoleIds(input.denyRoleIds)) {
      return Promise.reject(
        new Error(
          "Role filters must contain valid Discord role IDs (at most 250 each).",
        ),
      );
    }
    if (
      input.action !== "enable" &&
      (input.allowRoleIds?.length || input.denyRoleIds?.length)
    ) {
      return Promise.reject(
        new Error("Role filters apply only to enabled registrations."),
      );
    }
    if (!DISCORD_SNOWFLAKE.test(input.targetId)) {
      return Promise.reject(new Error("targetId must be a Discord ID."));
    }

    const mutation = this.mutationQueue.then(async () => {
      const next = copySnapshot(this.snapshot);
      const policy = next.features[input.feature];
      policy.rules = policy.rules.filter(
        (rule) =>
          rule.scope !== input.scope || rule.targetId !== input.targetId,
      );
      if (input.action !== "inherit") {
        policy.rules.push({
          scope: input.scope,
          targetId: input.targetId,
          enabled: input.action === "enable",
          ...(input.allowRoleIds?.length
            ? { allowRoleIds: [...new Set(input.allowRoleIds)].sort() }
            : {}),
          ...(input.denyRoleIds?.length
            ? { denyRoleIds: [...new Set(input.denyRoleIds)].sort() }
            : {}),
        });
      }
      policy.rules.sort((left, right) =>
        `${left.scope}:${left.targetId}`.localeCompare(
          `${right.scope}:${right.targetId}`,
        ),
      );
      await this.persist(next);
      this.snapshot = next;
      return structuredClone(policy);
    });
    this.mutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  private async persist(snapshot: FeatureAvailabilitySnapshot) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

let sharedStore: FeatureAvailabilityStore | undefined;

export function featureAvailabilityFile(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    environment.MINISAGO_FEATURE_AVAILABILITY_FILE?.trim() ||
    (environment.NODE_ENV === "production"
      ? "/app/state/feature-availability.json"
      : ".data/feature-availability.json")
  );
}

export function getFeatureAvailabilityStore() {
  sharedStore ??= new FeatureAvailabilityStore(featureAvailabilityFile());
  return sharedStore;
}
