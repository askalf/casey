import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Graduation = how T2 phases out. When a remediation pattern has been approved
 * by humans enough times, it earns trust and can be "promoted" so Arnie runs it
 * automatically (no sign-off). This stores the operator's promotions; the
 * approval counts themselves are computed from the ticket log. Arnie will consult
 * promotions once execute-on-approval ships.
 *
 * Pattern key is the triage category for now (a placeholder until Arnie emits
 * structured remediation signatures).
 */
export interface Promotion {
  key: string;
  auto: boolean;
  by?: string;
  at: string;
}

export async function loadPromotions(store: string): Promise<Promotion[]> {
  try {
    const raw = await fsp.readFile(store, "utf8");
    const byKey = new Map<string, Promotion>();
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const p = JSON.parse(line) as Promotion;
        byKey.set(p.key, p);
      } catch {
        /* skip a corrupt line */
      }
    }
    return [...byKey.values()];
  } catch {
    return [];
  }
}

export async function savePromotion(store: string, p: Promotion): Promise<void> {
  await fsp.mkdir(path.dirname(store), { recursive: true }).catch(() => {});
  await fsp.appendFile(store, JSON.stringify(p) + "\n", "utf8");
}
