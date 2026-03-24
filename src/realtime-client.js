/**
 * @deprecated Use src/providers/openai-realtime.js directly, or src/provider.js factory.
 *
 * Backwards-compatibility re-export.
 * Existing code that imports RealtimeClient from './realtime-client.js' continues to work.
 */
export { OpenAIRealtimeProvider as RealtimeClient } from './providers/openai-realtime.js';
