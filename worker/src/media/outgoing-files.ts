import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import {
  CHATBOT_OUTGOING_FILE_LIMITS,
  type ChatbotOutgoingFile,
} from "../../../contracts/worker-contract";

const MAX_OUTGOING_FILE_BYTES = CHATBOT_OUTGOING_FILE_LIMITS.bytes;
const artifactIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/u;
const generatedArtifactIdPattern = /^(?:media|python)-/u;
const generatedArtifactExtensions = new Set([
  ".csv",
  ".docx",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".png",
  ".pdf",
  ".txt",
  ".webp",
  ".xlsx",
  ".zip",
]);

const contentTypes = new Map([
  [".csv", "text/csv"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".zip", "application/zip"],
]);

function inside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function requestedFilePaths(content: string) {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const files = Array.isArray(value.files)
      ? value.files.filter((path): path is string => typeof path === "string")
      : [];
    delete value.files;
    return { content: JSON.stringify(value), files: files.slice(0, 1) };
  } catch {
    return { content, files: [] };
  }
}

export function requestedArtifactIds(content: string) {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const artifacts = Array.isArray(value.artifacts)
      ? value.artifacts.filter(
          (id): id is string =>
            typeof id === "string" &&
            id !== "." &&
            id !== ".." &&
            artifactIdPattern.test(id) &&
            generatedArtifactIdPattern.test(id) &&
            generatedArtifactExtensions.has(extname(id).toLocaleLowerCase()),
        )
      : [];
    delete value.artifacts;
    return { content: JSON.stringify(value), artifacts: artifacts.slice(0, 1) };
  } catch {
    return { content, artifacts: [] };
  }
}

async function readOutgoingFile(path: string): Promise<ChatbotOutgoingFile> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Outgoing path is not a regular file.");
  if (info.size > MAX_OUTGOING_FILE_BYTES) {
    throw new Error("Outgoing file exceeds Discord's 8 MB upload limit.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_OUTGOING_FILE_BYTES) {
    throw new Error("Outgoing file exceeds Discord's 8 MB upload limit.");
  }
  return {
    filename: basename(path).slice(0, 255),
    contentType:
      contentTypes.get(extname(path).toLocaleLowerCase()) ||
      "application/octet-stream",
    size: bytes.byteLength,
    data: bytes.toString("base64"),
  };
}

export async function prepareOutgoingFiles(
  content: string,
  allowedRoots: string[],
): Promise<{ content: string; files: ChatbotOutgoingFile[] }> {
  const requested = requestedFilePaths(content);
  const roots = await Promise.all(
    allowedRoots.map((root) => realpath(root).catch(() => resolve(root))),
  );
  const files: ChatbotOutgoingFile[] = [];

  for (const requestedPath of requested.files) {
    if (!isAbsolute(requestedPath)) {
      throw new Error("Outgoing file path must be absolute.");
    }
    const path = await realpath(requestedPath);
    if (!roots.some((root) => inside(root, path))) {
      throw new Error(
        "Outgoing file is outside the configured Mac file folders.",
      );
    }
    files.push(await readOutgoingFile(path));
  }

  return { content: requested.content, files };
}

export async function prepareGeneratedArtifacts(
  content: string,
  outputRoot: string,
): Promise<{ content: string; files: ChatbotOutgoingFile[] }> {
  const requested = requestedArtifactIds(content);
  const root = await realpath(outputRoot);
  const files: ChatbotOutgoingFile[] = [];

  for (const artifact of requested.artifacts) {
    const path = await realpath(resolve(root, artifact));
    if (!inside(root, path)) {
      throw new Error(
        "Generated artifact is outside the request output folder.",
      );
    }
    if (!generatedArtifactExtensions.has(extname(path).toLocaleLowerCase())) {
      throw new Error("Generated artifact has an unsupported output type.");
    }
    files.push(await readOutgoingFile(path));
  }

  return { content: requested.content, files };
}

