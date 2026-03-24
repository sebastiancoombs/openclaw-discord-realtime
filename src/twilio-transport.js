/**
 * Twilio Media Streams transport.
 *
 * The Twilio equivalent of discord-voice.js — handles the WebSocket connection
 * and bidirectional audio format conversion (mulaw 8kHz ↔ PCM 24kHz).
 *
 * Emits:
 *   'audio' (Buffer)   — PCM 24kHz 16-bit mono chunks (same as discord-voice.js)
 *   'call_start' ({ callSid, from, to, customParameters })
 *   'call_end' ({ callSid })
 *   'dtmf' ({ digit })
 *
 * Methods:
 *   startPlayback()    — no-op (Twilio buffers automatically)
 *   appendAudio(buf)   — convert PCM 24kHz → mulaw 8kHz, send to Twilio
 *   endPlayback()      — send mark message to track completion
 *   clearPlayback()    — send clear message (barge-in: stop current audio)
 */

import { EventEmitter } from 'events';

export class TwilioTransport extends EventEmitter {
  constructor() {
    super();
    this.streamSid = null;
    this.callSid = null;
    this.ws = null;
    this._markCounter = 0;
  }

  /**
   * Handle an incoming WebSocket connection from Twilio.
   * Called by TwilioServer when Twilio connects on /stream.
   */
  handleConnection(ws) {
    this.ws = ws;

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this._handleMessage(msg);
    });

    ws.on('close', () => {
      this.emit('call_end', { callSid: this.callSid });
      this.ws = null;
      this.streamSid = null;
      this.callSid = null;
    });

    ws.on('error', (err) => {
      console.error('[twilio] WebSocket error:', err.message);
    });
  }

  _handleMessage(msg) {
    switch (msg.event) {
      case 'connected':
        console.log('[twilio] WebSocket connected');
        break;

      case 'start':
        this.streamSid = msg.streamSid;
        this.callSid = msg.start.callSid;
        console.log(`[twilio] Stream started: call=${this.callSid} stream=${this.streamSid}`);
        this.emit('call_start', {
          callSid: this.callSid,
          from: msg.start.customParameters?.from || 'unknown',
          to: msg.start.customParameters?.to || 'unknown',
          customParameters: msg.start.customParameters || {},
        });
        break;

      case 'media': {
        // Decode base64 mulaw → convert to PCM 24kHz
        const mulawBuffer = Buffer.from(msg.media.payload, 'base64');
        const pcm8k = mulawToPcm(mulawBuffer);
        const pcm24k = upsample(pcm8k, 8000, 24000);
        this.emit('audio', pcm24k);
        break;
      }

      case 'dtmf':
        console.log(`[twilio] DTMF: ${msg.dtmf.digit}`);
        this.emit('dtmf', { digit: msg.dtmf.digit });
        break;

      case 'mark':
        // Playback of our audio completed
        break;

      case 'stop':
        console.log(`[twilio] Stream stopped: call=${msg.stop?.callSid}`);
        this.emit('call_end', { callSid: msg.stop?.callSid });
        break;
    }
  }

  /**
   * Send PCM 24kHz audio back to the caller.
   * Converts PCM 24kHz → mulaw 8kHz → base64 → Twilio WebSocket.
   */
  appendAudio(pcm24kBuffer) {
    if (!this.ws || !this.streamSid) return;

    const pcm8k = downsample(pcm24kBuffer, 24000, 8000);
    const mulaw = pcmToMulaw(pcm8k);
    const payload = mulaw.toString('base64');

    this.ws.send(JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload },
    }));
  }

  /** No-op — Twilio handles buffering automatically */
  startPlayback() {}

  /** Send a mark to track when audio finishes playing */
  endPlayback() {
    if (!this.ws || !this.streamSid) return;
    this._markCounter++;
    this.ws.send(JSON.stringify({
      event: 'mark',
      streamSid: this.streamSid,
      mark: { name: `response-${this._markCounter}` },
    }));
  }

  /** Clear the audio buffer — used for barge-in (interruption) */
  clearPlayback() {
    if (!this.ws || !this.streamSid) return;
    this.ws.send(JSON.stringify({
      event: 'clear',
      streamSid: this.streamSid,
    }));
  }
}

// ── Audio conversion functions ──────────────────────────────────────────────

/**
 * Convert mulaw encoded bytes to PCM 16-bit signed.
 * Standard ITU-T G.711 mulaw decoding.
 */
function mulawToPcm(mulawBuffer) {
  const MULAW_BIAS = 33;
  const pcm = Buffer.alloc(mulawBuffer.length * 2);

  for (let i = 0; i < mulawBuffer.length; i++) {
    let mulaw = ~mulawBuffer[i] & 0xFF;
    const sign = (mulaw & 0x80) ? -1 : 1;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    let sample = (mantissa << (exponent + 3)) + (MULAW_BIAS << exponent) - MULAW_BIAS;
    sample = sign * sample;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return pcm;
}

/**
 * Convert PCM 16-bit signed to mulaw encoded bytes.
 * Standard ITU-T G.711 mulaw encoding.
 */
function pcmToMulaw(pcmBuffer) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  const mulaw = Buffer.alloc(pcmBuffer.length / 2);

  for (let i = 0; i < mulaw.length; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    const sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = Math.min(sample + MULAW_BIAS, MULAW_MAX);

    let exponent = 7;
    const expMask = 0x4000;
    for (; exponent > 0; exponent--) {
      if (sample & (expMask >> (7 - exponent))) break;
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }

  return mulaw;
}

/**
 * Simple linear interpolation resampling (upsample).
 * Good enough for voice.
 */
function upsample(pcmBuffer, fromRate, toRate) {
  const ratio = toRate / fromRate;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples * ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i / ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = pcmBuffer.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
    const s1 = pcmBuffer.readInt16LE(Math.min(srcIndex + 1, inputSamples - 1) * 2);
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  return output;
}

/**
 * Simple decimation downsampling.
 */
function downsample(pcmBuffer, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.floor(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcIndex = Math.min(Math.floor(i * ratio), inputSamples - 1);
    output.writeInt16LE(pcmBuffer.readInt16LE(srcIndex * 2), i * 2);
  }

  return output;
}
