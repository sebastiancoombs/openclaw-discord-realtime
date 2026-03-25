/**
 * VoiceBridge — single class that owns the full lifecycle:
 *   Discord voice connection ↔ audio pipeline ↔ OpenAI Realtime WebSocket
 *
 * Clean ownership: create → start() → destroy(). No orphaned state.
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
import { EventEmitter } from 'events';
import { RealtimeConnection } from './realtime-connection.js';
import { createOpusDecoder, createOpusEncoder, Downsampler, Upsampler, PCMFramer } from './audio-pipeline.js';

export class VoiceBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.channelId
   * @param {string} opts.guildId
   * @param {Function} opts.adapterCreator
   * @param {string} opts.botUserId
   * @param {string} opts.apiKey
   * @param {string} opts.model
   * @param {string} opts.voice
   * @param {string} opts.systemPrompt
   * @param {string} opts.turnDetection
   * @param {Function} opts.executeTool
   * @param {object} opts.log
   */
  constructor(opts) {
    super();
    this.channelId = opts.channelId;
    this.guildId = opts.guildId;
    this.adapterCreator = opts.adapterCreator;
    this.botUserId = opts.botUserId;
    this.executeTool = opts.executeTool;
    this.log = opts.log;

    // Discord voice
    this.connection = null;
    this.player = createAudioPlayer();
    this._playbackStream = null;
    this._streaming = false;
    this._activeListeners = new Map();

    // OpenAI Realtime
    this.realtime = new RealtimeConnection({
      apiKey: opts.apiKey,
      model: opts.model,
      voice: opts.voice,
      systemPrompt: opts.systemPrompt,
      turnDetection: opts.turnDetection,
      executeTool: opts.executeTool,
      log: opts.log,
    });

    this._destroyed = false;
  }

  get isConnected() {
    return this.connection?.state?.status === VoiceConnectionStatus.Ready;
  }

  get isRealtimeConnected() {
    return this.realtime.connected;
  }

  /**
   * Start the bridge: join voice channel → connect to Realtime API → wire audio.
   */
  async start() {
    if (this._destroyed) throw new Error('Bridge destroyed');

    // 1. Join Discord voice channel
    this.log.info(`Joining voice channel ${this.channelId}`);
    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guildId,
      adapterCreator: this.adapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    this.connection.subscribe(this.player);
    this.log.info('Discord voice connection ready');

    // Handle disconnection
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.log.warn('Voice connection lost — destroying bridge');
        this.destroy();
      }
    });

    // 2. Wire Realtime API events → Discord playback
    this.realtime.on('speech_started', () => {
      // User started talking — interrupt any current playback (barge-in)
      if (this._streaming) {
        this._endPlayback();
      }
    });

    this.realtime.on('audio', (pcmChunk) => {
      if (!this._streaming) this._startPlayback();
      this._appendAudio(pcmChunk);
    });

    this.realtime.on('audio_done', () => {
      this._endPlayback();
    });

    this.realtime.on('user_transcript', (text) => {
      this.log.info(`User: ${text}`);
    });

    this.realtime.on('assistant_transcript', (text) => {
      this.log.info(`Assistant: ${text}`);
    });

    this.realtime.on('error', (err) => {
      this.log.error(`Realtime error: ${err.message}`);
    });

    this.realtime.on('disconnected', () => {
      this.log.warn('Realtime API disconnected');
    });

    // 3. Connect to OpenAI Realtime
    this.realtime.connect();

    // 4. Wait for ready, then start listening to Discord audio
    this.realtime.once('ready', () => {
      this._listenToAll();
      this.log.info(`Bridge active in channel ${this.channelId}`);
    });

    // Player lifecycle
    this.player.on(AudioPlayerStatus.Idle, () => {
      this._streaming = false;
    });

    this.player.on('error', (err) => {
      this.log.error(`Audio player error: ${err.message}`);
      this._streaming = false;
    });
  }

  /**
   * Listen to all users speaking in the voice channel.
   * Decodes Opus → PCM 24kHz mono → sends to Realtime API.
   */
  _listenToAll() {
    if (!this.connection) return;

    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      // Skip bot's own audio
      if (this.botUserId && userId === this.botUserId) return;
      // Skip if already listening to this user
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
          this.log.error(`Audio decode error (${userId}): ${err.message}`);
          cleanup();
        });
    });
  }

  /**
   * Start streaming playback to Discord.
   */
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

  /**
   * Append PCM chunk to current playback stream.
   */
  _appendAudio(pcmData) {
    if (this._playbackStream && !this._playbackStream.destroyed) {
      this._playbackStream.write(pcmData);
    }
  }

  /**
   * End current playback stream.
   */
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

    // Clean up audio listeners
    for (const [, { opusStream, decoder, downsampler }] of this._activeListeners) {
      opusStream.destroy();
      decoder.destroy();
      downsampler.destroy();
    }
    this._activeListeners.clear();

    // End playback
    this._endPlayback();

    // Disconnect Realtime API
    this.realtime.disconnect();

    // Leave voice channel
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    this.log.info('Voice bridge destroyed');
  }
}
