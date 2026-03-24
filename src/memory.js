/**
 * VoiceMemory — transcript persistence and cross-session context.
 *
 * Saves conversation transcripts as markdown files after each voice session.
 * Loads previous session context on reconnect so the agent remembers past conversations.
 */

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

export class VoiceMemory {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.transcriptDir = resolveHome(config.transcriptDir || '~/.openclaw/workspace/memory/voice');
    this.loadPreviousSessions = config.loadPreviousSessions ?? 3;
    this.maxContextTurns = config.maxContextTurns ?? 10;
  }

  /**
   * Save the current session's conversation history to a markdown file.
   * Call on disconnect/leave/SIGINT.
   */
  async saveTranscript(history, metadata = {}) {
    if (!this.enabled) return;
    if (!history || history.length === 0) return;

    const turns = history.getTurns();
    if (turns.length === 0) return;

    // Ensure directory exists
    await mkdir(this.transcriptDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);  // YYYY-MM-DD
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');  // HHmm
    const channelSlug = (metadata.channelName || 'voice').replace(/[^a-zA-Z0-9-]/g, '-');
    const filename = `${dateStr}-${timeStr}-${channelSlug}.md`;
    const filepath = join(this.transcriptDir, filename);

    // Build markdown content
    let md = `# Voice Session — ${dateStr} ${now.toTimeString().slice(0, 5)} — #${metadata.channelName || 'voice'}\n`;
    md += `Provider: ${metadata.provider || 'unknown'}`;
    if (metadata.startTime) {
      const durationMs = now.getTime() - new Date(metadata.startTime).getTime();
      const durationMin = Math.round(durationMs / 60000);
      md += ` | Duration: ${durationMin} minutes`;
    }
    md += ` | Turns: ${turns.length}\n\n`;

    for (const turn of turns) {
      const time = new Date(turn.timestamp).toTimeString().slice(0, 8);
      if (turn.role === 'user') {
        md += `**User** (${time}): ${turn.content}\n\n`;
      } else if (turn.role === 'assistant') {
        md += `**Assistant** (${time}): ${turn.content}\n\n`;
      } else if (turn.role === 'tool') {
        md += `**Tool** (${time}): ${turn.toolName} → ${turn.content.slice(0, 500)}\n\n`;
      }
    }

    await writeFile(filepath, md, 'utf8');
    console.log(`[memory] Transcript saved: ${filepath} (${turns.length} turns)`);
    return filepath;
  }

  /**
   * Load recent voice transcripts and return a context summary string
   * for injection into the system prompt.
   */
  async loadPreviousContext() {
    if (!this.enabled) return '';
    if (!existsSync(this.transcriptDir)) return '';

    try {
      const files = await readdir(this.transcriptDir);
      const mdFiles = files
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, this.loadPreviousSessions);

      if (mdFiles.length === 0) return '';

      let context = '';
      for (const file of mdFiles.reverse()) {  // Oldest first
        const content = await readFile(join(this.transcriptDir, file), 'utf8');
        // Extract just the conversation turns, limited
        const lines = content.split('\n').filter(l => l.startsWith('**User**') || l.startsWith('**Assistant**'));
        const recent = lines.slice(-this.maxContextTurns);
        if (recent.length > 0) {
          context += `\n--- Previous session (${file.slice(0, 10)}) ---\n`;
          context += recent.join('\n') + '\n';
        }
      }

      return context.trim();
    } catch (err) {
      console.error('[memory] Error loading previous context:', err.message);
      return '';
    }
  }

  /**
   * Try to search OpenClaw agent memory via gateway API.
   * Best-effort — returns empty string on any failure.
   */
  async searchOpenClawMemory(query, gatewayUrl, gatewayToken) {
    if (!gatewayUrl) return '';
    try {
      const res = await fetch(`${gatewayUrl}/api/tools-invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(gatewayToken ? { 'Authorization': `Bearer ${gatewayToken}` } : {}),
        },
        body: JSON.stringify({ tool: 'memory_search', params: { query } }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return typeof data.result === 'string' ? data.result : JSON.stringify(data.result || '');
    } catch {
      return '';
    }
  }
}

function resolveHome(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}
