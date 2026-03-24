---
name: openclaw-discord-realtime
description: Sub-500ms voice control via Discord voice with configurable AI providers (OpenAI Realtime or ElevenLabs) and custom function calling tools
version: 1.1.0
metadata:
  openclaw:
    emoji: "🎙️"
    requires:
      bins:
        - node
      env:
        - OPENAI_API_KEY
        - DISCORD_BOT_TOKEN
---

# openclaw-discord-realtime

Sub-500ms voice control for **anything** via Discord voice channels and OpenAI Realtime API.

Speak into Discord → AI understands + calls your tools → speaks the result back. All in one WebSocket round-trip.

## Quick Start

```bash
# Install
npm install -g openclaw-discord-realtime

# Copy and fill in your secrets
cp .env.example .env

# Run with default config (generic assistant, no tools)
openclaw-discord-realtime

# Run with custom tools
openclaw-discord-realtime --config examples/generic/config.json --tools examples/generic/tools.json
```

## Providers

Set `"provider"` in config.json to choose the AI backend:

| Provider | Latency | Description |
|----------|---------|-------------|
| `openai-realtime` | ~500ms | Speech-to-speech via OpenAI Realtime API (default) |
| `elevenlabs` | ~1–2s | ElevenLabs Scribe STT → OpenAI/Anthropic LLM → ElevenLabs TTS |
| `cascade` | ~800ms–2s | Mix-and-match STT + LLM + TTS providers |
| `local` | TBD | v2 placeholder — Whisper.cpp + Ollama + Piper (not yet implemented) |

## Configuration

Two files control behaviour:

### config.json

```json
{
  "provider": "openai-realtime",
  "systemPrompt": "You are a helpful voice assistant. Execute commands immediately when asked. Be concise — respond in 1-2 sentences.",
  "voice": "coral",
  "model": "gpt-realtime",
  "turnDetection": "semantic_vad"
}
```

For `elevenlabs`:
```json
{
  "provider": "elevenlabs",
  "llmProvider": "openai",
  "llmModel": "gpt-4o",
  "systemPrompt": "You are a helpful voice assistant. Be concise.",
  "voice": "JBFqnCBsd6RMkjVDRZzb",
  "silenceMs": 800
}
```

### tools.json

```json
{
  "tools": [
    {
      "name": "my_tool",
      "description": "What this tool does",
      "endpoint": { "method": "POST", "url": "https://your-service.example.com/my_tool" },
      "parameters": {
        "type": "object",
        "properties": {
          "arg1": { "type": "string", "description": "First argument" }
        },
        "required": ["arg1"]
      },
      "defaults": { "arg1": "default_value" }
    }
  ]
}
```

Each tool maps to an HTTP endpoint. The AI calls it, you get the result spoken back.

## Examples

See the `examples/` directory:

- `examples/generic/` — Simple webhook tools showing the format
- `examples/home-assistant/` — Smart home (lights, thermostat, locks)

## Discord Commands

| Command | Description |
|---------|-------------|
| `!join` | Join your current voice channel |
| `!leave` | Leave voice channel |
| `!say <text>` | Send text to the AI (testing) |
| `!status` | Show connection status |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ | Discord bot token |
| `OPENAI_API_KEY` | ✅ | OpenAI API key (also used as LLM key for elevenlabs/openai) |
| `ELEVENLABS_API_KEY` | elevenlabs provider / cascade tts=elevenlabs or stt=elevenlabs | ElevenLabs API key |
| `ANTHROPIC_API_KEY` | elevenlabs + anthropic LLM / cascade llm=anthropic | Anthropic API key |
| `DEEPGRAM_API_KEY` | cascade stt=deepgram | Deepgram API key for streaming STT |
| `GROQ_API_KEY` | cascade llm=groq | Groq API key for fastest inference |
| `DISCORD_GUILD_ID` | Optional | Guild to auto-join |
| `DISCORD_VOICE_CHANNEL_ID` | Optional | Voice channel to auto-join |
| `DISCORD_LISTEN_USER_ID` | Optional | Only listen to this user |
| `OPENAI_REALTIME_MODEL` | Optional | Override model from config |
| `OPENAI_VOICE` | Optional | Override voice from config |
