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
let isStreamingResponse = false;

// ── Discord ready ──

discord.once(Events.ClientReady, async (client) => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  console.log(`[BOT] Provider: ${appConfig.provider} | Tools: ${realtimeTools.length}`);

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
    await message.reply(
      `**OpenClaw Discord Voice Bridge**\n` +
      `Discord voice: ${voiceStatus}\n` +
      `Provider: ${appConfig.provider} ${providerStatus}\n` +
      `Tools: ${realtimeTools.length} loaded\n` +
      `Config: ${configPath}\n` +
      `Tools config: ${toolsPath}`
    );
  }
});

// ── Core: Voice Bridge ──

async function startVoiceBridge(channel) {
  console.log(`[BRIDGE] Starting voice bridge (provider: ${appConfig.provider})...`);

  await discordVoice.join(channel);

  provider = createProvider(appConfig, realtimeTools, executeToolFn);

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

  provider.on('user_transcript', (text) => {
    console.log(`🎤 User: ${text}`);
  });

  provider.on('assistant_transcript', (text) => {
    console.log(`🤖 Assistant: ${text}`);
  });

  provider.on('error', (err) => {
    console.error('[BRIDGE] Provider error:', err.message);
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

process.on('SIGINT', () => {
  console.log('\n[BRIDGE] Shutting down...');
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
