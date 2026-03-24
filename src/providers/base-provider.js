/**
 * BaseVoiceProvider — abstract base class for all voice providers.
 *
 * All providers extend this class and emit the same set of events so that
 * src/index.js can work with any provider without knowing its internals.
 *
 * Events emitted by every provider:
 *   'ready'                          — provider connected and configured
 *   'audio'         (Buffer)         — PCM audio chunk to play in Discord
 *   'audio_done'                     — finished speaking
 *   'speech_started'                 — user started speaking (barge-in signal)
 *   'speech_stopped'                 — user stopped speaking
 *   'user_transcript'   (string)     — what the user said
 *   'assistant_transcript' (string)  — what the assistant said
 *   'error'         (Error)          — provider error
 *   'disconnected'                   — provider disconnected
 */

import { EventEmitter } from 'events';

export class BaseVoiceProvider extends EventEmitter {
  /**
   * @param {object}   config      - Full config object from config.json
   * @param {Array}    tools       - OpenAI-format tool definitions
   * @param {Function} executeTool - Tool executor fn(name, args) → Promise<string>
   */
  constructor(config, tools, executeTool) {
    super();
    this.config      = config      || {};
    this.tools       = tools       || [];
    this.executeTool = executeTool || null;
    this.history     = null;
  }

  /** Set the shared ConversationHistory instance. */
  setHistory(historyInstance) {
    this.history = historyInstance;
  }

  /** Connect to the provider and emit 'ready' when ready. */
  connect() {
    throw new Error(`${this.constructor.name}.connect() not implemented`);
  }

  /**
   * Send PCM audio to the provider.
   * @param {Buffer} pcmBuffer - PCM 16-bit mono 24kHz audio
   */
  sendAudio(pcmBuffer) {
    throw new Error(`${this.constructor.name}.sendAudio() not implemented`);
  }

  /**
   * Send a text message (bypasses STT, useful for testing).
   * @param {string} text
   */
  sendText(text) {
    throw new Error(`${this.constructor.name}.sendText() not implemented`);
  }

  /** Disconnect from the provider. */
  disconnect() {
    throw new Error(`${this.constructor.name}.disconnect() not implemented`);
  }

  /** Whether the provider is currently connected. */
  get connected() {
    return false;
  }
}
