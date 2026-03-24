/**
 * Provider: local  (v2 placeholder)
 *
 * Fully local, offline pipeline. No cloud APIs required.
 * Target: run on-device using Whisper.cpp (STT) + Ollama (LLM) + Piper/Kokoro (TTS).
 *
 * Status: NOT YET IMPLEMENTED — stub only.
 *
 * Planned pipeline:
 *   PCM audio in
 *     → silence detection
 *     → Whisper.cpp STT  (via child_process or HTTP to whisper-server)
 *     → Ollama LLM with tool definitions
 *     → execute tool calls
 *     → Piper or Kokoro TTS  (via child_process or HTTP)
 *     → PCM audio out
 *
 * Planned config fields:
 *   provider:      "local"
 *   whisperModel:  path to Whisper.cpp model file (e.g. "models/ggml-base.en.bin")
 *   ollamaModel:   Ollama model name (e.g. "llama3.2", "mistral")
 *   ollamaUrl:     Ollama base URL (default: "http://localhost:11434")
 *   piperVoice:    path to Piper voice model (e.g. "voices/en_US-hfc_female-medium.onnx")
 *
 * Emits: audio, audio_done, speech_started, speech_stopped,
 *        user_transcript, assistant_transcript, response_done, error, ready
 */

import { BaseVoiceProvider } from './base-provider.js';

export class LocalProvider extends BaseVoiceProvider {
  constructor(config, tools, executeTool) {
    super(config, tools, executeTool);
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }

  connect() {
    console.log('[LOCAL] Local provider not yet implemented. Coming in v2.');
    console.log('[LOCAL] Will support: Whisper.cpp STT → Ollama LLM → Kokoro TTS');
    const err = new Error('Local provider coming in v2. Use "openai-realtime" or "elevenlabs" for now.');
    this.emit('error', err);
  }

  sendAudio(_pcmData) {
    // no-op until implemented
  }

  sendText(_text) {
    // no-op until implemented
  }

  disconnect() {
    this._connected = false;
  }
}
