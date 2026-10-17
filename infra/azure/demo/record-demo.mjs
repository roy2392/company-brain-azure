// Records the demo video: four Foundry agents, one shared memory (agent-memory on Atlas), governed in OpenMetadata.
// Runs on the Azure VM inside the compose network (infra/azure/demo/record.sh), so it talks to the app directly
// (http://brain:8787) and never types a password. Writes /out/demo.webm and /out/segments.json (waits to speed up).
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://brain:8787";
const W = 1600;
const H = 900;
const marks = []; // { start, end } of waits (ms since recording start), sped up in post

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: "/out/raw", size: { width: W, height: H } } });
const page = await context.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;
const pause = (ms) => page.waitForTimeout(ms);

async function caption(text, ms = 0) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, { position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", maxWidth: "1100px", padding: "14px 22px", borderRadius: "14px", background: "rgba(36,27,51,0.92)", color: "#f4f2f8", font: "500 21px/1.35 'Schibsted Grotesk Variable', Arial, sans-serif", zIndex: 99999, pointerEvents: "none", boxShadow: "0 8px 30px rgba(0,0,0,0.25)", textAlign: "center", transition: "opacity .3s" });
      document.body.appendChild(el);
    }
    el.style.opacity = t ? "1" : "0";
    if (t) el.textContent = t;
  }, text);
  if (ms) await pause(ms);
}

async function card(title, subtitle, ms) {
  await page.evaluate(([t, s]) => {
    const el = document.createElement("div");
    el.id = "demo-card";
    el.innerHTML = `<div style="font:500 54px/1.15 'Newsreader Variable',Georgia,serif;max-width:1200px">${t}</div><div style="margin-top:22px;font:400 24px/1.4 'Schibsted Grotesk Variable',Arial,sans-serif;color:#cfc6dd;max-width:1100px">${s}</div>`;
    Object.assign(el.style, { position: "fixed", inset: "0", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 120px", background: "#241b33", color: "#f4f2f8", zIndex: 100000 });
    document.body.appendChild(el);
  }, [title, subtitle]);
  await pause(ms);
  await page.evaluate(() => document.getElementById("demo-card")?.remove());
}

async function pickAgent(name) {
  await page.getByRole("button", { name: new RegExp(name) }).first().click({ force: true });
  await pause(1200);
}

/** Click the suggestion that starts with `prefix`, wait for the answer (sped up later), then show it. */
async function ask(prefix, during) {
  const before = await page.locator(".team-mem").count();
  const btn = page.locator(".team-suggest button", { hasText: prefix }).first();
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click({ force: true }); // the page re-renders every 2.5 s (memory feed), which can keep "stable" checks waiting
  await caption(during);
  await pause(1500);
  const start = now();
  await page.locator(".team-wait").waitFor({ state: "detached", timeout: 300_000 });
  await pause(3500); // memory panel polls every 2.5 s
  marks.push({ start, end: now() - 2500 });
  const turn = page.locator(".team-turn").last();
  await turn.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "smooth" }));
  await pause(1500);
  return { added: (await page.locator(".team-mem").count()) - before };
}

async function readAnswer(ms) {
  // slowly scroll through the answer so it can be read
  const steps = 6;
  for (let i = 0; i < steps; i++) {
    await page.locator(".team-turns").evaluate((el) => el.scrollBy({ top: 140, behavior: "smooth" }));
    await pause(ms / steps);
  }
}

process.on("unhandledRejection", async (e) => {
  console.error(e);
  await page.screenshot({ path: "/out/fail.png" }).catch(() => undefined);
  await context.close().catch(() => undefined);
  process.exit(1);
});

await page.goto(`${BASE}/team`, { waitUntil: "networkidle" });
await page.locator(".team-agent").first().waitFor();

await card(
  "Four agents. One memory. Governed.",
  "Wisteria Group's role agents run in Microsoft Foundry. They share one memory through agent-memory on MongoDB Atlas, and every memory is governed in OpenMetadata.",
  6000,
);
await caption("Support Lead, Account Manager, RevOps and Product Lead: four Foundry agents (gpt-5.4) with the company brain and OpenMetadata as MCP tools.", 5000);

// 1. Support Lead: investigates from scratch, saves what it learns
await pickAgent("Support Lead");
await ask("Novaris Holdings keeps escalating", "Support Lead investigates Novaris Holdings' escalations from scratch: Zendesk, Jira, the account record…");
await caption("Support Lead answers with cited records, and saves its findings to the team memory.", 4500);
await readAnswer(6000);
await caption("Saved to agent-memory in MongoDB Atlas (right) and mirrored to OpenMetadata, authored by the Support Lead's own bot.", 5500);

// 2. Account Manager: recalls Support's memories instead of re-investigating
await pickAgent("Account Manager");
await ask("Why did Novaris Holdings churn?", "Account Manager starts from the team memory: it recalls what Support Lead saved…");
await caption("“Recalled team memory”: it reuses Support Lead's findings and only investigates the gaps (calls, deals, Slack).", 5500);
await readAnswer(6000);

// 3. RevOps: both teammates' memories + governed ARR definition
await pickAgent("RevOps");
await ask("What should Finance report about Novaris Holdings", "RevOps recalls both teammates' memories and reads the governed ARR definition from OpenMetadata…");
await caption("Team memory plus the catalog: ARR as Finance defines it in OpenMetadata, not a guess.", 5500);
await readAnswer(6000);

// 4. Product Lead: priorities from what the team learned
await pickAgent("Product Lead");
await ask("Based on what the team learned", "Product Lead turns what the other three agents learned into product priorities…");
await caption("Four agents, one memory: each one builds on the others.", 4500);
await readAnswer(5000);

// 5. The same memories in OpenMetadata
await page.getByRole("tab", { name: /In OpenMetadata/ }).click({ force: true });
await caption("The same memories in OpenMetadata's Context Center: authored by each agent's bot, owned by its team, linked to the Atlas table.", 6000);
await page.locator(".team-memory ol").evaluate((el) => el.scrollBy({ top: 600, behavior: "smooth" }));
await caption("Lineage: the four agents → agent_memory.memories → the Company Brain agent, which can recall what they learned.", 6000);
await page.getByRole("tab", { name: /Shared memory/ }).click({ force: true });
await pause(1500);

// 6. Company context straight from OpenMetadata
await pickAgent("RevOps");
await ask("Who owns the ARR definition", "Company context: RevOps asks OpenMetadata who owns ARR and which datasets feed it…");
await caption("Answered from the OpenMetadata catalog over MCP: governed definition, owner and lineage.", 5500);
await readAnswer(6000);

await pickAgent("Product Lead");
await ask("Which datasets with personal data feed our agents", "Product Lead asks the catalog which personal-data datasets feed the agents, and who owns them…");
await caption("Governance at answer time: PII tags, owners and lineage, straight from OpenMetadata.", 5500);
await readAnswer(6000);

await caption("");
await card("Microsoft Foundry · MongoDB Atlas · OpenMetadata", "Agents in Foundry. Shared memory in agent-memory on MongoDB Atlas. Every memory, definition and lineage edge governed in OpenMetadata. All of it on Azure, defined in Terraform.", 6000);

await context.close();
await browser.close();
writeFileSync("/out/segments.json", JSON.stringify({ marks, total: now() }, null, 2));
console.log(`recorded ${(now() / 1000).toFixed(0)} s, ${marks.length} waits`);
