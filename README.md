# OpenClaw Discord Realtime Voice

Voice bridge: Discord voice channel ↔ pluggable voice providers with tool calling.

Speak into Discord, the provider handles STT + reasoning + optional tool calls + TTS, and the reply streams back into the channel.

## Providers

### 1. `openai-realtime` (default)

Lowest latency, single speech-to-speech WebSocket.

```json5
{
  plugins: {
    entries: {
      "discord-realtime": {
        enabled: true,
        config: {
          provider: "openai-realtime",
          followUserIds: ["YOUR_DISCORD_USER_ID"],
          systemPrompt: "You are a drone commander. Execute commands immediately. Be concise.",
          openai: {
            model: "gpt-4o-realtime-preview",
            voice: "coral",
            turnDetection: "semantic_vad"
          }
        }
      }
    }
  }
}
```

Env:

```bash
OPENAI_API_KEY=...
```

### 2. `elevenlabs`

Cascaded pipeline: ElevenLabs Scribe STT → OpenAI or Anthropic LLM → ElevenLabs TTS.
Higher latency, better voice flexibility.

```json5
{
  plugins: {
    entries: {
      "discord-realtime": {
        enabled: true,
        config: {
          provider: "elevenlabs",
          followUserIds: ["YOUR_DISCORD_USER_ID"],
          systemPrompt: "You are a smart home copilot. Be concise.",
          silenceMs: 1500,
          silenceThreshold: 200,
          elevenlabs: {
            apiKey: "env:ELEVENLABS_API_KEY",
            voiceId: "pNInz6obpgDQGcFmaJgB",
            modelId: "eleven_flash_v2_5"
          },
          llm: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKey: "env:ANTHROPIC_API_KEY"
          }
        }
      }
    }
  }
}
```

Env values can also be set directly in the environment:

```bash
ELEVENLABS_API_KEY=...
ANTHROPIC_API_KEY=...
# or if llm.provider is "openai"
OPENAI_API_KEY=...
```

### 3. `local`

Placeholder only for now.

Planned stack: Whisper.cpp STT → Ollama LLM → Kokoro TTS.

## Architecture

```
You speak in Discord voice channel
    ↓
PCM 48kHz stereo → Opus decode → downsample → PCM 24kHz mono
    ↓
Selected provider
    → openai-realtime: STT + reasoning + tool calling + TTS
    → elevenlabs: STT + LLM + tool calling + TTS
    ↓
Response audio → upsample → Opus encode → Discord voice
```

## Install

```bash
openclaw plugins install -l ~/Documents/Git/openclaw-discord-realtime
```

## Configure

In your OpenClaw config (`~/.openclaw/config.json`):

```json5
{
  plugins: {
    entries: {
      "discord-realtime": {
        enabled: true,
        config: {
          provider: "openai-realtime",
          followUserIds: ["YOUR_DISCORD_USER_ID"],
          systemPrompt: "You are a voice assistant. Be concise.",
          openai: {
            model: "gpt-4o-realtime-preview",
            voice: "coral",
            turnDetection: "semantic_vad"
          }
        }
      }
    }
  }
}
```

Backward compatibility is preserved. If `provider` is omitted, the plugin defaults to `openai-realtime` and still accepts the legacy flat fields `model`, `voice`, and `turnDetection`.

## How it works

1. Plugin registers a gateway hook
2. When a followed user joins voice, the bridge activates
3. Discord audio is streamed into the selected provider
4. Provider audio streams back into Discord
5. When the followed user leaves, the bridge tears down cleanly

## Status

Check bridge status:

```text
/rtstatus
```

## Requirements

- Node >= 22
- OpenClaw with Discord channel configured
- `@discordjs/opus` native bindings
- Provider-specific API keys, depending on the selected provider
