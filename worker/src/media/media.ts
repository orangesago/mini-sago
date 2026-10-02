import { randomUUID } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import {
  mediaContentType,
  type MediaClient,
  type RemoteMedia,
} from "./media-client";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 8_192;
const MAX_PIXELS = 40_000_000;
const MAX_DURATION_SECONDS = 600;
const COMMAND_TIMEOUT_MS = 45_000;

const manifestSchema = z.object({
  version: z.literal(1),
  root: z.string().min(1),
  outputDirectory: z.string().min(1),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        filename: z.string().min(1).max(255),
        contentType: z.string().max(100).optional(),
        size: z.number().int().nonnegative().max(MAX_INPUT_BYTES),
        storedFilename: z.string().min(1).max(255),
      }),
    )
    .max(10),
});

export type MediaManifest = z.infer<typeof manifestSchema>;

type CommandResult = { stdout: string; stderr: string };
export type MediaCommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
};

type ProbeOutput = {
  format?: { duration?: string; size?: string; format_name?: string };
  streams?: ProbeStream[];
};

function inside(root: string, candidate: string) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

async function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  const timeout = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) {
    throw new Error(stderr.trim().slice(0, 1_000) || "Media command failed.");
  }
  return { stdout, stderr };
}

function number(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function publicProbe(probe: ProbeOutput) {
  return {
    format: probe.format?.format_name,
    durationSeconds: number(probe.format?.duration),
    size: number(probe.format?.size),
    streams: (probe.streams ?? []).slice(0, 8).map((stream) => ({
      type: stream.codec_type,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      frameRate: stream.r_frame_rate,
      channels: stream.channels,
      sampleRate: number(stream.sample_rate),
    })),
  };
}

function validateProbe(probe: ProbeOutput) {
  if (!probe.streams?.length)
    throw new Error("Attachment has no media streams.");
  const duration = number(probe.format?.duration);
  if (duration !== undefined && duration > MAX_DURATION_SECONDS) {
    throw new Error("Media duration exceeds 10 minutes.");
  }
  for (const stream of probe.streams) {
    const width = stream.width ?? 0;
    const height = stream.height ?? 0;
    if (
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      width * height > MAX_PIXELS
    ) {
      throw new Error("Media dimensions exceed the processing limit.");
    }
  }
}

function imageExtension(format: "jpeg" | "png" | "webp") {
  return format === "jpeg" ? "jpg" : format;
}

function imageFilters(input: {
  width?: number;
  height?: number;
  fit: "contain" | "cover" | "stretch";
  rotate: 0 | 90 | 180 | 270;
}) {
  const filters: string[] = [];
  if (input.width && input.height) {
    if (input.fit === "cover") {
      filters.push(
        `scale=${input.width}:${input.height}:force_original_aspect_ratio=increase`,
        `crop=${input.width}:${input.height}`,
      );
    } else if (input.fit === "contain") {
      filters.push(
        `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease`,
      );
    } else {
      filters.push(`scale=${input.width}:${input.height}`);
    }
  } else if (input.width) {
    filters.push(`scale=${input.width}:-2`);
  } else if (input.height) {
    filters.push(`scale=-2:${input.height}`);
  }
  if (input.rotate === 90) filters.push("transpose=1");
  if (input.rotate === 180) filters.push("hflip", "vflip");
  if (input.rotate === 270) filters.push("transpose=2");
  return filters;
}

export class MediaProcessor {
  private readonly remoteAssets = new Map<
    string,
    Omit<RemoteMedia, "bytes"> & { path: string; size: number }
  >();

  private constructor(
    private readonly manifest: MediaManifest,
    private readonly runner: MediaCommandRunner,
    private readonly idFactory: () => string,
    private readonly mediaClient?: MediaClient,
  ) {}

  static async create(
    value: unknown,
    options: {
      runner?: MediaCommandRunner;
      idFactory?: () => string;
      mediaClient?: MediaClient;
    } = {},
  ) {
    const manifest = manifestSchema.parse(value);
    const root = await realpath(manifest.root);
    const outputDirectory = await realpath(manifest.outputDirectory);
    if (!inside(root, outputDirectory)) {
      throw new Error("Media output folder is outside the request root.");
    }
    return new MediaProcessor(
      { ...manifest, root, outputDirectory },
      options.runner ?? runCommand,
      options.idFactory ?? randomUUID,
      options.mediaClient,
    );
  }

  static async fromFile(path: string, mediaClient?: MediaClient) {
    return MediaProcessor.create(JSON.parse(await readFile(path, "utf8")), {
      mediaClient,
    });
  }

  async download(mediaId: string) {
    const attachment = await this.attachment(mediaId);
    return {
      mediaId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      path: attachment.path,
    };
  }

  private async attachment(id: string) {
    const attachment = this.manifest.attachments.find((item) => item.id === id);
    if (!attachment) {
      const cached = this.remoteAssets.get(id);
      if (cached) return cached;
      if (!this.mediaClient)
        throw new Error("Media is unavailable for this request.");
      const remote = await this.mediaClient.read(id);
      if (
        !remote.bytes.byteLength ||
        remote.bytes.byteLength > MAX_INPUT_BYTES
      ) {
        throw new Error("Media exceeds the processing limit.");
      }
      const extension = extname(basename(remote.filename))
        .replace(/[^A-Za-z0-9.]/gu, "")
        .slice(0, 20);
      const storedFilename = `remote-${id.replace(/[^A-Za-z0-9._-]/gu, "_")}${extension}`;
      const path = join(this.manifest.root, storedFilename);
      await Bun.write(path, remote.bytes);
      const resolved = {
        mediaId: id,
        filename: remote.filename,
        contentType: remote.contentType,
        size: remote.bytes.byteLength,
        path,
      };
      this.remoteAssets.set(id, resolved);
      return resolved;
    }
    if (basename(attachment.storedFilename) !== attachment.storedFilename) {
      throw new Error("Attachment manifest contains an invalid filename.");
    }
    const path = await realpath(
      join(this.manifest.root, attachment.storedFilename),
    );
    if (!inside(this.manifest.root, path)) {
      throw new Error("Attachment is outside the request root.");
    }
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) {
      throw new Error("Attachment exceeds the processing limit.");
    }
    return { ...attachment, path };
  }

  private async probePath(path: string) {
    const { stdout } = await this.runner("/usr/bin/ffprobe", [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_entries",
      "format=duration,size,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate",
      "-of",
      "json",
      path,
    ]);
    const probe = JSON.parse(stdout) as ProbeOutput;
    validateProbe(probe);
    return probe;
  }

  private async output(extension: string) {
    const id = `media-${this.idFactory()}.${extension}`;
    return { id, path: join(this.manifest.outputDirectory, id) };
  }

  private async finishOutput(output: { id: string; path: string }) {
    const path = await realpath(output.path);
    if (!inside(this.manifest.outputDirectory, path)) {
      throw new Error("Generated artifact escaped the output folder.");
    }
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_OUTPUT_BYTES) {
      await rm(path, { force: true });
      throw new Error("Generated artifact exceeds Discord's 8 MB limit.");
    }
    const bytes = new Uint8Array(await readFile(path));
    await this.mediaClient?.write({
      mediaId: output.id,
      filename: output.id,
      contentType: mediaContentType(output.id),
      bytes,
    });
    this.remoteAssets.set(output.id, {
      mediaId: output.id,
      filename: output.id,
      contentType: mediaContentType(output.id),
      size: info.size,
      path,
    });
    return { mediaId: output.id, size: info.size };
  }

  async inspect(mediaId: string) {
    const attachment = await this.attachment(mediaId);
    return {
      mediaId,
      filename: attachment.filename,
      contentType: attachment.contentType,
      ...publicProbe(await this.probePath(attachment.path)),
    };
  }

  async transformImage(input: {
    mediaId: string;
    format: "jpeg" | "png" | "webp";
    width?: number;
    height?: number;
    fit: "contain" | "cover" | "stretch";
    rotate: 0 | 90 | 180 | 270;
    quality: number;
  }) {
    const attachment = await this.attachment(input.mediaId);
    const extension = extname(attachment.filename).toLocaleLowerCase();
    if (
      !attachment.contentType?.startsWith("image/") &&
      ![".gif", ".jpeg", ".jpg", ".png", ".webp"].includes(extension)
    ) {
      throw new Error("Attachment is not an image.");
    }
    await this.probePath(attachment.path);
    const output = await this.output(imageExtension(input.format));
    const filters = imageFilters(input);
    const quality = Math.round(31 - (input.quality / 100) * 29);
    await this.runner("/usr/bin/ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "2",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      attachment.path,
      "-frames:v",
      "1",
      ...(filters.length ? ["-vf", filters.join(",")] : []),
      "-map_metadata",
      "-1",
      ...(input.format === "png"
        ? ["-compression_level", "6"]
        : ["-q:v", String(quality)]),
      output.path,
    ]);
    return this.finishOutput(output);
  }

  async extractFrame(input: {
    mediaId: string;
    timeSeconds: number;
    format: "jpeg" | "png" | "webp";
    width?: number;
  }) {
    const attachment = await this.attachment(input.mediaId);
    const probe = await this.probePath(attachment.path);
    if (!probe.streams?.some((stream) => stream.codec_type === "video")) {
      throw new Error("Attachment has no video stream.");
    }
    const output = await this.output(imageExtension(input.format));
    await this.runner("/usr/bin/ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "2",
      "-ss",
      String(input.timeSeconds),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      attachment.path,
      "-frames:v",
      "1",
      ...(input.width ? ["-vf", `scale=${input.width}:-2`] : []),
      "-map_metadata",
      "-1",
      output.path,
    ]);
    return this.finishOutput(output);
  }

  async transcode(input: {
    mediaId: string;
    preset: "audio_mp3" | "gif" | "video_mp4";
    startSeconds: number;
    durationSeconds: number;
    maxWidth: number;
  }) {
    const attachment = await this.attachment(input.mediaId);
    const probe = await this.probePath(attachment.path);
    const hasAudio = probe.streams?.some(
      (stream) => stream.codec_type === "audio",
    );
    const hasVideo = probe.streams?.some(
      (stream) => stream.codec_type === "video",
    );
    if (input.preset === "audio_mp3" && !hasAudio) {
      throw new Error("Attachment has no audio stream.");
    }
    if (input.preset !== "audio_mp3" && !hasVideo) {
      throw new Error("Attachment has no video stream.");
    }
    const maximumDuration =
      input.preset === "audio_mp3" ? 120 : input.preset === "gif" ? 15 : 30;
    if (input.durationSeconds > maximumDuration) {
      throw new Error(`The ${input.preset} preset duration is too long.`);
    }
    const extension =
      input.preset === "audio_mp3"
        ? "mp3"
        : input.preset === "video_mp4"
          ? "mp4"
          : "gif";
    const output = await this.output(extension);
    const common = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "2",
      "-ss",
      String(input.startSeconds),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      attachment.path,
      "-t",
      String(input.durationSeconds),
      "-map_metadata",
      "-1",
    ];
    const presetArgs =
      input.preset === "audio_mp3"
        ? ["-vn", "-c:a", "libmp3lame", "-b:a", "128k"]
        : input.preset === "video_mp4"
          ? [
              "-vf",
              `scale=min(${input.maxWidth}\\,iw):-2`,
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "28",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-movflags",
              "+faststart",
            ]
          : [
              "-vf",
              `fps=12,scale=min(${Math.min(input.maxWidth, 640)}\\,iw):-2:flags=lanczos`,
              "-loop",
              "0",
            ];
    await this.runner("/usr/bin/ffmpeg", [
      ...common,
      ...presetArgs,
      output.path,
    ]);
    return this.finishOutput(output);
  }
}

export const mediaLimits = {
  inputBytes: MAX_INPUT_BYTES,
  outputBytes: MAX_OUTPUT_BYTES,
  dimension: MAX_DIMENSION,
  pixels: MAX_PIXELS,
  durationSeconds: MAX_DURATION_SECONDS,
};
