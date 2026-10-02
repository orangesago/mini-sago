import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  outgoingFileLimits,
  prepareDeveloperImages,
  prepareGeneratedArtifacts,
  prepareOutgoingFiles,
  requestedArtifactIds,
  requestedFilePaths,
} from "./outgoing-files";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("developer image evidence", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jivsAAAAASUVORK5CYII=",
    "base64",
  );
  async function fixture() {
    const parent = await mkdtemp(join(tmpdir(), "minisago-evidence-"));
    temporaryDirectories.push(parent);
    const repo = join(parent, "repo");
    const output = join(parent, "output");
    await Promise.all([repo, output].map((path) => mkdir(path)));
    return { parent, repo, output };
  }

  test("uploads before/after images from repository and output paths with captions", async () => {
    const { repo, output } = await fixture();
    await writeFile(join(repo, "before.png"), png);
    await writeFile(join(output, "after (wide).png"), png);
    const result = await prepareDeveloperImages(
      `Shipped.\n\n![Before](before.png)\n![After](<${join(output, "after (wide).png")}>)\n![Again](./before.png)`,
      repo,
      output,
    );
    expect(result.content).toBe("Shipped.\n\nBefore\nAfter\nAgain");
    expect(result.files.map((file) => file.filename)).toEqual([
      "before.png",
      "after (wide).png",
    ]);
    expect(
      result.files.every((file) => file.data === png.toString("base64")),
    ).toBe(true);
  });

  test("ignores code examples, escaped Markdown and remote image URLs", async () => {
    const { repo, output } = await fixture();
    await writeFile(join(repo, "example.png"), png);
    const content =
      "```md\n![Example](example.png)\n```\n~~~md\n![Example](example.png)\n~~~\n`![Example](example.png)`\n\\![Example](example.png)\n![Remote](https://example.test/a.png)\n```md\n![Unclosed](example.png)";
    expect(await prepareDeveloperImages(content, repo, output)).toEqual({
      content,
      files: [],
    });
  });

  test("keeps the answer and explains missing, invalid and escaped images", async () => {
    const { parent, repo, output } = await fixture();
    await writeFile(join(parent, "private.png"), png);
    await symlink(join(parent, "private.png"), join(repo, "escape.png"));
    await writeFile(join(repo, "fake.png"), "private text");
    const result = await prepareDeveloperImages(
      "Work complete.\n![Missing](missing.png)\n![Invalid](fake.png)\n![Escape](escape.png)",
      repo,
      output,
    );
    expect(result.files).toEqual([]);
    expect(result.content).toContain("Work complete.");
    expect(result.content).toContain("the local image could not be read");
    expect(result.content).toContain("only PNG, JPEG, GIF, and WebP");
    expect(result.content).toContain("outside this task's repository");
    expect(result.content).not.toContain("private text");
    expect(result.content).not.toContain(parent);
  });

  test("bounds image count and combined bytes, and avoids duplicate filenames", async () => {
    const { repo, output } = await fixture();
    await writeFile(join(repo, "same.png"), png);
    await writeFile(join(output, "same.png"), png);
    const refs = [
      `![Repo](same.png)`,
      `![Output](<${join(output, "same.png")}>)`,
    ];
    for (let index = 0; index < 9; index++) {
      await writeFile(join(repo, `${index}.png`), png);
      refs.push(`![Image ${index}](${index}.png)`);
    }
    const result = await prepareDeveloperImages(refs.join("\n"), repo, output);
    expect(result.files).toHaveLength(10);
    expect(new Set(result.files.map((file) => file.filename)).size).toBe(10);
    expect(result.content).toContain("at most 10 images");
    const large = Buffer.alloc(5 * 1024 * 1024);
    png.copy(large);
    await Promise.all(
      ["large-1.png", "large-2.png"].map((name) =>
        writeFile(join(repo, name), large),
      ),
    );
    const bounded = await prepareDeveloperImages(
      "Done.\n![One](large-1.png)\n![Two](large-2.png)",
      repo,
      output,
    );
    expect(bounded.files).toHaveLength(1);
    expect(bounded.content).toContain("combined image upload exceeds 8 MB");
  });
});

