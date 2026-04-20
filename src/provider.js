import { OpenAIRealtimeProvider } from './providers/openai-realtime.js';
import { ElevenLabsProvider } from './providers/elevenlabs-provider.js';
import { LocalProvider } from './providers/local-provider.js';

export function createProvider(config, tools, executeTool) {
  switch (config.provider || 'openai-realtime') {
    case 'openai-realtime':
      return new OpenAIRealtimeProvider(config, tools, executeTool);
    case 'elevenlabs':
      return new ElevenLabsProvider(config, tools, executeTool);
    case 'local':
      return new LocalProvider(config, tools, executeTool);
    default:
      throw new Error(`Unknown provider: ${config.provider}. Use: openai-realtime, elevenlabs, local`);
  }
}
