/**
 * Provider: cascade
 *
 * Generic cascaded pipeline: any STT → any LLM → any TTS.
 * Mix-and-match providers independently for the best latency/quality/cost trade-off.
 *
 * Pipeline:
 *   PCM audio in
 *     → STT (deepgram streaming | elevenlabs scribe | whisper)
 *     → LLM with tool calling (anthropic | openai | groq)
 *     → execute any tool calls
 *     → TTS (elevenlabs | openai)
 *     → PCM audio out
 *
 * Config shape:
 * {
 *   "provider": "cascade",
 *   "systemPrompt": "...",
 *   "stt": {
 *     "provider": "deepgram",       // "deepgram" | "elevenlabs" | "whisper"
 *     "model": "nova-2",
 *     "apiKey": "env:DEEPGRAM_API_KEY",
 *     "language": "en"
 *   },
 *   "llm": {
 *     "provider": "groq",           // "groq" | "openai" | "anthropic"
 *     "model": "llama-3.3-70b-versatile",
 *     "apiKey": "env:GROQ_API_KEY"
 *   },
 *   "tts": {
 *     "provider": "elevenlabs",     // "elevenlabs" | "openai"
 *     "voiceId": "pNInz6obpgDQGcFmaJgB",
 *     "modelId": "eleven_flash_v2_5",
 *     "apiKey": "env:ELEVENLABS_API_KEY"
 *   },
 *   "silenceMs": 1500,              // ms of silence before batch STT triggers (default: 1500)
 *   "silenceThreshold": 200         // RMS below which audio is silence (default: 200)
 * }
 *
 * Emits: audio, audio_done, speech_started, speech_stopped,
 *        user_transcript, assistant_transcript, response_done, error, ready, disconnected
 */

import { BaseVoiceProvider }    from './base-provider.js';
import { ConversationHistory } from '../conversation-history.js';
import WebSocket               from 'ws';

// ── API endpoints ─────────────────────────────────────────────────────────────
const DEEPGRAM_WS_URL   = 'wss://api.deepgram.com/v1/listen';
const ELEVENLABS_BASE   = 'https://api.elevenlabs.io';
const WHISPER_URL       = 'https://api.openai.com/v1/audio/transcriptions';
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const OPENAI_CHAT_URL   = 'https://api.openai.com/v1/chat/completions';
const GROQ_CHAT_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_TTS_URL    = 'https://api.openai.com/v1/audio/speech';
const ANTHROPIC_VERSION = '2023-06-01';

// Minimum audio bytes before processing (~100ms at 24kHz mono 16-bit)
const MIN_AUDIO_BYTES = 4800;

/**
 * Resolve "env:VAR_NAME" references to environment variable values.
 * @param {string|undefined} val
 * @returns {string|undefined}
 */
