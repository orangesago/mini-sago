import type {
  ChatbotExecutionRoute,
  ChatbotTraceContext,
  PreservedDeveloperTask,
} from "../../contracts/worker-contract";

export function executionRouteOrChat(
  route: ChatbotExecutionRoute | "unclear",
): ChatbotExecutionRoute {
  return route === "unclear" ? "chat" : route;
}

export function parsePreviousTraceLookup(content: string): {
  status: "complete" | "not_found" | "unavailable";
  trace?: ChatbotTraceContext;
  developerTask?: PreservedDeveloperTask;
} {
  try {
    const payload = JSON.parse(content) as {
      status?: unknown;
      trace?: unknown;
      developerTask?: Partial<PreservedDeveloperTask>;
    };
    const task = payload.developerTask;
    const developerTask =
      task &&
      typeof task.id === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(task.id) &&
      task.id !== "." &&
      task.id !== ".." &&
      typeof task.requesterUserId === "string" &&
      typeof task.repository === "string" &&
      typeof task.request === "string" &&
      (task.title === undefined || typeof task.title === "string") &&
      (task.resumeSessionId === undefined ||
        typeof task.resumeSessionId === "string")
        ? {
            id: task.id,
            requesterUserId: task.requesterUserId,
            repository: task.repository,
            request: task.request,
            ...(task.title ? { title: task.title } : {}),
            ...(task.resumeSessionId
              ? { resumeSessionId: task.resumeSessionId }
              : {}),
          }
        : undefined;
    if (payload.status === "not_found")
      return {
        status: "not_found",
        ...(developerTask ? { developerTask } : {}),
      };
    if (
      payload.status !== "complete" ||
      !payload.trace ||
      typeof payload.trace !== "object"
    ) {
      return { status: "unavailable" };
    }
    const trace = payload.trace as Partial<ChatbotTraceContext>;
    if (
      typeof trace.contextMessageCount !== "number" ||
      typeof trace.searchResultCount !== "number" ||
      typeof trace.elapsedMs !== "number" ||
      !Array.isArray(trace.searchQueries) ||
      !Array.isArray(trace.memberQueries)
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "complete",
      trace: trace as ChatbotTraceContext,
      ...(developerTask ? { developerTask } : {}),
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function parseExecutionRoute(
  content: string,
  availableRepositories: string[] = [],
): {
  route: ChatbotExecutionRoute | "unclear";
  repository?: string;
  threadTitle?: string;
} {
  const advertisedRepositories = new Map(
    availableRepositories.map((repository) => [
      repository.toLocaleLowerCase("en-US"),
      repository,
    ]),
  );

  try {
    const normalized = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    const payload = JSON.parse(normalized) as {
      route?: unknown;
      repository?: unknown;
      threadTitle?: unknown;
    };
    if (
      ["chat", "mac", "oracle", "unclear"].includes(payload.route as string)
    ) {
      const route = payload.route as ChatbotExecutionRoute | "unclear";
      const repository =
        typeof payload.repository === "string"
          ? advertisedRepositories.get(
              payload.repository.toLocaleLowerCase("en-US"),
            )
          : undefined;
      const threadTitle =
        typeof payload.threadTitle === "string"
          ? payload.threadTitle.replace(/\s+/gu, " ").trim().slice(0, 100)
          : undefined;
      return {
        route,
        ...(route === "oracle" && repository ? { repository } : {}),
        ...(route === "oracle" && threadTitle ? { threadTitle } : {}),
      };
    }
  } catch {
    // Fall through to the deterministic safety net.
  }

  return {
    route: "unclear",
  };
}

export function missingDeveloperRepositoryResponse(
  route: ChatbotExecutionRoute | "unclear",
  repository?: string,
  availableRepositories: string[] = [],
) {
  if (route !== "oracle" || repository) return undefined;
  const choices =
    availableRepositories.length > 0
      ? `\n目前可用的有 ${availableRepositories.map((value) => `\`${value}\``).join(" ")}`
      : "";
  return `這題要碰程式碼 但我還不知道是哪個 GitHub repo${choices}\n告訴我是哪個 我就能繼續`;
}
