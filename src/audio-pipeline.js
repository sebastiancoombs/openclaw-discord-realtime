/**
 * Audio format conversion pipeline.
 *
 * Discord: Opus 48kHz stereo
 * OpenAI Realtime: PCM 16-bit mono 24kHz
 *
 * Inbound:  Discord Opus 48kHz → decode → PCM 48kHz stereo → downsample → PCM 24kHz mono → Realtime
 * Outbound: Realtime → PCM 24kHz mono → upsample → PCM 48kHz stereo → encode → Discord Opus
 */

import { Transform } from 'stream';
import prism from 'prism-media';

/**
 * Opus decoder: Discord 48kHz stereo → PCM s16le.
 */
export function createOpusDecoder() {
  return new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960, // 20ms at 48kHz
  });
}

/**
 * Opus encoder: PCM s16le → Discord 48kHz stereo.
 */
export function createOpusEncoder() {
  return new prism.opus.Encoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
}

/**
 * Downsample PCM 48kHz stereo → 24kHz mono.
 * Simple decimation + channel mixing (sufficient for voice).
 */
export class Downsampler extends Transform {
  constructor() {
    super();
  }

  _transform(chunk, _encoding, callback) {
    // Input: 4 bytes per stereo sample pair (2 channels × 2 bytes)
    // Output: 2 bytes per mono sample, 2:1 downsample
    const samples = chunk.length / 4;
    const output = Buffer.alloc(Math.floor(samples / 2) * 2);
    let outIdx = 0;

    for (let i = 0; i < samples; i += 2) {
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
 * Upsample PCM 24kHz mono → 48kHz stereo.
 * Simple duplication + channel copy.
 */
export class Upsampler extends Transform {
  constructor() {
    super();
  }

  _transform(chunk, _encoding, callback) {
    // Input: 2 bytes per mono sample
    // Output: 8 bytes per output (2× upsample, stereo = 4 bytes × 2)
    const monoSamples = chunk.length / 2;
    const output = Buffer.alloc(monoSamples * 8);
    let outIdx = 0;

    for (let i = 0; i < monoSamples; i++) {
      const sample = chunk.readInt16LE(i * 2);

      // Duplicate twice (2:1 upsample), both channels (stereo)
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
 * Buffer PCM into fixed-size frames for Opus encoding.
 * Opus expects exactly 960 stereo samples = 3840 bytes per frame.
 */
export class PCMFramer extends Transform {
  constructor(frameSize = 3840) {
    super();
    this.frameSize = frameSize;
    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= this.frameSize) {
      this.push(this.buffer.subarray(0, this.frameSize));
      this.buffer = this.buffer.subarray(this.frameSize);
    }

    callback();
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      const padded = Buffer.alloc(this.frameSize, 0);
      this.buffer.copy(padded);
      this.push(padded);
    }
    callback();
  }
}
