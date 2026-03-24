/**
 * Generic tool loader and executor for OpenClaw Discord Realtime.
 *
 * Loads tool definitions from a JSON config file, converts them to
 * OpenAI Realtime API format, and executes them via HTTP endpoints.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Load tools from a JSON config file.
 * @param {string} toolsPath - Path to tools.json
 * @returns {{ tools: object[], executeTool: Function }}
 */
export function loadTools(toolsPath) {
  const absPath = resolve(toolsPath);
  const raw = readFileSync(absPath, 'utf8');
  const config = JSON.parse(raw);

  if (!config.tools || !Array.isArray(config.tools)) {
    throw new Error(`Invalid tools config: expected { tools: [...] } in ${toolsPath}`);
  }

  // Convert JSON tool configs → OpenAI Realtime API format
  const realtimeTools = config.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  // Build endpoint map: name → { method, url, defaults }
  const endpointMap = {};
  for (const tool of config.tools) {
    endpointMap[tool.name] = {
      method: tool.endpoint.method,
      url: tool.endpoint.url,
      defaults: tool.defaults || {},
    };
  }

  /**
   * Execute a tool by calling its configured HTTP endpoint.
   * @param {string} toolName - Tool name from the Realtime API
   * @param {object} args - Parsed arguments from the model
   * @returns {Promise<string>} JSON string result
   */
  async function executeTool(toolName, args) {
    const endpoint = endpointMap[toolName];
    if (!endpoint) {
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }

    // Apply defaults for missing args
    const mergedArgs = { ...endpoint.defaults, ...args };

    console.log(`[TOOL] ${toolName}(${JSON.stringify(mergedArgs)}) -> ${endpoint.method} ${endpoint.url}`);

    try {
      const opts = {
        method: endpoint.method,
        headers: { 'Content-Type': 'application/json' },
      };

      if (endpoint.method !== 'GET' && endpoint.method !== 'HEAD') {
        opts.body = JSON.stringify(mergedArgs);
      }

      const res = await fetch(endpoint.url, opts);
      const data = await res.json();
      console.log(`[TOOL] ${toolName} -> ${res.status}`, JSON.stringify(data).slice(0, 200));
      return JSON.stringify(data);
    } catch (err) {
      console.error(`[TOOL] ${toolName} FAILED:`, err.message);
      return JSON.stringify({ error: err.message });
    }
  }

  console.log(`[TOOLS] Loaded ${realtimeTools.length} tools from ${absPath}`);

  return { tools: realtimeTools, executeTool };
}
