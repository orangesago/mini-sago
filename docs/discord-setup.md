# Discord Setup

This guide configures the Discord application, Gateway, and permissions.
Configure workers separately using [Workers](workers.md).

## Create and configure the application

1. Create a Discord application and bot.
2. Enable **Bot → Privileged Gateway Intents → Message Content**. Without it,
   Discord closes the Gateway with code `4014` and message features cannot read
   content.
3. Set **Installation → Install Link** to **Discord Provided Link**.
4. Copy `.env.example` to `.env.local` and provide the application ID, bot
   token, owner ID, and intended guild/channel access.
5. Run `bun run sync:install` to update the application's Default Install
   Settings and register `/ask` globally or in the configured guild. The
   command accepts a prompt in a public channel and returns an ephemeral answer
   visible only to its requester. The sync also clears any HTTP Interactions
   Endpoint URL so commands continue through MiniSago's existing Gateway
   connection. Install with the `bot` scope. Application defaults affect new
   installs only; update existing bot roles and channel overrides manually.

## Permissions

The synchronized permission bitfield is `9124124388416`:

- Add Reactions
- View Channels
- Send Messages
- Manage Messages
- Embed Links
- Read Message History
- Connect
- Speak
- Manage Webhooks
- Manage Expressions
- Manage Threads
- Create Public Threads
- Send Messages in Threads
- Create Expressions

Manage Messages pins PR review requests and lets MiniSago replace original
Instagram, X, and Threads messages after their proxy succeeds. Embed Links and
Manage Webhooks let those replacements retain the sender's display name and avatar
while showing the improved social embed. Thread permissions support review
discussions. Add Reactions supports answer and ambient reactions. Connect and
Speak let MiniSago join a member's voice channel and answer aloud. A private,
persistent Whisper service transcribes speech. The configured Codex worker
streams complete Japanese sentences to a private VOICEVOX engine, so playback
can begin before the full reply is ready. The voice credit is
`VOICEVOX:猫使ビィ`. Create Expressions is needed in every destination guild
where the owner may add emoji. Manage Expressions is needed where the owner may
rename emoji.

Once MiniSago joins, she responds to speech whenever she is idle; no wake word
or exact transcription of her name is required. While she is answering, direct
calls to Sago and corrections from the current speaker can take over. Unrelated
chatter pauses the answer without replacing it.

MiniSago prewarms a slow `うーん…` thinking cue when the gateway starts. It plays
at most once, after two seconds of processing. Speech suppresses the cue, and a
ready answer cuts it off.

Speech pauses a pending answer. Playback resumes only after everyone is quiet
and pending transcription has been resolved. Direct calls to Sago or explicit
corrections and stop commands from the current speaker replace or stop the
answer. Replacing a turn aborts its synthesis and cancels its worker job; the
replacement waits for cancellation acknowledgement (or the bridge's existing
10-second cancellation timeout). Successive corrections supersede intermediate
answers that have not started. Played sentences are kept in context; an
interrupted sentence is marked as potentially only partly heard.

The bot transcribes one utterance at a time, keeps at most three pending
utterances, and drops the oldest on overflow. Pending audio older than 15 seconds
is discarded. Recognition has an eight-second deadline, also bounded by that
15-second audio age limit, so a stalled recognizer cannot leave playback paused
indefinitely. Leaving the channel aborts recognition and answer work.

WebRTC voice activity detection confirms 100 ms of consecutive voiced audio
before pausing playback and submitting short commands. Briefer bursts are
ignored. Utterances end after 700 ms of silence. The shorter start threshold
should be checked with real microphones for false interruptions before tuning
endpointing further.

## Gateway ownership

Run only one Gateway-enabled deployment per bot token. Set
`DISCORD_GATEWAY_DISABLED=true` on temporary or HTTP-only instances while
production is connected.

MiniSago creates one `MiniSago Social Links` webhook per active parent channel
and reuses it for that channel's threads. Removing one under **Server Settings
→ Integrations → Webhooks** is safe; MiniSago recreates it when the next social
link arrives.

## GitHub review webhook

In the configured repository under **Settings → Webhooks**, create:

- Payload URL: `<public-origin>/api/github/webhook`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET`
- Events: **Pull requests** only

In `sago-cream/skills`, create a second webhook with the same payload URL,
content type, and secret. Subscribe it to **Pushes** only. A push to `main`
queues an immediate refresh on the connected Oracle worker.

Production posts to the `專案討論` channel `1521506395034226830` in guild
`1521168712579682567`. MiniSago needs view, send, history, public-thread,
thread-send, and thread-management permission there. Persist the mapping state
so repeated deliveries reuse the same thread and closed pull requests archive
the correct discussion.
