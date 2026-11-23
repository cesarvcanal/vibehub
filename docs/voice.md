# Voice

vibehub has three voice features, all backed by OpenAI and all inside a card's chat:

| Feature | What the person does | OpenAI model | Needs `VIBEHUB_VOICE_LIVE=1` |
|---------|----------------------|--------------|------------------------------|
| **Dictation** | Records with the composer's microphone; the text lands in the field to review before sending | `gpt-transcribe` | No |
| **Read aloud** | Presses the speaker under a finished answer | `gpt-4o-mini-tts` | No |
| **Voice call** | Talks with a voice assistant that hands work to the card's agent and acts on the board | `gpt-live-1`, delegating to `gpt-6-luna` | Yes |

## Keys and settings

- **OpenAI key.** Stored by the owner in Settings → Voice keys (vault entry `TRANSCRIBE_OPENAI_API_KEY`).
  Dictation reads only the vault. The voice call and read aloud use `VIBEHUB_VOICE_OPENAI_API_KEY`
  when set and fall back to the vault key.
- **Claude key (optional).** Also in Settings → Voice keys. Proofreads dictation against the shared
  brain with `claude-haiku-4-5`, but only when the `transcribeProofread` setting is also `true`
  (default `false`; it has no switch in the Settings screen, only `PATCH /api/settings`).
- **Transcription language** (`transcribeLanguage`, a two-letter code or empty for auto) and
  **transcription terms** (`transcribeKeywords`, up to 100 terms of up to 60 characters) are in
  Settings → Voice input. Both go to `gpt-transcribe` as hints (`languages[]`, `keywords[]`); without
  terms, team names and jargon come out misspelled.
- **`VIBEHUB_VOICE_LIVE=1`** turns the voice call on. Off, the call routes answer 404 and the call
  button does not appear.

## Dictation

The composer's microphone records, then sends the audio to `POST /api/cards/:id/transcribe`
(`requireCardWork`, up to 20 MB as base64). The back calls OpenAI's `/v1/audio/transcriptions`
with `gpt-transcribe` and, when proofreading is on, sends the raw text to Claude; a proofread
answer that is empty or much longer than the raw text is discarded and the raw text is used.
The text is appended to the field, never sent on its own. `GET /api/transcribe` (any signed-in
person) tells the composer whether a key is stored; `POST /api/transcribe/keys` (owner) stores the
keys. During a voice call dictation is disabled: one microphone grant at a time.

The same transcription serves the MCP tool `vibehub_transcribe_audio`, which transcribes an audio
file the person attached to the runner (`services/transcribe/`, `mcp/attachmentTools.ts`).

## Read aloud

The speaker button under a finished answer (`AnswerActions.tsx`) strips the markdown, splits the
text into pieces (`readAloud.ts`) and sends each piece to `POST /api/cards/:id/voice/speech`
(`requireCardWork`). The back streams back the MP3 of OpenAI's `/v1/audio/speech`
(`gpt-4o-mini-tts`, voice `marin`), up to 4096 characters per piece and 40 pieces per person per
minute (`services/voice/speech.ts`). One answer plays at a time in the whole app; stopping or
closing the tab cancels the OpenAI request. The button shows when `GET /api/voice/live` reports
`speech: true`, which only needs a reachable key.

## Voice call

A spoken conversation with `gpt-live-1` held inside the card's chat (native SDK chat only). The
transcript appears in the same thread as typed messages, the field still takes text and
attachments during the call, and after hanging up the conversation stays in the card's history.
There is no separate page: `/voice` only redirects to the card, and `/voice/lab` is a calibration
bench for the orb.

### Session creation

