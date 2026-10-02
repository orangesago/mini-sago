# Operations

This runbook covers deployment, verification, logs, recovery, and removal.
Initial Discord and worker installation live in [Discord setup](discord-setup.md)
and [Workers](workers.md).

## Runtime endpoints

| Endpoint                   | Purpose                                                  |
| -------------------------- | -------------------------------------------------------- |
| `GET /api/health`          | Configuration, aggregate worker capacity, and Mac status |
| `GET /api/mac-agent/ws`    | Authenticated worker WebSocket                           |
| `POST /api/chatbot/mcp`    | Bearer-bound MCP requests from active answer jobs        |
| `POST /api/github/webhook` | Verified GitHub pull-request events                      |

Expose the HTTP routes through HTTPS and preserve WebSocket upgrade headers for
`/api/mac-agent/ws`. The worker WebSocket returns `404` when no bridge secret is
configured.

## Local operation

Install and start the hosted service:

```bash
bun install
bun run dev
```

Use `DISCORD_GATEWAY_DISABLED=true` whenever another deployment already owns
the bot token. Install workers using the dedicated setup guides.

Before committing changes, run:

```bash
bun run build
bun run --cwd worker build
bun test
bun run format:check
```

## Container images

Every push to `main` publishes the core and worker images with moving `main`
tags and immutable `sha-<commit>` tags:

```text
ghcr.io/sago-cream/minisago
ghcr.io/sago-cream/minisago-worker
```

Oracle worker image builds resolve the latest stable Codex CLI release and
install that exact version. Model-only PRs therefore refresh Codex on the next
release without a separate version bump. PR CI runs the Linux sandbox smoke
check with the latest stable CLI; set `CODEX_VERSION` when running
`scripts/test-dev-sandbox.sh` to check a specific release. Published commit-tagged
images retain their installed version for rollback.

For a general self-host, run the core image with the hosted-service variables,
persist `/app/state`, expose port `3000` through an HTTPS reverse proxy, and run
at least one separately authenticated worker. Replace the
`bot.hsichen.dev` examples with the deployment's public origin.

## Sago Cloud deployment

Production changes flow through `main`. The deployment command requires a clean
local `main` exactly matching `origin/main`:

```bash
bun run deploy
```

The script waits for both images, then asks the operations checkout at
`/srv/sago-cloud/operations` to deploy core and worker as one release. It
connects through the local `sago-cloud` SSH alias over Tailscale and retries
connection timeouts three times. Use `SAGO_CLOUD_HOST` only for a replacement
host.

For Mac deployments, the `sago-cream.github` Tailscale profile must use **Exit
Node → None**, not Automatic/Recommended. Disconnect, select that profile, and
clear its exit node before connecting. The CLI equivalent, with that profile
already selected, is `tailscale set --exit-node=`; this changes the preference
without connecting. Use `tailscale switch --list` to check the selected profile
and `tailscale debug prefs` to confirm `ExitNodeID`, `ExitNodeIP`, and
`AutoExitNode` are empty or unset. Do not restore `auto:any` during deployment
cleanup: it can leave this profile without working internet access. Preserve
NTHUSA's separate NAS exit-node preference and restore the original selected
profile and connection state after deployment.

On the Sago Cloud Oracle worker, `MINISAGO_DEPLOY_SOCKET` replaces SSH with the
bounded host socket. The script submits the exact `origin/main` commit and
returns after the host accepts it, before the deployment replaces the bot and
worker containers. The host pins both images to that immutable commit tag.
The restarted bot reads the host status file and posts the terminal result to
the originating Discord development thread once.

The VM pulls published images rather than cloning this repository. Production
secrets live under `/srv/sago-cloud/secrets`. Only the core container joins
`sago_cloud_edge` under the `bot-core` alias. The following remain in external
persistent volumes:

- bot monitor, reminder, and webhook state;
- worker Codex and GitHub CLI state;
- worker traces; and
- disposable repository/worktree storage.

## Verification

After deployment:

```bash
curl https://bot.hsichen.dev/api/health
```

A healthy response has `ok: true`, required configuration flags set, and at
least one available worker. `mac: offline` is normal while the Mac is locked,
asleep, disconnected, or not running.

Also verify the relevant behavior after risky changes:

- mention MiniSago in an authorized channel;
- confirm an owner development request routes to an advertised repository;
- confirm worker logs show protocol authentication rather than reconnect loops;
- deliver a GitHub webhook and ensure it reuses the mapped thread; and
- check scheduled state files remain under `/app/state`.

The Oracle container also exposes an internal `GET /health` endpoint on port
`8081`. Its Docker health check verifies the bridge connection, Codex login,
and Codex app-server sessions; the port is not published publicly.

## Voice diagnostics dashboard

