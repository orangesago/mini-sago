import { timing, type TimingSink } from "../../src/observability/timing";
import type {
  ChatbotMcpTraceCall,
  ChatbotTaskProgress,
} from "../../contracts/worker-contract";

const SESSION_IDLE_TTL_MS = 3 * 24 * 60 * 60_000;

type JsonObject = Record<string, unknown>;

type RunOptions = {
  jobId: string;
  taskId: string;
  resumeThreadId?: string;
  title?: string;
  command: string[];
  cwd: string;
  processCwd?: string;
  environment: Record<string, string>;
  model: string;
  effort: string;
  developerInstructions: string;
  prompt: string;
  imagePaths: string[];
  outputSchema?: JsonObject;
  ephemeral?: boolean;
  failOnSandboxError?: boolean;
  permissions?: string;
  warm?: boolean;
  threadConfig?: JsonObject;
  onTiming?: TimingSink;
  onAgentMessageDelta?: (delta: string) => void;
  onProgress?: (progress: ChatbotTaskProgress) => void;
  onMcpToolCall?: (call: ChatbotMcpTraceCall) => void;
  signal?: AbortSignal;
};

type ActiveTurn = {
  jobId: string;
  turnId?: string;
  finalAnswer: string;
  sandboxError?: string;
  failOnSandboxError?: boolean;
  lastAgentMessage: string;
  onAgentMessageDelta?: RunOptions["onAgentMessageDelta"];
  onProgress?: RunOptions["onProgress"];
  onMcpToolCall?: RunOptions["onMcpToolCall"];
  resolve: (content: string) => void;
  reject: (error: Error) => void;
};

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        const item = record(entry);
        return typeof item?.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function errorMessage(value: unknown, fallback: string) {
  const error = record(value);
  return typeof error?.message === "string" ? error.message : fallback;
}