function markdownCodeRanges(content: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  let fence: { start: number; marker: string } | undefined;
  let offset = 0;
  for (const line of content.split(/(?<=\n)/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (marker) {
      if (!fence) fence = { start: offset, marker: marker[1]! };
      else if (
        marker[1]![0] === fence.marker[0] &&
        marker[1]!.length >= fence.marker.length &&
        !line.slice(marker[0].length).trim()
      ) {
        ranges.push({ start: fence.start, end: offset + line.length });
        fence = undefined;
      }
    }
    offset += line.length;
  }
  if (fence) ranges.push({ start: fence.start, end: content.length });
  for (const match of content.matchAll(/(`+)[\s\S]*?\1(?!`)/gu)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function isImage(file: ChatbotOutgoingFile) {
  const bytes = Buffer.from(file.data, "base64");
  switch (file.contentType) {
    case "image/png":
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case "image/gif":
      return /^(?:GIF87a|GIF89a)$/u.test(
        bytes.subarray(0, 6).toString("ascii"),
      );
    case "image/webp":
      return (
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
    default:
      return false;
  }
}

/** Upload only image references explicitly included in a coding task's final answer. */
export async function prepareDeveloperImages(
  content: string,
  workspaceRoot: string,
  outputRoot: string,
): Promise<{ content: string; files: ChatbotOutgoingFile[] }> {
  const roots = await Promise.all(
    [workspaceRoot, outputRoot].map((root) => realpath(root)),
  );
  const codeRanges = markdownCodeRanges(content);
  const files: ChatbotOutgoingFile[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let totalBytes = 0;
  let offset = 0;
  let response = "";
  const images =
    /(?<!\\)!\[((?:\\.|[^\]\\])*)\]\((?:<([^>\r\n]+)>|((?:\\.|[^\s)])+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\)/gu;
  for (const match of content.matchAll(images)) {
    if (
      codeRanges.some(
        ({ start, end }) => match.index >= start && match.index < end,
      )
    )
      continue;
    const requestedPath = (match[2] ?? match[3]!).replace(
      /\\([\\()[\] ])/gu,
      "$1",
    );
    // Remote references stay in the answer; this transport never fetches URLs.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(requestedPath)) continue;
    const caption = match[1]!.replace(/\\([\\\[\]])/gu, "$1").trim();
    response += content.slice(offset, match.index) + caption;
    offset = match.index + match[0].length;
    let failure = "the local image could not be read";
    try {
      const path = await realpath(resolve(workspaceRoot, requestedPath));
      if (!roots.some((root) => inside(root, path))) {
        failure =
          "the image is outside this task's repository and output folder";
        throw new Error(failure);
      }
      if (seen.has(path)) continue;
      seen.add(path);
      if (files.length >= CHATBOT_OUTGOING_FILE_LIMITS.count) {
        failure = "at most 10 images can be attached";
        throw new Error(failure);
      }
      const info = await stat(path);
      if (info.size + totalBytes > CHATBOT_OUTGOING_FILE_LIMITS.bytes) {
        failure = "the combined image upload exceeds 8 MB";
        throw new Error(failure);
      }
      const file = await readOutgoingFile(path);
      if (!isImage(file)) {
        failure = "only PNG, JPEG, GIF, and WebP images can be attached";
        throw new Error(failure);
      }
      if (file.size + totalBytes > CHATBOT_OUTGOING_FILE_LIMITS.bytes) {
        failure = "the combined image upload exceeds 8 MB";
        throw new Error(failure);
      }
      const originalFilename = file.filename;
      for (
        let index = 2;
        files.some((existing) => existing.filename === file.filename);
        index++
      ) {
        file.filename = `${index}-${originalFilename}`.slice(0, 255);
      }
      files.push(file);
      totalBytes += file.size;
    } catch {
      warnings.push(
        `Image attachment unavailable${caption ? ` (${caption.slice(0, 120)})` : ""}: ${failure}.`,
      );
    }
  }
  response += content.slice(offset);
  return {
    content: [response.trim(), ...new Set(warnings)]
      .filter(Boolean)
      .join("\n\n"),
    files,
  };
}

export const outgoingFileLimits = {
  count: 1,
  bytes: MAX_OUTGOING_FILE_BYTES,
};
