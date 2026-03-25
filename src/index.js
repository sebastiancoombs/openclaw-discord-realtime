/**
 * OpenClaw Plugin: Discord Realtime Voice
 *
 * Bridges Discord voice channels ↔ a configurable voice provider (OpenAI Realtime,
 * ElevenLabs, Cascade) for sub-500ms voice control with function calling tools.
 *
 * Hooks into OpenClaw's existing Discord voice infrastructure — does NOT create
 * its own Discord client.
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { DiscordVoice } from './discord-voice.js';
import { createProvider } from './provider.js';
import { loadTools } from './tools.js';
import { ConversationHistory } from './conversation-history.js';
import { VoiceMemory } from './memory.js';

export default definePluginEntry({
  id: 'discord-realtime',
  name: 'Discord Realtime Voice',
  description: 'Sub-500ms voice control via Discord voice channels using OpenAI Realtime API',
  register(api) {
    const log = api.logger;
    const config = api.pluginConfig || {};

    // ── State ──

    let discordVoice = null;
    let provider = null;
    let history = null;
    let memory = null;
    let currentChannel = null;
    let sessionStartTime = null;
    let isStreamingResponse = false;

    // ── Tools ──

    let realtimeTools = [];
    let executeToolFn = null;

    if (config.tools && Array.isArray(config.tools)) {
      realtimeTools = config.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }

    if (config.toolsFile) {
      try {
        const loaded = loadTools(config.toolsFile);
        realtimeTools = [...realtimeTools, ...loaded.tools];
        executeToolFn = loaded.executeTool;
      } catch (err) {
        log.warn(`Failed to load tools file: ${err.message}`);
      }
    }

    async function executeAnyTool(toolName, args) {
      if (executeToolFn) {
        const result = await executeToolFn(toolName, args);
        if (!result.includes('"error":"Unknown tool:')) return result;
      }
      if (api.runtime) {
        try {
          const result = await api.runtime.invokeTool(toolName, args);
          return typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          return JSON.stringify({ error: err.message });
        }
      }
      return JSON.stringify({ error: `No executor for tool: ${toolName}` });
    }

    // ── Transcript save helper ──

    async function saveSessionTranscript() {
      if (memory?.enabled && history && history.length > 0) {
        await memory.saveTranscript(history, {
          channelName: currentChannel?.name || 'voice',
          guildName: currentChannel?.guild?.name || 'unknown',
          startTime: sessionStartTime,
          provider: config.provider || 'openai-realtime',
        });
      }
    }

    // ── Core: Voice Bridge ──

    async function startVoiceBridge(channel, listenUserIds) {
      log.info(`Starting voice bridge in #${channel.name} (provider: ${config.provider || 'openai-realtime'})`);

      currentChannel = channel;
      sessionStartTime = new Date().toISOString();

      discordVoice = new DiscordVoice();
      await discordVoice.join(channel);

      history = new ConversationHistory(config.history?.maxTurns || 50);

      let previousContext = '';
      if (memory?.enabled) {
        previousContext = await memory.loadPreviousContext();
      }

      let systemPrompt = config.systemPrompt || 'You are a voice assistant. Be concise.';
      if (previousContext) {
        systemPrompt += '\n\nYou have memory of previous voice conversations:\n' + previousContext;
      }

      const sessionConfig = { ...config, systemPrompt, provider: config.provider || 'openai-realtime' };
      provider = createProvider(sessionConfig, realtimeTools, executeAnyTool, history);

      discordVoice.on('audio', (pcmChunk) => provider.sendAudio(pcmChunk));

      provider.on('speech_started', () => {
        if (isStreamingResponse) { discordVoice.endPlayback(); isStreamingResponse = false; }
      });

      provider.on('audio', (pcmChunk) => {
        if (!isStreamingResponse) { discordVoice.startPlayback(); isStreamingResponse = true; }
        discordVoice.appendAudio(pcmChunk);
      });

      provider.on('audio_done', () => { discordVoice.endPlayback(); isStreamingResponse = false; });

      provider.on('user_transcript', (text) => {
        log.info(`User: ${text}`);
        if (!history.turns.length || history.turns[history.turns.length - 1].content !== text) {
          history.addUserTurn(text);
        }
      });

      provider.on('assistant_transcript', (text) => {
        log.info(`Assistant: ${text}`);
        if (!history.turns.length || history.turns[history.turns.length - 1].content !== text) {
          history.addAssistantTurn(text);
        }
      });

      provider.on('error', (err) => log.error(`Provider error: ${err.message}`));
      provider.on('disconnected', async () => { log.warn('Provider disconnected'); await saveSessionTranscript(); });

      provider.connect();

      provider.once('ready', () => {
        if (listenUserIds?.length) {
          discordVoice.listenTo(listenUserIds[0]);
        } else {
          discordVoice.listenToAll();
        }
        log.info('Voice bridge active');
      });
    }

    async function stopVoiceBridge() {
      await saveSessionTranscript();
      discordVoice?.leave();
      provider?.disconnect();
      discordVoice = null;
      provider = null;
      history = null;
      currentChannel = null;
      isStreamingResponse = false;
    }

    // ── Register Service (uses `id`, `start`, `stop`) ──

    api.registerService({
      id: 'discord-realtime-voice',
      start: async () => {
        memory = new VoiceMemory({
          ...(config.memory || {}),
          transcriptDir: config.transcriptDir,
        });
        log.info(`Discord Realtime Voice service started (provider: ${config.provider || 'openai-realtime'}, tools: ${realtimeTools.length})`);
      },
      stop: async () => {
        await stopVoiceBridge();
        log.info('Discord Realtime Voice service stopped');
      },
    });

    // ── Register Commands (uses `handler` not `execute`, `args` is a string not array) ──

    api.registerCommand({
      name: 'rtjoin',
      description: 'Join your voice channel with OpenAI Realtime',
      acceptsArgs: false,
      handler: async (ctx) => {
        const voiceChannel = ctx.member?.voice?.channel;
        if (!voiceChannel) {
          return { text: 'Join a voice channel first.' };
        }
        if (currentChannel?.id === voiceChannel.id && provider?.connected) {
          return { text: `Already connected to **${voiceChannel.name}**.` };
        }
        if (provider) await stopVoiceBridge();
        await startVoiceBridge(voiceChannel, config.followUserIds);
        return { text: `🎙️ Joined **${voiceChannel.name}**. Realtime voice active.` };
      },
    });

    api.registerCommand({
      name: 'rtleave',
      description: 'Leave the voice channel (Realtime)',
      acceptsArgs: false,
      handler: async (ctx) => {
        if (!provider) {
          return { text: 'Not connected to any voice channel.' };
        }
        await stopVoiceBridge();
        return { text: '👋 Left voice channel.' };
      },
    });

    api.registerCommand({
      name: 'rtsay',
      description: 'Send text to the Realtime voice provider',
      acceptsArgs: true,
      handler: async (ctx) => {
        const text = (ctx.args || '').trim();
        if (!text) return { text: 'Usage: /rtsay <text>' };
        if (!provider?.connected) return { text: 'Not connected. Use /rtjoin first.' };
        provider.sendText(text);
        return { text: `📝 Sent: "${text}"` };
      },
    });

    api.registerCommand({
      name: 'rtstatus',
      description: 'Show Realtime voice bridge status',
      acceptsArgs: false,
      handler: async (ctx) => {
        const pStatus = provider?.connected ? '✅' : '❌';
        const vStatus = discordVoice?.connection ? '✅' : '❌';
        return {
          text: `**Discord Realtime Voice**\n` +
            `Voice: ${vStatus} | Provider: ${config.provider || 'openai-realtime'} ${pStatus}\n` +
            `Tools: ${realtimeTools.length} | History: ${history?.length || 0} turns\n` +
            `Memory: ${memory?.enabled ? '✅' : '❌'}`,
        };
      },
    });

    log.info(`discord-realtime plugin registered (${realtimeTools.length} tools)`);
  },
});
