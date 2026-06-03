import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

/** Pull a JSON object out of a model reply, tolerating code fences and prose. */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Ask the model for a structured result as JSON-in-text (not a tool call), so it
 * routes cleanly through dario's Claude-Code wire shape. Validates against a zod
 * schema and retries once on an unparseable reply.
 */
export async function completeJson<T>(
  client: Anthropic,
  model: string,
  system: string,
  userContent: string,
  schema: z.ZodType<T>,
  maxTokens = 2000,
): Promise<T> {
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    const content =
      attempt === 0
        ? userContent
        : `${userContent}\n\n(Your previous reply was not valid JSON. Respond with ONLY the JSON object, nothing else.)`;
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const json = extractJson(text);
    if (json) {
      const parsed = schema.safeParse(json);
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } else {
      lastErr = "no JSON object found in reply";
    }
  }
  throw new Error(`completeJson: could not parse a valid result (${lastErr})`);
}