describe("Mac outgoing files", () => {
  test("extracts and removes the model-only files field", () => {
    expect(
      requestedFilePaths(
        JSON.stringify({
          reply: "found it",
          reaction: null,
          files: ["/tmp/a"],
        }),
      ),
    ).toEqual({
      content: JSON.stringify({ reply: "found it", reaction: null }),
      files: ["/tmp/a"],
    });
  });

  test("reads one regular file contained by an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-files-"));
    temporaryDirectories.push(root);
    const path = join(root, "notes.txt");
    await writeFile(path, "ship friday");

    const result = await prepareOutgoingFiles(
      JSON.stringify({ reply: "here", reaction: null, files: [path] }),
      [root],
    );

    expect(result.files).toEqual([
      {
        filename: "notes.txt",
        contentType: "text/plain",
        size: 11,
        data: Buffer.from("ship friday").toString("base64"),
      },
    ]);
  });

  test("rejects files and symlinks that escape the allowed roots", async () => {
    const parent = await mkdtemp(join(tmpdir(), "minisago-files-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "allowed");
    await mkdir(root);
    const secret = join(parent, "secret.txt");
    await writeFile(secret, "nope");
    const link = join(root, "shortcut.txt");
    await symlink(secret, link);

    await expect(
      prepareOutgoingFiles(
        JSON.stringify({ reply: "", reaction: null, files: [link] }),
        [root],
      ),
    ).rejects.toThrow("outside the configured Mac file folders");
  });

  test("keeps the websocket upload bounded", () => {
    expect(outgoingFileLimits).toEqual({ count: 1, bytes: 8 * 1024 * 1024 });
  });
});

describe("generated artifacts", () => {
  test("extracts one generated artifact ID and removes the model-only field", () => {
    expect(
      requestedArtifactIds(
        JSON.stringify({
          reply: "done",
          reaction: null,
          artifacts: [
            "media-result.webp",
            "python-ignored.png",
            "../secret.txt",
          ],
        }),
      ),
    ).toEqual({
      content: JSON.stringify({ reply: "done", reaction: null }),
      artifacts: ["media-result.webp"],
    });
  });

  test("ignores reminder IDs and unsupported artifact names", () => {
    expect(
      requestedArtifactIds(
        JSON.stringify({
          reply: "reminder created",
          reaction: null,
          artifacts: [
            "e7452ed6-a4db-426a-9e71-a81d8f7640c0",
            "result.webp",
            "media-result.exe",
          ],
        }),
      ),
    ).toEqual({
      content: JSON.stringify({
        reply: "reminder created",
        reaction: null,
      }),
      artifacts: [],
    });
  });

  test("reads one generated artifact from the request output folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-artifacts-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "media-result.webp"), "image");

    const result = await prepareGeneratedArtifacts(
      JSON.stringify({
        reply: "done",
        reaction: null,
        artifacts: ["media-result.webp"],
      }),
      root,
    );

    expect(result.content).toBe(
      JSON.stringify({ reply: "done", reaction: null }),
    );
    expect(result.files).toEqual([
      {
        filename: "media-result.webp",
        contentType: "image/webp",
        size: 5,
        data: Buffer.from("image").toString("base64"),
      },
    ]);
  });

  test("rejects generated artifact symlinks that escape the output folder", async () => {
    const parent = await mkdtemp(join(tmpdir(), "minisago-artifacts-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "outputs");
    await mkdir(root);
    const secret = join(parent, "secret.txt");
    await writeFile(secret, "nope");
    await symlink(secret, join(root, "media-result.txt"));

    await expect(
      prepareGeneratedArtifacts(
        JSON.stringify({
          reply: "",
          reaction: null,
          artifacts: ["media-result.txt"],
        }),
        root,
      ),
    ).rejects.toThrow("outside the request output folder");
  });

  test("ignores generated artifacts outside the output allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "minisago-artifacts-"));
    temporaryDirectories.push(root);
    const result = await prepareGeneratedArtifacts(
      JSON.stringify({
        reply: "done",
        reaction: null,
        artifacts: ["media-result.exe"],
      }),
      root,
    );

    expect(result).toEqual({
      content: JSON.stringify({ reply: "done", reaction: null }),
      files: [],
    });
  });
});
