# Voice (Goals 20, 21, 22, 24)

Everything here is optional: without the keys below, audio is declined politely and text works as usual.
Voice has its **own monthly budget** (default $5, warning at 80%), separate from the text budget, stored in
`provider_usage`. At the limit it stops calling providers; it never switches to another provider to get
around the limit.

## What you set up

| Variable | Where | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | web + worker | Transcription (Whisper) and the OpenAI speech fallback |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | web + worker | Epi's spoken voice (preferred) |
| `VOICE_MONTHLY_BUDGET_USD`, `VOICE_BUDGET_WARN_PERCENT` | web + worker | Spending limit |
| `VOICE_*_USD_*` | web + worker | Prices used to meter spending; confirm against the providers' pricing pages |

For live voice the bot also needs the **Connect** and **Speak** permissions (invite permissions integer
`3214352`, which adds them to the earlier `68624`). The Guild Voice States gateway intent it uses is not
privileged, so it needs no Developer Portal toggle.

## Audio messages (Goal 20)

Send a Discord voice message or an audio file (mp3, m4a, ogg, wav, webm) in a DM or your private
`#assistant`. Epi downloads it into memory, transcribes it, and runs the text through **exactly the same
path as typed text** (same confirmations, same permissions). Limits: 8 MB and 5 minutes by default.

- Unsupported, oversized, too-long, or empty audio is refused with a clear message.
- If the transcription is unreliable, Epi shows what it thinks you said and asks; it acts only after you
  say yes (or type it instead).
- Raw audio is **never stored**: it exists in memory for the call. Transcripts are not kept beyond the
  normal conversation record.
- If transcription is not configured or the voice budget is used up, Epi says so and text keeps working.

## Spoken replies (Goal 21)

Turn them on by saying so ("talk back to me"). Replies then also arrive as an **audio attachment** (mp3)
next to the text, which is always sent first. This does not need a voice channel. ElevenLabs is tried first,
then OpenAI speech, and only while the voice budget allows; any failure leaves the text reply as it is.
Discord's native voice-message format is **not** promised: ordinary audio attachments are used.

## Live voice in a server voice channel (Goal 22)

Design reference: DiscordNPC's voice handler (join/leave, per-speaker buffers, silence-triggered
processing, Whisper then ElevenLabs with an OpenAI fallback, idle exit). It is Python and uses private
discord.py internals, so it is a design reference only; Epiphany uses the maintained `@discordjs/voice`
(with `@snazzah/davey` for Discord's current end-to-end voice encryption, `opusscript` and
`libsodium-wrappers`). Playback uses Ogg Opus, so **no ffmpeg is needed**.

- Say, from a voice channel, "join my voice channel" (any wording). Epi joins, and **announces in text
  that it is listening** and how to stop it.
- It acts **only on your voice**: other speakers are never subscribed to or transcribed.
- "Stop listening", "start listening again", "mute your voice" (keep replies as text), and "leave" all
  work conversationally. It leaves by itself after five quiet minutes.
- Audio is decoded in memory and discarded after transcription.
- **Spoken answers are heard by everyone in the channel.** The written copy goes to your DM, not the text
  channel. Don't ask for private details aloud when others are listening.
- Rules (who is acted on, when listening, idle exit) are unit tested in `packages/core/src/voice/session.ts`.

## Dashboard push-to-talk (Goal 24)

In the dashboard chat, **hold the microphone button** (or hold Space/Enter while it is focused) to record
and release to send. The mic is open only while held and the browser shows its own recording indicator.
The audio is sent to the server only to be turned into text, then runs the same path as typed text.
Replies can be spoken (when spoken replies are on) and a **Stop speaking** button interrupts them; sending
or recording also interrupts.

Limits: needs HTTPS and microphone permission; recording is capped at 60 seconds. A **"Hey Epi" wake
word is not implemented**: browsers cannot listen with the tab closed or in the background, and an
always-on microphone would be neither private nor reliable. Push-to-talk is the supported activation.

## Not verified live

Everything is tested against fake providers and fake Discord objects. A real run is still needed for:
transcription accuracy and cost, ElevenLabs output, joining a real voice channel, receiving per-speaker
audio, Opus decoding in the deployed image, DAVE negotiation, and playback.
