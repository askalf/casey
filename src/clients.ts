import fsp from "node:fs/promises";
import path from "node:path";

/**
 * The MSP's clients and their assets — the "this client, this machine" context
 * an MSP ticket needs (and that Arnie's reach-to-remediate will hang off).
 * Native source of truth for now (append-only JSONL, dedupe-by-id last-write-wins,
 * same shape as the ticket store); an RMM/PSA sync can layer on later.
 */
export interface Asset {
  id: string;
  name: string; // hostname / label
  type?: string; // workstation | server | network | printer | other
}

export interface Client {
  id: string;
  name: string;
  created_at: string;
  /** Email domain, so intake from someone@acme.com can auto-match this client. */
  domain?: string;
  assets: Asset[];
}

function uid(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

export function newClient(name: string, domain?: string): Client {
  return { id: uid("cli"), name, created_at: new Date().toISOString(), domain, assets: [] };
}

export function newAsset(name: string, type?: string): Asset {
  return { id: uid("ast"), name, type };
}

export async function loadClients(store: string): Promise<Client[]> {
  try {
    const raw = await fsp.readFile(store, "utf8");
    const byId = new Map<string, Client>();
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const c = JSON.parse(line) as Client;
        byId.set(c.id, c);
      } catch {
        /* skip a corrupt line */
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

export async function saveClient(store: string, c: Client): Promise<void> {
  await fsp.mkdir(path.dirname(store), { recursive: true }).catch(() => {});
  await fsp.appendFile(store, JSON.stringify(c) + "\n", "utf8");
}

/** Best-effort auto-match a sender like someone@acme.com to a client by domain. */
export function matchClientByEmail(clients: Client[], from: string): Client | undefined {
  const at = from.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = from.slice(at + 1).toLowerCase();
  if (!domain) return undefined;
  return clients.find((c) => c.domain && c.domain.toLowerCase() === domain);
}
