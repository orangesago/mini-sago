import { randomBytes } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexPath } from "../worker/src/codex-path.ts";

const action = process.argv[2];
const supportedActions = new Set(["install", "status", "uninstall"]);

if (!supportedActions.has(action)) {
  console.error("Usage: bun scripts/worker.mjs <install|status|uninstall>");
  process.exit(1);
}

if (process.platform !== "darwin") {
  console.error("The MiniSago Mac helper can only be installed on macOS.");
  process.exit(1);
}

const label = "dev.hsichen.minisago-mac-agent";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = join(repositoryRoot, "worker");
const userHome = homedir();
const applicationSupport = join(
  userHome,
  "Library",
  "Application Support",
  "MiniSago",
);
const binDirectory = join(applicationSupport, "bin");
const logsDirectory = join(applicationSupport, "logs");
const codexHome = join(applicationSupport, "codex-home");
const environmentFile = join(applicationSupport, "agent.env");
const sessionMonitor = join(binDirectory, "session-monitor");
const launchAgentFile = join(
  userHome,
  "Library",
  "LaunchAgents",
  `${label}.plist`,
);
const serviceTarget = `gui/${process.getuid()}/${label}`;

function run(command, args, options = {}) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options.cwd,
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: options.quiet ? "ignore" : "inherit",
  });

  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(`${command} exited with status ${result.exitCode}`);
  }

  return result;
}

async function bootstrapLaunchAgent(domain, plist) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = run("/bin/launchctl", ["bootstrap", domain, plist], {
      allowFailure: true,
      quiet: attempt < 2,
    });
    if (result.exitCode === 0) return;
    if (attempt < 2) await Bun.sleep(500 * (attempt + 1));
  }

  throw new Error("/bin/launchctl bootstrap failed after 3 attempts");
}

function escapeXml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}

function envLine(name, value) {
  return `${name}=${JSON.stringify(value)}`;
}

