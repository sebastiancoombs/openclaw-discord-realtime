/**
 * Provider: openai-realtime
 *
 * Speech-to-speech via OpenAI Realtime API WebSocket.
 * Single round-trip: PCM in → STT + reasoning + function calling + TTS → PCM out.
 * Target latency: ~300–500ms.
 *
 * Config fields (in config.json):
 *   provider:      "openai-realtime"
 *   systemPrompt:  System instructions for the assistant
 *   openai:
 *     model:         Realtime model ID (default: "gpt-realtime")
 *     voice:         TTS voice (default: "coral")
 *     turnDetection: VAD mode (default: "semantic_vad")
 *
 * Backward-compatible top-level fields also accepted:
 *   model, voice, turnDetection (legacy flat config)
 *
 * Emits: audio, audio_done, speech_started, speech_stopped,
 *        user_transcript, assistant_transcript, response_done, error, disconnected, ready
 */

import WebSocket from 'ws';
import { BaseVoiceProvider } from './base-provider.js';

export class OpenAIRealtimeProvider extends BaseVoiceProvider {
  /**
   * @param {object}   config      - Full config object from config.json
   * @param {Array}    tools       - OpenAI Realtime tool definitions
   * @param {Function} executeTool - Tool executor fn(name, args) → Promise<string>
   */
  constructor(config, tools, executeTool) {
    super(config, tools, executeTool);

    // Support nested config.openai or flat legacy config
    const openaiCfg = config.openai || {};
    this.apiKey        = process.env.OPENAI_API_KEY;
    this.model         = openaiCfg.model         || config.model         || 'gpt-realtime';
    this.voice         = openaiCfg.voice         || config.voice         || 'coral';
    this.systemPrompt  = config.systemPrompt      || 'You are a voice assistant. Be concise.';
    this.turnDetection = openaiCfg.turnDetection  || config.turnDetection || 'semantic_vad';

    this.ws = null;
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (!this.apiKey) {
      this.emit('error', new Error('OPENAI_API_KEY not set'));
      return;
    }

    const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;
    console.log(`[openai-realtime] Connecting to ${url}`);

    this.ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      console.log('[openai-realtime] WebSocket connected');
      this._connected = true;
      this._configureSession();
    });

    this.ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      this._handleEvent(event);
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[openai-realtime] WebSocket closed: ${code} ${reason}`);
      this._connected = false;
      this.emit('disconnected');
    });

    this.ws.on('error', (err) => {
      console.error('[openai-realtime] WebSocket error:', err.message);
      this.emit('error', err);
    });
  }

  _configureSession() {
    this._send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.systemPrompt,
        voice: this.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: this.turnDetection },
        tools: this.tools,
        tool_choice: this.tools.length > 0 ? 'auto' : 'none',
      },
    });

    console.log(`[openai-realtime] Session configured: voice=${this.voice}, ${this.tools.length} tools`);
    this.emit('ready');
  }

  /** Send PCM 16-bit mono 24kHz audio to the API. */
  sendAudio(pcmData) {
    if (!this._connected) return;
    this._send({
      type: 'input_audio_buffer.append',
      audio: pcmData.toString('base64'),
    });
  }

  /** Send a text message (for testing without voice). */
  sendText(text) {
    if (!this._connected) return;
    this._send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this._send({ type: 'response.create' });
  }

  _send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  async _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
        console.log('[openai-realtime] Session created:', event.session?.id);
        break;

      case 'session.updated':
        console.log('[openai-realtime] Session updated');
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[openai-realtime] Speech detected');
        this.emit('speech_started');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[openai-realtime] Speech ended');
        this.emit('speech_stopped');
        break;

      case 'response.audio.delta': {
        const audioBuffer = Buffer.from(event.delta, 'base64');
        this.emit('audio', audioBuffer);
        break;
      }

      case 'response.audio.done':
        this.emit('audio_done');
        break;

      case 'response.output_item.done':
        if (event.item?.type === 'function_call') {
          const { name, call_id, arguments: argsStr } = event.item;
          console.log(`[openai-realtime] Function call: ${name}(${argsStr})`);

          if (!this.executeTool) {
            console.warn(`[openai-realtime] No executeTool set — skipping: ${name}`);
            break;
          }

          try {
            const args = JSON.parse(argsStr);
            const result = await this.executeTool(name, args);
            if (this.history) this.history.addToolResult(name, args, result);
            this._send({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id, output: result },
            });
            this._send({ type: 'response.create' });
          } catch (err) {
            console.error('[openai-realtime] Function call error:', err);
            this._send({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id,
                output: JSON.stringify({ error: err.message }),
              },
            });
            this._send({ type: 'response.create' });
          }
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        console.log(`[openai-realtime] User said: "${event.transcript}"`);
        if (this.history) this.history.addUserTurn(event.transcript);
        this.emit('user_transcript', event.transcript);
        break;

      case 'response.output_audio_transcript.delta':
        break;

      case 'response.output_audio_transcript.done':
        console.log(`[openai-realtime] Assistant said: "${event.transcript}"`);
        if (this.history) this.history.addAssistantTurn(event.transcript);
        this.emit('assistant_transcript', event.transcript);
        break;

      case 'response.done':
        this.emit('response_done', event.response);
        break;

      case 'error':
        console.error('[openai-realtime] API Error:', event.error);
        this.emit('error', new Error(event.error?.message || 'Unknown error'));
        break;

      case 'rate_limits.updated':
        break;

      default:
        // console.log(`[openai-realtime] ${event.type}`);
        break;
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }
}
