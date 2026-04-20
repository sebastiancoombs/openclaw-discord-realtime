import WebSocket from 'ws';
import { BaseVoiceProvider } from './base-provider.js';

export class OpenAIRealtimeProvider extends BaseVoiceProvider {
  constructor(config = {}, tools = [], executeTool = null) {
    super(config, tools, executeTool);
    const openai = config.openai || {};
    this.apiKey = process.env.OPENAI_API_KEY;
    this.model = openai.model || config.model || 'gpt-4o-realtime-preview';
    this.voice = openai.voice || config.voice || 'coral';
    this.systemPrompt = config.systemPrompt || 'You are a voice assistant. Be concise.';
    this.turnDetection = openai.turnDetection || config.turnDetection || 'semantic_vad';
    this.log = config.log || console;
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
    this.log.info(`Connecting to OpenAI Realtime: ${this.model}`);

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      this._connected = true;
      this._configureSession();
    });

    this.ws.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        this._handleEvent(event);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
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

    this.log.info(`Session configured: voice=${this.voice}, tools=${this.tools.length}`);
    this.emit('ready');
  }

  sendAudio(pcmData) {
    if (!this._connected) return;
    this._send({ type: 'input_audio_buffer.append', audio: pcmData.toString('base64') });
  }

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

  async _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
      case 'response.audio_transcript.delta':
      case 'response.done':
      case 'rate_limits.updated':
      case 'response.created':
      case 'response.output_item.added':
      case 'conversation.item.created':
        break;
      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;
      case 'response.audio.delta':
        this.emit('audio', Buffer.from(event.delta, 'base64'));
        break;
      case 'response.audio.done':
        this.emit('audio_done');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) this.emit('user_transcript', event.transcript);
        break;
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (event.transcript) this.emit('assistant_transcript', event.transcript);
        break;
      case 'response.output_item.done':
        if (event.item?.type === 'function_call') await this._handleToolCall(event.item);
        break;
      case 'error':
        this.emit('error', new Error(event.error?.message || 'Unknown Realtime API error'));
        break;
      default:
        break;
    }
  }

  async _handleToolCall(item) {
    const { name, call_id, arguments: argsStr } = item;
    let output;
    try {
      if (!this.executeTool) throw new Error('No tool executor configured');
      const args = JSON.parse(argsStr || '{}');
      output = await this.executeTool(name, args);
    } catch (err) {
      output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }

    this._send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id, output },
    });
    this._send({ type: 'response.create' });
  }

  _send(event) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
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
