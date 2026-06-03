import type { Channel, ChannelServer, InboundHandler, OutboundMessage, ServerRequest, ServerResponse } from "./types.js";
import { formParams, requestUrl, verifyTwilio, twiml } from "./twilio-common.js";

/**
 * SMS via Twilio — a push channel. Twilio POSTs inbound texts to /sms; we verify
 * the X-Twilio-Signature, ack with empty TwiML, then triage and reply out-of-band
 * via the Messaging REST API (robust against the webhook timeout).
 *
 * Setup: buy a Twilio number, set its Messaging webhook to https://<host>/sms.
 *   env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER (the From), and
 *        optionally TWILIO_PUBLIC_BASE if signature URL reconstruction needs help.
 */
export class SmsChannel implements Channel {
  readonly name = "sms";
  readonly kind = "push" as const;

  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string,
    private publicBase?: string,
  ) {}

  register(server: ChannelServer, handle: InboundHandler): void {
    server.route("POST", "/sms", (req) => this.onSms(req, handle));
  }

  private async onSms(req: ServerRequest, handle: InboundHandler): Promise<ServerResponse> {
    const params = formParams(req.body);
    const sig = req.headers["x-twilio-signature"] || "";
    if (!verifyTwilio(this.authToken, requestUrl(req, this.publicBase), params, sig)) {
      return { status: 403, headers: { "content-type": "text/plain" }, body: "bad signature" };
    }
    const from = params.From;
    const body = (params.Body || "").trim();
    if (from && body) {
      const msg = { channel: "sms", conversationId: `sms:${from}`, from, text: body, ref: from, meta: { from } };
      void handle(msg)
        .then((out) => (out ? this.reply(out) : undefined))
        .catch((e) => console.error(`sms: handle failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    return twiml("<Response></Response>"); // ack; the reply is sent async via REST
  }

  async reply(out: OutboundMessage): Promise<void> {
    const to = (out.meta?.from as string | undefined) ?? out.conversationId.split(":")[1];
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: this.fromNumber, To: to, Body: out.text }).toString(),
    });
    if (!res.ok) throw new Error(`twilio sms send failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}
