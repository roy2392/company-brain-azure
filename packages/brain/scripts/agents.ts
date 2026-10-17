/**
 * Three Wisteria agents, one shared memory (agent-memory on MongoDB Atlas), governed in OpenMetadata.
 *   npm run agents                              # Support Lead → Account Manager → RevOps on Novaris Holdings
 *   npm run agents -- --account "Ironwood Group"
 *   npm run agents -- --only account_manager    # one agent, on whatever the team already remembers
 *   npm run agents -- --reset                   # forget the team memory first (Atlas + the OpenMetadata mirror)
 *   npm run agents -- --sync                    # only record journaled runs OpenMetadata missed, then exit
 */
import { syncAll } from "../src/agents/journal.ts";
import { teamMemory } from "../src/agents/memory.ts";
import { AGENT_NAMES, agentByName, scenario } from "../src/agents/roster.ts";
import { runAgent } from "../src/agents/run.ts";
import { closeDb } from "../src/brain/store.ts";
import { cfg } from "../src/config.ts";
import { forgetPromotedMemories } from "../src/om/agents.ts";
import { OM } from "../src/om/client.ts";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const account = arg("--account") ?? "Novaris Holdings";
const only = arg("--only");
const paint = (code: number, s: string) => `\x1b[${code}m${s}\x1b[0m`;

await teamMemory.health().catch(() => {
  console.error(`agent-memory is not reachable at ${cfg.memory.url}: docker compose up -d agent-memory`);
  process.exit(1);
});
const om = await new OM().login().catch(() => {
  console.warn("OpenMetadata is not reachable: runs and memories will not be recorded in the catalog");
  return null;
});
if (process.argv.includes("--sync")) {
  if (!om) process.exit(1);
  const r = await syncAll(om);
  console.log(`synced ${r.runs} runs to OpenMetadata${r.errors.length ? `\n${r.errors.join("\n")}` : ""}`);
  await closeDb();
  process.exit(r.errors.length ? 1 : 0);
}
if (process.argv.includes("--reset")) {
  const docs = await teamMemory.reset();
  const mirrored = om ? await forgetPromotedMemories(om) : 0;
  console.log(paint(2, `reset: ${docs} agent-memory documents, ${mirrored} Context Center memories`));
}

const steps = scenario(account).filter((s) => !only || s.agent === only);
if (!steps.length) throw new Error(`unknown agent ${only}`);
for (const step of steps) {
  const a = agentByName(step.agent)!;
  console.log(`\n${paint(a.color, paint(1, `━━ ${a.displayName}`))} ${paint(2, `(${a.team} · space ${teamMemory.team})`)}\n${paint(1, step.task)}\n`);
  for await (const ev of runAgent(a, step.task, { account, om })) {
    if (ev.type === "text") process.stdout.write(ev.delta);
    else if (ev.type === "tool" && ev.name !== "recall_team_memory" && ev.name !== "remember") process.stdout.write(paint(2, `\n· ${ev.name} ${JSON.stringify(ev.input).slice(0, 120)}\n`));
    else if (ev.type === "recall") {
      const by = [...new Set(ev.hits.map((h) => AGENT_NAMES[h.by] ?? h.by))];
      process.stdout.write(paint(a.color, `\n⟲ recall "${ev.query}" → ${ev.hits.length} memories${by.length ? ` from ${by.join(", ")}` : ""}\n`));
    } else if (ev.type === "remember") process.stdout.write(paint(a.color, `\n✚ remember [[memory:${ev.id}]] ${ev.fact.slice(0, 180)}\n`));
    else if (ev.type === "error") console.error(paint(31, `\n✗ ${ev.message}`));
    else if (ev.type === "done")
      console.log(
        paint(2, `\n\n— ${ev.tools} tool calls · ${ev.remembered} memories saved · ${(ev.durationMs / 1000).toFixed(1)} s${ev.costUsd ? ` · $${ev.costUsd.toFixed(3)}` : ""}`) +
          paint(2, ev.omExecution ? ` · OpenMetadata: execution recorded, ${ev.omMemories} memories in the Context Center` : "") +
          (ev.omError ? paint(31, ` · OpenMetadata: ${ev.omError}`) : ""),
      );
  }
}
if (om) console.log(paint(2, `\nIn OpenMetadata: ${om.ui}/contextCenter (memories) · AI applications wisteria_*_agent (executions, lineage)`));
await closeDb();
