/**
 * Provider: elevenlabs
 *
 * Cascaded pipeline: ElevenLabs Scribe STT → configurable LLM → ElevenLabs TTS.
 * Higher quality audio; slightly higher latency (~1–2s vs ~500ms for openai-realtime).
 *
 * Pipeline:
 *   PCM audio in
 *     → silence detection (VAD buffer)
 *     → ElevenLabs Scribe STT  (POST /v1/speech-to-text)
 *     → LLM with tool definitions (OpenAI chat completions or Anthropic Messages)
 *     → execute any tool calls
 *     → ElevenLabs TTS  (POST /v1/text-to-speech/:voice_id/stream)
 *     → PCM audio out
 *
 * Config fields (in config.json):
 *   provider:      "elevenlabs"
 *   systemPrompt:  System instructions for the LLM
 *   elevenlabs:
 *     apiKey:      ElevenLabs API key or "env:ELEVENLABS_API_KEY"
 *     voiceId:     ElevenLabs voice ID (default: "JBFqnCBsd6RMkjVDRZzb")
 *     modelId:     ElevenLabs TTS model (default: "eleven_turbo_v2_5")
 *   llm:
 *     provider:    "openai" | "anthropic"  (default: "openai")
 *     model:       LLM model name (e.g. "gpt-4o", "claude-sonnet-4-6")
 *     apiKey:      API key or "env:OPENAI_API_KEY" / "env:ANTHROPIC_API_KEY"
 *   silenceMs:     ms of silence before processing speech (default: 800)
 *   silenceThreshold: RMS level below which audio is silence (default: 200)
 *
 * Emits: audio, audio_done, speech_started, speech_stopped,
 *        user_transcript, assistant_transcript, response_done, error, ready
 */

import { BaseVoiceProvider }    from './base-provider.js';
import { ConversationHistory } from '../conversation-history.js';

const ELEVENLABS_BASE   = 'https://api.elevenlabs.io';
const OPENAI_CHAT_URL   = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Default ElevenLabs voice: "Rachel" — calm, clear, English
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';

/**
 * Resolve a value that may be an "env:VARIABLE_NAME" reference.
 * @param {string} val
 * @returns {string|undefined}
 */
function resolveValue(val) {
  if (typeof val === 'string' && val.startsWith('env:')) {
    return process.env[val.slice(4)];
  }
  return val;
}

export class ElevenLabsProvider extends BaseVoiceProvider {
  /**
   * @param {object}   config      - Full config object from config.json
   * @param {Array}    tools       - OpenAI-format tool definitions
   * @param {Function} executeTool - Tool executor fn(name, args) → Promise<string>
   */
  constructor(config, tools, executeTool) {
    super(config, tools, executeTool);

    const elCfg  = config.elevenlabs || {};
    const llmCfg = config.llm        || {};

    // Resolve API keys (support "env:VAR" pattern)
    this.elevenLabsKey = resolveValue(elCfg.apiKey)  || process.env.ELEVENLABS_API_KEY;
    this.llmProvider   = llmCfg.provider || 'openai';
    this.llmModel      = llmCfg.model    || (this.llmProvider === 'anthropic' ? 'claude-opus-4-5' : 'gpt-4o');
    this.llmKey        = resolveValue(llmCfg.apiKey) ||
                         (this.llmProvider === 'anthropic'
                           ? process.env.ANTHROPIC_API_KEY
                           : process.env.OPENAI_API_KEY);

    this.systemPrompt     = config.systemPrompt     || 'You are a voice assistant. Be concise.';
    this.voiceId          = elCfg.voiceId           || DEFAULT_VOICE_ID;
    this.ttsModelId       = elCfg.modelId           || 'eleven_turbo_v2_5';
    this.silenceMs        = config.silenceMs        ?? 800;
    this.silenceThreshold = config.silenceThreshold ?? 200;

    // Internal state
    this._audioChunks    = [];
    this._totalBytes     = 0;
    this._speaking       = false;
    this._silenceTimer   = null;
    this._isConnected    = true; // No persistent WS — always "connected" once ready
  }

  get connected() {
    return this._isConnected;
  }

  /** Called by index.js — no persistent connection needed for cascaded pipeline. */
  connect() {
    if (!this.elevenLabsKey) {
      this.emit('error', new Error('ElevenLabs API key not set. Set ELEVENLABS_API_KEY or config.elevenlabs.apiKey'));
      return;
    }
    if (this.llmProvider === 'openai' && !this.llmKey) {
      this.emit('error', new Error('OpenAI API key not set. Set OPENAI_API_KEY or config.llm.apiKey'));
      return;
    }
    if (this.llmProvider === 'anthropic' && !this.llmKey) {
      this.emit('error', new Error('Anthropic API key not set. Set ANTHROPIC_API_KEY or config.llm.apiKey'));
      return;
    }

    console.log(`[elevenlabs] Ready — LLM: ${this.llmProvider}/${this.llmModel}, voice: ${this.voiceId}`);
    console.log(`[elevenlabs] TTS model: ${this.ttsModelId}, VAD: silence>${this.silenceMs}ms, threshold=${this.silenceThreshold}`);
    this.emit('ready');
  }