```
browser (card chat)                 back (vibehub)                        OpenAI
-------------------                 --------------                        ------
call button → AudioContext created in the gesture
getUserMedia (mic)
RTCPeerConnection + "oai-events" channel
createOffer ── POST /api/cards/:id/voice/sessions {sdp} ──►
                                    requireCardWork, validates the SDP, 6 creations/min/person
                                    instructions = base + summary + recent thread
                                    delegation = responses (gpt-6-luna + tools)
                                    POST /v1/live/sessions ──────────────►  session created
setRemoteDescription ◄───────────── 201 {sessionId, sdp}
audio ◄═════════════ WebRTC direct; the back never sees the audio ═════════════►
```

GPT-Live has no ephemeral client keys, so the SDP exchange is the one step that needs the API key
and runs on the server (`services/voice/live.ts`). Each creation bills 15 s of voice up front.

The **instructions** are built per call (`cardCallInstructions`):

1. the fixed card prompt, in Portuguese, with GPT-Live's `Delegation policy` section and the
   `<|SpawnThinking|>` token that makes the voice delegate;
2. a **summary** of the card's conversation, made on the spot by `gpt-6-luna` through the Responses
   API (`services/voice/summary.ts`: 6 s timeout, `store: false`, cached per card until the thread
   changes). If the summary fails, the instructions say so and the call still starts;
3. the **recent thread** (`services/voice/context.ts`): typed messages, the agent's answers and
   earlier spoken turns, newest last, within 6000 characters. Tool calls and their output never go.

### Delegation: who does the work

The card call creates the session with `delegation: { type: "responses" }`: when the voice decides
to delegate, OpenAI runs `gpt-6-luna` with the executor instructions and seven function tools
(`services/voice/executor.ts`), one tool call at a time. The function calls arrive in the browser on
the data channel (`response.event` carrying `response.output_item.done` of type `function_call`),
and the browser runs each one (`useVoiceDelegation.ts`):

