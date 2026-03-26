/**
 * VoiceBridge — owns the full lifecycle:
 *   Discord voice connection ↔ audio pipeline ↔ OpenAI Realtime WebSocket
 *
 * Usage: create → start() → destroy(). No orphaned state.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import { PassThrough } from 'stream';
import { RealtimeConnection } from './realtime-connection.js';
import {
  createOpusDecoder,
  createOpusEncoder,
  Downsampler,
  Upsampler,
  PCMFramer,
} from './audio-pipeline.js';

export class VoiceBridge {
  /**
   * @param {object} opts
   * @param {string} opts.channelId
   * @param {string} opts.guildId
   * @param {Function} opts.adapterCreator - from Carbon VoicePlugin.getGatewayAdapterCreator()
   * @param {string} opts.botUserId - bot's own user ID, to filter self-audio
   * @param {string} opts.apiKey - OpenAI API key
   * @param {string} opts.model
   * @param {string} opts.voice
   * @param {string} opts.systemPrompt
   * @param {string} opts.turnDetection
   * @param {object} opts.log - PluginLogger { info, warn, error }
   */
  constructor(opts) {
    this.channelId = opts.channelId;
    this.guildId = opts.guildId;
    this.adapterCreator = opts.adapterCreator;
    this.botUserId = opts.botUserId;
    this.log = opts.log;

    // Discord voice
    this.connection = null;
    this.player = createAudioPlayer();
    this._playbackStream = null;
    this._streaming = false;
    this._activeListeners = new Map();
    this._destroyed = false;

    // OpenAI Realtime
    this.realtime = new RealtimeConnection({
      apiKey: opts.apiKey,
      model: opts.model,
      voice: opts.voice,
      systemPrompt: opts.systemPrompt,
      turnDetection: opts.turnDetection,
      log: opts.log,
    });
  }

  get isConnected() {
    return !this._destroyed && this.connection?.state?.status === VoiceConnectionStatus.Ready;
  }

  get isRealtimeConnected() {
    return this.realtime.connected;
  }

  /**
   * Join voice channel → connect to Realtime API → wire audio.
   */
  async start() {
    if (this._destroyed) throw new Error('Bridge already destroyed');

    // 1. Join Discord voice channel
    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guildId,
      adapterCreator: this.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.subscribe(this.player);

    // Handle unexpected disconnection
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnecting — do nothing
      } catch {
        this.log.warn('[discord-realtime] Voice connection lost');
        this.destroy();
      }
    });

    // 2. Wire Realtime API events → Discord playback
    this.realtime.on('speech_started', () => {
      if (this._streaming) this._endPlayback();
    });

    this.realtime.on('audio', (pcmChunk) => {
      if (!this._streaming) this._startPlayback();
      this._appendAudio(pcmChunk);
    });

    this.realtime.on('audio_done', () => {
      this._endPlayback();
    });

    this.realtime.on('user_transcript', (text) => {
      this.log.info(`[discord-realtime] User: ${text}`);
    });

    this.realtime.on('assistant_transcript', (text) => {
      this.log.info(`[discord-realtime] Assistant: ${text}`);
    });

    this.realtime.on('error', (err) => {
      this.log.error(`[discord-realtime] Realtime error: ${err.message}`);
    });

    this.realtime.on('disconnected', () => {
      this.log.warn('[discord-realtime] Realtime API disconnected');
    });

    // Player events
    this.player.on(AudioPlayerStatus.Idle, () => {
      this._streaming = false;
    });

    this.player.on('error', (err) => {
      this.log.error(`[discord-realtime] Audio player error: ${err.message}`);
      this._streaming = false;
    });

    // 3. Connect to OpenAI Realtime API
    this.realtime.connect();

    // 4. Start listening to Discord audio when Realtime is ready
    this.realtime.once('ready', () => {
      this._listenToAll();
    });
  }

  /**
   * Listen to all users in the voice channel.
   * Opus → decode → downsample → PCM 24kHz mono → Realtime API
   */
  _listenToAll() {
    if (!this.connection) return;

    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      if (this.botUserId && userId === this.botUserId) return;
      if (this._activeListeners.has(userId)) return;

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });

      const decoder = createOpusDecoder();
      const downsampler = new Downsampler();

      this._activeListeners.set(userId, { opusStream, decoder, downsampler });

      const cleanup = () => {
        this._activeListeners.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        downsampler.destroy();
      };

      opusStream
        .pipe(decoder)
        .pipe(downsampler)
        .on('data', (pcm) => {
          if (!this._destroyed) this.realtime.sendAudio(pcm);
        })
        .on('end', cleanup)
        .on('error', (err) => {
          this.log.error(`[discord-realtime] Audio decode error (${userId}): ${err.message}`);
          cleanup();
        });
    });
  }

  _startPlayback() {
    this._playbackStream = new PassThrough();
    const upsampler = new Upsampler();
    const framer = new PCMFramer(3840);
    const encoder = createOpusEncoder();

    this._playbackStream.pipe(upsampler).pipe(framer).pipe(encoder);

    const resource = createAudioResource(encoder, { inputType: StreamType.Opus });
    this.player.play(resource);
    this._streaming = true;
  }

  _appendAudio(pcmData) {
    if (this._playbackStream && !this._playbackStream.destroyed) {
      this._playbackStream.write(pcmData);
    }
  }

  _endPlayback() {
    if (this._playbackStream && !this._playbackStream.destroyed) {
      this._playbackStream.end();
    }
    this._playbackStream = null;
    this._streaming = false;
  }

  /**
   * Tear down everything. No orphaned state.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    // Audio listeners
    for (const [, { opusStream, decoder, downsampler }] of this._activeListeners) {
      opusStream.destroy();
      decoder.destroy();
      downsampler.destroy();
    }
    this._activeListeners.clear();

    // Playback
    this._endPlayback();

    // Realtime API
    this.realtime.disconnect();
    this.realtime.removeAllListeners();

    // Voice channel
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }
}
