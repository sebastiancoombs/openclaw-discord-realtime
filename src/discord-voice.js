/**
 * Discord voice channel integration.
 * Joins a voice channel, captures user audio, plays back AI audio.
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
import { Readable, PassThrough } from 'stream';
import { EventEmitter } from 'events';
import {
  createOpusDecoder,
  createOpusEncoder,
  Downsampler,
  Upsampler,
  PCMFramer,
} from './audio-pipeline.js';

export class DiscordVoice extends EventEmitter {
  constructor() {
    super();
    this.connection = null;
    this.player = createAudioPlayer();
    this._audioQueue = [];
    this._isPlaying = false;
    this._playbackStream = null;

    // When player goes idle, check for queued audio
    this.player.on(AudioPlayerStatus.Idle, () => {
      this._isPlaying = false;
      this._playNext();
    });

    this.player.on('error', (err) => {
      console.error('[DISCORD] Audio player error:', err.message);
      this._isPlaying = false;
    });
  }

  /**
   * Join a Discord voice channel.
   * @param {import('discord.js').VoiceChannel} channel
   */
  async join(channel) {
    console.log(`[DISCORD] Joining voice channel: ${channel.name} (${channel.id})`);

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // Need to hear users
      selfMute: false,
    });

    // Wait for connection to be ready
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    console.log('[DISCORD] Voice connection ready');

    // Subscribe the audio player to the connection
    this.connection.subscribe(this.player);

    // Handle disconnection
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Reconnecting...
      } catch {
        console.log('[DISCORD] Voice connection destroyed');
        this.connection.destroy();
        this.emit('disconnected');
      }
    });
  }

  /**
   * Start listening to a specific user's audio.
   * @param {string} userId - Discord user ID
   */
  listenTo(userId) {
    if (!this.connection) throw new Error('Not connected to voice channel');

    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (speakingUserId) => {
      if (userId && speakingUserId !== userId) return;

      console.log(`[DISCORD] User ${speakingUserId} started speaking`);

      // Subscribe to user's audio stream
      const opusStream = receiver.subscribe(speakingUserId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000, // 1 second of silence ends the stream
        },
      });

      // Decode Opus → PCM 48kHz stereo → downsample to 24kHz mono
      const decoder = createOpusDecoder();
      const downsampler = new Downsampler();

      opusStream
        .pipe(decoder)
        .pipe(downsampler)
        .on('data', (pcmChunk) => {
          // Emit PCM 24kHz mono chunks for the Realtime API
          this.emit('audio', pcmChunk);
        })
        .on('end', () => {
          console.log(`[DISCORD] User ${speakingUserId} stopped speaking`);
        })
        .on('error', (err) => {
          console.error(`[DISCORD] Audio decode error:`, err.message);
        });
    });

    console.log(`[DISCORD] Listening to user: ${userId || 'ALL'}`);
  }

  /**
   * Listen to ALL users in the channel.
   */
  listenToAll() {
    this.listenTo(null);
  }

  /**
   * Play PCM 24kHz mono audio back into the voice channel.
   * Buffers incoming audio and plays as a continuous stream.
   * @param {Buffer} pcmData - PCM s16le 24kHz mono audio
   */
  queueAudio(pcmData) {
    this._audioQueue.push(pcmData);
    if (!this._isPlaying) {
      this._playNext();
    }
  }

  /**
   * Start a new playback stream for continuous audio from Realtime API.
   * Call appendAudio() to feed chunks, then endAudio() when done.
   */
  startPlayback() {
    // Create a passthrough stream for continuous audio
    this._playbackStream = new PassThrough();

    // Upsample 24kHz mono → 48kHz stereo, then encode to Opus
    const upsampler = new Upsampler();
    const framer = new PCMFramer(3840); // 960 samples × 2 channels × 2 bytes
    const encoder = createOpusEncoder();

    this._playbackStream
      .pipe(upsampler)
      .pipe(framer)
      .pipe(encoder);

    const resource = createAudioResource(encoder, {
      inputType: StreamType.Opus,
    });

    this.player.play(resource);
    this._isPlaying = true;
  }

  /**
   * Append audio chunk to the current playback stream.
   * @param {Buffer} pcmData - PCM s16le 24kHz mono
   */
  appendAudio(pcmData) {
    if (this._playbackStream && !this._playbackStream.destroyed) {
      this._playbackStream.write(pcmData);
    }
  }

  /**
   * End the current playback stream.
   */
  endPlayback() {
    if (this._playbackStream && !this._playbackStream.destroyed) {
      this._playbackStream.end();
      this._playbackStream = null;
    }
  }

  _playNext() {
    if (this._audioQueue.length === 0) return;

    const pcmData = Buffer.concat(this._audioQueue);
    this._audioQueue = [];

    // Create a readable stream from the buffer
    const stream = new Readable({
      read() {
        this.push(pcmData);
        this.push(null);
      },
    });

    // Upsample and encode
    const upsampler = new Upsampler();
    const framer = new PCMFramer(3840);
    const encoder = createOpusEncoder();

    stream
      .pipe(upsampler)
      .pipe(framer)
      .pipe(encoder);

    const resource = createAudioResource(encoder, {
      inputType: StreamType.Opus,
    });

    this.player.play(resource);
    this._isPlaying = true;
  }

  /**
   * Leave the voice channel.
   */
  leave() {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }
}