export function isSuccessfulPullRequestMerge(item: JsonObject) {
  if (item.type !== "commandExecution") return false;
  const command = text(item.command);
  return (
    item.status === "completed" &&
    item.exitCode === 0 &&
    /(?:^|[\s"'=\/])gh\s+pr\s+merge(?:\s|$)/u.test(command)
  );
}

class CodexTurnInterruptedError extends Error {}

class CodexAppServerSession {
  private active?: ActiveTurn;
  private onTiming?: TimingSink;
  private buffer = "";
  private child: Bun.PipedSubprocess;
  private exited = false;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: JsonObject) => void; reject: (error: Error) => void }
  >();
  private ready: Promise<void>;
  private stderr = "";
  private threadId?: string;
  private readonly startedAt = performance.now();

  constructor(private readonly options: RunOptions) {
    this.onTiming = options.onTiming;
    timing(this.onTiming).mark("codex.spawn");
    this.child = Bun.spawn(options.command, {
      cwd: options.processCwd ?? options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: options.environment,
    });
    void this.readOutput();
    void this.readErrors();
    void this.watchExit();
    this.ready = this.initialize();
  }

  async prepare() {
    await this.ready;
  }

  get pid() {
    return this.child.pid;
  }

  async runFresh(options: RunOptions) {
    await this.ready;
    this.onTiming = options.onTiming;
    if (options.signal?.aborted)
      throw new CodexTurnInterruptedError("Request cancelled.");
    const clock = timing(this.onTiming);
    const done = clock.start("warm.thread_start");
    try {
      const response = await this.request("thread/start", {
        model: options.model,
        cwd: options.cwd,
        approvalPolicy: "never",
        developerInstructions: options.developerInstructions,
        serviceName: "minisago",
        // Persist only until thread/delete can synchronously release this session.
        ephemeral: false,
        config: options.threadConfig,
      });
      const thread = record(response.thread);
      if (typeof thread?.id !== "string")
        throw new Error("Missing fresh thread ID.");
      this.threadId = thread.id;
      done();
      clock.mark("codex.thread.started");
      return await this.run(options);
    } finally {
      const threadId = this.threadId;
      this.threadId = undefined;
      if (threadId) {
        const cleanup = clock.start("warm.thread_delete");
        try {
          await this.request("thread/delete", { threadId });
        } catch {
          this.close();
        } finally {
          cleanup();
        }
      }
      this.onTiming = undefined;
    }
  }

  async run(options: RunOptions) {
    await this.ready;
    if (options.signal?.aborted)
      throw new CodexTurnInterruptedError("Request cancelled.");
    if (this.active)
      throw new Error("Codex thread already has an active turn.");
    const input: JsonObject[] = [{ type: "text", text: options.prompt }];
    input.push(
      ...options.imagePaths.map((path) => ({ type: "localImage", path })),
    );

    let resolveResult!: (content: string) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // A failed turn/start RPC can reject the turn before its result is awaited.
    void result.catch(() => undefined);
    this.active = {
      jobId: options.jobId,
      finalAnswer: "",
      failOnSandboxError: options.failOnSandboxError,
      lastAgentMessage: "",
      onAgentMessageDelta: options.onAgentMessageDelta,
      onProgress: options.onProgress,
      onMcpToolCall: options.onMcpToolCall,
      resolve: resolveResult,
      reject: rejectResult,
    };
    const interrupt = () => void this.interrupt(options.jobId);
    options.signal?.addEventListener("abort", interrupt, { once: true });

    try {
      timing(this.onTiming).mark("codex.turn.started");
      const response = await this.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: "never",
        model: options.model,
        effort: options.effort,
        summary: "detailed",
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      const turn = record(response.turn);
      if (!turn || typeof turn.id !== "string") {
        throw new Error("Codex App Server did not return a turn ID.");
      }
      if (this.active?.jobId === options.jobId) this.active.turnId = turn.id;
      if (options.signal?.aborted) await this.interrupt(options.jobId);
      return await result;
    } catch (error) {
      if (this.active?.jobId === options.jobId) {
        this.active = undefined;
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", interrupt);
    }
  }

  async steer(jobId: string, input: string) {
    await this.ready;
    const active = this.active;
    if (active?.jobId !== jobId || !active.turnId) return false;
    const response = await this.request("turn/steer", {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      expectedTurnId: active.turnId,
    });
    return response.turnId === active.turnId;
  }

  async interrupt(jobId: string) {
    await this.ready.catch(() => undefined);
    const active = this.active;
    if (active?.jobId !== jobId || !active.turnId) return false;
    await this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: active.turnId,
    });
    return true;
  }

  close() {
    this.exited = true;
    this.child.kill();
  }

  isHealthy() {
    return !this.exited;
  }

  private async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "minisago", title: "MiniSago", version: "1" },
      ...(this.options.permissions
        ? { capabilities: { experimentalApi: true } }
        : {}),
    });
    this.options.onProgress?.({
      phase: "preparing",
      summary: "Codex process ready.",
      timing: {
        stage: "Process startup",
        durationMs: performance.now() - this.startedAt,
      },
    });
    this.notify("initialized", {});
    timing(this.onTiming).mark("warm.process_ready");
    if (this.options.warm) return;
    const threadStartedAt = performance.now();
    const threadOptions = {
      model: this.options.model,
      cwd: this.options.cwd,
      config: this.options.threadConfig,
      ...(this.options.permissions
        ? { permissions: this.options.permissions }
        : {}),
      approvalPolicy: "never",
      developerInstructions: this.options.developerInstructions,
    };
    const response = await this.request(
      this.options.resumeThreadId ? "thread/resume" : "thread/start",
      this.options.resumeThreadId
        ? { ...threadOptions, threadId: this.options.resumeThreadId }
        : { ...threadOptions, serviceName: "minisago" },
    );
    const thread = record(response.thread);
    if (!thread || typeof thread.id !== "string") {
      throw new Error("Codex App Server did not return a thread ID.");
    }
    this.threadId = thread.id;
    this.options.onProgress?.({
      phase: "preparing",
      summary: "Codex thread started.",
      timing: {
        stage: "Thread setup",
        durationMs: performance.now() - threadStartedAt,
      },
      sessionId: thread.id,
    });
    if (this.options.title) {
      await this.request("thread/name/set", {
        threadId: thread.id,
        name: this.options.title,
      });
    }
  }

  private request(method: string, params: JsonObject) {
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ method, id, params });
    let timer: ReturnType<typeof setTimeout>;
    const bounded = Promise.race([
      response,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex RPC timed out: ${method}`));
        }, 30000);
      }),
    ]);
    return bounded.finally(() => clearTimeout(timer));
  }

  private notify(method: string, params: JsonObject) {
    this.write({ method, params });
  }

  private write(message: JsonObject) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readOutput() {
    const reader = this.child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.handleMessage(line);
        newline = this.buffer.indexOf("\n");
      }
    }
  }

  private async readErrors() {
    const stderr = await new Response(this.child.stderr).text();
    this.stderr = stderr.trim().slice(-2_000);
  }

  private async watchExit() {
    const exitCode = await this.child.exited;
    this.exited = true;
    const error = new Error(
      this.stderr || `Codex App Server exited with status ${exitCode}.`,
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.active?.reject(error);
    this.active = undefined;
  }

  private handleMessage(line: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(errorMessage(message.error, "Codex App Server failed.")),
        );
      } else {
        pending.resolve(record(message.result) ?? {});
      }
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, record(message.params) ?? {});
    }
  }

  private handleNotification(method: string, params: JsonObject) {
    const active = this.active;
    if (!active) return;
    if (
      typeof params.threadId === "string" &&
      params.threadId !== this.threadId
    )
      return;
    const turnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof record(params.turn)?.id === "string"
          ? (record(params.turn)!.id as string)
          : undefined;
    if (active.turnId && turnId && active.turnId !== turnId) return;

    if (method === "item/started") {
      const item = record(params.item);
      if (item?.type === "commandExecution") {
        const command = text(item.command);
        active.onProgress?.(
          /\b(?:test|check|build|lint|typecheck|pytest)\b/iu.test(command)
            ? { phase: "testing", summary: "Running repository checks." }
            : { phase: "exploring", summary: "Inspecting the repository." },
        );
      }
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (typeof params.delta === "string" && params.delta) {
        active.onAgentMessageDelta?.(params.delta);
      }
      return;
    }

    if (method === "item/completed") {
      this.handleCompletedItem(active, record(params.item));
      return;
    }
    if (method !== "turn/completed") return;

    timing(this.onTiming).mark("codex.turn.completed");
    const turn = record(params.turn);
    const status = turn?.status;
    this.active = undefined;
    if (status === "completed") {
      const answer = active.finalAnswer || active.lastAgentMessage;
      if (active.sandboxError) active.reject(new Error(active.sandboxError));
      else if (answer.trim()) active.resolve(answer.trim());
      else active.reject(new Error("Codex returned no final answer."));
    } else if (status === "interrupted") {
      active.reject(
        new CodexTurnInterruptedError(
          "Codex request was cancelled or timed out.",
        ),
      );
    } else {
      active.reject(new Error(errorMessage(turn?.error, "Codex turn failed.")));
    }
  }

  private handleCompletedItem(active: ActiveTurn, item?: JsonObject) {
    if (!item || typeof item.type !== "string") return;
    if (item.type === "commandExecution" && item.exitCode !== 0) {
      const output = text(item.aggregatedOutput);
      if (
        active.failOnSandboxError &&
        /bwrap:|synthetic (?:bubblewrap mount target|mount registry)|sandbox.*(?:panic|failed to)/iu.test(
          output,
        )
      ) {
        active.sandboxError = `Coding sandbox failed: ${output.trim().slice(-1000)}`;
      }
      if (active.failOnSandboxError)
        active.onMcpToolCall?.({
          name: "command_execution",
          arguments: { exitCode: item.exitCode },
          status: "failed",
        });
      if (active.sandboxError)
        active.onProgress?.({
          phase: "testing",
          kind: "trace",
          summary: "The coding environment is blocked by a sandbox failure.",
        });
    }
    if (isSuccessfulPullRequestMerge(item)) {
      active.onProgress?.({
        phase: "reviewing",
        summary: "Pull request merged.",
        completion: "pull_request_merged",
      });
      return;
    }
    if (item.type === "reasoning") {
      return;
    }
    if (item.type === "agentMessage") {
      timing(this.onTiming).mark("codex.item.completed.agent_message");
      const message = text(item.text).trim();
      if (!message) return;
      active.lastAgentMessage = message;
      if (item.phase === "final_answer") {
        active.finalAnswer = message;
      } else {
        active.onProgress?.({
          phase: "reviewing",
          summary: message.slice(0, 2_000),
          kind: "trace",
        });
      }
      return;
    }
    if (item.type === "plan") {
      const plan = text(item.text).trim();
      if (plan) {
        active.onProgress?.({
          phase: "exploring",
          summary: plan.slice(0, 2_000),
          kind: "trace",
        });
      }
      return;
    }
    if (item.type === "fileChange") {
      active.onProgress?.({
        phase: "implementing",
        summary: "Updated the working tree.",
      });
      return;
    }
    if (item.type !== "mcpToolCall" || item.server !== "minisago") return;
    if (typeof item.tool !== "string") return;
    active.onMcpToolCall?.({
      name: item.tool.slice(0, 100),
      arguments: record(item.arguments) ?? {},
      ...(typeof item.status === "string"
        ? { status: item.status.slice(0, 30) }
        : {}),
    });
  }
}

export class CodexAppServerManager {
  private warmSession?: CodexAppServerSession;
  private warmBusy = false;
  private warmKey?: string;

  warmStatus() {
    return {
      pid: this.warmSession?.pid,
      healthy: this.warmSession?.isHealthy() ?? false,
      busy: this.warmBusy,
    };
  }

  async prewarm(options: RunOptions) {
    if (this.warmBusy || this.warmSession?.isHealthy()) return;
    this.warmBusy = true;
    try {
      this.warmSession = new CodexAppServerSession({ ...options, warm: true });
      this.warmKey = JSON.stringify([options.command, options.environment]);
      await this.warmSession.prepare();
    } catch (error) {
      this.warmSession?.close();
      this.warmSession = undefined;
      throw error;
    } finally {
      this.warmBusy = false;
    }
  }

  async runWarm(options: RunOptions): Promise<string | undefined> {
    if (this.warmBusy) return undefined;
    this.warmBusy = true;
    const key = JSON.stringify([options.command, options.environment]);
    try {
      if (!this.warmSession?.isHealthy() || this.warmKey !== key) {
        this.warmSession?.close();
        this.warmSession = new CodexAppServerSession({
          ...options,
          warm: true,
        });
        this.warmKey = key;
      }
      this.jobs.set(options.jobId, this.warmSession);
      return await this.warmSession.runFresh(options);
    } catch (error) {
      this.warmSession?.close();
      this.warmSession = undefined;
      throw error;
    } finally {
      this.jobs.delete(options.jobId);
      this.warmBusy = false;
    }
  }

  private jobs = new Map<string, CodexAppServerSession>();
  private sessions = new Map<string, CodexAppServerSession>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async run(options: RunOptions) {
    if (options.ephemeral) {
      const session = new CodexAppServerSession(options);
      this.jobs.set(options.jobId, session);
      const abort = () => session.close();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        return await session.run(options);
      } finally {
        options.signal?.removeEventListener("abort", abort);
        this.jobs.delete(options.jobId);
        session.close();
      }
    }

    this.clearTimer(options.taskId);
    let session = this.sessions.get(options.taskId);
    if (!session) {
      session = new CodexAppServerSession(options);
      this.sessions.set(options.taskId, session);
    }
    this.jobs.set(options.jobId, session);
    try {
      return await session.run(options);
    } catch (error) {
      if (!(error instanceof CodexTurnInterruptedError)) {
        if (this.sessions.get(options.taskId) === session) {
          this.sessions.delete(options.taskId);
        }
        session.close();
      }
      throw error;
    } finally {
      this.jobs.delete(options.jobId);
      if (this.sessions.get(options.taskId) === session) {
        this.scheduleClose(options.taskId, session);
      }
    }
  }

  async steer(jobId: string, request: string) {
    return (await this.jobs.get(jobId)?.steer(jobId, request)) ?? false;
  }

  async interrupt(jobId: string) {
    return (await this.jobs.get(jobId)?.interrupt(jobId)) ?? false;
  }

  status() {
    const sessions = [...this.sessions.values()];
    return {
      ok: sessions.every((session) => session.isHealthy()),
      sessions: sessions.length,
      active: this.jobs.size,
    };
  }

  close() {
    this.warmSession?.close();
    this.warmSession = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const session of new Set([
      ...this.sessions.values(),
      ...this.jobs.values(),
    ])) {
      session.close();
    }
    this.timers.clear();
    this.jobs.clear();
    this.sessions.clear();
  }

  private clearTimer(taskId: string) {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
  }

  private scheduleClose(taskId: string, session: CodexAppServerSession) {
    const timer = setTimeout(() => {
      if (this.sessions.get(taskId) === session) {
        this.sessions.delete(taskId);
        session.close();
      }
      this.timers.delete(taskId);
    }, SESSION_IDLE_TTL_MS);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }
}
