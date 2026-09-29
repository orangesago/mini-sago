# Workers

MiniSago uses fixed secret-backed worker profiles. Oracle provides preferred
`chat,dev`; the Mac helper provides fallback `chat,dev,mac`. Workers connect
outbound to the hosted bridge and expose no public port.

## Shared requirements

Every worker needs:

- a working Codex executable and isolated Codex home;
- a bridge URL and 32-byte-or-longer profile secret;
- the same `MINISAGO_CHATBOT_OWNER_USER_ID` as the hosted service;
- a dedicated authenticated GitHub CLI login; and
- outbound HTTPS and WSS.

At startup, each worker discovers and advertises every repository visible to its
GitHub login. A repository does not need to exist locally in advance. Oracle jobs
always receive a disposable checkout and prepared feature branch.

The headless Oracle worker also reads the GitHub skill links in
`sago-cream/skills` and installs them into its isolated Codex home before
connecting. It checks the Skillbook revision every 15 minutes. A new Skillbook
revision snapshots the current commit of every linked skill, and that set is
available to the next Discord development turn without restarting the worker.
The Mac helper leaves its skills alone so the Mac remains the authoring copy.
Set `MINISAGO_SKILLBOOK_REPOSITORY` explicitly to enable or change syncing on
another worker, and adjust
`MINISAGO_SKILLBOOK_SYNC_INTERVAL_MS` when a slower refresh is preferable.
Pushes to `sago-cream/skills` also trigger an immediate Oracle refresh through
the existing GitHub webhook. The periodic check remains as recovery when a
delivery arrives while Oracle is offline.

## Oracle worker

Use an OCI Ampere A1 Compute VM rather than Container Instances because Codex,
GitHub CLI, traces, repositories, and worktrees require persistent volumes.
Confirm current OCI pricing, capacity, and reclamation policy in official
sources.

On Ubuntu AArch64 with Docker Engine and the Compose plugin:

```bash
cp .env.worker.example .env.worker
chmod 600 .env.worker
docker compose -f compose.worker.yaml build
docker compose -f compose.worker.yaml run --rm worker codex login --device-auth
docker compose -f compose.worker.yaml up -d
docker compose -f compose.worker.yaml logs -f worker
```

The Linux worker compose file also starts an internal sandbox broker. It alone
holds the Docker socket and launches short-lived, networkless containers with
read-only system paths and size-monitored scratch space for generic Python
computation. The worker itself never receives the Docker socket. Keep the sandbox
service private; it intentionally publishes no host port.

Put the same secret in the worker's `MINISAGO_MAC_BRIDGE_SECRET` and the hosted
service's `MINISAGO_WORKER_BRIDGE_SECRET`. Device authentication must write only
to the persistent Codex volume.

Authenticate the dedicated fine-grained GitHub login over standard input:

```bash
docker compose -f compose.worker.yaml run --rm worker gh auth login --hostname github.com --git-protocol https --with-token
docker compose -f compose.worker.yaml up -d --force-recreate
docker compose -f compose.worker.yaml exec worker gh auth status
```

Restart the worker after changing the GitHub login or its repository access so
it refreshes the advertised repository list.

Never put the token in `.env.worker`, Discord, a Codex request, a shell
argument, or the repository. Do not expose Docker, Codex, SSH, or workspace
volumes publicly.

## Mac helper

Prerequisites are Bun, Xcode command-line tools including `swiftc`, an existing
`~/.codex/auth.json`, and the Mac profile secret configured on both the helper
and hosted service.

Authenticate the helper's isolated GitHub login, then install it:

```bash
GH_CONFIG_DIR="$HOME/Library/Application Support/MiniSago/github" gh auth login --hostname github.com --git-protocol https --with-token
bun run mac-agent:install
bun run mac-agent:status
```

The installer consumes `.env.local`, creates an isolated Codex home linked to
the existing authentication file, and installs the per-user LaunchAgent
`dev.hsichen.minisago-mac-agent`.

The helper connects only while the user session is unlocked, disconnects
before sleep or lock, and reconnects afterward. Display sleep without a session
lock does not disconnect it. Missed requests are never replayed.

By default, owner file requests are limited to Desktop, Documents, Downloads,
Movies, Music, Pictures, and iCloud Drive. Override those roots with
`MINISAGO_MAC_FILE_ROOTS`.

## Authentication and capacity

ChatGPT device authentication can expire and remains subject to account plan
limits. It is not an uptime guarantee. A worker reports availability and
`MINISAGO_MAX_CONCURRENT_JOBS`; the hosted service prefers Oracle, falls back to
Mac when Oracle is full or unavailable, and routes explicit Mac work only to
Mac.

See [Security](security.md) for credential and sandbox boundaries and
[Operations](operations.md) for logs, recovery, deployment, and removal.

The Oracle image includes Python 3 with `venv` support for owner development
jobs. Chat jobs do not receive arbitrary Python or shell execution. Media work
uses the image's FFmpeg binaries only through MiniSago's request-local typed MCP
tools.

## Development runtime checks

Coding replies resume the saved Codex conversation in a fresh process. Checkout,
scratch and attachment paths remain under the task's workspace; task files are
not automatically deleted. The existing thread registry is still in memory and
expires after three idle days, so restarting the core requires manual task
recovery. Preserve unfinished work before manually retiring its workspace.

Before starting a coding turn, the worker checks Git metadata writes, scratch
storage and repository access through the actual Codex sandbox. A failed check
or sandbox initialization error fails the job and remains visible in the thread
and worker trace. Finishing a turn does not certify PR or CI completion.

Run `bash scripts/test-dev-sandbox.sh` to check the pinned Linux runtime without
credentials or a model call. On AppArmor hosts, first load the existing
production profile with `sudo apparmor_parser -r scripts/test-fixtures/worker-security/minisago-worker.apparmor`.
The smoke test uses copies of production's AppArmor and seccomp profiles and
verifies readiness, continuation and denial of writes outside the task as UID 1000. It changes no production configuration.
