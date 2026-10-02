import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  defaultFeatureAvailability,
  featureAvailabilityFile,
  FeatureAvailabilityStore,
} from "./feature-availability";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function store(environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "minisago-features-"));
  directories.push(directory);
  return {
    directory,
    store: new FeatureAvailabilityStore(
      join(directory, "features.json"),
      environment,
    ),
  };
}

describe("feature availability", () => {
  test("uses persistent state by default in production", () => {
    expect(featureAvailabilityFile({ NODE_ENV: "production" })).toBe(
      "/app/state/feature-availability.json",
    );
    expect(featureAvailabilityFile({ NODE_ENV: "development" })).toBe(
      ".data/feature-availability.json",
    );
    expect(
      featureAvailabilityFile({
        NODE_ENV: "production",
        MINISAGO_FEATURE_AVAILABILITY_FILE: "/custom/features.json",
      }),
    ).toBe("/custom/features.json");
  });

  test("preserves the old environment coverage as initial policy", () => {
    const snapshot = defaultFeatureAvailability({
      MINISAGO_CHATBOT_GUILD_IDS: "917436845187563610",
      MINISAGO_CHATBOT_CHANNEL_IDS: "1517766866964316201",
      MINISAGO_AMBIENT_REACTIONS_ENABLED: "true",
    });

    expect(snapshot.features.chatbot.rules).toEqual([
      { scope: "guild", targetId: "917436845187563610", enabled: true },
      { scope: "channel", targetId: "1517766866964316201", enabled: true },
    ]);
    expect(snapshot.features.ambient_reactions.rules).toEqual(
      snapshot.features.chatbot.rules,
    );
    expect(snapshot.features.trip_planner.defaultEnabled).toBe(false);
    expect(Object.keys(snapshot.features)).toEqual([
      "chatbot",
      "ambient_reactions",
      "trip_planner",
      "ccxp_meetings",
      "developer_steering",
    ]);
  });

  test("registers approved CCXP guilds and preserves revocation after restart", async () => {
    const { directory, store: availability } = await store();
    for (const guildId of ["1394943277836402779", "1000249491494019092"])
      expect(availability.isEnabled("ccxp_meetings", { guildId })).toBe(true);
    const guildId = "917436845187563610";
    expect(availability.isEnabled("ccxp_meetings", { guildId })).toBe(false);
    expect(availability.isEnabled("ccxp_meetings", {})).toBe(false);
    await expect(
      availability.configure({
        feature: "ccxp_meetings",
        scope: "channel",
        targetId: guildId,
        action: "enable",
      }),
    ).rejects.toThrow("guild scope");
    await availability.configure({
      feature: "ccxp_meetings",
      scope: "guild",
      targetId: guildId,
      action: "enable",
    });
    expect(
      new FeatureAvailabilityStore(
        join(directory, "features.json"),
        {},
      ).isEnabled("ccxp_meetings", { guildId }),
    ).toBe(true);
    await availability.configure({
      feature: "ccxp_meetings",
      scope: "guild",
      targetId: guildId,
      action: "inherit",
    });
    await availability.configure({
      feature: "ccxp_meetings",
      scope: "guild",
      targetId: "1000249491494019092",
      action: "disable",
    });
    const reloaded = new FeatureAvailabilityStore(
      join(directory, "features.json"),
      {},
    );
    expect(reloaded.isEnabled("ccxp_meetings", { guildId })).toBe(false);
    expect(
      reloaded.isEnabled("ccxp_meetings", { guildId: "1000249491494019092" }),
    ).toBe(false);
  });

  test("registers coding steering only by guild and preserves revocation", async () => {
    const { directory, store: availability } = await store({
      MINISAGO_CHATBOT_GUILD_IDS: "917436845187563610",
      MINISAGO_CHATBOT_CHANNEL_IDS: "1517766866964316201",
    });
    const guildId = "1521168712579682567";
    expect(availability.isEnabled("developer_steering", { guildId })).toBe(
      true,
    );
    expect(
      availability.isEnabled("developer_steering", {
        guildId: "917436845187563610",
      }),
    ).toBe(false);
    expect(
      availability.isEnabled("developer_steering", {
        channelId: "1517766866964316201",
      }),
    ).toBe(false);
    await expect(
      availability.configure({
        feature: "developer_steering",
        scope: "channel",
        targetId: guildId,
        action: "enable",
      }),
    ).rejects.toThrow("guild scope");
    await availability.configure({
      feature: "developer_steering",
      scope: "guild",
      targetId: guildId,
      action: "inherit",
    });
    expect(
      new FeatureAvailabilityStore(
        join(directory, "features.json"),
        {},
      ).isEnabled("developer_steering", { guildId }),
    ).toBe(false);
    const file = join(directory, "legacy.json");
    const { developer_steering, ...legacyFeatures } =
      defaultFeatureAvailability({}).features;
    await writeFile(
      file,
      JSON.stringify({ version: 1, features: legacyFeatures }),
    );
    expect(
      new FeatureAvailabilityStore(file, {}).list().features.developer_steering,
    ).toEqual(developer_steering);
  });

  test("migrates existing feature files without replacing saved CCXP decisions", async () => {
    const { directory } = await store();
    const file = join(directory, "legacy.json");
    const snapshot = defaultFeatureAvailability({});
    const { ccxp_meetings, ...legacyFeatures } = snapshot.features;
    await writeFile(
      file,
      JSON.stringify({ version: 1, features: legacyFeatures }),
    );
    const migrated = new FeatureAvailabilityStore(file, {});
    expect(migrated.list().features.ccxp_meetings).toEqual(ccxp_meetings);
    expect(migrated.list().features.chatbot).toEqual(legacyFeatures.chatbot);

    snapshot.features.ccxp_meetings.rules = [];
    await writeFile(file, JSON.stringify(snapshot));
    expect(
      new FeatureAvailabilityStore(file, {}).isEnabled("ccxp_meetings", {
        guildId: "1394943277836402779",
      }),
    ).toBe(false);
    snapshot.features.ccxp_meetings.defaultEnabled = true;
    await writeFile(file, JSON.stringify(snapshot));
    expect(() => new FeatureAvailabilityStore(file, {})).toThrow(
      "explicit guild registrations",
    );
    snapshot.features.ccxp_meetings.defaultEnabled = false;
    snapshot.features.ccxp_meetings.rules = [
      { scope: "channel", targetId: "1000249491494019092", enabled: true },
    ];
    await writeFile(file, JSON.stringify(snapshot));
    expect(() => new FeatureAvailabilityStore(file, {})).toThrow(
      "explicit guild registrations",
    );
  });

  test("uses channel rules before guild rules and persists changes", async () => {
    const { directory, store: availability } = await store();
    const guildId = "917436845187563610";
    const channelId = "1517766866964316201";

    await availability.configure({
      feature: "chatbot",
      scope: "guild",
      targetId: guildId,
      action: "enable",
    });
    await availability.configure({
      feature: "chatbot",
      scope: "channel",
      targetId: channelId,
      action: "disable",
    });

    expect(availability.isEnabled("chatbot", { guildId })).toBe(true);
    expect(availability.isEnabled("chatbot", { guildId, channelId })).toBe(
      false,
    );
    const reloaded = new FeatureAvailabilityStore(
      join(directory, "features.json"),
    );
    expect(reloaded.isEnabled("chatbot", { guildId, channelId })).toBe(false);

    await reloaded.configure({
      feature: "chatbot",
      scope: "channel",
      targetId: channelId,
      action: "inherit",
    });
    expect(reloaded.isEnabled("chatbot", { guildId, channelId })).toBe(true);
  });
});
