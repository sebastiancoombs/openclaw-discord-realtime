/**
 * OpenClaw Plugin: Discord Realtime Voice (v3)
 *
 * Bridges Discord voice ↔ OpenAI Realtime API.
 * Uses OpenClaw's Discord gateway (Carbon). No second bot.
 *
 * register(api):
 *   - Registers a gateway_start hook (deferred, non-blocking)
 *   - Registers a /rtstatus command
 *   - Does NOT start anything or poll anything
 *
 * gateway_start hook:
 *   - Gets the Carbon gateway client
 *   - Registers a VOICE_STATE_UPDATE listener
 *   - That's it — purely event-driven from here
 *
 * VOICE_STATE_UPDATE:
 *   - Followed user joins → start bridge
 *   - Followed user leaves → stop bridge
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { getGateway } from 'openclaw/plugin-sdk/discord';
import { VoiceBridge } from './voice-bridge.js';

// Module-level guard: prevent duplicate listener registration across reloads
let voiceListenerRegistered = false;
let currentBridge = null;

export default definePluginEntry({
  id: 'discord-realtime',
  name: 'Discord Realtime Voice',
  description: 'Voice bridge: Discord voice ↔ OpenAI Realtime API with tool calling',

  register(api) {
    const log = api.logger;
    const config = api.pluginConfig || {};
    const followUserIds = new Set(config.followUserIds || []);

    if (!followUserIds.size) {
      log.warn('[discord-realtime] No followUserIds configured — voice auto-join disabled');
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      log.warn('[discord-realtime] OPENAI_API_KEY not set — plugin disabled');
      return;
    }

    async function startBridge(channelId, guildId) {
      // Don't re-join the same channel
      if (currentBridge?.channelId === channelId && currentBridge?.isConnected) return;

      await stopBridge();

      const gw = getGateway();
      const client = gw?.client;
      if (!client) {
        log.error('[discord-realtime] Cannot start bridge: no Discord client');
        return;
      }

      const voicePlugin = client.getPlugin('voice');
      if (!voicePlugin) {
        log.error('[discord-realtime] Cannot start bridge: no voice plugin on Carbon client');
        return;
      }

      const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
      if (!adapterCreator) {
        log.error('[discord-realtime] Cannot start bridge: no voice adapter for guild');
        return;
      }

      const botUserId = client.options?.clientId;

      try {
        currentBridge = new VoiceBridge({
          channelId,
          guildId,
          adapterCreator,
          botUserId,
          apiKey: process.env.OPENAI_API_KEY,
          model: config.model || 'gpt-4o-realtime-preview',
          voice: config.voice || 'coral',
          systemPrompt: config.systemPrompt || 'You are a voice assistant. Be concise.',
          turnDetection: config.turnDetection || 'semantic_vad',
          log,
        });

        await currentBridge.start();
        log.info(`[discord-realtime] Bridge active in channel ${channelId}`);
      } catch (err) {
        log.error(`[discord-realtime] Failed to start bridge: ${err.message}`);
        currentBridge = null;
      }
    }

    async function stopBridge() {
      if (currentBridge) {
        try {
          currentBridge.destroy();
        } catch (err) {
          log.error(`[discord-realtime] Error destroying bridge: ${err.message}`);
        }
        currentBridge = null;
      }
    }

    /**
     * Register the VOICE_STATE_UPDATE listener on Carbon's client.
     * Called once, when we know the gateway client exists.
     */
    function registerVoiceListener(client) {
      if (voiceListenerRegistered) return;
      voiceListenerRegistered = true;

      client.registerListener({
        type: 'VOICE_STATE_UPDATE',
        parseRawData: (d) => d,
        handle: (data) => {
          // Ignore users we don't follow
          if (!followUserIds.has(data.user_id)) return;

          if (data.channel_id) {
            // User joined or switched channel
            startBridge(data.channel_id, data.guild_id).catch(err =>
              log.error(`[discord-realtime] Auto-join error: ${err.message}`)
            );
          } else {
            // User left voice
            stopBridge().catch(err =>
              log.error(`[discord-realtime] Auto-leave error: ${err.message}`)
            );
          }
        },
      });

      log.info(`[discord-realtime] VOICE_STATE_UPDATE listener registered — following ${followUserIds.size} user(s)`);
    }

    // ── Hook: gateway_start — fires when OpenClaw gateway is listening ──
    api.on('gateway_start', () => {
      const gw = getGateway();
      const client = gw?.client;

      if (!client) {
        log.error('[discord-realtime] gateway_start fired but no Discord client available');
        return;
      }

      // If Discord is already connected, register immediately
      if (gw.isConnected) {
        registerVoiceListener(client);
        return;
      }

      // Otherwise wait for Discord READY event
      client.registerListener({
        type: 'READY',
        parseRawData: (d) => d,
        handle: () => {
          registerVoiceListener(client);
        },
      });

      log.info('[discord-realtime] Waiting for Discord READY to register voice listener');
    });

    // ── Hook: gateway_stop — clean teardown ──
    api.on('gateway_stop', () => {
      voiceListenerRegistered = false;
      stopBridge().catch(err =>
        log.error(`[discord-realtime] Error during gateway_stop cleanup: ${err.message}`)
      );
    });

    // ── Command: /rtstatus ──
    api.registerCommand({
      name: 'rtstatus',
      description: 'Voice bridge status',
      handler: async () => ({
        text: currentBridge
          ? `🎙️ Voice: ✅ (${currentBridge.channelId}) | Realtime: ${currentBridge.isRealtimeConnected ? '✅' : '❌'}`
          : '🎙️ Voice bridge idle — join a voice channel to activate',
      }),
    });

    log.info(`[discord-realtime] Plugin registered — following ${followUserIds.size} user(s)`);
  },
});
