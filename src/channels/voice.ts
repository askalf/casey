import type { Channel, ChannelServer, InboundHandler, OutboundMessage, ServerRequest, ServerResponse } from "./types.js";
import { formParams, requestUrl, verifyTwilio, twiml, escapeXml } from "./twilio-common.js";

/**
 * Voice via Twilio — a push channel that runs a spoken conversation with TwiML.
 * An inbound call hits /voice (we greet + gather speech); each speech result hits
 * /voice/gather, where we triage and speak the reply, then gather again. Replies
 * are synchronous (spoken in the TwiML response), so the model call happens inline.
 *
 * Setup: buy a Twilio number, set its Voice webhook to https://<host>/voice.
 *   env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (+ optional TWILIO_PUBLIC_BASE).
 *
 * NOTE: the reply is generated inline, so keep an eye on model latency vs Twilio's
 * webhook timeout for deep troubleshooting turns.
 */
export class VoiceChannel implements Channel {
  readonly name = "voice";
  readonly kind = "push" as const;

  constructor(
    private authToken: string,
    private publicBase?: string,
  ) {}

  register(server: ChannelServer, handle: InboundHandler): void {
    server.route("POST", "/voice", (req) => this.onCall(req));
    server.route("POST", "/voice/gather", (req) => this.onGather(req, handle));
  }

  private check(req: ServerRequest): boolean {
    return verifyTwilio(this.authToken, requestUrl(req, this.publicBase), formParams(req.body), req.headers["x-twilio-signature"] || "");
  }

  private async onCall(req: ServerRequest): Promise<ServerResponse> {
    if (!this.check(req)) return { status: 403, headers: { "content-type": "text/plain" }, body: "bad signature" };
    return twiml(
      `<Response><Gather input="speech" speechTimeout="auto" action="/voice/gather" method="POST">` +
        `<Say>Thanks for calling I.T. support. Please describe your issue after the tone.</Say></Gather>` +
        `<Say>Sorry, I didn't catch that. Please call back. Goodbye.</Say></Response>`,
    );
  }

  private async onGather(req: ServerRequest, handle: InboundHandler): Promise<ServerResponse> {
    if (!this.check(req)) return { status: 403, headers: { "content-type": "text/plain" }, body: "bad signature" };
    const p = formParams(req.body);
    const speech = (p.SpeechResult || "").trim();
    const callSid = p.CallSid || "";
    if (!speech) {
      return twiml(
        `<Response><Gather input="speech" speechTimeout="auto" action="/voice/gather" method="POST">` +
          `<Say>I didn't catch that. Please tell me what you need help with.</Say></Gather></Response>`,
      );
    }
    const out = await handle({ channel: "voice", conversationId: `voice:${callSid}`, from: p.From || callSid, text: speech, ref: callSid, meta: { callSid } });
    const say = escapeXml(out?.text ?? "Sorry, something went wrong on our end. Please try again.");
    return twiml(
      `<Response><Say>${say}</Say>` +
        `<Gather input="speech" speechTimeout="auto" action="/voice/gather" method="POST"><Say>Is there anything else I can help with?</Say></Gather>` +
        `<Say>Thanks for calling. Goodbye.</Say></Response>`,
    );
  }

  // Voice replies synchronously in the TwiML response, so there's nothing to push.
  async reply(_out: OutboundMessage): Promise<void> {}
}
