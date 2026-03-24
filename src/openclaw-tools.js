/**
 * OpenClaw Native Tool Bridge
 *
 * Provides 8 tools that let the voice agent control the OpenClaw ecosystem:
 * exec, memory, message, reminder, status, web_search, read_file, github.
 *
 * Routes through the OpenClaw gateway API when available, falls back to CLI.
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCb);

/**
 * Resolve "env:VAR_NAME" to process.env value.
 */
function resolveEnv(val) {
  if (typeof val === 'string' && val.startsWith('env:')) {
    return process.env[val.slice(4)];
  }
  return val;
}

const TOOL_DEFINITIONS = {
  exec: {
    name: 'openclaw_run_command',
    description: 'Execute a shell command on the host machine. Use for quick system tasks like checking disk space, listing files, running scripts, or any CLI operation. Return the command output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute (e.g. "ls -la", "df -h", "docker ps")' }
      },
      required: ['command']
    }
  },
  memory: {
    name: 'openclaw_search_memory',
    description: "Search the agent's long-term memory for information about past conversations, decisions, preferences, people, or stored facts. Use when the user asks 'do you remember...', 'what did we discuss about...', or needs context from previous interactions.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query describing what to find in memory' }
      },
      required: ['query']
    }
  },
  message: {
    name: 'openclaw_send_message',
    description: 'Send a text message to a person or channel via OpenClaw messaging (WhatsApp, Telegram, Discord, Signal, etc.). Use when asked to message someone, send an update, or notify a channel.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Who to send to: a channel name like "#general", a person name, phone number, or channel ID' },
        message: { type: 'string', description: 'The message text to send' }
      },
      required: ['target', 'message']
    }
  },
  reminder: {
    name: 'openclaw_set_reminder',
    description: 'Set a reminder or scheduled task. Creates a cron job that will fire at the specified time with the given message. Use when asked to remind about something later.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to be reminded about' },
        time: { type: 'string', description: 'When to fire the reminder: ISO timestamp, relative time like "in 30 minutes", "at 5pm", "tomorrow 9am"' }
      },
      required: ['text', 'time']
    }
  },
  status: {
    name: 'openclaw_check_status',
    description: 'Check the status of the OpenClaw system including gateway health, active sessions, connected channels, and model info. Use when asked about system status or diagnostics.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  web_search: {
    name: 'openclaw_web_search',
    description: 'Search the web for current information. Use when the user asks about recent events, needs to look something up, or wants real-time data that might not be in memory.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  read_file: {
    name: 'openclaw_read_file',
    description: 'Read a file from the workspace or filesystem. Use when asked to check a file, read notes, or look at configuration.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read (relative to workspace or absolute)' }
      },
      required: ['path']
    }
  },
  github: {
    name: 'openclaw_github',
    description: 'Run GitHub CLI operations. Check PRs, issues, CI status, create issues, review code. Use when asked about GitHub, pull requests, issues, or repository status.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The gh CLI command to run (without the "gh" prefix). Examples: "pr list", "issue list --limit 5", "pr status", "repo view"' }
      },
      required: ['command']
    }
  }
};

