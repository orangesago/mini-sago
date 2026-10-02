import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkCodexAuthentication } from "./codex";
import { resolveCodexPath } from "./codex-path";

async function executable(path: string, content = "#!/bin/sh\nexit 0\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o700);
  return path;
}

async function withDirectory(run: (root: string) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "minisago-codex-path-")),
  );
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Codex executable discovery", () => {
  test("preserves an explicit native executable", async () => {
    await withDirectory(async (root) => {
      const configured = await executable(join(root, "custom-codex"));
      const bundled = await executable(join(root, "bundled-codex"));
      expect(await resolveCodexPath(configured, null, [bundled])).toBe(
        configured,
      );
    });
  });

  test("preserves custom launchers outside the Codex npm package", async () => {
    await withDirectory(async (root) => {
      const launcher = await executable(join(root, "bin", "codex.js"));
      expect(await resolveCodexPath(launcher, null, [])).toBe(launcher);
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "custom-launcher" }),
      );
      expect(await resolveCodexPath(launcher, null, [])).toBe(launcher);
    });
  });

  test("prefers the current app bundle and recovers stale configured paths", async () => {
    await withDirectory(async (root) => {
      const currentBundle = await executable(join(root, "CodexCLI", "codex"));
      const legacyBundle = await executable(join(root, "Resources", "codex"));
      const onPath = await executable(join(root, "bin", "codex"));
      const configured = join(root, "removed-codex");
      expect(
        await resolveCodexPath(configured, onPath, [
          currentBundle,
          legacyBundle,
        ]),
      ).toBe(currentBundle);
      await rm(currentBundle);
      expect(
        await resolveCodexPath(configured, onPath, [
          currentBundle,
          legacyBundle,
        ]),
      ).toBe(legacyBundle);
      await rm(legacyBundle);
      expect(await resolveCodexPath(configured, onPath, [])).toBe(onPath);
    });
  });

  for (const layout of ["platform-bin", "platform-codex", "local-codex"]) {
    test(`runs npm Codex without Node (${layout})`, async () => {
      await withDirectory(async (root) => {
        const modules = join(root, "node_modules");
        const packageRoot = join(modules, "@openai", "codex");
        const launcher = await executable(
          join(packageRoot, "bin", "codex.js"),
          "#!/usr/bin/env node\nprocess.exit(1);\n",
        );
        await writeFile(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "@openai/codex" }),
        );
        const link = join(modules, ".bin", "codex");
        await mkdir(dirname(link));
        await symlink(launcher, link);

        const platformRoot = layout.startsWith("platform")
          ? join(
              modules,
              "@openai",
              `codex-${process.platform}-${process.arch}`,
            )
          : packageRoot;
        const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
        const target =
          process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
        const native = await executable(
          join(
            platformRoot,
            "vendor",
            `${architecture}-${target}`,
            layout === "platform-bin" ? "bin" : "codex",
            "codex",
          ),
          '#!/bin/sh\n[ "$1" = login ] && [ "$2" = status ]\n',
        );
        if (platformRoot !== packageRoot) {
          await writeFile(join(platformRoot, "package.json"), "{}");
        }

        const codexHome = join(root, "codex-home");
        expect(
          await checkCodexAuthentication({ codexHome, codexPath: link }),
        ).toBe(false);
        const resolved = await resolveCodexPath(link, null, []);
        expect(resolved).toBe(native);
        expect(
          await checkCodexAuthentication({ codexHome, codexPath: resolved }),
        ).toBe(true);
      });
    });
  }

  test("reports a missing executable", async () => {
    await expect(resolveCodexPath("/missing/codex", null, [])).rejects.toThrow(
      "Set MINISAGO_CODEX_PATH",
    );
  });

  test("reports an npm installation missing its native binary", async () => {
    await withDirectory(async (root) => {
      const launcher = await executable(join(root, "bin", "codex.js"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "@openai/codex" }),
      );
      await expect(resolveCodexPath(launcher, null, [])).rejects.toThrow(
        "No native Codex executable",
      );
    });
  });
});
