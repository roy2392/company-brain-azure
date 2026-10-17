// Record the demo in the real portals: the four agents in the Microsoft Foundry playground, then OpenMetadata
// (the memories they saved, the lineage, the glossary term an agent proposed). Runs inside the portal-browser container
// (record-portal.sh), attached over CDP to the Chromium you signed in to: ffmpeg grabs the X display, xdotool moves
// the real pointer and clicks, captions are drawn into the page. Nothing here types a password.
//   env: AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, FOUNDRY_ACCOUNT, FOUNDRY_PROJECT, OM_URL
//   optional: BRAIN_URL (http://brain:8787), MODEL (gpt-5.4), OUT (/out), SCENES (foundry,om), DRY=1 (no recording)
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const env = process.env;
const OM = env.OM_URL;
const BRAIN = env.BRAIN_URL ?? "http://brain:8787";
const MODEL = env.MODEL ?? "gpt-5.4";
const OUT = env.OUT ?? "/out";
const SCENES = new Set((env.SCENES ?? "foundry,traces,om").split(","));
// whose trace the traces scene opens: the one that recalls first, then remembers (and may propose a concept)
const TRACE_AGENT = env.TRACE_AGENT ?? "wisteria-account-manager";
// the portal addresses a project by the subscription id's 16 bytes in base64url
const subKey = Buffer.from(env.AZURE_SUBSCRIPTION_ID.replace(/-/g, ""), "hex").toString("base64url");
const AGENTS_URL = `https://ai.azure.com/nextgen/r/${subKey},${env.AZURE_RESOURCE_GROUP},,${env.FOUNDRY_ACCOUNT},${env.FOUNDRY_PROJECT}/build/agents`;

const CHATS = [
  {
    agent: "wisteria-support-lead",
    title: "Support Lead: investigate, then remember",
    prompt: "Novaris Holdings keeps escalating. What is breaking for them, since when, and is it getting worse? Save what the account team needs to know.",
    working: "It reads tickets, cases and Jira through the company-brain MCP tool, then calls remember: each fact goes to agent-memory on MongoDB Atlas and is mirrored to OpenMetadata.",
    done: "Every claim cites its record. [[memory:…]] marks a fact it saved for the rest of the team.",
  },
  {
    agent: "wisteria-account-manager",
    title: "Account Manager: starts from the team's memory",
    prompt: "Why did Novaris Holdings churn? Start from what the team already knows, fill the gaps, and save the churn reason for the team. If the pattern has no name in our glossary yet, propose one.",
    working: "Its first tool call recalls the shared memory (same agent-memory space), so it only investigates what the Support Lead did not cover.",
    done: "It cites the Support Lead's memories, and proposes a new business concept for the ontology.",
  },
  {
    agent: "wisteria-revops-analyst",
    title: "RevOps: governed definitions from OpenMetadata",
    prompt: "What should Finance report about Novaris Holdings at quarter close? Use our governed ARR definition from OpenMetadata, and save the figure for the team.",
    working: "It reads the governed ARR definition from OpenMetadata over MCP, with its own read-only bot, and recalls what its teammates learned.",
    done: "The answer is computed the governed way, and the figure is saved for the team.",
  },
  {
    agent: "wisteria-product-lead",
    title: "Product Lead: team memory + company context",
    prompt: "Which datasets with personal data are in our catalog, and who owns them? Then, from what the team learned about Novaris Holdings, what should product fix first?",
    working: "OpenMetadata for the PII-tagged datasets and their owners; team memory for the account story.",
    done: "Data owners from the governed catalog, priorities from three teammates' memories.",
  },
];

