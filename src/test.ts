import { parseTicket } from "./ticket.js";
import { triageSchema } from "./triage.js";

interface Case {
  name: string;
  pass: boolean;
  detail?: string;
}
const cases: Case[] = [];
const check = (name: string, pass: boolean, detail?: string): void => {
  cases.push({ name, pass, detail });
};

function parseTests(): void {
  const j = parseTicket('{"from":"a@b.com","subject":"VPN down","body":"cannot connect"}');
  check("parse: JSON ticket", j.from === "a@b.com" && j.subject === "VPN down" && j.body === "cannot connect", JSON.stringify(j));

  const e = parseTicket("From: jane@acme.com\nSubject: printer jammed\n\nThe printer on the 3rd floor won't print.");
  check(
    "parse: plain email headers + body",
    e.from === "jane@acme.com" && e.subject === "printer jammed" && /3rd floor/.test(e.body),
    JSON.stringify(e),
  );

  const b = parseTicket("My laptop won't turn on at all.");
  check("parse: body-only fallback", b.subject === "(no subject)" && /laptop/.test(b.body), JSON.stringify(b));
}

function schemaTests(): void {
  const ok = triageSchema.safeParse({
    category: "network",
    priority: "P2",
    tier: 3,
    summary: "VPN won't connect",
    missing_info: [],
    action: "escalate",
    client_reply: "We're on it.",
    escalation_brief: "diagnose VPN",
  });
  check("schema: valid triage parses", ok.success, ok.success ? undefined : JSON.stringify(ok.error.issues));

  const bad = triageSchema.safeParse({
    category: "nope",
    priority: "P9",
    tier: 5,
    summary: "x",
    missing_info: [],
    action: "explode",
    client_reply: "",
  });
  check("schema: invalid triage rejected", !bad.success, bad.success ? "should have failed" : undefined);
}

function main(): void {
  parseTests();
  schemaTests();
  console.log("\n" + "=".repeat(60));
  console.log("CASEY TESTS");
  console.log("=".repeat(60));
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    console.log(`[${c.pass ? "PASS" : "FAIL"}] ${c.name}${c.detail ? " — " + c.detail : ""}`);
    if (c.pass) passed++;
    else failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed (${cases.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
