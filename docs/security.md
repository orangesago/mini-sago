# Security

MiniSago treats the hosted Discord service as the authority boundary and Codex
workers as constrained executors. Model output never grants its own
permissions.

## Capability boundary

| Capability                                        | Community | Owner                    |
| ------------------------------------------------- | --------- | ------------------------ |
| Conversation and public web research              | Yes       | Yes                      |
| Permission-filtered Discord context               | Yes       | Yes                      |
| Host-bound reminders and voice actions            | Yes       | Yes                      |
| Cross-channel messaging and expression management | No        | Yes                      |
| Repository checkout and developer commands        | No        | Yes                      |
| GitHub mutation                                   | No        | Owner-routed tasks only  |
| Mac file search and upload                        | No        | Explicit Mac target only |

The hosted service checks requester identity before dispatch. The worker checks
the declared capabilities again before Codex runs. Authorization never depends
on matching phrases in the request.

CCXP meeting tools require an explicit owner-managed guild registration and a
configured read-only index mount. DMs and unregistered guilds have no access,
even for the bot owner. Registration uses the persistent `ccxp_meetings`
feature policy; revocation is checked again on every tool call. Owner-only manual
sync tools write request metadata to a separate shared control volume; they cannot
write the index, access credentials, or override the rejected-password pause. A separate collector holds the CCXP account,
browser profile, and session; these are never exposed to core or Codex. MCP
results contain bounded text and session-free category links. Password changes
remain manual, with deduplicated owner DMs when login requires attention. See
[CCXP meeting retrieval](ccxp-meetings.md) for retention and recovery.

## Discord boundaries

Chatbot access uses an owner ID, allowed guilds, and optional channel
exceptions. Ambient reactions use the same community boundary. Guild searches
include only channels where the requester has View Channel and Read Message
History; if role data cannot be loaded, search falls back to the current
channel.

Member roles, join dates, presence, and reaction-member lists are not sent to
Codex. Host-bound tools cannot use model arguments to substitute another
requester, guild, member, or channel.

MiniSago captures voice-channel audio only after a member explicitly asks her
to join. A private Whisper service on the same host transcribes each bounded
utterance with the bundled model. The bot deletes temporary audio and sends only
the transcript to the configured Codex worker as a normal answer job. A private
VOICEVOX engine on the same host synthesizes spoken replies with the Nekotsuka
Bi voice. Raw voice audio never reaches Codex or an external speech API;
transcripts and answers follow the normal trace retention policy below.

The owner may copy an emoji between shared guilds, create one from an image
attached directly to the request or its replied-to message, or rename an
existing emoji. The destination bot role must have Create Expressions to add
and Manage Expressions to rename. Community users never receive these tools.

## Worker authentication and isolation

Oracle and Mac use independent random bridge secrets of at least 32 bytes. The
secret selects a fixed server-owned profile; workers cannot raise their own
capabilities or priority.

Every Codex run ignores normal user configuration, memories, plugins, and
user-configured MCP servers. Chat jobs cannot read installed skills, have
restricted filesystem access, and have no general network permission outside
Codex's own web search and MiniSago's MCP server.

Oracle development jobs can read the skills installed in their isolated Codex
home. Oracle snapshots the linked skill commits only when the trusted Skillbook
repository advances, rejects symbolic links, and replaces managed skill
directories as one transaction. A linked skill is trusted developer guidance,
so only reviewed Skillbook changes should advance the snapshot. The Mac helper
does not sync or replace the Mac's local skills.

Kyushu itinerary access is exposed only when the host-bound Discord guild is
`1282936453134815275`. Reads use the public planner endpoint; edits require a
dedicated service token kept by the hosted service. The model receives typed
read and edit tools, never the token or raw database access. Locked schedule
items remain immutable.

The Linux worker uses Codex's Bubblewrap sandbox inside the container.
Production allows only its required namespace and mount syscalls and loads the
dedicated AppArmor profile. The worker process remains unprivileged.

## Attachments and Mac files

Only answer jobs download attachments. Supported formats are images, short
audio/video files, PDFs, and text files, with these limits:

- at most 10 attachments;
- at most 20 MB per attachment and 40 MB total; and
- at most 100,000 extracted characters per file and 200,000 total.

