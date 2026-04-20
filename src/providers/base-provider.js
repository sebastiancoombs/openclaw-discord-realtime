import { EventEmitter } from 'events';

export class BaseVoiceProvider extends EventEmitter {
  constructor(config = {}, tools = [], executeTool = null) {
    super();
    this.config = config;
    this.tools = tools;
    this.executeTool = executeTool;
  }

  connect() { throw new Error('Not implemented'); }
  sendAudio(_pcmBuffer) { throw new Error('Not implemented'); }
  sendText(_text) { throw new Error('Not implemented'); }
  disconnect() { throw new Error('Not implemented'); }
  get connected() { return false; }
}
