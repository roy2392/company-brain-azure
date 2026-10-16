/**
 * Ask the company brain from the terminal (same agent as the web app).
 *   npm run ask -- "Which PII datasets feed the Company Brain agent, and who owns them?"
 */
import { askBrain } from "../src/agent.ts";
import { closeDb } from "../src/brain/store.ts";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}
let cited = 0;
for await (const ev of askBrain(question)) {
  if (ev.type === "tool_start") process.stdout.write(`\n· ${ev.name} ${JSON.stringify(ev.input).slice(0, 140)}\n`);
  else if (ev.type === "tool_result") cited += ev.citations.length;
  else if (ev.type === "text") process.stdout.write(ev.delta);
  else if (ev.type === "error") console.error(`\n✗ ${ev.message}`);
  else if (ev.type === "done") console.log(`\n\n— ${cited} citations · ${(ev.durationMs / 1000).toFixed(1)} s${ev.costUsd ? ` · $${ev.costUsd.toFixed(3)}` : ""}`);
}
await closeDb();