Open `/voice-debug` on the bot's origin to inspect live voice sessions. Set a
dedicated `MINISAGO_VOICE_DEBUG_TOKEN` (at least 32 random characters) in the
core environment to enable capture and sign in. Do not reuse a Discord, worker,
or Codex credential. The token is exchanged for a 12-hour HttpOnly, SameSite
cookie; it is never put in a URL or browser storage. Production requires HTTPS.
Without the token configured, the diagnostics API is disabled.

The dashboard links each utterance to its Whisper transcript, the host's
answer/ignore/replace/stop decision, Codex's first text and final reply,
VOICEVOX synthesis, and playback. Timing bars show wall-clock durations and may
overlap. Whisper and synthesis durations include audio conversion and network
requests; Codex time includes worker dispatch and startup. The host rule is
shown separately from model output; private model reasoning is not collected.

Tuning controls update speech confirmation and end silence for the next speech
segment, and recognition timeout, thinking feedback, and speech speed for the
next recognized turn. Existing captures and answers keep their settings.
Changes are process-local and reset on restart. Concurrent edits use a revision
check to avoid overwriting another tab's changes. Stop reply cancels the active
answer. It does not disconnect the voice session.

Transcripts and replies are held only in memory for 30 minutes, up to 800 events
and 32 session summaries. Captured audio has a separate 24 MB memory bound. Browser
test recordings and recognition results also persist in the test library described below.
Clear events removes the transient buffer; exported JSON is a separate local copy containing transcript
text. Authenticated clients poll once per second. Pausing updates affects only
the dashboard, not the bot. `/voice-debug?demo=1` contains clearly labeled sample
traces and local-only tuning, and does not contact the live diagnostics API.

## Logs and traces

Core logs cover Gateway lifecycle, monitors, webhooks, worker connections, and
request failures. Worker failures include job ID, last phase, repository,
prepared branch, cause, and whether retrying is safe. Logs intentionally omit
request content.

Mac logs and traces live under:

```text
~/Library/Application Support/MiniSago/logs
~/Library/Application Support/MiniSago/traces.sqlite
```

