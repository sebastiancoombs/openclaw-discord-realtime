import { BaseVoiceProvider } from './base-provider.js';

export class LocalProvider extends BaseVoiceProvider {
  connect() {
    console.log('[LOCAL] Local provider not yet implemented. Coming in v2.');
    console.log('[LOCAL] Will support: Whisper.cpp STT → Ollama LLM → Kokoro TTS');
    throw new Error('Local provider coming in v2. Use "openai-realtime" or "elevenlabs" for now.');
  }
}
