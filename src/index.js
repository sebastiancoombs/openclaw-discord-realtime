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

export default definePluginEntry((api) => {
  const log = api.logger;
  const config = api.pluginConfig;

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

  // If a toolsEndpoints config is provided, load HTTP endpoint tools
  if (config.toolsFile) {
    try {
      const loaded = loadTools(config.toolsFile);
      realtimeTools = [...realtimeTools, ...loaded.tools];
      executeToolFn = loaded.executeTool;
    } catch (err) {
      log.warn(`Failed to load tools file: ${err.message}`);
    }
  }

  // Tool executor — routes to HTTP endpoint tools or api.runtime for native tools
  async function executeAnyTool(toolName, args) {
    // Try HTTP endpoint tools first
    if (executeToolFn) {
      const result = await executeToolFn(toolName, args);
      if (!result.includes('"error":"Unknown tool:')) return result;
    }
    // Fall through to plugin runtime if available
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
      const sessionMetadata = {
        channelName: currentChannel?.name || 'voice',
        guildName: currentChannel?.guild?.name || 'unknown',
        startTime: sessionStartTime,
        provider: config.provider || 'openai-realtime',
      };
      await memory.saveTranscript(history, sessionMetadata);
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

    // Load previous session context
    let previousContext = '';
    if (memory?.enabled) {
      previousContext = await memory.loadPreviousContext();
      if (previousContext) {
        log.info(`Loaded context from ${memory.loadPreviousSessions} previous sessions`);
      }
    }

    // Build enriched system prompt
    let systemPrompt = config.systemPrompt || 'You are a voice assistant. Be concise.';
    if (previousContext) {
      systemPrompt += '\n\nYou have memory of previous voice conversations:\n' + previousContext;
      systemPrompt += '\n\nUse this context naturally. If the user references something from a previous conversation, you can recall it.';
    }

    const sessionConfig = {
      ...config,
      systemPrompt,
      provider: config.provider || 'openai-realtime',
    };
    provider = createProvider(sessionConfig, realtimeTools, executeAnyTool, history);

    // Discord → Provider
    discordVoice.on('audio', (pcmChunk) => {
      provider.sendAudio(pcmChunk);
    });

    // Barge-in: stop playback when user starts speaking
    provider.on('speech_started', () => {
      if (isStreamingResponse) {
        discordVoice.endPlayback();
        isStreamingResponse = false;
      }
    });

    // Provider → Discord
    provider.on('audio', (pcmChunk) => {
      if (!isStreamingResponse) {
        discordVoice.startPlayback();
        isStreamingResponse = true;
      }
      discordVoice.appendAudio(pcmChunk);
    });

    provider.on('audio_done', () => {
      discordVoice.endPlayback();
      isStreamingResponse = false;
    });

    // Transcripts (deduplicated — providers may also record via history)
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

    provider.on('error', (err) => {
      log.error(`Provider error: ${err.message}`);
    });

    provider.on('disconnected', async () => {
      log.warn('Provider disconnected unexpectedly');
      await saveSessionTranscript();
    });

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

  // ── Register Service: manages Realtime API WebSocket lifecycle ──

  api.registerService({
    name: 'discord-realtime-voice',
    description: 'Manages voice provider WebSocket lifecycle and Discord voice bridging',

    async start() {
      memory = new VoiceMemory({
        ...(config.memory || {}),
        transcriptDir: config.transcriptDir,
      });
      log.info(`Discord Realtime Voice service started (provider: ${config.provider || 'openai-realtime'}, tools: ${realtimeTools.length})`);
    },

    async stop() {
      await stopVoiceBridge();
      log.info('Discord Realtime Voice service stopped');
    },
  });

  // ── Register Commands ──

  api.registerCommand({
    name: 'join',
    description: 'Join the voice channel you are currently in',
    async execute(ctx) {
      const voiceChannel = ctx.member?.voice?.channel;
      if (!voiceChannel) {
        await ctx.reply('Join a voice channel first.');
        return;
      }
      if (currentChannel?.id === voiceChannel.id && provider?.connected) {
        await ctx.reply(`Already connected to **${voiceChannel.name}**.`);
        return;
      }
      if (provider) await stopVoiceBridge();
      await startVoiceBridge(voiceChannel, config.followUserIds);
      await ctx.reply(`Joined **${voiceChannel.name}**. Voice control active.`);
    },
  });

  api.registerCommand({
    name: 'leave',
    description: 'Leave the current voice channel',
    async execute(ctx) {
      if (!provider) {
        await ctx.reply('Not connected to any voice channel.');
        return;
      }
      await stopVoiceBridge();
      await ctx.reply('Left voice channel.');
    },
  });

  api.registerCommand({
    name: 'say',
    description: 'Send a text message to the voice provider',
    async execute(ctx) {
      const text = ctx.args?.join(' ');
      if (!text) {
        await ctx.reply('Usage: !say <text>');
        return;
      }
      if (!provider?.connected) {
        await ctx.reply('Not connected. Use !join first.');
        return;
      }
      provider.sendText(text);
      await ctx.reply(`Sent: "${text}"`);
    },
  });

  api.registerCommand({
    name: 'voice-status',
    description: 'Show voice bridge status',
    async execute(ctx) {
      const providerStatus = provider?.connected ? 'connected' : 'disconnected';
      const voiceStatus = discordVoice?.connection ? 'connected' : 'disconnected';
      const historyCount = history?.length || 0;
      await ctx.reply(
        `**Discord Realtime Voice**\n` +
        `Discord voice: ${voiceStatus}\n` +
        `Provider: ${config.provider || 'openai-realtime'} (${providerStatus})\n` +
        `Tools: ${realtimeTools.length} loaded\n` +
        `History: ${historyCount} turns this session\n` +
        `Memory: ${memory?.enabled ? 'enabled' : 'disabled'}`
      );
    },
  });

  // ── Register Hook: auto-follow users into voice channels ──

  api.registerHook({
    event: 'voice_state_update',
    description: 'Auto-follow configured users into voice channels',
    async handler(oldState, newState) {
      const followIds = config.followUserIds || [];
      if (!followIds.includes(newState.id)) return;

      const leftChannel = oldState.channel;
      const joinedChannel = newState.channel;

      // User joined or switched voice channels
      if (joinedChannel && joinedChannel.id !== currentChannel?.id) {
        log.info(`Auto-follow: ${newState.member?.displayName || newState.id} joined ${joinedChannel.name}`);
        if (provider) await stopVoiceBridge();
        await startVoiceBridge(joinedChannel, followIds);
      }

      // User left voice entirely
      if (!joinedChannel && leftChannel && leftChannel.id === currentChannel?.id) {
        const followedStillIn = leftChannel.members.some(m => followIds.includes(m.id));
        if (!followedStillIn) {
          log.info(`Auto-follow: ${newState.member?.displayName || newState.id} left voice — disconnecting`);
          await stopVoiceBridge();
        }
      }
    },
  });
});
