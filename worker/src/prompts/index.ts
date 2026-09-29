import type { CodexJob } from "../../../contracts/worker-contract";
import {
  ARTIFACT_ANSWER_OUTPUT_SCHEMA,
  ANSWER_OUTPUT_SCHEMA,
  ANSWER_TASK_INSTRUCTION,
  buildAnswerDeveloperInstructions,
  CODEX_THREAD_TASK_INSTRUCTION,
  MAC_FILE_ANSWER_OUTPUT_SCHEMA,
  PROMPT_VERSION,
  VOICE_ANSWER_OUTPUT_SCHEMA,
} from "./answer";
import { answerContext } from "./context";
import {
  executionRouteContext,
  EXECUTION_ROUTE_INSTRUCTIONS,
  EXECUTION_ROUTE_TASK_INSTRUCTION,
  EXECUTION_ROUTE_OUTPUT_SCHEMA,
} from "./execution-route";
import {
  socialActionContext,
  SOCIAL_ACTION_INSTRUCTIONS,
  SOCIAL_ACTION_TASK_INSTRUCTION,
  SOCIAL_ACTION_OUTPUT_SCHEMA,
} from "./social-action";

export {
  ARTIFACT_ANSWER_OUTPUT_SCHEMA,
  ANSWER_OUTPUT_SCHEMA,
  MAC_FILE_ANSWER_OUTPUT_SCHEMA,
  PROMPT_VERSION,
  VOICE_ANSWER_OUTPUT_SCHEMA,
} from "./answer";
export { EXECUTION_ROUTE_OUTPUT_SCHEMA } from "./execution-route";
export { SOCIAL_ACTION_OUTPUT_SCHEMA } from "./social-action";

export const PROMPT_PLAN_VERSIONS = {
  policy: 12,
  task: 3,
  context: 8,
} as const;

export type PromptPlan = {
  versions: typeof PROMPT_PLAN_VERSIONS;
  developerInstructions: string;
  taskInstruction: string;
  context: string;
  telemetry: {
    promptVersion: number;
    purpose: CodexJob["purpose"];
    developerCharacters: number;
    taskCharacters: number;
    contextCharacters: number;
  };
};

function promptPlan(
  purpose: CodexJob["purpose"],
  developerInstructions: string,
  taskInstruction: string,
  context: string,
): PromptPlan {
  return {
    versions: PROMPT_PLAN_VERSIONS,
    developerInstructions,
    taskInstruction,
    context,
    telemetry: {
      promptVersion: PROMPT_VERSION,
      purpose,
      developerCharacters: developerInstructions.length,
      taskCharacters: taskInstruction.length,
      contextCharacters: context.length,
    },
  };
}

export function buildPromptPlan(
  job: CodexJob,
  attachmentText: string[],
  ignoredAttachments: string[],
  developerPolicy?: string,
  macFileRoots: string[] = [],
): PromptPlan {
  if (job.purpose === "execution_route") {
    return promptPlan(
      "execution_route",
      EXECUTION_ROUTE_INSTRUCTIONS,
      EXECUTION_ROUTE_TASK_INSTRUCTION,
      executionRouteContext(job),
    );
  }
  if (job.purpose === "social_action") {
    return promptPlan(
      "social_action",
      SOCIAL_ACTION_INSTRUCTIONS,
      SOCIAL_ACTION_TASK_INSTRUCTION,
      socialActionContext(job),
    );
  }
  return promptPlan(
    "answer",
    buildAnswerDeveloperInstructions(job, developerPolicy, macFileRoots),
    job.developerTask ? CODEX_THREAD_TASK_INSTRUCTION : ANSWER_TASK_INSTRUCTION,
    answerContext(job, attachmentText, ignoredAttachments),
  );
}

export function buildCodexPrompt(
  job: CodexJob,
  attachmentText: string[],
  ignoredAttachments: string[],
  developerPolicy?: string,
  macFileRoots: string[] = [],
) {
  const plan = buildPromptPlan(
    job,
    attachmentText,
    ignoredAttachments,
    developerPolicy,
    macFileRoots,
  );
  return [plan.developerInstructions, plan.taskInstruction, plan.context].join(
    "\n\n",
  );
}

export function outputSchemaForJob(job: CodexJob) {
  if (job.purpose === "execution_route") return EXECUTION_ROUTE_OUTPUT_SCHEMA;
  if (job.purpose === "social_action") return SOCIAL_ACTION_OUTPUT_SCHEMA;
  if (job.purpose === "answer") {
    if (job.developerTask) return undefined;
    if (job.streamReply) return VOICE_ANSWER_OUTPUT_SCHEMA;
    if (job.executionRoute === "mac") return MAC_FILE_ANSWER_OUTPUT_SCHEMA;
    return job.executionRoute === "oracle"
      ? ANSWER_OUTPUT_SCHEMA
      : ARTIFACT_ANSWER_OUTPUT_SCHEMA;
  }
  return undefined;
}
