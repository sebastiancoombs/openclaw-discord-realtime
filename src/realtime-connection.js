/**
 * RealtimeConnection — manages the WebSocket to OpenAI Realtime API.
 *
 * Responsibilities:
 *   - Connect/disconnect/reconnect
 *   - Session configuration (voice, model, tools, VAD)
 *   - Send audio to API
 *   - Handle events: audio output, transcripts, tool calls
 *   - Execute tool calls and return results
 *
 * Emits:
 *   'ready'                — session configured and ready
 *   'audio'    (Buffer)    — PCM 16-bit mono 24kHz chunk to play
 *   'audio_done'           — finished speaking
 *   'speech_started'       — user speech detected (barge-in signal)
 *   'speech_stopped'       — user speech ended
 *   'user_transcript'   (string)  — what the user said
 *   'assistant_transcript' (string) — what the assistant said
 *   'error'    (Error)     — API or connection error
 *   'disconnected'         — WebSocket closed
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class RealtimeConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {string} opts.voice
   * @param {string} opts.systemPrompt
   * @param {string} opts.turnDetection
   * @param {Function} opts.executeTool  — async (name, args) => string
   * @param {object} opts.log
   */
  constructor(opts) {
    super();
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.voice = opts.voice;
    this.systemPrompt = opts.systemPrompt;
    this.turnDetection = opts.turnDetection;
    this.executeTool = opts.executeTool;
    this.log = opts.log;

    this.ws = null;
    this._connected = false;
    this._tools = []; // Populated dynamically from OpenClaw's tool registry
  }

  get connected() {
    return this._connected;
  }

  /**
   * Set the tools the Realtime API can call.
   * Called before connect() or dynamically via session.update.
   * @param {Array} tools — OpenAI function-calling tool definitions
   */
  setTools(tools) {
    this._tools = tools;
  }

  /**
   * Open WebSocket to OpenAI Realtime API.
   */
  connect() {
    const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;
    this.log.info(`Connecting to OpenAI Realtime: ${this.model}`);

    this.ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      this._connected = true;
      this._configureSession();
    });

    this.ws.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        this._handleEvent(event);
      } catch (e) {
        this.log.error(`Failed to parse Realtime event: ${e.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      this.log.info(`Realtime WebSocket closed: ${code} ${reason}`);
      this._connected = false;
      this.emit('disconnected');
    });

    this.ws.on('error', (err) => {
      this.log.error(`Realtime WebSocket error: ${err.message}`);
      this.emit('error', err);
    });
  }

  /**
   * Configure the Realtime session after connection opens.
   */
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
        tools: this._tools,
        tool_choice: this._tools.length > 0 ? 'auto' : 'none',
      },
    });

    this.log.info(`Session configured: voice=${this.voice}, tools=${this._tools.length}`);
    this.emit('ready');
  }

  /**
   * Send PCM 16-bit mono 24kHz audio to the API.
   * @param {Buffer} pcmData
   */
  sendAudio(pcmData) {
    if (!this._connected) return;
    this._send({
      type: 'input_audio_buffer.append',
      audio: pcmData.toString('base64'),
    });
  }

  /**
   * Handle an event from the Realtime API.
   */
  async _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;

      case 'response.audio.delta': {
        const buf = Buffer.from(event.delta, 'base64');
        this.emit('audio', buf);
        break;
      }

      case 'response.audio.done':
        this.emit('audio_done');
        break;

      case 'response.output_item.done':
        if (event.item?.type === 'function_call') {
          await this._handleToolCall(event.item);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          this.emit('user_transcript', event.transcript);
        }
        break;

      case 'response.audio_transcript.done':
        if (event.transcript) {
          this.emit('assistant_transcript', event.transcript);
        }
        break;

      case 'error':
        this.emit('error', new Error(event.error?.message || 'Unknown Realtime API error'));
        break;

      // Ignored events
      case 'response.audio_transcript.delta':
      case 'response.done':
      case 'rate_limits.updated':
      case 'response.created':
      case 'response.output_item.added':
      case 'conversation.item.created':
        break;

      default:
        // Uncomment to debug unknown events:
        // this.log.info(`Realtime event: ${event.type}`);
        break;
    }
  }

  /**
   * Execute a tool call from the Realtime API and return the result.
   */
  async _handleToolCall(item) {
    const { name, call_id, arguments: argsStr } = item;
    this.log.info(`Tool call: ${name}(${argsStr})`);

    let output;
    try {
      const args = JSON.parse(argsStr);
      output = await this.executeTool(name, args);
    } catch (err) {
      this.log.error(`Tool call failed: ${err.message}`);
      output = JSON.stringify({ error: err.message });
    }

    // Return result to the API
    this._send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id, output },
    });

    // Trigger a new response after tool result
    this._send({ type: 'response.create' });
  }

  /**
   * Send a JSON event to the WebSocket.
   */
  _send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  /**
   * Close the WebSocket connection.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }
}