async function ensureAuthLink() {
  const source = join(userHome, ".codex", "auth.json");
  const destination = join(codexHome, "auth.json");
  try {
    await access(source);
  } catch {
    throw new Error(
      "Local Codex auth.json was not found. Sign in with Codex CLI first.",
    );
  }

  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);

  let existing;
  try {
    existing = await lstat(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (existing) {
    if (existing.isSymbolicLink() && (await readlink(destination)) === source) {
      return;
    }

    throw new Error(
      `${destination} already exists and was not created by this installer.`,
    );
  }

  await symlink(source, destination);
}

async function install() {
  const bridgeSecret = process.env.MINISAGO_MAC_BRIDGE_SECRET?.trim();
  if (!bridgeSecret || Buffer.byteLength(bridgeSecret) < 32) {
    console.error(
      "Set a 32-byte-or-longer MINISAGO_MAC_BRIDGE_SECRET in .env.local before installing.",
    );
    console.error(`Suggested value: ${randomBytes(32).toString("hex")}`);
    process.exit(1);
  }

  const codexPath = await resolveCodexPath();

  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(launchAgentFile), { recursive: true });
  await ensureAuthLink();

  run(Bun.which("bun") || process.execPath, ["install", "--frozen-lockfile"], {
    cwd: workerRoot,
  });
  run("/usr/bin/swiftc", [
    join(workerRoot, "src", "mac", "session-monitor.swift"),
    "-o",
    sessionMonitor,
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
  ]);
  await chmod(sessionMonitor, 0o700);

  const bunPath = Bun.which("bun") || process.execPath;
  const ghPath = Bun.which("gh") || "/usr/bin/gh";
  const workerPath = [
    dirname(bunPath),
    dirname(ghPath),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");

  const environment = [
    envLine("PATH", workerPath),
    envLine(
      "MINISAGO_BRIDGE_URL",
      process.env.MINISAGO_BRIDGE_URL?.trim() ||
        "wss://bot.hsichen.dev/api/mac-agent/ws",
    ),
    envLine("MINISAGO_MAC_BRIDGE_SECRET", bridgeSecret),
    envLine(
      "MINISAGO_CHATBOT_OWNER_USER_ID",
      process.env.MINISAGO_CHATBOT_OWNER_USER_ID?.trim() || "",
    ),
    envLine("MINISAGO_CODEX_HOME", codexHome),
    envLine(
      "MINISAGO_MAX_CONCURRENT_JOBS",
      process.env.MINISAGO_MAX_CONCURRENT_JOBS?.trim() || "2",
    ),
    envLine(
      "MINISAGO_WORKER_ID",
      process.env.MINISAGO_WORKER_ID?.trim() || "hsi-mac",
    ),
    envLine(
      "MINISAGO_MAC_FILE_ROOTS",
      process.env.MINISAGO_MAC_FILE_ROOTS?.trim() || "",
    ),
    envLine(
      "MINISAGO_WORKSPACE_ROOT",
      process.env.MINISAGO_WORKSPACE_ROOT?.trim() || join(userHome, "Projects"),
    ),
    envLine(
      "MINISAGO_CHATBOT_REPOSITORY",
      process.env.MINISAGO_CHATBOT_REPOSITORY?.trim() || "",
    ),
    envLine(
      "MINISAGO_GITHUB_CONFIG_DIR",
      process.env.MINISAGO_GITHUB_CONFIG_DIR?.trim() ||
        join(applicationSupport, "github"),
    ),
    envLine(
      "MINISAGO_GITHUB_WORKTREE_ROOT",
      process.env.MINISAGO_GITHUB_WORKTREE_ROOT?.trim() ||
        join(userHome, "Projects", "worktrees"),
    ),
    envLine("MINISAGO_CODEX_PATH", codexPath),
    envLine("MINISAGO_SESSION_MONITOR_PATH", sessionMonitor),
    envLine(
      "MINISAGO_TRACE_DATABASE_PATH",
      process.env.MINISAGO_TRACE_DATABASE_PATH?.trim() ||
        join(applicationSupport, "traces.sqlite"),
    ),
  ].join("\n");
  await writeFile(environmentFile, `${environment}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(environmentFile, 0o600);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bunPath)}</string>
    <string>--env-file=${escapeXml(environmentFile)}</string>
    <string>${escapeXml(join(workerRoot, "src", "index.ts"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repositoryRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(workerPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logsDirectory, "helper.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logsDirectory, "helper-error.log"))}</string>
</dict>
</plist>
`;

  await writeFile(launchAgentFile, plist, { encoding: "utf8", mode: 0o600 });
  await chmod(launchAgentFile, 0o600);
  run("/bin/launchctl", ["bootout", serviceTarget], {
    allowFailure: true,
    quiet: true,
  });
  await bootstrapLaunchAgent(`gui/${process.getuid()}`, launchAgentFile);
  run("/bin/launchctl", ["kickstart", "-k", serviceTarget]);

  console.log("MiniSago Mac helper installed and started.");
  console.log(`Status: bun run mac-agent:status`);
}

function status() {
  const probe = run("/bin/launchctl", ["print", serviceTarget], {
    allowFailure: true,
    quiet: true,
  });

  if (probe.exitCode !== 0) {
    console.error("MiniSago Mac helper is not loaded.");
    process.exit(1);
  }

  run("/bin/launchctl", ["print", serviceTarget]);
}

async function uninstall() {
  run("/bin/launchctl", ["bootout", serviceTarget], {
    allowFailure: true,
    quiet: true,
  });
  await rm(launchAgentFile, { force: true });
  await rm(applicationSupport, { recursive: true, force: true });
  console.log("MiniSago Mac helper was stopped and removed.");
  console.log("Your normal ~/.codex authentication was not changed.");
}

if (action === "install") {
  await install();
} else if (action === "status") {
  status();
} else {
  await uninstall();
}
