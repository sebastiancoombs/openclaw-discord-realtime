# OpenClaw Discord Realtime Voice

Voice bridge: Discord voice channel ↔ OpenAI Realtime API with tool calling.

Speak into Discord → OpenAI Realtime processes speech + calls tools + speaks back. Single WebSocket round-trip. ~300–500ms latency.

## Architecture

```
You speak in Discord voice channel
    ↓
PCM 48kHz stereo → Opus decode → downsample → PCM 24kHz mono
    ↓
OpenAI Realtime API (WebSocket)
    → STT + reasoning + function calling + TTS in one pass
    ↓
Tool calls → api.runtime.invokeTool() → any registered OpenClaw tool
    ↓
Response audio → upsample → Opus encode → Discord voice
```

**One bot.** Uses OpenClaw's existing Discord gateway (Carbon). No second bot token.

**Any tool.** The Realtime API calls tools registered in OpenClaw via `api.registerTool()`. Register drone commands, home automation, or anything — voice controls it.

## Install

```bash
# Link for development
openclaw plugins install -l ~/Documents/Git/openclaw-discord-realtime

# Or install from path
openclaw plugins install ~/Documents/Git/openclaw-discord-realtime
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
          followUserIds: ["YOUR_DISCORD_USER_ID"],
          voice: "coral",
          model: "gpt-4o-realtime-preview",
          systemPrompt: "You are a drone commander. Execute commands immediately. Be concise.",
          turnDetection: "semantic_vad"
        }
      }
    }
  }
}
```

Set `OPENAI_API_KEY` in your environment.

## How it works

1. Plugin registers a **service** (`api.registerService()`) — OpenClaw manages its lifecycle
2. Service listens for `VOICE_STATE_UPDATE` events from Discord gateway
3. When a followed user joins a voice channel, the bridge activates:
   - Joins the voice channel via `@discordjs/voice`
   - Opens WebSocket to OpenAI Realtime API
   - Wires Discord audio ↔ Realtime API audio
4. Tool calls from the Realtime API route through `api.runtime.invokeTool()` — any tool registered in OpenClaw is callable by voice
5. When the followed user leaves, bridge tears down cleanly

## Registering tools for voice

The Realtime API can call any tool registered in OpenClaw. To add drone tools (or any tools), create a separate plugin or register them in your existing setup:

```js
api.registerTool({
  name: 'drone_takeoff',
  description: 'Take off a drone to specified altitude',
  parameters: Type.Object({
    drone_id: Type.String(),
    altitude: Type.Number(),
  }),
  async execute(_id, params) {
    const res = await fetch(`http://localhost:8000/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `takeoff ${params.drone_id} ${params.altitude}` }),
    });
    return { content: [{ type: 'text', text: await res.text() }] };
  },
});
```

## Files

```
src/
  index.js              — Plugin entry: service registration, auto-join, command
  voice-bridge.js       — Discord voice ↔ Realtime API lifecycle manager
  realtime-connection.js — OpenAI Realtime WebSocket client
  audio-pipeline.js     — Opus decode/encode, PCM resample (48kHz↔24kHz)
```

## Status

Check bridge status:
```
/rtstatus
```

## Requirements

- Node >= 22
- OpenClaw with Discord channel configured
- `OPENAI_API_KEY` environment variable
- `@discordjs/opus` native bindings (installed via dependencies)
