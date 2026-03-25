/**
 * OpenClaw Plugin: Discord Realtime Voice (v3 — clean rewrite)
 *
 * Bridges Discord voice ↔ OpenAI Realtime API.
 * One bot (OpenClaw's Discord gateway). No second client.
 *
 * Uses:
 *   - api.registerService()  → lifecycle-managed voice bridge
 *   - api.registerTool()     → expose tools to the Realtime API via invokeTool
 *   - api.registerCommand()  → /rtstatus for bridge health
 *   - getGateway()           → Carbon's Discord gateway for voice adapter
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { getGateway } from 'openclaw/plugin-sdk/discord';
import { VoiceBridge } from './voice-bridge.js';

export default definePluginEntry({
  id: 'discord-realtime',
  name: 'Discord Realtime Voice',

  register(api) {
    const log = api.logger;
    const config = api.pluginConfig || {};
    const followUserIds = new Set(config.followUserIds || []);

    if (!followUserIds.size) {
      log.warn('No followUserIds configured — voice auto-join disabled');
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      log.error('OPENAI_API_KEY not set — voice bridge cannot start');
      return;
    }

    // ── Voice bridge (lifecycle-managed) ──
    let bridge = null;
    let listenerRegistered = false;

    /**
     * Tool executor: routes tool calls from Realtime API → OpenClaw's registered tools.
     */
    async function executeTool(name, args) {
      if (api.runtime?.invokeTool) {
        try {
          const result = await api.runtime.invokeTool(name, args);
          return JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      }
      return JSON.stringify({ error: `Tool not available: ${name}` });
    }

    /**
     * Start bridge in a voice channel.
     */
    async function startBridge(channelId, guildId) {
      if (bridge?.channelId === channelId && bridge?.isConnected) return;
      await stopBridge();

      const gw = getGateway();
      const client = gw?.client;
      if (!client) {
        log.error('Cannot start bridge: Discord gateway not available');
        return;
      }

      const voicePlugin = client.getPlugin('voice');
      const adapterCreator = voicePlugin?.getGatewayAdapterCreator(guildId);
      if (!adapterCreator) {
        log.error('Cannot start bridge: voice adapter not available');
        return;
      }

      const botUserId = client.options?.clientId;

      bridge = new VoiceBridge({
        channelId,
        guildId,
        adapterCreator,
        botUserId,
        apiKey: process.env.OPENAI_API_KEY,
        model: config.model || 'gpt-4o-realtime-preview',
        voice: config.voice || 'coral',
        systemPrompt: config.systemPrompt || 'You are a voice assistant. Be concise.',
        turnDetection: config.turnDetection || 'semantic_vad',
        executeTool,
        log,
      });

      await bridge.start();
    }

    /**
     * Stop and tear down the bridge.
     */
    async function stopBridge() {
      if (bridge) {
        bridge.destroy();
        bridge = null;
      }
    }

    /**
     * Register VOICE_STATE_UPDATE listener on Carbon's gateway.
     * Called once when the gateway client is available.
     */
    function registerVoiceListener() {
      if (listenerRegistered) return;

      const gw = getGateway();
      const client = gw?.client;
      if (!client) return false;

      client.registerListener({
        type: 'VOICE_STATE_UPDATE',
        parseRawData: (d) => d,
        handle: (data) => {
          if (!followUserIds.has(data.user_id)) return;

          if (data.channel_id) {
            startBridge(data.channel_id, data.guild_id).catch(e =>
              log.error(`Auto-join failed: ${e.message}`)
            );
          } else {
            stopBridge().catch(e =>
              log.error(`Auto-leave failed: ${e.message}`)
            );
          }
        },
      });

      listenerRegistered = true;
      log.info(`Voice listener registered — following ${followUserIds.size} user(s)`);
      return true;
    }

    // ── Service: lifecycle-managed startup/shutdown ──
    api.registerService({
      id: 'discord-realtime-voice',
      name: 'Discord Realtime Voice Bridge',

      async start() {
        // Try to register immediately if gateway is ready
        if (registerVoiceListener()) return;

        // Otherwise wait for gateway to become available
        // Check periodically with bounded retries
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(() => {
          attempts++;
          if (registerVoiceListener() || attempts >= maxAttempts) {
            clearInterval(interval);
            if (attempts >= maxAttempts && !listenerRegistered) {
              log.error('Gave up waiting for Discord gateway after 60s');
            }
          }
        }, 3000);

        // Store interval ref for cleanup
        this._waitInterval = interval;
      },

      async stop() {
        if (this._waitInterval) clearInterval(this._waitInterval);
        await stopBridge();
        listenerRegistered = false;
        log.info('Voice bridge service stopped');
      },

      health() {
        return {
          status: bridge?.isConnected ? 'healthy' : 'idle',
          channel: bridge?.channelId || null,
          realtimeConnected: bridge?.isRealtimeConnected || false,
        };
      },
    });

    // ── Command: /rtstatus ──
    api.registerCommand({
      name: 'rtstatus',
      description: 'Voice bridge status',
      handler: async () => ({
        text: bridge
          ? `🎙️ Voice: ✅ (${bridge.channelId}) | Realtime: ${bridge.isRealtimeConnected ? '✅' : '❌'}`
          : '🎙️ Voice bridge idle — join a voice channel to activate',
      }),
    });

    log.info(`Plugin registered — following ${followUserIds.size} user(s)`);
  },
});
