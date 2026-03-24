/**
 * Shared conversation history manager for all voice providers.
 *
 * Stores turns in a normalized format and provides adapters for
 * OpenAI Chat Completions, Anthropic Messages API, and plain-text context.
 */

export class ConversationHistory {
  constructor(maxTurns = 50) {
    this.turns = [];
    // Each turn: { role: 'user'|'assistant'|'tool', content: string, timestamp: ISO string, toolName?: string, toolArgs?: object }
    this.maxTurns = maxTurns;
  }

  addUserTurn(text) {
    this.turns.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    this._trim();
  }

  addAssistantTurn(text) {
    this.turns.push({ role: 'assistant', content: text, timestamp: new Date().toISOString() });
    this._trim();
  }

  addToolResult(toolName, args, result) {
    this.turns.push({
      role: 'tool',
      content: result,
      toolName,
      toolArgs: args,
      timestamp: new Date().toISOString(),
    });
    this._trim();
  }

  /**
   * Return OpenAI Chat Completions format messages array.
   * Filters out 'tool' turns — they're context for the assistant but not separate messages.
   */
  toOpenAIMessages() {
    return this.turns
      .filter(t => t.role === 'user' || t.role === 'assistant')
      .map(t => ({ role: t.role, content: t.content }));
  }

  /**
   * Return Anthropic Messages API format.
   * Anthropic requires strict user/assistant alternation — merge consecutive same-role turns.
   */
  toAnthropicMessages() {
    const merged = [];
    for (const turn of this.turns.filter(t => t.role === 'user' || t.role === 'assistant')) {
      const last = merged[merged.length - 1];
      if (last && last.role === turn.role) {
        last.content += '\n' + turn.content;
      } else {
        merged.push({ role: turn.role, content: turn.content });
      }
    }
    return merged;
  }

  /**
   * Human-readable string for system prompt injection or context summary.
   */
  toContextString(maxTurns = 10) {
    return this.turns.slice(-maxTurns).map(t => {
      if (t.role === 'user') return `User: ${t.content}`;
      if (t.role === 'assistant') return `Assistant: ${t.content}`;
      if (t.role === 'tool') return `[Tool ${t.toolName}: ${t.content.slice(0, 200)}]`;
      return '';
    }).join('\n');
  }

  getTurns() { return [...this.turns]; }
  get length() { return this.turns.length; }
  clear() { this.turns = []; }

  _trim() {
    if (this.turns.length > this.maxTurns) {
      this.turns = this.turns.slice(-this.maxTurns);
    }
  }
}
