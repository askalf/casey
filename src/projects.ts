import fsp from "node:fs/promises";
import path from "node:path";

/**
 * The Project work-item — the *planned* side of an MSP (onboardings, migrations,
 * rollouts), as opposed to reactive Service tickets. Human-run ticketing +
 * management only for now (no AI execution); a work breakdown of tasks under a
 * project. Same JSONL / dedupe-by-id store pattern as tickets + clients.
 */
export type ProjectStatus = "planning" | "active" | "on_hold" | "done";
export type TaskStatus = "todo" | "doing" | "done";

export interface ProjectTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignee?: string;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  clientId?: string;
  dueDate?: string;
  tasks: ProjectTask[];
}

function uid(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
}

export function newProject(name: string, clientId?: string, dueDate?: string): Project {
  const now = new Date().toISOString();
  return { id: uid("prj"), name, status: "planning", created_at: now, updated_at: now, clientId, dueDate, tasks: [] };
}

export function newTask(title: string): ProjectTask {
  return { id: uid("tsk"), title, status: "todo" };
}

export async function loadProjects(store: string): Promise<Project[]> {
  try {
    const raw = await fsp.readFile(store, "utf8");
    const byId = new Map<string, Project>();
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const p = JSON.parse(line) as Project;
        byId.set(p.id, p);
      } catch {
        /* skip a corrupt line */
      }
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

export async function saveProject(store: string, p: Project): Promise<void> {
  await fsp.mkdir(path.dirname(store), { recursive: true }).catch(() => {});
  await fsp.appendFile(store, JSON.stringify(p) + "\n", "utf8");
}
