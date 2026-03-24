/**
 * OpenClaw Discord Realtime Voice Bridge
 *
 * Bridges Discord voice ↔ a configurable voice provider for sub-500ms (or 1–2s)
 * voice control of any HTTP-accessible service via configurable function calling tools.
 *
 * Supported providers (set via config.json "provider" field):
 *   "openai-realtime" — OpenAI Realtime API (default, ~300–500ms)
 *   "elevenlabs"      — ElevenLabs STT + LLM + TTS (~1–2s, higher quality audio)
 *   "local"           — Fully local pipeline (v2, not yet implemented)
 *
 * Architecture:
 *   Discord Voice Channel (user speaks)
 *     → Opus decode → PCM 24kHz mono
 *     → Voice Provider (STT + reasoning + function calling + TTS)
 *     → Function calls → HTTP to configured endpoints
 *     → Audio response → PCM 24kHz mono
 *     → Upsample → Opus encode → Discord voice channel
 *
 * Usage:
 *   node src/index.js [--config path/to/config.json] [--tools path/to/tools.json]
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DiscordVoice } from './discord-voice.js';
import { createProvider } from './provider.js';
import { loadTools } from './tools.js';
import { ConversationHistory } from './conversation-history.js';
import { VoiceMemory } from './memory.js';
import { OpenClawTools } from './openclaw-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Parse CLI flags ──

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const configPath = getArg('--config') || resolve(ROOT, 'config.json');
const toolsPath  = getArg('--tools')  || resolve(ROOT, 'tools.json');

// ── Load config ──

function loadConfig(path) {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    console.warn(`[CONFIG] No config file found at ${absPath}, using defaults.`);
    return {};
  }
  const raw    = readFileSync(absPath, 'utf8');
  const config = JSON.parse(raw);
  console.log(`[CONFIG] Loaded from ${absPath}`);
  return config;
}

const appConfig = loadConfig(configPath);

// Default provider is "openai-realtime" for backward compatibility
if (!appConfig.provider) {
  appConfig.provider = 'openai-realtime';
}

// ── Load tools ──

let realtimeTools = [];
let executeToolFn = null;

if (existsSync(resolve(toolsPath))) {
  const loaded = loadTools(toolsPath);
  realtimeTools = loaded.tools;
  executeToolFn = loaded.executeTool;
} else {
  console.warn(`[TOOLS] No tools file found at ${toolsPath}. Running without function calling.`);
}

// ── Load OpenClaw native tools ──

const openclawTools = new OpenClawTools(appConfig.openclaw || {});
if (openclawTools.enabled) {
  await openclawTools.probe();
}
const openclawDefs = openclawTools.getToolDefinitions();
const allTools = [...realtimeTools, ...openclawDefs];

console.log(`[TOOLS] ${realtimeTools.length} HTTP tools + ${openclawDefs.length} OpenClaw tools = ${allTools.length} total`);

// Combined executor that routes to the right handler
async function executeAnyTool(toolName, args) {
  if (toolName.startsWith('openclaw_')) {
    return openclawTools.executeTool(toolName, args);
  }
  if (executeToolFn) {
    return executeToolFn(toolName, args);
  }
  return JSON.stringify({ error: `No executor for tool: ${toolName}` });
}

// ── Memory ──

const memory = new VoiceMemory(appConfig.memory);

// ── Validate environment ──

const DISCORD_TOKEN    = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID         = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const LISTEN_USER_ID   = process.env.DISCORD_LISTEN_USER_ID;

if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN not set. See .env.example');
  process.exit(1);
}

// Provider-specific required env vars are checked inside each provider's connect()

// ── Discord client ──

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const discordVoice = new DiscordVoice();
let provider = null;
let history = null;
let currentChannel = null;
let sessionStartTime = null;
let isStreamingResponse = false;

// ── Save transcript helper ──

async function saveSessionTranscript() {
  if (memory.enabled && history && history.length > 0) {
    const sessionMetadata = {
      channelName: currentChannel?.name || 'voice',
      guildName: currentChannel?.guild?.name || 'unknown',
      startTime: sessionStartTime,
      provider: appConfig.provider,
    };
    await memory.saveTranscript(history, sessionMetadata);
  }
}

// ── Discord ready ──

discord.once(Events.ClientReady, async (client) => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  console.log(`[BOT] Provider: ${appConfig.provider} | Tools: ${allTools.length}`);

  if (VOICE_CHANNEL_ID && GUILD_ID) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (guild) {
      const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
      if (channel?.isVoiceBased()) {
        await startVoiceBridge(channel);
      } else {
        console.error(`❌ Voice channel ${VOICE_CHANNEL_ID} not found in guild ${GUILD_ID}`);
      }
    }
  } else {
    console.log('[BOT] No auto-join configured. Use !join in a text channel while in a voice channel.');
  }
});

// ── Text commands ──

discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content === '!join') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      await message.reply('Join a voice channel first.');
      return;
    }
    await startVoiceBridge(voiceChannel);
    await message.reply(`🎙️ Joined **${voiceChannel.name}**. Voice control active.`);
  }

  if (message.content === '!leave') {
    await saveSessionTranscript();
    discordVoice.leave();
    provider?.disconnect();
    provider = null;
    await message.reply('👋 Left voice channel.');
  }

  if (message.content.startsWith('!say ')) {
    const text = message.content.slice(5);
    if (provider) {
      provider.sendText(text);
      await message.reply(`📝 Sent: "${text}"`);
    } else {
      await message.reply('Not connected. Use !join first.');
    }
  }

  if (message.content === '!status') {
    const providerStatus = provider?.connected ? '✅' : '❌';
    const voiceStatus    = discordVoice.connection ? '✅' : '❌';
    const historyCount   = history?.length || 0;
    const openclawStatus = openclawTools.enabled ? (openclawTools.useGateway ? '✅ Gateway' : '⚠️ CLI fallback') : '❌ Disabled';
    await message.reply(
      `**OpenClaw Discord Voice Bridge**\n` +
      `Discord voice: ${voiceStatus}\n` +
      `Provider: ${appConfig.provider} ${providerStatus}\n` +
      `Tools: ${allTools.length} loaded (${realtimeTools.length} HTTP + ${openclawDefs.length} OpenClaw)\n` +
      `OpenClaw: ${openclawStatus}\n` +
      `History: ${historyCount} turns this session\n` +
      `Memory: ${memory?.enabled ? '✅' : '❌'}`
    );
  }
});

// ── Core: Voice Bridge ──

async function startVoiceBridge(channel) {
  console.log(`[BRIDGE] Starting voice bridge (provider: ${appConfig.provider})...`);

  currentChannel = channel;
  sessionStartTime = new Date().toISOString();

  await discordVoice.join(channel);

  // ── Conversation history ──
  history = new ConversationHistory(appConfig.history?.maxTurns || 50);

  // ── Load previous session context ──
  let previousContext = '';
  if (memory.enabled) {
    previousContext = await memory.loadPreviousContext();
    if (previousContext) {
      console.log(`[memory] Loaded context from ${memory.loadPreviousSessions} previous sessions`);
    }
  }

  // ── Build enriched system prompt ──
  let systemPrompt = appConfig.systemPrompt || 'You are a voice assistant. Be concise.';

  if (previousContext) {
    systemPrompt += '\n\nYou have memory of previous voice conversations:\n' + previousContext;
    systemPrompt += '\n\nUse this context naturally. If the user references something from a previous conversation, you can recall it.';
  }

  if (openclawTools.enabled && openclawDefs.length > 0) {
    systemPrompt += '\n\nYou have access to OpenClaw system tools. You can run shell commands, search your memory for past conversations, send messages to people on various platforms, set reminders, search the web, read files, and interact with GitHub — all by voice. When executing a tool, briefly confirm what you\'re doing before the result comes back. Keep responses concise and conversational.';
  }

  // Override config systemPrompt for this session
  const sessionConfig = { ...appConfig, systemPrompt };
  provider = createProvider(sessionConfig, allTools, executeAnyTool, history);

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

  // Deduplicated history recording at the bridge level (safety net)
  provider.on('user_transcript', (text) => {
    console.log(`🎤 User: ${text}`);
    if (!history.turns.length || history.turns[history.turns.length - 1].content !== text) {
      history.addUserTurn(text);
    }
  });

  provider.on('assistant_transcript', (text) => {
    console.log(`🤖 Assistant: ${text}`);
    if (!history.turns.length || history.turns[history.turns.length - 1].content !== text) {
      history.addAssistantTurn(text);
    }
  });

  provider.on('error', (err) => {
    console.error('[BRIDGE] Provider error:', err.message);
  });

  provider.on('disconnected', async () => {
    console.log('[BRIDGE] Provider disconnected unexpectedly');
    await saveSessionTranscript();
  });

  provider.connect();

  provider.once('ready', () => {
    if (LISTEN_USER_ID) {
      discordVoice.listenTo(LISTEN_USER_ID);
    } else {
      discordVoice.listenToAll();
    }
    console.log('[BRIDGE] ✅ Voice bridge active.');
  });
}

// ── Graceful shutdown ──

process.on('SIGINT', async () => {
  console.log('\n[BRIDGE] Shutting down...');
  await saveSessionTranscript();
  discordVoice.leave();
  provider?.disconnect();
  discord.destroy();
  process.exit(0);
});

// ── Start ──

console.log('🎙️ OpenClaw Discord Voice Bridge starting...');
console.log(`   Provider: ${appConfig.provider}`);
console.log(`   Config:   ${configPath}`);
console.log(`   Tools:    ${toolsPath}`);
discord.login(DISCORD_TOKEN);
