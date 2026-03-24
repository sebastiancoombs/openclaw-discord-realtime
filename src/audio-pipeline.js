/**
 * Audio format conversion pipeline.
 *
 * Discord sends Opus at 48kHz stereo.
 * OpenAI Realtime expects PCM 16-bit mono 24kHz.
 * OpenAI Realtime sends PCM 16-bit mono 24kHz.
 * Discord expects Opus at 48kHz stereo.
 *
 * Pipeline:
 *   Discord Opus 48kHz → decode → PCM 48kHz stereo → resample → PCM 24kHz mono → Realtime API
 *   Realtime API → PCM 24kHz mono → resample → PCM 48kHz stereo → encode → Discord Opus
 */

import { Transform } from 'stream';
import prism from 'prism-media';

/**
 * Create an Opus decoder that outputs PCM s16le.
 * Discord sends 48kHz stereo Opus frames.
 */
export function createOpusDecoder() {
  return new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960, // 20ms at 48kHz
  });
}

/**
 * Create an Opus encoder for sending audio back to Discord.
 */
export function createOpusEncoder() {
  return new prism.opus.Encoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
}

/**
 * Resample PCM from 48kHz stereo to 24kHz mono.
 * Simple decimation + channel mixing (good enough for voice).
 */
export class Downsampler extends Transform {
  constructor() {
    super();
  }

  _transform(chunk, encoding, callback) {
    // Input: PCM s16le, 48kHz, stereo (4 bytes per sample pair)
    // Output: PCM s16le, 24kHz, mono (2 bytes per sample)
    const samples = chunk.length / 4; // each stereo sample = 4 bytes (2 channels × 2 bytes)
    const output = Buffer.alloc(Math.floor(samples / 2) * 2); // 2:1 downsample, mono
    let outIdx = 0;

    for (let i = 0; i < samples; i += 2) {
      // Take every other stereo sample pair, mix to mono
      const offset = i * 4;
      if (offset + 3 >= chunk.length) break;
      const left = chunk.readInt16LE(offset);
      const right = chunk.readInt16LE(offset + 2);
      const mono = Math.round((left + right) / 2);
      if (outIdx + 1 < output.length) {
        output.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), outIdx);
        outIdx += 2;
      }
    }

    callback(null, output.subarray(0, outIdx));
  }
}

/**
 * Resample PCM from 24kHz mono to 48kHz stereo.
 * Simple interpolation + channel duplication.
 */
export class Upsampler extends Transform {
  constructor() {
    super();
  }

  _transform(chunk, encoding, callback) {
    // Input: PCM s16le, 24kHz, mono (2 bytes per sample)
    // Output: PCM s16le, 48kHz, stereo (4 bytes × 2 per input sample)
    const monoSamples = chunk.length / 2;
    const output = Buffer.alloc(monoSamples * 2 * 4); // 2× upsample, stereo = 4 bytes per output sample × 2
    let outIdx = 0;

    for (let i = 0; i < monoSamples; i++) {
      const sample = chunk.readInt16LE(i * 2);

      // Duplicate sample twice (2:1 upsample) and to both channels (stereo)
      for (let dup = 0; dup < 2; dup++) {
        output.writeInt16LE(sample, outIdx);     // left
        output.writeInt16LE(sample, outIdx + 2); // right
        outIdx += 4;
      }
    }

    callback(null, output.subarray(0, outIdx));
  }
}

/**
 * Buffer PCM audio into fixed-size chunks for Opus encoding.
 * Opus encoder expects exactly 960 stereo samples = 3840 bytes per frame.
 */
export class PCMFramer extends Transform {
  constructor(frameSize = 3840) {
    super();
    this.frameSize = frameSize;
    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.subarray(0, this.frameSize);
      this.buffer = this.buffer.subarray(this.frameSize);
      this.push(frame);
    }

    callback();
  }

  _flush(callback) {
    // Pad final frame with silence if needed
    if (this.buffer.length > 0) {
      const padded = Buffer.alloc(this.frameSize, 0);
      this.buffer.copy(padded);
      this.push(padded);
    }
    callback();
  }
}
