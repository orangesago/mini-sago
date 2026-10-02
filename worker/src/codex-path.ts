import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

export const BUNDLED_CODEX_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
];

async function isExecutable(path: string) {
  try {
    await access(path, 1);
    return true;
  } catch {
    return false;
  }
}

async function nativeCodexPath(path: string) {
  const executable = await realpath(path);
  if (basename(executable) !== "codex.js") return path;

  const packageRoot = dirname(dirname(executable));
  let metadata;
  try {
    metadata = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
  } catch {
    return path;
  }
  if (metadata?.name !== "@openai/codex") return path;

  const architectures: Record<string, string> = {
    arm64: "aarch64",
    x64: "x86_64",
  };
  const targets: Record<string, string> = {
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
  };
  const architecture = architectures[process.arch];
  const target = targets[process.platform];
  if (!architecture || !target) return path;

  // npm's launcher requires Node, which is absent from the chat worker PATH.
  const vendorRoots = [join(packageRoot, "vendor")];
  try {
    const require = createRequire(executable);
    const platformPackage = require.resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
    );
    vendorRoots.unshift(join(dirname(platformPackage), "vendor"));
  } catch {
    // Older packages include the native binary in the main package.
  }

  for (const root of vendorRoots) {
    for (const directory of ["bin", "codex"]) {
      const nativePath = join(
        root,
        `${architecture}-${target}`,
        directory,
        "codex",
      );
      if (await isExecutable(nativePath)) return nativePath;
    }
  }

  throw new Error(`No native Codex executable was found for ${path}.`);
}

export async function resolveCodexPath(
  configured = process.env.MINISAGO_CODEX_PATH?.trim(),
  onPath = Bun.which("codex"),
  bundledPaths = BUNDLED_CODEX_PATHS,
) {
  const candidates = [configured, ...bundledPaths, onPath].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return nativeCodexPath(candidate);
    }
  }

  throw new Error(
    "No working Codex executable was found. Set MINISAGO_CODEX_PATH.",
  );
}
