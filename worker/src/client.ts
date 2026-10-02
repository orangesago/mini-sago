import {
  CHATBOT_PROTOCOL_VERSION,
  parseChatbotJob,
  type ChatbotFailureKind,
  type ChatbotJob,
  type ChatbotMcpTraceCall,
  type MacAgentClientMessage,
  type MacAgentServerMessage,
} from "../../contracts/worker-contract";
import type { MacAgentConfig } from "./config";
import {
  checkCodexAuthentication,
  codexProfileForJob,
  PROMPT_VERSION,
  prewarmChatRuntime,
  runCodexJob,
} from "./codex";
import { SessionMonitor } from "./mac/session-monitor";
import { ChatbotTraceStore } from "./trace-store";
import { readCodexUsage } from "./codex-usage";
import { CodexAppServerManager } from "./codex-app-server";
import { SkillbookSync } from "./skillbook";
import { developerBranchName } from "./developer-workspace";

const HEARTBEAT_INTERVAL_MS = 20_000;
const AUTH_RETRY_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type JobPhase =
  | "preparing"
  | "exploring"
  | "implementing"
  | "testing"
  | "reviewing";

export function formatJobFailure(
  job: ChatbotJob,
  phase: JobPhase,
  cause: string,
) {
  const retryable =
    /busy|disconnect|network|offline|rate.?limit|timed? out|timeout/iu.test(
      cause,
    );
  const branch = job.developerTask
    ? developerBranchName(job.developerTask.id)
    : undefined;
  return [
    `Phase: ${phase}`,
    `Cause: ${cause}`,
    ...(job.repository ? [`Repository: ${job.repository}`] : []),
    ...(branch ? [`Branch: ${branch}`] : []),
    `Retry: ${retryable ? "safe" : "needs review"}`,
    `Logs: worker job ${job.id}`,
  ].join("\n");
}

export function failureKindForCause(
  cause: string,
  stopped = false,
): ChatbotFailureKind {
  if (stopped) return "internal";
  if (/timed? out|timeout/iu.test(cause)) return "timeout";
  if (/busy|disconnect|network|offline|rate.?limit/iu.test(cause)) {
    return "unavailable";
  }
  return "internal";
}

