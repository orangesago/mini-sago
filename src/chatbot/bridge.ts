import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";

import {
  CHATBOT_JOB_TIMEOUT_MS,
  CHATBOT_DEV_JOB_TIMEOUT_MS,
  CHATBOT_PROTOCOL_VERSION,
  type ChatbotFailureKind,
  type ChatbotJob,
  type ChatbotOutgoingFile,
  type ChatbotTaskProgress,
  type ChatbotWorkerCapability,
  type CodexUsageSnapshot,
  type MacAgentClientMessage,
  type MacAgentServerMessage,
  type WorkerSkillbookStatus,
} from "../../contracts/worker-contract";
import { CHATBOT_REPLY_MAX_CHARACTERS } from "../../contracts/answer-contract";

export type MacAgentSocketData = {
  authenticated: boolean;
  workerId?: string;
};

type PendingJob = {
  id: string;
  workerId: string;
  workflowId?: string;
  resolve: (result: MacAgentJobResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: (progress: ChatbotTaskProgress) => void;
  onReplyDelta?: (delta: string) => void;
  replyCharacters: number;
  stopping?: boolean;
};

type PendingUsageRequest = {
  workerId: string;
  resolve: (usage: CodexUsageSnapshot | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingSteer = {
  jobId: string;
  workerId: string;
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Worker = {
  id: string;
  socket: Socket;
  profile: WorkerProfile;
  repositories: Set<string>;
  repositoryNames: string[];
  chatbotRepository?: string;
  available: boolean;
  capacity: number;
  skillbook?: WorkerSkillbookStatus;
};

type WorkerProfile = "oracle" | "mac";

type WorkerPolicy = {
  workerId?: string;
  profile: WorkerProfile;
};

type Workflow = {
  workerId: string;
  activeJobId?: string;
};

export type MacAgentJobResult =
  | { ok: true; content: string; files?: ChatbotOutgoingFile[] }
  | {
      ok: false;
      error: string;
      failureKind: ChatbotFailureKind;
      stopped?: boolean;
    };

export type DispatchResult =
  | { status: "offline" }
  | { status: "busy" }
  | {
      status: "accepted";
      result: Promise<MacAgentJobResult>;
      cancel: () => boolean;
    };

export type WorkerSelectionResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted" };

export type WorkflowLease = {
  availableRepositories: string[];
  chatbotRepository?: string;
  dispatch: (
    job: ChatbotJob,
    onProgress?: (progress: ChatbotTaskProgress) => void,
  ) => DispatchResult;
  steer: (jobId: string, request: string) => Promise<boolean>;
  stop: (jobId: string) => boolean;
  route: (
    capabilities: ChatbotWorkerCapability[],
    repository?: string,
  ) => WorkerSelectionResult;
  getCodexUsage: () => Promise<CodexUsageSnapshot | null>;
  release: () => void;
};

export type AcquireWorkflowResult =
  | { status: "offline" }
  | { status: "busy" }
  | { status: "accepted"; workflow: WorkflowLease };

type Socket = ServerWebSocket<MacAgentSocketData>;

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function parseClientMessage(message: string | Buffer) {
  try {
    return JSON.parse(message.toString()) as MacAgentClientMessage;
  } catch {
    return null;
  }
}

function send(socket: Socket, message: MacAgentServerMessage) {
  socket.send(JSON.stringify(message));
}

function validRepositories(repositories: unknown): repositories is string[] {
  return (
    Array.isArray(repositories) &&
    repositories.every(
      (repository) =>
        typeof repository === "string" &&
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(repository),
    )
  );
}

function validOutgoingFiles(
  value: unknown,
): value is ChatbotOutgoingFile[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 1 &&
      value.every(
        (file) =>
          file &&
          typeof file === "object" &&
          typeof file.filename === "string" &&
          file.filename.length > 0 &&
          file.filename.length <= 255 &&
          !/[\\/\0]/u.test(file.filename) &&
          typeof file.contentType === "string" &&
          file.contentType.length <= 100 &&
          Number.isInteger(file.size) &&
          file.size >= 0 &&
          file.size <= 8 * 1024 * 1024 &&
          typeof file.data === "string" &&
          file.data.length <= 12 * 1024 * 1024 &&
          /^[A-Za-z0-9+/]*={0,2}$/u.test(file.data) &&
          Buffer.byteLength(file.data, "base64") === file.size,
      ))
  );
}

function validCodexUsage(value: unknown): value is CodexUsageSnapshot | null {
  return (
    value === null ||
    Boolean(
      value &&
      typeof value === "object" &&
      typeof (value as CodexUsageSnapshot).updatedAt === "string" &&
      (value as CodexUsageSnapshot).updatedAt.length <= 40 &&
      Number.isFinite(Date.parse((value as CodexUsageSnapshot).updatedAt)) &&
      Array.isArray((value as CodexUsageSnapshot).windows) &&
      (value as CodexUsageSnapshot).windows.length <= 4 &&
      (value as CodexUsageSnapshot).windows.every(
        (window) =>
          typeof window.label === "string" &&
          window.label.length <= 40 &&
          Number.isInteger(window.windowMinutes) &&
          window.windowMinutes > 0 &&
          window.windowMinutes <= 525_600 &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 0 &&
          window.usedPercent <= 100 &&
          Number.isFinite(window.remainingPercent) &&
          window.remainingPercent >= 0 &&
          window.remainingPercent <= 100 &&
          (window.resetsAt === null ||
            (typeof window.resetsAt === "string" &&
              window.resetsAt.length <= 40 &&
              Number.isFinite(Date.parse(window.resetsAt)))),
      ),
    )
  );
}

function validSkillbookStatus(value: unknown): value is WorkerSkillbookStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as WorkerSkillbookStatus;
  return (
    typeof status.ok === "boolean" &&
    typeof status.syncing === "boolean" &&
    Number.isInteger(status.skills) &&
    status.skills >= 0 &&
    status.skills <= 1_000 &&
    (status.revision === undefined ||
      (typeof status.revision === "string" &&
        /^[a-f0-9]{40}$/u.test(status.revision))) &&
    (status.lastSyncedAt === undefined ||
      (typeof status.lastSyncedAt === "string" &&
        status.lastSyncedAt.length <= 40 &&
        Number.isFinite(Date.parse(status.lastSyncedAt)))) &&
    (status.error === undefined ||
      (typeof status.error === "string" && status.error.length <= 500))
  );
}

function validTaskProgress(value: unknown): value is ChatbotTaskProgress {
  if (!value || typeof value !== "object") return false;
  const progress = value as ChatbotTaskProgress;
  return (
    ["preparing", "exploring", "implementing", "testing", "reviewing"].includes(
      progress.phase,
    ) &&
    typeof progress.summary === "string" &&
    progress.summary.length > 0 &&
    progress.summary.length <= 2_000 &&
    (progress.timing === undefined ||
      (progress.timing !== null &&
        typeof progress.timing === "object" &&
        typeof progress.timing.stage === "string" &&
        progress.timing.stage.length <= 80 &&
        Number.isFinite(progress.timing.durationMs) &&
        progress.timing.durationMs >= 0)) &&
    (progress.kind === undefined ||
      progress.kind === "trace" ||
      progress.kind === "action") &&
    (progress.completion === undefined ||
      progress.completion === "pull_request_merged") &&
    (progress.sessionId === undefined ||
      (typeof progress.sessionId === "string" &&
        /^[a-z0-9._-]{1,128}$/iu.test(progress.sessionId)))
  );
}

function repositoryKey(repository: string) {
  return repository.toLocaleLowerCase("en-US");
}

function supports(worker: Worker, capabilities: ChatbotWorkerCapability[]) {
  return worker.profile === "mac" || !capabilities.includes("mac");
}

function profilePriority(profile: WorkerProfile) {
  return profile === "oracle" ? 100 : 50;
}

function configuredSecret(name: string) {
  const secret = process.env[name]?.trim();
  return secret && Buffer.byteLength(secret) >= 32 ? secret : undefined;
}

function workerPolicy(secret: string): WorkerPolicy | null {
  const policies: Array<{ secret?: string; policy: WorkerPolicy }> = [
    {
      secret: configuredSecret("MINISAGO_WORKER_BRIDGE_SECRET"),
      policy: {
        workerId: process.env.MINISAGO_WORKER_ID?.trim() || "oracle",
        profile: "oracle",
      },
    },
    {
      secret: configuredSecret("MINISAGO_MAC_BRIDGE_SECRET"),
      policy: {
        profile: "mac",
      },
    },
  ];
  const matches = policies.filter(
    (candidate) => candidate.secret && safeEqual(secret, candidate.secret),
  );
  return matches.length === 1 ? matches[0]!.policy : null;
}

export class MacAgentBridge {
  private workers = new Map<string, Worker>();
  private authenticationTimers = new WeakMap<
    Socket,
    ReturnType<typeof setTimeout>
  >();
  private heartbeatTimers = new WeakMap<
    Socket,
    ReturnType<typeof setTimeout>
  >();
  private pendingJobs = new Map<string, PendingJob>();
  private pendingSteers = new Map<string, PendingSteer>();
  private pendingUsageRequests = new Map<string, PendingUsageRequest>();
  private workflows = new Map<string, Workflow>();

  isConfigured() {
    return Boolean(
      configuredSecret("MINISAGO_MAC_BRIDGE_SECRET") ||
      configuredSecret("MINISAGO_WORKER_BRIDGE_SECRET"),
    );
  }

  getStatus(capabilities: ChatbotWorkerCapability[] = ["chat"]) {
    const status = this.selectWorker(capabilities).status;
    return status === "accepted" ? ("available" as const) : status;
  }

  getWorkerSummary() {
    const workers = [...this.workers.values()];
    const skillbook = workers.find(
      (worker) => worker.profile === "oracle",
    )?.skillbook;
    return {
      connected: workers.length,
      available: workers.filter((worker) => worker.available).length,
      capacity: workers.reduce((total, worker) => total + worker.capacity, 0),
      active: this.pendingJobs.size,
      mac: this.getStatus(["mac"]),
      ...(skillbook ? { skillbook } : {}),
    };
  }

  triggerOracleSkillSync() {
    const worker = [...this.workers.values()].find(
      (candidate) => candidate.profile === "oracle" && candidate.available,
    );
    if (!worker) return false;
    if (worker.skillbook) {
      worker.skillbook = { ...worker.skillbook, syncing: true };
    }
    send(worker.socket, {
      type: "skill_sync_request",
      requestId: randomUUID(),
    });
    return true;
  }

  handleUpgrade(request: Request, server: Server<MacAgentSocketData>) {
    if (!this.isConfigured()) {
      return new Response("本機連線服務尚未啟用", { status: 404 });
    }

    const upgraded = server.upgrade(request, {
      data: { authenticated: false },
    });

    return upgraded
      ? undefined
      : new Response("需要 WebSocket 連線", { status: 426 });
  }

  dispatch(
    job: ChatbotJob,
    capabilities: ChatbotWorkerCapability[] = [
      job.executionRoute === "oracle" ? "dev" : "chat",
    ],
    onReplyDelta?: (delta: string) => void,
    onProgress?: (progress: ChatbotTaskProgress) => void,
  ): DispatchResult {
    const selected = this.selectWorker(capabilities, undefined, job.repository);
    if (selected.status !== "accepted") return selected;
    return this.dispatchJob(
      job,
      selected.worker.id,
      undefined,
      onProgress,
      onReplyDelta,
    );
  }

  acquireWorkflow(
    capabilities: ChatbotWorkerCapability[] = ["chat"],
  ): AcquireWorkflowResult {
    const selected = this.selectWorker(capabilities);
    if (selected.status !== "accepted") return selected;

    const workflowId = randomUUID();
    this.workflows.set(workflowId, { workerId: selected.worker.id });
    const repositoryCapabilities = this.repositoryCapabilities();

    return {
      status: "accepted",
      workflow: {
        ...repositoryCapabilities,
        dispatch: (job, onProgress) =>
          this.dispatchWorkflowJob(job, workflowId, onProgress),
        steer: (jobId, request) => this.steerJob(jobId, workflowId, request),
        stop: (jobId) => this.stopJob(jobId, workflowId),
        route: (requiredCapabilities, repository) =>
          this.routeWorkflow(workflowId, requiredCapabilities, repository),
        getCodexUsage: () => this.getWorkflowCodexUsage(workflowId),
        release: () => {
          this.workflows.delete(workflowId);
        },
      },
    };
  }

  private repositoryCapabilities() {
    const repositoryNames = new Map<string, string>();
    const chatbotRepositories = new Map<string, string>();

    for (const worker of this.workers.values()) {
      if (!worker.available) continue;
      for (const repository of worker.repositoryNames) {
        repositoryNames.set(repositoryKey(repository), repository);
      }
      if (worker.chatbotRepository) {
        chatbotRepositories.set(
          repositoryKey(worker.chatbotRepository),
          worker.chatbotRepository,
        );
      }
    }

    const advertisedChatbotRepositories = [...chatbotRepositories.values()];
    return {
      availableRepositories: [...repositoryNames.values()].sort((left, right) =>
        left.localeCompare(right),
      ),
      ...(advertisedChatbotRepositories.length === 1
        ? { chatbotRepository: advertisedChatbotRepositories[0] }
        : {}),
    };
  }

  open(socket: Socket) {
    const timer = setTimeout(() => {
      if (!socket.data.authenticated) {
        socket.close(4001, "Authentication timeout");
      }
    }, 5_000);

    this.authenticationTimers.set(socket, timer);
  }

  message(socket: Socket, rawMessage: string | Buffer) {
    const message = parseClientMessage(rawMessage);

    if (!message) {
      socket.close(4002, "Invalid message");
      return;
    }

    if (!socket.data.authenticated) {
      this.authenticate(socket, message);
      return;
    }

    const worker = socket.data.workerId
      ? this.workers.get(socket.data.workerId)
      : undefined;
    if (!worker || worker.socket !== socket) {
      socket.close(4003, "Connection replaced");
      return;
    }

    this.armHeartbeatTimeout(worker);

    if (message.type === "heartbeat") return;

    if (message.type === "availability") {
      if (
        message.skillbook !== undefined &&
        !validSkillbookStatus(message.skillbook)
      ) {
        socket.close(4002, "Invalid availability");
        return;
      }
      worker.available = message.available;
      worker.capacity = Number.isFinite(message.capacity)
        ? Math.max(1, Math.min(16, Math.floor(message.capacity)))
        : 1;
      if (message.skillbook) worker.skillbook = message.skillbook;
      return;
    }

    if (message.type === "progress") {
      const pendingJob = this.pendingJobs.get(message.jobId);
      if (
        pendingJob?.workerId === worker.id &&
        validTaskProgress(message.progress)
      ) {
        pendingJob.onProgress?.(message.progress);
      }
      return;
    }

    if (message.type === "answer_delta") {
      const pendingJob = this.pendingJobs.get(message.jobId);
      if (
        pendingJob?.workerId === worker.id &&
        !pendingJob.stopping &&
        typeof message.delta === "string" &&
        message.delta.length > 0 &&
        message.delta.length <= CHATBOT_REPLY_MAX_CHARACTERS &&
        pendingJob.replyCharacters + message.delta.length <=
          CHATBOT_REPLY_MAX_CHARACTERS
      ) {
        pendingJob.replyCharacters += message.delta.length;
        pendingJob.onReplyDelta?.(message.delta);
      }
      return;
    }

    if (message.type === "result") {
      this.finishJob(worker, message);
      return;
    }

    if (message.type === "steer_result") {
      const pending = this.pendingSteers.get(message.requestId);
      if (
        pending?.jobId === message.jobId &&
        pending.workerId === worker.id &&
        typeof message.accepted === "boolean"
      ) {
        clearTimeout(pending.timer);
        this.pendingSteers.delete(message.requestId);
        pending.resolve(message.accepted);
      }
      return;
    }

    if (message.type === "codex_usage_result") {
      this.finishUsageRequest(worker, message);
      return;
    }

    if (message.type === "skill_sync_result") {
      if (
        typeof message.requestId === "string" &&
        message.requestId.length <= 128 &&
        validSkillbookStatus(message.status)
      ) {
        worker.skillbook = message.status;
        return;
      }
    }

    socket.close(4002, "Unexpected message");
  }

  close(socket: Socket) {
    this.clearAuthenticationTimer(socket);
    this.clearHeartbeatTimeout(socket);

    const workerId = socket.data.workerId;
    if (!workerId) return;

    const worker = this.workers.get(workerId);
    if (!worker || worker.socket !== socket) return;

    this.workers.delete(workerId);
    this.failPendingJobs(
      workerId,
      "The Codex worker disconnected while answering.",
    );
    this.failPendingUsageRequests(workerId);
  }

  private getWorkflowCodexUsage(
    workflowId: string,
  ): Promise<CodexUsageSnapshot | null> {
    const workflow = this.workflows.get(workflowId);
    const worker = workflow ? this.workers.get(workflow.workerId) : undefined;
    if (!worker) return Promise.resolve(null);

    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingUsageRequests.delete(requestId);
        resolve(null);
      }, 7_000);
      this.pendingUsageRequests.set(requestId, {
        workerId: worker.id,
        resolve,
        timer,
      });
      send(worker.socket, { type: "codex_usage_request", requestId });
    });
  }

  private dispatchWorkflowJob(
    job: ChatbotJob,
    workflowId: string,
    onProgress?: (progress: ChatbotTaskProgress) => void,
  ): DispatchResult {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return { status: "offline" };
    if (workflow.activeJobId && job.purpose !== "trace_lookup")
      return { status: "busy" };
    return this.dispatchJob(job, workflow.workerId, workflowId, onProgress);
  }

  private dispatchJob(
    job: ChatbotJob,
    workerId: string,
    workflowId?: string,
    onProgress?: (progress: ChatbotTaskProgress) => void,
    onReplyDelta?: (delta: string) => void,
  ): DispatchResult {
    const worker = this.workers.get(workerId);
    if (!worker?.available) return { status: "offline" };
    if (
      job.executionRoute === "oracle" &&
      (!job.repository ||
        !worker.repositories.has(repositoryKey(job.repository)))
    ) {
      return { status: "offline" };
    }
    if (this.pendingJobs.has(job.id)) return { status: "busy" };
    if (!workflowId && this.usedSlots(workerId) >= worker.capacity) {
      return { status: "busy" };
    }

    const result = new Promise<MacAgentJobResult>((resolve) => {
      // Give the worker's execution deadline time to deliver its result.
      const timeoutMs =
        job.executionRoute === "oracle" && job.purpose === "answer"
          ? CHATBOT_DEV_JOB_TIMEOUT_MS + 60_000
          : CHATBOT_JOB_TIMEOUT_MS;
      const timer = setTimeout(() => {
        const pendingJob = this.pendingJobs.get(job.id);
        if (!pendingJob) return;

        this.deletePendingJob(pendingJob);
        const activeWorker = this.workers.get(pendingJob.workerId);
        if (activeWorker)
          send(activeWorker.socket, { type: "cancel", jobId: job.id });
        resolve({
          ok: false,
          error: "Local Codex timed out.",
          failureKind: "timeout",
        });
      }, timeoutMs);

      const pendingJob = {
        id: job.id,
        workerId,
        workflowId,
        resolve,
        timer,
        onProgress,
        onReplyDelta,
        replyCharacters: 0,
      };
      this.pendingJobs.set(job.id, pendingJob);
      if (workflowId) {
        const workflow = this.workflows.get(workflowId);
        if (workflow && job.purpose !== "trace_lookup")
          workflow.activeJobId = job.id;
      }
    });

    send(worker.socket, { type: "job", job });
    return {
      status: "accepted",
      result,
      cancel: () => this.stopJob(job.id, workflowId),
    };
  }

  private stopJob(jobId: string, workflowId?: string) {
    const pendingJob = this.pendingJobs.get(jobId);
    if (!pendingJob || pendingJob.workflowId !== workflowId) return false;
    if (pendingJob.stopping) return true;
    const worker = this.workers.get(pendingJob.workerId);
    clearTimeout(pendingJob.timer);
    pendingJob.stopping = true;
    pendingJob.timer = setTimeout(() => {
      if (this.pendingJobs.get(jobId) !== pendingJob) return;
      this.deletePendingJob(pendingJob);
      pendingJob.resolve({
        ok: false,
        error: "Task stopped without a worker acknowledgement.",
        failureKind: "internal",
        stopped: true,
      });
    }, 10_000);
    if (worker) send(worker.socket, { type: "cancel", jobId });
    return true;
  }

  private steerJob(
    jobId: string,
    workflowId: string,
    request: string,
  ): Promise<boolean> {
    const pendingJob = this.pendingJobs.get(jobId);
    if (
      !request.trim() ||
      !pendingJob ||
      pendingJob.workflowId !== workflowId ||
      pendingJob.stopping
    ) {
      return Promise.resolve(false);
    }
    const worker = this.workers.get(pendingJob.workerId);
    if (!worker) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSteers.delete(requestId);
        resolve(false);
      }, 5_000);
      this.pendingSteers.set(requestId, {
        jobId,
        workerId: worker.id,
        resolve,
        timer,
      });
      send(worker.socket, {
        type: "steer",
        jobId,
        requestId,
        request: request.trim(),
      });
    });
  }

  private routeWorkflow(
    workflowId: string,
    capabilities: ChatbotWorkerCapability[],
    repository?: string,
  ): WorkerSelectionResult {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return { status: "offline" };
    if (workflow.activeJobId) return { status: "busy" };

    const current = this.workers.get(workflow.workerId);
    if (
      current?.available &&
      supports(current, capabilities) &&
      (!repository || current.repositories.has(repositoryKey(repository)))
    ) {
      return { status: "accepted" };
    }

    const selected = this.selectWorker(capabilities, workflowId, repository);
    if (selected.status !== "accepted") return selected;
    workflow.workerId = selected.worker.id;
    return { status: "accepted" };
  }

  private selectWorker(
    capabilities: ChatbotWorkerCapability[],
    movingWorkflowId?: string,
    repository?: string,
  ):
    | { status: "offline" }
    | { status: "busy" }
    | { status: "accepted"; worker: Worker } {
    const compatible = [...this.workers.values()].filter(
      (worker) =>
        worker.available &&
        supports(worker, capabilities) &&
        (!repository || worker.repositories.has(repositoryKey(repository))),
    );
    if (compatible.length === 0) return { status: "offline" };

    const available = compatible.filter(
      (worker) => this.usedSlots(worker.id, movingWorkflowId) < worker.capacity,
    );
    if (available.length === 0) return { status: "busy" };

    available.sort((left, right) => {
      const priority =
        profilePriority(right.profile) - profilePriority(left.profile);
      if (priority !== 0) return priority;
      const utilization =
        this.usedSlots(left.id, movingWorkflowId) / left.capacity -
        this.usedSlots(right.id, movingWorkflowId) / right.capacity;
      return utilization || left.id.localeCompare(right.id);
    });
    return { status: "accepted", worker: available[0]! };
  }

  private authenticate(socket: Socket, message: MacAgentClientMessage) {
    const policy =
      message.type === "authenticate" ? workerPolicy(message.secret) : null;

    if (
      message.type !== "authenticate" ||
      message.protocolVersion !== CHATBOT_PROTOCOL_VERSION ||
      !policy ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(message.workerId) ||
      (policy.workerId !== undefined && message.workerId !== policy.workerId) ||
      !validRepositories(message.repositories) ||
      (message.chatbotRepository !== undefined &&
        (typeof message.chatbotRepository !== "string" ||
          !message.repositories.some(
            (repository) =>
              repositoryKey(repository) ===
              repositoryKey(message.chatbotRepository!),
          )))
    ) {
      socket.close(4001, "Authentication failed");
      return;
    }

    const oldWorker = this.workers.get(message.workerId);
    if (oldWorker && oldWorker.socket !== socket) {
      this.failPendingJobs(
        oldWorker.id,
        "The Codex worker reconnected while answering.",
      );
      oldWorker.socket.close(4003, "Connection replaced");
    }

    this.clearAuthenticationTimer(socket);
    socket.data.authenticated = true;
    socket.data.workerId = message.workerId;
    const worker: Worker = {
      id: message.workerId,
      socket,
      profile: policy.profile,
      repositories: new Set(message.repositories.map(repositoryKey)),
      repositoryNames: [...message.repositories],
      chatbotRepository: message.chatbotRepository,
      available: false,
      capacity: 1,
      skillbook: undefined,
    };
    this.workers.set(worker.id, worker);
    this.armHeartbeatTimeout(worker);
    send(socket, {
      type: "authenticated",
      protocolVersion: CHATBOT_PROTOCOL_VERSION,
    });
  }

  private finishJob(
    worker: Worker,
    message: Extract<MacAgentClientMessage, { type: "result" }>,
  ) {
    const pendingJob = this.pendingJobs.get(message.jobId);
    if (!pendingJob || pendingJob.workerId !== worker.id) return;

    if (message.ok && !validOutgoingFiles(message.files)) {
      this.deletePendingJob(pendingJob);
      clearTimeout(pendingJob.timer);
      pendingJob.resolve({
        ok: false,
        error: "Worker returned invalid files.",
        failureKind: "internal",
      });
      return;
    }

    this.deletePendingJob(pendingJob);
    clearTimeout(pendingJob.timer);
    pendingJob.resolve(
      message.ok
        ? {
            ok: true,
            content: message.content,
            ...(message.files?.length ? { files: message.files } : {}),
          }
        : {
            ok: false,
            error: message.error,
            failureKind: message.failureKind,
            ...(message.stopped ? { stopped: true } : {}),
          },
    );
  }

  private finishUsageRequest(
    worker: Worker,
    message: Extract<MacAgentClientMessage, { type: "codex_usage_result" }>,
  ) {
    const pending = this.pendingUsageRequests.get(message.requestId);
    if (!pending || pending.workerId !== worker.id) return;
    clearTimeout(pending.timer);
    this.pendingUsageRequests.delete(message.requestId);
    pending.resolve(validCodexUsage(message.usage) ? message.usage : null);
  }

  private failPendingUsageRequests(workerId: string) {
    for (const [requestId, pending] of this.pendingUsageRequests) {
      if (pending.workerId !== workerId) continue;
      clearTimeout(pending.timer);
      this.pendingUsageRequests.delete(requestId);
      pending.resolve(null);
    }
  }

  private failPendingJobs(workerId: string, error: string) {
    for (const pendingJob of this.pendingJobs.values()) {
      if (pendingJob.workerId !== workerId) continue;
      clearTimeout(pendingJob.timer);
      this.deletePendingJob(pendingJob);
      pendingJob.resolve({
        ok: false,
        error,
        failureKind: "unavailable",
      });
    }
  }

  private deletePendingJob(pendingJob: PendingJob) {
    this.pendingJobs.delete(pendingJob.id);
    for (const [requestId, pending] of this.pendingSteers) {
      if (pending.jobId !== pendingJob.id) continue;
      clearTimeout(pending.timer);
      this.pendingSteers.delete(requestId);
      pending.resolve(false);
    }
    if (!pendingJob.workflowId) return;
    const workflow = this.workflows.get(pendingJob.workflowId);
    if (workflow?.activeJobId === pendingJob.id) {
      delete workflow.activeJobId;
    }
  }

  private usedSlots(workerId: string, ignoredWorkflowId?: string) {
    let slots = 0;
    for (const [workflowId, workflow] of this.workflows) {
      if (workflowId !== ignoredWorkflowId && workflow.workerId === workerId) {
        slots += 1;
      }
    }
    for (const pendingJob of this.pendingJobs.values()) {
      if (
        pendingJob.workerId === workerId &&
        (!pendingJob.workflowId || !this.workflows.has(pendingJob.workflowId))
      )
        slots += 1;
    }
    return slots;
  }

  private armHeartbeatTimeout(worker: Worker) {
    this.clearHeartbeatTimeout(worker.socket);
    const timer = setTimeout(() => {
      if (this.workers.get(worker.id)?.socket === worker.socket) {
        worker.socket.close(4004, "Heartbeat timeout");
      }
    }, 45_000);
    this.heartbeatTimers.set(worker.socket, timer);
  }

  private clearAuthenticationTimer(socket: Socket) {
    const timer = this.authenticationTimers.get(socket);
    if (!timer) return;
    clearTimeout(timer);
    this.authenticationTimers.delete(socket);
  }

  private clearHeartbeatTimeout(socket: Socket) {
    const timer = this.heartbeatTimers.get(socket);
    if (!timer) return;
    clearTimeout(timer);
    this.heartbeatTimers.delete(socket);
  }
}

export const macAgentBridge = new MacAgentBridge();

export const macAgentWebSocketHandler = {
  open(socket: Socket) {
    macAgentBridge.open(socket);
  },
  message(socket: Socket, message: string | Buffer) {
    macAgentBridge.message(socket, message);
  },
  close(socket: Socket) {
    macAgentBridge.close(socket);
  },
};