const t0 = Date.now();
const marks = [];
const now = () => Date.now() - t0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${(now() / 1000).toFixed(0).padStart(4)}s]`, ...a);

// ---------- pointer (real X pointer, so the video shows it) ----------
const X = (...args) => execFileSync("xdotool", args.map(String), { env: { ...env, DISPLAY: ":99" } });
let cur = { x: 960, y: 620 };
X("mousemove", cur.x, cur.y);
async function glide(x, y, ms = 650) {
  const steps = Math.max(10, Math.round(ms / 22));
  const from = { ...cur };
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    X("mousemove", Math.round(from.x + (x - from.x) * e), Math.round(from.y + (y - from.y) * e));
    await sleep(ms / steps);
  }
  cur = { x, y };
}
const chromeOffset = (page) => page.evaluate(() => ({ x: window.screenX + window.outerWidth - window.innerWidth, y: window.screenY + window.outerHeight - window.innerHeight }));
async function pointAt(page, target, { dx = 0.5, dy = 0.5, ms } = {}) {
  const loc = typeof target === "string" ? page.locator(target).first() : target;
  await loc.waitFor({ timeout: 30_000 });
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  const b = await loc.boundingBox();
  const off = await chromeOffset(page);
  await glide(Math.round(off.x + b.x + b.width * dx), Math.round(off.y + b.y + b.height * dy), ms);
  return loc;
}
async function click(page, target, opts) {
  await pointAt(page, target, opts);
  await sleep(150);
  X("click", 1);
  await sleep(400);
}
async function pointAtXY(page, x, y, ms) {
  const off = await chromeOffset(page);
  await glide(off.x + x, off.y + y, ms);
}

// ---------- captions and cards, drawn into the page (outside the app's own DOM tree) ----------
// Styled like the slides ("blueprint"): pale panels with a solid offset edge, product colours (Foundry blue,
// MongoDB green, OpenMetadata purple), Barlow Condensed + Inter. Fonts load from bytes with the FontFace API and
// logos are built as inline SVG elements, so neither depends on the portal's CSP or Trusted Types.
const ASSETS = env.ASSETS ?? "/demo/assets";
const FONTS = [
  ["Deck Condensed", "barlow-condensed-600.woff2", "600"],
  ["Deck Condensed", "barlow-condensed-700.woff2", "700"],
  ["Deck Sans", "inter-var.woff2", "100 900"],
].map(([family, file, weight]) => ({ family, weight, b64: readFileSync(`${ASSETS}/fonts/${file}`).toString("base64") }));

/** Minimal SVG → {tag, attrs, children} tree (the logo files are plain markup without text nodes). */
function svgTree(src) {
  const root = { children: [] };
  const stack = [root];
  const clean = src.replace(/<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, "");
  for (const [, close, tag, attrStr, self] of clean.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
    if (close) {
      stack.pop();
      continue;
    }
    const attrs = Object.fromEntries([...attrStr.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!self) stack.push(node);
  }
  return root.children[0];
}
const LOGOS = ["microsoft", "foundry", "mongodb", "openmetadata", "terraform"].map((n) => svgTree(readFileSync(`${ASSETS}/logos/${n}.svg`, "utf8")));

const DECK_CSS = `
@keyframes __up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
#__cap{position:fixed;z-index:2147483646;pointer-events:none;max-width:660px;padding:16px 22px 18px;border-radius:12px;background:var(--fill);border:2px solid var(--line);box-shadow:7px 7px 0 var(--edge),0 18px 40px rgba(15,36,64,.18);color:#1F3550;font:16px/1.5 "Deck Sans","Segoe UI",sans-serif;opacity:0;transition:opacity .3s ease}
#__cap.on{opacity:1;animation:__up .5s cubic-bezier(.2,.8,.2,1) both}
#__cap b{display:block;margin-bottom:7px;font:700 25px/1.1 "Deck Condensed","Segoe UI",sans-serif;letter-spacing:.02em;text-transform:uppercase;color:#0F2440}
#__cap.bl{left:24px;bottom:26px}#__cap.br{right:30px;bottom:26px}#__cap.tr{right:30px;top:64px}
#__cap.blue,.__chip.blue{--fill:#EAF2FB;--line:#2F6DB5;--edge:#9DBCE3}
#__cap.green,.__chip.green{--fill:#E8F5EC;--line:#1F8F4E;--edge:#9CCFB0}
#__cap.purple,.__chip.purple{--fill:#F0ECFF;--line:#6B4FD8;--edge:#BDB0F0}
.__chip.gray{--fill:#F6F8FA;--line:#5B6B7C;--edge:#C3CDD8}
#__card{position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;text-align:center;background:#E8EFF6;color:#0F2440;font-family:"Deck Sans","Segoe UI",sans-serif;opacity:0;transition:opacity .5s ease}
#__card.on{opacity:1}
#__card::before{content:"";position:absolute;inset:22px;border:2px solid #C8D6E5;border-radius:22px}
#__card .b{opacity:0}#__card.on .b{animation:__up .6s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i) * 110ms + 150ms)}
#__card .logos{display:flex;gap:40px;align-items:center;height:60px}#__card .logos svg{height:54px;width:auto}
#__card h1{margin:0;max-width:1500px;font:700 78px/1.02 "Deck Condensed","Segoe UI",sans-serif;letter-spacing:.01em;text-transform:uppercase;color:#0B1B33}
#__card .rule{width:0;height:5px;border-radius:3px;background:#1B365D;transition:width .8s cubic-bezier(.2,.8,.2,1) .45s}#__card.on .rule{width:240px}
#__card p{margin:0;max-width:1180px;font:400 26px/1.5 "Deck Sans","Segoe UI",sans-serif;color:#2A4060}
#__card .row{display:flex;flex-wrap:wrap;justify-content:center;gap:18px;margin-top:6px;max-width:1500px}
.__chip{padding:11px 22px;border-radius:999px;background:var(--fill);border:2px solid var(--line);box-shadow:4px 4px 0 var(--edge);font:700 22px/1 "Deck Condensed","Segoe UI",sans-serif;letter-spacing:.03em;text-transform:uppercase;color:#0F2440}
#__card .foot{position:absolute;left:54px;bottom:42px;font:400 15px "Deck Sans","Segoe UI",sans-serif;color:#6B7F96}`;

/** Fonts and styles, once per document; waits for the fonts so the first caption never flashes a fallback face. */
async function deckLook(page) {
  if (await page.evaluate(() => !!document.getElementById("__demo_style"))) return;
  await page.evaluate(
    async ([fonts, css]) => {
      const st = document.createElement("style");
      st.id = "__demo_style";
      st.textContent = css;
      document.documentElement.append(st);
      for (const f of fonts) {
        const bytes = Uint8Array.from(atob(f.b64), (ch) => ch.charCodeAt(0));
        const face = new FontFace(f.family, bytes.buffer, { weight: f.weight });
        document.fonts.add(await face.load());
      }
    },
    [FONTS, DECK_CSS],
  );
}

const toneOf = (page) => (page.url().includes("ai.azure.com") ? "blue" : "purple");
async function caption(page, title, text = "", pos = "bl", tone = toneOf(page)) {
  await deckLook(page);
  await page.evaluate(
    ([title, text, pos, tone]) => {
      let el = document.getElementById("__cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "__cap";
        document.documentElement.append(el);
      }
      if (!title) {
        el.classList.remove("on");
        return;
      }
      el.className = `${pos} ${tone}`;
      el.replaceChildren();
      const b = document.createElement("b");
      b.textContent = title;
      el.append(b, document.createTextNode(text));
      void el.offsetWidth; // restart the entrance animation for each new caption
      el.classList.add("on");
    },
    [title, text, pos, tone],
  );
}

const chipTone = (t) => (/MongoDB|memory/i.test(t) ? "green" : /OpenMetadata|ontology|governed/i.test(t) ? "purple" : /Foundry|Microsoft|MCP/i.test(t) ? "blue" : "gray");
async function card(page, title, text, chips, ms) {
  await caption(page, "");
  await deckLook(page);
  await page.evaluate(
    ([title, text, chips, logos]) => {
      const NS = "http://www.w3.org/2000/svg";
      const build = (n) => {
        const e = document.createElementNS(NS, n.tag);
        for (const [k, v] of Object.entries(n.attrs)) if (!k.startsWith("xmlns")) e.setAttribute(k.replace(/^xlink:/, ""), v);
        for (const c of n.children) e.append(build(c));
        return e;
      };
      const el = (tag, cls, i, textContent) => Object.assign(document.createElement(tag), { className: cls, textContent: textContent ?? "" });
      const c = document.createElement("div");
      c.id = "__card";
      let i = 0;
      const step = (e) => (e.style.setProperty("--i", String(i++)), e);
      const row1 = step(el("div", "logos b"));
      for (const l of logos) row1.append(build(l));
      const h = step(el("h1", "b", 0, title));
      const rule = el("div", "rule");
      const p = step(el("p", "b", 0, text));
      const row = el("div", "row");
      for (const t of chips) row.append(step(el("span", `__chip b ${t[1]}`, 0, t[0])));
      c.append(row1, h, rule, p, row, el("div", "foot", 0, "Company Brain on MongoDB Atlas · Roey Zalta, Microsoft"));
      document.documentElement.append(c);
      void c.offsetWidth;
      c.classList.add("on");
    },
    [title, text, chips.map((t) => [t, chipTone(t)]), LOGOS],
  );
  await sleep(ms);
  await page.evaluate(() => document.getElementById("__card")?.classList.remove("on"));
  await sleep(600);
  await page.evaluate(() => document.getElementById("__card")?.remove());
}

// ---------- Foundry ----------
async function openAgent(page, agent) {
  await page.goto(AGENTS_URL, { waitUntil: "domcontentloaded" });
  const link = page.locator(`a:has-text("${agent}")`).first();
  await link.waitFor({ timeout: 60_000 });
  await sleep(1500);
  return link;
}
async function ensureModel(page) {
  const combo = page.locator('button[role="combobox"]').filter({ hasText: "Model" }).first();
  await combo.waitFor({ timeout: 60_000 });
  // the picker fills in after the page loads; returns at once when it already shows the model
  await page.waitForFunction((m) => [...document.querySelectorAll('button[role="combobox"]')].some((b) => b.textContent.includes("Model") && b.textContent.includes(m)), MODEL, { timeout: 6_000 }).catch(() => undefined);
  if ((await combo.innerText()).includes(MODEL)) return;
  log("model picker shows", JSON.stringify(await combo.innerText()), "→ selecting", MODEL);
  await click(page, combo);
  await click(page, page.locator(`[role="option"]:has-text("${MODEL}"), [role="menuitem"]:has-text("${MODEL}"), li:has-text("${MODEL}")`).first());
  await sleep(1000);
  if (!(await combo.innerText()).includes(MODEL)) throw new Error(`model picker still shows ${await combo.innerText()}`);
}
async function chat(page, c, i) {
  log("chat", c.agent);
  const link = await openAgent(page, c.agent);
  if (i === 0) {
    await caption(page, "Microsoft Foundry · project wisteria-agents", `Four role agents, each a Foundry prompt agent on ${MODEL}. Terraform created the project; a script created the agents.`);
    for (const a of CHATS) await pointAt(page, `a:has-text("${a.agent}")`, { dx: 0.3, ms: 500 }).then(() => sleep(350));
    await sleep(1200);
  }
  await click(page, link, { dx: 0.3 });
  const input = page.locator('[data-testid="chat-input"]');
  await input.waitFor({ timeout: 60_000 });
  await ensureModel(page);
  await caption(page, c.title, i === 0 ? "Two MCP tools per agent: the company brain with the shared team memory, and OpenMetadata (read-only, through the agent's own bot)." : "");
  if (i === 0) {
    await pointAt(page, page.locator('text=/wisteria-brain-/').first(), { dx: 0.2, ms: 700 });
    await sleep(1500);
    await pointAt(page, page.locator('text=/wisteria-om-/').first(), { dx: 0.2, ms: 500 });
    await sleep(1800);
  }
  const newChat = page.locator('button[aria-label="New chat"]');
  if (await newChat.isVisible().catch(() => false)) await click(page, newChat);
  const likes = page.locator('button[aria-label="Like this response"]');
  const before = await likes.count();
  await click(page, input, { dx: 0.15 });
  await page.keyboard.type(c.prompt, { delay: 14 });
  await sleep(700);
  await page.keyboard.press("Enter");
  await sleep(2500);
  await caption(page, c.title, `${c.working}  (waiting sped up)`);
  const start = now();
  await page.waitForFunction((n) => document.querySelectorAll('button[aria-label="Like this response"]').length > n && !document.querySelector('button[aria-label="Stop"]'), before, { timeout: 360_000, polling: 1000 });
  marks.push({ start, end: now() });
  log("answered", c.agent, `${((now() - start) / 1000).toFixed(0)}s`);
  await caption(page, c.title, c.done);
  await readAnswer(page);
}
// scroll the conversation from the prompt to the end of the answer, at reading pace
async function readAnswer(page) {
  const like = page.locator('button[aria-label="Like this response"]').last();
  const box = await like.boundingBox();
  await pointAtXY(page, 1320, Math.max(320, Math.min(620, (box?.y ?? 600) - 140)), 600);
  const steps = await page.evaluate(() => {
    let el = document.querySelector('button[aria-label="Like this response"]');
    while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (!el) return 0;
    window.__chatScroller = el;
    el.scrollTo({ top: 0, behavior: "smooth" });
    return Math.ceil((el.scrollHeight - el.clientHeight) / 170);
  });
  await sleep(steps ? 2600 : 5000);
  for (let s = 0; s < steps; s++) {
    await page.evaluate(() => window.__chatScroller?.scrollBy({ top: 170, behavior: "smooth" }));
    await sleep(1500);
  }
  // the tool calls behind the answer
  const chipY = (await like.boundingBox())?.y;
  if (chipY) await pointAtXY(page, 980, chipY + 10, 700);
  await sleep(3500);
}

// ---------- Foundry traces (Application Insights on the project, see terraform/tracing.tf) ----------
const traceCount = (page) => page.evaluate(() => Number((document.body.innerText.match(/\d+-\d+ of (\d+)/) || [])[1] ?? 0));
async function openTraces(page, agent, show = true) {
  const link = await openAgent(page, agent);
  if (show) await click(page, link, { dx: 0.3 });
  else await link.click();
  await page.locator('[role=tab]:has-text("Traces")').first().waitFor({ timeout: 60_000 });
  if (show) await click(page, page.locator('[role=tab]:has-text("Traces")').first());
  else await page.locator('[role=tab]:has-text("Traces")').first().click();
  await page.locator("text=Trace ID").first().waitFor({ timeout: 60_000 });
  await sleep(1500);
}
async function traces(page, agent, baseline) {
  log("traces", agent);
  await openTraces(page, agent);
  const title = "Foundry tracing: every tool call";
  const text = "Application Insights is connected to the Foundry project (in Terraform), so every run is traced: each MCP tool call with its arguments and result.";
  await caption(page, title, text);
  // a run reaches Application Insights a minute or two after it ends
  const start = now();
  for (let i = 0; i < 20 && (await traceCount(page)) <= baseline; i++) {
    await caption(page, title, `${text}  (waiting for the newest run, sped up)`);
    await sleep(10_000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("text=Trace ID").first().waitFor({ timeout: 60_000 });
    await sleep(1000);
  }
  if (now() - start > 5000) marks.push({ start, end: now() });
  await caption(page, title, text);
  await sleep(1500);
  await click(page, page.locator("button").filter({ hasText: /^[0-9a-f]{32}$/ }).first(), { dx: 0.3 });
  await page.locator("text=Trajectories").first().waitFor({ timeout: 60_000 });
  await sleep(2500);
  await caption(page, "One run, step by step", "The agent recalled the team's memory first, called the company-brain tools for the gaps, then saved what it learned with remember. Click any step for its input and output.");
  const steps = page.locator("text=/execute_tool mcp_/").filter({ visible: true });
  const n = await steps.count();
  for (let i = 0; i < Math.min(n, 7); i++) {
    await pointAt(page, steps.nth(i), { dx: 0.4, ms: 450 });
    await sleep(500);
  }
  const remember = page.locator("text=/execute_tool mcp_wisteria_brain\\.remember/").filter({ visible: true });
  if (await remember.count()) {
    await click(page, remember.last(), { dx: 0.4 });
    await sleep(1200);
    await caption(page, "remember: what the agent saved", "The fact, the question it answers, the account and the ontology concepts, plus a new concept when the glossary lacks one. agent-memory stores it on MongoDB Atlas; the gateway mirrors it to OpenMetadata.", "bl", "green");
    await pointAtXY(page, 1490, 420, 700);
    await sleep(7000);
  }
  await click(page, page.locator('[role=tab]:has-text("Graph view")').first());
  await caption(page, "The same run as a graph", "One agent invocation fanning out into its tool calls and the model call.");
  await sleep(4500);
}

// ---------- OpenMetadata ----------
async function catalog() {
  return (await fetch(`${BRAIN}/api/team/catalog`)).json();
}
/** One step of the tour; a UI change skips the step instead of failing the take. TOUR=lineage,... runs only those. */
const TOUR = env.TOUR ? new Set(env.TOUR.split(",")) : null;
async function soft(name, fn) {
  if (TOUR && !TOUR.has(name)) return;
  try {
    await fn();
  } catch (e) {
    log(`skipped ${name}:`, String(e).split("\n")[0]);
  }
}
async function show(page, target, { hold = 900, ...opts } = {}) {
  const l = typeof target === "string" ? page.locator(target).first() : target;
  if (!(await l.isVisible().catch(() => false))) return;
  await pointAt(page, l, { ms: 600, ...opts });
  await sleep(hold);
}
const wheel = (n, down = true) => X("click", "--repeat", n, "--delay", 90, down ? 5 : 4);
/** Drag across an element (pans a lineage canvas, orbits the 3D knowledge graph). */
async function drag(page, target, dx, dy = 0, ms = 2400) {
  const b = await (typeof target === "string" ? page.locator(target).first() : target).boundingBox();
  const off = await chromeOffset(page);
  const vh = await page.evaluate(() => window.innerHeight); // some canvases run past the bottom of the window
  const x = Math.round(off.x + b.x + b.width / 2), y = Math.round(off.y + Math.min(b.y + b.height / 2, vh - 260));
  await glide(x, y, 500);
  X("mousedown", 1);
  await glide(x + dx, y + dy, ms);
  X("mouseup", 1);
}

/** OpenMetadata 2.0 over the Era by Eon catalog: sources, Slack and Zendesk tables, PII, column lineage,
 *  the knowledge graph, governed metrics and the data marketplace. */
async function catalogTour(om) {
  await soft("services", async () => {
    await om.goto(`${OM}/settings/services/databases`, { waitUntil: "domcontentloaded" });
    await om.locator("text=Slack · Era").first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    await caption(om, "Era by Eon, cataloged", "Wisteria's six systems from Era by Eon (Salesforce, Zendesk, Gong, Slack, Jira & Confluence, Google Drive), each an OpenMetadata service with an owner team, next to MongoDB Atlas: the brain database and the agent-memory cluster.", "tr");
    for (const s of ["Salesforce · Era", "Zendesk · Era", "Slack · Era", "Gong · Era"]) await show(om, `text=${s}`, { dx: 0.3, hold: 700 });
    wheel(5);
    await sleep(2800);
  });

  await soft("slack", async () => {
    await om.goto(`${OM}/table/era_slack.wisteria.slack.messages`, { waitUntil: "domcontentloaded" });
    await om.locator("text=Slack Conversation").first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    await caption(om, "Slack · messages", "Pulled through Era's Slack API, columns refined from real records: ts, user, text, thread_ts, reactions, files. Owned by Data Platform in the Collaboration domain, tagged with the Slack Conversation concept; user is a foreign key to slack.users.", "br");
    for (const t of ["text=Collaboration", "text=Data Platform", "text=Slack Conversation"]) await show(om, t, { hold: 800 });
    await show(om, "text=reply_count", { hold: 300 });
    wheel(4);
    await sleep(2600);
  });

  await soft("zendesk pii", async () => {
    await om.goto(`${OM}/table/era_zendesk.wisteria.zendesk.users`, { waitUntil: "domcontentloaded" });
    await om.locator("text=Sensitive").first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    await caption(om, "PII, tagged per column", "Zendesk · users: name, email and phone carry PII.Sensitive and the table inherits the tag, so people and agents see what is personal before they use it. The Product Lead's PII question was answered from these tags.", "br");
    for (let i = 0; i < 3; i++) await show(om, om.locator("text=Sensitive").nth(i), { hold: 800 });
    await sleep(1500);
  });

  await soft("lineage", async () => {
    await om.goto(`${OM}/table/era_zendesk.wisteria.zendesk.tickets/lineage`, { waitUntil: "domcontentloaded" });
    await om.locator('.react-flow__node:has-text("raw_zendesk_tickets")').first().waitFor({ timeout: 60_000 });
    await sleep(1500);
    await caption(om, "Column-level lineage", "Every Zendesk ticket field flows into raw_zendesk_tickets on Atlas (the era_to_atlas pipeline), then into docs and chunks, the Escalation Rate metric and the Company Brain agent.", "tr");
    await sleep(1500);
    // full screen first: the column layer lays the graph out again with tall nodes, which need the room
    const full = om.getByRole("button", { name: /full screen/i }).first();
    await click(om, full);
    await sleep(1500);
    await click(om, "text=Layers");
    await click(om, om.getByRole("button", { name: "Column", exact: true }).first());
    await sleep(3000);
    await show(om, om.locator('.react-flow__node:has-text("Zendesk") >> text=priority').first(), { hold: 400 });
    X("click", 1);
    await sleep(4000);
    await om.keyboard.press("Escape");
    await sleep(800);
    if (await full.isVisible().catch(() => false)) await click(om, full); // leave full screen if Escape did not
  });

  await soft("knowledge graph", async () => {
    await click(om, '[role=tab]:has-text("Knowledge Graph")');
    await om.locator("text=Drag to orbit").first().waitFor({ timeout: 30_000 });
    await sleep(2500);
    await click(om, "text=Show columns");
    await sleep(2000);
    await caption(om, "New in 2.0: the Knowledge Graph", "One asset in context: its columns, owners, glossary terms and queries, and the lineage between assets, as a graph you can orbit. Switch to the data-product or domain level, or overlay the ontology.", "tr");
    await drag(om, om.locator("canvas").filter({ visible: true }).first(), 320, -40, 3200);
    await sleep(2500);
  });

  await soft("metric", async () => {
    await om.goto(`${OM}/metric/escalation_rate`, { waitUntil: "domcontentloaded" });
    await om.locator('[role=tab]:has-text("Expression")').first().waitFor({ timeout: 60_000 });
    await sleep(1200);
    await click(om, '[role=tab]:has-text("Expression")');
    await caption(om, "Governed metrics, with their code", "Escalation Rate: a MongoDB aggregation over the brain's docs, a ratio by quarter, owned by Support and bound to the Escalation glossary term. Agents read this definition instead of inventing one.", "br");
    for (const t of ["text=RATIO", "text=QUARTER", "text=db.docs.aggregate"]) await show(om, t, { hold: 900 });
    await sleep(1800);
  });

  await soft("marketplace", async () => {
    await om.goto(`${OM}/data-marketplace`, { waitUntil: "domcontentloaded" });
    await om.locator("text=Customer 360 Brain").first().waitFor({ timeout: 60_000 });
    await sleep(1200);
    await caption(om, "New in 2.0: the Data Marketplace", "People discover trusted data products and request access. Customer 360 Brain bundles the 30 Atlas collections the agents read, owned by Data Platform in the Company Brain domain.", "tr");
    await sleep(1500);
    await click(om, "text=Customer 360 Brain");
    await om.locator('[role=tab]:has-text("Assets")').first().waitFor({ timeout: 30_000 });
    await click(om, '[role=tab]:has-text("Assets")');
    await sleep(3500);
  });
  await caption(om, "");
}
async function openMetadata(om) {
  await om.bringToFront();
  const cat = await catalog();
  log("catalog", cat.memories?.length, "memories,", cat.proposed?.length, "proposed terms");
  if (!env.SKIP_TOUR) await catalogTour(om);
  if (env.TOUR_ONLY) return;

  // memories
  await om.goto(`${OM}/context-center/memories`, { waitUntil: "domcontentloaded" });
  await om.locator("text=Total Memories").first().waitFor({ timeout: 60_000 });
  await sleep(2500);
  await caption(om, "OpenMetadata · Context Center", `The ${cat.memories?.length ?? ""} memories the agents just saved, each written by the agent's own bot user, owned by its team and shared with the others. The memory of record stays in agent-memory on Atlas.`);
  for (const author of ["support-lead-agent", "account-manager-agent", "revops-analyst-agent", "product-lead-agent"]) {
    const a = om.locator(`text=${author}`).first();
    if (await a.isVisible().catch(() => false)) {
      await pointAt(om, a, { ms: 600 });
      await sleep(900);
    }
  }
  await sleep(1500);
  const pick = cat.memories?.find((m) => m.author === "account-manager-agent") ?? cat.memories?.[0];
  if (pick) {
    await click(om, om.locator(`text=${pick.question.slice(0, 40)}`).first(), { dx: 0.2 });
    await sleep(2500);
    await caption(om, "One memory, linked to its agents", "Linked to the agent that wrote it (an AI application), to the agents it is shared with, and to agent_memory.memories, the Atlas collection that holds it.", "br");
    await sleep(2500);
    await om.evaluate(() => {
      const body = [...document.querySelectorAll(".ant-modal-body, [role=dialog] *")].find((e) => e.scrollHeight > e.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(e).overflowY));
      body?.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
    });
    await sleep(5000);
    await om.keyboard.press("Escape");
    await caption(om, "");
    await sleep(1000);
  }

  // lineage
  await om.goto(`${OM}/table/${encodeURIComponent(cat.table)}/lineage`, { waitUntil: "domcontentloaded" });
  await om.locator("text=Company Brain agent").first().waitFor({ timeout: 60_000 });
  await sleep(2500);
  await caption(om, "Lineage: who writes the memory, who reads it", "Four Foundry agents write agent_memory.memories, a collection on the MongoDB Atlas cluster on Azure (see the breadcrumb); the Company Brain agent reads it.", "br");
  for (const n of ["Support Lead agent", "Account Manager agent", "RevOps agent", "Product Lead agent", "Company Brain agent"]) {
    const node = om.locator(`.react-flow__node:has-text("${n}")`).first();
    if (await node.isVisible().catch(() => false)) {
      await pointAt(om, node, { dx: 0.4, ms: 550 });
      await sleep(700);
    }
  }
  await sleep(3000);

  // the ontology grows
  const term = cat.proposed?.[0];
  if (term) {
    await om.goto(`${OM}/glossary/${encodeURIComponent(term.fqn)}`, { waitUntil: "domcontentloaded" });
    await om.locator(`text=${term.name}`).first().waitFor({ timeout: 60_000 });
    await sleep(2500);
    await caption(om, `The ontology grows: "${term.name}"`, `The ${term.by ?? "agent"} proposed this concept while answering. OpenMetadata's workflow made it a glossary term under ${term.parent?.split(".").pop() ?? "the glossary"}, In Review, owned by the agent's team, with an approval task for Data Platform: governance decides, not the agent.`, "bl");
    for (const t of ["text=/In Review/i", "text=Owners", "text=Reviewers"]) {
      const l = om.locator(t).first();
      if (await l.isVisible().catch(() => false)) {
        await pointAt(om, l, { ms: 600 });
        await sleep(1300);
      }
    }
    await sleep(2500);
  }
  // the whole ontology: OpenMetadata 2.0's Ontology Explorer (the glossary's relations graph if it is unavailable)
  const about = term ? `"${term.name}" joins it next to the concepts its memory touched. ` : "";
  try {
    await om.goto(`${OM}/governance/ontology`, { waitUntil: "domcontentloaded" });
    await om.locator("text=Ontology Explorer").first().waitFor({ timeout: 30_000 });
    await sleep(5000);
    await caption(om, "New in 2.0: the Ontology Explorer", `Wisteria's business concepts, governed metrics and typed relations in one graph, mapped to schema.org and FIBO. ${about}Agents tag every memory with these terms.`, "tr");
  } catch {
    await om.goto(`${OM}/glossary/WisteriaGlossary`, { waitUntil: "domcontentloaded" });
    await click(om, om.locator("text=Relations Graph").first());
    await sleep(5000);
    await caption(om, "The Wisteria ontology", `Business concepts, typed relations and mappings to schema.org and FIBO. ${about}Agents tag every memory with these terms.`, "tr");
  }
  if (term) {
    const search = om.locator('input[placeholder*="Search in Graph"]').first();
    if (await search.isVisible().catch(() => false)) {
      await click(om, search);
      await om.keyboard.type(term.name, { delay: 40 });
      await sleep(800);
      await om.keyboard.press("Enter");
    }
  }
  await sleep(7000);
}

// ---------- run ----------
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const pages = browser.contexts().flatMap((c) => c.pages());
const foundry = pages.find((p) => p.url().includes("ai.azure.com")) ?? pages[0];
const om = pages.find((p) => p.url().startsWith(OM));
if (!om) throw new Error(`no OpenMetadata tab (${OM}) open in the portal browser`);
// leave pages without "unsaved changes?" prompts blocking navigation
for (const p of [foundry, om]) p.on("dialog", (d) => d.accept().catch(() => undefined));

// pre-roll, off camera: how many traces the trace agent has before this take
let traceBaseline = 0;
if (SCENES.has("traces")) {
  await openTraces(foundry, TRACE_AGENT, false);
  traceBaseline = SCENES.has("foundry") ? await traceCount(foundry) : -1;
  log("traces before the take:", traceBaseline);
}

let ff;
if (!env.DRY) {
  ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-framerate", "25", "-video_size", "1920x1080", "-i", ":99", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", `${OUT}/portal-raw.mp4`], { stdio: ["pipe", "inherit", "inherit"] });
  await sleep(1000);
}
let failed;
try {
  if (SCENES.has("foundry")) {
    await foundry.bringToFront();
    await foundry.goto(AGENTS_URL, { waitUntil: "domcontentloaded" });
    await foundry.locator(`a:has-text("${CHATS[0].agent}")`).first().waitFor({ timeout: 60_000 });
    await card(foundry, "Wisteria's company brain, on Azure", "Role agents in Microsoft Foundry share one memory — agent-memory on MongoDB Atlas — and work from governed company context in OpenMetadata.", ["Microsoft Foundry · gpt-5.4", "MongoDB Atlas · agent-memory", "OpenMetadata 2.0.5", "Terraform"], 6000);
    for (const [i, c] of CHATS.entries()) await chat(foundry, c, i);
  }
  if (SCENES.has("traces")) {
    await foundry.bringToFront();
    await traces(foundry, TRACE_AGENT, traceBaseline);
  }
  if (SCENES.has("om")) await openMetadata(om);
  await card(om, "One memory, governed", "Foundry agents remember in MongoDB Atlas; OpenMetadata shows who wrote what, where it lives, who may read it, and grows the shared vocabulary.", ["Shared team memory", "Governed context over MCP", "An ontology that grows", "All in Terraform"], 6000);
} catch (e) {
  failed = e;
  log("FAILED:", String(e).split("\n")[0]);
  await foundry.screenshot({ path: `${OUT}/failed-foundry.png` }).catch(() => undefined);
  await om.screenshot({ path: `${OUT}/failed-om.png` }).catch(() => undefined);
} finally {
  if (ff) {
    ff.stdin.write("q");
    await once(ff, "exit");
  }
  writeFileSync(`${OUT}/portal-segments.json`, JSON.stringify({ total: now(), marks }, null, 1));
  for (const p of [foundry, om]) await caption(p, "").catch(() => undefined);
  await browser.close().catch(() => undefined);
}
log(failed ? "done with errors" : "done", `${(now() / 1000).toFixed(0)} s raw`);
if (failed) process.exit(1);
