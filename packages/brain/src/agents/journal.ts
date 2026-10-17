import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cfg } from "../config.ts";
import type { OM } from "../om/client.ts";
import { promoteMemory, recordExecution, type RunRecord } from "../om/agents.ts";
import { agentByName } from "./roster.ts";

/**
 * Every agent run is journaled on disk, then synced to OpenMetadata (agent execution + Context Center memories).
 * Each step is independent and idempotent, so a catalog outage during a run is repaired by `npm run agents -- --sync`.
 */
export interface RunJournal extends RunRecord {
  agent: string;
  account?: string;
  remembered: Array<{ id: string; fact: string; question: string; topic?: string }>;
  om: { execution?: string; memories: string[] };
}

const DIR = path.join(cfg.cacheDir, "agent-runs");

export function saveRun(j: RunJournal) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, `${j.agent}-${j.runId}.json`), JSON.stringify(j, null, 2));
}

export function loadRuns(): RunJournal[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as RunJournal)
      .sort((a, b) => a.startedAt - b.startedAt);
  } catch {
    return [];
  }
}

export async function syncRun(om: OM, j: RunJournal) {
  const a = agentByName(j.agent);
  const errors: string[] = [];
  if (!a) return { execution: undefined, memories: 0, errors: [`unknown agent ${j.agent}`] };
  if (!j.om.execution) {
    try {
      j.om.execution = (await recordExecution(om, a, j))?.id;
    } catch (e) {
      errors.push(`execution: ${String(e).slice(0, 200)}`);
    }
  }
  for (const m of j.remembered) {
    if (j.om.memories.includes(m.id)) continue;
    try {
      if (await promoteMemory(om, a, { ...m, account: j.account, runId: j.runId })) j.om.memories.push(m.id);
    } catch (e) {
      errors.push(`memory ${m.id}: ${String(e).slice(0, 200)}`);
    }
  }
  saveRun(j);
  return { execution: j.om.execution, memories: j.om.memories.length, errors };
}

/** Sync every journaled run OpenMetadata has not fully seen. */
export async function syncAll(om: OM) {
  let runs = 0;
  const errors: string[] = [];
  for (const j of loadRuns()) {
    if (j.om.execution && j.remembered.every((m) => j.om.memories.includes(m.id))) continue;
    const r = await syncRun(om, j);
    runs++;
    errors.push(...r.errors);
  }
  return { runs, errors };
}