Downloads accept only Discord HTTPS CDN hosts and stop on cancellation. Coding
task files remain with the retained workspace; other downloads are deleted after
the response. Attachment URLs are stripped from observable tool results and
sanitized in traces. After a CDN 403, 404, or 410, the host may fetch a registered
attachment's original message through the bot API and retry once with the refreshed
URL for that same attachment. It rejects missing attachments and non-CDN URLs.

Owner-authorized Linux coding jobs also receive `download_attachment`. It accepts
only a media ID registered to the task's bearer token and returns the original
file's local path within the task's attachment folder, including attachments
resolved after the task started. The caller cannot supply a URL or destination.
Ordinary chat jobs do not receive this file-path tool.

Generated media is request-local and may be returned only by an opaque artifact
identifier from the job's dedicated output folder. The worker rejects path
escapes, symlinks, unsupported media extensions, files above 8 MB, and more than
one output before sending bytes to the hosted service. Generated files are
deleted with the downloaded attachments after the response.

The Linux media MCP accepts only opaque media IDs registered to the active
bearer token. The host registry admits Discord CDN inputs and bounded generated
bytes; it never resolves caller-supplied paths or URLs. This lets attachments,
member avatars, and generated outputs compose without broadening network or
filesystem authority. Typed transformations replace shell commands and raw
FFmpeg arguments. Inspection omits source metadata and tags; transformations
strip output metadata. Inputs are limited to 20 MB, 10 minutes, 8,192 pixels per
dimension, and 40 megapixels. Commands use fixed local protocols, two threads,
and a 45-second deadline. Presets further limit generated clips to 15 seconds
for GIF, 30 seconds for MP4, and 120 seconds for MP3.

Mac file requests are owner-only and read-only. Search is limited to configured
roots, and the host revalidates the exact path before uploading at most one
regular file of 8 MB or less. Symlinks and paths outside the roots are rejected.

Coding evidence uploads are selected by local image references in the final
answer, excluding code examples. The worker resolves each path and admits only
regular PNG, JPEG, GIF, or WebP files inside the selected repository or current
turn's output folder, with matching image signatures. Paths and symlinks that
escape those roots are rejected. The worker and host both enforce at most 10
attachments and 8 MB combined; remote image URLs are never fetched for upload.

## Owner development and GitHub

Development jobs receive one selected disposable repository checkout. GitHub
uses a dedicated persistent `gh` login. Workers discover every repository that
credential can access rather than maintaining a second application allowlist.
Tokens must never be placed in Discord, tasks, environment files, shell
arguments, or repository content.

Only the configured owner can route work to Oracle. Every Oracle job uses a
prepared feature branch, and per-job `gh` and `git` wrappers permit ordinary
repository work without a second inferred authorization scope:

- issue operations are allowed;
- the prepared feature branch may be pushed and used to open a draft PR;
- an explicit owner request may merge a pull request without administrative
  bypass; and
- PR edits, comments, reviews, ready-for-review, release management, workflow
  management and Actions reruns are allowed within the owner's requested work;
  protected-branch and force pushes are denied.

GitHub rulesets must independently block direct and force pushes to protected
branches. The credential should have repository contents, issues, and pull
request access plus read access to checks. Release mutations require Contents
write access; workflow mutations and Actions reruns require Actions write access.
Never grant administration, secrets, environments, deployments, organization, or unrelated
repository access. Credential and ruleset setup is tracked in
[issue #12](https://github.com/sago-cream/mini-sago/issues/12).

The production Oracle worker exposes `deploy_minisago` only to jobs for the
configured MiniSago repository. A small MCP adapter calls the existing deployment
socket outside the shell sandbox, so the socket is never a writable directory
root. The tool accepts a full MiniSago commit SHA and fixes the originating
Discord thread ID from the job. The host verifies the fixed
request shape and deploys the matching immutable core and worker image tags.
Codex receives no Docker socket, SSH credential, command argument, host path,
or general deployment target through this channel. The bot reads the terminal
status from a read-only mount and checkpoints its Discord notification in the
existing persistent state volume.

## Retention and privacy

Metadata-only worker logs exclude prompts, Discord messages, answers, links,
and attachment contents. Debug traces may contain message context, sanitized
attachment metadata, bounded MCP tool names and arguments, model output,
errors, and timings. They never contain MCP tokens, signed URL parameters,
tool-result message bodies, or downloaded attachment bodies.

Traces are owner-readable, expire after 14 days, and are pruned oldest-first
above 250 MB. `resolve_context` can expose bounded operational metadata from the
same channel when `includePreviousTrace` is requested. It never returns private
chain-of-thought.
