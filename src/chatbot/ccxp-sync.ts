import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CcxpSyncQueue,
  type CcxpCollectorStatus,
} from "../../contracts/ccxp-sync";
import {
  getFeatureAvailabilityStore,
  type FeatureAvailabilityStore,
} from "../discord/feature-availability";

export const ccxpSyncSchemas = {
  request_ccxp_sync: z.object({}).strict(),
  get_ccxp_sync_status: z.object({}).strict(),
};
export type CcxpSyncToolName = keyof typeof ccxpSyncSchemas;
export const ccxpSyncDescription =
  "Owner-only CCXP cache maintenance in registered guilds. Only request_ccxp_sync when the requester explicitly asks to sync or refresh CCXP meeting records. It queues one bounded pass; queued/running does not mean complete. Use get_ccxp_sync_status to check progress, the next nightly run, and whether password rotation is needed. Never claim the full archive is complete without checking coverage. Ordinary searches never trigger a sync.";

export function createCcxpSyncClient(
  env: Record<string, string | undefined>,
  context: {
    guildId?: string;
    roleIds?: readonly string[];
    requesterId: string;
    ownerId: string;
    messageId: string;
  },
  availability: Pick<
    FeatureAvailabilityStore,
    "isEnabled"
  > = getFeatureAvailabilityStore(),
) {
  const allowed = () =>
    Boolean(
      context.ownerId &&
      context.requesterId === context.ownerId &&
      context.guildId &&
      availability.isEnabled("ccxp_meetings", {
        guildId: context.guildId,
        roleIds: context.roleIds,
      }),
    );
  if (
    !allowed() ||
    !env.MINISAGO_CCXP_SYNC_QUEUE_PATH ||
    !env.MINISAGO_CCXP_INDEX_PATH
  )
    return;
  const queuePath = env.MINISAGO_CCXP_SYNC_QUEUE_PATH;
  const indexPath = env.MINISAGO_CCXP_INDEX_PATH;
  // Bound to the Discord message, so retries of its MCP call do not start another pass.
  const id = createHash("sha256").update(context.messageId).digest("hex");
  return {
    async call(
      name: CcxpSyncToolName,
      raw: unknown,
    ): Promise<Record<string, unknown>> {
      if (!allowed()) return { status: "forbidden" };
      ccxpSyncSchemas[name].parse(raw);
      let queue: CcxpSyncQueue | undefined;
      try {
        queue = new CcxpSyncQueue(queuePath);
        const collector = (await Bun.file(`${indexPath}.status.json`)
          .json()
          .catch(() => null)) as CcxpCollectorStatus | null;
        const schedule =
          "Nightly at 03:00 Asia/Taipei, plus 15-minute batches while work is pending; manual requests are checked every minute.";
        if (name === "request_ccxp_sync") {
          if (collector?.state === "auth_required")
            return { status: "auth_required", collector, schedule };
          return { ...queue.enqueue(id), collector, schedule };
        }
        return {
          status: "complete",
          request: queue.latest(),
          collector,
          schedule,
        };
      } catch {
        return { status: "unavailable" };
      } finally {
        queue?.close();
      }
    },
  };
}
export type CcxpSyncClient = NonNullable<
  ReturnType<typeof createCcxpSyncClient>
>;
