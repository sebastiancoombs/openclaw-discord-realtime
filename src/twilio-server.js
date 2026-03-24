/**
 * Twilio webhook + WebSocket server.
 *
 * Two endpoints:
 *   POST /voice       — Twilio calls this when a call comes in. Returns TwiML.
 *   WebSocket /stream  — Twilio connects here for bidirectional Media Stream.
 *
 * Config:
 *   port: HTTP server port (default: 8080)
 *   publicUrl: Your server's public URL (for TwiML <Stream> url)
 *   greeting: Optional greeting message spoken before the stream starts
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { TwilioTransport } from './twilio-transport.js';

export class TwilioServer {
  constructor(config = {}) {
    this.port = config.port || 8080;
    this.publicUrl = config.publicUrl;  // e.g. "wss://your-domain.com"
    this.greeting = config.greeting || null;
    this.transport = null;
    this.server = null;
    this.wss = null;

    // Callback set by index.js to wire up a new call
    this.onNewCall = null;
  }

  start() {
    this.server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/voice') {
        this._handleVoiceWebhook(req, res);
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // WebSocket server for media streams
    this.wss = new WebSocketServer({ server: this.server, path: '/stream' });

    this.wss.on('connection', (ws) => {
      console.log('[twilio-server] New Media Stream WebSocket connection');
      this.transport = new TwilioTransport();
      this.transport.handleConnection(ws);

      // Notify index.js that a new call is ready
      if (this.onNewCall) {
        this.transport.once('call_start', (callInfo) => {
          this.onNewCall(this.transport, callInfo);
        });
      }
    });

    this.server.listen(this.port, () => {
      console.log(`[twilio-server] Listening on port ${this.port}`);
      console.log(`[twilio-server] Voice webhook: http://localhost:${this.port}/voice`);
      console.log(`[twilio-server] Media stream: ws://localhost:${this.port}/stream`);
    });
  }

  /**
   * Handle Twilio's voice webhook. Returns TwiML that:
   * 1. Optionally says a greeting
   * 2. Connects to a bidirectional Media Stream
   */
  _handleVoiceWebhook(req, res) {
    // Parse form body (Twilio sends application/x-www-form-urlencoded)
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const from = params.get('From') || 'unknown';
      const to = params.get('To') || 'unknown';
      const callSid = params.get('CallSid') || 'unknown';

      console.log(`[twilio-server] Incoming call: ${from} → ${to} (${callSid})`);

      // Determine WebSocket URL for the stream
      const wsUrl = this.publicUrl
        ? `${this.publicUrl}/stream`
        : `wss://${req.headers.host}/stream`;

      // Build TwiML response
      let twiml = '<?xml version="1.0" encoding="UTF-8"?>';
      twiml += '<Response>';

      if (this.greeting) {
        twiml += `<Say>${this.greeting}</Say>`;
        twiml += '<Pause length="1"/>';
      }

      twiml += '<Connect>';
      twiml += `<Stream url="${wsUrl}">`;
      twiml += `<Parameter name="from" value="${from}"/>`;
      twiml += `<Parameter name="to" value="${to}"/>`;
      twiml += '</Stream>';
      twiml += '</Connect>';
      twiml += '</Response>';

      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml);
    });
  }

  stop() {
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }
}
