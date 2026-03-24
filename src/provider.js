/**
 * Provider factory — creates the appropriate voice provider based on config.provider.
 *
 * Supported providers:
 *   "openai-realtime" — OpenAI Realtime API (speech-to-speech, ~300–500ms latency)
 *   "elevenlabs"      — ElevenLabs STT + configurable LLM + ElevenLabs TTS (~1–2s latency)
 *   "local"           — Fully local pipeline (v2, not yet implemented)
 *
 * @param {object}   config      - Full config object from config.json
 * @param {Array}    tools       - OpenAI-format tool definitions
 * @param {Function} executeTool - Tool executor fn(name, args) → Promise<string>
 * @returns {BaseVoiceProvider}
 */

import { OpenAIRealtimeProvider } from './providers/openai-realtime.js';
import { ElevenLabsProvider }     from './providers/elevenlabs-provider.js';
import { LocalProvider }          from './providers/local-provider.js';
import { CascadeProvider }        from './providers/cascade-provider.js';

export function createProvider(config, tools, executeTool) {
  // Default to openai-realtime for backward compatibility
  const provider = config.provider || 'openai-realtime';

  switch (provider) {
    case 'openai-realtime':
      return new OpenAIRealtimeProvider(config, tools, executeTool);

    case 'elevenlabs':
      return new ElevenLabsProvider(config, tools, executeTool);

    case 'local':
      return new LocalProvider(config, tools, executeTool);

    case 'cascade':
      return new CascadeProvider(config, tools, executeTool);

    default:
      throw new Error(
        `Unknown provider: "${provider}". Supported: openai-realtime, elevenlabs, local, cascade`
      );
  }
}
