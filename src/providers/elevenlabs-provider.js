import { BaseVoiceProvider } from './base-provider.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function resolveValue(val) {
  if (typeof val === 'string' && val.startsWith('env:')) {
    return process.env[val.slice(4)];
  }
  return val;
}

function rms(buffer) {
  if (buffer.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (buffer.length / 2));
}

function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export class ElevenLabsProvider extends BaseVoiceProvider {
  constructor(config = {}, tools = [], executeTool = null) {
    super(config, tools, executeTool);
    const elevenlabs = config.elevenlabs || {};
    const llm = config.llm || {};
    this.log = config.log || console;
    this.systemPrompt = config.systemPrompt || 'You are a voice assistant. Be concise.';
    this.elevenlabsApiKey = resolveValue(elevenlabs.apiKey) || process.env.ELEVENLABS_API_KEY;
    this.voiceId = elevenlabs.voiceId || 'pNInz6obpgDQGcFmaJgB';
    this.modelId = elevenlabs.modelId || 'eleven_flash_v2_5';
    this.llmProvider = llm.provider || 'anthropic';
    this.llmModel = llm.model || (this.llmProvider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o');
    this.llmApiKey = resolveValue(llm.apiKey) || (this.llmProvider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);
    this.silenceThreshold = config.silenceThreshold ?? 200;
    this.silenceMs = config.silenceMs ?? 1500;
    this._audioChunks = [];
    this._totalBytes = 0;
    this._speaking = false;
    this._silenceTimer = null;
    this._connected = false;
    this._history = [];
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (!this.elevenlabsApiKey) {
      this.emit('error', new Error('ELEVENLABS_API_KEY not set'));
      return;
    }
    if (!this.llmApiKey) {
      this.emit('error', new Error(`${this.llmProvider.toUpperCase()} API key not set`));
      return;
    }
    this._connected = true;
    this.emit('ready');
  }

  sendAudio(pcmBuffer) {
    const level = rms(pcmBuffer);
    const isSpeech = level > this.silenceThreshold;
    if (isSpeech) {
      if (!this._speaking) {
        this._speaking = true;
        this._audioChunks = [];
        this._totalBytes = 0;
        this.emit('speech_started');
      }
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
      this._audioChunks.push(pcmBuffer);
      this._totalBytes += pcmBuffer.length;
      return;
    }

    if (this._speaking) {
      this._audioChunks.push(pcmBuffer);
      this._totalBytes += pcmBuffer.length;
      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => {
          this._silenceTimer = null;
          this._speaking = false;
          this.emit('speech_stopped');
          void this._processSpeech();
        }, this.silenceMs);
      }
    }
  }

  sendText(text) {
    this.emit('user_transcript', text);
    void this._processText(text);
  }

  async _processSpeech() {
    if (this._totalBytes < 4800) {
      this._audioChunks = [];
      this._totalBytes = 0;
      return;
    }
    const pcm = Buffer.concat(this._audioChunks);
    this._audioChunks = [];
    this._totalBytes = 0;
    try {
      const transcript = await this._transcribe(pcm);
      if (!transcript) return;
      this.emit('user_transcript', transcript);
      await this._processText(transcript);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async _processText(text) {
    this._history.push({ role: 'user', content: text });
    const initial = await this._callLLM(this._history);
    let finalReply = initial.reply;

    if (initial.toolCalls?.length && this.executeTool) {
      const toolResults = [];
      for (const call of initial.toolCalls) {
        try {
          const result = await this.executeTool(call.name, call.args);
          toolResults.push({ call, result });
        } catch (err) {
          toolResults.push({ call, result: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
        }
      }

      this._history.push({
        role: 'assistant',
        content: null,
        tool_calls: initial.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      });
      this._history.push(...toolResults.map(({ call, result }) => ({ role: 'tool', tool_call_id: call.id, content: result })));
      const followup = await this._callLLM(this._history);
      finalReply = followup.reply;
    }

    if (!finalReply) return;
    this._history.push({ role: 'assistant', content: finalReply });
    this.emit('assistant_transcript', finalReply);
    await this._speak(finalReply);
  }

  async _transcribe(pcmBuffer) {
    const wav = pcmToWav(pcmBuffer);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model_id', 'scribe_v1');
    const res = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.elevenlabsApiKey },
      body: form,
    });
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.text || '';
  }

  async _callLLM(messages) {
    return this.llmProvider === 'anthropic' ? this._callAnthropic(messages) : this._callOpenAI(messages);
  }

  async _callOpenAI(messages) {
    const body = {
      model: this.llmModel,
      messages: [{ role: 'system', content: this.systemPrompt }, ...messages],
      ...(this.tools.length > 0 ? {
        tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: 'auto',
      } : {}),
    };
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.llmApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI LLM ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    return {
      reply: msg?.content || null,
      toolCalls: (msg?.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') })),
    };
  }

  async _callAnthropic(messages) {
    const anthropicMessages = messages.filter((m) => m.role !== 'system').map((m) => {
      if (m.role === 'tool') {
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
      }
      if (m.tool_calls) {
        return { role: 'assistant', content: m.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })) };
      }
      return { role: m.role, content: m.content };
    });
    const body = {
      model: this.llmModel,
      max_tokens: 1024,
      system: this.systemPrompt,
      messages: anthropicMessages,
      ...(this.tools.length > 0 ? { tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    };
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': this.llmApiKey, 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic LLM ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const blocks = data.content || [];
    return {
      reply: blocks.find((b) => b.type === 'text')?.text || null,
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    };
  }

  async _speak(text) {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/text-to-speech/${this.voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.elevenlabsApiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/pcm;rate=24000',
      },
      body: JSON.stringify({ text, model_id: this.modelId, output_format: 'pcm_24000' }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) this.emit('audio', Buffer.from(value));
    }
    this.emit('audio_done');
  }

  disconnect() {
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = null;
    this._connected = false;
    this._speaking = false;
    this._audioChunks = [];
    this._totalBytes = 0;
    this.emit('disconnected');
  }
}
