# OpenClaw Discord Realtime Voice Bridge

> **Sub-500ms voice control for anything via Discord + OpenAI Realtime API**

Speak into a Discord voice channel → OpenAI processes speech, reasons, calls your tools, and speaks the result back — all in a single WebSocket round-trip. No STT → LLM → TTS pipeline. One hop.

Built as an [OpenClaw](https://openclaw.ai) skill. Available on [ClawHub](https://clawhub.com) as a premium skill.

---

## How It Works

Two provider options — same Discord interface, different latency/quality trade-offs:

### `openai-realtime` (default) — ~500ms
```
You speak in Discord voice
    ↓
PCM 24kHz mono → OpenAI Realtime API (WebSocket)
    → STT + reasoning + function calling + TTS in ONE pass
    ↓
HTTP calls to YOUR endpoints (via tools.json)
    ↓
Response audio → Discord voice
```

### `elevenlabs` — ~1–2s
```
You speak in Discord voice
    ↓
PCM → silence detection (VAD)
    ↓
ElevenLabs Scribe  (STT)
    ↓
OpenAI / Anthropic LLM  (reasoning + function calling)
    ↓
HTTP calls to YOUR endpoints (via tools.json)
    ↓
ElevenLabs TTS  (high-quality audio)
    ↓
Response audio → Discord voice
```

### `cascade` — mix-and-match (~800ms–2s)
```
You speak in Discord voice
    ↓
PCM → Deepgram streaming WebSocket  (STT, real-time)
         or ElevenLabs Scribe / Whisper (batch, on silence)
    ↓
Groq / OpenAI / Anthropic  (LLM + function calling)
    ↓
HTTP calls to YOUR endpoints (via tools.json)
    ↓
ElevenLabs / OpenAI TTS  (audio synthesis)
    ↓
Response audio → Discord voice
```

**Mix-and-match combinations:**

| STT | LLM | TTS | Use case |
|-----|-----|-----|----------|
| Deepgram | Groq Llama | ElevenLabs Flash | ⚡ Speed demon (~800ms) |
| Deepgram | Anthropic Claude | ElevenLabs Flash | 🧠 Smart + great voice (~1s) |
| Deepgram | OpenAI GPT-4o | ElevenLabs | 🎯 Balanced |
| Whisper | Anthropic Claude | OpenAI TTS | 💰 Cheapest OpenAI combo |
| ElevenLabs Scribe | Groq | ElevenLabs | 🎙️ Best ElevenLabs quality |

### `local` — v2 placeholder
Planned: Whisper.cpp + Ollama + Piper/Kokoro. Fully offline, no cloud APIs. Not yet implemented.

---

## Install

```bash
# Via npm
npm install -g openclaw-discord-realtime

# Or clone
git clone https://github.com/your-org/openclaw-discord-realtime
cd openclaw-discord-realtime
npm install
```

### Via ClawHub (OpenClaw users)

```bash
clawhub install openclaw-discord-realtime
```

> **Note:** This is a premium skill on ClawHub. It requires an active OpenClaw subscription and consumes OpenAI Realtime API credits (approximately $0.06/min of audio).

---

## Quick Start

```bash
# 1. Set up environment
cp .env.example .env
# Edit .env with your DISCORD_BOT_TOKEN and OPENAI_API_KEY

# 2. Run with the generic assistant (no tools)
openclaw-discord-realtime

# 3. Or run with custom tools
openclaw-discord-realtime --config config.json --tools tools.json

# 4. In Discord, go to a voice channel and type:
#   !join
```

---

## Configuration

Two JSON files control the bridge's behaviour. Point to them with CLI flags:

```bash
openclaw-discord-realtime --config path/to/config.json --tools path/to/tools.json
```

### config.json

Controls the provider, AI personality, and audio settings:

```json
{
  "provider": "openai-realtime",
  "systemPrompt": "You are a helpful voice assistant. Execute commands immediately when asked. Be concise — respond in 1-2 sentences.",
  "voice": "coral",
  "model": "gpt-realtime",
  "turnDetection": "semantic_vad"
}
```

| Field | Provider | Description |
|-------|----------|-------------|
| `provider` | all | `"openai-realtime"` \| `"elevenlabs"` \| `"cascade"` \| `"local"` |
| `systemPrompt` | all | Instructions for the AI |
| `voice` | all | OpenAI voice name **or** ElevenLabs voice ID |
| `model` | `openai-realtime` | OpenAI Realtime model |
| `turnDetection` | `openai-realtime` | VAD mode (`semantic_vad` recommended) |
| `llmProvider` | `elevenlabs` | LLM backend: `"openai"` or `"anthropic"` |
| `llmModel` | `elevenlabs` | LLM model name (e.g. `"gpt-4o"`, `"claude-opus-4-5"`) |
| `silenceMs` | `elevenlabs` / `cascade` | ms of silence before processing speech (default: 800/1500) |
| `silenceThreshold` | `elevenlabs` / `cascade` | RMS level below which audio is silence (default: 200) |
| `stt` | `cascade` | STT config block — see Cascade Provider below |
| `llm` | `cascade` | LLM config block — see Cascade Provider below |
| `tts` | `cascade` | TTS config block — see Cascade Provider below |

### Cascade Provider config

The `cascade` provider accepts separate `stt`, `llm`, and `tts` config blocks:

```json
{
  "provider": "cascade",
  "systemPrompt": "You are a helpful voice assistant. Be concise.",
  "stt": {
    "provider": "deepgram",
    "model": "nova-2",
    "apiKey": "env:DEEPGRAM_API_KEY",
    "language": "en"
  },
  "llm": {
    "provider": "groq",
    "model": "llama-3.3-70b-versatile",
    "apiKey": "env:GROQ_API_KEY"
  },
  "tts": {
    "provider": "elevenlabs",
    "voiceId": "pNInz6obpgDQGcFmaJgB",
    "modelId": "eleven_flash_v2_5",
    "apiKey": "env:ELEVENLABS_API_KEY"
  }
}
```

**Supported STT providers:** `deepgram` (streaming WebSocket), `elevenlabs` (Scribe batch), `whisper` (OpenAI batch)

**Supported LLM providers:** `groq` (fastest inference), `openai` (Chat Completions), `anthropic` (Messages API with tool_use)

**Supported TTS providers:** `elevenlabs` (streaming PCM), `openai` (TTS API)

### tools.json

Defines the functions the AI can call:

```json
{
  "tools": [
    {
      "name": "my_action",
      "description": "What this action does — the AI reads this to decide when to call it",
      "endpoint": {
        "method": "POST",
        "url": "https://your-service.example.com/my_action"
      },
      "parameters": {
        "type": "object",
        "properties": {
          "item": { "type": "string", "description": "The item to act on" }
        },
        "required": ["item"]
      },
      "defaults": { "item": "default" }
    }
  ]
}
```

Each tool maps to any HTTP endpoint — your own service, Home Assistant, a local API server, anything.

---

## Examples

### Generic — Webhooks

A simple starting point showing how to wire up three HTTP tools:

```bash
openclaw-discord-realtime \
  --config examples/generic/config.json \
  --tools examples/generic/tools.json
```

> "What time is it?" → `get_time()` → "It's 14:32 UTC."

> "Turn on the lights" → `run_action(action=turn_on, target=lights)` → "Lights are on."

### Home Assistant — Smart Home

Control lights, thermostat, and doors (uses `elevenlabs` for higher-quality voice):

```bash
openclaw-discord-realtime \
  --config examples/home-assistant/config.json \
  --tools examples/home-assistant/tools.json
```

Or with the cascade provider (Deepgram + Claude + ElevenLabs):

```bash
openclaw-discord-realtime \
  --config examples/home-assistant/config-cascade.json \
  --tools examples/home-assistant/tools.json
```

Tools: `turn_light_on`, `turn_light_off`, `set_thermostat`, `get_thermostat`, `lock_door`

> "Turn off the living room lights" → `turn_light_off(living_room)` → "Living room lights off."

> "Set temperature to 21 degrees" → `set_thermostat(21)` → "Thermostat set to 21°C."

---

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot → Enable **Message Content Intent** and **Server Members Intent** and **Voice States**
3. Generate a bot token → add to `.env`
4. Invite the bot with scopes: `bot` + permissions: `Connect`, `Speak`, `Use Voice Activity`, `Read Messages`, `Send Messages`

---

## Discord Commands

| Command | Description |
|---------|-------------|
| `!join` | Bot joins your current voice channel |
| `!leave` | Bot leaves voice channel |
| `!say <text>` | Send text to AI (useful for testing without speaking) |
| `!status` | Show connection status, model, voice, tools count |

---

## Environment Variables

```bash
# Required
DISCORD_BOT_TOKEN=your_discord_bot_token
OPENAI_API_KEY=your_openai_api_key       # also used as LLM key for elevenlabs/openai

# Required for elevenlabs provider
ELEVENLABS_API_KEY=your_elevenlabs_key

# Required for elevenlabs + anthropic LLM, or cascade + anthropic
ANTHROPIC_API_KEY=your_anthropic_key

# Required for cascade + deepgram STT
DEEPGRAM_API_KEY=your_deepgram_key

# Required for cascade + groq LLM
GROQ_API_KEY=your_groq_key

# Optional: auto-join on startup
DISCORD_GUILD_ID=your_guild_id
DISCORD_VOICE_CHANNEL_ID=voice_channel_id

# Optional: listen only to one user
DISCORD_LISTEN_USER_ID=discord_user_id

# Optional: override config.json values
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_VOICE=coral
```

---

## Pricing Note

This skill uses the **OpenAI Realtime API**, which is billed by audio duration:
- Input audio: ~$0.06/min
- Output audio: ~$0.24/min

Typical voice command: ~2–5 seconds in, ~1–3 seconds out = **~$0.01–0.03 per interaction**.

The skill itself is available as a **premium ClawHub skill** — a one-time purchase that includes lifetime updates and examples.

---

## Architecture Notes

- **Provider abstraction** — swap between `openai-realtime`, `elevenlabs`, or future `local` by changing one line in config.json
- **Same tool config works across providers** — tools.json is provider-agnostic
- **Single WebSocket** for `openai-realtime` — no separate STT or TTS APIs
- **Cascaded HTTP calls** for `elevenlabs` — Scribe STT → LLM → ElevenLabs TTS
- **Semantic VAD** for natural turn detection (no push-to-talk)
- **Barge-in support** — speaking interrupts the AI's current response
- **Streaming audio** — response starts playing before the AI finishes generating
- Tools are **pure HTTP** — works with any backend that has a REST API

---

## License

MIT