| Tool | Runs where | What it does |
|------|------------|--------------|
| `ask_card_agent` | Browser | Sends the request to the card's agent (Claude Code) as an urgent "send now" message: `[pedido por voz]`, the request and the call's recent transcript. If the agent is waiting on a question with options, the spoken choice goes as the answer to that question instead |
| `list_projects`, `list_cards` | `POST /api/cards/:id/voice/actions` | What the person reaches on the board |
| `create_card` | same | Creates a card and delivers its first instruction (owner only) |
| `send_to_card` | same | Sends an instruction to another card (never the call's own card) |
| `move_cards` | same | Moves cards to done or backlog (never the call's own card) |
| `notify` | same | Records a notice on the call's card |

The browser answers each call with `response.item.create` (a `function_call_output`) followed by
`response.create`. The actions route (`routes/voice.ts`) takes `requireCardWork` on the call's
card, validates the arguments with zod, runs the action in the name of the person
(`services/maestro/asUser.ts`, which applies that person's access) and is idempotent per person,
`callId` and tool for 10 minutes. Board refusals come back as 4xx with the reason, so the voice can
say it.

For `ask_card_agent` the tool output is immediate ("handed to the agent, not done yet"). The
agent's answer comes later: when the agent's turn on that request ends, its last answer goes to the
voice with `session.commentary.append` so it is spoken. After 45 s without an answer the voice is
told, quietly, that the agent is still working. A request that could not be sent, an agent turn
that ended without text, and a request without content all get an explicit result, so the voice
never waits forever.

The calibration lab uses `POST /api/voice/live/sessions` (any signed-in person) with
`delegation: { type: "client" }` and instructions that forbid delegating; anything that still
arrives there is answered "nobody can do that here".

### During the call

- **One source of truth:** the card's thread (`sdk-history/<card>.ndjson`, replayed by the
  `/api/cards/:id/sdk` websocket). Each spoken turn is a `voice_turn` event
  `{ vid, role, text, at, from }`. The browser settles GPT-Live's transcript fragments into turns
  (`voiceTurns.ts`: the other side speaking closes a turn; a gap over 1.5 s on the model's timeline
  opens another; 2.5 s without fragments closes it), saves them through
  `POST /api/cards/:id/voice/turns` with retry, and the back writes each `vid` once, also under a
  race and after a restart (`services/voice/turns.ts`).
- **Typed text and attachments** go through the chat's normal send, to the card's agent. GPT-Live
  takes no text, image or file input: the voice is told a message arrived
  (`session.commentary.append`) and says so. The agent's answers reach the voice as quiet context
  (`session.thinking.append`). Both are clipped to 1200 characters.
- **Agent questions:** an open question with options from the agent is read to the voice, which
  reads the options aloud and passes the choice back through `ask_card_agent`.
- **Phases** (connecting, listening, you speaking, thinking, answering, interrupted, muted,
  failed) follow real events (`voicePhase.ts`), with hysteresis: "thinking" shows only after
  0.7 s of silence following the person's speech, or while the agent works.
- **Orb:** the voice's level is measured on the remote stream with an `AnalyserNode` in the
  `AudioContext` created on the click (`audioLevel.ts`: gate −60 dBFS, window −50…−16 dBFS). If the
  analyser returns only zeros for 700 ms, it falls back to `getStats` `audioLevel`
  (inbound-rtp, every 250 ms) and then to pulses from the transcript fragments. The source in use
  is on the DOM (`data-ai-source`).
- **Mic:** mute sends `session.input_audio.mute`. One call at a time in the app; leaving the chat
  (another card, the Terminal tab) ends it.
- **Hang-up:** sends `session.close` and waits for `session.closed` (up to 15 s). Drops, startup
  errors and timeouts go through the same teardown; what was being said becomes a turn and is saved.
- **Nothing sensitive logged:** no key, SDP or audio. The audit log has the session, the person,
  the card and each action's tool name.

### Files

- back: `services/voice/{live,summary,context,executor,turns,speech}.ts`, `routes/voice.ts`,
  `services/transcribe/transcribe.ts`, the transcription routes in `routes/agent.ts`.
- front: `features/voice/` (`useVoiceCall`, `useVoiceDelegation`, `liveVoice`, `voiceDelegation`,
  `voiceQuestion`, `voiceContext`, `voiceTurns`, `voicePhase`, `audioLevel`, `readAloud`, `api`,
  `status`, `VoiceCallBar`, `VoiceTurnBubble`, `ComposerVoiceButton`, `AnswerActions`, `living/`),
  and the integration in `features/board/components/SdkChatView.tsx` and `TerminalComposer.tsx`.

## Run locally

Requirements: Node 24, an OpenAI key with access to `gpt-live-1`, a browser with a microphone.
`getUserMedia` only works on `localhost` or HTTPS.

```bash
npm run install:all

# back (port 3011, data in a throwaway directory)
cd back
VIBEHUB_VOICE_LIVE=1 \
VIBEHUB_VOICE_OPENAI_API_KEY=sk-... \
VIBEHUB_INSECURE_COOKIES=1 \
VIBEHUB_PORT=3011 VIBEHUB_DATA_DIR=/tmp/vh-voice \
npx tsx src/index.ts

# front, in another terminal
cd front
VIBEHUB_BACKEND=http://127.0.0.1:3011 npx vite --port 5184
```

1. Open `http://localhost:5184`, create the owner in the setup assistant and sign in.
2. Open a card (native chat) and press the blue wave: on desktop beside the microphone, outside the
   field; on a phone, in the field's bar while it is empty. The call bar shows above the composer.
3. Allow the microphone, wait for "listening" and talk. Talk over the answer to interrupt. Type and
   attach freely. The red button on the call bar hangs up.

Dictation also needs the OpenAI key stored in Settings: it does not read
`VIBEHUB_VOICE_OPENAI_API_KEY`.

## Run through a card's Preview (vibehub inside vibehub)

The Preview proxy serves the test instance under `/preview/<port>/`. Four details make it work
without touching the outer panel:

- **Front base:** `vite build --base /preview/<port>/`. The API, the 401 redirect and the
  websockets follow `import.meta.env.BASE_URL` (`/` in a normal build).
- **Own session cookie:** `VIBEHUB_SESSION_COOKIE=<another name>`. The proxy strips the panel's
  session cookie on the way in, and the inner instance's `Set-Cookie` would sign the owner out of
  the panel.
- **No setup or login:** `VIBEHUB_PREVIEW_PROXY_AUTH=1` (refused unless `VIBEHUB_HOST` is
  loopback). The panel's proxy already authenticated the person but forwards no identity. With the
  flag, the inner instance creates at boot a local owner `preview-owner` with a random, discarded
  password, and treats as that owner every request carrying `x-forwarded-prefix: /preview/<port>`.
  The panel drops that header from the client and sets it itself (`DROP_HEADERS` in
  `services/preview/preview.ts`), so through the panel it only exists on requests that passed the
  proxy's check. The trust boundary is the runner: processes inside it reach the port, and can
  already read the instance's data directory. The inner instance does not know which person is
  behind the proxy.
- **HTTPS:** the microphone only opens in a secure context, so open the panel over HTTPS with a
  valid certificate; over plain HTTP the browser hides `getUserMedia`.

Recipe (port 4317, front already built with that base into `$DIR/public`):

```bash
umask 077; cd back
VIBEHUB_SECRET_KEY="$(openssl rand -hex 32)" VIBEHUB_SESSION_SECRET="$(openssl rand -hex 32)" \
VIBEHUB_VOICE_LIVE=1 VIBEHUB_SESSION_COOKIE=vibehub_voice_preview VIBEHUB_PREVIEW_PROXY_AUTH=1 \
VIBEHUB_PORT=4317 VIBEHUB_HOST=127.0.0.1 VIBEHUB_DATA_DIR=$DIR/data VIBEHUB_STATIC_DIR=$DIR/public \
npx tsx src/index.ts
```

A random master key per run makes the test vault die with the process: restarting without the same
`VIBEHUB_SECRET_KEY` loses the pasted OpenAI key (the local owner is recreated on its own). In this
recipe no OpenAI key goes to env, file or log: the owner pastes it in Settings.

## Tests

```bash
cd back  && npx vitest run src/routes/voice.test.ts src/routes/voiceCard.test.ts src/routes/voiceSpeech.test.ts src/services/voice
cd front && npx vitest run src/features/voice src/features/board/components/SdkChatView.voice.test.tsx src/features/board/lib/sdkChat.voice.test.ts
```

Unit and integration tests with fakes at the edges: OpenAI's fetch, the WebRTC stack
(`fakeWebRtc.ts`) and Web Audio (`FakeAudioContext`). No test talks to the network.

**E2E in a real Chromium** (`front/e2e/voice-in-chat.e2e.mjs`, outside CI): real back and front,
with only GPT-Live (a fake `RTCPeerConnection` whose remote track is real audio synthesised in the
page), the card's Claude driver (a websocket that replays the card's real history) and the SDP
exchange simulated. It checks, among others: the call without leaving the chat, the orb reacting to
the mic and to the voice's syllables, silence at zero, typed text reaching the voice as context,
mute, the mobile layout, and turns saved once and replayed after a reload. It needs
`playwright-core` (`NODE_PATH`) and Playwright's Chromium; the file header has the command.

## Limitations

- GPT-Live takes no text, image or file: attachments go to the card's agent through the chat and the
  voice only hears that they arrived.
- `ask_card_agent` carries what the voice understood. If the transcription got it wrong, the agent
  gets the mistake; the call's recent transcript goes along so it can disambiguate.
- A spoken action runs as if the person had typed or clicked it: there is no extra confirmation.
- Interrupting is by voice (the model's barge-in).
- The creation and read-aloud ceilings, the actions' idempotency and the summary cache are in
  memory, per process: during a blue/green deploy or with several replicas they are not shared.
- The call sets no voice, so GPT-Live uses its default; the instructions are in Portuguese.
- Only the native SDK chat offers the call; the classic transcript chat does not.