  /**
   * Receive PCM 16-bit mono 24kHz audio.
   * Accumulates speech and triggers processing after silence.
   */
  sendAudio(pcmData) {
    const rms      = _rms(pcmData);
    const isSpeech = rms > this.silenceThreshold;

    if (isSpeech) {
      if (!this._speaking) {
        this._speaking = true;
        this._audioChunks = [];
        this._totalBytes  = 0;
        console.log('[elevenlabs] Speech detected');
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
          console.log('[elevenlabs] Speech ended');
          this.emit('speech_stopped');
          this._processSpeech();
        }, this.silenceMs);
      }
    }
  }

  /** Send a text message directly (bypasses STT). */
  sendText(text) {
    console.log(`[elevenlabs] Text input: "${text}"`);
    this.emit('user_transcript', text);
    this._processText(text).catch((err) => {
      console.error('[elevenlabs] sendText error:', err.message);
      this.emit('error', err);
    });
  }

  /** Process accumulated PCM audio through the full pipeline. */
  async _processSpeech() {
    if (this._totalBytes < 4800) {
      // < 100ms of audio at 24kHz mono 16-bit — discard as noise
      console.log('[elevenlabs] Audio too short, discarding');
      this._audioChunks = [];
      this._totalBytes  = 0;
      return;
    }

    const pcmBuffer = Buffer.concat(this._audioChunks);
    this._audioChunks = [];
    this._totalBytes  = 0;

    try {
      // ── Step 1: STT via ElevenLabs Scribe ──
      const transcript = await this._transcribe(pcmBuffer);
      if (!transcript || transcript.trim() === '') {
        console.log('[elevenlabs] Empty transcript, skipping');
        return;
      }

      console.log(`[elevenlabs] User said: "${transcript}"`);
      this.emit('user_transcript', transcript);

      await this._processText(transcript);
    } catch (err) {
      console.error('[elevenlabs] Pipeline error:', err.message);
      this.emit('error', err);
    }
  }

  /** Run the LLM → tool calls → TTS leg of the pipeline. */
  async _processText(text) {
    // Ensure we have a history instance (shared from index.js or created locally)
    if (!this.history) this.history = new ConversationHistory();

    try {
      // ── Step 2: LLM with tool definitions ──
      this.history.addUserTurn(text);

      // Build messages from shared history (elevenlabs uses OpenAI format for LLM)
      const baseMessages = this.llmProvider === 'anthropic'
        ? this.history.toAnthropicMessages()
        : this.history.toOpenAIMessages();

      const { reply, toolCalls } = await this._callLLM(baseMessages);

      // ── Step 3: Execute tool calls ──
      let finalReply = reply;

      if (toolCalls && toolCalls.length > 0 && this.executeTool) {
        const toolResults = [];

        for (const call of toolCalls) {
          console.log(`[elevenlabs] Tool call: ${call.name}(${JSON.stringify(call.args)})`);
          try {
            const result = await this.executeTool(call.name, call.args);
            toolResults.push({ call, result });
            this.history.addToolResult(call.name, call.args, result);
          } catch (err) {
            console.error(`[elevenlabs] Tool ${call.name} failed:`, err.message);
            const errResult = JSON.stringify({ error: err.message });
            toolResults.push({ call, result: errResult });
            this.history.addToolResult(call.name, call.args, errResult);
          }
        }

        // Build extended messages with tool calls/results for LLM follow-up
        const followUpMessages = [
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

        // Re-call LLM with tool results for spoken reply
        const { reply: followUp } = await this._callLLM(followUpMessages);
        finalReply = followUp;
      }

      if (!finalReply) {
        console.warn('[elevenlabs] LLM returned empty reply');
        return;
      }

      console.log(`[elevenlabs] Assistant reply: "${finalReply}"`);
      this.history.addAssistantTurn(finalReply);
      this.emit('assistant_transcript', finalReply);

      // ── Step 4: TTS via ElevenLabs ──
      await this._speak(finalReply);

      this.emit('response_done');
    } catch (err) {
      console.error('[elevenlabs] _processText error:', err.message);
      this.emit('error', err);
    }
  }

  // ── STT: ElevenLabs Scribe ──────────────────────────────────────────────────

  async _transcribe(pcmBuffer) {
    // Scribe accepts WAV/MP3/etc. We wrap raw PCM in a minimal WAV container.
    const wav = _pcmToWav(pcmBuffer, 24000, 1, 16);

    const formData = new FormData();
    formData.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model_id', 'scribe_v1');

    const res = await fetch(`${ELEVENLABS_BASE}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.elevenLabsKey },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElevenLabs STT ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.text || '';
  }

  // ── LLM call (OpenAI or Anthropic) ─────────────────────────────────────────

  async _callLLM(messages) {
    if (this.llmProvider === 'anthropic') {
      return this._callAnthropic(messages);
    }
    return this._callOpenAI(messages);
  }

  async _callOpenAI(messages) {
    const body = {
      model: this.llmModel,
      messages: [
        { role: 'system', content: this.systemPrompt },
        ...messages,
      ],
    };

    if (this.tools.length > 0) {
      // Convert OpenAI Realtime tool format → Chat Completions format
      body.tools = this.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.llmKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenAI LLM ${res.status}: ${err}`);
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
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
          };
        }
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
        'x-api-key':          this.llmKey,
        'anthropic-version':  ANTHROPIC_VERSION,
        'Content-Type':       'application/json',
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

  // ── TTS: ElevenLabs ─────────────────────────────────────────────────────────

  async _speak(text) {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/text-to-speech/${this.voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key':   this.elevenLabsKey,
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

    // Stream PCM chunks out as 'audio' events
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        this.emit('audio', Buffer.from(value));
      }
    }

    this.emit('audio_done');
  }

  disconnect() {
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    this._speaking    = false;
    this._audioChunks = [];
    this._totalBytes  = 0;
    this._isConnected = false;
    console.log('[elevenlabs] Disconnected');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute RMS amplitude of a PCM s16le buffer.
 * Used for silence detection.
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
 * Wrap raw PCM s16le into a minimal WAV container.
 * ElevenLabs Scribe requires a proper audio file format.
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
  header.writeUInt16LE(1, 20);              // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}