export class OpenClawTools {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.gatewayUrl = config.gatewayUrl || 'http://localhost:3578';
    this.gatewayToken = resolveEnv(config.gatewayToken);
    this.enabledTools = new Set(config.tools || ['exec', 'memory', 'message', 'reminder', 'status', 'web_search', 'read_file', 'github']);
    this.useGateway = false;  // Set after probing
    this.fallbackToCli = true;
    this.execTimeoutMs = 30000;
  }

  /**
   * Probe whether the OpenClaw gateway API is reachable.
   * Call once on startup.
   */
  async probe() {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${this.gatewayUrl}/api/status`, {
        signal: AbortSignal.timeout(3000),
        headers: this.gatewayToken ? { 'Authorization': `Bearer ${this.gatewayToken}` } : {},
      });
      if (res.ok) {
        this.useGateway = true;
        console.log(`[openclaw-tools] Gateway API reachable at ${this.gatewayUrl}`);
      } else {
        console.log(`[openclaw-tools] Gateway returned ${res.status}, falling back to CLI`);
      }
    } catch (err) {
      console.log(`[openclaw-tools] Gateway not reachable (${err.message}), falling back to CLI`);
    }
  }

  /**
   * Return OpenAI-format tool definitions for all enabled OpenClaw tools.
   */
  getToolDefinitions() {
    if (!this.enabled) return [];
    return Object.entries(TOOL_DEFINITIONS)
      .filter(([key]) => this.enabledTools.has(key))
      .map(([, def]) => ({
        type: 'function',
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      }));
  }

  /**
   * Execute an OpenClaw tool by name.
   * Routes through gateway API if available, falls back to CLI.
   */
  async executeTool(name, args) {
    if (!this.enabled) return JSON.stringify({ error: 'OpenClaw tools disabled' });

    console.log(`[openclaw-tools] ${name}(${JSON.stringify(args)})`);

    try {
      switch (name) {
        case 'openclaw_run_command':
          return await this._execCommand(args.command);

        case 'openclaw_search_memory':
          return await this._invokeGatewayTool('memory_search', { query: args.query })
            || await this._cliFallback(`search memory for: ${args.query}`);

        case 'openclaw_send_message':
          return await this._invokeGatewayTool('message', { action: 'send', target: args.target, message: args.message })
            || await this._cliFallback(`send a message to ${args.target} saying: ${args.message}`);

        case 'openclaw_set_reminder':
          return await this._cliFallback(`set a reminder: "${args.text}" at ${args.time}`);

        case 'openclaw_check_status':
          return await this._execCommand('openclaw status --json 2>/dev/null || openclaw status');

        case 'openclaw_web_search':
          return await this._invokeGatewayTool('web_search', { query: args.query })
            || await this._cliFallback(`search the web for: ${args.query}`);

        case 'openclaw_read_file':
          return await this._execCommand(`cat "${args.path}" 2>&1 | head -100`);

        case 'openclaw_github':
          return await this._execCommand(`gh ${args.command} 2>&1`);

        default:
          return JSON.stringify({ error: `Unknown OpenClaw tool: ${name}` });
      }
    } catch (err) {
      console.error(`[openclaw-tools] ${name} failed:`, err.message);
      return JSON.stringify({ error: err.message });
    }
  }

  /**
   * Call a tool via the OpenClaw gateway tools-invoke HTTP API.
   * Returns result string or null if gateway is unavailable.
   */
  async _invokeGatewayTool(tool, params) {
    if (!this.useGateway) return null;
    try {
      const res = await fetch(`${this.gatewayUrl}/api/tools-invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.gatewayToken ? { 'Authorization': `Bearer ${this.gatewayToken}` } : {}),
        },
        body: JSON.stringify({ tool, params }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const result = data.result || data;
      return JSON.stringify(typeof result === 'string' ? { result } : result);
    } catch {
      return null;
    }
  }

  /**
   * Fallback: send a natural language instruction to the OpenClaw agent via CLI.
   */
  async _cliFallback(instruction) {
    if (!this.fallbackToCli) return JSON.stringify({ error: 'Gateway unavailable and CLI fallback disabled' });
    return this._execCommand(`openclaw agent --message "${instruction.replace(/"/g, '\\"')}" 2>&1`, 30000);
  }

  /**
   * Execute a shell command and return stdout.
   */
  async _execCommand(command, timeout) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeout || this.execTimeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      });
      const output = (stdout || stderr || '').trim();
      console.log(`[openclaw-tools] exec result: ${output.slice(0, 200)}`);
      return JSON.stringify({ output: output || 'Command completed with no output' });
    } catch (err) {
      return JSON.stringify({ error: err.message, output: err.stdout?.trim() || err.stderr?.trim() || '' });
    }
  }
}
