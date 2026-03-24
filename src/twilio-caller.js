/**
 * Make outbound calls via Twilio REST API.
 * The call connects to the same Media Stream WebSocket as inbound calls.
 *
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 */

export class TwilioCaller {
  constructor(config = {}) {
    this.accountSid = config.accountSid || process.env.TWILIO_ACCOUNT_SID;
    this.authToken = config.authToken || process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = config.fromNumber || process.env.TWILIO_PHONE_NUMBER;
    this.publicUrl = config.publicUrl;  // Your server's public URL
  }

  /**
   * Initiate an outbound call.
   * @param {string} to — Phone number to call (E.164 format: +15551234567)
   * @param {string} greeting — Optional greeting before stream starts
   * @returns {Promise<{ callSid: string }>}
   */
  async call(to, greeting) {
    if (!this.accountSid || !this.authToken) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required for outbound calls');
    }

    const wsUrl = `${this.publicUrl}/stream`;

    let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';
    if (greeting) {
      twiml += `<Say>${greeting}</Say><Pause length="1"/>`;
    }
    twiml += `<Connect><Stream url="${wsUrl}"/></Connect></Response>`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Calls.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const body = new URLSearchParams({
      To: to,
      From: this.fromNumber,
      Twiml: twiml,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Twilio call failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    console.log(`[twilio-caller] Outbound call initiated: ${data.sid} → ${to}`);
    return { callSid: data.sid };
  }
}