function resolveValue(val) {
  if (typeof val === 'string' && val.startsWith('env:')) {
    return process.env[val.slice(4)];
  }
  return val;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class CascadeProvider extends BaseVoiceProvider {
  /**
   * @param {object}   config      - Full config object from config.json
   * @param {Array}    tools       - OpenAI-format tool definitions
   * @param {Function} executeTool - Tool executor fn(name, args) → Promise<string>
   */
  constructor(config, tools, executeTool) {
    super(config, tools, executeTool);

    const sttCfg = config.stt || {};
    const llmCfg = config.llm || {};
    const ttsCfg = config.tts || {};

    // ── STT config ──
    this.sttProvider  = sttCfg.provider  || 'deepgram';
    this.sttApiKey    = resolveValue(sttCfg.apiKey);
    this.sttModel     = sttCfg.model     || (this.sttProvider === 'deepgram' ? 'nova-2' : 'whisper-1');
    this.sttLanguage  = sttCfg.language  || 'en';

    // ── LLM config ──
    this.llmProvider  = llmCfg.provider  || 'openai';
    this.llmModel     = llmCfg.model     || this._defaultLlmModel(this.llmProvider);
    this.llmApiKey    = resolveValue(llmCfg.apiKey);
    this.llmBaseUrl   = this.llmProvider === 'groq' ? GROQ_CHAT_URL : OPENAI_CHAT_URL;

    // ── TTS config ──
    this.ttsProvider  = ttsCfg.provider  || 'elevenlabs';
    this.ttsApiKey    = resolveValue(ttsCfg.apiKey);
    this.ttsVoiceId   = ttsCfg.voiceId   || 'JBFqnCBsd6RMkjVDRZzb';
    this.ttsModelId   = ttsCfg.modelId   || 'eleven_turbo_v2_5';
    this.ttsVoice     = ttsCfg.voice     || 'alloy'; // for openai tts

    // ── General config ──
    this.systemPrompt     = config.systemPrompt     || 'You are a voice assistant. Be concise.';
    this.silenceMs        = config.silenceMs        ?? 1500;
    this.silenceThreshold = config.silenceThreshold ?? 200;

    // ── Internal state ──
    this._audioChunks         = [];
    this._totalBytes          = 0;
    this._speaking            = false;
    this._silenceTimer        = null;
    this._isConnected         = false;
    this._processing          = false;

    // ── Deepgram WebSocket state ──
    this._dgWs               = null;
    this._dgTranscriptBuffer = '';
    this._dgConnected        = false;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  _defaultLlmModel(provider) {
    switch (provider) {
      case 'anthropic': return 'claude-sonnet-4-6';
      case 'groq':      return 'llama-3.3-70b-versatile';
      default:          return 'gpt-4o';
    }
  }

  get connected() {
    return this._isConnected;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  connect() {
    // Validate API keys
    if (!this.sttApiKey) {
      const envVars = { deepgram: 'DEEPGRAM_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', whisper: 'OPENAI_API_KEY' };
      this.emit('error', new Error(
        `STT API key not set. Set ${envVars[this.sttProvider] || 'STT_API_KEY'} or config.stt.apiKey`
      ));
      return;
    }
    if (!this.llmApiKey) {
      const envVars = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY' };
      this.emit('error', new Error(
        `LLM API key not set. Set ${envVars[this.llmProvider] || 'LLM_API_KEY'} or config.llm.apiKey`
      ));
      return;
    }
    if (!this.ttsApiKey) {
      const envVars = { elevenlabs: 'ELEVENLABS_API_KEY', openai: 'OPENAI_API_KEY' };
      this.emit('error', new Error(
        `TTS API key not set. Set ${envVars[this.ttsProvider] || 'TTS_API_KEY'} or config.tts.apiKey`
      ));
      return;
    }

    this._isConnected = true;

    if (this.sttProvider === 'deepgram') {
      this._connectDeepgram();
    } else {
      console.log(`[cascade] Ready — STT: ${this.sttProvider}/${this.sttModel}, LLM: ${this.llmProvider}/${this.llmModel}, TTS: ${this.ttsProvider}`);
      this.emit('ready');
    }
  }

  disconnect() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    if (this._dgWs) {
      try { this._dgWs.close(); } catch (_) {}
      this._dgWs = null;
    }
    this._speaking    = false;
    this._audioChunks = [];
    this._totalBytes  = 0;
    this._isConnected = false;
    this._dgConnected = false;
    console.log('[cascade] Disconnected');
    this.emit('disconnected');
  }

  // ── Audio input ──────────────────────────────────────────────────────────────

  /**
   * Receive PCM 16-bit mono 24kHz audio.
   * Routes to Deepgram streaming or local VAD+batch depending on STT provider.
   */
  sendAudio(pcmData) {
    if (this.sttProvider === 'deepgram') {
      this._sendAudioDeepgram(pcmData);
    } else {
      this._sendAudioBatch(pcmData);
    }
  }

  /** Send a text message directly (bypasses STT). */
  sendText(text) {
    console.log(`[cascade] Text input: "${text}"`);
    this.emit('user_transcript', text);
    this._processText(text).catch((err) => {
      console.error('[cascade] sendText error:', err.message);
      this.emit('error', err);
    });
  }

  // ── Deepgram streaming STT ───────────────────────────────────────────────────

  _connectDeepgram() {
    const params = new URLSearchParams({
      model:            this.sttModel,
      language:         this.sttLanguage,
      punctuate:        'true',
      interim_results:  'true',
      endpointing:      '300',
      vad_events:       'true',
      encoding:         'linear16',
      sample_rate:      '24000',
      channels:         '1',
    });

    const url = `${DEEPGRAM_WS_URL}?${params}`;
    console.log(`[cascade] Connecting to Deepgram: ${url}`);

    this._dgWs = new WebSocket(url, {
      headers: { Authorization: `Token ${this.sttApiKey}` },
    });

    this._dgWs.on('open', () => {
      console.log('[cascade] Deepgram WebSocket connected');
      this._dgConnected = true;
      console.log(`[cascade] Ready — STT: deepgram/${this.sttModel}, LLM: ${this.llmProvider}/${this.llmModel}, TTS: ${this.ttsProvider}`);
      this.emit('ready');
    });

    this._dgWs.on('message', (data) => {
      this._handleDeepgramMessage(data);
    });

    this._dgWs.on('error', (err) => {
      console.error('[cascade] Deepgram WS error:', err.message);
      this._dgConnected = false;
      this.emit('error', new Error(`Deepgram WebSocket error: ${err.message}`));
    });

    this._dgWs.on('close', (code, reason) => {
      console.log(`[cascade] Deepgram WS closed: ${code} ${reason}`);
      this._dgConnected = false;
      if (this._isConnected) {
        // Unexpected close — try to reconnect after a delay
        setTimeout(() => {
          if (this._isConnected) {
            console.log('[cascade] Reconnecting to Deepgram...');
            this._connectDeepgram();
          }
        }, 2000);
      }
    });
  }

  _handleDeepgramMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    const type = msg.type;

    // VAD speech events
    if (type === 'SpeechStarted') {
      if (!this._speaking) {
        this._speaking = true;
        console.log('[cascade] Deepgram: speech started');
        this.emit('speech_started');
      }
      return;
    }

    if (type === 'UtteranceEnd') {
      // Deepgram says the utterance is complete
      if (this._speaking) {
        this._speaking = false;
        console.log('[cascade] Deepgram: utterance end');
        this.emit('speech_stopped');
      }
      if (this._dgTranscriptBuffer.trim()) {
        const text = this._dgTranscriptBuffer.trim();
        this._dgTranscriptBuffer = '';
        console.log(`[cascade] Deepgram final transcript: "${text}"`);
        this.emit('user_transcript', text);
        this._processText(text).catch((err) => {
          console.error('[cascade] Pipeline error:', err.message);
          this.emit('error', err);
        });
      }
      return;
    }

    // Transcript results
    if (type === 'Results') {
      const channel    = msg.channel;
      const isFinal    = msg.is_final;
      const speechFinal = msg.speech_final;
      const transcript  = channel?.alternatives?.[0]?.transcript || '';

      if (!transcript) return;

      if (isFinal) {
        this._dgTranscriptBuffer += (this._dgTranscriptBuffer ? ' ' : '') + transcript;
        console.log(`[cascade] Deepgram is_final: "${transcript}"`);
      }

      if (speechFinal && this._dgTranscriptBuffer.trim()) {
        // Speech endpoint detected — trigger LLM immediately
        if (this._speaking) {
          this._speaking = false;
          this.emit('speech_stopped');
        }
        const text = this._dgTranscriptBuffer.trim();
        this._dgTranscriptBuffer = '';
        console.log(`[cascade] Deepgram speech_final: "${text}"`);
        this.emit('user_transcript', text);
        this._processText(text).catch((err) => {
          console.error('[cascade] Pipeline error:', err.message);
          this.emit('error', err);
        });
      }
    }
  }

  _sendAudioDeepgram(pcmData) {
    // Local RMS for speech_started detection (mirrors Deepgram VAD events)
    const rms      = _rms(pcmData);
    const isSpeech = rms > this.silenceThreshold;

    if (isSpeech && !this._speaking) {
      this._speaking = true;
      this.emit('speech_started');
    }

    // Stream to Deepgram
    if (this._dgConnected && this._dgWs?.readyState === WebSocket.OPEN) {
      this._dgWs.send(pcmData);
    }
  }

  // ── Batch STT (ElevenLabs Scribe, Whisper) ───────────────────────────────────

  _sendAudioBatch(pcmData) {
    const rms      = _rms(pcmData);
    const isSpeech = rms > this.silenceThreshold;

    if (isSpeech) {
      if (!this._speaking) {
        this._speaking    = true;
        this._audioChunks = [];
        this._totalBytes  = 0;
        console.log('[cascade] Speech detected');
        this.emit('speech_started');
      }
      if (this._silenceTimer) {
        clearTimeout(this._silenceTimer);
        this._silenceTimer = null;
      }
      this._audioChunks.push(pcmData);
      this._totalBytes += pcmData.length;
    } else if (this._speaking) {
      this._audioChunks.push(pcmData);
      this._totalBytes += pcmData.length;

      if (!this._silenceTimer) {
        this._silenceTimer = setTimeout(() => {
          this._silenceTimer = null;
          this._speaking = false;
          console.log('[cascade] Speech ended');
          this.emit('speech_stopped');
          this._processSpeechBatch();
        }, this.silenceMs);
      }
    }
  }

  async _processSpeechBatch() {
    if (this._totalBytes < MIN_AUDIO_BYTES) {
      console.log('[cascade] Audio too short, discarding');
      this._audioChunks = [];
      this._totalBytes  = 0;
      return;
    }

    if (this._processing) {
      console.log('[cascade] Already processing, discarding overlapping speech');
      this._audioChunks = [];
      this._totalBytes  = 0;
      return;
    }

    const pcmBuffer = Buffer.concat(this._audioChunks);
    this._audioChunks = [];
    this._totalBytes  = 0;
    this._processing  = true;

    try {
      const transcript = await this._transcribeBatch(pcmBuffer);
      if (!transcript || !transcript.trim()) {
        console.log('[cascade] Empty transcript, skipping');
        return;
      }
      console.log(`[cascade] User said: "${transcript}"`);
      this.emit('user_transcript', transcript);
      await this._processText(transcript);
    } catch (err) {
      console.error('[cascade] Batch STT pipeline error:', err.message);
      this.emit('error', err);
    } finally {
      this._processing = false;
    }
  }

  // ── STT implementations ──────────────────────────────────────────────────────

  async _transcribeBatch(pcmBuffer) {
    switch (this.sttProvider) {
      case 'elevenlabs': return this._transcribeElevenLabs(pcmBuffer);
      case 'whisper':    return this._transcribeWhisper(pcmBuffer);
      default:
        throw new Error(`Unknown batch STT provider: "${this.sttProvider}"`);
    }
  }

  async _transcribeElevenLabs(pcmBuffer) {
    const wav      = _pcmToWav(pcmBuffer, 24000, 1, 16);
    const formData = new FormData();
    formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model_id', 'scribe_v1');

    const res = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.sttApiKey },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElevenLabs STT ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.text || '';
  }

  async _transcribeWhisper(pcmBuffer) {
    const wav      = _pcmToWav(pcmBuffer, 24000, 1, 16);
    const formData = new FormData();
    formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', this.sttModel || 'whisper-1');
    if (this.sttLanguage) formData.append('language', this.sttLanguage);

    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.sttApiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Whisper STT ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.text || '';
  }

  // ── LLM call ─────────────────────────────────────────────────────────────────

  async _processText(text) {
    if (this._processing && this.sttProvider !== 'deepgram') return;

    // Ensure we have a history instance (shared from index.js or created locally)
    if (!this.history) this.history = new ConversationHistory();

    try {
      this.history.addUserTurn(text);

      // Build messages from shared history
      const baseMessages = this.llmProvider === 'anthropic'
        ? this.history.toAnthropicMessages()
        : this.history.toOpenAIMessages();

      const { reply, toolCalls } = await this._callLLM(baseMessages);

      let finalReply = reply;

      if (toolCalls?.length > 0 && this.executeTool) {
        const toolResults = [];

        for (const call of toolCalls) {
          console.log(`[cascade] Tool call: ${call.name}(${JSON.stringify(call.args)})`);
          try {
            const result = await this.executeTool(call.name, call.args);
            toolResults.push({ call, result });
            this.history.addToolResult(call.name, call.args, result);
          } catch (err) {
            console.error(`[cascade] Tool ${call.name} failed:`, err.message);
            const errResult = JSON.stringify({ error: err.message });
            toolResults.push({ call, result: errResult });
            this.history.addToolResult(call.name, call.args, errResult);
          }
        }

        // Build extended messages with tool calls/results for LLM follow-up
        let followUpMessages;
        if (this.llmProvider === 'anthropic') {
          followUpMessages = [
            ...baseMessages,
            {
              role: 'assistant',
              content: toolCalls.map((c) => ({
                type: 'tool_use', id: c.id, name: c.name, input: c.args,
              })),
            },
            {
              role: 'user',
              content: toolResults.map(({ call, result }) => ({
                type: 'tool_result', tool_use_id: call.id, content: result,
              })),
            },
          ];
        } else {
          followUpMessages = [
            ...baseMessages,
            {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls.map((c) => ({
                id: c.id, type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
            ...toolResults.map(({ call, result }) => ({
              role: 'tool', tool_call_id: call.id, content: result,
            })),
          ];
        }

        // Re-call LLM with tool results for spoken reply
        const { reply: followUp } = await this._callLLM(followUpMessages);
        finalReply = followUp;
      }

      if (!finalReply) {
        console.warn('[cascade] LLM returned empty reply');
        return;
      }

      console.log(`[cascade] Assistant reply: "${finalReply}"`);
      this.history.addAssistantTurn(finalReply);
      this.emit('assistant_transcript', finalReply);

      await this._speak(finalReply);
      this.emit('response_done');
    } catch (err) {
      console.error('[cascade] _processText error:', err.message);
      this.emit('error', err);
    }
  }

  async _callLLM(messages) {
    if (this.llmProvider === 'anthropic') {
      return this._callAnthropic(messages);
    }
    // openai and groq use the same format (groq just has a different base URL)
    return this._callOpenAICompat(messages);
  }

  async _callOpenAICompat(messages) {
    const url = this.llmProvider === 'groq' ? GROQ_CHAT_URL : OPENAI_CHAT_URL;

    const body = {
      model:    this.llmModel,
      messages: [
        { role: 'system', content: this.systemPrompt },
        ...messages,
      ],
    };

    if (this.tools.length > 0) {
      body.tools = this.tools.map((t) => ({
        type:     'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${this.llmApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.llmProvider} LLM ${res.status}: ${err}`);
    }

    const data    = await res.json();
    const choice  = data.choices?.[0];
    const message = choice?.message;

    const toolCalls = message?.tool_calls?.map((tc) => ({
      id:   tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}'),
    })) || [];

    return { reply: message?.content || null, toolCalls };
  }

  async _callAnthropic(messages) {
    // Convert message history to Anthropic format
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        // Already in Anthropic format (tool_use content array from our history)
        if (Array.isArray(m.content)) {
          return { role: m.role, content: m.content };
        }
        // OpenAI-style tool_calls message
        if (m.tool_calls) {
          return {
            role: 'assistant',
            content: m.tool_calls.map((tc) => ({
              type:  'tool_use',
              id:    tc.id,
              name:  tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}'),
            })),
          };
        }
        // OpenAI-style tool result message
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
          };
        }
        return { role: m.role, content: m.content };
      });

    const body = {
      model:      this.llmModel,
      max_tokens: 1024,
      system:     this.systemPrompt,
      messages:   anthropicMessages,
    };

    if (this.tools.length > 0) {
      body.tools = this.tools.map((t) => ({
        name:         t.name,
        description:  t.description,
        input_schema: t.parameters,
      }));
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key':         this.llmApiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type':      'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Anthropic LLM ${res.status}: ${err}`);
    }

    const data    = await res.json();
    const content = data.content || [];

    const textBlock  = content.find((b) => b.type === 'text');
    const toolBlocks = content.filter((b) => b.type === 'tool_use');

    const toolCalls = toolBlocks.map((b) => ({
      id:   b.id,
      name: b.name,
      args: b.input || {},
    }));

    return { reply: textBlock?.text || null, toolCalls };
  }

  // ── TTS implementations ──────────────────────────────────────────────────────

  async _speak(text) {
    switch (this.ttsProvider) {
      case 'elevenlabs': return this._speakElevenLabs(text);
      case 'openai':     return this._speakOpenAI(text);
      default:
        throw new Error(`Unknown TTS provider: "${this.ttsProvider}"`);
    }
  }

  async _speakElevenLabs(text) {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/text-to-speech/${this.ttsVoiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key':   this.ttsApiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/pcm;rate=24000',
      },
      body: JSON.stringify({
        text,
        model_id:       this.ttsModelId,
        output_format:  'pcm_24000',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElevenLabs TTS ${res.status}: ${err}`);
    }

    // Stream PCM chunks as 'audio' events
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) this.emit('audio', Buffer.from(value));
    }

    this.emit('audio_done');
  }

  async _speakOpenAI(text) {
    const res = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${this.ttsApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:           'tts-1',
        input:           text,
        voice:           this.ttsVoice,
        response_format: 'pcm', // raw 24kHz 16-bit mono PCM
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI TTS ${res.status}: ${err}`);
    }

    // Stream PCM chunks as 'audio' events
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) this.emit('audio', Buffer.from(value));
    }

    this.emit('audio_done');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute RMS amplitude of a PCM s16le buffer.
 * Used for silence/speech detection (VAD).
 */
function _rms(buffer) {
  if (buffer.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (buffer.length / 2));
}

/**
 * Wrap raw PCM s16le data in a minimal WAV container header.
 * Required for batch STT APIs that need a proper audio file format.
 */
function _pcmToWav(pcmBuffer, sampleRate, channels, bitDepth) {
  const byteRate   = (sampleRate * channels * bitDepth) / 8;
  const blockAlign = (channels * bitDepth) / 8;
  const header     = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);          // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}