function parseServerMessage(value: unknown) {
  try {
    const message = JSON.parse(String(value)) as unknown;
    if (!message || typeof message !== "object") return null;
    const record = message as Record<string, unknown>;

    if (
      record.type === "authenticated" &&
      typeof record.protocolVersion === "number"
    ) {
      return record as MacAgentServerMessage;
    }
    if (record.type === "job") {
      const job = parseChatbotJob(record.job);
      return job ? ({ type: "job", job } as const) : null;
    }
    if (record.type === "cancel" && typeof record.jobId === "string") {
      return record as MacAgentServerMessage;
    }
    if (
      record.type === "steer" &&
      typeof record.jobId === "string" &&
      typeof record.requestId === "string" &&
      typeof record.request === "string"
    ) {
      return record as MacAgentServerMessage;
    }
    if (
      record.type === "codex_usage_request" &&
      typeof record.requestId === "string"
    ) {
      return record as MacAgentServerMessage;
    }
    if (
      record.type === "skill_sync_request" &&
      typeof record.requestId === "string"
    ) {
      return record as MacAgentServerMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export class MacAgentClient {
  private appServer = new CodexAppServerManager();
  private authenticated = false;
  private authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private codexAuthenticated = false;
  private currentJobs = new Map<string, AbortController>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionMonitor: SessionMonitor | null;
  private skillbook?: SkillbookSync;
  private skillsChanged = false;
  private socket: WebSocket | null = null;
  private stopped = false;
  private traceStore: ChatbotTraceStore;
  private unlocked = false;

  constructor(private readonly config: MacAgentConfig) {
    this.traceStore = new ChatbotTraceStore(config.traceDatabasePath, {
      promptVersion: PROMPT_VERSION,
    });
    this.skillbook = config.skillbookRepository
      ? new SkillbookSync({
          codexHome: config.codexHome,
          githubConfigDir: config.githubConfigDir,
          repository: config.skillbookRepository,
          intervalMs: config.skillbookSyncIntervalMs,
        })
      : undefined;
    this.sessionMonitor = config.headless
      ? null
      : new SessionMonitor(
          config.sessionMonitorPath,
          (state) => void this.handleSessionState(state),
        );
  }

  start() {
    void this.startAfterSkillSync();
  }

  private async startAfterSkillSync() {
    await this.skillbook?.start(
      () => this.markSkillsChanged(),
      () => this.sendAvailability(),
    );
    if (this.stopped) return;
    if (this.config.headless) {
      this.unlocked = true;
      void prewarmChatRuntime({
        ...this.config,
        appServer: this.appServer,
      }).catch(() =>
        console.warn(
          "Chat runtime prewarm unavailable; the next request will start it.",
        ),
      );
      void this.connectWhenReady();
      console.log("MiniSago headless worker started.");
      return;
    }

    this.sessionMonitor?.start();
    console.log("MiniSago Mac worker started.");
  }

  stop() {
    this.stopped = true;
    this.unlocked = false;
    this.codexAuthenticated = false;
    this.clearTimers();
    this.abortAllJobs();
    this.appServer.close();
    this.skillbook?.stop();
    this.socket?.close(1000, "Helper stopped");
    this.socket = null;
    this.sessionMonitor?.stop();
    this.traceStore.close();
  }

  health() {
    const appServer = this.appServer.status();
    const bridge =
      this.authenticated && this.socket?.readyState === WebSocket.OPEN;
    return {
      ok: Boolean(
        this.unlocked && bridge && this.codexAuthenticated && appServer.ok,
      ),
      bridge,
      codexAuthenticated: this.codexAuthenticated,
      activeJobs: this.currentJobs.size,
      appServer,
      warmChat: this.appServer.warmStatus(),
      ...(this.skillbook ? { skillbook: this.skillbook.status() } : {}),
    };
  }

  private async handleSessionState(state: "locked" | "unlocked") {
    if (state === "locked") {
      this.unlocked = false;
      this.authenticated = false;
      this.codexAuthenticated = false;
      this.clearTimers();
      this.abortAllJobs();
      this.appServer.close();
      this.socket?.close(1000, "Mac locked or sleeping");
      this.socket = null;
      console.log("Mac locked; worker unavailable.");
      return;
    }

    if (this.unlocked || this.stopped) {
      return;
    }

    this.unlocked = true;
    await this.connectWhenReady();
  }

  private async connectWhenReady() {
    if (!this.unlocked || this.stopped || this.socket) {
      return;
    }

    this.codexAuthenticated = await checkCodexAuthentication(this.config);
    if (!this.codexAuthenticated) {
      console.warn("Local Codex authentication unavailable; chatbot offline.");
      this.authRetryTimer = setTimeout(
        () => void this.connectWhenReady(),
        AUTH_RETRY_MS,
      );
      return;
    }

    this.openSocket();
  }

  private openSocket() {
    if (!this.unlocked || this.stopped || this.socket) {
      return;
    }

    const socket = new WebSocket(this.config.bridgeUrl);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({
        type: "authenticate",
        protocolVersion: CHATBOT_PROTOCOL_VERSION,
        secret: this.config.bridgeSecret,
        workerId: this.config.workerId,
        repositories: this.config.githubRepositories,
        ...(this.config.chatbotRepository
          ? { chatbotRepository: this.config.chatbotRepository }
          : {}),
      });
    });
    socket.addEventListener("message", (event) => {
      void this.handleServerMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (socket !== this.socket) {
        return;
      }

      this.socket = null;
      this.authenticated = false;
      this.stopHeartbeat();
      this.abortAllJobs();
      this.appServer.close();
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private async handleServerMessage(rawMessage: unknown) {
    const message = parseServerMessage(rawMessage);
    if (!message) {
      this.socket?.close(4002, "Invalid server message");
      return;
    }

    if (message.type === "authenticated") {
      if (message.protocolVersion !== CHATBOT_PROTOCOL_VERSION) {
        this.socket?.close(4002, "Protocol mismatch");
        return;
      }

      this.authenticated = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.sendAvailability();
      console.log("MiniSago worker available.");
      return;
    }

    if (!this.authenticated) {
      this.socket?.close(4001, "Server message before authentication");
      return;
    }

    if (message.type === "cancel") {
      this.currentJobs.get(message.jobId)?.abort();
      return;
    }

    if (message.type === "steer") {
      let accepted = false;
      try {
        accepted = await this.appServer.steer(message.jobId, message.request);
      } catch (error) {
        console.warn(
          `Job ${message.jobId} steering failed: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
      this.send({
        type: "steer_result",
        jobId: message.jobId,
        requestId: message.requestId,
        accepted,
      });
      if (!accepted) {
        console.warn(`Job ${message.jobId} could not be steered.`);
      }
      return;
    }

    if (message.type === "codex_usage_request") {
      const usage = await readCodexUsage(this.config);
      if (this.authenticated) {
        this.send({
          type: "codex_usage_result",
          requestId: message.requestId,
          usage,
        });
      }
      return;
    }

    if (message.type === "skill_sync_request") {
      let changed = false;
      if (this.skillbook) {
        changed = await this.skillbook.sync().catch((error) => {
          console.warn(
            `Skillbook sync failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
          return false;
        });
        if (changed) this.markSkillsChanged();
      }
      this.send({
        type: "skill_sync_result",
        requestId: message.requestId,
        status: this.skillbook?.status() ?? {
          ok: false,
          syncing: false,
          skills: 0,
          error: "Skillbook sync is disabled on this worker.",
        },
      });
      return;
    }

    if (message.type === "job") {
      void this.handleJob(message.job);
    }
  }

  private async handleJob(job: ChatbotJob) {
    // Trace reads must be serviceable while the requesting answer occupies a slot.
    if (job.purpose === "trace_lookup") {
      try {
        const trace = this.traceStore.previousTrace(
          job.channelId,
          job.requestMessageId,
        );
        const developerTask = this.traceStore.preservedDeveloperTask(
          job.channelId,
        );
        this.send({
          type: "result",
          jobId: job.id,
          ok: true,
          content: JSON.stringify({
            ...(trace
              ? { status: "complete", trace }
              : { status: "not_found" }),
            ...(developerTask ? { developerTask } : {}),
          }),
        });
      } catch {
        this.send({
          type: "result",
          jobId: job.id,
          ok: false,
          error: "Trace lookup unavailable.",
          failureKind: "internal",
        });
      }
      return;
    }
    if (this.currentJobs.size >= this.config.maxConcurrentJobs) {
      this.send({
        type: "result",
        jobId: job.id,
        ok: false,
        error: "Codex worker is busy.",
        failureKind: "unavailable",
      });
      return;
    }

    const controller = new AbortController();
    this.reloadSkillsIfIdle();
    this.currentJobs.set(job.id, controller);
    const startedAt = Date.now();
    let phase: JobPhase = "preparing";
    console.log(`Job ${job.id} started.`);

    try {
      const rawContent = await (async () => {
        const toolCalls: ChatbotMcpTraceCall[] = [];
        this.traceStore.start(job, startedAt, {
          model: codexProfileForJob(job, this.config.chatbotAccess).model,
        });
        const answer = await runCodexJob(job, {
          ...this.config,
          appServer: this.appServer,
          onMcpToolCall: (call) => toolCalls.push(call),
          onPromptCompiled: (prompt) =>
            this.traceStore.recordPrompt(job.id, prompt),
          onProgress: (progress) => {
            phase = progress.phase;
            if (job.developerTask && progress.sessionId)
              this.traceStore.recordDeveloperSession(
                job.id,
                progress.sessionId,
              );
            this.send({ type: "progress", jobId: job.id, progress });
          },
          onReplyDelta: (delta) => {
            this.send({ type: "answer_delta", jobId: job.id, delta });
          },
          signal: controller.signal,
        });
        this.traceStore.finish(job.id, answer.content, Date.now(), toolCalls);
        return answer;
      })();

      const outgoing =
        typeof rawContent === "string"
          ? { content: rawContent, files: [] }
          : rawContent;

      if (!controller.signal.aborted && this.authenticated) {
        this.currentJobs.delete(job.id);
        this.send({
          type: "result",
          jobId: job.id,
          ok: true,
          content: outgoing.content,
          ...(outgoing.files.length ? { files: outgoing.files } : {}),
        });
      }
      console.log(`Job ${job.id} finished in ${Date.now() - startedAt} ms.`);
    } catch (error) {
      const cause = controller.signal.aborted
        ? "Task stopped."
        : error instanceof Error
          ? error.message
          : "Codex failed.";
      this.traceStore.fail(job.id, cause);
      if (this.authenticated) {
        this.currentJobs.delete(job.id);
        this.send({
          type: "result",
          jobId: job.id,
          ok: false,
          error: controller.signal.aborted
            ? cause
            : formatJobFailure(job, phase, cause),
          failureKind: failureKindForCause(cause, controller.signal.aborted),
          ...(controller.signal.aborted ? { stopped: true } : {}),
        });
      }
      console.error(
        `Job ${job.id} failed in ${phase} after ${Date.now() - startedAt} ms: ${cause}`,
      );
    } finally {
      this.currentJobs.delete(job.id);
      this.reloadSkillsIfIdle();
    }
  }

  private markSkillsChanged() {
    this.skillsChanged = true;
    this.reloadSkillsIfIdle();
    this.sendAvailability();
  }

  private reloadSkillsIfIdle() {
    if (!this.skillsChanged || this.currentJobs.size > 0) return;
    this.appServer.close();
    this.skillsChanged = false;
  }

  private send(message: MacAgentClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private sendAvailability() {
    this.send({
      type: "availability",
      available: true,
      capacity: this.config.maxConcurrentJobs,
      ...(this.skillbook ? { skillbook: this.skillbook.status() } : {}),
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect() {
    if (!this.unlocked || this.stopped) {
      return;
    }

    const delay = Math.min(
      1_000 * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => void this.connectWhenReady(), delay);
  }

  private clearTimers() {
    this.stopHeartbeat();

    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private abortAllJobs() {
    for (const controller of this.currentJobs.values()) controller.abort();
    this.currentJobs.clear();
  }
}