Oracle stores equivalent state in its persistent worker volume. Traces expire
after 14 days and prune above 250 MB. See [Security](security.md#retention-and-privacy)
for their contents and exclusions.

## Common recovery procedures

### Durable-state backup and restore

Production state is backed up to the private
[sago-cream/minisago-state](https://github.com/sago-cream/minisago-state)
repository, separately from application code. Keep its local checkout alongside
this one:

```text
Bot & Infra/
  mini-sago/
  minisago-state/
```

An ordinary Mac cron job runs `minisago-state/scripts/sync.py` at five minutes
past every hour. It reads Oracle through SSH alias `sago-cloud`, commits changes,
and pushes to the backup repository's `main` branch. No Codex automation is
involved. The Mac must be awake, connected to Tailscale, and configured with the
repository-scoped SSH deploy key; the job does not use login-Keychain credentials.
Logs are at `~/Library/Logs/ObiInfra/minisago-state-sync.log`.

For a replacement Mac, follow the [Mac recovery setup runbook](https://github.com/sago-cream/obi-infra/blob/master/docs/mac-recovery-setup.md).
It covers dependencies, cloning, Git author identity, Oracle SSH/Tailscale access,
deploy-key regeneration, cron installation, and scheduled-run verification. While
[Obi infrastructure PR #4](https://github.com/sago-cream/obi-infra/pull/4) is pending,
read the runbook on its `chore/git-vault-recovery` branch. A Git clone alone does
not restore the crontab, `.git/config`, private keys, host trust, or account logins.

The allowlist includes guild-memory Markdown and its Git history, reminders,
feature availability, GitHub PR-thread mappings, and selected monitor cursors.
The reader validates JSON and requires two matching reads around the history
capture, retrying if files change. It does not stop the bot. This is a stable
file snapshot, not a cross-service transaction. When adding a new durable state
file, update the backup reader's allowlist in `minisago-state` as well.

Credentials are stored in Bitwarden folder **Obi and MiniSago Recovery**.
Media, recordings, traces, sessions, caches, dependencies, and worker checkouts
are excluded. Preserve unfinished worker code in its application remote before
discarding a workspace; uploaded media and share links are expendable under the
current recovery policy. The live guild-memory repository keeps no remote.

After moving or cloning the backup checkout, install its cron entry again:

```bash
sh ../minisago-state/scripts/install-cron.sh
python3 ../minisago-state/scripts/sync.py
```

To recover after losing the server:

1. Clone the private state repository and provision services from
   [sago-cloud](https://github.com/sago-cream/sago-cloud).
2. Restore current service credentials from Bitwarden and stop bot-core while
   restoring files.
3. Copy the contents of `state/` into the `sago_cloud_bot-core-state` volume,
   preserving the service user's ownership and private permissions.
4. Clone `history/guild-memory.bundle` into a temporary directory, remove its
   origin, and copy its `.git` directory into the restored `guild-memory`
   directory. Keep `state/guild-memory/*.md` as the latest working files. Never
   attach the backup remote to the bot's live memory repository.
5. Restart bot-core and verify memory, reminders, and feature settings. Consult
   the private backup repository's README for current recovery details.

The former Oracle bot/CouchDB snapshot and restore-test timers are retired;
Git history is the durable-state recovery source.

### Worker unavailable

1. Check `/api/health` for connected, available, capacity, active, and Mac
   status.
2. Inspect worker logs for authentication, protocol-version, Codex-login, or
   reconnect failures.
   A container marked unhealthy has also failed its local bridge, Codex login,
   or Codex app-server check.
3. Verify the worker and hosted service use the matching profile secret.
4. Confirm Codex authentication and account capacity.
5. Restart only the affected worker after correcting configuration.

Requests received while every compatible worker is unavailable are not queued;
ask the requester to retry.

### Mac helper unavailable

```bash
bun run mac-agent:status
bun run mac-agent:install
```

Confirm the session is unlocked, the bridge URL is reachable, and the edge
preserves WebSocket upgrades. Reinstalling refreshes the compiled session
monitor and LaunchAgent configuration.

### Oracle worker unavailable

```bash
docker compose -f compose.worker.yaml logs -f worker
docker compose -f compose.worker.yaml exec worker codex login status
docker compose -f compose.worker.yaml exec worker gh auth status
docker compose -f compose.worker.yaml up -d --force-recreate
```

Confirm persistent volumes are mounted and outbound HTTPS/WSS works. The worker
must not expose a public port.

### Gateway rejected

- Code `4004`: verify `DISCORD_BOT_TOKEN`.
- Code `4013`: inspect requested Gateway intents.
- Code `4014`: enable the Message Content privileged intent.
- Duplicate or transformed messages: verify only one Gateway deployment owns
  the bot token and remove retired webhooks.

### Deployment connection failure

Confirm `ssh sago-cloud` works and rerun `bun run deploy`. Do not bypass the
clean-main or image-success checks.

## Credential rotation

Rotate one boundary at a time:

1. Generate a new independent 32-byte-or-longer secret.
2. Update the hosted and matching worker configuration.
3. Restart that profile and confirm it authenticates.
4. Remove the old secret.

For GitHub credentials, authenticate the dedicated CLI state over standard
input, verify `gh auth status`, then revoke the old credential. Never copy
tokens into environment files or task text.

## Removal

Remove the Mac helper and all of its isolated state with:

```bash
bun run mac-agent:uninstall
```

This removes its secret, compiled monitor, logs, traces, and isolated GitHub
login without changing normal `~/.codex` or `~/.config/gh` state.

For a full deployment removal, stop core and worker containers, remove the
GitHub webhook, then deliberately archive or delete persistent state and
credentials according to the operator's retention requirements.

### Browser voice tests

Open `/voice-debug` and sign in with the dedicated debug token. Select **Record**, speak, then **Stop recording**. The table shows recording playback, Whisper transcript, Codex reply, VOICEVOX text, and playback status with module durations. Event details expose the underlying trace. Capture stops automatically at 30 seconds; starting another recording cancels the preceding answer and creates an isolated browser conversation.

Browser tests do not join Discord or use Discord playback. They share recognition, worker, and TTS service capacity. Each login owns its browser session; logout and expiry destroy it. Saved recordings persist in `/app/state/voice-tests`, shared by authorized dashboard users.

### Recognition models and comparisons

Live recognition defaults to **multilingual base with fixed Japanese**, beam size 1, temperature 0, and Silero VAD. `MINISAGO_WHISPER_BASE_URL` selects its server (default `http://whisper-base:8080`). The small server remains at `MINISAGO_WHISPER_URL` for comparison; quantized small uses `MINISAGO_WHISPER_QUANTIZED_URL` (default `http://whisper-quantized:8080`). Deploy `compose.voice-comparison.yaml` with `WHISPER_COMPARISON_MODEL_DIR` containing `ggml-base.bin` and `ggml-small-q5_1.bin` from the ggerganov/whisper.cpp model repository. The base service is required for live recognition.

**Compare recognition** replays a saved recording through three editable model/language cards. **Add variant** allows a fourth profile. Runs execute sequentially and persist their transcripts, timings, settings, and diagnostics. Comparisons invoke recognition only. Recording a normal turn still runs the complete conversation pipeline and saves the recording.

The library retains at most 100 recordings of up to 30 seconds and 20 runs per recording. The authenticated recording DELETE API removes fixtures; the minimal UI has no deletion control. Recognition has a 120-second deadline. Module durations can overlap and should not be summed to estimate time to first audio.

On September 7, the same 1.44-second Japanese greeting produced `こんにちは` with all three models: small 23.6 seconds, small Q5_1 37.1 seconds, base 11.4 seconds. All used fixed Japanese and identical decoding/VAD settings. These single-sample results motivated the base default; they do not establish general accuracy or realtime performance.
