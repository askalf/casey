import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerRequest, ServerResponse } from "./types.js";

/** Parse an application/x-www-form-urlencoded body (Twilio webhooks) into a map. */
export function formParams(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

/**
 * Reconstruct the public URL Twilio signed. Behind a proxy/tunnel, prefer the
 * x-forwarded-* headers; an explicit base (TWILIO_PUBLIC_BASE) overrides both.
 */
export function requestUrl(req: ServerRequest, publicBase?: string): string {
  if (publicBase) return publicBase.replace(/\/$/, "") + req.path;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  return `${proto}://${host}${req.path}`;
}

/**
 * Validate Twilio's X-Twilio-Signature for a form POST: HMAC-SHA1 (base64) of the
 * URL followed by each param's key+value sorted by key, keyed by the auth token.
 */
export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch
  }
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap a TwiML <Response> body in a proper XML response. */
export function twiml(responseBody: string): ServerResponse {
  return {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: `<?xml version="1.0" encoding="UTF-8"?>${responseBody}`,
  };
}
